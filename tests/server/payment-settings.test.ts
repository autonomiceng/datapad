import { afterAll, beforeEach, expect, test } from "bun:test";
// Standalone domain runs use the same response formats as HTTP composition.
import "elysia/type-system/format";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq, sql } from "drizzle-orm";
import {
  createAccess,
  createAuditWriter,
  bootstrapSyntheticAccess,
} from "../../src/access";
import { session, member, user } from "../../src/access/internal/schema";
import type { HumanActor, AuditWriter } from "../../src/access/types";
import { createCustomers, createCustomerRegistry } from "../../src/customers";
import type { Customers } from "../../src/customers/types";
import {
  createPaymentSettings,
  createSubscriptions,
  createScheduledBilling,
} from "../../src/billing";
import type { PaymentSettingsOptions } from "../../src/billing/payment-settings-types";
import {
  SAVE_TERMS_VERSION,
  ENROLLMENT_TERMS_VERSION,
  PaymentSettingsResponseSchema,
  type ReplaceEnrollmentRequest,
  type StartPaymentSetupRequest,
} from "../../src/billing/payment-settings-contract";
import type {
  PaymentSettingsProvider,
  PaymentSetupIntent,
  ProviderPaymentSetup,
  ProviderSavedPaymentMethod,
  Lookup,
} from "../../src/billing/provider";
import type { CreateSubscriptionRequest } from "../../src/billing/subscriptions-contract";
import { Value } from "@sinclair/typebox/value";
import { billingCustomers } from "../../src/billing/internal/invoice-schema";
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL is required");
const pool = new Pool({ connectionString: url, max: 4 }),
  lockPool = new Pool({ connectionString: url, max: 2 }),
  db = drizzle(pool);
const clear = () =>
  pool.query(
    'TRUNCATE customers, "user", organization, verification, access_audit, access_commands CASCADE',
  );
beforeEach(clear);
afterAll(async () => {
  await clear();
  await Promise.all([pool.end(), lockPool.end()]);
});
function value<T>(r: { ok: true; value: T } | { ok: false; code: string }): T {
  if (!r.ok) throw new Error(r.code);
  return r.value;
}
const rejection = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: unknown) => error,
  );
class SetupProvider implements PaymentSettingsProvider {
  ownership = { deploymentKey: "payment-test", accountId: "acct_payment_test" };
  setups = new Map<string, ProviderPaymentSetup>();
  creates = 0;
  loseCreate = false;
  ambiguous = false;
  wrongOwner = false;
  beforeRetrieve: (() => Promise<void>) | null = null;
  async findSetup(
    intent: PaymentSetupIntent,
  ): Promise<Lookup<ProviderPaymentSetup>> {
    if (this.ambiguous) return { kind: "ambiguous" };
    const setup = this.setups.get(intent.setupId);
    return setup
      ? { kind: "found", value: structuredClone(setup) }
      : { kind: "absent" };
  }
  async createSetup(intent: PaymentSetupIntent) {
    this.creates++;
    const receipt: ProviderPaymentSetup = {
      ...intent,
      livemode: false,
      providerSessionId: `cs_test_${intent.setupId}`,
      status: "open",
      checkoutUrl: `https://checkout.stripe.com/c/setup/${intent.setupId}`,
      setupIntent: null,
    };
    this.setups.set(intent.setupId, receipt);
    if (this.loseCreate) {
      this.loseCreate = false;
      throw new Error("Synthetic lost response");
    }
    return structuredClone(receipt);
  }
  async retrieveSetup(intent: PaymentSetupIntent, providerSessionId: string) {
    await this.beforeRetrieve?.();
    const setup = this.setups.get(intent.setupId);
    if (!setup || setup.providerSessionId !== providerSessionId)
      throw new Error("Synthetic missing setup");
    return structuredClone(setup);
  }
  async retrieveSavedMethod(
    intent: PaymentSetupIntent,
    id: string,
  ): Promise<ProviderSavedPaymentMethod> {
    return {
      ...this.ownership,
      providerPaymentMethodId: id,
      providerCustomerId: this.wrongOwner
        ? "cus_foreign"
        : intent.providerCustomerId,
      livemode: false,
      type: "card",
      card: { brand: "visa", last4: "4242", expiryMonth: 12, expiryYear: 2035 },
    };
  }
  complete(id: string) {
    const receipt = this.setups.get(id)!;
    receipt.status = "complete";
    receipt.checkoutUrl = null;
    receipt.setupIntent = {
      providerSetupIntentId: `seti_${id}`,
      deploymentKey: this.ownership.deploymentKey,
      setupId: id,
      providerCustomerId: receipt.providerCustomerId,
      livemode: false,
      status: "succeeded",
      usage: "off_session",
      providerPaymentMethodId: `pm_${id}`,
    };
  }
}
async function setup() {
  const audit = createAuditWriter(),
    provider = new SetupProvider();
  const registry = createCustomerRegistry({
    audit,
    operatorId: "payment-settings-test",
    allowProfile: (p) =>
      [
        "Elm (sample)",
        "Elm updated (sample)",
        "Elm revised (sample)",
        "Birch (sample)",
      ].includes(p.legalName) && p.billingEmail === null,
  });
  const actors: Record<string, HumanActor> = {};
  const ids = await db.transaction(async (tx) => {
    await bootstrapSyntheticAccess(tx, {
      operatorId: "payment-settings-test",
      allowedEmails: ["staff", "admin", "ordinary", "dual", "foreign"].map(
        (id) => `${id}@payment.test`,
      ),
      users: [
        {
          id: "staff",
          name: "Staff (sample)",
          email: "staff@payment.test",
          staffRoles: ["account_administrator", "billing", "support"],
        },
        {
          id: "dual",
          name: "Dual (sample)",
          email: "dual@payment.test",
          staffRoles: ["billing"],
        },
        ...["admin", "ordinary", "foreign"].map((id) => ({
          id,
          name: `${id} (sample)`,
          email: `${id}@payment.test`,
          staffRoles: [],
        })),
      ],
      organizations: [
        {
          id: "elm-org",
          name: "Elm (sample)",
          slug: "elm",
          members: [
            { userId: "admin", role: "administrator" },
            { userId: "dual", role: "administrator" },
            { userId: "ordinary", role: "member" },
          ],
        },
        {
          id: "birch-org",
          name: "Birch (sample)",
          slug: "birch",
          members: [{ userId: "foreign", role: "administrator" }],
        },
      ],
    });
    const elm = await registry.ensureCustomer(tx, {
      registryKey: '["payment-test","elm"]',
      organizationId: "elm-org",
      initialProfile: {
        legalName: "Elm (sample)",
        displayName: "Elm (sample)",
        billingEmail: null,
      },
    });
    const birch = await registry.ensureCustomer(tx, {
      registryKey: '["payment-test","birch"]',
      organizationId: "birch-org",
      initialProfile: {
        legalName: "Birch (sample)",
        displayName: "Birch (sample)",
        billingEmail: null,
      },
    });
    for (const id of ["staff", "admin", "ordinary", "dual", "foreign"]) {
      await tx.update(user).set({ emailVerified: true }).where(eq(user.id, id));
      const sessionId = randomUUID();
      await tx.insert(session).values({
        id: sessionId,
        userId: id,
        token: randomUUID(),
        expiresAt: new Date(Date.now() + 86400000),
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      actors[id] = { userId: id, sessionId };
    }
    return { elm: elm.customerId, birch: birch.customerId };
  });
  let customers: Customers;
  const access = createAccess({
    pool,
    lockPool,
    authentication: {
      getSession: async () => null,
      acceptInvitation: async () => {
        throw new Error("No invitation in this fixture");
      },
    },
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
    allowProfile: (p) =>
      [
        "Elm (sample)",
        "Elm updated (sample)",
        "Elm revised (sample)",
        "Birch (sample)",
      ].includes(p.legalName) && p.billingEmail === null,
    providerProfile: async () => "not_linked",
  });
  let clock = new Date("2030-01-01T12:00:00Z");
  const allowSubscription = (s: {
    customerId: string;
    label: string;
    amountMinor: number;
  }) =>
    [ids.elm, ids.birch].includes(s.customerId) &&
    s.label === "Synthetic recurring support" &&
    [0, 1200, 1800].includes(s.amountMinor);
  const options: PaymentSettingsOptions = {
    pool,
    deploymentKey: provider.ownership.deploymentKey,
    providerOwnership: provider.ownership,
    provider,
    customerAccess: customers,
    audit,
    allowProfile: (p) =>
      [
        "Elm (sample)",
        "Elm updated (sample)",
        "Elm revised (sample)",
        "Birch (sample)",
      ].includes(p.legalName) && p.billingEmail === null,
    allowMappingName: (customerId, name) =>
      customerId === ids.elm
        ? [
            "Elm (sample)",
            "Elm updated (sample)",
            "Elm revised (sample)",
          ].includes(name)
        : customerId === ids.birch && name === "Birch (sample)",
    allowSubscription,
    successUrl: "http://localhost:4321/payment-settings/return",
    cancelUrl: "http://localhost:4321/payment-settings/return",
    now: () => clock,
    ensureCustomerReceipt: async (connection, id) => {
      // Capability fixture supplies a stable verified mapping receipt. Recovery itself belongs to the shared lifecycle tests.
      const receipt = `cus_${id}`;
      await connection.execute(
        sql`UPDATE billing_customers SET provider_customer_id=${receipt},create_attempted_at=coalesce(create_attempted_at,${clock.toISOString()}::timestamptz) WHERE id=${id}`,
      );
      return receipt;
    },
  };
  const settings = createPaymentSettings(options);
  const subscriptions = createSubscriptions({
    pool,
    deploymentKey: options.deploymentKey,
    authorizeCustomer: (...args) => customers.authorizeCustomer(...args),
    audit,
    calendar: { timeZone: "UTC", issueHour: 9, chargeHour: 9 },
    allowSubscription,
    now: options.now,
  });
  const scheduled = createScheduledBilling({
    pool,
    deploymentKey: options.deploymentKey,
    providerOwnership: provider.ownership,
    customerAccess: customers,
    audit,
    workerId: "synthetic-scheduler",
    allowSubscription,
    allowRequest: (r) =>
      r.request.lines.every(
        (l) => l.description === "Synthetic recurring support",
      ),
    now: options.now,
  });
  return {
    ids,
    actors,
    audit,
    provider,
    options,
    settings,
    customers,
    subscriptions,
    scheduled,
    setClock: (date: string) => {
      clock = new Date(date);
    },
  };
}
const setupInput = (): StartPaymentSetupRequest => ({
  requestId: randomUUID(),
  saveTermsVersion: SAVE_TERMS_VERSION,
  acceptSaveTerms: true as const,
});
async function save(
  s: Awaited<ReturnType<typeof setup>>,
  customerId = s.ids.elm,
  actor = s.actors.admin,
) {
  const pending = value(
    await s.settings.startSetup(actor, customerId, setupInput()),
  );
  s.provider.complete(pending.setupId);
  return value(
    await s.settings.refreshSetup(actor, customerId, pending.setupId),
  ).paymentMethodId!;
}
async function add(
  s: Awaited<ReturnType<typeof setup>>,
  overrides: Partial<CreateSubscriptionRequest> = {},
) {
  return value(
    await s.subscriptions.createSubscription(s.actors.staff, s.ids.elm, {
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
    }),
  ).subscription;
}
function enrollmentInput(
  methodId: string,
  subscriptions: Array<{ id: string; version: number }>,
  expectedVersion = 0,
): ReplaceEnrollmentRequest {
  return {
    requestId: randomUUID(),
    expectedVersion,
    paymentMethodId: methodId,
    termsVersion: ENROLLMENT_TERMS_VERSION,
    acceptTerms: true,
    selections: subscriptions.map((s) => ({
      subscriptionId: s.id,
      expectedSubscriptionVersion: s.version,
      fromPeriodIndex: 0,
    })),
  };
}

test("payment authority uses actual administrator membership and rechecks after hosted retrieval", async () => {
  const s = await setup(),
    input = setupInput();
  const emptyLocal = createPaymentSettings({
    ...s.options,
    provider: null,
    providerOwnership: null,
  });
  expect(await emptyLocal.assertSyntheticData()).toEqual(new Set());
  expect(
    value(await emptyLocal.getPaymentSettings(s.actors.admin, s.ids.elm)),
  ).toMatchObject({
    setupAvailable: false,
    methods: [],
    enrollment: null,
  });
  expect(
    await emptyLocal.getPaymentSettings(s.actors.foreign, s.ids.elm),
  ).toEqual({ ok: false, code: "not_found" });
  expect(await emptyLocal.startSetup(s.actors.admin, s.ids.elm, input)).toEqual(
    { ok: false, code: "unavailable" },
  );
  expect(await emptyLocal.startSetup(s.actors.staff, s.ids.elm, input)).toEqual(
    { ok: false, code: "forbidden" },
  );
  expect(
    await emptyLocal.replaceEnrollment(
      s.actors.admin,
      s.ids.elm,
      enrollmentInput(randomUUID(), [{ id: randomUUID(), version: 1 }]),
    ),
  ).toEqual({ ok: false, code: "unavailable" });
  expect(() =>
    createPaymentSettings({ ...s.options, providerOwnership: null }),
  ).toThrow("Invalid payment settings configuration");
  expect(() =>
    createPaymentSettings({
      ...s.options,
      providerOwnership: { ...s.provider.ownership, accountId: "acct_foreign" },
    }),
  ).toThrow("Invalid payment settings configuration");
  for (const actor of [s.actors.staff, s.actors.ordinary]) {
    expect(await s.settings.startSetup(actor, s.ids.elm, input)).toEqual({
      ok: false,
      code: "forbidden",
    });
    expect(
      await s.settings.replaceEnrollment(
        actor,
        s.ids.elm,
        enrollmentInput(randomUUID(), [{ id: randomUUID(), version: 1 }]),
      ),
    ).toEqual({ ok: false, code: "forbidden" });
  }
  expect(
    await s.settings.startSetup(s.actors.foreign, s.ids.elm, input),
  ).toEqual({ ok: false, code: "not_found" });
  const pending = value(
    await s.settings.startSetup(s.actors.dual, s.ids.elm, input),
  );
  expect(await rejection(emptyLocal.assertSyntheticData())).toBeInstanceOf(
    Error,
  );
  expect(
    await emptyLocal.getPaymentSettings(s.actors.admin, s.ids.elm),
  ).toEqual({ ok: false, code: "unavailable" });
  const receipt = s.provider.setups.get(pending.setupId)!;
  const expectedReturn = `http://localhost:4321/payment-settings/return?customerId=${s.ids.elm}&setupId=${pending.setupId}`;
  expect({
    successUrl: receipt.successUrl,
    cancelUrl: receipt.cancelUrl,
    status: value(
      await s.settings.refreshSetup(s.actors.dual, s.ids.elm, pending.setupId),
    ).status,
  }).toEqual({
    successUrl: expectedReturn,
    cancelUrl: expectedReturn,
    status: "pending",
  });
  expect(
    await s.settings.refreshSetup(
      s.actors.foreign,
      s.ids.birch,
      pending.setupId,
    ),
  ).toEqual({ ok: false, code: "not_found" });
  expect(
    await s.settings.refreshSetup(s.actors.admin, s.ids.elm, randomUUID()),
  ).toEqual({ ok: false, code: "not_found" });
  s.provider.complete(pending.setupId);
  s.provider.beforeRetrieve = async () => {
    await db.delete(member).where(eq(member.userId, "dual"));
  };
  expect(
    await s.settings.refreshSetup(s.actors.dual, s.ids.elm, pending.setupId),
  ).toEqual({ ok: false, code: "forbidden" });
  const read = value(
    await s.settings.getPaymentSettings(s.actors.admin, s.ids.elm),
  );
  expect(read.methods).toHaveLength(1);
  expect(read.enrollment).toBeNull();
  expect(
    [...Value.Errors(PaymentSettingsResponseSchema, read)].map(
      ({ path, message }) => ({ path, message }),
    ),
  ).toEqual([]);
  const audit = (
    await pool.query(
      "SELECT details FROM access_audit WHERE action='payment_setup.started'",
    )
  ).rows[0].details;
  expect(audit.consentingMembershipId).toBeString();
  expect(audit.membershipProvenance).toEqual({
    invitationId: null,
    invitedByUserId: null,
    invitedByStaff: null,
  });
});

test("lost setup responses and duplicate completion converge without consent or foreign method adoption", async () => {
  const s = await setup();
  // An earlier invoice established this mapping before the legal name changed.
  const mappingId = randomUUID();
  await db.insert(billingCustomers).values({
    id: mappingId,
    customerId: s.ids.elm,
    deploymentKey: s.provider.ownership.deploymentKey,
    providerAccountId: s.provider.ownership.accountId,
    key: "synthetic-invoice-mapping",
    name: "Elm (sample)",
    providerCustomerId: `cus_${mappingId}`,
    createAttemptedAt: "2029-12-31T12:00:00Z",
    createdAt: "2029-12-31T12:00:00Z",
  });
  const [originalMapping] = await db
    .select()
    .from(billingCustomers)
    .where(eq(billingCustomers.id, mappingId));
  const rename = async (legalName: string) => {
    const current = value(
      await s.customers.getCustomer(s.actors.admin, s.ids.elm),
    ).customer;
    value(
      await s.customers.updateCustomer(s.actors.staff, s.ids.elm, {
        requestId: randomUUID(),
        expectedVersion: current.version,
        profile: { legalName, displayName: legalName, billingEmail: null },
      }),
    );
  };
  await rename("Elm updated (sample)");
  s.provider.loseCreate = true;
  const request = setupInput();
  const attempts = await Promise.all([
    s.settings.startSetup(s.actors.admin, s.ids.elm, request),
    s.settings.startSetup(s.actors.admin, s.ids.elm, request),
  ]);
  const pending = value(attempts[0]);
  expect(value(attempts[1]).setupId).toBe(pending.setupId);
  expect(pending.status).toBe("pending");
  expect(s.provider.creates).toBe(1);
  await rename("Elm revised (sample)");
  const orphanId = randomUUID();
  await db.insert(billingCustomers).values({
    id: orphanId,
    customerId: s.ids.birch,
    deploymentKey: s.provider.ownership.deploymentKey,
    providerAccountId: s.provider.ownership.accountId,
    key: "synthetic-orphan",
    name: "Birch (sample)",
    createdAt: "2030-01-01T12:00:00Z",
  });
  expect(await createPaymentSettings(s.options).assertSyntheticData()).toEqual(
    new Set([mappingId]),
  );
  s.provider.complete(pending.setupId);
  const event = {
    ...s.provider.ownership,
    eventId: "evt_setup_test",
    setupId: pending.setupId,
    providerSessionId: s.provider.setups.get(pending.setupId)!
      .providerSessionId,
  };
  await Promise.all([
    s.settings.receiveSetupEvent(event),
    s.settings.receiveSetupEvent(event),
  ]);
  expect(await s.settings.pendingSetups()).toContain(pending.setupId);
  await Promise.all([
    s.settings.processSetup(pending.setupId),
    s.settings.processSetup(pending.setupId),
  ]);
  const repeated = value(
    await s.settings.startSetup(s.actors.admin, s.ids.elm, request),
  );
  expect(repeated.status).toBe("verified");
  expect(s.provider.creates).toBe(1);
  const savedSetup = await pool.query(
    "select * from billing_payment_setups where id=$1",
    [pending.setupId],
  );
  let refreshRetrievals = 0;
  s.provider.beforeRetrieve = async () => {
    refreshRetrievals++;
  };
  s.provider.wrongOwner = true;
  const refreshes = await Promise.all([
    s.settings.refreshSetup(s.actors.admin, s.ids.elm, pending.setupId),
    s.settings.refreshSetup(s.actors.admin, s.ids.elm, pending.setupId),
  ]);
  expect(refreshes.map((result) => value(result))).toEqual([
    repeated,
    repeated,
  ]);
  expect(refreshRetrievals).toBe(0);
  expect(
    (
      await pool.query("select * from billing_payment_setups where id=$1", [
        pending.setupId,
      ])
    ).rows,
  ).toEqual(savedSetup.rows);
  s.provider.beforeRetrieve = null;
  s.provider.wrongOwner = false;
  const view = value(
    await s.settings.getPaymentSettings(s.actors.admin, s.ids.elm),
  );
  expect(view.methods).toHaveLength(1);
  expect(view.enrollment).toBeNull();
  await s.settings.assertSyntheticData();
  expect(
    (
      await db
        .select()
        .from(billingCustomers)
        .where(eq(billingCustomers.id, mappingId))
    )[0],
  ).toEqual(originalMapping);
  const deniedMapping = createPaymentSettings({
    ...s.options,
    allowMappingName: () => false,
  });
  expect(
    await deniedMapping.startSetup(s.actors.admin, s.ids.elm, setupInput()),
  ).toEqual({ ok: false, code: "conflict" });
  expect(await rejection(deniedMapping.assertSyntheticData())).toBeInstanceOf(
    Error,
  );
  const deniedProfile = createPaymentSettings({
    ...s.options,
    allowProfile: () => false,
  });
  expect(
    await deniedProfile.startSetup(s.actors.admin, s.ids.elm, setupInput()),
  ).toEqual({ ok: false, code: "invalid_request" });
  expect(await rejection(deniedProfile.assertSyntheticData())).toBeInstanceOf(
    Error,
  );
  const wrong = value(
    await s.settings.startSetup(s.actors.admin, s.ids.elm, setupInput()),
  );
  s.provider.complete(wrong.setupId);
  s.provider.wrongOwner = true;
  expect(
    value(
      await s.settings.refreshSetup(s.actors.admin, s.ids.elm, wrong.setupId),
    ).status,
  ).toBe("needs_review");
  expect(
    value(await s.settings.getPaymentSettings(s.actors.admin, s.ids.elm))
      .methods,
  ).toHaveLength(1);
  s.provider.wrongOwner = false;
  await s.settings.receiveSetupEvent({
    ...s.provider.ownership,
    eventId: "evt_definitive_completion",
    setupId: wrong.setupId,
    providerSessionId: s.provider.setups.get(wrong.setupId)!.providerSessionId,
  });
  expect(await s.settings.pendingSetups()).not.toContain(wrong.setupId);
  expect(await s.settings.processSetup(wrong.setupId)).toBe("needs_review");
  expect(
    value(
      await s.settings.refreshSetup(s.actors.admin, s.ids.elm, wrong.setupId),
    ).status,
  ).toBe("needs_review");
  const late = value(
    await s.settings.startSetup(s.actors.admin, s.ids.elm, setupInput()),
  );
  let retrievals = 0;
  s.provider.beforeRetrieve = async () => {
    retrievals++;
    throw new Error("Synthetic transient retrieval outage");
  };
  for (let hour = 13; hour <= 17; hour++) {
    s.setClock(`2030-01-01T${hour}:00:00Z`);
    expect(await s.settings.processSetup(late.setupId)).toBe(
      hour === 17 ? "needs_review" : "retry",
    );
  }
  expect(await s.settings.pendingSetups()).not.toContain(late.setupId);
  expect(await s.settings.processSetup(late.setupId)).toBe("needs_review");
  expect(retrievals).toBe(5);
  s.provider.complete(late.setupId);
  const completion = {
    ...s.provider.ownership,
    eventId: "evt_late_completion",
    setupId: late.setupId,
    providerSessionId: s.provider.setups.get(late.setupId)!.providerSessionId,
  };
  const creates = s.provider.creates;
  const restarted = createPaymentSettings(s.options);
  await restarted.receiveSetupEvent(completion);
  expect(await restarted.pendingSetups()).toContain(late.setupId);
  expect(await restarted.processSetup(late.setupId)).toBe("retry");
  await restarted.receiveSetupEvent(completion);
  expect(await restarted.pendingSetups()).not.toContain(late.setupId);
  expect(await restarted.processSetup(late.setupId)).toBe("retry");
  expect(retrievals).toBe(6);
  s.provider.beforeRetrieve = null;
  s.setClock("2030-01-01T17:01:00Z");
  expect(await restarted.processSetup(late.setupId)).toBe("complete");
  const completed = value(
    await restarted.getPaymentSettings(s.actors.admin, s.ids.elm),
  );
  expect(completed.methods).toHaveLength(2);
  expect(completed.enrollment).toBeNull();
  expect(s.provider.creates).toBe(creates);
  await restarted.assertSyntheticData();
  s.provider.loseCreate = true;
  const uncertain = value(
    await s.settings.startSetup(s.actors.admin, s.ids.elm, setupInput()),
  );
  s.provider.setups.delete(uncertain.setupId);
  s.setClock("2030-01-02T18:00:00Z");
  const count = s.provider.creates;
  expect(
    value(
      await s.settings.refreshSetup(
        s.actors.admin,
        s.ids.elm,
        uncertain.setupId,
      ),
    ).status,
  ).toBe("needs_review");
  expect(s.provider.creates).toBe(count);
});

test("enrollment applies explicit future revision scope and atomically rolls back arrangement and audit", async () => {
  const s = await setup(),
    method = await save(s),
    chosen = await add(s),
    untouched = await add(s),
    current = await add(s, { periodAnchorDate: "2030-01-01" });
  expect(
    await s.settings.replaceEnrollment(
      s.actors.admin,
      s.ids.elm,
      enrollmentInput(method, [current]),
    ),
  ).toEqual({ ok: false, code: "conflict" });
  const revised = value(
    await s.subscriptions.changeSubscription(
      s.actors.staff,
      s.ids.elm,
      chosen.id,
      {
        requestId: randomUUID(),
        expectedVersion: chosen.version,
        change: {
          kind: "terms",
          effectivePeriodIndex: 2,
          label: "Synthetic recurring support",
          amountMinor: 1800,
          paymentArrangement: "manual",
        },
      },
    ),
  ).subscription;
  const input = enrollmentInput(method, [revised]);
  const failingAudit: AuditWriter = {
    ...s.audit,
    append: async (tx, entry) => {
      if (entry.action === "payment_enrollment.changed")
        throw new Error("Synthetic audit unavailable");
      await s.audit.append(tx, entry);
    },
  };
  const failing = createPaymentSettings({ ...s.options, audit: failingAudit });
  expect(
    await rejection(
      failing.replaceEnrollment(s.actors.admin, s.ids.elm, input),
    ),
  ).toBeInstanceOf(Error);
  expect(
    value(
      await s.subscriptions.getSubscription(
        s.actors.staff,
        s.ids.elm,
        chosen.id,
      ),
    ).subscription.version,
  ).toBe(revised.version);
  expect(
    value(await s.settings.getPaymentSettings(s.actors.admin, s.ids.elm))
      .enrollment,
  ).toBeNull();
  const changed = value(
    await s.settings.replaceEnrollment(s.actors.admin, s.ids.elm, input),
  );
  expect(changed.enrollment.scopes[0]).toMatchObject({
    fromPeriodIndex: 0,
    untilPeriodIndex: 2,
    periodStart: "2030-01-02",
    dueDate: "2030-01-22",
  });
  const staffSettings = value(
    await s.settings.getPaymentSettings(s.actors.staff, s.ids.elm),
  );
  const customerSettings = value(
    await s.settings.getPaymentSettings(s.actors.admin, s.ids.elm),
  );
  expect({
    staffOrigin: staffSettings.consentAdministratorOrigin,
    customerOrigin: customerSettings.consentAdministratorOrigin,
    label: staffSettings.subscriptions.find((sub) => sub.id === chosen.id)
      ?.label,
  }).toEqual({
    staffOrigin: "unknown",
    customerOrigin: null,
    label: "Synthetic recurring support",
  });
  const updated = value(
    await s.subscriptions.getSubscription(s.actors.staff, s.ids.elm, chosen.id),
  ).subscription;
  expect(updated.version).toBe(revised.version + 1);
  expect(updated.paymentArrangement).toBe("automatic");
  expect(updated.upcomingChanges).toContainEqual(
    expect.objectContaining({
      kind: "commercial",
      effectivePeriodIndex: 2,
      amountMinor: 1800,
      paymentArrangement: "manual",
    }),
  );
  expect(
    value(
      await s.subscriptions.getSubscription(
        s.actors.staff,
        s.ids.elm,
        untouched.id,
      ),
    ).subscription.paymentArrangement,
  ).toBe("manual");
  expect(
    value(await s.settings.replaceEnrollment(s.actors.admin, s.ids.elm, input))
      .outcome,
  ).toBe("unchanged");
  expect(
    await s.settings.replaceEnrollment(s.actors.admin, s.ids.elm, {
      ...input,
      selections: [],
    }),
  ).toEqual({ ok: false, code: "invalid_request" });
  const foreign = await save(s, s.ids.birch, s.actors.foreign);
  expect(
    await s.settings.replaceEnrollment(
      s.actors.admin,
      s.ids.elm,
      enrollmentInput(foreign, [updated], 1),
    ),
  ).toEqual({ ok: false, code: "not_found" });
  s.setClock("2030-03-03T12:00:00Z");
  const later = value(
    await s.settings.getPaymentSettings(s.actors.admin, s.ids.elm),
  ).subscriptions.find((sub) => sub.id === chosen.id)!;
  expect(later.retainedScope).toMatchObject({
    label: "Synthetic recurring support",
    amountMinor: 1200,
    currency: "USD",
    intervalMonths: 1,
    fromPeriodIndex: 0,
    untilPeriodStart: "2030-03-02",
  });
  expect(
    value(
      await s.subscriptions.getSubscription(
        s.actors.staff,
        s.ids.elm,
        chosen.id,
      ),
    ).subscription.amountMinor,
  ).toBe(1800);
  expect(
    later.boundaries.some((boundary) => boundary.fromPeriodIndex === 0),
  ).toBe(false);
  const sameConsent = enrollmentInput(method, [updated], 1);
  const retainAll = {
    requestId: randomUUID(),
    expectedVersion: 1,
    retainSubscriptionIds: [chosen.id],
  };
  for (const result of await Promise.all([
    s.settings.replaceEnrollment(s.actors.admin, s.ids.elm, sameConsent),
    s.settings.reduceEnrollment(s.actors.admin, s.ids.elm, retainAll),
  ]))
    expect(value(result)).toEqual({
      outcome: "unchanged",
      enrollment: changed.enrollment,
    });
  expect(
    await s.settings.reduceEnrollment(s.actors.admin, s.ids.elm, {
      ...retainAll,
      retainSubscriptionIds: [],
    }),
  ).toEqual({ ok: false, code: "conflict" });
  expect(
    await s.settings.replaceEnrollment(s.actors.admin, s.ids.elm, {
      ...sameConsent,
      paymentMethodId: foreign,
    }),
  ).toEqual({ ok: false, code: "conflict" });
  expect(
    await s.settings.replaceEnrollment(s.actors.admin, s.ids.elm, {
      ...sameConsent,
      requestId: retainAll.requestId,
    }),
  ).toEqual({ ok: false, code: "conflict" });
  expect(
    await s.settings.startSetup(s.actors.admin, s.ids.elm, {
      ...setupInput(),
      requestId: retainAll.requestId,
    }),
  ).toEqual({ ok: false, code: "conflict" });
  expect(
    await s.settings.reduceEnrollment(s.actors.foreign, s.ids.birch, retainAll),
  ).toEqual({ ok: false, code: "conflict" });
  expect(
    await s.settings.reduceEnrollment(s.actors.ordinary, s.ids.elm, retainAll),
  ).toEqual({ ok: false, code: "forbidden" });
  expect(
    (
      await pool.query(
        "SELECT request_id FROM access_audit WHERE request_id = ANY($1::uuid[])",
        [[sameConsent.requestId, retainAll.requestId]],
      )
    ).rows,
  ).toHaveLength(0);
  expect(
    (
      await pool.query(
        "SELECT version FROM billing_enrollments ORDER BY version",
      )
    ).rows,
  ).toEqual([{ version: 1 }]);
  const reduced = value(
    await s.settings.reduceEnrollment(s.actors.admin, s.ids.elm, {
      requestId: randomUUID(),
      expectedVersion: 1,
      retainSubscriptionIds: [],
    }),
  );
  expect(reduced.enrollment.version).toBe(2);
  const restarted = createPaymentSettings(s.options);
  expect(
    value(
      await restarted.reduceEnrollment(s.actors.admin, s.ids.elm, retainAll),
    ),
  ).toEqual({ outcome: "unchanged", enrollment: changed.enrollment });
  expect(
    value(
      await restarted.replaceEnrollment(s.actors.admin, s.ids.elm, sameConsent),
    ),
  ).toEqual({ outcome: "unchanged", enrollment: changed.enrollment });
  expect(
    value(await restarted.getPaymentSettings(s.actors.admin, s.ids.elm))
      .enrollment,
  ).toEqual(reduced.enrollment);
  await restarted.assertSyntheticData();
});

test("sealing freezes every covered line and version replacement or local opt-out cannot rewrite old groups", async () => {
  const s = await setup();
  s.setClock("2030-01-01T08:00:00Z");
  const method = await save(s),
    paid = await add(s),
    free = await add(s, { amountMinor: 0, paymentArrangement: "automatic" }),
    manual = await add(s);
  const enrolled = value(
    await s.settings.replaceEnrollment(
      s.actors.admin,
      s.ids.elm,
      enrollmentInput(method, [paid, free]),
    ),
  ).enrollment;
  const all = await Promise.all(
    [paid, free, manual].map(
      async (sub) =>
        value(
          await s.subscriptions.getSubscription(
            s.actors.staff,
            s.ids.elm,
            sub.id,
          ),
        ).subscription,
    ),
  );
  value(
    await s.scheduled.configureSchedule(s.actors.staff, s.ids.elm, {
      requestId: randomUUID(),
      expectedVersion: 0,
      change: {
        kind: "activate",
        subscriptions: all.map((sub) => ({
          subscriptionId: sub.id,
          expectedVersion: sub.version,
          activationFromPeriodIndex: 0,
        })),
      },
    }),
  );
  s.setClock("2030-01-01T12:00:00Z");
  await Promise.all([
    s.scheduled.sweepScheduled(),
    s.scheduled.sweepScheduled(),
  ]);
  const sealed = (
    await pool.query(
      "SELECT id, payment_arrangement, enrollment_id, payment_method_id FROM billing_invoice_groups ORDER BY payment_arrangement",
    )
  ).rows;
  expect(sealed).toHaveLength(2);
  expect(
    sealed.find((g) => g.payment_arrangement === "automatic"),
  ).toMatchObject({ enrollment_id: enrolled.id, payment_method_id: method });
  expect(sealed.find((g) => g.payment_arrangement === "manual")).toMatchObject({
    enrollment_id: null,
    payment_method_id: null,
  });
  const sealedSettings = value(
    await s.settings.getPaymentSettings(s.actors.admin, s.ids.elm),
  );
  expect(sealedSettings.affectedInvoices).toHaveLength(1);
  expect(
    sealedSettings.subscriptions.find((sub) => sub.id === paid.id)
      ?.retainedScope,
  ).toMatchObject({
    fromPeriodIndex: 0,
    amountMinor: 1200,
    untilPeriodStart: null,
  });
  const replacement = await save(s),
    current = await Promise.all(
      [paid, free].map(
        async (sub) =>
          value(
            await s.subscriptions.getSubscription(
              s.actors.staff,
              s.ids.elm,
              sub.id,
            ),
          ).subscription,
      ),
    );
  const knownLocal = createPaymentSettings({ ...s.options, provider: null });
  expect(
    value(await knownLocal.getPaymentSettings(s.actors.admin, s.ids.elm))
      .setupAvailable,
  ).toBe(false);
  const next = value(
    await knownLocal.replaceEnrollment(
      s.actors.admin,
      s.ids.elm,
      enrollmentInput(replacement, current, 1),
    ),
  ).enrollment;
  expect(next.version).toBe(2);
  expect(next.scopes).toEqual(enrolled.scopes);
  expect(
    (
      await pool.query(
        "SELECT enrollment_id FROM billing_invoice_groups WHERE payment_arrangement='automatic'",
      )
    ).rows[0].enrollment_id,
  ).toBe(enrolled.id);
  const local = createPaymentSettings({
    ...s.options,
    provider: null,
    ensureCustomerReceipt: async () => {
      throw new Error("Opt-out must not depend on provider");
    },
  });
  s.setClock("2030-02-01T12:00:00Z");
  const outcomes = await Promise.all([
    local.reduceEnrollment(s.actors.admin, s.ids.elm, {
      requestId: randomUUID(),
      expectedVersion: 2,
      retainSubscriptionIds: [],
    }),
    s.scheduled.sweepScheduled(),
  ]);
  const reduced = value(outcomes[0]);
  expect(reduced.enrollment.scopes).toEqual([]);
  expect(reduced.enrollment.paymentMethodId).toBeNull();
  const nextGroup = (
    await pool.query(
      "SELECT enrollment_id FROM billing_invoice_groups WHERE payment_arrangement='automatic' AND due_date='2030-02-22'",
    )
  ).rows[0];
  expect(nextGroup).toBeDefined();
  expect([null, next.id]).toContain(nextGroup.enrollment_id);
  expect(
    value(await local.getPaymentSettings(s.actors.admin, s.ids.elm)).methods,
  ).toHaveLength(2);
  await local.assertSyntheticData();
  // Existing groups have no retroactive permission; a foreign method cannot be frozen onto an owned group.
  const foreign = await save(s, s.ids.birch, s.actors.foreign);
  expect(
    await rejection(
      pool.query(
        "UPDATE billing_invoice_groups SET payment_method_id=$1 WHERE enrollment_id=$2",
        [foreign, enrolled.id],
      ),
    ),
  ).toBeInstanceOf(Error);
});
