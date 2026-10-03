import { expect, test } from "bun:test";
import { Elysia } from "elysia";
import type { HumanActor } from "../../src/access/types";
import {
  SAVE_TERMS_VERSION,
  SAVE_TERMS_TEXT,
  ENROLLMENT_TERMS_VERSION,
  ENROLLMENT_TERMS_TEXT,
  type PaymentSettingsResponse,
  type ReduceEnrollmentRequest,
  type ReplaceEnrollmentRequest,
} from "../../src/billing/payment-settings-contract";
import {
  paymentSettingsRoutes,
  type PaymentSettingsHttp,
} from "../../src/server/payment-settings-routes";

const origin = "http://localhost";
const customerId = "00000000-0000-4000-8000-000000000001";
const setupId = "00000000-0000-4000-8000-000000000002";
const requestId = "00000000-0000-4000-8000-000000000003";
const subscriptionId = "00000000-0000-4000-8000-000000000004";
const futureSubscriptionId = "00000000-0000-4000-8000-000000000005";
const enrollmentId = "00000000-0000-4000-8000-000000000006";
const methodId = "00000000-0000-4000-8000-000000000007";
const path = `/api/customers/${customerId}`;
const read = (route: string) => new Request(`${origin}${route}`);
const mutation = (
  route: string,
  body: unknown,
  headers: Record<string, string> = { origin },
) =>
  new Request(`${origin}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
async function error(response: Response, code: string, status: number) {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ code });
}

test("payment settings transport scopes local setup refresh, rejects browser proof and forwards an explicit local stop under the current session", async () => {
  let actor: HumanActor | null = {
    userId: "sample-user",
    sessionId: "sample-session",
  };
  let observed: HumanActor | undefined;
  let setupCalls = 0;
  let stop: ReduceEnrollmentRequest | undefined;
  let replacement: ReplaceEnrollmentRequest | undefined;
  const calendar = { timeZone: "UTC", issueHour: 9, chargeHour: 9 };
  const scope = {
    subscriptionId,
    commercialRevision: 1,
    fromPeriodIndex: 0,
    untilPeriodIndex: 42,
    periodStart: "2026-09-02",
    dueDate: "2026-09-22",
    calendar,
  };
  const settings: PaymentSettingsResponse = {
    canManage: false,
    setupAvailable: false,
    saveTerms: { version: SAVE_TERMS_VERSION, text: SAVE_TERMS_TEXT },
    enrollmentTerms: {
      version: ENROLLMENT_TERMS_VERSION,
      text: ENROLLMENT_TERMS_TEXT,
    },
    methods: [
      {
        id: methodId,
        brand: "visa",
        last4: "4242",
        expiryMonth: 11,
        expiryYear: 2029,
        verifiedAt: "2026-10-03T12:00:00Z",
        usable: true,
      },
    ],
    enrollment: {
      id: enrollmentId,
      version: 1,
      predecessorId: null,
      decision: "authorize",
      paymentMethodId: methodId,
      acceptedAt: "2026-10-03T12:00:00Z",
      termsVersion: ENROLLMENT_TERMS_VERSION,
      scopes: [scope],
    },
    consentAdministratorOrigin: null,
    subscriptions: [
      {
        id: subscriptionId,
        label: "Sample hosting with updated terms",
        version: 3,
        calendar,
        intervalMonths: 1,
        retainedScope: {
          ...scope,
          label: "Original sample hosting",
          amountMinor: 1200,
          currency: "USD",
          intervalMonths: 1,
          untilPeriodStart: "2030-03-02",
        },
        boundaries: [],
        blocker: "no_future_boundary",
      },
      {
        id: futureSubscriptionId,
        label: "Sample future agreement",
        version: 1,
        calendar,
        intervalMonths: 1,
        retainedScope: null,
        boundaries: [
          {
            fromPeriodIndex: 1,
            periodStart: "2026-11-02",
            dueDate: "2026-11-22",
            commercialRevision: 1,
            untilPeriodIndex: null,
            untilPeriodStart: null,
            label: "Sample future agreement",
            amountMinor: 1800,
            paymentArrangement: "manual",
          },
        ],
        blocker: null,
      },
    ],
    affectedInvoices: [],
  };
  const config: PaymentSettingsHttp = {
    origin,
    access: { resolveActor: async () => actor },
    paymentSettings: {
      getPaymentSettings: async (current, id) => {
        observed = current;
        expect(id).toBe(customerId);
        return { ok: true, value: settings };
      },
      startSetup: async () => {
        setupCalls++;
        return { ok: false, code: "forbidden" };
      },
      refreshSetup: async (current, id, localId) => {
        observed = current;
        expect(id).toBe(customerId);
        return localId === setupId
          ? {
              ok: true,
              value: {
                setupId,
                status: "pending",
                paymentMethodId: null,
                checkoutUrl: null,
              },
            }
          : { ok: false, code: "not_found" };
      },
      replaceEnrollment: async (current, id, input) => {
        observed = current;
        expect(id).toBe(customerId);
        replacement = input;
        return { ok: false, code: "conflict" };
      },
      reduceEnrollment: async (current, id, input) => {
        observed = current;
        expect(id).toBe(customerId);
        stop = input;
        return {
          ok: true,
          value: {
            outcome: "changed",
            enrollment: {
              id: requestId,
              version: 2,
              predecessorId: enrollmentId,
              decision: "reduce",
              paymentMethodId: null,
              acceptedAt: "2026-10-03T12:00:00Z",
              termsVersion: ENROLLMENT_TERMS_VERSION,
              scopes: [],
            },
          },
        };
      },
    },
  };
  const app = new Elysia({ normalize: false })
    .use(paymentSettingsRoutes(config))
    .post("/unrelated", () => ({ accepted: true }));
  const response = await app.handle(read(`${path}/payment-settings`));
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual(settings);
  expect(observed).toEqual(actor);
  const save = {
    requestId,
    saveTermsVersion: SAVE_TERMS_VERSION,
    acceptSaveTerms: true,
  };
  await error(
    await app.handle(mutation(`${path}/payment-setups`, save, {})),
    "forbidden",
    403,
  );
  await error(
    await app.handle(
      mutation(`${path}/payment-setups`, save, {
        origin: "https://foreign.test",
      }),
    ),
    "forbidden",
    403,
  );
  await error(
    await app.handle(
      mutation(`${path}/payment-setups`, save, {
        origin,
        "content-type": "text/plain",
      }),
    ),
    "invalid_request",
    422,
  );
  await error(
    await app.handle(
      mutation(`${path}/payment-setups`, { ...save, acceptSaveTerms: false }),
    ),
    "invalid_request",
    422,
  );
  expect(setupCalls).toBe(0);
  await error(
    await app.handle(mutation(`${path}/payment-setups`, save)),
    "forbidden",
    403,
  );
  expect(setupCalls).toBe(1);
  const refresh = `${path}/payment-setups/${setupId}/refresh`;
  await error(
    await app.handle(
      mutation(refresh, { success: true, paymentMethodId: requestId }),
    ),
    "invalid_request",
    422,
  );
  await error(
    await app.handle(mutation(`${refresh}?success=true`, {})),
    "invalid_request",
    422,
  );
  await error(
    await app.handle(
      mutation(`${path}/payment-setups/${requestId}/refresh`, {}),
    ),
    "not_found",
    404,
  );
  actor = { userId: "sample-customer-admin", sessionId: "current-session" };
  const refreshed = await app.handle(mutation(refresh, {}));
  expect(refreshed.status).toBe(200);
  expect((await refreshed.json()).status).toBe("pending");
  expect(observed).toEqual(actor);
  const input: ReduceEnrollmentRequest = {
    requestId,
    expectedVersion: 1,
    retainSubscriptionIds: [],
  };
  expect(
    (
      await app.handle(
        mutation(`${path}/automatic-payment-enrollment/reduce`, input),
      )
    ).status,
  ).toBe(200);
  expect(stop).toEqual(input);
  expect(observed).toEqual(actor);
  const replacementInput: ReplaceEnrollmentRequest = {
    requestId,
    expectedVersion: 1,
    paymentMethodId: methodId,
    termsVersion: ENROLLMENT_TERMS_VERSION,
    acceptTerms: true,
    selections: [
      {
        subscriptionId,
        expectedSubscriptionVersion: 3,
        fromPeriodIndex: scope.fromPeriodIndex,
      },
    ],
  };
  await error(
    await app.handle(
      mutation(`${path}/automatic-payment-enrollment`, replacementInput),
    ),
    "conflict",
    409,
  );
  expect(replacement).toEqual(replacementInput);
  expect(observed).toEqual(actor);
  actor = null;
  await error(await app.handle(mutation(refresh, {})), "unauthenticated", 401);
  expect((await app.handle(mutation("/unrelated", {}, {}))).status).toBe(200);
  actor = { userId: "sample-user", sessionId: "sample-session" };
  config.paymentSettings.getPaymentSettings = async () => {
    throw new Error("private persistence details");
  };
  await error(
    await app.handle(read(`${path}/payment-settings`)),
    "unavailable",
    503,
  );
  const disabled = new Elysia({ normalize: false }).use(
    paymentSettingsRoutes(),
  );
  await error(
    await disabled.handle(read(`${path}/payment-settings`)),
    "unavailable",
    503,
  );
});
