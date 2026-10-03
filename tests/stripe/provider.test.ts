import { rejects } from "node:assert/strict";
import { expect, test } from "bun:test";
import Stripe from "stripe";
import {
  createStripeBillingProvider,
  createStripeEventVerifier,
} from "../../src/stripe";
import {
  BillingProviderError,
  type InvoiceIntent,
} from "../../src/billing/provider";

const ownership = { accountId: "acct_synthetic", deploymentKey: "synthetic" };
const intent: InvoiceIntent = {
  ...ownership,
  recipientName: "Synthetic customer",
  customerId: "00000000-0000-4000-8000-000000000001",
  invoiceId: "00000000-0000-4000-8000-000000000002",
  providerCustomerId: "cus_synthetic",
  issueDate: "2026-10-03",
  dueDate: "2026-10-24",
  dueEndAt: "2026-10-25T06:59:59.000Z",
  currency: "USD",
  totalMinor: 100,
  lines: [
    {
      lineId: "00000000-0000-4000-8000-000000000003",
      position: 0,
      description: "Synthetic service",
      amountMinor: 100,
    },
  ],
};
const invoiceMetadata = {
  datapad_deployment: ownership.deploymentKey,
  datapad_customer: intent.customerId,
  datapad_invoice: intent.invoiceId,
  datapad_issue_date: intent.issueDate,
  datapad_due_date: intent.dueDate,
};
function invoice(status = "draft", total = 0) {
  return {
    id: "in_synthetic",
    object: "invoice",
    metadata: invoiceMetadata,
    livemode: false,
    customer: intent.providerCustomerId,
    customer_name: intent.recipientName,
    customer_email: `${intent.customerId}@billing.test`,
    currency: "usd",
    collection_method: "send_invoice",
    auto_advance: false,
    due_date: Date.parse("2026-10-25T06:59:59.000Z") / 1000,
    automatic_tax: { enabled: false },
    discounts: [],
    total_discount_amounts: [],
    total_taxes: [],
    starting_balance: 0,
    pre_payment_credit_notes_amount: 0,
    post_payment_credit_notes_amount: 0,
    parent: null,
    status,
    total,
    subtotal: total,
    hosted_invoice_url: null,
    status_transitions: {
      finalized_at:
        status === "draft" ? null : Date.parse("2026-10-03T00:00:00Z") / 1000,
    },
  };
}
const line = {
  id: "il_synthetic",
  object: "line_item",
  livemode: false,
  invoice: "in_synthetic",
  currency: "usd",
  description: "Synthetic service",
  amount: 100,
  subtotal: 100,
  discounts: [],
  discount_amounts: [],
  pretax_credit_amounts: [],
  taxes: [],
  metadata: {
    ...invoiceMetadata,
    datapad_line: intent.lines[0].lineId,
    datapad_position: "0",
  },
  parent: {
    type: "invoice_item_details",
    invoice_item_details: {
      invoice_item: "ii_synthetic",
      proration: false,
      subscription: null,
    },
  },
};
function list(data: unknown[], hasMore = false) {
  return { object: "list", data, has_more: hasMore, url: "/v1/invoices" };
}
async function provider(
  route: (url: URL, method: string, body: string | undefined) => unknown,
  maxPages = 100,
) {
  const fetcher = Object.assign(
    async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const url = new URL(
        input instanceof Request ? input.url : input.toString(),
      );
      const value =
        url.pathname === "/v1/account"
          ? { id: ownership.accountId, object: "account" }
          : route(
              url,
              init?.method ?? "GET",
              typeof init?.body === "string" ? init.body : undefined,
            );
      return new Response(JSON.stringify(value), {
        headers: { "Content-Type": "application/json" },
      });
    },
    { preconnect: () => {} },
  );
  return createStripeBillingProvider({
    apiKey: "rk_test_synthetic",
    ...ownership,
    maxPages,
    httpClient: Stripe.createFetchHttpClient(fetcher),
  });
}

test("recovery inspects every page, returns actual partial draft and stops on incomplete lookup", async () => {
  const cursors: (string | null)[] = [];
  const adapter = await provider((url) => {
    if (url.pathname.endsWith("/lines")) return list([]);
    cursors.push(url.searchParams.get("starting_after"));
    return url.searchParams.has("starting_after")
      ? list([invoice()])
      : list([{ ...invoice(), id: "in_unrelated", metadata: {} }], true);
  });
  const found = await adapter.findInvoice(intent);
  expect(cursors).toEqual([null, "in_unrelated"]);
  expect(found.kind).toBe("found");
  if (found.kind === "found") expect(found.value.totalMinor).toBe(0);
  const bounded = await provider(
    () => list([{ ...invoice(), id: "in_unrelated", metadata: {} }], true),
    1,
  );
  expect(await bounded.findInvoice(intent)).toEqual({ kind: "ambiguous" });
  const incompleteLines = await provider(
    (url) =>
      url.pathname.endsWith("/lines")
        ? list([line], true)
        : invoice("paid", 100),
    1,
  );
  await rejects(incompleteLines.retrieveInvoice(intent, "in_synthetic"), {
    kind: "review",
    receiptMismatch: false,
  });
});

test("retrieval preserves actual recipients, amounts and line identities; recipient mismatch blocks finalization and duplicate ownership fails", async () => {
  const adapter = await provider((url) =>
    url.pathname.endsWith("/lines") ? list([line]) : invoice("paid", 100),
  );
  const paid = await adapter.retrieveInvoice(intent, "in_synthetic");
  expect(paid.lines[0].providerLineId).toBe("ii_synthetic");
  expect(paid.lines[0].amountMinor).toBe(100);
  expect(paid.dueEndAt).toBe(intent.dueEndAt);
  expect(paid.recipientName).toBe(intent.recipientName);
  expect(paid.recipientEmail).toBe(`${intent.customerId}@billing.test`);
  const renamed = await provider((url) =>
    url.pathname.endsWith("/lines")
      ? list([line])
      : {
          ...invoice("draft", 100),
          customer_name: "Changed synthetic customer",
        },
  );
  expect(await renamed.retrieveInvoice(intent, "in_synthetic")).toMatchObject({
    recipientName: "Changed synthetic customer",
    recipientEmail: `${intent.customerId}@billing.test`,
  });
  await rejects(
    renamed.finalizeInvoice(intent, "in_synthetic", {
      idempotencyKey: "synthetic",
    }),
    { kind: "review", reason: "invoice_mismatch", receiptMismatch: true },
  );
  const differentEmail = await provider((url) =>
    url.pathname.endsWith("/lines")
      ? list([line])
      : { ...invoice("draft", 100), customer_email: "changed@billing.test" },
  );
  expect(
    await differentEmail.retrieveInvoice(intent, "in_synthetic"),
  ).toMatchObject({
    recipientName: intent.recipientName,
    recipientEmail: "changed@billing.test",
  });
  await rejects(
    differentEmail.finalizeInvoice(intent, "in_synthetic", {
      idempotencyKey: "synthetic",
    }),
    { kind: "review", reason: "invoice_mismatch", receiptMismatch: true },
  );
  const missing = await provider((url) =>
    url.pathname.endsWith("/lines")
      ? list([line])
      : { ...invoice("paid", 100), customer_name: null, customer_email: null },
  );
  expect(await missing.retrieveInvoice(intent, "in_synthetic")).toMatchObject({
    status: "paid",
    recipientName: null,
    recipientEmail: null,
  });
  const changed = await provider((url) =>
    url.pathname.endsWith("/lines")
      ? list([{ ...line, amount: 200 }])
      : invoice("paid", 100),
  );
  await rejects(changed.retrieveInvoice(intent, "in_synthetic"), {
    kind: "review",
    reason: "invoice_mismatch",
    receiptMismatch: true,
  });
  const duplicate = await provider(() =>
    list([invoice(), { ...invoice(), id: "in_duplicate" }]),
  );
  expect(await duplicate.findInvoice(intent)).toEqual({ kind: "ambiguous" });
});

test("finalization refuses an incomplete draft before any mutation and account mismatch refuses composition", async () => {
  const methods: string[] = [];
  const adapter = await provider((url, method) => {
    methods.push(method);
    return url.pathname.endsWith("/lines") ? list([]) : invoice();
  });
  await rejects(
    adapter.finalizeInvoice(intent, "in_synthetic", {
      idempotencyKey: "synthetic",
    }),
    BillingProviderError,
  );
  expect(methods.every((method) => method === "GET")).toBe(true);
  await rejects(
    createStripeBillingProvider({
      apiKey: "sk_live_synthetic",
      deploymentKey: "synthetic",
    }),
    { reason: "ownership_mismatch" },
  );
  const fetcher = Object.assign(
    async () => new Response(JSON.stringify({ id: "acct_foreign" })),
    { preconnect: () => {} },
  );
  await rejects(
    createStripeBillingProvider({
      apiKey: "rk_test_synthetic",
      ...ownership,
      httpClient: Stripe.createFetchHttpClient(fetcher),
    }),
    { reason: "ownership_mismatch" },
  );
});

test("signature verification preserves raw bytes and rejects live/foreign events", async () => {
  const stripe = new Stripe("unused");
  const secret = "whsec_synthetic";
  const verifier = createStripeEventVerifier({
    signingSecret: secret,
    ownership,
  });
  const event = {
    id: "evt_synthetic",
    object: "event",
    type: "invoice.paid",
    livemode: false,
    created: Math.floor(Date.now() / 1000),
    data: { object: invoice("paid", 100) },
  };
  const payload = JSON.stringify(event);
  const signature = await stripe.webhooks.generateTestHeaderStringAsync({
    payload,
    secret,
  });
  expect(await verifier.verifyEvent(payload, signature)).toMatchObject({
    invoiceId: intent.invoiceId,
    providerInvoiceId: "in_synthetic",
  });
  await rejects(verifier.verifyEvent(`${payload} `, signature), {
    reason: "ownership_mismatch",
  });
  for (const other of [
    { ...event, livemode: true },
    { ...event, account: "acct_foreign" },
  ]) {
    const rawBody = JSON.stringify(other);
    await rejects(
      verifier.verifyEvent(
        rawBody,
        await stripe.webhooks.generateTestHeaderStringAsync({
          payload: rawBody,
          secret,
        }),
      ),
      { reason: "ownership_mismatch" },
    );
  }
});
