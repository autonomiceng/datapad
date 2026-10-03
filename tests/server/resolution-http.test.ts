import { expect, test } from "bun:test";
import { Elysia } from "elysia";
import type { AccessResult, HumanActor } from "../../src/access/types";
import type {
  ExternalPaymentRequest,
  ReceiptCorrectionRequest,
  ReconcileResolutionRequest,
  ResolutionActionResponse,
  ResolutionReviewResponse,
  VoidInvoiceRequest,
} from "../../src/billing/resolutions-contract";
import {
  resolutionRoutes,
  type ResolutionHttp,
} from "../../src/server/resolution-routes";

const origin = "http://localhost";
const customerId = "00000000-0000-4000-8000-000000000001";
const invoiceId = "00000000-0000-4000-8000-000000000002";
const requestId = "00000000-0000-4000-8000-000000000003";
const otherId = "00000000-0000-4000-8000-000000000004";
const path = `/api/customers/${customerId}/invoices/${invoiceId}`;
const received: ExternalPaymentRequest = {
  requestId,
  amountMinor: 500,
  receivedDate: "2026-10-03",
  method: "check",
  reference: "Sample receipt",
};
const pending: ResolutionActionResponse = {
  resolution: {
    id: otherId,
    kind: "external_payment",
    state: "pending",
    amountMinor: received.amountMinor,
    receivedDate: received.receivedDate,
    method: received.method,
    createdAt: "2026-10-03T12:00:00Z",
    confirmedAt: null,
    reviewReason: null,
  },
};
const review: ResolutionReviewResponse = {
  invoiceId,
  remainingMinor: null,
  collectionState: "unknown",
  lastCheckedAt: null,
  actions: ["record_external_payment"],
  blockers: ["provider_unavailable"],
  resolution: null,
  history: [],
};
const read = (route: string) => new Request(`${origin}${route}`);
const post = (
  route: string,
  body: unknown,
  headers: Record<string, string> = { origin },
) =>
  new Request(`${origin}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
async function error(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ code });
}

function fixture() {
  let actor: HumanActor | null = {
    userId: "sample-staff",
    sessionId: "sample-session",
  };
  let failure: "conflict" | "forbidden" | null = null;
  let calls = 0;
  let lastInput: unknown;
  const authorize = (
    current: HumanActor,
    customer: string,
    invoice: string,
  ) => {
    if (
      current.userId !== actor?.userId ||
      current.sessionId !== actor?.sessionId
    )
      throw new Error("Unexpected stale identity");
    if (customer !== customerId || invoice !== invoiceId)
      return { ok: false, code: "not_found" } as const;
    if (failure) return { ok: false, code: failure } as const;
    return null;
  };
  const action = async (
    current: HumanActor,
    customer: string,
    invoice: string,
    input:
      | ExternalPaymentRequest
      | VoidInvoiceRequest
      | ReceiptCorrectionRequest
      | ReconcileResolutionRequest,
  ): Promise<AccessResult<ResolutionActionResponse>> => {
    calls++;
    lastInput = input;
    return (
      authorize(current, customer, invoice) ?? { ok: true, value: pending }
    );
  };
  const config: ResolutionHttp = {
    origin,
    access: { resolveActor: async () => actor },
    resolutions: {
      getResolutionReview: async (current, customer, invoice) =>
        authorize(current, customer, invoice) ?? { ok: true, value: review },
      recordExternalPayment: action,
      requestVoid: action,
      flagReceiptCorrection: action,
      reconcileResolution: action,
    },
  };
  return {
    config,
    app: new Elysia({ normalize: false }).use(resolutionRoutes(config)),
    setActor(value: HumanActor | null) {
      actor = value;
    },
    setFailure(value: typeof failure) {
      failure = value;
    },
    get calls() {
      return calls;
    },
    get lastInput() {
      return lastInput;
    },
  };
}

test("resolution HTTP keeps current identity, invoice scope and pending outcomes explicit", async () => {
  const f = fixture();
  const loaded = await f.app.handle(read(`${path}/resolution-review`));
  expect(loaded.status).toBe(200);
  expect(loaded.headers.get("cache-control")).toBe("no-store");
  expect(await loaded.json()).toEqual(review);
  const recorded = await f.app.handle(
    post(`${path}/external-payment`, received),
  );
  expect(recorded.status).toBe(200);
  expect(recorded.headers.get("cache-control")).toBe("no-store");
  expect(await recorded.json()).toEqual(pending);
  expect(f.lastInput).toEqual(received);
  f.setActor({ userId: "next-staff", sessionId: "next-session" });
  for (const [suffix, input] of [
    ["void", { requestId, reason: "Sample void reason" }],
    ["receipt-correction", { requestId, reason: "Sample correction reason" }],
    ["reconcile", { requestId }],
  ] as const) {
    expect((await f.app.handle(post(`${path}/${suffix}`, input))).status).toBe(
      200,
    );
    expect(f.lastInput).toEqual(input);
  }
  await error(
    await f.app.handle(
      read(`/api/customers/${otherId}/invoices/${invoiceId}/resolution-review`),
    ),
    404,
    "not_found",
  );
  await error(
    await f.app.handle(
      post(
        `/api/customers/${customerId}/invoices/${otherId}/external-payment`,
        received,
      ),
    ),
    404,
    "not_found",
  );
  f.setFailure("conflict");
  await error(
    await f.app.handle(post(`${path}/external-payment`, received)),
    409,
    "conflict",
  );
  expect(f.lastInput).toEqual(received);
  f.setFailure("forbidden");
  await error(
    await f.app.handle(read(`${path}/resolution-review`)),
    403,
    "forbidden",
  );
  await error(
    await f.app.handle(
      post(`${path}/void`, { requestId, reason: "Sample reason" }),
    ),
    403,
    "forbidden",
  );
  f.setActor(null);
  await error(
    await f.app.handle(read(`${path}/resolution-review`)),
    401,
    "unauthenticated",
  );
});

test("resolution HTTP rejects unsafe browser bodies and masks unavailable internals", async () => {
  const f = fixture();
  for (const route of [
    "external-payment",
    "void",
    "receipt-correction",
    "reconcile",
  ]) {
    const input =
      route === "external-payment"
        ? received
        : route === "reconcile"
          ? { requestId }
          : { requestId, reason: "Sample reason" };
    await error(
      await f.app.handle(
        post(`${path}/${route}`, input, { origin: "https://foreign.test" }),
      ),
      403,
      "forbidden",
    );
    await error(
      await f.app.handle(post(`${path}/${route}`, input, {})),
      403,
      "forbidden",
    );
    await error(
      await f.app.handle(
        post(`${path}/${route}`, input, {
          origin,
          "content-type": "text/plain",
        }),
      ),
      422,
      "invalid_request",
    );
    await error(
      await f.app.handle(
        post(`${path}/${route}`, {
          ...input,
          providerInvoiceId: "forbidden-provider-id",
        }),
      ),
      422,
      "invalid_request",
    );
  }
  await error(
    await f.app.handle(
      post(`${path}/external-payment`, { ...received, amountMinor: 0 }),
    ),
    422,
    "invalid_request",
  );
  await error(
    await f.app.handle(
      post(`${path}/external-payment`, { ...received, amountMinor: "500" }),
    ),
    422,
    "invalid_request",
  );
  await error(
    await f.app.handle(
      post(`${path}/external-payment`, {
        ...received,
        receivedDate: "not-a-date",
      }),
    ),
    422,
    "invalid_request",
  );
  await error(
    await f.app.handle(
      read(`${path}/resolution-review?providerInvoiceId=forbidden`),
    ),
    422,
    "invalid_request",
  );
  await error(
    await f.app.handle(
      new Request(`${origin}${path}/external-payment`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: "{",
      }),
    ),
    422,
    "invalid_request",
  );
  expect(f.calls).toBe(0);
  f.config.resolutions = undefined;
  await error(
    await f.app.handle(post(`${path}/external-payment`, received)),
    503,
    "unavailable",
  );
  await error(
    await resolutionRoutes().handle(read(`${path}/resolution-review`)),
    503,
    "unavailable",
  );
  f.config.access.resolveActor = async () => {
    throw new Error("private provider/database detail");
  };
  await error(
    await f.app.handle(read(`${path}/resolution-review`)),
    503,
    "unavailable",
  );
});
