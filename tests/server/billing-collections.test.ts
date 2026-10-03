import { afterAll, beforeEach, expect, test } from "bun:test";
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
import { session, user, auditEntries } from "../../src/access/internal/schema";
import type { AuditWriter, HumanActor } from "../../src/access/types";
import { createCustomers, createCustomerRegistry } from "../../src/customers";
import type { Customers } from "../../src/customers/types";
import {
  createBilling,
  createPaymentSettings,
  createSubscriptions,
  createScheduledBilling,
  createInvoiceCollections,
  createInvoiceResolutions,
} from "../../src/billing";
import {
  SAVE_TERMS_VERSION,
  ENROLLMENT_TERMS_VERSION,
} from "../../src/billing/payment-settings-contract";
import {
  BillingProviderError,
  type PaymentSettingsProvider,
  type InvoiceCollectionProvider,
  type PaymentSetupIntent,
  type ProviderPaymentSetup,
  type ProviderSavedPaymentMethod,
  type InvoiceIntent,
  type CollectionPayRequest,
  type CollectionPayOutcome,
  type ProviderEffect,
} from "../../src/billing/provider";
import { billingPaymentAttempts } from "../../src/billing/internal/collection-schema";
import { assertSyntheticCollectionData } from "../../src/billing/internal/collection";
import { billingInvoiceGroups } from "../../src/billing/internal/scheduled-schema";
import { billingEnrollmentScopes } from "../../src/billing/internal/payment-scope-schema";
import { invoices } from "../../src/billing/internal/invoice-schema";
import { SyntheticBillingProvider } from "./billing-provider";
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL is required");
const pool = new Pool({
  connectionString: url,
  max: 6,
  application_name: "collection-pg",
});
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
function value<T>(r: { ok: true; value: T } | { ok: false; code: string }): T {
  if (!r.ok) throw new Error(r.code);
  return r.value;
}
class CollectionProvider
  extends SyntheticBillingProvider
  implements PaymentSettingsProvider, InvoiceCollectionProvider
{
  setupReceipts = new Map<string, ProviderPaymentSetup>();
  sends: Array<{ request: CollectionPayRequest; key: string }> = [];
  mode:
    | "paid"
    | "uncertain"
    | "lost_paid"
    | "processing"
    | "declined"
    | "action"
    | "competing" = "paid";
  detached = false;
  afterSendOutage = false;
  beforeSend: (() => Promise<void>) | null = null;
  beforeInspection: (() => Promise<void>) | null = null;
  beforeMethod: (() => Promise<void>) | null = null;
  async network() {
    const result = await pool.query(
      "select count(*)::int as n from pg_stat_activity where application_name='collection-pg' and state='idle in transaction'",
    );
    expect(result.rows[0].n).toBe(0);
  }
  async findSetup(intent: PaymentSetupIntent) {
    const result = this.setupReceipts.get(intent.setupId);
    return result
      ? { kind: "found" as const, value: structuredClone(result) }
      : { kind: "absent" as const };
  }
  async createSetup(intent: PaymentSetupIntent) {
    const receipt: ProviderPaymentSetup = {
      ...intent,
      livemode: false,
      providerSessionId: `cs_${intent.setupId}`,
      status: "complete",
      checkoutUrl: null,
      setupIntent: {
        providerSetupIntentId: `seti_${intent.setupId}`,
        deploymentKey: intent.deploymentKey,
        setupId: intent.setupId,
        providerCustomerId: intent.providerCustomerId,
        livemode: false,
        status: "succeeded",
        usage: "off_session",
        providerPaymentMethodId: `pm_${intent.setupId}`,
      },
    };
    this.setupReceipts.set(intent.setupId, receipt);
    return structuredClone(receipt);
  }
  async retrieveSetup(intent: PaymentSetupIntent) {
    return structuredClone(this.setupReceipts.get(intent.setupId)!);
  }
  async retrieveSavedMethod(
    intent: PaymentSetupIntent,
    id: string,
  ): Promise<ProviderSavedPaymentMethod> {
    await this.network();
    await this.beforeMethod?.();
    return {
      ...this.ownership,
      providerPaymentMethodId: id,
      providerCustomerId: this.detached ? null : intent.providerCustomerId,
      livemode: false,
      type: "card",
      card: { brand: "visa", last4: "4242", expiryMonth: 12, expiryYear: 2035 },
    };
  }
  async inspectCollection(intent: InvoiceIntent, id: string) {
    await this.network();
    await this.beforeInspection?.();
    return super.inspectCollection(intent, id);
  }
  paid(id: string, methodId: string) {
    const evidence = this.evidence(id),
      amount = evidence.remainingMinor;
    this.invoices.get(id)!.status = "paid";
    evidence.paidMinor += amount;
    evidence.remainingMinor = 0;
    evidence.collectionState = "idle";
    const prior = evidence.payments.find(
      (p) => p.paymentIntentId === `pi_${id}`,
    );
    const payment = {
      invoicePaymentId: `inpay_${id}`,
      paymentIntentId: `pi_${id}`,
      providerPaymentMethodId: methodId,
      status: "paid" as const,
      paidMinor: amount,
      intentState: "succeeded" as const,
      receivedMinor: amount,
      capturableMinor: 0,
    };
    if (prior) Object.assign(prior, payment);
    else evidence.payments.push(payment);
  }
  async payInvoice(
    _intent: InvoiceIntent,
    request: CollectionPayRequest,
    effect: ProviderEffect,
  ): Promise<CollectionPayOutcome> {
    await this.network();
    this.sends.push({
      request: structuredClone(request),
      key: effect.idempotencyKey,
    });
    await this.beforeSend?.();
    const id = request.providerInvoiceId,
      evidence = this.evidence(id);
    if (this.mode === "uncertain")
      throw new BillingProviderError("retryable", "retry_exhausted");
    if (
      this.mode === "paid" ||
      this.mode === "lost_paid" ||
      this.mode === "competing"
    )
      this.paid(
        id,
        this.mode === "competing"
          ? "pm_hosted_competitor"
          : request.providerPaymentMethodId,
      );
    if (this.mode === "processing" || this.mode === "action") {
      evidence.collectionState = "active";
      evidence.payments = [
        {
          invoicePaymentId: `inpay_${id}`,
          paymentIntentId: `pi_${id}`,
          providerPaymentMethodId: request.providerPaymentMethodId,
          status: "open",
          paidMinor: null,
          intentState:
            this.mode === "processing" ? "processing" : "requires_action",
          receivedMinor: 0,
          capturableMinor: 0,
        },
      ];
    }
    if (this.afterSendOutage)
      this.collectionError = new BillingProviderError(
        "retryable",
        "retry_exhausted",
      );
    if (this.mode === "lost_paid")
      throw new BillingProviderError("retryable", "retry_exhausted");
    if (this.mode === "declined" || this.mode === "action")
      return {
        kind: this.mode === "declined" ? "declined" : "requires_action",
        paymentIntentId: this.mode === "action" ? `pi_${id}` : null,
      };
    return {
      kind: "response",
      receipt: {
        ...this.ownership,
        invoiceId: _intent.invoiceId,
        providerInvoiceId: id,
        providerCustomerId: _intent.providerCustomerId,
        status: this.invoices.get(id)!.status,
        payment:
          this.mode === "competing"
            ? null
            : {
                invoicePaymentId: `inpay_${id}`,
                paymentIntentId: `pi_${id}`,
                providerPaymentMethodId: request.providerPaymentMethodId,
              },
      },
    };
  }
}
async function setup() {
  const audit = createAuditWriter(),
    provider = new CollectionProvider(),
    suffix = randomUUID();
  const names = { staff: `staff_${suffix}`, admin: `admin_${suffix}` };
  const registry = createCustomerRegistry({
    audit,
    operatorId: "collection-test",
    allowProfile: (p) =>
      p.legalName === "Elm (sample)" && p.billingEmail === null,
  });
  const actors: Record<string, HumanActor> = {};
  const customerId = await db.transaction(async (tx) => {
    await bootstrapSyntheticAccess(tx, {
      operatorId: `collection-test-${suffix}`,
      allowedEmails: Object.values(names).map((id) => `${id}@collection.test`),
      users: Object.entries(names).map(([role, id]) => ({
        id,
        name: "Test operator",
        email: `${id}@collection.test`,
        staffRoles: role === "staff" ? ["billing"] : [],
      })),
      organizations: [
        {
          id: suffix,
          name: "Elm (sample)",
          slug: `elm-${suffix}`,
          members: [{ userId: names.admin, role: "administrator" }],
        },
      ],
    });
    const customer = await registry.ensureCustomer(tx, {
      registryKey: JSON.stringify(["collection-test", suffix]),
      organizationId: suffix,
      initialProfile: {
        legalName: "Elm (sample)",
        displayName: "Elm (sample)",
        billingEmail: null,
      },
    });
    for (const [role, id] of Object.entries(names)) {
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
      actors[role] = { userId: id, sessionId };
    }
    return customer.customerId;
  });
  let customers: Customers;
  const access = createAccess({
    pool,
    lockPool,
    authentication: {
      getSession: async () => null,
      acceptInvitation: async () => {
        throw new Error("Unused");
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
      p.legalName === "Elm (sample)" && p.billingEmail === null,
    providerProfile: async () => "not_linked",
  });
  let business = new Date("2030-01-01T08:00:00Z"),
    wall = new Date("2030-01-01T08:00:00Z");
  const deploymentKey = provider.ownership.deploymentKey;
  const allowSubscription = (s: {
    customerId: string;
    label: string;
    amountMinor: number;
  }) =>
    s.customerId === customerId &&
    s.label === "Synthetic recurring support" &&
    [0, 1200].includes(s.amountMinor);
  const settings = createPaymentSettings({
    pool,
    deploymentKey,
    providerOwnership: provider.ownership,
    provider,
    customerAccess: customers,
    audit,
    allowProfile: (p) =>
      p.legalName === "Elm (sample)" && p.billingEmail === null,
    allowMappingName: (id, name) =>
      id === customerId && name === "Elm (sample)",
    allowSubscription,
    successUrl: "http://localhost:4321/payment-settings/return",
    cancelUrl: "http://localhost:4321/payment-settings/return",
    now: () => wall,
    ensureCustomerReceipt: async (connection, id) => {
      const receipt = await provider.createCustomer({
        ...provider.ownership,
        customerId: id,
        name: "Elm (sample)",
      });
      await connection.execute(
        sql`update billing_customers set provider_customer_id=${receipt.providerCustomerId},create_attempted_at=${wall.toISOString()}::timestamptz where id=${id}`,
      );
      return receipt.providerCustomerId;
    },
  });
  const subscriptions = createSubscriptions({
    pool,
    deploymentKey,
    authorizeCustomer: (...args) => customers.authorizeCustomer(...args),
    audit,
    calendar: { timeZone: "UTC", issueHour: 9, chargeHour: 9 },
    allowSubscription,
    now: () => business,
  });
  const scheduled = createScheduledBilling({
    pool,
    deploymentKey,
    providerOwnership: provider.ownership,
    customerAccess: customers,
    audit,
    workerId: "collection-test",
    allowSubscription,
    allowRequest: (r) =>
      r.request.lines.every(
        (l) => l.description === "Synthetic recurring support",
      ),
    now: () => business,
  });
  const saved = value(
    await settings.startSetup(actors.admin, customerId, {
      requestId: randomUUID(),
      saveTermsVersion: SAVE_TERMS_VERSION,
      acceptSaveTerms: true,
    }),
  );
  const methodId = value(
    await settings.refreshSetup(actors.admin, customerId, saved.setupId),
  ).paymentMethodId!;
  const subs = [];
  for (const [amountMinor, paymentArrangement] of [
    [1200, "automatic"],
    [0, "automatic"],
    [1200, "manual"],
  ] as const)
    subs.push(
      value(
        await subscriptions.createSubscription(actors.staff, customerId, {
          requestId: randomUUID(),
          serviceId: null,
          periodAnchorDate: "2030-01-02",
          dueAnchorDate: "2030-01-22",
          intervalMonths: 1,
          firstUnbilledPeriodIndex: 0,
          label: "Synthetic recurring support",
          amountMinor,
          paymentArrangement,
        }),
      ).subscription,
    );
  const enrollment = value(
    await settings.replaceEnrollment(actors.admin, customerId, {
      requestId: randomUUID(),
      expectedVersion: 0,
      paymentMethodId: methodId,
      termsVersion: ENROLLMENT_TERMS_VERSION,
      acceptTerms: true,
      selections: subs.slice(0, 2).map((s) => ({
        subscriptionId: s.id,
        expectedSubscriptionVersion: s.version,
        fromPeriodIndex: 0,
      })),
    }),
  ).enrollment;
  value(
    await scheduled.configureSchedule(actors.staff, customerId, {
      requestId: randomUUID(),
      expectedVersion: 0,
      change: {
        kind: "activate",
        subscriptions: subs.map((s) => ({
          subscriptionId: s.id,
          expectedVersion: s.version,
          activationFromPeriodIndex: 0,
        })),
      },
    }),
  );
  business = new Date("2030-01-01T12:00:00Z");
  wall = new Date(business);
  await scheduled.sweepScheduled();
  const linked = await db
    .select()
    .from(billingInvoiceGroups)
    .where(eq(billingInvoiceGroups.customerId, customerId));
  const invoiceId = linked.find(
    (g) => g.paymentArrangement === "automatic",
  )!.invoiceId!;
  const manualId = linked.find(
    (g) => g.paymentArrangement === "manual",
  )!.invoiceId!;
  const billing = createBilling({
    pool,
    deploymentKey,
    provider,
    resolutionProvider: provider,
    customers: registry,
    now: () => wall,
  });
  expect(await billing.issueInvoice(invoiceId)).toBe("complete");
  expect(await billing.issueInvoice(manualId)).toBe("complete");
  const options = {
    pool,
    deploymentKey,
    provider,
    audit,
    workerId: "collection-test",
    businessNow: () => business,
    wallNow: () => wall,
  };
  const collections = createInvoiceCollections(options);
  const resolutions = createInvoiceResolutions({
    pool,
    deploymentKey,
    resolutionProvider: provider,
    customerAccess: customers,
    audit,
    workerId: "collection-test",
    allowResolution: () => true,
    now: () => wall,
  });
  business = new Date("2030-01-22T09:00:00Z");
  wall = new Date(business);
  return {
    customerId,
    actors,
    provider,
    collections,
    options,
    resolutions,
    settings,
    billing,
    invoiceId,
    manualId,
    enrollment,
    freeId: subs[1].id,
    setBusiness: (s: string) => {
      business = new Date(s);
    },
    setWall: (s: string) => {
      wall = new Date(s);
    },
    advance: (ms: number) => {
      wall = new Date(wall.getTime() + ms);
      business = new Date(business.getTime() + ms);
    },
    stop: () =>
      settings.reduceEnrollment(actors.admin, customerId, {
        requestId: randomUUID(),
        expectedVersion: 1,
        retainSubscriptionIds: [],
      }),
  };
}
async function attempt(invoiceId: string) {
  return (
    await db
      .select()
      .from(billingPaymentAttempts)
      .where(eq(billingPaymentAttempts.invoiceId, invoiceId))
  )[0];
}
const receipt = () => ({
  requestId: randomUUID(),
  amountMinor: 1200,
  receivedDate: "2030-01-22",
  method: "zelle" as const,
  reference: "Synthetic receipt",
});

test("collection eligibility binds due window, every frozen line and current owned consent", async () => {
  const s = await setup();
  s.setBusiness("2030-01-22T08:59:59Z");
  s.setWall("2030-01-22T08:59:59Z");
  expect(await s.collections.collectDueInvoice(s.invoiceId)).toBe("complete");
  expect(
    (await s.collections.getCollectionDisposition(s.invoiceId))?.disposition,
  ).toEqual({ kind: "payable", reason: "before_charge" });
  expect(await s.collections.collectDueInvoice(s.manualId)).toBe("complete");
  expect(await s.collections.collectDueInvoice(randomUUID())).toBe("complete");
  expect(s.provider.sends).toHaveLength(0);
  s.setWall("2030-01-22T23:59:59Z");
  s.provider.collectionError = new BillingProviderError(
    "retryable",
    "retry_exhausted",
  );
  await s.collections.collectDueInvoice(s.invoiceId);
  expect(
    (
      await db
        .select()
        .from(billingInvoiceGroups)
        .where(eq(billingInvoiceGroups.invoiceId, s.invoiceId))
    )[0].collectionMissedAt,
  ).not.toBeNull();
  s.provider.collectionError = null;
  expect(
    (await s.collections.getCollectionDisposition(s.invoiceId))?.disposition,
  ).toEqual({ kind: "payable", reason: "missed" });
  s.setWall("2030-01-22T10:00:00Z");
  s.setBusiness("2030-01-22T10:00:00Z");
  await s.collections.collectDueInvoice(s.invoiceId);
  expect(await attempt(s.invoiceId)).toBeUndefined();
  for (const change of [
    "scope",
    "stop",
    "detached",
    "receipt",
    "paid",
  ] as const) {
    const f = await setup();
    if (change === "scope")
      await db
        .delete(billingEnrollmentScopes)
        .where(eq(billingEnrollmentScopes.subscriptionId, f.freeId));
    if (change === "stop") value(await f.stop());
    if (change === "detached") f.provider.detached = true;
    if (change === "receipt")
      value(
        await f.resolutions.recordExternalPayment(
          f.actors.staff,
          f.customerId,
          f.invoiceId,
          receipt(),
        ),
      );
    if (change === "paid")
      f.provider.paid(`in_${f.invoiceId}`, "pm_early_hosted");
    await f.collections.collectDueInvoice(f.invoiceId);
    expect(f.provider.sends).toHaveLength(0);
    expect(await attempt(f.invoiceId)).toBeUndefined();
    if (change === "detached")
      expect(
        (await f.collections.getCollectionDisposition(f.invoiceId))
          ?.disposition,
      ).toEqual({ kind: "payable", reason: "not_authorized" });
  }

  const deferred = await setup();
  deferred.provider.detached = true;
  let methodReads = 0;
  deferred.provider.beforeMethod = async () => {
    methodReads++;
  };
  await deferred.collections.collectDueInvoice(deferred.invoiceId);
  const inspections = deferred.provider.calls.inspect;
  const restarted = createInvoiceCollections(deferred.options);
  deferred.advance(5000);
  expect((await restarted.pendingCollections()).invoiceIds).not.toContain(
    deferred.invoiceId,
  );
  await restarted.collectDueInvoice(deferred.invoiceId);
  expect(deferred.provider.calls.inspect).toBe(inspections);
  expect(methodReads).toBe(1);
  deferred.advance(55000);
  // A fresh read, including a reminder's inspection, must not restart worker backoff.
  await restarted.getCollectionDisposition(deferred.invoiceId, {
    explicitCheck: true,
    canManageBilling: true,
  });
  expect((await restarted.pendingCollections()).invoiceIds).toContain(
    deferred.invoiceId,
  );
  await restarted.collectDueInvoice(deferred.invoiceId);
  expect(deferred.provider.calls.inspect).toBe(inspections + 2);
  deferred.advance(6000);
  expect(
    (
      await restarted.getCollectionDisposition(deferred.invoiceId, {
        explicitCheck: true,
        canManageBilling: true,
      })
    )?.disposition,
  ).toEqual({ kind: "payable", reason: "not_authorized" });
  expect(deferred.provider.calls.inspect).toBe(inspections + 3);
  deferred.setBusiness("2030-01-22T23:59:45Z");
  deferred.setWall("2030-01-22T23:59:45Z");
  await restarted.collectDueInvoice(deferred.invoiceId);
  deferred.advance(14000);
  expect((await restarted.pendingCollections()).invoiceIds).toContain(
    deferred.invoiceId,
  );
  await restarted.collectDueInvoice(deferred.invoiceId);
  expect(
    (
      await db
        .select()
        .from(billingInvoiceGroups)
        .where(eq(billingInvoiceGroups.invoiceId, deferred.invoiceId))
    )[0].collectionMissedAt,
  ).not.toBeNull();
  expect(await attempt(deferred.invoiceId)).toBeUndefined();
  expect(deferred.provider.sends).toHaveLength(0);
});

test("duplicate jobs converge, audit rollback precedes dispatch and cursor scan reaches later pages", async () => {
  const offline = { pool, deploymentKey: "billing-test" };
  await assertSyntheticCollectionData(offline);
  const s = await setup();
  const missingGroupIdentity = await assertSyntheticCollectionData(
    offline,
  ).then(
    () => false,
    () => true,
  );
  const failAudit: AuditWriter = {
    ...s.options.audit,
    recordOperator: async (tx, entry) => {
      if (entry.action === "invoice.collection_attempted")
        throw new Error("Synthetic audit failure");
      await s.options.audit.recordOperator(tx, entry);
    },
  };
  const error = await createInvoiceCollections({
    ...s.options,
    audit: failAudit,
  })
    .collectDueInvoice(s.invoiceId)
    .then(
      () => null,
      (error: unknown) => error,
    );
  expect(error).toBeInstanceOf(Error);
  expect(await attempt(s.invoiceId)).toBeUndefined();
  expect(s.provider.sends).toHaveLength(0);
  s.provider.evidence(`in_${s.invoiceId}`).payments = [
    {
      invoicePaymentId: `inpay_in_${s.invoiceId}`,
      paymentIntentId: `pi_in_${s.invoiceId}`,
      providerPaymentMethodId: null,
      status: "open",
      paidMinor: null,
      intentState: "requires_payment_method",
      receivedMinor: 0,
      capturableMinor: 0,
    },
  ];
  s.advance(60000);
  await Promise.all([
    s.collections.collectDueInvoice(s.invoiceId),
    s.collections.collectDueInvoice(s.invoiceId),
  ]);
  expect(s.provider.sends).toHaveLength(1);
  expect((await attempt(s.invoiceId)).state).toBe("succeeded");
  const first = await setup(),
    second = await setup(),
    third = await setup();
  const seen: string[] = [];
  let page = await first.collections.pendingCollections({ limit: 1 });
  while (true) {
    seen.push(...page.invoiceIds);
    if (!page.next) break;
    page = await first.collections.pendingCollections({
      limit: 1,
      after: page.next,
      through: page.through,
    });
  }
  expect(seen).toEqual(
    expect.arrayContaining([
      first.invoiceId,
      second.invoiceId,
      third.invoiceId,
    ]),
  );
  expect(new Set(seen).size).toBe(seen.length);
  expect(seen).not.toContain(s.invoiceId);
  const audits = await db
    .select()
    .from(auditEntries)
    .where(eq(auditEntries.targetId, (await attempt(s.invoiceId)).id));
  expect(
    audits.filter((a) => a.action === "invoice.collection_attempted"),
  ).toHaveLength(1);
  await s.collections.assertSyntheticData();
  const ownedOffline = {
    ...offline,
    accountId: s.provider.ownership.accountId,
  };
  await assertSyntheticCollectionData(ownedOffline);
  const original = await attempt(s.invoiceId);
  await db
    .update(billingPaymentAttempts)
    .set({ requestDigest: "0".repeat(64) })
    .where(eq(billingPaymentAttempts.id, original.id));
  try {
    const missingAttemptIdentity = await assertSyntheticCollectionData(
      offline,
    ).then(
      () => false,
      () => true,
    );
    const corruptedIntent = await assertSyntheticCollectionData(
      ownedOffline,
    ).then(
      () => false,
      () => true,
    );
    expect({
      missingGroupIdentity,
      missingAttemptIdentity,
      corruptedIntent,
    }).toEqual({
      missingGroupIdentity: true,
      missingAttemptIdentity: true,
      corruptedIntent: true,
    });
  } finally {
    await db
      .update(billingPaymentAttempts)
      .set({ requestDigest: original.requestDigest })
      .where(eq(billingPaymentAttempts.id, original.id));
  }
});

test("lost response recovery retains request and key with five dispatch and wall lifetime limits", async () => {
  const s = await setup();
  s.provider.mode = "uncertain";
  expect(await s.collections.collectDueInvoice(s.invoiceId)).toBe("retry");
  const original = await attempt(s.invoiceId),
    restarted = createInvoiceCollections(s.options);
  expect(await restarted.collectDueInvoice(s.invoiceId)).toBe("retry");
  expect(s.provider.sends).toHaveLength(1);
  s.advance(5000);
  s.provider.mode = "paid";
  expect(await restarted.collectDueInvoice(s.invoiceId)).toBe("complete");
  expect(s.provider.sends[1]).toEqual(s.provider.sends[0]);
  expect((await attempt(s.invoiceId)).id).toBe(original.id);
  expect((await attempt(s.invoiceId)).state).toBe("succeeded");
  const exhausted = await setup();
  exhausted.provider.mode = "uncertain";
  for (const delay of [0, 5000, 30000, 120000, 600000]) {
    exhausted.advance(delay);
    await exhausted.collections.collectDueInvoice(exhausted.invoiceId);
  }
  expect(exhausted.provider.sends).toHaveLength(5);
  expect((await attempt(exhausted.invoiceId)).state).toBe("needs_review");
  const expired = await setup();
  expired.provider.mode = "uncertain";
  await expired.collections.collectDueInvoice(expired.invoiceId);
  expired.setWall("2030-01-23T08:00:00Z");
  await expired.collections.collectDueInvoice(expired.invoiceId);
  expect(expired.provider.sends).toHaveLength(1);
  expect((await attempt(expired.invoiceId)).state).toBe("needs_review");
  const lost = await setup();
  lost.provider.mode = "lost_paid";
  await lost.collections.collectDueInvoice(lost.invoiceId);
  expect((await attempt(lost.invoiceId)).state).toBe("needs_review");
  expect(
    (await lost.collections.getCollectionDisposition(lost.invoiceId))
      ?.disposition,
  ).toEqual({ kind: "suppress", reason: "paid" });
  expect(lost.provider.sends).toHaveLength(1);
  const outage = await setup();
  outage.provider.mode = "uncertain";
  await outage.collections.collectDueInvoice(outage.invoiceId);
  outage.provider.collectionError = new BillingProviderError(
    "retryable",
    "retry_exhausted",
  );
  for (let count = 0; count < 5; count++) {
    outage.advance(30000);
    await outage.collections.collectDueInvoice(outage.invoiceId);
  }
  expect((await attempt(outage.invoiceId)).reason).toBe("provider_unavailable");
  expect(outage.provider.sends).toHaveLength(1);
});

test("processing and definitive card results consume dispatch while disposition requires fresh owned evidence", async () => {
  const uncorrelated = await setup();
  uncorrelated.provider.mode = "processing";
  let observations = 0;
  uncorrelated.provider.beforeInspection = async () => {
    if (++observations === 2) {
      const evidence = uncorrelated.provider.evidence(
        `in_${uncorrelated.invoiceId}`,
      );
      evidence.collectionState = "idle";
      evidence.payments = [];
    }
  };
  expect(
    await uncorrelated.collections.collectDueInvoice(uncorrelated.invoiceId),
  ).toBe("retry");
  expect(await attempt(uncorrelated.invoiceId)).toMatchObject({
    state: "pending",
    responseKind: "response",
  });
  expect(
    new Date(
      (await attempt(uncorrelated.invoiceId)).nextAttemptAt!,
    ).toISOString(),
  ).toBe("2030-01-22T09:00:30.000Z");
  uncorrelated.advance(5000);
  expect(
    (await uncorrelated.collections.pendingCollections()).invoiceIds,
  ).not.toContain(uncorrelated.invoiceId);
  await uncorrelated.collections.collectDueInvoice(uncorrelated.invoiceId);
  expect(observations).toBe(2);
  uncorrelated.advance(25000);
  expect(
    (await uncorrelated.collections.pendingCollections()).invoiceIds,
  ).toContain(uncorrelated.invoiceId);
  await uncorrelated.collections.collectDueInvoice(uncorrelated.invoiceId);
  expect(observations).toBe(3);
  expect(
    new Date(
      (await attempt(uncorrelated.invoiceId)).nextAttemptAt!,
    ).toISOString(),
  ).toBe("2030-01-22T09:01:00.000Z");
  uncorrelated.setWall("2030-01-23T08:00:00Z");
  await uncorrelated.collections.collectDueInvoice(uncorrelated.invoiceId);
  expect((await attempt(uncorrelated.invoiceId)).state).toBe("needs_review");
  expect(uncorrelated.provider.sends).toHaveLength(1);

  for (const mode of ["processing", "declined", "action"] as const) {
    const s = await setup();
    s.provider.mode = mode;
    s.provider.afterSendOutage = mode !== "processing";
    await s.collections.collectDueInvoice(s.invoiceId);
    expect((await attempt(s.invoiceId)).state).toBe(
      mode === "declined"
        ? "failed"
        : mode === "action"
          ? "requires_action"
          : "processing",
    );
    s.advance(60000);
    await s.collections.collectDueInvoice(s.invoiceId);
    expect(s.provider.sends).toHaveLength(1);
    s.provider.collectionError = null;
    const projected = await s.collections.getCollectionDisposition(s.invoiceId);
    expect(projected?.disposition).toEqual(
      mode === "processing"
        ? { kind: "defer", reason: "processing" }
        : {
            kind: "payable",
            reason: mode === "action" ? "requires_action" : "declined",
          },
    );
    if (mode === "processing") {
      const evidence = s.provider.evidence(`in_${s.invoiceId}`);
      evidence.collectionState = "idle";
      evidence.payments = [];
      s.advance(30000);
      await s.collections.collectDueInvoice(s.invoiceId);
      expect((await attempt(s.invoiceId)).state).toBe("processing");
      expect(s.provider.sends).toHaveLength(1);
    }
    if (mode === "action") {
      s.provider.evidence(`in_${s.invoiceId}`).payments.push({
        invoicePaymentId: "inpay_competing",
        paymentIntentId: "pi_competing",
        providerPaymentMethodId: "pm_other",
        status: "open",
        paidMinor: null,
        intentState: "processing",
        receivedMinor: 0,
        capturableMinor: 0,
      });
      expect(
        (await s.collections.getCollectionDisposition(s.invoiceId))?.disposition
          .kind,
      ).toBe("defer");
    }
  }
  const delayed = await setup();
  delayed.provider.mode = "processing";
  await delayed.collections.collectDueInvoice(delayed.invoiceId);
  const delayedAttempt = await attempt(delayed.invoiceId);
  expect(delayedAttempt.responsePaymentIntentId).toBe(
    `pi_in_${delayed.invoiceId}`,
  );
  delayed.provider.paid(
    `in_${delayed.invoiceId}`,
    delayedAttempt.request.providerPaymentMethodId,
  );
  await delayed.collections.reconcileCollection(delayed.invoiceId);
  expect(await attempt(delayed.invoiceId)).toMatchObject({
    state: "succeeded",
    attributedInvoicePaymentId: delayedAttempt.responseInvoicePaymentId,
    attributedPaymentIntentId: delayedAttempt.responsePaymentIntentId,
  });

  const competing = await setup();
  competing.provider.mode = "processing";
  await competing.collections.collectDueInvoice(competing.invoiceId);
  const captured = await attempt(competing.invoiceId);
  const evidence = competing.provider.evidence(`in_${competing.invoiceId}`);
  const original = evidence.payments[0];
  original.intentState = "canceled";
  original.status = "canceled";
  evidence.payments.push({
    ...original,
    invoicePaymentId: "inpay_hosted_other",
    paymentIntentId: "pi_hosted_other",
    status: "paid",
    intentState: "succeeded",
    paidMinor: 1200,
    receivedMinor: 1200,
  });
  evidence.remainingMinor = 0;
  evidence.paidMinor = 1200;
  evidence.collectionState = "idle";
  competing.provider.invoices.get(`in_${competing.invoiceId}`)!.status = "paid";
  await competing.collections.reconcileCollection(competing.invoiceId);
  expect((await attempt(competing.invoiceId)).state).toBe("needs_review");
  expect(
    (await competing.collections.getCollectionDisposition(competing.invoiceId))
      ?.disposition,
  ).toEqual({ kind: "suppress", reason: "paid" });
  expect(
    (
      await db
        .select()
        .from(auditEntries)
        .where(eq(auditEntries.targetId, captured.id))
    ).some((entry) => entry.action === "invoice.collection_succeeded"),
  ).toBe(false);

  const interruptedRead = await setup();
  interruptedRead.provider.afterSendOutage = true;
  await interruptedRead.collections.collectDueInvoice(
    interruptedRead.invoiceId,
  );
  expect(await attempt(interruptedRead.invoiceId)).toMatchObject({
    responseKind: "response",
    responseInvoiceStatus: "paid",
    responseInvoicePaymentId: `inpay_in_${interruptedRead.invoiceId}`,
    responsePaymentIntentId: `pi_in_${interruptedRead.invoiceId}`,
  });
  interruptedRead.provider.collectionError = null;
  await interruptedRead.collections.reconcileCollection(
    interruptedRead.invoiceId,
  );
  expect((await attempt(interruptedRead.invoiceId)).state).toBe("succeeded");
  expect(interruptedRead.provider.sends).toHaveLength(1);

  const slow = await setup();
  slow.setBusiness("2030-01-22T08:00:00Z");
  slow.provider.beforeInspection = async () => slow.advance(6000);
  expect(
    (await slow.collections.getCollectionDisposition(slow.invoiceId))
      ?.disposition,
  ).toEqual({ kind: "defer", reason: "stale" });
  slow.setBusiness("2030-01-22T10:00:00Z");
  expect(await slow.collections.collectDueInvoice(slow.invoiceId)).toBe(
    "retry",
  );
  expect(slow.provider.sends).toHaveLength(0);
});

test("revocation and collection reservations serialize; P6 preserves money facts and holds conflicting effects", async () => {
  const revoked = await setup();
  revoked.provider.beforeMethod = async () => {
    revoked.provider.beforeMethod = null;
    value(await revoked.stop());
  };
  await revoked.collections.collectDueInvoice(revoked.invoiceId);
  expect(revoked.provider.sends).toHaveLength(0);
  const stalled = await setup();
  const stallAudit: AuditWriter = {
    ...stalled.options.audit,
    recordOperator: async (tx, entry) => {
      await stalled.options.audit.recordOperator(tx, entry);
      if (entry.action === "invoice.collection_attempted")
        stalled.advance(6000);
    },
  };
  await createInvoiceCollections({
    ...stalled.options,
    audit: stallAudit,
  }).collectDueInvoice(stalled.invoiceId);
  expect(stalled.provider.sends).toHaveLength(0);
  expect((await attempt(stalled.invoiceId)).state).toBe("needs_review");
  const stoppedRecovery = await setup();
  stoppedRecovery.provider.mode = "uncertain";
  await stoppedRecovery.collections.collectDueInvoice(
    stoppedRecovery.invoiceId,
  );
  value(await stoppedRecovery.stop());
  stoppedRecovery.advance(5000);
  await stoppedRecovery.collections.collectDueInvoice(
    stoppedRecovery.invoiceId,
  );
  expect(stoppedRecovery.provider.sends).toHaveLength(1);
  expect((await attempt(stoppedRecovery.invoiceId)).reason).toBe(
    "consent_changed",
  );
  const stamped = await setup();
  stamped.provider.beforeSend = async () => {
    value(await stamped.stop());
  };
  await stamped.collections.collectDueInvoice(stamped.invoiceId);
  expect(stamped.provider.sends).toHaveLength(1);
  expect((await attempt(stamped.invoiceId)).state).toBe("succeeded");
  const pending = await setup();
  pending.provider.mode = "uncertain";
  await pending.collections.collectDueInvoice(pending.invoiceId);
  expect(
    await pending.resolutions.requestVoid(
      pending.actors.staff,
      pending.customerId,
      pending.invoiceId,
      { requestId: randomUUID(), reason: "Synthetic void" },
    ),
  ).toEqual({ ok: false, code: "conflict" });
  const recorded = value(
    await pending.resolutions.recordExternalPayment(
      pending.actors.staff,
      pending.customerId,
      pending.invoiceId,
      receipt(),
    ),
  ).resolution;
  expect(recorded.state).toBe("needs_review");
  expect(await pending.resolutions.processResolution(recorded.id)).toBe(
    "needs_review",
  );
  expect(
    await pending.resolutions.reconcileResolution(
      pending.actors.staff,
      pending.customerId,
      pending.invoiceId,
      { requestId: randomUUID() },
    ),
  ).toEqual({ ok: false, code: "conflict" });
  expect(pending.provider.calls.settle).toBe(0);
  expect(pending.provider.calls.void).toBe(0);
  pending.advance(5000);
  await pending.collections.collectDueInvoice(pending.invoiceId);
  expect(pending.provider.sends).toHaveLength(1);
  expect((await attempt(pending.invoiceId)).reason).toBe("resolution_conflict");
  const raced = await setup();
  raced.provider.mode = "competing";
  await raced.collections.collectDueInvoice(raced.invoiceId);
  expect((await attempt(raced.invoiceId)).state).toBe("needs_review");
  expect(
    (
      await db.select().from(invoices).where(eq(invoices.id, raced.invoiceId))
    )[0].providerStatus,
  ).toBe("paid");
});
