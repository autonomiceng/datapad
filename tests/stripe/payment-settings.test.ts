import { rejects } from "node:assert/strict";
import { expect, test } from "bun:test";
import Stripe from "stripe";
import { createStripeBillingProvider } from "../../src/stripe";
import { type PaymentSetupIntent } from "../../src/billing/provider";
import {
  createStripePaymentSettingsProvider,
  normalizeStripePaymentSetupEvent,
} from "../../src/stripe/payment-settings";

const ownership = { accountId: "acct_synthetic", deploymentKey: "synthetic" };
const intent: PaymentSetupIntent = {
  ...ownership,
  setupId: "00000000-0000-4000-8000-000000000002",
  customerId: "00000000-0000-4000-8000-000000000001",
  providerCustomerId: "cus_synthetic",
  currency: "USD",
  successUrl: "http://localhost:4404/payment-settings?returned=true",
  cancelUrl: "http://localhost:4404/payment-settings",
  integrationIdentifier: "datapad_setup_abcdefgh",
};
const metadata = {
  datapad_deployment: intent.deploymentKey,
  datapad_customer: intent.customerId,
  datapad_setup: intent.setupId,
};
const customer = {
  id: intent.providerCustomerId,
  object: "customer",
  livemode: false,
  metadata: {
    datapad_deployment: intent.deploymentKey,
    datapad_customer: intent.customerId,
  },
};
function session() {
  return {
    id: "cs_test_synthetic",
    object: "checkout.session",
    livemode: false,
    mode: "setup",
    customer: intent.providerCustomerId,
    metadata,
    currency: "usd",
    success_url: intent.successUrl,
    cancel_url: intent.cancelUrl,
    integration_identifier: intent.integrationIdentifier,
    allowed_payment_method_types: ["card"],
    status: "complete",
    url: null,
    setup_intent: "seti_synthetic",
    client_secret: "synthetic_secret_omit",
    customer_details: { email: "synthetic@billing.test" },
  };
}
function setupIntent() {
  return {
    id: "seti_synthetic",
    object: "setup_intent",
    livemode: false,
    customer: intent.providerCustomerId,
    metadata,
    status: "succeeded",
    usage: "off_session",
    payment_method: "pm_synthetic",
    client_secret: "synthetic_secret_omit",
  };
}
function paymentMethod() {
  return {
    id: "pm_synthetic",
    object: "payment_method",
    livemode: false,
    customer: intent.providerCustomerId,
    type: "card",
    card: {
      brand: "visa",
      last4: "4242",
      exp_month: 12,
      exp_year: 2035,
      fingerprint: "synthetic_omit",
    },
    billing_details: { email: "synthetic@billing.test" },
  };
}
function list(data: unknown[], hasMore = false) {
  return {
    object: "list",
    data,
    has_more: hasMore,
    url: "/v1/checkout/sessions",
  };
}
type Request = {
  url: URL;
  method: string;
  body: URLSearchParams;
  headers: Headers;
};
function fixture(route: (request: Request) => unknown) {
  const requests: Request[] = [];
  const fetcher = Object.assign(
    async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const request = {
        url: new URL(
          input instanceof globalThis.Request ? input.url : input.toString(),
        ),
        method: init?.method ?? "GET",
        body: new URLSearchParams(
          typeof init?.body === "string" ? init.body : undefined,
        ),
        headers: new Headers(init?.headers),
      };
      requests.push(request);
      const value = route(request);
      return value instanceof Response
        ? value
        : new Response(JSON.stringify(value), {
            headers: { "Content-Type": "application/json" },
          });
    },
    { preconnect: () => {} },
  );
  // Stand-in for the root's account-verified client. All SDK I/O stays in this fixture.
  const httpClient = Stripe.createFetchHttpClient(fetcher);
  const stripe = new Stripe("rk_test_synthetic", {
    apiVersion: "2026-09-30.endive",
    maxNetworkRetries: 0,
    httpClient,
  });
  return {
    adapter: createStripePaymentSettingsProvider({
      stripe,
      ownership,
      maxPages: 100,
    }),
    httpClient,
    requests,
  };
}
function resources(request: Request) {
  switch (request.url.pathname) {
    case "/v1/customers/cus_synthetic":
      return customer;
    case "/v1/checkout/sessions/cs_test_synthetic":
      return session();
    case "/v1/setup_intents/seti_synthetic":
      return setupIntent();
    case "/v1/payment_methods/pm_synthetic":
      return paymentMethod();
    default:
      throw new Error("Unexpected synthetic SDK request");
  }
}

test("setup creation uses persisted SDK parameters and independently retrieves an open Session with no SetupIntent", async () => {
  const { adapter, requests } = fixture((request) => {
    if (request.url.pathname === "/v1/checkout/sessions") {
      return { ...session(), status: "complete" };
    }
    if (request.url.pathname === "/v1/checkout/sessions/cs_test_synthetic")
      return {
        ...session(),
        status: "open",
        setup_intent: null,
        url: "https://checkout.stripe.com/c/pay/cs_test_synthetic#synthetic",
      };
    return resources(request);
  });
  expect(
    await adapter.createSetup(intent, {
      idempotencyKey: "synthetic_setup_key",
    }),
  ).toEqual({
    ...intent,
    livemode: false,
    providerSessionId: "cs_test_synthetic",
    status: "open",
    checkoutUrl:
      "https://checkout.stripe.com/c/pay/cs_test_synthetic#synthetic",
    setupIntent: null,
  });
  expect(
    requests.map((request) => [request.method, request.url.pathname]),
  ).toEqual([
    ["GET", "/v1/customers/cus_synthetic"],
    ["POST", "/v1/checkout/sessions"],
    ["GET", "/v1/checkout/sessions/cs_test_synthetic"],
  ]);
  const create = requests[1];
  expect(create.headers.get("Idempotency-Key")).toBe("synthetic_setup_key");
  expect(create.headers.get("Stripe-Version")).toBe("2026-09-30.endive");
  expect(Object.fromEntries(create.body)).toEqual({
    mode: "setup",
    currency: "usd",
    customer: intent.providerCustomerId,
    "allowed_payment_method_types[0]": "card",
    success_url: intent.successUrl,
    cancel_url: intent.cancelUrl,
    integration_identifier: intent.integrationIdentifier,
    "metadata[datapad_deployment]": intent.deploymentKey,
    "metadata[datapad_customer]": intent.customerId,
    "metadata[datapad_setup]": intent.setupId,
    "setup_intent_data[metadata][datapad_deployment]": intent.deploymentKey,
    "setup_intent_data[metadata][datapad_customer]": intent.customerId,
    "setup_intent_data[metadata][datapad_setup]": intent.setupId,
  });
});

test("completion follows independently retrieved receipt IDs and exposes only safe card observations", async () => {
  const { adapter, requests } = fixture(resources);
  const receipt = await adapter.retrieveSetup(intent, "cs_test_synthetic");
  expect(receipt).toEqual({
    ...intent,
    livemode: false,
    providerSessionId: "cs_test_synthetic",
    status: "complete",
    checkoutUrl: null,
    setupIntent: {
      providerSetupIntentId: "seti_synthetic",
      deploymentKey: ownership.deploymentKey,
      setupId: intent.setupId,
      providerCustomerId: intent.providerCustomerId,
      livemode: false,
      status: "succeeded",
      usage: "off_session",
      providerPaymentMethodId: "pm_synthetic",
    },
  });
  const methodId = receipt.setupIntent?.providerPaymentMethodId;
  if (!methodId) throw new Error("Missing synthetic method receipt");
  expect(await adapter.retrieveSavedMethod(intent, methodId)).toEqual({
    ...ownership,
    providerPaymentMethodId: "pm_synthetic",
    providerCustomerId: intent.providerCustomerId,
    livemode: false,
    type: "card",
    card: { brand: "visa", last4: "4242", expiryMonth: 12, expiryYear: 2035 },
  });
  expect(requests.filter((request) => request.method !== "GET")).toEqual([]);
  const observed = fixture((request) => {
    if (request.url.pathname.startsWith("/v1/setup_intents/"))
      return { ...setupIntent(), usage: "on_session", status: "processing" };
    if (request.url.pathname.startsWith("/v1/payment_methods/"))
      return {
        ...paymentMethod(),
        customer: null,
        card: { ...paymentMethod().card, exp_year: 2001 },
      };
    return resources(request);
  }).adapter;
  expect(
    (await observed.retrieveSetup(intent, "cs_test_synthetic")).setupIntent,
  ).toMatchObject({ usage: "on_session", status: "processing" });
  expect(
    await observed.retrieveSavedMethod(intent, "pm_synthetic"),
  ).toMatchObject({ providerCustomerId: null, card: { expiryYear: 2001 } });
  const unsupported = fixture((request) =>
    request.url.pathname.startsWith("/v1/payment_methods/")
      ? { ...paymentMethod(), type: "us_bank_account" }
      : resources(request),
  ).adapter;
  expect(
    await unsupported.retrieveSavedMethod(intent, "pm_synthetic"),
  ).toMatchObject({ type: "unsupported", card: null });
});

test("foreign ownership, altered persisted Session intent and mismatched resource associations fail closed", async () => {
  const changedCustomer = fixture((request) =>
    request.url.pathname.startsWith("/v1/customers/")
      ? {
          ...customer,
          metadata: { ...customer.metadata, datapad_deployment: "foreign" },
        }
      : resources(request),
  );
  await rejects(
    changedCustomer.adapter.createSetup(intent, {
      idempotencyKey: "synthetic",
    }),
    { kind: "review", reason: "ownership_mismatch" },
  );
  expect(changedCustomer.requests).toHaveLength(1);
  const valid = fixture(resources);
  await rejects(
    valid.adapter.retrieveSetup(
      { ...intent, accountId: "acct_foreign" },
      "cs_test_synthetic",
    ),
    { reason: "ownership_mismatch" },
  );
  expect(valid.requests).toHaveLength(0);
  for (const altered of [
    { customer: "cus_foreign" },
    { livemode: true },
    { currency: "eur" },
    {
      metadata: {
        ...metadata,
        datapad_setup: "00000000-0000-4000-8000-000000000009",
      },
    },
    { success_url: "https://example.test/changed" },
    { cancel_url: "https://example.test/changed" },
    { integration_identifier: "datapad_setup_ijklmnop" },
    { allowed_payment_method_types: ["card", "us_bank_account"] },
  ]) {
    const { adapter } = fixture((request) =>
      request.url.pathname.startsWith("/v1/checkout/sessions/")
        ? { ...session(), ...altered }
        : resources(request),
    );
    await rejects(adapter.retrieveSetup(intent, "cs_test_synthetic"), {
      kind: "review",
      reason: "ownership_mismatch",
    });
  }
  const differentIntent = fixture((request) =>
    request.url.pathname.startsWith("/v1/setup_intents/")
      ? { ...setupIntent(), id: "seti_foreign" }
      : resources(request),
  ).adapter;
  await rejects(differentIntent.retrieveSetup(intent, "cs_test_synthetic"), {
    reason: "ownership_mismatch",
  });
  const differentMetadata = fixture((request) =>
    request.url.pathname.startsWith("/v1/setup_intents/")
      ? {
          ...setupIntent(),
          metadata: { ...metadata, datapad_customer: "foreign" },
        }
      : resources(request),
  ).adapter;
  await rejects(differentMetadata.retrieveSetup(intent, "cs_test_synthetic"), {
    reason: "ownership_mismatch",
  });
  const connectedAccount = fixture((request) =>
    request.url.pathname.startsWith("/v1/setup_intents/")
      ? { ...setupIntent(), on_behalf_of: "acct_foreign" }
      : resources(request),
  ).adapter;
  await rejects(connectedAccount.retrieveSetup(intent, "cs_test_synthetic"), {
    reason: "ownership_mismatch",
  });
  const expanded = fixture((request) =>
    request.url.pathname.startsWith("/v1/checkout/sessions/")
      ? {
          ...session(),
          setup_intent: { ...setupIntent(), payment_method: "pm_foreign" },
        }
      : resources(request),
  ).adapter;
  await rejects(expanded.retrieveSetup(intent, "cs_test_synthetic"), {
    reason: "ownership_mismatch",
  });
  for (const altered of [
    { id: "pm_foreign" },
    { customer: "cus_foreign" },
    { livemode: true },
  ]) {
    const { adapter } = fixture((request) =>
      request.url.pathname.startsWith("/v1/payment_methods/")
        ? { ...paymentMethod(), ...altered }
        : resources(request),
    );
    await rejects(adapter.retrieveSavedMethod(intent, "pm_synthetic"), {
      reason: "ownership_mismatch",
    });
  }
});

test("missing completion evidence and unsafe hosted URLs return safe review errors", async () => {
  const missing = fixture((request) =>
    request.url.pathname.startsWith("/v1/checkout/sessions/")
      ? { ...session(), setup_intent: null }
      : resources(request),
  ).adapter;
  await rejects(missing.retrieveSetup(intent, "cs_test_synthetic"), {
    kind: "review",
    reason: "provider_conflict",
  });
  for (const url of [
    "http://checkout.stripe.com/pay/synthetic",
    "https://checkout.stripe.com.example.test/pay/synthetic",
    "https://synthetic:secret@checkout.stripe.com/pay/synthetic",
    "https://checkout.stripe.com:8443/pay/synthetic",
    "https://checkout.stripe.com/pay/synthetic?client_secret=seti_synthetic_secret_omit",
    "https://checkout.stripe.com/pay/synthetic?client_secret=synthetic",
    "invalid synthetic URL",
  ]) {
    const { adapter } = fixture((request) =>
      request.url.pathname.startsWith("/v1/checkout/sessions/")
        ? { ...session(), status: "open", setup_intent: null, url }
        : resources(request),
    );
    await rejects(adapter.retrieveSetup(intent, "cs_test_synthetic"), {
      kind: "review",
      reason: "provider_conflict",
    });
  }
});

test("lost-response recovery fully paginates customer-scoped Sessions and rejects ambiguous or incomplete inspection", async () => {
  const { adapter, requests } = fixture((request) => {
    if (request.url.pathname === "/v1/checkout/sessions")
      return request.url.searchParams.has("starting_after")
        ? list([session()])
        : list([{ ...session(), id: "cs_test_unrelated", metadata: {} }], true);
    return resources(request);
  });
  const result = await adapter.findSetup(intent);
  expect(result.kind).toBe("found");
  if (result.kind === "found")
    expect(result.value.setupIntent?.providerPaymentMethodId).toBe(
      "pm_synthetic",
    );
  const lists = requests.filter(
    (request) => request.url.pathname === "/v1/checkout/sessions",
  );
  expect(
    lists.map((request) => Object.fromEntries(request.url.searchParams)),
  ).toEqual([
    { customer: intent.providerCustomerId, limit: "100" },
    {
      customer: intent.providerCustomerId,
      limit: "100",
      starting_after: "cs_test_unrelated",
    },
  ]);
  const duplicate = fixture((request) =>
    request.url.pathname === "/v1/checkout/sessions"
      ? request.url.searchParams.has("starting_after")
        ? list([{ ...session(), id: "cs_test_duplicate" }])
        : list([session()], true)
      : resources(request),
  ).adapter;
  expect(await duplicate.findSetup(intent)).toEqual({ kind: "ambiguous" });
  const incomplete = fixture((request) =>
    request.url.pathname === "/v1/checkout/sessions"
      ? list([], true)
      : resources(request),
  ).adapter;
  expect(await incomplete.findSetup(intent)).toEqual({ kind: "ambiguous" });
  const repeated = fixture((request) =>
    request.url.pathname === "/v1/checkout/sessions"
      ? list([session()], true)
      : resources(request),
  ).adapter;
  expect(await repeated.findSetup(intent)).toEqual({ kind: "ambiguous" });
  let pageIndex = 0;
  const exhaustedFixture = fixture((request) =>
    request.url.pathname === "/v1/account"
      ? { id: ownership.accountId }
      : request.url.pathname === "/v1/checkout/sessions"
        ? list(
            [{ ...session(), id: `cs_test_page${pageIndex++}`, metadata: {} }],
            true,
          )
        : resources(request),
  );
  const exhausted = await createStripeBillingProvider({
    apiKey: "rk_test_synthetic",
    deploymentKey: ownership.deploymentKey,
    accountId: ownership.accountId,
    maxPages: 1,
    httpClient: exhaustedFixture.httpClient,
  });
  expect(await exhausted.findSetup(intent)).toEqual({ kind: "ambiguous" });
  expect(pageIndex).toBe(1);
  const absent = fixture((request) =>
    request.url.pathname === "/v1/checkout/sessions"
      ? list([])
      : resources(request),
  ).adapter;
  expect(await absent.findSetup(intent)).toEqual({ kind: "absent" });
  const changed = fixture((request) =>
    request.url.pathname === "/v1/checkout/sessions"
      ? list([session()])
      : request.url.pathname.startsWith("/v1/checkout/sessions/")
        ? { ...session(), integration_identifier: "datapad_setup_ijklmnop" }
        : resources(request),
  ).adapter;
  await rejects(changed.findSetup(intent), { reason: "ownership_mismatch" });
  const changedCustomer = fixture((request) =>
    request.url.pathname === "/v1/checkout/sessions"
      ? list([
          {
            ...session(),
            metadata: { ...metadata, datapad_customer: "foreign" },
          },
        ])
      : request.url.pathname.startsWith("/v1/checkout/sessions/")
        ? {
            ...session(),
            metadata: { ...metadata, datapad_customer: "foreign" },
          }
        : resources(request),
  ).adapter;
  await rejects(changedCustomer.findSetup(intent), {
    reason: "ownership_mismatch",
  });
});

test("SDK errors expose classification without raw provider details", async () => {
  for (const [status, kind] of [
    [429, "retryable"],
    [400, "review"],
  ]) {
    const { adapter } = fixture(
      () =>
        new Response(
          JSON.stringify({
            error: {
              type: "invalid_request_error",
              message: "synthetic_secret_omit",
            },
          }),
          {
            status: Number(status),
            headers: { "Content-Type": "application/json" },
          },
        ),
    );
    await rejects(adapter.retrieveSetup(intent, "cs_test_synthetic"), {
      kind,
      message: "provider_conflict",
    });
  }
});

test("setup event normalization consumes signature-verified SDK events and never treats the event as completion proof", async () => {
  const stripe = new Stripe("unused");
  const secret = "whsec_synthetic";
  const event = {
    id: "evt_synthetic",
    object: "event",
    type: "checkout.session.completed",
    livemode: false,
    created: Math.floor(Date.now() / 1000),
    data: { object: session() },
  };
  async function verified(value: unknown) {
    const raw = JSON.stringify(value);
    const signature = await stripe.webhooks.generateTestHeaderStringAsync({
      payload: raw,
      secret,
    });
    return stripe.webhooks.constructEventAsync(
      raw,
      signature,
      secret,
      undefined,
      Stripe.createSubtleCryptoProvider(),
    );
  }
  expect(
    normalizeStripePaymentSetupEvent(await verified(event), ownership),
  ).toEqual({
    ...ownership,
    eventId: "evt_synthetic",
    providerSessionId: "cs_test_synthetic",
    setupId: intent.setupId,
  });
  expect(
    normalizeStripePaymentSetupEvent(
      await verified({
        ...event,
        data: {
          object: {
            ...session(),
            metadata: { ...metadata, datapad_deployment: "foreign" },
          },
        },
      }),
      ownership,
    )?.setupId,
  ).toBeNull();
  expect(
    normalizeStripePaymentSetupEvent(
      await verified({
        ...event,
        data: { object: { ...session(), mode: "payment" } },
      }),
      ownership,
    ),
  ).toBeNull();
  expect(
    normalizeStripePaymentSetupEvent(
      await verified({ ...event, type: "customer.created" }),
      ownership,
    ),
  ).toBeNull();
  const verifiedEvent = await verified(event);
  for (const altered of [
    { livemode: true },
    { account: "acct_foreign" },
    { context: "foreign" },
  ])
    expect(() =>
      normalizeStripePaymentSetupEvent(
        { ...verifiedEvent, ...altered },
        ownership,
      ),
    ).toThrow("ownership_mismatch");
  const raw = JSON.stringify(event);
  const signature = await stripe.webhooks.generateTestHeaderStringAsync({
    payload: raw,
    secret,
  });
  await rejects(
    stripe.webhooks.constructEventAsync(
      `${raw} `,
      signature,
      secret,
      undefined,
      Stripe.createSubtleCryptoProvider(),
    ),
  );
});
