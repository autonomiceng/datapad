import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type { RegisteredCustomer } from "../../customers/types";
import type { InvoiceRequest } from "../contract";
import type { BillingOptions, RequestResult } from "../types";
import { billingCustomers, invoiceLines, invoices } from "./schema";
import { readinessDate, requestDigest, validateRequest } from "./validate";

export async function ensureMapping(
  tx: NodePgDatabase,
  options: BillingOptions,
  account: RegisteredCustomer,
  key: string,
  name: string,
  createdAt: string,
) {
  const scope = and(
    eq(billingCustomers.deploymentKey, options.deploymentKey),
    eq(billingCustomers.customerId, account.customerId),
  );
  let [mapping] = await tx.select().from(billingCustomers).where(scope);
  if (!mapping) {
    await tx
      .insert(billingCustomers)
      .values({
        id: randomUUID(),
        customerId: account.customerId,
        deploymentKey: options.deploymentKey,
        providerAccountId: options.provider.ownership.accountId,
        key,
        name,
        createdAt,
      })
      .onConflictDoNothing();
    [mapping] = await tx.select().from(billingCustomers).where(scope);
  }
  return mapping?.providerAccountId === options.provider.ownership.accountId
    ? mapping
    : null;
}

export async function persistInvoice(
  tx: NodePgDatabase,
  deploymentKey: string,
  request: InvoiceRequest,
  account: RegisteredCustomer,
  billingCustomerId: string,
  createdAt: string,
): Promise<string> {
  const invoiceId = randomUUID();
  await tx.insert(invoices).values({
    id: invoiceId,
    deploymentKey,
    originKey: request.originKey,
    requestDigest: requestDigest(request),
    requestCustomerName: request.customer.name,
    billingCustomerId,
    billToName: account.profile.legalName,
    billToEmail: account.profile.billingEmail,
    billToProfileVersion: account.version,
    issueDate: request.issueDate,
    dueDate: request.dueDate,
    readinessDate: readinessDate(request.dueDate),
    currency: request.currency,
    totalMinor: request.lines.reduce((sum, line) => sum + line.amountMinor, 0),
    state: "requested",
    createdAt,
  });
  await tx.insert(invoiceLines).values(
    request.lines.map((line, position) => ({
      id: randomUUID(),
      invoiceId,
      position,
      ...line,
    })),
  );
  return invoiceId;
}

export function createRequester(options: BillingOptions) {
  const { pool, deploymentKey, customers, now = () => new Date() } = options;
  const db = drizzle(pool);
  return async (input: unknown): Promise<RequestResult> => {
    const request = validateRequest(input);
    if (!request) return { kind: "invalid", fields: ["/"] };
    const digest = requestDigest(request);
    return db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`request:${deploymentKey}:${request.originKey}`}, 0))`,
      );
      const [existing] = await tx
        .select()
        .from(invoices)
        .where(
          and(
            eq(invoices.deploymentKey, deploymentKey),
            eq(invoices.originKey, request.originKey),
          ),
        );
      if (existing)
        return existing.requestDigest === digest
          ? { kind: "unchanged", invoiceId: existing.id }
          : { kind: "conflict" };
      if (request.dueDate <= now().toISOString().slice(0, 10))
        return { kind: "invalid", fields: ["/dueDate"] };
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`customer-key:${deploymentKey}:${request.customer.key}`}, 0))`,
      );
      const account = await customers.ensureCustomer(tx, {
        registryKey: JSON.stringify([deploymentKey, request.customer.key]),
        initialProfile: {
          displayName: request.customer.name,
          legalName: request.customer.name,
          billingEmail: null,
        },
      });
      const createdAt = now().toISOString();
      const mapping = await ensureMapping(
        tx,
        options,
        account,
        request.customer.key,
        request.customer.name,
        createdAt,
      );
      if (!mapping || mapping.key !== request.customer.key)
        return { kind: "conflict" };
      const invoiceId = await persistInvoice(
        tx,
        deploymentKey,
        request,
        account,
        mapping.id,
        createdAt,
      );
      return { kind: "created", invoiceId };
    });
  };
}
