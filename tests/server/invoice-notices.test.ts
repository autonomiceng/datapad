import { createFinancialEffectGuard } from "../../src/billing";
import { resumeEffects } from "./effects-fixture";
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
import type { HumanActor } from "../../src/access/types";
import { createCustomers, createCustomerRegistry } from "../../src/customers";
import type { Customers } from "../../src/customers/types";
import { customers as customerTable } from "../../src/customers/internal/schema";
import {
  createBilling,
  createInvoiceNoticeBilling,
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
import { billingPaymentAttempts } from "../../src/billing/internal/collection-schema";
import { billingInvoiceGroups } from "../../src/billing/internal/scheduled-schema";
import type {
  PaymentSettingsProvider,
  ProviderPaymentSetup,
  InvoiceCollectionProvider,
} from "../../src/billing/provider";
import { BillingProviderError } from "../../src/billing/provider";
import { createInvoiceNotices } from "../../src/notifications";
import type { NoticeSmtp } from "../../src/notifications/types";
import { invoiceNotices } from "../../src/notifications/internal/schema";
import { SyntheticBillingProvider } from "./billing-provider";
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL is required");
const pool = new Pool({
  connectionString: url,
  max: 6,
  application_name: "notice-pg",
});
const lockPool = new Pool({ connectionString: url, max: 2 });
const db = drizzle(pool);
const clear = () =>
  pool.query(
    'TRUNCATE customers, "user", organization, verification, access_audit, access_commands CASCADE',
  );
beforeEach(async () => {
  await clear();
  await resumeEffects(pool, "billing-test");
});
afterAll(async () => {
  await clear();
  await Promise.all([pool.end(), lockPool.end()]);
});
function value<T>(r: { ok: true; value: T } | { ok: false; code: string }): T {
  if (!r.ok) throw new Error(r.code);
  return r.value;
}
async function setup() {
  const audit = createAuditWriter();
  const registry = createCustomerRegistry({
    operatorId: "notice-test",
    audit,
    allowProfile: () => true,
  });
  const actors: Record<string, HumanActor> = {};
  const customerId = await db.transaction(async (tx) => {
    await bootstrapSyntheticAccess(tx, {
      operatorId: "notice-test",
      allowedEmails: ["staff@notice.test", "member@notice.test"],
      users: [
        {
          id: "staff",
          name: "Staff",
          email: "staff@notice.test",
          staffRoles: ["billing"],
        },
        {
          id: "member",
          name: "Member",
          email: "member@notice.test",
          staffRoles: [],
        },
      ],
      organizations: [
        {
          id: "notice-org",
          name: "Notice sample",
          slug: "notice-sample",
          members: [{ userId: "member", role: "administrator" }],
        },
      ],
    });
    for (const id of ["staff", "member"]) {
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
    return (
      await registry.ensureCustomer(tx, {
        registryKey: JSON.stringify(["billing-test", "notice-customer"]),
        organizationId: "notice-org",
        initialProfile: {
          legalName: "Notice sample",
          displayName: "Notice sample",
          billingEmail: "billing@notice.test",
        },
      })
    ).customerId;
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
    allowProfile: () => true,
    providerProfile: async () => "not_linked",
  });
  const provider = new SyntheticBillingProvider();
  let wall = new Date("2030-01-01T12:00:00Z"),
    business = new Date(wall);
  let beforeInspect: (() => Promise<void>) | null = null;
  let providerReads = 0;
  const network = async () => {
    const result = await pool.query(
      "select count(*)::int as n from pg_stat_activity where application_name='notice-pg' and state='idle in transaction'",
    );
    expect(result.rows[0].n).toBe(0);
  };
  let detached = false,
    actionEnabled = false,
    paymentCalls = 0;
  const savedMethod: InvoiceCollectionProvider["retrieveSavedMethod"] = async (
    intent,
    id,
  ) => {
    providerReads++;
    return {
      ...provider.ownership,
      providerPaymentMethodId: id,
      providerCustomerId: detached ? null : intent.providerCustomerId,
      livemode: false,
      type: "card",
      card: { brand: "visa", last4: "4242", expiryMonth: 12, expiryYear: 2035 },
    };
  };
  const collectionProvider: InvoiceCollectionProvider = {
    ownership: provider.ownership,
    async inspectCollection(...args) {
      providerReads++;
      await network();
      await beforeInspect?.();
      return provider.inspectCollection(...args);
    },
    retrieveSavedMethod: savedMethod,
    async payInvoice(_intent, request) {
      if (!actionEnabled) throw new Error("Notices never charge");
      paymentCalls++;
      const evidence = provider.evidence(request.providerInvoiceId);
      evidence.collectionState = "active";
      evidence.payments = [
        {
          invoicePaymentId: `inpay_${request.providerInvoiceId}`,
          paymentIntentId: `pi_${request.providerInvoiceId}`,
          providerPaymentMethodId: request.providerPaymentMethodId,
          status: "open",
          paidMinor: null,
          intentState: "requires_action",
          receivedMinor: 0,
          capturableMinor: 0,
        },
      ];
      return {
        kind: "requires_action",
        paymentIntentId: `pi_${request.providerInvoiceId}`,
      };
    },
  };
  const options = {
    pool,
    deploymentKey: provider.ownership.deploymentKey,
    provider: collectionProvider,
    audit,
    workerId: "notice-test",
    wallNow: () => wall,
    businessNow: () => business,
  };
  const billing = createBilling({
    pool,
    deploymentKey: options.deploymentKey,
    provider,
    customers: registry,
    now: () => wall,
    businessNow: () => business,
  });
  const noticeBilling = createInvoiceNoticeBilling(options);
  const sent: Array<Parameters<NoticeSmtp["send"]>[0]> = [];
  let outcome: Awaited<ReturnType<NoticeSmtp["send"]>> = { kind: "accepted" };
  let afterSend: (() => Promise<void>) | null = null;
  let afterStamp: (() => Promise<void>) | null = null;
  const smtp: NoticeSmtp = {
    async send(message) {
      await network();
      sent.push(message);
      await afterSend?.();
      return outcome;
    },
  };
  const factory = (calendar = { timeZone: "America/Los_Angeles", hour: 9 }) =>
    createInvoiceNotices({
      financialEffectGuard: createFinancialEffectGuard(options.deploymentKey),
      pool,
      deploymentKey: options.deploymentKey,
      customerAccess: customers,
      billing: noticeBilling,
      billingReader: billing,
      smtp,
      audit: {
        ...audit,
        async recordOperator(tx, entry) {
          await audit.recordOperator(tx, entry);
          if (entry.action === "invoice.notice_attempted") await afterStamp?.();
        },
      },
      workerId: "notice-test",
      allowRecipient: (email) =>
        ["billing@notice.test", "new@notice.test"].includes(email),
      noticeCalendar: calendar,
      portalOrigin: "http://localhost:4321",
      wallNow: () => wall,
      businessNow: () => business,
    });
  const notices = factory();
  async function issue(dueDate = "2030-01-22") {
    const result = await billing.requestInvoice({
      originKey: randomUUID(),
      customer: { key: "notice-customer", name: "Notice sample" },
      issueDate: wall.toISOString().slice(0, 10),
      dueDate,
      currency: "USD",
      lines: [
        {
          description: "Synthetic support",
          amountMinor: 1200,
          originRef: null,
        },
      ],
    });
    if (result.kind !== "created") throw new Error("Invoice fixture failed");
    expect(await billing.requestIssue(result.invoiceId)).toEqual({
      kind: "accepted",
    });
    expect(await billing.issueInvoice(result.invoiceId)).toBe("complete");
    await notices.sweepNotices();
    return result.invoiceId;
  }
  async function automatic() {
    business = new Date("2030-01-01T08:00:00Z");
    const receipts = new Map<string, ProviderPaymentSetup>();
    const setupProvider: PaymentSettingsProvider = {
      ownership: provider.ownership,
      async findSetup(intent) {
        const receipt = receipts.get(intent.setupId);
        return receipt
          ? { kind: "found", value: structuredClone(receipt) }
          : { kind: "absent" };
      },
      async createSetup(intent) {
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
        receipts.set(intent.setupId, receipt);
        return structuredClone(receipt);
      },
      async retrieveSetup(intent) {
        return structuredClone(receipts.get(intent.setupId)!);
      },
      retrieveSavedMethod: savedMethod,
    };
    const deploymentKey = options.deploymentKey;
    const settings = createPaymentSettings({
      pool,
      deploymentKey,
      providerOwnership: provider.ownership,
      provider: setupProvider,
      customerAccess: customers,
      audit,
      allowProfile: () => true,
      allowMappingName: () => true,
      allowSubscription: () => true,
      successUrl: "http://localhost:4321/payment-settings/return",
      cancelUrl: "http://localhost:4321/payment-settings/return",
      now: () => wall,
      ensureCustomerReceipt: async (connection, id) => {
        const receipt = await provider.createCustomer({
          ...provider.ownership,
          customerId: id,
          name: "Notice sample",
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
      allowSubscription: () => true,
      now: () => business,
    });
    const scheduled = createScheduledBilling({
      pool,
      deploymentKey,
      providerOwnership: provider.ownership,
      customerAccess: customers,
      audit,
      workerId: "notice-test",
      allowSubscription: () => true,
      allowRequest: () => true,
      now: () => business,
    });
    const saved = value(
      await settings.startSetup(actors.member, customerId, {
        requestId: randomUUID(),
        saveTermsVersion: SAVE_TERMS_VERSION,
        acceptSaveTerms: true,
      }),
    );
    const methodId = value(
      await settings.refreshSetup(actors.member, customerId, saved.setupId),
    ).paymentMethodId!;
    const subscription = value(
      await subscriptions.createSubscription(actors.staff, customerId, {
        requestId: randomUUID(),
        serviceId: null,
        periodAnchorDate: "2030-01-02",
        dueAnchorDate: "2030-01-22",
        intervalMonths: 1,
        firstUnbilledPeriodIndex: 0,
        label: "Synthetic recurring support",
        amountMinor: 1200,
        paymentArrangement: "automatic",
      }),
    ).subscription;
    value(
      await settings.replaceEnrollment(actors.member, customerId, {
        requestId: randomUUID(),
        expectedVersion: 0,
        paymentMethodId: methodId,
        termsVersion: ENROLLMENT_TERMS_VERSION,
        acceptTerms: true,
        selections: [
          {
            subscriptionId: subscription.id,
            expectedSubscriptionVersion: subscription.version,
            fromPeriodIndex: 0,
          },
        ],
      }),
    );
    value(
      await scheduled.configureSchedule(actors.staff, customerId, {
        requestId: randomUUID(),
        expectedVersion: 0,
        change: {
          kind: "activate",
          subscriptions: [
            {
              subscriptionId: subscription.id,
              expectedVersion: subscription.version,
              activationFromPeriodIndex: 0,
            },
          ],
        },
      }),
    );
    business = new Date("2030-01-01T12:00:00Z");
    await scheduled.sweepScheduled();
    const [group] = await db
      .select()
      .from(billingInvoiceGroups)
      .where(eq(billingInvoiceGroups.customerId, customerId));
    expect(await billing.issueInvoice(group.invoiceId!)).toBe("complete");
    await notices.sweepNotices();
    return group.invoiceId!;
  }
  const rows = (id: string) =>
    db.select().from(invoiceNotices).where(eq(invoiceNotices.invoiceId, id));
  const stage = async (id: string, name: string) =>
    (await rows(id)).find((row) => row.stage === name)!;
  return {
    provider,
    providerReads: () => providerReads,
    afterStamp: (f: typeof afterStamp) => {
      afterStamp = f;
    },
    enableAction: () => {
      actionEnabled = true;
    },
    paymentCalls: () => paymentCalls,
    resolutions: createInvoiceResolutions({
      pool,
      deploymentKey: options.deploymentKey,
      resolutionProvider: provider,
      customerAccess: customers,
      audit,
      workerId: "notice-test",
      allowResolution: () => true,
      now: () => wall,
    }),
    noticeBilling,
    billing,
    notices,
    automatic,
    collections: createInvoiceCollections(options),
    detach: () => {
      detached = true;
    },
    factory,
    sent,
    issue,
    rows,
    stage,
    customerId,
    actors,
    setBusiness: (s: string) => {
      business = new Date(s);
    },
    setWall: (s: string) => {
      wall = new Date(s);
    },
    advanceWall: (ms: number) => {
      wall = new Date(wall.getTime() + ms);
    },
    setOutcome: (o: typeof outcome) => {
      outcome = o;
    },
    beforeInspect: (f: typeof beforeInspect) => {
      beforeInspect = f;
    },
    afterSend: (f: typeof afterSend) => {
      afterSend = f;
    },
  };
}

test("notice calendar and initial gate capture four stages, reject DST gaps and prevent delayed bursts", async () => {
  const s = await setup();
  const id = await s.issue("2030-01-02");
  expect((await s.rows(id)).length).toBe(4);
  expect(new Date((await s.stage(id, "due")).scheduledAt!)).toEqual(
    new Date("2030-01-02T17:00:00Z"),
  );
  s.setBusiness("2030-01-09T18:00:00Z");
  const first = await s.stage(id, "invoice");
  s.setOutcome({ kind: "definitively_unaccepted", transient: true });
  expect(await s.notices.processNotice(first.id)).toBe("retry");
  expect(
    (await s.rows(id)).filter((r) => r.reason === "obsolete_after_delay"),
  ).toHaveLength(3);
  s.advanceWall(60000);
  s.setOutcome({ kind: "accepted" });
  expect(await s.notices.processNotice(first.id)).toBe("complete");
  s.setBusiness("2030-01-02T18:00:00Z");
  for (const row of await s.rows(id)) await s.notices.processNotice(row.id);
  expect(s.sent).toHaveLength(2);
  const latest = await s.issue();
  s.setBusiness("2030-01-01T12:00:00Z");
  expect(
    await s.notices.processNotice((await s.stage(latest, "invoice")).id),
  ).toBe("complete");
  s.setBusiness("2030-01-22T18:00:00Z");
  expect(
    await s.notices.processNotice((await s.stage(latest, "before_due")).id),
  ).toBe("complete");
  expect((await s.stage(latest, "before_due")).reason).toBe("obsolete");
  expect(await s.notices.processNotice((await s.stage(latest, "due")).id)).toBe(
    "complete",
  );
  expect(s.sent).toHaveLength(4);
  const held = await s.issue();
  const readsBeforeHolds = s.providerReads();
  s.setBusiness("2030-01-01T12:00:00Z");
  const beforeDue = await s.stage(held, "before_due");
  expect(await s.notices.processNotice(beforeDue.id)).toBe("retry");
  expect(s.providerReads()).toBe(readsBeforeHolds);
  s.setBusiness(beforeDue.scheduledAt!);
  expect(await s.notices.processNotice(beforeDue.id)).toBe("retry");
  const pendingHold = await s.stage(held, "before_due");
  s.setWall(pendingHold.nextAttemptAt!);
  expect(await s.notices.processNotice(beforeDue.id)).toBe("retry");
  expect(
    Date.parse((await s.stage(held, "before_due")).nextAttemptAt!) -
      Date.parse(pendingHold.nextAttemptAt!),
  ).toBe(60000);
  await db
    .update(invoiceNotices)
    .set({
      state: "needs_review",
      reason: "recipient_not_allowed",
    })
    .where(eq(invoiceNotices.id, (await s.stage(held, "invoice")).id));
  s.setWall((await s.stage(held, "before_due")).nextAttemptAt!);
  for (const name of ["before_due", "due", "overdue"]) {
    const reminder = await s.stage(held, name);
    s.setBusiness(reminder.scheduledAt!);
    expect(await s.notices.processNotice(reminder.id)).toBe("retry");
    expect(await s.stage(held, name)).toMatchObject({
      reason: "initial_notice_needs_review",
      nextAttemptAt: null,
    });
    expect((await s.notices.sweepNotices()).noticeIds).not.toContain(
      reminder.id,
    );
    s.setBusiness(reminder.windowEndAt!);
    expect((await s.notices.sweepNotices()).noticeIds).toContain(reminder.id);
    expect(await s.notices.processNotice(reminder.id)).toBe("complete");
    expect(await s.stage(held, name)).toMatchObject({
      state: "suppressed",
      reason: "obsolete",
    });
  }
  expect(s.providerReads()).toBe(readsBeforeHolds);
  s.setWall("2030-02-20T12:00:00Z");
  const dst = await s.issue("2030-03-10");
  // Recreate only this disposable fixture's as-yet-unattempted rows with a gap-hour policy.
  await db.delete(invoiceNotices).where(eq(invoiceNotices.invoiceId, dst));
  await s.factory({ timeZone: "America/Los_Angeles", hour: 2 }).sweepNotices();
  expect(
    (await s.rows(dst)).every(
      (row) =>
        row.state === "needs_review" &&
        row.reason === "calendar_invalid" &&
        row.scheduledAt === null,
    ),
  ).toBe(true);
});

test("notice financial holds, explicit contact and scoped staff reads preserve stamped content", async () => {
  const s = await setup();
  const id = await s.issue();
  const first = await s.stage(id, "invoice");
  expect(
    await s.notices.getInvoiceNotices(s.actors.member, s.customerId, id),
  ).toMatchObject({ ok: false });
  expect(
    await s.notices.getInvoiceNotices(s.actors.staff, randomUUID(), id),
  ).toMatchObject({ ok: false });
  await db
    .update(customerTable)
    .set({ billingEmail: null })
    .where(eq(customerTable.id, s.customerId));
  const readsBeforeMissingContact = s.providerReads();
  expect(await s.notices.processNotice(first.id)).toBe("retry");
  expect((await s.stage(id, "invoice")).reason).toBe("billing_contact_missing");
  const firstHold = await s.stage(id, "invoice");
  s.setWall(firstHold.nextAttemptAt!);
  expect(await s.notices.processNotice(first.id)).toBe("retry");
  const secondHold = await s.stage(id, "invoice");
  expect(
    Date.parse(secondHold.nextAttemptAt!) -
      Date.parse(firstHold.nextAttemptAt!),
  ).toBe(60000);
  s.setWall(secondHold.nextAttemptAt!);
  expect(await s.notices.processNotice(first.id)).toBe("retry");
  const thirdHold = await s.stage(id, "invoice");
  expect(
    Date.parse(thirdHold.nextAttemptAt!) -
      Date.parse(secondHold.nextAttemptAt!),
  ).toBeGreaterThan(60000);
  expect(s.providerReads()).toBe(readsBeforeMissingContact);
  s.setWall(thirdHold.nextAttemptAt!);
  await db
    .update(customerTable)
    .set({ billingEmail: "billing@notice.test" })
    .where(eq(customerTable.id, s.customerId));
  s.provider.evidence(`in_${id}`).collectionState = "active";
  expect(await s.notices.processNotice(first.id)).toBe("retry");
  expect((await s.stage(id, "invoice")).reason).toBe("processing");
  s.advanceWall(30000);
  s.provider.evidence(`in_${id}`).collectionState = "idle";
  s.provider.collectionError = new BillingProviderError(
    "retryable",
    "retry_exhausted",
  );
  expect(await s.notices.processNotice(first.id)).toBe("retry");
  expect((await s.stage(id, "invoice")).reason).toBe("provider_unavailable");
  s.advanceWall(30000);
  s.provider.collectionError = null;
  s.setOutcome({ kind: "definitively_unaccepted", transient: true });
  expect(await s.notices.processNotice(first.id)).toBe("retry");
  const read = value(
    await s.notices.getInvoiceNotices(s.actors.staff, s.customerId, id),
  );
  expect(s.sent[0]).toMatchObject(read.notices[0].preview!);
  expect(read.notices[0].previewKind).toBe("stamped");
  s.advanceWall(60000);
  await db
    .update(customerTable)
    .set({ billingEmail: "new@notice.test", version: 2 })
    .where(eq(customerTable.id, s.customerId));
  expect(await s.notices.processNotice(first.id)).toBe("needs_review");
  expect((await s.stage(id, "invoice")).reason).toBe("billing_contact_changed");
  expect(s.sent).toHaveLength(1);
  const paid = await s.issue();
  s.provider.invoices.get(`in_${paid}`)!.status = "paid";
  s.provider.evidence(`in_${paid}`).remainingMinor = 0;
  expect(
    await s.notices.processNotice((await s.stage(paid, "invoice")).id),
  ).toBe("complete");
  expect((await s.rows(paid)).every((r) => r.reason === "paid")).toBe(true);
  const voided = await s.issue();
  s.provider.invoices.get(`in_${voided}`)!.status = "void";
  await s.notices.processNotice((await s.stage(voided, "invoice")).id);
  expect((await s.rows(voided)).every((r) => r.reason === "void")).toBe(true);
  const conflict = await s.issue();
  value(
    await s.resolutions.recordExternalPayment(
      s.actors.staff,
      s.customerId,
      conflict,
      {
        requestId: randomUUID(),
        amountMinor: 1100,
        receivedDate: "2030-01-01",
        method: "check",
        reference: "Synthetic partial receipt",
      },
    ),
  );
  expect(
    await s.notices.processNotice((await s.stage(conflict, "invoice")).id),
  ).toBe("retry");
  expect((await s.stage(conflict, "invoice")).reason).toBe(
    "resolution_conflict",
  );
  const auto = await s.automatic();
  s.setBusiness("2030-01-22T09:00:00Z");
  s.setWall("2030-01-22T09:00:00Z");
  s.enableAction();
  s.setOutcome({ kind: "accepted" });
  expect(await s.collections.collectDueInvoice(auto)).toBe("complete");
  expect(
    await s.notices.processNotice((await s.stage(auto, "invoice")).id),
  ).toBe("complete");
  expect(s.sent.at(-1)!.text).toContain("needs verification");
  expect(s.paymentCalls()).toBe(1);
  const evidence = s.provider.evidence(`in_${auto}`);
  evidence.collectionState = "idle";
  evidence.remainingMinor = 0;
  evidence.paidMinor = 1200;
  evidence.payments = [
    {
      invoicePaymentId: "inpay_competing",
      paymentIntentId: "pi_competing",
      providerPaymentMethodId: "pm_competing",
      status: "paid",
      paidMinor: 1200,
      intentState: "succeeded",
      receivedMinor: 1200,
      capturableMinor: 0,
    },
  ];
  s.provider.invoices.get(`in_${auto}`)!.status = "paid";
  s.setBusiness((await s.stage(auto, "overdue")).scheduledAt!);
  expect(
    await s.notices.processNotice((await s.stage(auto, "overdue")).id),
  ).toBe("complete");
  expect((await s.stage(auto, "overdue")).reason).toBe("paid");
  const [attempt] = await db
    .select()
    .from(billingPaymentAttempts)
    .where(eq(billingPaymentAttempts.invoiceId, auto));
  expect(attempt.state).toBe("needs_review");
});

test("notice financial evidence ages under held locks and never permits network work in transactions", async () => {
  const s = await setup();
  const id = await s.issue();
  let observations = 0;
  await s.noticeBilling.withInvoiceNoticeContext(id, async (context) => {
    const facts = await context.observe();
    expect(facts.collection.disposition).toEqual({
      kind: "payable",
      reason: "manual",
    });
    s.advanceWall(5001);
    const stale = await context.connection.transaction((tx) =>
      context.recheck(tx),
    );
    expect(stale.collection.disposition).toEqual({
      kind: "defer",
      reason: "stale",
    });
  });
  const auto = await s.automatic();
  const autoFirst = await s.stage(auto, "invoice");
  expect(await s.notices.processNotice(autoFirst.id)).toBe("complete");
  s.setBusiness("2030-01-22T09:00:00Z");
  s.setWall("2030-01-22T09:00:00Z");
  const due = await s.stage(auto, "due");
  expect(await s.notices.processNotice(due.id)).toBe("retry");
  expect((await s.stage(auto, "due")).reason).toBe("awaiting_collection");
  await s.noticeBilling.withInvoiceNoticeContext(auto, async (context) => {
    const exposed = await context.observe();
    exposed.collection.disposition = {
      kind: "payable",
      reason: "not_authorized",
    };
    expect(
      (await context.connection.transaction((tx) => context.recheck(tx)))
        .collection.disposition,
    ).toEqual({ kind: "defer", reason: "awaiting_collection" });
  });
  s.detach();
  await s.noticeBilling.withInvoiceNoticeContext(auto, async (context) => {
    expect((await context.observe()).collection.disposition).toEqual({
      kind: "payable",
      reason: "not_authorized",
    });
    expect(
      (await context.connection.transaction((tx) => context.recheck(tx)))
        .collection.disposition,
    ).toEqual({ kind: "payable", reason: "not_authorized" });
  });
  s.advanceWall(30000);
  expect(await s.notices.processNotice(due.id)).toBe("complete");
  expect(s.sent.at(-1)!.text).toContain("not authorized");
  s.setBusiness("2030-01-29T09:00:00Z");
  s.setWall("2030-01-29T09:00:00Z");
  expect(await s.collections.collectDueInvoice(auto)).toBe("complete");
  expect(
    await s.notices.processNotice((await s.stage(auto, "overdue")).id),
  ).toBe("complete");
  expect(s.sent.at(-1)!.text).toContain("not attempted");
  const sentBeforeStall = s.sent.length;
  s.beforeInspect(async () => {
    observations++;
    s.advanceWall(5001);
  });
  expect(await s.notices.processNotice((await s.stage(id, "invoice")).id)).toBe(
    "retry",
  );
  expect(observations).toBe(2);
  expect(s.sent).toHaveLength(sentBeforeStall);
  expect((await s.stage(id, "invoice")).reason).toBe("stale");
  s.beforeInspect(null);
  s.advanceWall(30000);
  s.afterStamp(async () => {
    s.advanceWall(5001);
  });
  const readsBeforeStamp = s.providerReads();
  expect(await s.notices.processNotice((await s.stage(id, "invoice")).id)).toBe(
    "needs_review",
  );
  expect(await s.stage(id, "invoice")).toMatchObject({
    state: "needs_review",
    reason: "evidence_expired_before_send",
    attempts: 1,
  });
  expect(s.providerReads()).toBe(readsBeforeStamp + 1);
  expect(s.sent).toHaveLength(sentBeforeStall);
});

test("notice durability bounds retries, preserves uncertain stamps and advances independent pages", async () => {
  const s = await setup();
  const id = await s.issue();
  const first = await s.stage(id, "invoice");
  s.setOutcome({ kind: "uncertain" });
  expect(
    await Promise.all([
      s.notices.processNotice(first.id),
      s.notices.processNotice(first.id),
    ]),
  ).toEqual(["needs_review", "needs_review"]);
  expect(s.sent).toHaveLength(1);
  expect((await s.stage(id, "invoice")).reason).toBe("uncertain_delivery");
  const retry = await s.issue();
  const retryId = (await s.stage(retry, "invoice")).id;
  s.setOutcome({ kind: "definitively_unaccepted", transient: true });
  expect(await s.notices.processNotice(retryId)).toBe("retry");
  s.advanceWall(60000);
  await db
    .update(customerTable)
    .set({ displayName: "Renamed display", version: 2 })
    .where(eq(customerTable.id, s.customerId));
  expect(await s.notices.processNotice(retryId)).toBe("retry");
  expect((await s.stage(retry, "invoice")).profileVersion).toBe(1);
  s.advanceWall(300000);
  expect(await s.notices.processNotice(retryId)).toBe("needs_review");
  expect((await s.stage(retry, "invoice")).attempts).toBe(3);
  expect((await s.stage(retry, "invoice")).reason).toBe("retry_exhausted");
  const changed = await s.issue();
  const changedId = (await s.stage(changed, "invoice")).id;
  expect(await s.notices.processNotice(changedId)).toBe("retry");
  s.advanceWall(60000);
  s.provider.evidence(`in_${changed}`).remainingMinor = 1100;
  s.provider.evidence(`in_${changed}`).paidMinor = 100;
  expect(await s.notices.processNotice(changedId)).toBe("needs_review");
  expect((await s.stage(changed, "invoice")).reason).toBe("content_changed");
  const crash = await s.issue();
  const crashId = (await s.stage(crash, "invoice")).id;
  s.setOutcome({ kind: "definitively_unaccepted", transient: true });
  await s.notices.processNotice(crashId);
  await db
    .update(invoiceNotices)
    .set({ state: "sending", reason: null, nextAttemptAt: null })
    .where(eq(invoiceNotices.id, crashId));
  const count = s.sent.length;
  expect(await s.notices.processNotice(crashId)).toBe("needs_review");
  expect(s.sent).toHaveLength(count);
  const one = await s.issue(),
    two = await s.issue();
  let page = await s.notices.sweepNotices({ limit: 1 });
  const ids = [...page.noticeIds];
  for (let i = 0; page.pending.after && i < 20; i++) {
    page = await s.notices.sweepNotices({
      limit: 1,
      pending: page.pending,
      discovery: page.discovery,
    });
    ids.push(...page.noticeIds);
  }
  expect(ids).toContain((await s.stage(one, "invoice")).id);
  expect(ids).toContain((await s.stage(two, "invoice")).id);
  const audits = await db
    .select()
    .from(auditEntries)
    .where(sql`${auditEntries.action} like 'invoice.notice_%'`);
  expect(audits.some((a) => a.action === "invoice.notice_attempted")).toBe(
    true,
  );
  expect(audits.every((a) => !("recipient" in a.details))).toBe(true);
  await s.notices.assertSyntheticData();
});
