import { afterAll, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import {
  createAccess,
  createAuthentication,
  createAuditWriter,
  bootstrapSyntheticAccess,
} from "../../src/access";
import { user, session } from "../../src/access/internal/schema";
import type { HumanActor } from "../../src/access/types";
import type { StaffRole } from "../../src/access/contract";
import { createCustomers, createCustomerRegistry } from "../../src/customers";
import type { Customers } from "../../src/customers/types";
import { createSubscriptions, createBilling } from "../../src/billing";
import type {
  CalendarPolicy,
  CreateSubscriptionRequest,
  ChangeSubscriptionRequest,
} from "../../src/billing/subscriptions-contract";
import { SyntheticBillingProvider } from "./billing-provider";
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL is required");
const pool = new Pool({ connectionString: url, max: 2 });
const lockPool = new Pool({ connectionString: url, max: 2 });
const db = drizzle(pool);
const clear = () =>
  pool.query(
    'TRUNCATE customers, "user", organization, verification, access_audit, access_commands CASCADE',
  );
beforeEach(clear);
afterAll(async () => {
  await clear();
  await Promise.all([pool.end(), lockPool.end()]);
});
function value<T>(
  result: { ok: true; value: T } | { ok: false; code: string },
): T {
  if (!result.ok) throw new Error(result.code);
  return result.value;
}
const rejection = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: unknown) => error,
  );
const input = (
  overrides: Partial<CreateSubscriptionRequest> = {},
): CreateSubscriptionRequest => ({
  requestId: randomUUID(),
  serviceId: null,
  periodAnchorDate: "2030-01-01",
  dueAnchorDate: "2030-01-22",
  intervalMonths: 1,
  firstUnbilledPeriodIndex: 0,
  label: "Synthetic recurring support",
  amountMinor: 1200,
  paymentArrangement: "manual",
  ...overrides,
});
const window = (fromDueDate = "2030-01-22", throughDueDate = fromDueDate) => ({
  fromDueDate,
  throughDueDate,
  limit: 100,
  offset: 0,
});
async function setup(
  calendar: CalendarPolicy = {
    timeZone: "America/Los_Angeles",
    issueHour: 9,
    chargeHour: 9,
  },
) {
  const audit = createAuditWriter();
  const registry = createCustomerRegistry({
    operatorId: "billing-workflow-test",
    audit,
    allowProfile: (profile) =>
      ["Elm (sample)", "Elm revised (sample)", "Birch (sample)"].includes(
        profile.legalName,
      ) &&
      (profile.billingEmail === null ||
        profile.billingEmail === "billing@elm.test"),
  });
  const roles: Record<string, StaffRole[]> = {
    billing: ["billing"],
    admin: ["account_administrator"],
    support: ["support"],
    staff: ["account_administrator", "billing"],
    member: [],
    outsider: [],
  };
  const ids = await db.transaction(async (tx) => {
    await bootstrapSyntheticAccess(tx, {
      operatorId: "billing-workflow-test",
      allowedEmails: Object.keys(roles).map((id) => `${id}@workflow.test`),
      users: Object.entries(roles).map(([id, staffRoles]) => ({
        id,
        name: `${id} (sample)`,
        email: `${id}@workflow.test`,
        staffRoles,
      })),
      organizations: [
        {
          id: "elm-org",
          name: "Elm (sample)",
          slug: "elm",
          members: [{ userId: "member", role: "administrator" }],
        },
        {
          id: "birch-org",
          name: "Birch (sample)",
          slug: "birch",
          members: [{ userId: "outsider", role: "administrator" }],
        },
      ],
    });
    const elm = await registry.ensureCustomer(tx, {
      registryKey: '["billing-test","elm"]',
      initialProfile: {
        legalName: "Elm (sample)",
        displayName: "Elm (sample)",
        billingEmail: null,
      },
      organizationId: "elm-org",
    });
    const birch = await registry.ensureCustomer(tx, {
      registryKey: '["billing-test","birch"]',
      initialProfile: {
        legalName: "Birch (sample)",
        displayName: "Birch (sample)",
        billingEmail: null,
      },
      organizationId: "birch-org",
    });
    return { elm: elm.customerId, birch: birch.customerId };
  });
  const actors: Record<string, HumanActor> = {};
  for (const userId of Object.keys(roles)) {
    await db
      .update(user)
      .set({ emailVerified: true })
      .where(eq(user.id, userId));
    const sessionId = randomUUID();
    await db.insert(session).values({
      id: sessionId,
      userId,
      token: randomUUID(),
      expiresAt: new Date(Date.now() + 86400000),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    actors[userId] = { userId, sessionId };
  }
  const authentication = createAuthentication({
    pool,
    baseURL: "http://localhost:4321",
    secret: "workflow-test-synthetic-secret-0123456789",
    synthetic: true,
    allowedEmails: Object.keys(roles).map((id) => `${id}@workflow.test`),
    sendMagicLink: async () => {},
  });
  let customers: Customers;
  const access = createAccess({
    pool,
    lockPool,
    authentication: authentication.gateway,
    getCustomerTarget: (id) => customers.getAccessTarget(id),
    getOrganizationTarget: (id) => customers.getOrganizationTarget(id),
    allowInvitation: () => false,
    signInMethods: ["email_link"],
    synthetic: true,
    baseURL: "http://localhost:4321",
    sendInvitation: async () => {},
  });
  customers = createCustomers({
    pool,
    access: access.policy,
    audit,
    allowProfile: () => true,
    providerProfile: async () => "not_linked",
  });
  let clock = new Date("2030-01-01T12:00:00Z");
  const options = {
    pool,
    deploymentKey: "subscriptions-test",
    authorizeCustomer: (
      tx: Parameters<Customers["authorizeCustomer"]>[0],
      actor: HumanActor,
      customerId: string,
      capability: Parameters<Customers["authorizeCustomer"]>[3],
      mutation: boolean,
    ) =>
      customers.authorizeCustomer(tx, actor, customerId, capability, mutation),
    audit,
    calendar,
    allowSubscription: (record: {
      customerId: string;
      label: string;
      cancellationReason: string | null;
    }) =>
      [ids.elm, ids.birch].includes(record.customerId) &&
      record.label === "Synthetic recurring support" &&
      [
        null,
        "Customer requested cancellation",
        "Cancellation confirmed",
        "Continue the agreement",
      ].includes(record.cancellationReason),
    now: () => clock,
  };
  const subscriptions = createSubscriptions(options);
  const services = {
    hosting: randomUUID(),
    addon: randomUUID(),
    foreign: randomUUID(),
  };
  await pool.query(
    "INSERT INTO services(id,customer_id,source_key,kind,name,included_components) VALUES($1,$2,'hosting','hosting','Synthetic hosting','{}'),($3,$2,'addon','addon','Synthetic add-on','{}'),($4,$5,'foreign','hosting','Synthetic foreign','{}')",
    [services.hosting, ids.elm, services.addon, services.foreign, ids.birch],
  );
  return {
    ids,
    actors,
    registry,
    options,
    audit,
    subscriptions,
    services,
    setDate: (date: string) => {
      clock = new Date(date);
    },
  };
}
async function change(
  s: Awaited<ReturnType<typeof setup>>,
  id: string,
  change: ChangeSubscriptionRequest["change"],
) {
  const current = value(
    await s.subscriptions.getSubscription(s.actors.billing, s.ids.elm, id),
  ).subscription;
  return value(
    await s.subscriptions.changeSubscription(s.actors.billing, s.ids.elm, id, {
      requestId: randomUUID(),
      expectedVersion: current.version,
      change,
    }),
  );
}

test("forecast calendar keeps original anchors, first-unbilled dates and explicit local-time outcomes", async () => {
  const s = await setup();
  const monthly = value(
    await s.subscriptions.createSubscription(
      s.actors.billing,
      s.ids.elm,
      input({
        periodAnchorDate: "2030-01-31",
        dueAnchorDate: "2030-01-31",
        firstUnbilledPeriodIndex: 1,
      }),
    ),
  ).subscription;
  const leap = value(
    await s.subscriptions.createSubscription(
      s.actors.billing,
      s.ids.elm,
      input({
        periodAnchorDate: "2024-02-29",
        dueAnchorDate: "2024-02-29",
        intervalMonths: 12,
        firstUnbilledPeriodIndex: 5,
      }),
    ),
  ).subscription;
  const boundary = value(
    await s.subscriptions.getBoundaryOptions(s.actors.member, s.ids.elm, {
      periodAnchorDate: "2030-01-31",
      dueAnchorDate: "2030-02-28",
      intervalMonths: 1,
      fromDueDate: "2030-02-01",
      throughDueDate: "2030-04-30",
    }),
  );
  expect(
    boundary.boundaries.map((row) => [
      row.periodStart,
      row.periodEnd,
      row.dueDate,
    ]),
  ).toEqual([
    ["2030-01-31", "2030-02-28", "2030-02-28"],
    ["2030-02-28", "2030-03-31", "2030-03-28"],
    ["2030-03-31", "2030-04-30", "2030-04-28"],
  ]);
  const forecast = value(
    await s.subscriptions.materializeForecast(s.actors.billing, s.ids.elm, {
      requestId: randomUUID(),
      fromDueDate: "2030-01-01",
      throughDueDate: "2032-03-31",
    }),
  );
  const rows = forecast.groups.flatMap((group) => group.periods);
  expect(
    rows
      .filter((row) => row.subscriptionId === monthly.id)
      .slice(0, 2)
      .map((row) => [row.periodIndex, row.periodStart, row.chargeAt]),
  ).toEqual([
    [1, "2030-02-28", "2030-02-28T17:00:00.000Z"],
    [2, "2030-03-31", "2030-03-31T16:00:00.000Z"],
  ]);
  expect(
    rows
      .filter((row) => row.subscriptionId === leap.id)
      .map((row) => row.periodStart),
  ).toEqual(["2030-02-28", "2031-02-28", "2032-02-29"]);
  const gapFactory = createSubscriptions({
    ...s.options,
    calendar: { timeZone: "America/Los_Angeles", issueHour: 2, chargeHour: 2 },
  });
  const gap = value(
    await gapFactory.createSubscription(
      s.actors.billing,
      s.ids.elm,
      input({ periodAnchorDate: "2030-01-10", dueAnchorDate: "2030-01-10" }),
    ),
  ).subscription;
  const invalid = value(
    await gapFactory.materializeForecast(s.actors.billing, s.ids.elm, {
      requestId: randomUUID(),
      fromDueDate: "2030-03-10",
      throughDueDate: "2030-03-10",
    }),
  );
  expect(invalid.groups[0]).toMatchObject({
    outcome: "needs_review",
    reviewReasons: ["invalid_local_time"],
    periods: [{ subscriptionId: gap.id, chargeAt: null }],
  });
  expect(
    await s.subscriptions.createSubscription(
      s.actors.billing,
      s.ids.elm,
      input({ dueAnchorDate: "2030-03-01" }),
    ),
  ).toEqual({ ok: false, code: "invalid_request" });
  await s.subscriptions.assertSyntheticData();
});

test("current authority and atomic audit protect concurrent period identity and customer-owned relationships", async () => {
  const s = await setup();
  expect(
    await s.subscriptions.createSubscription(
      s.actors.admin,
      s.ids.elm,
      input(),
    ),
  ).toEqual({ ok: false, code: "forbidden" });
  expect(
    await s.subscriptions.createSubscription(
      s.actors.member,
      s.ids.elm,
      input(),
    ),
  ).toEqual({ ok: false, code: "forbidden" });
  expect(
    await s.subscriptions.createSubscription(
      s.actors.billing,
      s.ids.elm,
      input({ serviceId: s.services.foreign }),
    ),
  ).toEqual({ ok: false, code: "invalid_request" });
  const request = input({ serviceId: s.services.hosting });
  const subscription = value(
    await s.subscriptions.createSubscription(
      s.actors.billing,
      s.ids.elm,
      request,
    ),
  ).subscription;
  expect(
    value(
      await s.subscriptions.createSubscription(
        s.actors.billing,
        s.ids.elm,
        request,
      ),
    ).outcome,
  ).toBe("unchanged");
  const broken = createSubscriptions({
    ...s.options,
    audit: {
      ...s.audit,
      append: async (tx, entry) => {
        await s.audit.append(tx, entry);
        throw new Error("Synthetic audit interruption");
      },
    },
  });
  const materialize = {
    requestId: randomUUID(),
    fromDueDate: "2030-01-22",
    throughDueDate: "2030-02-22",
  };
  expect(
    await rejection(
      broken.materializeForecast(s.actors.billing, s.ids.elm, materialize),
    ),
  ).toBeInstanceOf(Error);
  expect(
    (await pool.query("SELECT count(*)::int AS total FROM billing_periods"))
      .rows,
  ).toEqual([{ total: 0 }]);
  const other = { ...materialize, requestId: randomUUID() };
  const results = await Promise.all([
    s.subscriptions.materializeForecast(
      s.actors.billing,
      s.ids.elm,
      materialize,
    ),
    s.subscriptions.materializeForecast(s.actors.billing, s.ids.elm, other),
  ]);
  expect(results.map((result) => value(result).outcome).sort()).toEqual([
    "changed",
    "unchanged",
  ]);
  expect(
    value(results[0]).groups.flatMap((group) =>
      group.periods.map((row) => row.id),
    ),
  ).toEqual(
    value(results[1]).groups.flatMap((group) =>
      group.periods.map((row) => row.id),
    ),
  );
  const recorded =
    value(results[0]).outcome === "changed" ? materialize : other;
  expect(
    await s.subscriptions.materializeForecast(
      s.actors.billing,
      s.ids.elm,
      recorded,
    ),
  ).toEqual({ ok: false, code: "conflict" });
  expect(
    (
      await pool.query(
        "SELECT count(*)::int AS total FROM access_audit WHERE action='forecast.materialized'",
      )
    ).rows,
  ).toEqual([{ total: 1 }]);
  expect(
    value(
      await s.subscriptions.getForecast(
        s.actors.member,
        s.ids.elm,
        window("2030-01-22", "2030-02-22"),
      ),
    ).complete,
  ).toBe(true);
  expect(
    await s.subscriptions.getSubscription(
      s.actors.outsider,
      s.ids.elm,
      subscription.id,
    ),
  ).toEqual({ ok: false, code: "not_found" });
  const cross = await rejection(
    pool.query(
      "INSERT INTO billing_subscription_terms(subscription_id,customer_id,deployment_key,revision,effective_period_index,kind,billing_state) VALUES($1,$2,'subscriptions-test',99,1,'state','paused')",
      [subscription.id, s.ids.birch],
    ),
  );
  expect(cross).toMatchObject({ code: "23503" });
  await db.delete(session).where(eq(session.id, s.actors.billing.sessionId));
  expect(
    await s.subscriptions.materializeForecast(s.actors.billing, s.ids.elm, {
      ...materialize,
      requestId: randomUUID(),
    }),
  ).toEqual({ ok: false, code: "unauthenticated" });
});

test("forecast separates arrangements and independent add-ons while warning only about overlapping same-service agreements", async () => {
  const s = await setup();
  const provider = new SyntheticBillingProvider();
  const billing = createBilling({
    pool,
    provider,
    customers: s.registry,
    deploymentKey: provider.ownership.deploymentKey,
    now: s.options.now,
  });
  const invoice = await billing.requestInvoice({
    originKey: "synthetic:unrelated-onetime",
    customer: { key: "elm", name: "Elm (sample)" },
    issueDate: "2030-01-01",
    dueDate: "2030-01-22",
    currency: "USD",
    lines: [
      {
        description: "Synthetic one-time support",
        amountMinor: 1200,
        originRef: null,
      },
    ],
  });
  if (invoice.kind !== "created") throw new Error("Fixture invoice failed");
  const before = await billing.getInvoice(invoice.invoiceId);
  const serviceBefore = (await pool.query("SELECT * FROM services ORDER BY id"))
    .rows;
  for (const request of [
    input({ serviceId: s.services.hosting }),
    input({ serviceId: s.services.addon, amountMinor: 500 }),
    input({ paymentArrangement: "automatic", amountMinor: 1000 }),
    input({ amountMinor: 800 }),
  ])
    value(
      await s.subscriptions.createSubscription(
        s.actors.billing,
        s.ids.elm,
        request,
      ),
    );
  const grouped = value(
    await s.subscriptions.materializeForecast(s.actors.billing, s.ids.elm, {
      requestId: randomUUID(),
      fromDueDate: "2030-01-22",
      throughDueDate: "2030-01-22",
    }),
  );
  expect(
    grouped.groups.map((group) => [
      group.paymentArrangement,
      group.totalMinor,
      group.outcome,
    ]),
  ).toEqual([
    ["automatic", 1000, "billable"],
    ["manual", 2500, "billable"],
  ]);
  value(
    await s.subscriptions.createSubscription(
      s.actors.billing,
      s.ids.elm,
      input({
        serviceId: s.services.hosting,
        dueAnchorDate: "2030-01-23",
        amountMinor: 100,
      }),
    ),
  );
  const overlap = value(
    await s.subscriptions.getForecast(s.actors.member, s.ids.elm, window()),
  );
  expect(overlap.groups[1].reviewReasons).toContain("overlapping_agreement");
  expect((await pool.query("SELECT * FROM services ORDER BY id")).rows).toEqual(
    serviceBefore,
  );
  expect(await billing.getInvoice(invoice.invoiceId)).toEqual(before);
  expect(provider.invoices.size).toBe(0);
});

test("durable zero facts and read-time classification expose free, tiny and negative periods without read effects", async () => {
  const s = await setup();
  const free = value(
    await s.subscriptions.createSubscription(
      s.actors.billing,
      s.ids.elm,
      input({ amountMinor: 0 }),
    ),
  ).subscription;
  const missing = value(
    await s.subscriptions.getForecast(s.actors.member, s.ids.elm, window()),
  );
  expect(missing).toMatchObject({
    complete: false,
    groups: [
      {
        outcome: "needs_review",
        reviewReasons: ["not_materialized"],
        periods: [{ id: null }],
      },
    ],
  });
  const noCharge = value(
    await s.subscriptions.materializeForecast(s.actors.billing, s.ids.elm, {
      requestId: randomUUID(),
      fromDueDate: "2030-01-22",
      throughDueDate: "2030-02-22",
    }),
  );
  expect(noCharge.groups.map((group) => group.outcome)).toEqual([
    "no_charge",
    "no_charge",
  ]);
  value(
    await s.subscriptions.createSubscription(
      s.actors.billing,
      s.ids.elm,
      input(),
    ),
  );
  value(
    await s.subscriptions.createSubscription(
      s.actors.billing,
      s.ids.elm,
      input({ amountMinor: 25, paymentArrangement: "automatic" }),
    ),
  );
  const mixed = value(
    await s.subscriptions.materializeForecast(s.actors.billing, s.ids.elm, {
      requestId: randomUUID(),
      fromDueDate: "2030-02-22",
      throughDueDate: "2030-02-22",
    }),
  );
  expect(mixed.groups[0]).toMatchObject({
    outcome: "needs_review",
    reviewReasons: ["unsupported_total"],
    totalMinor: 25,
  });
  expect(mixed.groups[1]).toMatchObject({
    outcome: "billable",
    totalMinor: 1200,
  });
  expect(mixed.groups[1].periods.some((row) => row.amountMinor === 0)).toBe(
    true,
  );
  expect(
    await s.subscriptions.changeSubscription(
      s.actors.billing,
      s.ids.elm,
      free.id,
      {
        requestId: randomUUID(),
        expectedVersion: 1,
        change: {
          kind: "terms",
          effectivePeriodIndex: 1,
          label: "Synthetic recurring support",
          amountMinor: -100,
          paymentArrangement: "manual",
        },
      },
    ),
  ).toEqual({ ok: false, code: "invalid_request" });
  await pool.query(
    "INSERT INTO billing_subscription_terms(subscription_id,customer_id,deployment_key,revision,effective_period_index,kind,label,amount_minor,currency,payment_arrangement) VALUES($1,$2,'subscriptions-test',3,1,'commercial','Synthetic recurring support',-100,'USD','manual')",
    [free.id, s.ids.elm],
  );
  const negative = value(
    await s.subscriptions.materializeForecast(s.actors.billing, s.ids.elm, {
      requestId: randomUUID(),
      fromDueDate: "2030-02-22",
      throughDueDate: "2030-02-22",
    }),
  );
  expect(negative.groups[1].reviewReasons).toContain("negative_amount");
  const persisted = (
    await pool.query("SELECT * FROM billing_periods ORDER BY id")
  ).rows;
  const auditCount = (await pool.query("SELECT count(*) FROM access_audit"))
    .rows;
  s.setDate("2030-02-23T12:00:00Z");
  const late = value(
    await s.subscriptions.getForecast(
      s.actors.member,
      s.ids.elm,
      window("2030-02-22"),
    ),
  );
  expect(late.groups[0].reviewReasons).toContain("past_due");
  expect(
    (await pool.query("SELECT * FROM billing_periods ORDER BY id")).rows,
  ).toEqual(persisted);
  expect((await pool.query("SELECT count(*) FROM access_audit")).rows).toEqual(
    auditCount,
  );
});

test("future revisions refresh every window and cancellation dominates both planned prices and resumes without rewriting sealed history", async () => {
  const s = await setup();
  const sub = value(
    await s.subscriptions.createSubscription(
      s.actors.billing,
      s.ids.elm,
      input(),
    ),
  ).subscription;
  for (const date of ["2030-03-22", "2031-01-22"])
    value(
      await s.subscriptions.materializeForecast(s.actors.billing, s.ids.elm, {
        requestId: randomUUID(),
        fromDueDate: date,
        throughDueDate: date,
      }),
    );
  const oldIds = (
    await pool.query("SELECT id FROM billing_periods ORDER BY period_index")
  ).rows;
  await change(s, sub.id, {
    kind: "terms",
    effectivePeriodIndex: 1,
    label: "Synthetic recurring support",
    amountMinor: 0,
    paymentArrangement: "manual",
  });
  expect(
    value(
      await s.subscriptions.getForecast(
        s.actors.member,
        s.ids.elm,
        window("2031-01-22"),
      ),
    ).groups[0].outcome,
  ).toBe("no_charge");
  await change(s, sub.id, {
    kind: "terms",
    effectivePeriodIndex: 12,
    label: "Synthetic recurring support",
    amountMinor: 1400,
    paymentArrangement: "manual",
  });
  await change(s, sub.id, { kind: "pause_billing", effectivePeriodIndex: 10 });
  const paused = value(
    await s.subscriptions.getForecast(
      s.actors.member,
      s.ids.elm,
      window("2031-01-22"),
    ),
  ).groups[0];
  expect(paused).toMatchObject({
    outcome: "inactive",
    totalMinor: 0,
    periods: [{ amountMinor: 1400, billingState: "paused" }],
  });
  await change(s, sub.id, { kind: "resume_billing", effectivePeriodIndex: 12 });
  await change(s, sub.id, {
    kind: "request_cancellation",
    reason: "Customer requested cancellation",
  });
  await change(s, sub.id, {
    kind: "decide_cancellation",
    decision: "approve",
    reason: "Cancellation confirmed",
    effectivePeriodIndex: 10,
  });
  const cancelled = value(
    await s.subscriptions.getForecast(
      s.actors.member,
      s.ids.elm,
      window("2031-01-22"),
    ),
  ).groups[0];
  expect(cancelled.periods[0]).toMatchObject({
    amountMinor: 1400,
    billingState: "cancelled",
  });
  const current = value(
    await s.subscriptions.getSubscription(s.actors.billing, s.ids.elm, sub.id),
  ).subscription;
  expect(
    current.upcomingChanges.some(
      (term) =>
        term.kind === "state" &&
        term.billingState === "billable" &&
        term.effectivePeriodIndex >= 10,
    ),
  ).toBe(false);
  expect(
    await s.subscriptions.changeSubscription(
      s.actors.billing,
      s.ids.elm,
      sub.id,
      {
        requestId: randomUUID(),
        expectedVersion: current.version,
        change: { kind: "resume_billing", effectivePeriodIndex: 13 },
      },
    ),
  ).toEqual({ ok: false, code: "conflict" });
  expect(
    await s.subscriptions.materializeForecast(s.actors.billing, s.ids.elm, {
      requestId: randomUUID(),
      fromDueDate: "2033-02-22",
      throughDueDate: "2033-02-22",
    }),
  ).toEqual({ ok: false, code: "invalid_request" });
  expect(
    (await pool.query("SELECT id FROM billing_periods ORDER BY period_index"))
      .rows,
  ).toEqual(oldIds);
  await pool.query(
    "UPDATE billing_periods SET sealed_at='2030-12-31T17:00:00Z' WHERE subscription_id=$1 AND period_index=12",
    [sub.id],
  );
  const sealed = (
    await pool.query(
      "SELECT * FROM billing_periods WHERE subscription_id=$1 AND period_index=12",
      [sub.id],
    )
  ).rows;
  expect(
    await s.subscriptions.changeSubscription(
      s.actors.billing,
      s.ids.elm,
      sub.id,
      {
        requestId: randomUUID(),
        expectedVersion: current.version,
        change: {
          kind: "terms",
          effectivePeriodIndex: 11,
          label: "Synthetic recurring support",
          amountMinor: 1500,
          paymentArrangement: "manual",
        },
      },
    ),
  ).toEqual({ ok: false, code: "conflict" });
  expect(
    (
      await pool.query(
        "SELECT * FROM billing_periods WHERE subscription_id=$1 AND period_index=12",
        [sub.id],
      )
    ).rows,
  ).toEqual(sealed);
  await s.subscriptions.assertSyntheticData();
});
