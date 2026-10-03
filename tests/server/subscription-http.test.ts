import { expect, test } from "bun:test";
import { Elysia } from "elysia";
import type { HumanActor } from "../../src/access/types";
import type {
  CreateSubscriptionRequest,
  SubscriptionResponse,
} from "../../src/billing/subscriptions-contract";
import {
  subscriptionRoutes,
  type SubscriptionHttp,
} from "../../src/server/subscription-routes";

const origin = "http://localhost";
const customerId = "00000000-0000-4000-8000-000000000001";
const subscriptionId = "00000000-0000-4000-8000-000000000002";
const requestId = "00000000-0000-4000-8000-000000000003";
const path = `/api/customers/${customerId}`;
const calendar = { timeZone: "UTC", issueHour: 9, chargeHour: 9 };
const boundary = {
  periodIndex: 0,
  periodStart: "2026-11-01",
  periodEnd: "2026-12-01",
  dueDate: "2026-11-22",
};
const input: CreateSubscriptionRequest = {
  requestId,
  serviceId: null,
  periodAnchorDate: boundary.periodStart,
  dueAnchorDate: boundary.dueDate,
  intervalMonths: 1,
  firstUnbilledPeriodIndex: 0,
  label: "Sample agreement",
  amountMinor: 2300,
  paymentArrangement: "manual",
};
const detail: SubscriptionResponse = {
  subscription: {
    id: subscriptionId,
    customerId,
    serviceId: null,
    version: 1,
    periodAnchorDate: input.periodAnchorDate,
    dueAnchorDate: input.dueAnchorDate,
    intervalMonths: 1,
    firstUnbilledPeriodIndex: 0,
    calendar,
    label: input.label,
    amountMinor: input.amountMinor,
    paymentArrangement: "manual",
    billingState: "billable",
    nextRenewal: boundary.periodStart,
    cancellation: { status: "none", reason: null, effectivePeriodIndex: null },
    canManage: true,
    firstUnbilled: boundary,
    upcomingChanges: [],
    changesTruncated: false,
  },
};
const read = (route: string) => new Request(`${origin}${route}`);
const mutation = (
  route: string,
  body: unknown,
  headers: Record<string, string> = { origin },
  method: "POST" | "PATCH" = "POST",
) =>
  new Request(`${origin}${route}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
async function error(response: Response, code: string, status: number) {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ code });
}

test("subscription transport uses current identity, strict numeric queries and local mutation guards without intercepting sibling routes", async () => {
  let actor: HumanActor | null = {
    userId: "sample-staff",
    sessionId: "sample-session",
  };
  let created = false;
  let observed: HumanActor | undefined;
  const config: SubscriptionHttp = {
    origin,
    access: { resolveActor: async () => actor },
    readOptions: async () => ({
      ok: true,
      value: {
        cancellationReasons: ["Sample cancellation"],
        choices: [],
        calendar,
        periodAnchorDate: input.periodAnchorDate,
        dueAnchorDate: input.dueAnchorDate,
      },
    }),
    subscriptions: {
      listSubscriptions: async (current, id, page) => {
        observed = current;
        expect(id).toBe(customerId);
        expect(page).toEqual({ limit: 10, offset: 0 });
        return {
          ok: true,
          value: { subscriptions: [], total: 0, limit: 10, offset: 0 },
        };
      },
      getSubscription: async () => ({ ok: true, value: detail }),
      createSubscription: async () => {
        const outcome = created ? "unchanged" : "created";
        created = true;
        return { ok: true, value: { ...detail, outcome } };
      },
      changeSubscription: async () => ({ ok: false, code: "conflict" }),
      getBoundaryOptions: async (current, id, query) => {
        observed = current;
        expect(id).toBe(customerId);
        expect(query.intervalMonths).toBe(1);
        return { ok: true, value: { boundaries: [boundary], calendar } };
      },
      getForecast: async (current, id, query) => {
        observed = current;
        expect(id).toBe(customerId);
        expect(query.limit).toBe(10);
        return {
          ok: true,
          value: { ...query, groups: [], total: 0, complete: false },
        };
      },
      materializeForecast: async () => ({ ok: false, code: "forbidden" }),
      assertSyntheticData: async () => {},
    },
  };
  const app = new Elysia({ normalize: false })
    .use(subscriptionRoutes(config))
    .post("/unrelated", () => ({ accepted: true }));
  const disabled = new Elysia({ normalize: false })
    .use(subscriptionRoutes())
    .post("/unrelated", () => ({ accepted: true }));
  expect((await disabled.handle(mutation("/unrelated", {}, {}))).status).toBe(
    200,
  );
  expect((await app.handle(mutation("/unrelated", {}, {}))).status).toBe(200);
  await error(
    await disabled.handle(read(`${path}/subscription-options`)),
    "unavailable",
    503,
  );
  expect((await app.handle(read(`${path}/subscription-options`))).status).toBe(
    200,
  );
  const list = await app.handle(
    read(`${path}/subscriptions?limit=10&offset=0`),
  );
  expect(list.status).toBe(200);
  expect(list.headers.get("cache-control")).toBe("no-store");
  expect(observed).toEqual(actor);
  expect(
    (await app.handle(mutation(`${path}/subscriptions`, input))).status,
  ).toBe(201);
  expect(
    (await app.handle(mutation(`${path}/subscriptions`, input))).status,
  ).toBe(200);
  actor = { userId: "sample-customer", sessionId: "new-session" };
  const query = new URLSearchParams({
    periodAnchorDate: input.periodAnchorDate,
    dueAnchorDate: input.dueAnchorDate,
    intervalMonths: "1",
    fromDueDate: boundary.dueDate,
    throughDueDate: "2027-02-22",
  });
  expect(
    (await app.handle(read(`${path}/subscription-boundaries?${query}`))).status,
  ).toBe(200);
  expect(observed).toEqual(actor);
  expect(
    (
      await app.handle(
        read(
          `${path}/billing-forecast?fromDueDate=2026-11-22&throughDueDate=2027-02-22&limit=10&offset=0`,
        ),
      )
    ).status,
  ).toBe(200);
  await error(
    await app.handle(
      mutation(`${path}/billing-forecast`, {
        requestId,
        fromDueDate: boundary.dueDate,
        throughDueDate: "2027-02-22",
      }),
    ),
    "forbidden",
    403,
  );
  await error(
    await app.handle(
      mutation(
        `${path}/subscriptions/${subscriptionId}`,
        {
          requestId,
          expectedVersion: 1,
          change: { kind: "pause_billing", effectivePeriodIndex: 1 },
        },
        { origin },
        "PATCH",
      ),
    ),
    "conflict",
    409,
  );
  await error(
    await app.handle(mutation(`${path}/subscriptions`, input, {})),
    "forbidden",
    403,
  );
  await error(
    await app.handle(
      mutation(`${path}/subscriptions`, input, {
        origin: "https://foreign.test",
      }),
    ),
    "forbidden",
    403,
  );
  await error(
    await app.handle(
      mutation(`${path}/subscriptions`, input, {
        origin,
        "content-type": "text/plain",
      }),
    ),
    "invalid_request",
    422,
  );
  await error(
    await app.handle(mutation(`${path}/subscriptions`, { ...input, calendar })),
    "invalid_request",
    422,
  );
  await error(
    await app.handle(read(`${path}/subscriptions?limit=1.5&offset=0`)),
    "invalid_request",
    422,
  );
  await error(
    await app.handle(
      read(`${path}/subscription-boundaries?${query}&extra=true`),
    ),
    "invalid_request",
    422,
  );
  actor = null;
  await error(
    await app.handle(read(`${path}/subscriptions/${subscriptionId}`)),
    "unauthenticated",
    401,
  );
  config.readOptions = async () => {
    throw new Error("private persistence details");
  };
  actor = { userId: "sample-staff", sessionId: "sample-session" };
  await error(
    await app.handle(read(`${path}/subscription-options`)),
    "unavailable",
    503,
  );
});
