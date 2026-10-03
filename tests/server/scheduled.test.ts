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
import {
  createSubscriptions,
  createBilling,
  createScheduledBilling,
} from "../../src/billing";
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
  periodAnchorDate: "2030-01-02",
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
    deploymentKey: "billing-test",
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
  const provider = new SyntheticBillingProvider();
  const scheduledOptions = {
    pool,
    deploymentKey: "billing-test",
    providerOwnership: provider.ownership,
    customerAccess: customers,
    audit,
    workerId: "synthetic-scheduler",
    allowSubscription: options.allowSubscription,
    allowRequest: (record: {
      customerId: string;
      billTo: { legalName: string; billingEmail: string | null };
      request: { lines: Array<{ description: string }> };
    }) =>
      [ids.elm, ids.birch].includes(record.customerId) &&
      ["Elm (sample)", "Elm revised (sample)", "Birch (sample)"].includes(
        record.billTo.legalName,
      ) &&
      [null, "billing@elm.test"].includes(record.billTo.billingEmail) &&
      record.request.lines.every(
        (line) => line.description === "Synthetic recurring support",
      ),
    now: options.now,
  };
  const scheduled = createScheduledBilling(scheduledOptions);
  const billing = createBilling({
    pool,
    deploymentKey: "billing-test",
    provider,
    customers: registry,
    now: options.now,
  });
  return {
    ids,
    actors,
    registry,
    options,
    audit,
    subscriptions,
    customers,
    provider,
    scheduledOptions,
    scheduled,
    billing,
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

async function add(
  s: Awaited<ReturnType<typeof setup>>,
  overrides: Partial<CreateSubscriptionRequest> = {},
  customerId = s.ids.elm,
) {
  return value(
    await s.subscriptions.createSubscription(
      s.actors.billing,
      customerId,
      input(overrides),
    ),
  ).subscription;
}
async function activate(
  s: Awaited<ReturnType<typeof setup>>,
  selections: Array<{ id: string; version: number; index?: number }>,
  customerId = s.ids.elm,
) {
  const schedule = value(
    await s.scheduled.getSchedule(s.actors.billing, customerId),
  ).schedule;
  return value(
    await s.scheduled.configureSchedule(s.actors.billing, customerId, {
      requestId: randomUUID(),
      expectedVersion: schedule.version,
      change: {
        kind: "activate",
        subscriptions: selections.map((sub) => ({
          subscriptionId: sub.id,
          expectedVersion: sub.version,
          activationFromPeriodIndex: sub.index ?? 0,
        })),
      },
    }),
  );
}
async function hold(s: Awaited<ReturnType<typeof setup>>, pause: boolean) {
  const current = value(
    await s.scheduled.getSchedule(s.actors.billing, s.ids.elm),
  ).schedule;
  return value(
    await s.scheduled.configureSchedule(s.actors.billing, s.ids.elm, {
      requestId: randomUUID(),
      expectedVersion: current.version,
      change: { kind: pause ? "pause_issuance" : "resume_issuance" },
    }),
  );
}
const rowCount = async (table: string) =>
  Number((await pool.query(`select count(*) as n from ${table}`)).rows[0].n);

test("concurrent schedule sweeps seal once and audit failure rolls back the invoice and period claims", async () => {
  const s = await setup();
  const sub = await add(s);
  expect(
    await s.scheduled.configureSchedule(s.actors.admin, s.ids.elm, {
      requestId: randomUUID(),
      expectedVersion: 0,
      change: {
        kind: "activate",
        subscriptions: [
          {
            subscriptionId: sub.id,
            expectedVersion: sub.version,
            activationFromPeriodIndex: 0,
          },
        ],
      },
    }),
  ).toEqual({ ok: false, code: "forbidden" });
  await activate(s, [sub]);
  s.setDate("2030-01-01T17:00:00Z");
  const failing = createScheduledBilling({
    ...s.scheduledOptions,
    audit: {
      ...s.audit,
      recordOperator: async () => {
        throw new Error("Synthetic audit outage");
      },
    },
  });
  expect((await failing.sweepScheduled()).results[0].failure).toBe(
    "unavailable",
  );
  expect(await rowCount("invoices")).toBe(0);
  expect(await rowCount("billing_invoice_groups")).toBe(0);
  expect(await rowCount("billing_periods")).toBe(0);
  const sweeps = await Promise.all([
    s.scheduled.sweepScheduled(),
    s.scheduled.sweepScheduled(),
  ]);
  const invoiceIds = sweeps.flatMap((page) =>
    page.results.flatMap((result) => result.invoiceIds),
  );
  expect(invoiceIds).toHaveLength(1);
  expect(await rowCount("billing_invoice_groups")).toBe(1);
  expect(
    (
      await pool.query(
        "select count(*) as n from access_audit where action='invoice_group.sealed'",
      )
    ).rows[0].n,
  ).toBe("1");
  expect(await s.billing.pendingWork()).toContainEqual({
    kind: "issue",
    invoiceId: invoiceIds[0],
  });
  expect(await s.billing.issueInvoice(invoiceIds[0])).toBe("complete");
  expect((await s.billing.getInvoice(invoiceIds[0]))?.invoice.state).toBe(
    "open",
  );
  await s.billing.assertSyntheticPolicy(
    () => false,
    s.provider.ownership.accountId,
    s.scheduledOptions.allowRequest,
  );
  await s.scheduled.assertSyntheticData();
  expect(
    value(
      await s.scheduled.listScheduledGroups(
        s.actors.member,
        s.ids.elm,
        window(),
      ),
    ).groups[0].outcome,
  ).toBe("invoice_requested");
  expect(await s.scheduled.getSchedule(s.actors.outsider, s.ids.elm)).toEqual({
    ok: false,
    code: "not_found",
  });
});

test("same-date arrangements preflight together and preserve zero lines, final No charge and recipient snapshots", async () => {
  const s = await setup();
  const paid = await add(s);
  const free = await add(s, { amountMinor: 0 });
  const tiny = await add(s, {
    amountMinor: 25,
    paymentArrangement: "automatic",
  });
  const birch = await add(s, { amountMinor: 0 }, s.ids.birch);
  await activate(s, [paid, free, tiny]);
  await activate(s, [birch], s.ids.birch);
  s.setDate("2030-01-01T17:00:00Z");
  const first = await s.scheduled.sweepScheduled();
  expect(
    first.results.find((row) => row.customerId === s.ids.elm)?.reviewReasons,
  ).toContain("unsupported_total");
  expect(
    first.results.find((row) => row.customerId === s.ids.elm)?.groupIds,
  ).toEqual([]);
  expect(
    first.results.find((row) => row.customerId === s.ids.birch)?.invoiceIds,
  ).toEqual([]);
  expect(await rowCount("billing_customers")).toBe(0);
  const nocharge = value(
    await s.scheduled.listScheduledGroups(
      s.actors.billing,
      s.ids.birch,
      window(),
    ),
  ).groups[0];
  expect(nocharge).toMatchObject({
    outcome: "no_charge",
    totalMinor: 0,
    invoice: null,
  });
  await change(s, tiny.id, {
    kind: "terms",
    effectivePeriodIndex: 0,
    label: "Synthetic recurring support",
    amountMinor: 500,
    paymentArrangement: "automatic",
  });
  const second = await s.scheduled.sweepScheduled();
  const ids = second.results.find(
    (row) => row.customerId === s.ids.elm,
  )!.invoiceIds;
  expect(ids).toHaveLength(2);
  const views = await Promise.all(ids.map((id) => s.billing.getInvoice(id)));
  expect(
    views.map((row) => row!.invoice.totalMinor).sort((a, b) => a - b),
  ).toEqual([500, 1200]);
  expect(
    views
      .find((row) => row!.invoice.totalMinor === 1200)!
      .invoice.lines.map((line) => line.amountMinor)
      .sort((a, b) => a - b),
  ).toEqual([0, 1200]);
  await s.scheduled.assertSyntheticData();
  value(
    await s.customers.updateCustomer(s.actors.staff, s.ids.elm, {
      requestId: randomUUID(),
      expectedVersion: 1,
      profile: {
        displayName: "Elm revised (sample)",
        legalName: "Elm revised (sample)",
        billingEmail: "billing@elm.test",
      },
    }),
  );
  s.setDate("2030-02-01T17:00:00Z");
  const renamed = await s.scheduled.sweepScheduled();
  expect(
    renamed.results.find((row) => row.customerId === s.ids.elm)?.reviewReasons,
  ).toContain("provider_profile_pending");
  expect(
    renamed.results.find((row) => row.customerId === s.ids.elm)?.groupIds,
  ).toEqual([]);
  expect((await s.billing.getInvoice(ids[0]))?.invoice.billTo).toEqual({
    legalName: "Elm (sample)",
    billingEmail: null,
    profileVersion: 1,
  });
});

test("activation, bounded recovery and per-effect issuance holds respect calendar readiness and legacy attempts", async () => {
  const s = await setup();
  const old = await add(s, {
    periodAnchorDate: "2029-12-01",
    dueAnchorDate: "2029-12-22",
  });
  expect(
    await s.scheduled.configureSchedule(s.actors.billing, s.ids.elm, {
      requestId: randomUUID(),
      expectedVersion: 0,
      change: {
        kind: "activate",
        subscriptions: [
          {
            subscriptionId: old.id,
            expectedVersion: old.version,
            activationFromPeriodIndex: 0,
          },
        ],
      },
    }),
  ).toEqual({ ok: false, code: "invalid_request" });
  const activation = await activate(s, [{ ...old, index: 1 }]);
  expect(activation.schedule.activations[0].beforeActivation).toMatchObject({
    fromPeriodIndex: 0,
    throughPeriodIndex: 0,
    fromDueDate: "2029-12-22",
  });
  const birch = await add(s, {}, s.ids.birch);
  await activate(s, [birch], s.ids.birch);
  expect(
    (await s.scheduled.sweepScheduled()).results.flatMap((row) => row.groupIds),
  ).toEqual([]);
  s.setDate("2030-01-01T17:00:00Z");
  const first = await s.scheduled.sweepScheduled({ limit: 1 });
  expect(first.next).not.toBeNull();
  const last = await s.scheduled.sweepScheduled({
    limit: 1,
    after: first.next,
    through: first.through,
  });
  expect(last.next).toBeNull();
  const id = [...first.results, ...last.results].find(
    (row) => row.customerId === s.ids.elm,
  )!.invoiceIds[0];
  await hold(s, true);
  expect(await s.billing.issueInvoice(id)).toBe("retry");
  expect(s.provider.customers.size).toBe(0);
  const birchId = [...first.results, ...last.results].find(
    (row) => row.customerId === s.ids.birch,
  )!.invoiceIds[0];
  expect(await s.billing.pendingWork(1)).toEqual([
    { kind: "issue", invoiceId: birchId },
  ]);
  expect(
    await s.billing.acceptEvent({
      ...s.provider.ownership,
      invoiceId: id,
      providerInvoiceId: `in_${id}`,
      eventId: "evt_held_synthetic",
      eventType: "invoice.paid",
      createdAt: s.options.now().toISOString(),
    }),
  ).toBe("accepted");
  expect(await s.billing.pendingWork(2)).toEqual(
    expect.arrayContaining([
      { kind: "issue", invoiceId: birchId },
      { kind: "event", eventId: "evt_held_synthetic" },
    ]),
  );
  expect(
    (
      await pool.query(
        "select attempts,create_attempted_at from invoices where id=$1",
        [id],
      )
    ).rows[0],
  ).toEqual({ attempts: 0, create_attempted_at: null });
  s.setDate("2030-01-01T17:00:31Z");
  expect(await s.billing.pendingWork(2)).toEqual(
    expect.arrayContaining([
      { kind: "issue", invoiceId: birchId },
      { kind: "event", eventId: "evt_held_synthetic" },
    ]),
  );
  expect(await s.billing.pendingWork()).not.toContainEqual({
    kind: "issue",
    invoiceId: id,
  });
  await hold(s, false);
  s.provider.interrupt.add("customer");
  expect(await s.billing.issueInvoice(id)).toBe("retry");
  await hold(s, true);
  s.setDate("2030-01-01T17:01:00Z");
  expect(await s.billing.pendingWork()).toContainEqual({
    kind: "issue",
    invoiceId: id,
  });
  expect(await s.billing.issueInvoice(id)).toBe("retry");
  expect(s.provider.customers.size).toBe(1);
  expect(s.provider.invoices.size).toBe(0);
  await hold(s, false);
  s.setDate("2030-01-01T17:01:31Z");
  s.provider.interrupt.add("invoice");
  expect(await s.billing.issueInvoice(id)).toBe("retry");
  await hold(s, true);
  s.setDate("2030-01-01T17:02:02Z");
  expect(await s.billing.pendingWork()).toContainEqual({
    kind: "issue",
    invoiceId: id,
  });
  expect(await s.billing.issueInvoice(id)).toBe("retry");
  expect([...s.provider.invoices.values()][0].lines).toHaveLength(1);
  expect([...s.provider.invoices.values()][0].status).toBe("draft");
  expect(
    value(await s.scheduled.getSchedule(s.actors.billing, s.ids.elm)).schedule
      .continuing[0],
  ).toMatchObject({
    invoiceId: id,
    invoiceCreateAttempted: true,
    finalizeAttempted: false,
  });
  s.setDate("2030-01-01T17:02:33Z");
  expect(await s.billing.pendingWork()).not.toContainEqual({
    kind: "issue",
    invoiceId: id,
  });
  await hold(s, false);
  s.provider.interrupt.add("finalize");
  expect(await s.billing.issueInvoice(id)).toBe("retry");
  await hold(s, true);
  s.setDate("2030-01-01T17:05:00Z");
  expect(await s.billing.pendingWork()).toContainEqual({
    kind: "issue",
    invoiceId: id,
  });
  expect(await s.billing.issueInvoice(id)).toBe("complete");
  expect((await s.billing.getInvoice(id))?.invoice.state).toBe("open");
  const late = await add(s, {
    periodAnchorDate: "2030-02-02",
    dueAnchorDate: "2030-02-22",
  });
  await activate(s, [late]);
  const birchInvoice = [...first.results, ...last.results].find(
    (row) => row.customerId === s.ids.birch,
  )!.invoiceIds[0];
  s.setDate("2030-01-23T07:59:58Z");
  s.provider.interrupt.add("invoice");
  expect(await s.billing.issueInvoice(birchInvoice)).toBe("retry");
  const birchSchedule = value(
    await s.scheduled.getSchedule(s.actors.billing, s.ids.birch),
  ).schedule;
  value(
    await s.scheduled.configureSchedule(s.actors.billing, s.ids.birch, {
      requestId: randomUUID(),
      expectedVersion: birchSchedule.version,
      change: { kind: "pause_issuance" },
    }),
  );
  s.setDate("2030-01-23T08:00:04Z");
  expect(await s.billing.pendingWork()).toContainEqual({
    kind: "issue",
    invoiceId: birchInvoice,
  });
  expect(await s.billing.issueInvoice(birchInvoice)).toBe("needs_review");
  expect((await s.billing.getInvoice(birchInvoice))?.invoice.state).toBe(
    "needs_review",
  );
  expect(
    (
      await pool.query(
        "select finalize_attempted_at from invoices where id=$1",
        [birchInvoice],
      )
    ).rows[0].finalize_attempted_at,
  ).toBeNull();
  s.setDate("2030-02-23T08:00:00Z");
  await hold(s, false);
  expect(
    (await s.scheduled.sweepScheduled()).results.flatMap(
      (row) => row.invoiceIds,
    ),
  ).toEqual([]);
  expect(
    value(
      await s.scheduled.listScheduledGroups(
        s.actors.billing,
        s.ids.elm,
        window("2030-02-22"),
      ),
    ).groups.some((group) => group.kind === "missed"),
  ).toBe(true);
  const legacy = await s.billing.requestInvoice({
    originKey: "legacy-recovery",
    customer: { key: "legacy", name: "Elm (sample)" },
    issueDate: "2030-02-23",
    dueDate: "2030-03-01",
    currency: "USD",
    lines: [
      {
        description: "Synthetic recurring support",
        amountMinor: 1200,
        originRef: null,
      },
    ],
  });
  if (legacy.kind !== "created") throw new Error("legacy request failed");
  await s.billing.requestIssue(legacy.invoiceId);
  s.setDate("2030-02-28T23:59:00Z");
  s.provider.interrupt.add("invoice");
  expect(await s.billing.issueInvoice(legacy.invoiceId)).toBe("retry");
  await hold(s, true);
  s.setDate("2030-03-01T00:01:00Z");
  expect(await s.billing.issueInvoice(legacy.invoiceId)).toBe("complete");
});

test("sealed exclusions and No charge cannot be rewritten or supplemented by late arrangements", async () => {
  const s = await setup();
  const free = await add(s, { amountMinor: 0 });
  const paused = await add(s, {
    amountMinor: 500,
    paymentArrangement: "automatic",
  });
  await change(s, paused.id, {
    kind: "pause_billing",
    effectivePeriodIndex: 0,
  });
  const pausedCurrent = value(
    await s.subscriptions.getSubscription(
      s.actors.billing,
      s.ids.elm,
      paused.id,
    ),
  ).subscription;
  await activate(s, [free, pausedCurrent]);
  s.setDate("2030-01-01T17:00:00Z");
  const sealed = await s.scheduled.sweepScheduled();
  expect(sealed.results[0].groupIds).toHaveLength(1);
  expect(sealed.results[0].invoiceIds).toEqual([]);
  const rows = (
    await pool.query(
      "select billing_state,sealed_at,invoice_group_id from billing_periods order by billing_state",
    )
  ).rows;
  expect(rows).toHaveLength(2);
  expect(rows.every((row) => row.sealed_at !== null)).toBe(true);
  expect(
    rows.find((row) => row.billing_state === "paused").invoice_group_id,
  ).toBeNull();
  const current = value(
    await s.subscriptions.getSubscription(
      s.actors.billing,
      s.ids.elm,
      paused.id,
    ),
  ).subscription;
  expect(
    await s.subscriptions.changeSubscription(
      s.actors.billing,
      s.ids.elm,
      paused.id,
      {
        requestId: randomUUID(),
        expectedVersion: current.version,
        change: { kind: "resume_billing", effectivePeriodIndex: 0 },
      },
    ),
  ).toEqual({ ok: false, code: "conflict" });
  const freeCurrent = value(
    await s.subscriptions.getSubscription(s.actors.billing, s.ids.elm, free.id),
  ).subscription;
  expect(
    await s.subscriptions.changeSubscription(
      s.actors.billing,
      s.ids.elm,
      free.id,
      {
        requestId: randomUUID(),
        expectedVersion: freeCurrent.version,
        change: {
          kind: "terms",
          effectivePeriodIndex: 0,
          label: "Synthetic recurring support",
          amountMinor: 1200,
          paymentArrangement: "manual",
        },
      },
    ),
  ).toEqual({ ok: false, code: "conflict" });
  // An agreement activated before this seal can have its later period join a sealed date.
  s.setDate("2029-12-01T12:00:00Z");
  const late = await add(s, {
    periodAnchorDate: "2029-12-01",
    dueAnchorDate: "2029-12-22",
    paymentArrangement: "automatic",
  });
  await activate(s, [late]);
  s.setDate("2030-01-01T17:00:00Z");
  expect(
    (await s.scheduled.sweepScheduled()).results[0].reviewReasons,
  ).toContain("late_period");
  const history = value(
    await s.scheduled.listScheduledGroups(
      s.actors.billing,
      s.ids.elm,
      window(),
    ),
  );
  expect(
    history.groups.some(
      (group) =>
        group.kind === "late" && group.paymentArrangement === "automatic",
    ),
  ).toBe(true);
  expect(await rowCount("billing_invoice_groups")).toBe(1);
  expect(await rowCount("invoices")).toBe(0);
  await s.scheduled.assertSyntheticData();
  await pool.query(
    "update billing_invoice_groups set bill_to_name='Unapproved recipient'",
  );
  expect(await rejection(s.scheduled.assertSyntheticData())).toBeInstanceOf(
    Error,
  );
});
