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
  route: (
    url: URL,
    method: string,
    body: string | undefined,
    key: string | null,
  ) => unknown,
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
              new Headers(init?.headers).get("Idempotency-Key"),
            );
      if (value instanceof Response) return value;
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
  const actionPayload = JSON.stringify({
    ...event,
    type: "invoice.payment_action_required",
  });
  expect(
    await verifier.verifyEvent(
      actionPayload,
      await stripe.webhooks.generateTestHeaderStringAsync({
        payload: actionPayload,
        secret,
      }),
    ),
  ).toMatchObject({
    eventType: "invoice.payment_action_required",
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

function collectionInvoice(status = "open", paid = 0, offStripe = 0) {
  return {
    ...invoice(status, 100),
    amount_due: 100,
    amount_remaining: status === "void" ? 0 : 100 - paid,
    amount_paid: paid,
    amount_paid_off_stripe: offStripe,
    amount_overpaid: 0,
  };
}
const invoicePayment = {
  id: "inpay_synthetic",
  object: "invoice_payment",
  invoice: "in_synthetic",
  currency: "usd",
  livemode: false,
  amount_requested: 100,
  amount_paid: null,
  status: "open",
  payment: { type: "payment_intent", payment_intent: "pi_synthetic" },
};
const paymentIntent = {
  id: "pi_synthetic",
  object: "payment_intent",
  customer: intent.providerCustomerId,
  currency: "usd",
  livemode: false,
  status: "requires_payment_method",
  amount: 100,
  amount_received: 0,
  amount_capturable: 0,
};

test("collection inspection paginates allocations, independently retrieves intents and rereads expanded amounts", async () => {
  const cursors: (string | null)[] = [];
  const intentIds: string[] = [];
  let invoiceReads = 0;
  const adapter = await provider((url) => {
    if (url.pathname.endsWith("/lines")) return list([line]);
    if (url.pathname === "/v1/invoice_payments") {
      expect(url.searchParams.get("invoice")).toBe("in_synthetic");
      cursors.push(url.searchParams.get("starting_after"));
      return url.searchParams.has("starting_after")
        ? list([
            {
              ...invoicePayment,
              id: "inpay_paid",
              status: "paid",
              amount_paid: 30,
              amount_requested: 30,
              payment: {
                type: "payment_intent",
                payment_intent: {
                  id: "pi_paid",
                  status: "processing",
                  payment_method: "pm_untrusted",
                },
              },
            },
          ])
        : list([{ ...invoicePayment, amount_requested: 70 }], true);
    }
    if (url.pathname.startsWith("/v1/payment_intents/")) {
      intentIds.push(url.pathname);
      return url.pathname.endsWith("pi_paid")
        ? {
            ...paymentIntent,
            id: "pi_paid",
            status: "succeeded",
            amount: 30,
            amount_received: 30,
            payment_method: { id: "pm_paid" },
          }
        : { ...paymentIntent, amount: 70 };
    }
    invoiceReads++;
    expect(url.searchParams.get("expand[0]")).toBe("amount_paid_off_stripe");
    return collectionInvoice("open", 30);
  });
  const inspection = await adapter.inspectCollection(intent, "in_synthetic");
  expect(inspection).toMatchObject({
    remainingMinor: 70,
    paidMinor: 30,
    paidOffStripeMinor: 0,
    overpaidMinor: 0,
    collectionState: "idle",
  });
  expect(inspection.payments).toHaveLength(2);
  expect(inspection.payments[0].providerPaymentMethodId).toBeNull();
  expect(inspection.payments[1]).toMatchObject({
    invoicePaymentId: "inpay_paid",
    paymentIntentId: "pi_paid",
    providerPaymentMethodId: "pm_paid",
    paidMinor: 30,
    intentState: "succeeded",
  });
  expect(cursors).toEqual([null, "inpay_synthetic"]);
  expect(intentIds).toEqual([
    "/v1/payment_intents/pi_synthetic",
    "/v1/payment_intents/pi_paid",
  ]);
  expect(invoiceReads).toBe(2);
  const settled = await provider((url) => {
    if (url.pathname.endsWith("/lines")) return list([line]);
    if (url.pathname === "/v1/invoice_payments")
      return list([
        {
          ...invoicePayment,
          id: "inpay_external",
          status: "paid",
          amount_paid: 100,
          payment: {
            type: "payment_record",
            payment_record: "pr_test_synthetic",
          },
        },
        { ...invoicePayment, status: "canceled" },
      ]);
    if (url.pathname === "/v1/payment_records/pr_test_synthetic")
      return {
        id: "pr_test_synthetic",
        object: "payment_record",
        livemode: false,
        customer_details: { customer: intent.providerCustomerId },
        reported_by: "self",
        payment_method_details: {
          type: "custom",
          custom: { display_name: "Paid out of band", type: null },
        },
        processor_details: {
          type: "custom",
          custom: { payment_reference: "Out of band payment for in_synthetic" },
        },
        amount: { currency: "usd", value: 100 },
        amount_requested: { currency: "usd", value: 100 },
        amount_authorized: { currency: "usd", value: 100 },
        amount_guaranteed: { currency: "usd", value: 100 },
        amount_canceled: { currency: "usd", value: 0 },
        amount_failed: { currency: "usd", value: 0 },
        amount_refunded: { currency: "usd", value: 0 },
      };
    if (url.pathname.startsWith("/v1/payment_intents/"))
      return { ...paymentIntent, status: "canceled" };
    return collectionInvoice("paid", 100, 100);
  });
  expect(await settled.inspectCollection(intent, "in_synthetic")).toMatchObject(
    {
      remainingMinor: 0,
      paidMinor: 100,
      paidOffStripeMinor: 100,
      overpaidMinor: 0,
      collectionState: "idle",
      payments: [
        {
          invoicePaymentId: "inpay_synthetic",
          paymentIntentId: "pi_synthetic",
          providerPaymentMethodId: null,
          status: "canceled",
          receivedMinor: 0,
          capturableMinor: 0,
        },
      ],
    },
  );
});

test("collection never treats active, unallocated, foreign or incomplete evidence as idle", async () => {
  async function inspect(
    payment: unknown,
    pi: unknown,
    current: unknown = collectionInvoice(),
    hasMore = false,
    maxPages = 100,
  ) {
    const adapter = await provider((url) => {
      if (url.pathname.endsWith("/lines")) return list([line]);
      if (url.pathname === "/v1/invoice_payments")
        return list([payment], hasMore);
      if (url.pathname.startsWith("/v1/payment_intents/")) return pi;
      return current;
    }, maxPages);
    return adapter.inspectCollection(intent, "in_synthetic");
  }
  expect(
    await inspect(invoicePayment, {
      ...paymentIntent,
      status: "processing",
      payment_method: null,
    }),
  ).toMatchObject({
    collectionState: "active",
    payments: [{ providerPaymentMethodId: null }],
  });
  expect(
    await inspect(invoicePayment, {
      ...paymentIntent,
      payment_method: "pm_synthetic",
    }),
  ).toMatchObject({
    collectionState: "idle",
    payments: [{ providerPaymentMethodId: "pm_synthetic" }],
  });
  expect(
    await inspect(invoicePayment, {
      ...paymentIntent,
      status: "succeeded",
      amount_received: 100,
    }),
  ).toMatchObject({ collectionState: "unknown" });
  await rejects(
    inspect({ ...invoicePayment, invoice: "in_foreign" }, paymentIntent),
    { kind: "review", reason: "ownership_mismatch" },
  );
  await rejects(
    inspect(invoicePayment, {
      ...paymentIntent,
      customer: "cus_foreign",
      payment_method: "pm_synthetic",
    }),
    { kind: "review", reason: "ownership_mismatch" },
  );
  await rejects(
    inspect(
      { ...invoicePayment, payment: { type: "payment_record" } },
      paymentIntent,
    ),
    { kind: "review", reason: "provider_conflict" },
  );
  await rejects(
    inspect(invoicePayment, paymentIntent, {
      ...collectionInvoice(),
      amount_paid_off_stripe: undefined,
    }),
    { kind: "review", reason: "provider_conflict" },
  );
  await rejects(
    inspect(invoicePayment, paymentIntent, collectionInvoice(), true, 1),
    { kind: "review", reason: "provider_conflict" },
  );
  const incompletePagination = await provider((url) => {
    if (url.pathname.endsWith("/lines")) return list([line]);
    if (url.pathname === "/v1/invoice_payments")
      return { object: "list", data: [] };
    return collectionInvoice();
  });
  await rejects(
    incompletePagination.inspectCollection(intent, "in_synthetic"),
    { kind: "review", reason: "provider_conflict" },
  );
  let reads = 0;
  const racing = await provider((url) => {
    if (url.pathname.endsWith("/lines")) return list([line]);
    if (url.pathname === "/v1/invoice_payments") return list([invoicePayment]);
    if (url.pathname.startsWith("/v1/payment_intents/")) return paymentIntent;
    return ++reads === 1
      ? collectionInvoice()
      : collectionInvoice("paid", 100, 100);
  });
  await rejects(racing.inspectCollection(intent, "in_synthetic"), {
    kind: "review",
    reason: "provider_conflict",
  });
});

test("scheduled pay replays only the frozen invoice, method, off-session flag and key", async () => {
  const requests: {
    method: string;
    path: string;
    body: string | undefined;
    key: string | null;
  }[] = [];
  let loseResponse = true;
  const adapter = await provider((url, method, body, key) => {
    requests.push({ method, path: url.pathname, body, key });
    if (url.pathname.endsWith("/lines"))
      throw new Error("Synthetic read outage after successful pay response");
    expect(url.pathname).toBe("/v1/invoices/in_synthetic/pay");
    if (loseResponse) {
      loseResponse = false;
      throw new Error("Synthetic lost response");
    }
    return {
      ...collectionInvoice("paid", 100),
      payments: list([
        {
          ...invoicePayment,
          is_default: true,
          status: "paid",
          amount_paid: 100,
          payment: {
            type: "payment_intent",
            payment_intent: {
              ...paymentIntent,
              status: "succeeded",
              amount_received: 100,
              payment_method: "pm_synthetic",
            },
          },
        },
      ]),
    };
  });
  const request = {
    providerInvoiceId: "in_synthetic",
    providerPaymentMethodId: "pm_synthetic",
    offSession: true,
  } satisfies Parameters<typeof adapter.payInvoice>[1];
  const effect = { idempotencyKey: "datapad:synthetic:payment:synthetic:pay" };
  await rejects(adapter.payInvoice(intent, request, effect), {
    kind: "retryable",
  });
  expect(requests).toHaveLength(1);
  expect(await adapter.payInvoice(intent, request, effect)).toMatchObject({
    kind: "response",
    receipt: {
      status: "paid",
      providerInvoiceId: "in_synthetic",
      payment: {
        invoicePaymentId: "inpay_synthetic",
        paymentIntentId: "pi_synthetic",
        providerPaymentMethodId: "pm_synthetic",
      },
    },
  });
  expect(requests).toHaveLength(2); // The successful POST returns before the failing line read can run.
  const pays = requests.filter((entry) => entry.method === "POST");
  expect(pays).toHaveLength(2);
  expect(pays[0]).toEqual(pays[1]);
  expect(pays[0]).toMatchObject({
    method: "POST",
    path: "/v1/invoices/in_synthetic/pay",
    key: effect.idempotencyKey,
  });
  expect([...new URLSearchParams(pays[0].body).entries()]).toEqual([
    ["payment_method", "pm_synthetic"],
    ["off_session", "true"],
    ["expand[0]", "payments.data.payment.payment_intent"],
  ]);
  await rejects(
    adapter.payInvoice(
      { ...intent, accountId: "acct_foreign" },
      request,
      effect,
    ),
    { kind: "review", reason: "ownership_mismatch" },
  );
  expect(requests.filter((entry) => entry.method === "POST")).toHaveLength(2);
  const foreign = await provider((url) =>
    url.pathname.endsWith("/lines")
      ? list([line])
      : { ...collectionInvoice("paid", 100), customer: "cus_foreign" },
  );
  await rejects(foreign.payInvoice(intent, request, effect), {
    kind: "review",
    receiptMismatch: true,
  });
});

test("scheduled pay classifies definitive card outcomes before safe errors and exposes only correlation hints", async () => {
  const cases = [
    { type: "card_error", code: "card_declined", kind: "declined" },
    { type: "card_error", code: "processing_error", kind: "declined" },
    {
      type: "card_error",
      code: "authentication_required",
      kind: "requires_action",
    },
    {
      type: "card_error",
      code: "invoice_payment_intent_requires_action",
      kind: "requires_action",
    },
    {
      type: "card_error",
      code: "payment_intent_action_required",
      kind: "requires_action",
    },
    {
      type: "card_error",
      code: "card_declined",
      decline_code: "authentication_required",
      kind: "requires_action",
    },
    {
      type: "card_error",
      code: "card_declined",
      payment_intent: {
        ...paymentIntent,
        customer: "cus_foreign",
        status: "requires_action",
      },
      kind: "requires_action",
    },
    {
      type: "invalid_request_error",
      status: 402,
      payment_intent: { ...paymentIntent, status: "requires_action" },
      kind: "review",
    },
    { type: "invalid_request_error", status: 400, kind: "review" },
    { type: "invalid_request_error", status: 422, kind: "review" },
    { type: "api_error", status: 500, kind: "retryable" },
  ] satisfies Array<{
    type: string;
    code?: string;
    decline_code?: string;
    status?: number;
    payment_intent?: typeof paymentIntent;
    kind: "declined" | "requires_action" | "review" | "retryable";
  }>;
  for (const scenario of cases) {
    let calls = 0;
    const adapter = await provider((url) => {
      calls++;
      expect(url.pathname).toBe("/v1/invoices/in_synthetic/pay");
      return new Response(
        JSON.stringify({
          error: {
            message: "Synthetic provider detail must stay private",
            type: scenario.type,
            code: scenario.code,
            decline_code: scenario.decline_code,
            payment_intent: scenario.payment_intent,
          },
        }),
        {
          status: scenario.status ?? 402,
          headers: { "Content-Type": "application/json" },
        },
      );
    });
    const outcome = adapter.payInvoice(
      intent,
      {
        providerInvoiceId: "in_synthetic",
        providerPaymentMethodId: "pm_synthetic",
        offSession: true,
      },
      { idempotencyKey: "synthetic_collection_pay" },
    );
    if (scenario.type === "card_error") {
      if (scenario.kind !== "declined" && scenario.kind !== "requires_action")
        throw new Error("Invalid synthetic card outcome");
      expect(await outcome).toEqual({
        kind: scenario.kind,
        paymentIntentId: scenario.payment_intent?.id ?? null,
      });
    } else {
      await rejects(outcome, (error: unknown) => {
        expect(error).toBeInstanceOf(BillingProviderError);
        expect(error).toMatchObject({
          kind: scenario.kind,
          reason: "provider_conflict",
        });
        expect(String(error)).not.toContain("Synthetic provider detail");
        return true;
      });
    }
    expect(calls).toBe(1);
  }
});

test("external pay replays immutable expanded parameters and void verifies the owned invoice before mutation", async () => {
  const requests: {
    method: string;
    path: string;
    body: string | undefined;
    key: string | null;
  }[] = [];
  let loseResponse = true;
  const adapter = await provider((url, method, body, key) => {
    requests.push({ method, path: url.pathname, body, key });
    if (url.pathname.endsWith("/lines")) return list([line]);
    if (url.pathname.endsWith("/pay")) {
      if (loseResponse) {
        loseResponse = false;
        throw new Error("Synthetic lost response");
      }
      return collectionInvoice("paid", 100, 100);
    }
    if (url.pathname.endsWith("/void")) return collectionInvoice("void");
    return collectionInvoice();
  });
  const effect = {
    idempotencyKey: "datapad:synthetic:resolution:synthetic:settle",
  };
  await rejects(adapter.settleExternally(intent, "in_synthetic", effect), {
    kind: "retryable",
  });
  expect(
    await adapter.settleExternally(intent, "in_synthetic", effect),
  ).toMatchObject({
    invoice: { status: "paid", providerInvoiceId: "in_synthetic" },
    paidOffStripeMinor: 100,
  });
  const pays = requests.filter((request) => request.path.endsWith("/pay"));
  expect(pays).toHaveLength(2);
  expect(pays[0]).toEqual(pays[1]);
  expect(pays[0].method).toBe("POST");
  expect(pays[0].key).toBe(effect.idempotencyKey);
  const params = new URLSearchParams(pays[0].body);
  expect([...params.entries()]).toEqual([
    ["paid_out_of_band", "true"],
    ["expand[0]", "amount_paid_off_stripe"],
  ]);
  expect(
    await adapter.voidInvoice(intent, "in_synthetic", {
      idempotencyKey: "synthetic_void",
    }),
  ).toMatchObject({ status: "void", providerInvoiceId: "in_synthetic" });
  expect(
    requests.find((request) => request.path.endsWith("/void")),
  ).toMatchObject({ method: "POST", key: "synthetic_void" });
  let mutations = 0;
  const foreign = await provider((url, method) => {
    if (method === "POST") mutations++;
    return url.pathname.endsWith("/lines")
      ? list([line])
      : { ...collectionInvoice(), customer: "cus_foreign" };
  });
  await rejects(foreign.voidInvoice(intent, "in_synthetic", effect), {
    kind: "review",
    receiptMismatch: true,
  });
  expect(mutations).toBe(0);
  const missingExpansion = await provider((url) =>
    url.pathname.endsWith("/lines")
      ? list([line])
      : {
          ...collectionInvoice("paid", 100, 100),
          amount_paid_off_stripe: undefined,
        },
  );
  await rejects(
    missingExpansion.settleExternally(intent, "in_synthetic", effect),
    { kind: "review", reason: "provider_conflict" },
  );
});
