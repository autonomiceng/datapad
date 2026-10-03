import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import Stripe from "stripe";
import { createBilling } from "../../src/billing";
import { createAuditWriter } from "../../src/access";
import { createCustomerRegistry } from "../../src/customers";
import { createStripeEventVerifier } from "../../src/stripe";
import { createApp } from "../../src/server/app";
import { SyntheticBillingProvider } from "./billing-provider";

const unused = async (): Promise<never> => {
  throw new Error("Unexpected human operation.");
};

test("authenticated composition accepts original signed webhook bytes durably without browser origin or session", async () => {
  if (!process.env.TEST_DATABASE_URL)
    throw new Error("TEST_DATABASE_URL is required");
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const deploymentKey = randomUUID();
  const provider = new SyntheticBillingProvider();
  provider.ownership.deploymentKey = deploymentKey;
  const signingSecret = "whsec_synthetic_composition";
  const billing = createBilling({
    pool,
    deploymentKey,
    provider,
    now: () => new Date("2030-01-01T12:00:00Z"),
    customers: createCustomerRegistry({
      operatorId: "synthetic-composition",
      audit: createAuditWriter(),
      allowProfile: (profile) =>
        profile.displayName === "Webhook sample" &&
        profile.legalName === "Webhook sample" &&
        profile.billingEmail === null,
    }),
  });
  const app = createApp({
    importReview: {
      listSources: unused,
      listImports: unused,
      listCustomers: unused,
      getCustomer: unused,
      listDataIssues: unused,
    },
    accounts: {
      routes: {
        origin: "http://localhost",
        access: {
          resolveActor: async () => ({
            userId: "sample-staff",
            sessionId: "sample-session",
          }),
          getSession: unused,
          listMembers: unused,
          listInvitations: unused,
          inviteMember: unused,
          revokeMember: unused,
          revokeInvitation: unused,
          acceptInvitation: unused,
        },
        customers: {
          listCustomers: unused,
          getCustomer: unused,
          updateCustomer: unused,
        },
      },
      authHandler: unused,
      authorizeImport: unused,
    },
    billing: {
      reader: billing,
      authorizeRead: async () => ({ ok: false, code: "unauthenticated" }),
      webhook: {
        verifier: createStripeEventVerifier({
          signingSecret,
          ownership: provider.ownership,
        }),
        acceptEvent: (event) => billing.acceptEvent(event),
      },
    },
  });
  try {
    const requested = await billing.requestInvoice({
      originKey: "signed-composition",
      customer: { key: "webhook", name: "Webhook sample" },
      issueDate: "2030-01-01",
      dueDate: "2030-01-22",
      currency: "USD",
      lines: [
        { description: "Sample service", amountMinor: 2300, originRef: null },
      ],
    });
    if (requested.kind !== "created")
      throw new Error("Expected a prepared synthetic invoice.");
    expect((await billing.requestIssue(requested.invoiceId)).kind).toBe(
      "accepted",
    );
    const eventId = `evt_${randomUUID()}`;
    const body = JSON.stringify(
      {
        id: eventId,
        object: "event",
        type: "invoice.paid",
        livemode: false,
        created: Math.floor(Date.now() / 1000),
        data: {
          object: {
            id: `in_${randomUUID()}`,
            object: "invoice",
            metadata: {
              datapad_deployment: deploymentKey,
              datapad_invoice: requested.invoiceId,
            },
          },
        },
      },
      null,
      2,
    );
    const signature = await Stripe.webhooks.generateTestHeaderStringAsync({
      payload: body,
      secret: signingSecret,
    });
    const post = (payload: string, signed?: string) =>
      app.handle(
        new Request("http://localhost/api/billing/webhooks/stripe", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(signed ? { "stripe-signature": signed } : {}),
          },
          body: payload,
        }),
      );
    expect((await post(body, signature)).status).toBe(200);
    const persisted = await pool.query(
      "select event_id, deployment_key from stripe_events where event_id = $1",
      [eventId],
    );
    expect(persisted.rows).toEqual([
      { event_id: eventId, deployment_key: deploymentKey },
    ]);
    expect((await post(body, signature)).status).toBe(200);
    expect((await post(`${body} `, signature)).status).toBe(400);
    expect((await post(body)).status).toBe(400);
    expect(
      (
        await pool.query(
          "select count(*)::int as total from stripe_events where event_id = $1",
          [eventId],
        )
      ).rows[0].total,
    ).toBe(1);
    expect(
      (
        await app.handle(
          new Request("http://localhost/api/billing/invoices", {
            method: "GET",
          }),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await app.handle(
          new Request(`http://localhost/api/customers/${randomUUID()}`, {
            method: "PATCH",
            headers: {
              "content-type": "application/json",
              origin: "http://foreign.test",
            },
            body: JSON.stringify({
              requestId: randomUUID(),
              expectedVersion: 1,
              profile: {
                displayName: "Webhook sample",
                legalName: "Webhook sample",
                billingEmail: null,
              },
            }),
          }),
        )
      ).status,
    ).toBe(403);
  } finally {
    await pool.query("delete from stripe_events where deployment_key = $1", [
      deploymentKey,
    ]);
    await pool.query(
      "delete from invoice_lines where invoice_id in (select id from invoices where deployment_key = $1)",
      [deploymentKey],
    );
    await pool.query("delete from invoices where deployment_key = $1", [
      deploymentKey,
    ]);
    await pool.query(
      "delete from billing_customers where deployment_key = $1",
      [deploymentKey],
    );
    const registryKey = JSON.stringify([deploymentKey, "webhook"]);
    await pool.query(
      "delete from access_audit where customer_id = (select id from customers where registry_key = $1)",
      [registryKey],
    );
    await pool.query("delete from customers where registry_key = $1", [
      registryKey,
    ]);
    await pool.end();
  }
});
