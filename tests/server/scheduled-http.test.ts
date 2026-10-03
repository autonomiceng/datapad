import { expect, test } from "bun:test";
import { openapi } from "@elysia/openapi";
import { Elysia } from "elysia";
import type { HumanActor } from "../../src/access/types";
import type {
  ConfigureScheduleRequest,
  ScheduleResponse,
} from "../../src/billing/scheduled-contract";
import {
  scheduledRoutes,
  type ScheduledHttp,
} from "../../src/server/scheduled-routes";

const origin = "http://localhost";
const customerId = "00000000-0000-4000-8000-000000000001";
const subscriptionId = "00000000-0000-4000-8000-000000000002";
const path = `/api/customers/${customerId}`;
const input: ConfigureScheduleRequest = {
  requestId: "00000000-0000-4000-8000-000000000003",
  expectedVersion: 0,
  change: {
    kind: "activate",
    subscriptions: [
      { subscriptionId, expectedVersion: 1, activationFromPeriodIndex: 2 },
    ],
  },
};
const schedule: ScheduleResponse["schedule"] = {
  customerId,
  version: 1,
  issuancePaused: false,
  canManage: true,
  activations: [
    {
      subscriptionId,
      activationFromPeriodIndex: 2,
      activatedAt: "2026-10-03T09:00:00Z",
      firstPeriod: {
        periodIndex: 2,
        periodStart: "2026-11-01",
        periodEnd: "2026-12-01",
        dueDate: "2026-11-22",
      },
      beforeActivation: {
        fromPeriodIndex: 0,
        throughPeriodIndex: 1,
        periodStart: "2026-09-01",
        periodEnd: "2026-11-01",
        fromDueDate: "2026-09-22",
        throughDueDate: "2026-10-22",
      },
    },
  ],
  continuing: [],
  continuingTotal: 0,
};
const read = (route: string) => new Request(`${origin}${route}`);
const mutation = (
  body: unknown,
  headers: Record<string, string> = { origin },
) =>
  new Request(`${origin}${path}/billing-schedule`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
async function error(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ code });
}

test("scheduled HTTP requires current identity before availability and preserves strict scoped commands, safe responses and route-local guards", async () => {
  let actor: HumanActor | null = {
    userId: "sample-staff",
    sessionId: "sample-session",
  };
  let conflict = false;
  const authorized = (current: HumanActor, id: string) =>
    current.userId === "sample-staff" &&
    current.sessionId === "sample-session" &&
    id === customerId;
  const config: ScheduledHttp = {
    origin,
    access: { resolveActor: async () => actor },
    scheduled: {
      getSchedule: async (current, id) =>
        authorized(current, id)
          ? { ok: true, value: { schedule } }
          : { ok: false, code: "forbidden" },
      configureSchedule: async (current, id, body) => {
        if (!authorized(current, id)) return { ok: false, code: "forbidden" };
        if (conflict) return { ok: false, code: "conflict" };
        if (JSON.stringify(body) !== JSON.stringify(input))
          return { ok: false, code: "invalid_request" };
        return { ok: true, value: { schedule, outcome: "changed" } };
      },
      listScheduledGroups: async (current, id, query) =>
        authorized(current, id)
          ? { ok: true, value: { ...query, groups: [], total: 0 } }
          : { ok: false, code: "forbidden" },
      sweepScheduled: async () => {
        throw new Error("No browser sweep");
      },
      assertSyntheticData: async () => {},
    },
  };
  const app = new Elysia({ normalize: false })
    .use(openapi({ path: "/api/openapi", provider: null }))
    .use(scheduledRoutes(config))
    .post("/sibling", () => ({ accepted: true }));
  const configured = await app.handle(mutation(input));
  expect(configured.status).toBe(200);
  expect(configured.headers.get("cache-control")).toBe("no-store");
  expect(await configured.json()).toEqual({ schedule, outcome: "changed" });
  const current = await app.handle(read(`${path}/billing-schedule`));
  expect(current.status).toBe(200);
  expect(current.headers.get("cache-control")).toBe("no-store");
  expect(await current.json()).toEqual({ schedule });
  const query =
    "fromDueDate=2026-10-01&throughDueDate=2026-12-01&limit=10&offset=0";
  const groups = await app.handle(read(`${path}/scheduled-groups?${query}`));
  expect(groups.status).toBe(200);
  expect(groups.headers.get("cache-control")).toBe("no-store");
  expect(await groups.json()).toEqual({
    fromDueDate: "2026-10-01",
    throughDueDate: "2026-12-01",
    limit: 10,
    offset: 0,
    groups: [],
    total: 0,
  });
  await error(
    await app.handle(mutation(input, { origin: "https://foreign.test" })),
    403,
    "forbidden",
  );
  await error(await app.handle(mutation(input, {})), 403, "forbidden");
  await error(
    await app.handle(mutation(input, { origin, "content-type": "text/plain" })),
    422,
    "invalid_request",
  );
  await error(
    await app.handle(mutation({ ...input, actor: "forged" })),
    422,
    "invalid_request",
  );
  await error(
    await app.handle(
      mutation({ ...input, change: { ...input.change, providerId: "forged" } }),
    ),
    422,
    "invalid_request",
  );
  await error(
    await app.handle(
      read(
        `${path}/scheduled-groups?${query.replace("limit=10", "limit=1.5")}`,
      ),
    ),
    422,
    "invalid_request",
  );
  await error(
    await app.handle(read(`${path}/billing-schedule?unexpected=true`)),
    422,
    "invalid_request",
  );
  conflict = true;
  await error(await app.handle(mutation(input)), 409, "conflict");
  actor = { userId: "sample-staff", sessionId: "revoked-session" };
  await error(
    await app.handle(read(`${path}/billing-schedule`)),
    403,
    "forbidden",
  );
  config.scheduled = undefined;
  actor = null;
  await error(
    await app.handle(read(`${path}/billing-schedule`)),
    401,
    "unauthenticated",
  );
  await error(await app.handle(mutation(input)), 401, "unauthenticated");
  actor = { userId: "sample-staff", sessionId: "sample-session" };
  await error(
    await app.handle(read(`${path}/billing-schedule`)),
    503,
    "unavailable",
  );
  await error(await app.handle(mutation(input)), 503, "unavailable");
  expect(
    (await app.handle(new Request(`${origin}/sibling`, { method: "POST" })))
      .status,
  ).toBe(200);
  config.access.resolveActor = async () => {
    throw new Error("private database details");
  };
  await error(
    await app.handle(read(`${path}/billing-schedule`)),
    503,
    "unavailable",
  );
  const document = await (await app.handle(read("/api/openapi/json"))).json();
  const route = document.paths["/api/customers/{customerId}/billing-schedule"];
  expect(route.get.operationId).toBe("getCustomerBillingSchedule");
  expect(route.post.operationId).toBe("configureCustomerBillingSchedule");
  expect(
    route.post.requestBody.content["application/json"].schema
      .additionalProperties,
  ).toBe(false);
  expect(
    route.post.responses["200"].content["application/json"].schema.required,
  ).toEqual(["schedule", "outcome"]);
  expect(
    document.paths["/api/customers/{customerId}/scheduled-groups"].get
      .responses["403"],
  ).toBeDefined();
  expect(
    Object.keys(document.paths).some((route) => route.includes("sweep")),
  ).toBe(false);
});
