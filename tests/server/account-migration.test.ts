import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createBillingReader } from "../../src/billing";

test("account migration preserves provider identities and invoice history while scoped reads follow the new customer", async () => {
  if (!process.env.TEST_DATABASE_URL)
    throw new Error("TEST_DATABASE_URL is required");
  const databaseName = `datapad_upgrade_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const folder = await mkdtemp(join(tmpdir(), "datapad-upgrade-"));
  const url = new URL(process.env.TEST_DATABASE_URL);
  url.pathname = `/${databaseName}`;
  let pool: Pool | undefined;
  try {
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    pool = new Pool({ connectionString: url.toString() });
    const db = drizzle(pool);
    const migrations = new URL("../../drizzle/", import.meta.url).pathname;
    const journal = await Bun.file(
      join(migrations, "meta/_journal.json"),
    ).json();
    const baseline = { ...journal, entries: journal.entries.slice(0, 2) };
    await mkdir(join(folder, "meta"));
    await writeFile(
      join(folder, "meta/_journal.json"),
      JSON.stringify(baseline),
    );
    for (const entry of baseline.entries)
      await copyFile(
        join(migrations, `${entry.tag}.sql`),
        join(folder, `${entry.tag}.sql`),
      );
    await migrate(db, { migrationsFolder: folder });
    const mappingId = randomUUID();
    const invoiceId = randomUUID();
    const lineId = randomUUID();
    await pool.query(
      `INSERT INTO billing_customers (id,deployment_key,provider_account_id,key,name,provider_customer_id,create_attempted_at,created_at)
      VALUES ($1,'migration-test','acct_sample','elm','Elm Studio','cus_sample','2030-01-01T12:00:00Z','2030-01-01T12:00:00Z')`,
      [mappingId],
    );
    await pool.query(
      `INSERT INTO invoices (id,deployment_key,origin_key,request_digest,customer_id,issue_date,due_date,readiness_date,currency,total_minor,state,provider_invoice_id,provider_status,created_at,create_attempted_at,finalize_attempted_at)
      VALUES ($1,'migration-test','sample-period','immutable-digest',$2,'2030-01-01','2030-01-22','2030-01-01','USD',1200,'paid','in_sample','paid','2030-01-01T12:00:00Z','2030-01-01T12:01:00Z','2030-01-01T12:02:00Z')`,
      [invoiceId, mappingId],
    );
    await pool.query(
      `INSERT INTO invoice_lines (id,invoice_id,position,description,amount_minor,provider_line_id,create_attempted_at) VALUES ($1,$2,0,'Web hosting',1200,'il_sample','2030-01-01T12:01:30Z')`,
      [lineId, invoiceId],
    );
    const original = await pool.query(
      "SELECT to_jsonb(i) AS invoice FROM invoices i WHERE id=$1",
      [invoiceId],
    );
    await migrate(db, { migrationsFolder: migrations });
    const mapped = await pool.query(
      "SELECT customer_id, provider_customer_id, create_attempted_at FROM billing_customers WHERE id=$1",
      [mappingId],
    );
    const customerId: string = mapped.rows[0].customer_id;
    expect(customerId).not.toBe(mappingId);
    expect(mapped.rows[0].provider_customer_id).toBe("cus_sample");
    expect(mapped.rows[0].create_attempted_at.toISOString()).toBe(
      "2030-01-01T12:00:00.000Z",
    );
    const after = await pool.query(
      "SELECT to_jsonb(i) - 'bill_to_name' - 'bill_to_email' - 'bill_to_profile_version' - 'request_customer_name' AS invoice FROM invoices i WHERE id=$1",
      [invoiceId],
    );
    const historical = original.rows[0].invoice;
    historical.billing_customer_id = historical.customer_id;
    historical.provider_receipt_state = "unverified";
    historical.calendar = null;
    historical.issue_not_before = "2030-01-01T00:00:00+00:00";
    historical.first_attempt_before = "2030-01-22T00:00:00+00:00";
    historical.due_end_at = "2030-01-22T23:59:59+00:00";
    delete historical.customer_id;
    expect(after.rows).toEqual([{ invoice: historical }]);
    const customer = await pool.query(
      "SELECT registry_key, organization_id, legal_name FROM customers WHERE id=$1",
      [customerId],
    );
    expect(customer.rows[0]).toEqual({
      registry_key: JSON.stringify(["migration-test", "elm"]),
      organization_id: null,
      legal_name: "Elm Studio",
    });
    await pool.query(
      "UPDATE customers SET legal_name='Elm Studio Updated', version=2 WHERE id=$1",
      [customerId],
    );
    const reader = createBillingReader({
      pool,
      deploymentKey: "migration-test",
    });
    const detail = await reader.getInvoiceForCustomers([customerId], invoiceId);
    expect(detail?.invoice.providerReceipt).toEqual({
      state: "unverified",
      reason: null,
    });
    expect(detail?.invoice.hostedInvoiceUrl).toBeNull();
    expect(detail?.invoice.calendar).toBeNull();
    expect(detail?.invoice.customer).toEqual({
      id: customerId,
      name: "Elm Studio",
    });
    expect(detail?.invoice.billTo).toEqual({
      legalName: "Elm Studio",
      billingEmail: null,
      profileVersion: 1,
    });
    expect(detail?.invoice.lines[0]).toMatchObject({
      id: lineId,
      amountMinor: 1200,
    });
    expect((await reader.listInvoicesForCustomers([customerId])).total).toBe(1);
    expect(
      await reader.getInvoiceForCustomers([randomUUID()], invoiceId),
    ).toBeNull();
    expect((await reader.listInvoicesForCustomers([])).total).toBe(0);
    expect(
      await reader.providerProfile(customerId, {
        legalName: "Elm Studio Updated",
        billingEmail: null,
      }),
    ).toBe("pending");
  } finally {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await admin.end();
    await rm(folder, { recursive: true, force: true });
  }
});
