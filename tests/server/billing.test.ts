import { afterAll, beforeEach, expect, test } from "bun:test";
import { Pool } from "pg";
import {
  createBilling,
  createBillingReader,
  type Billing,
} from "../../src/billing";
import type { InvoiceRequest } from "../../src/billing/contract";
import {
  BillingProviderError,
  type VerifiedInvoiceEvent,
} from "../../src/billing/provider";
import { SyntheticBillingProvider } from "./billing-provider";
import { createCustomerRegistry } from "../../src/customers";
import { createAuditWriter } from "../../src/access";

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL is required");
const pool = new Pool({ connectionString: url });
const clear = () =>
  pool.query(
    "TRUNCATE billing_customers, invoices, invoice_lines, stripe_events CASCADE",
  );
beforeEach(clear);
afterAll(async () => {
  await clear();
  await pool.end();
});
const fixture = (originKey = "manual:synthetic"): InvoiceRequest => ({
  originKey,
  customer: { key: "synthetic-customer", name: "Synthetic customer" },
  issueDate: "2030-01-01",
  dueDate: "2030-01-22",
  currency: "USD",
  lines: [
    {
      description: "Synthetic web hosting",
      amountMinor: 1200,
      originRef: "synthetic:hosting",
    },
    { description: "Synthetic DNS hosting", amountMinor: 300, originRef: null },
  ],
});
function setup() {
  const provider = new SyntheticBillingProvider();
  let clock = new Date("2030-01-01T12:00:00Z");
  const options = {
    pool,
    provider,
    deploymentKey: provider.ownership.deploymentKey,
    customers: createCustomerRegistry({
      operatorId: "synthetic-test",
      audit: createAuditWriter(),
      allowProfile: () => true,
    }),
    now: () => clock,
  };
  return {
    provider,
    options,
    billing: createBilling(options),
    advance: (milliseconds: number) => {
      clock = new Date(clock.getTime() + milliseconds);
    },
    setDate: (date: string) => {
      clock = new Date(date);
    },
  };
}
async function request(billing: Billing, input = fixture()) {
  const result = await billing.requestInvoice(input);
  if (result.kind !== "created" && result.kind !== "unchanged")
    throw new Error("Synthetic invoice request failed");
  return result.invoiceId;
}
function event(
  invoiceId: string,
  eventId = "evt_synthetic",
): VerifiedInvoiceEvent {
  return {
    deploymentKey: "billing-test",
    accountId: "acct_synthetic",
    invoiceId,
    providerInvoiceId: `in_${invoiceId}`,
    eventId,
    eventType: "invoice.paid",
    createdAt: "2030-01-01T12:00:00Z",
  };
}
const rejection = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: unknown) => error,
  );

test("billing requests persist immutable positive USD lines, arbitrate concurrent identity and enforce readiness and synthetic policy", async () => {
  const state = setup();
  state.setDate("2029-12-31T12:00:00Z");
  const values = await Promise.all([
    state.billing.requestInvoice(fixture()),
    state.billing.requestInvoice(fixture()),
  ]);
  expect(values.map((value) => value.kind).sort()).toEqual([
    "created",
    "unchanged",
  ]);
  const id = await request(state.billing);
  expect(
    await state.billing.requestInvoice({
      ...fixture(),
      lines: [{ description: "Changed", amountMinor: 1500, originRef: null }],
    }),
  ).toEqual({ kind: "conflict" });
  expect(await state.billing.requestIssue(id)).toEqual({ kind: "not_ready" });
  expect(await state.billing.issueInvoice(id)).toBe("complete");
  expect(state.provider.calls.invoice).toBe(0);
  for (const input of [
    { ...fixture("bad-date"), dueDate: "2030-02-30" },
    {
      ...fixture("zero"),
      lines: [{ description: "Free", amountMinor: 0, originRef: null }],
    },
    { ...fixture("unsafe"), customer: { key: "other", name: "bad\u0000name" } },
    { ...fixture("secret"), email: "unsafe@example.test" },
  ])
    expect((await state.billing.requestInvoice(input)).kind).toBe("invalid");
  state.setDate("2030-01-01T00:00:00Z");
  expect(await state.billing.requestIssue(id)).toEqual({ kind: "accepted" });
  const detail = (await state.billing.getInvoice(id))!.invoice;
  expect(detail).toMatchObject({
    readinessDate: "2030-01-01",
    dueDate: "2030-01-22",
    totalMinor: 1500,
    currency: "USD",
    state: "preparing",
  });
  expect(detail.lines.map((line) => line.originRef)).toEqual([
    "synthetic:hosting",
    null,
  ]);
  const reader = createBillingReader({ pool, deploymentKey: "billing-test" });
  await reader.assertSyntheticData([fixture()], "acct_synthetic");
  expect(
    await rejection(reader.assertSyntheticData([fixture()])),
  ).toBeInstanceOf(Error);
  expect(
    await rejection(reader.assertSyntheticData([], "acct_synthetic")),
  ).toBeInstanceOf(Error);
  expect((await reader.listInvoices()).total).toBe(1);
});

test("concurrent workers and process restart issue one owned invoice and preserve provider-free reads", async () => {
  const state = setup();
  const id = await request(state.billing);
  await state.billing.requestIssue(id);
  const otherPool = new Pool({ connectionString: url });
  try {
    const other = createBilling({ ...state.options, pool: otherPool });
    expect(
      await Promise.all([
        state.billing.issueInvoice(id),
        other.issueInvoice(id),
      ]),
    ).toEqual(["complete", "complete"]);
    expect(state.provider.calls).toMatchObject({
      customer: 1,
      invoice: 1,
      line: 2,
      finalize: 1,
    });
    const restarted = createBilling(state.options);
    expect(await restarted.requestIssue(id)).toEqual({ kind: "unchanged" });
    expect(await restarted.issueInvoice(id)).toBe("complete");
    expect((await restarted.getInvoice(id))!.invoice).toMatchObject({
      state: "open",
      lastCheckedAt: "2030-01-01T12:00:00.000Z",
      issuedAt: "2030-01-01T12:00:00.000Z",
      totalMinor: 1500,
      providerStatus: "open",
      hostedInvoiceUrl: `https://invoice.stripe.com/i/in_${id}`,
    });
    expect(await restarted.pendingWork()).toEqual([]);
  } finally {
    await otherPool.end();
  }
});

test("lost customer, invoice, partial line and finalization receipts recover independently; expired uncertain effects stop", async () => {
  const state = setup();
  state.provider.interrupt = new Set([
    "customer",
    "invoice",
    "line",
    "finalize",
  ]);
  const id = await request(state.billing);
  await state.billing.requestIssue(id);
  for (const delay of [6000, 31000, 121000, 601000]) {
    expect(await createBilling(state.options).issueInvoice(id)).toBe("retry");
    state.advance(delay);
  }
  expect(await createBilling(state.options).issueInvoice(id)).toBe("complete");
  expect(state.provider.calls).toMatchObject({
    customer: 1,
    invoice: 1,
    line: 2,
    finalize: 1,
  });
  expect((await state.billing.getInvoice(id))!.invoice.state).toBe("open");
  const uncertain = await request(state.billing, fixture("manual:uncertain"));
  await state.billing.requestIssue(uncertain);
  state.provider.interrupt.add("invoice");
  expect(await state.billing.issueInvoice(uncertain)).toBe("retry");
  state.provider.invoices.delete(`in_${uncertain}`);
  state.advance(24 * 60 * 60 * 1000);
  expect(await state.billing.issueInvoice(uncertain)).toBe("needs_review");
  expect((await state.billing.getInvoice(uncertain))!.invoice).toMatchObject({
    state: "needs_review",
    reviewReason: "uncertain_invoice",
    providerReceipt: { state: "unverified", reason: null },
    hostedInvoiceUrl: null,
  });
  expect(state.provider.calls.invoice).toBe(2);

  const missingLine = await request(
    state.billing,
    fixture("manual:uncertain-line"),
  );
  await state.billing.requestIssue(missingLine);
  state.provider.interrupt.add("line");
  expect(await state.billing.issueInvoice(missingLine)).toBe("retry");
  const draft = state.provider.invoices.get(`in_${missingLine}`)!;
  draft.lines = [];
  draft.totalMinor = 0;
  expect(await state.billing.refreshInvoice(missingLine)).toBe("complete");
  state.advance(24 * 60 * 60 * 1000);
  expect(await state.billing.issueInvoice(missingLine)).toBe("needs_review");
  expect((await state.billing.getInvoice(missingLine))!.invoice).toMatchObject({
    state: "needs_review",
    reviewReason: "uncertain_line",
    providerReceipt: { state: "verified", reason: null },
  });
});

test("receipt uncertainty preserves trust while an initial observed contradiction marks mismatch", async () => {
  const state = setup();
  const uncertain = await request(state.billing);
  await state.billing.requestIssue(uncertain);
  const findCustomer = state.provider.findCustomer.bind(state.provider);
  state.provider.findCustomer = async () => ({ kind: "ambiguous" });
  expect(await state.billing.issueInvoice(uncertain)).toBe("needs_review");
  expect((await state.billing.getInvoice(uncertain))!.invoice).toMatchObject({
    state: "needs_review",
    reviewReason: "uncertain_customer",
    providerReceipt: { state: "unverified", reason: null },
  });
  state.provider.findCustomer = findCustomer;
  const contradicted = await request(
    state.billing,
    fixture("manual:contradicted"),
  );
  await state.billing.requestIssue(contradicted);
  state.provider.onCreate = async (invoice) => {
    invoice.recipientName = "Different synthetic customer";
  };
  expect(await state.billing.issueInvoice(contradicted)).toBe("needs_review");
  expect((await state.billing.getInvoice(contradicted))!.invoice).toMatchObject(
    {
      providerReceipt: { state: "mismatch", reason: "invoice_mismatch" },
    },
  );
  expect(
    (
      await pool.query("SELECT provider_invoice_id FROM invoices WHERE id=$1", [
        contradicted,
      ])
    ).rows,
  ).toEqual([{ provider_invoice_id: null }]);
});

test("durable events arriving before create receipts recover Paid, reject unrelated identities and cannot regress terminal status", async () => {
  const state = setup();
  const id = await request(state.billing);
  await state.billing.requestIssue(id);
  state.provider.onCreate = async (invoice, intent) => {
    invoice.lines = intent.lines.map((line) => ({
      ...line,
      currency: "USD",
      providerLineId: `il_${line.lineId}`,
    }));
    invoice.totalMinor = intent.totalMinor;
    invoice.status = "paid";
    invoice.finalizedAt = "2030-01-01T12:00:00Z";
    invoice.hostedInvoiceUrl = `https://invoice.stripe.com/i/${invoice.providerInvoiceId}`;
    expect(await state.billing.acceptEvent(event(id))).toBe("accepted");
  };
  state.provider.interrupt.add("invoice");
  expect(await state.billing.issueInvoice(id)).toBe("retry");
  expect(await state.billing.acceptEvent(event(id))).toBe("duplicate");
  const unrelatedId = "in_unrelated_claim";
  state.provider.invoices.set(unrelatedId, {
    ...structuredClone(state.provider.invoices.get(`in_${id}`)!),
    providerInvoiceId: unrelatedId,
    accountId: "acct_foreign",
  });
  expect(
    await state.billing.acceptEvent({
      ...event(id, "evt_unrelated_claim"),
      providerInvoiceId: unrelatedId,
    }),
  ).toBe("accepted");
  expect(await state.billing.processEvent("evt_unrelated_claim")).toBe(
    "complete",
  );
  expect((await state.billing.getInvoice(id))!.invoice.state).toBe("preparing");

  expect(
    await state.billing.acceptEvent({
      ...event(id, "evt_foreign"),
      accountId: "acct_foreign",
    }),
  ).toBe("ignored");
  expect(
    await state.billing.acceptEvent({
      ...event(id, "evt_unknown"),
      invoiceId: null,
      providerInvoiceId: "in_unrelated",
    }),
  ).toBe("ignored");
  expect(await createBilling(state.options).processEvent("evt_synthetic")).toBe(
    "complete",
  );
  expect((await state.billing.getInvoice(id))!.invoice.state).toBe("paid");
  const retrieveInvoice = state.provider.retrieveInvoice.bind(state.provider);
  state.provider.retrieveInvoice = async () => {
    throw new BillingProviderError("review", "provider_conflict");
  };
  expect(await state.billing.refreshInvoice(id)).toBe("needs_review");
  expect(
    await state.billing.acceptEvent(event(id, "evt_unobserved_review")),
  ).toBe("accepted");
  expect(await state.billing.processEvent("evt_unobserved_review")).toBe(
    "needs_review",
  );
  expect(
    (
      await pool.query(
        "SELECT last_error FROM stripe_events WHERE event_id=$1",
        ["evt_unobserved_review"],
      )
    ).rows,
  ).toEqual([{ last_error: "provider_conflict" }]);
  expect((await state.billing.getInvoice(id))!.invoice).toMatchObject({
    state: "paid",
    reviewReason: null,
    providerReceipt: { state: "verified", reason: null },
    hostedInvoiceUrl: `https://invoice.stripe.com/i/in_${id}`,
  });
  state.provider.retrieveInvoice = retrieveInvoice;
  const current = state.provider.invoices.get(`in_${id}`)!;
  state.provider.stale = { ...structuredClone(current), status: "open" };
  expect(await state.billing.refreshInvoice(id)).toBe("needs_review");
  expect((await state.billing.getInvoice(id))!.invoice).toMatchObject({
    state: "paid",
    providerReceipt: { state: "mismatch", reason: "provider_conflict" },
    hostedInvoiceUrl: null,
  });
  expect(await state.billing.issueInvoice(id)).toBe("complete");
  expect(state.provider.calls.invoice).toBe(1);
});

test("pending work survives a lost enqueue and transient event retrieval; exhausted retries remain visible", async () => {
  const state = setup();
  const id = await request(state.billing);
  await state.billing.requestIssue(id);
  expect(await createBilling(state.options).pendingWork()).toEqual([
    { kind: "issue", invoiceId: id },
  ]);
  await state.billing.issueInvoice(id);
  await state.billing.acceptEvent(event(id));
  expect(await state.billing.pendingWork()).toEqual([
    { kind: "event", eventId: "evt_synthetic" },
  ]);
  state.provider.unavailable = true;
  expect(await state.billing.processEvent("evt_synthetic")).toBe("retry");
  expect(await state.billing.pendingWork()).toEqual([]);
  state.advance(6000);
  state.provider.unavailable = false;
  state.provider.invoices.get(`in_${id}`)!.status = "paid";
  expect(await state.billing.processEvent("evt_synthetic")).toBe("complete");
  expect((await state.billing.getInvoice(id))!.invoice.state).toBe("paid");
  const exhausted = await request(state.billing, fixture("manual:exhausted"));
  await state.billing.requestIssue(exhausted);
  await state.billing.issueInvoice(exhausted);
  await state.billing.acceptEvent(event(exhausted, "evt_exhausted"));
  state.provider.unavailable = true;
  for (const delay of [6000, 31000, 121000, 601000]) {
    expect(await state.billing.processEvent("evt_exhausted")).toBe("retry");
    state.advance(delay);
  }
  expect(await state.billing.processEvent("evt_exhausted")).toBe(
    "needs_review",
  );
  expect((await state.billing.getInvoice(exhausted))!.invoice).toMatchObject({
    state: "open",
    providerStatus: "open",
    reviewReason: null,
    providerReceipt: { state: "verified", reason: null },
    hostedInvoiceUrl: `https://invoice.stripe.com/i/in_${exhausted}`,
  });
  expect(await state.billing.pendingWork()).toEqual([]);
});

test("exhausted event retrieval before the create receipt preserves pending invoice recovery", async () => {
  const state = setup();
  const id = await request(state.billing);
  await state.billing.requestIssue(id);
  state.provider.onCreate = async () => {
    expect(await state.billing.acceptEvent(event(id))).toBe("accepted");
  };
  state.provider.interrupt.add("invoice");
  expect(await state.billing.issueInvoice(id)).toBe("retry");
  state.provider.unavailable = true;
  for (const delay of [6000, 31000, 121000, 601000]) {
    expect(await state.billing.processEvent("evt_synthetic")).toBe("retry");
    state.advance(delay);
  }
  expect(await state.billing.processEvent("evt_synthetic")).toBe(
    "needs_review",
  );
  expect((await state.billing.getInvoice(id))!.invoice).toMatchObject({
    state: "preparing",
    providerStatus: null,
    reviewReason: null,
  });
  expect(await state.billing.pendingWork()).toEqual([
    { kind: "issue", invoiceId: id },
  ]);
  const receipt = await pool.query(
    "SELECT attempts, last_error, processed_at FROM stripe_events WHERE event_id = $1",
    ["evt_synthetic"],
  );
  expect(receipt.rows).toEqual([
    { attempts: 5, last_error: "retry_exhausted", processed_at: null },
  ]);
  state.provider.unavailable = false;
  expect(await createBilling(state.options).issueInvoice(id)).toBe("complete");
  expect((await state.billing.getInvoice(id))!.invoice.state).toBe("open");
  expect(state.provider.calls).toMatchObject({
    invoice: 1,
    line: 2,
    finalize: 1,
  });
});
