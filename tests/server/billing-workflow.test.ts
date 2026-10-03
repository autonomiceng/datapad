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
import {
  user,
  session,
  member,
  auditEntries,
} from "../../src/access/internal/schema";
import type { HumanActor } from "../../src/access/types";
import type { StaffRole } from "../../src/access/contract";
import { createCustomers, createCustomerRegistry } from "../../src/customers";
import type { Customers } from "../../src/customers/types";
import {
  createBilling,
  createBillingWorkflow,
  createInvoiceCollections,
} from "../../src/billing";
import type { PrepareInvoiceRequest } from "../../src/billing/contract";
import type { SyntheticInvoicePolicy } from "../../src/billing/types";
import { SyntheticBillingProvider } from "./billing-provider";
import { ENROLLMENT_TERMS_VERSION } from "../../src/billing/payment-settings-contract";
import {
  invoices,
  invoiceLines,
  billingCustomers,
} from "../../src/billing/internal/invoice-schema";
import {
  billingSchedules,
  billingInvoiceGroups,
} from "../../src/billing/internal/scheduled-schema";
import {
  billingPaymentSetups,
  billingPaymentMethods,
  billingEnrollments,
} from "../../src/billing/internal/payment-settings-schema";
import { billingPaymentAttempts } from "../../src/billing/internal/collection-schema";
import {
  billingPeriods,
  billingSubscriptions,
  billingSubscriptionTerms,
} from "../../src/billing/internal/subscriptions-schema";
import { billingEnrollmentScopes } from "../../src/billing/internal/payment-scope-schema";
import type { InvoiceCollectionProvider } from "../../src/billing/provider";

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
const input = (expectedCustomerVersion = 1): PrepareInvoiceRequest => ({
  requestId: randomUUID(),
  expectedCustomerVersion,
  dueDate: "2030-01-22",
  currency: "USD",
  lines: [{ description: "Synthetic one-time support", amountMinor: 1200 }],
});
async function setup() {
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
          members: [
            { userId: "member", role: "member" },
            { userId: "staff", role: "administrator" },
          ],
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
  const provider = new SyntheticBillingProvider();
  let detached = false,
    methodReads = 0;
  const collectionProvider: InvoiceCollectionProvider = {
    ownership: provider.ownership,
    inspectCollection: (...args) => provider.inspectCollection(...args),
    async retrieveSavedMethod(intent, providerPaymentMethodId) {
      methodReads++;
      return {
        ...provider.ownership,
        providerPaymentMethodId,
        providerCustomerId: detached ? null : intent.providerCustomerId,
        livemode: false,
        type: "card",
        card: {
          brand: "visa",
          last4: "4242",
          expiryMonth: 12,
          expiryYear: 2035,
        },
      };
    },
    async payInvoice() {
      throw new Error("Invoice checks cannot charge");
    },
  };
  let now = new Date("2030-01-01T12:00:00Z");
  const allowRequest: SyntheticInvoicePolicy = ({
    request,
    customerId,
    billTo,
  }) =>
    [ids.elm, ids.birch].includes(customerId) &&
    ["Elm (sample)", "Elm revised (sample)", "Birch (sample)"].includes(
      request.customer.name,
    ) &&
    ["Elm (sample)", "Elm revised (sample)", "Birch (sample)"].includes(
      billTo.legalName,
    ) &&
    [null, "billing@elm.test"].includes(billTo.billingEmail) &&
    request.lines.length === 1 &&
    request.lines[0].description === "Synthetic one-time support" &&
    request.lines[0].amountMinor === 1200;
  const options = {
    pool,
    provider,
    deploymentKey: "billing-test",
    customers: registry,
    customerAccess: customers,
    audit,
    allowRequest,
    now: () => now,
  };
  return {
    ids,
    actors,
    audit,
    customers,
    provider,
    options,
    collectionOptions: {
      pool,
      deploymentKey: options.deploymentKey,
      provider: collectionProvider,
      audit,
      workerId: "billing-workflow-test",
      wallNow: options.now,
      businessNow: options.now,
    },
    setMethodDetached: () => {
      detached = true;
    },
    methodReads: () => methodReads,
    workflow: createBillingWorkflow(options),
    billing: createBilling(options),
    setDate: (date: string) => {
      now = new Date(date);
    },
  };
}

test("billing authority, atomic audit and first-mapping concurrency prevent unapproved or duplicate issue", async () => {
  const s = await setup();
  expect(
    await s.workflow.prepareInvoice(s.actors.admin, s.ids.elm, input()),
  ).toEqual({ ok: false, code: "forbidden" });
  expect(
    await s.workflow.prepareInvoice(s.actors.support, s.ids.elm, input()),
  ).toEqual({ ok: false, code: "forbidden" });
  expect(
    await s.workflow.prepareInvoice(s.actors.member, s.ids.elm, input()),
  ).toEqual({ ok: false, code: "forbidden" });
  const first = input();
  const prepared = await Promise.all([
    s.workflow.prepareInvoice(s.actors.billing, s.ids.elm, first),
    s.workflow.prepareInvoice(s.actors.billing, s.ids.elm, input()),
  ]);
  const id = value(prepared[0]).invoice.id;
  expect(prepared.map((result) => value(result).outcome)).toEqual([
    "created",
    "created",
  ]);
  expect(
    (await pool.query("SELECT count(*)::int AS total FROM billing_customers"))
      .rows,
  ).toEqual([{ total: 1 }]);
  expect((await s.billing.getInvoice(id))!.invoice.state).toBe("requested");
  expect(await s.billing.pendingWork()).toEqual([]);
  expect(s.provider.invoices.size).toBe(0);
  s.setDate("2030-01-02T12:00:00Z");
  expect(
    value(await s.workflow.prepareInvoice(s.actors.billing, s.ids.elm, first)),
  ).toMatchObject({
    outcome: "unchanged",
    invoice: { id, issueDate: "2030-01-01" },
  });
  expect(
    await s.workflow.prepareInvoice(s.actors.billing, s.ids.elm, {
      ...first,
      dueDate: "2030-01-21",
    }),
  ).toEqual({ ok: false, code: "conflict" });
  expect(
    await s.workflow.getPreparation(s.actors.billing, s.ids.birch, id),
  ).toEqual({ ok: false, code: "not_found" });
  const broken = createBillingWorkflow({
    ...s.options,
    audit: {
      ...s.audit,
      append: async (tx, entry) => {
        await s.audit.append(tx, entry);
        throw new Error("Synthetic audit interruption");
      },
    },
  });
  const rejected = input();
  expect(
    await rejection(
      broken.prepareInvoice(s.actors.billing, s.ids.elm, rejected),
    ),
  ).toBeInstanceOf(Error);
  expect(
    (
      await pool.query(
        "SELECT count(*)::int AS total FROM invoices WHERE origin_key=$1",
        [`staff:${rejected.requestId}`],
      )
    ).rows,
  ).toEqual([{ total: 0 }]);
  expect(
    await rejection(broken.confirmIssue(s.actors.billing, s.ids.elm, id)),
  ).toBeInstanceOf(Error);
  expect((await s.billing.getInvoice(id))!.invoice.state).toBe("requested");
  value(
    await s.workflow.prepareInvoice(s.actors.billing, s.ids.elm, {
      ...input(),
      requestId: id,
    }),
  );
  const confirmed = await Promise.all([
    s.workflow.confirmIssue(s.actors.billing, s.ids.elm, id),
    s.workflow.confirmIssue(s.actors.billing, s.ids.elm, id),
  ]);
  expect(confirmed.map((result) => value(result).outcome).sort()).toEqual([
    "accepted",
    "unchanged",
  ]);
  expect(
    (
      await db
        .select()
        .from(auditEntries)
        .where(eq(auditEntries.action, "invoice.issue_requested"))
    ).length,
  ).toBe(1);
  expect(await s.billing.pendingWork()).toEqual([
    { kind: "issue", invoiceId: id },
  ]);
  await db.delete(session).where(eq(session.id, s.actors.billing.sessionId));
  expect(
    await s.workflow.confirmIssue(
      s.actors.billing,
      s.ids.elm,
      value(prepared[1]).invoice.id,
    ),
  ).toEqual({ ok: false, code: "unauthenticated" });
  expect(
    value(await s.workflow.checkInvoice(s.actors.admin, s.ids.elm, id)).invoice
      .id,
  ).toBe(id);
  expect(
    value(await s.workflow.checkInvoice(s.actors.member, s.ids.elm, id)).invoice
      .id,
  ).toBe(id);
  expect(
    await s.workflow.checkInvoice(s.actors.member, s.ids.birch, id),
  ).toEqual({ ok: false, code: "not_found" });
  expect(
    await s.workflow.checkInvoice(s.actors.outsider, s.ids.elm, id),
  ).toEqual({ ok: false, code: "not_found" });
  expect(
    await s.workflow.checkInvoice(s.actors.support, s.ids.elm, id),
  ).toEqual({ ok: false, code: "forbidden" });
});

test("member checks inspect manual payment availability once for queued callers and recheck membership after waiting", async () => {
  const s = await setup();
  const id = value(
    await s.workflow.prepareInvoice(s.actors.billing, s.ids.elm, input()),
  ).invoice.id;
  value(await s.workflow.confirmIssue(s.actors.billing, s.ids.elm, id));
  await s.billing.issueInvoice(id);
  const workflow = createBillingWorkflow({
    ...s.options,
    collectionProvider: s.provider,
    invoiceCollections: createInvoiceCollections(s.collectionOptions),
  });
  const inspect = s.provider.inspectCollection.bind(s.provider);
  let entered = Promise.withResolvers<void>();
  let release = Promise.withResolvers<void>();
  s.provider.inspectCollection = async (...args) => {
    entered.resolve();
    await release.promise;
    return inspect(...args);
  };
  const first = workflow.checkInvoice(s.actors.member, s.ids.elm, id);
  await entered.promise;
  const queued = workflow.checkInvoice(s.actors.member, s.ids.elm, id);
  let waiting = false;
  try {
    for (let poll = 0; poll < 100; poll++) {
      const result = await lockPool.query(
        "SELECT count(*)::int AS total FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND wait_event='advisory'",
      );
      if (result.rows[0].total > 0) {
        waiting = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  } finally {
    release.resolve();
  }
  expect(waiting).toBe(true);
  const responses = await Promise.all([first, queued]);
  expect(responses.map((r) => value(r).invoice.id)).toEqual([id, id]);
  expect(s.provider.calls.inspect).toBe(1);
  expect(
    (
      await pool.query("SELECT collection_state FROM invoices WHERE id=$1", [
        id,
      ])
    ).rows,
  ).toEqual([{ collection_state: "idle" }]);
  const calls = { ...s.provider.calls };
  expect(await workflow.checkInvoice(s.actors.outsider, s.ids.elm, id)).toEqual(
    { ok: false, code: "not_found" },
  );
  expect(s.provider.calls).toEqual(calls);
  // Background refresh is unconditional even immediately after an explicit check.
  await createBilling({
    ...s.options,
    collectionProvider: s.provider,
  }).refreshInvoice(id);
  expect(s.provider.calls.inspect).toBe(1);
  expect(s.provider.calls.retrieve).toBe(calls.retrieve + 1);
  s.setDate("2030-01-01T12:00:06Z");
  entered = Promise.withResolvers<void>();
  release = Promise.withResolvers<void>();
  const removedWhileWaiting = workflow.checkInvoice(
    s.actors.member,
    s.ids.elm,
    id,
  );
  await entered.promise;
  await db.delete(member).where(eq(member.userId, s.actors.member.userId));
  release.resolve();
  expect(await removedWhileWaiting).toEqual({ ok: false, code: "not_found" });
  expect(s.provider.calls.inspect).toBe(2);
  expect(s.provider.calls.invoice).toBe(1);
});

test("member checks preserve collection inspection budgets and allow fresh customer Pay for a detached card", async () => {
  const s = await setup();
  s.setDate(new Date().toISOString());
  const due = new Date();
  due.setUTCDate(due.getUTCDate() + 21);
  const request = { ...input(), dueDate: due.toISOString().slice(0, 10) };
  const id = value(
    await s.workflow.prepareInvoice(s.actors.billing, s.ids.elm, request),
  ).invoice.id;
  value(await s.workflow.confirmIssue(s.actors.billing, s.ids.elm, id));
  await s.billing.issueInvoice(id);
  const [invoice] = await db.select().from(invoices).where(eq(invoices.id, id));
  const [mapping] = await db
    .select()
    .from(billingCustomers)
    .where(eq(billingCustomers.id, invoice.billingCustomerId));
  const [membership] = await db
    .select()
    .from(member)
    .where(eq(member.userId, s.actors.member.userId));
  const setupId = randomUUID(),
    methodId = randomUUID(),
    enrollmentId = randomUUID(),
    groupId = randomUUID(),
    attemptId = randomUUID();
  const stamp = s.options.now().toISOString();
  const owner = {
    customerId: s.ids.elm,
    deploymentKey: s.options.deploymentKey,
  };
  const methodOwner = {
    ...owner,
    billingCustomerId: mapping.id,
    providerAccountId: s.provider.ownership.accountId,
  };
  const consent = {
    actorUserId: s.actors.member.userId,
    actorSessionId: s.actors.member.sessionId,
    consentingMembershipId: membership.id,
    membershipProvenance: {
      invitationId: null,
      invitedByUserId: null,
      invitedByStaff: null,
    },
    acceptedAt: stamp,
    requestDigest: "0".repeat(64),
    requestId: randomUUID(),
  };
  // Seed only the durable guard dependencies. Collection eligibility and dispatch have their own suite.
  await db.transaction(async (tx) => {
    await tx.insert(billingPaymentSetups).values({
      ...methodOwner,
      ...consent,
      id: setupId,
      saveTermsVersion: "synthetic",
      saveTermsDigest: "0".repeat(64),
      successUrl: "http://localhost:4321/return",
      cancelUrl: "http://localhost:4321/return",
      integrationIdentifier: "synthetic-abcdefgh",
      status: "verified",
      lastCheckedAt: stamp,
      retrievalRequestedAt: stamp,
      providerSessionId: "cs_guard",
      providerSetupIntentId: "seti_guard",
      providerPaymentMethodId: "pm_guard",
    });
    await tx.insert(billingPaymentMethods).values({
      ...methodOwner,
      id: methodId,
      setupId,
      providerPaymentMethodId: "pm_guard",
      brand: "visa",
      last4: "4242",
      expiryMonth: 12,
      expiryYear: 2035,
      verifiedAt: stamp,
    });
    await tx.insert(billingEnrollments).values({
      ...owner,
      ...consent,
      requestId: randomUUID(),
      id: enrollmentId,
      version: 1,
      decision: "authorize",
      paymentMethodId: methodId,
      termsVersion: ENROLLMENT_TERMS_VERSION,
      termsDigest: "0".repeat(64),
      request: {
        requestId: randomUUID(),
        expectedVersion: 0,
        paymentMethodId: methodId,
        termsVersion: ENROLLMENT_TERMS_VERSION,
        acceptTerms: true,
        selections: [],
      },
    });
    await tx.insert(billingSchedules).values({
      ...owner,
      createdAt: stamp,
      updatedAt: stamp,
      createdBy: s.actors.billing.userId,
      updatedBy: s.actors.billing.userId,
    });
    await tx.insert(billingInvoiceGroups).values({
      ...owner,
      id: groupId,
      invoiceId: id,
      billingCustomerId: mapping.id,
      dueDate: invoice.dueDate,
      currency: "USD",
      paymentArrangement: "automatic",
      calendar: { timeZone: "UTC", issueHour: 9, chargeHour: 9 },
      outcome: "invoice_requested",
      sealedAt: stamp,
      totalMinor: invoice.totalMinor,
      billToName: invoice.billToName,
      billToProfileVersion: invoice.billToProfileVersion,
      enrollmentId,
      paymentMethodId: methodId,
    });
    await tx.insert(billingPaymentAttempts).values({
      ...methodOwner,
      id: attemptId,
      invoiceId: id,
      groupId,
      enrollmentId,
      paymentMethodId: methodId,
      chargeAt: stamp,
      dueEndAt: invoice.dueEndAt,
      currency: "USD",
      remainingMinor: invoice.totalMinor,
      request: {
        providerInvoiceId: invoice.providerInvoiceId!,
        providerPaymentMethodId: "pm_guard",
        offSession: true,
      },
      requestDigest: "0".repeat(64),
      idempotencyKey: `datapad:${owner.deploymentKey}:payment:${attemptId}:pay`,
      firstAttemptedAt: stamp,
      lastDispatchedAt: stamp,
      baselineObservedAt: stamp,
      baselinePaidMinor: 0,
      baselinePaidOffStripeMinor: 0,
      baselineOverpaidMinor: 0,
      baselinePayments: [],
      state: "pending",
      dispatchCount: 1,
      inspectionFailures: 3,
    });
  });
  s.provider.unavailable = true;
  const workflow = createBillingWorkflow({
    ...s.options,
    collectionProvider: s.provider,
    invoiceCollections: createInvoiceCollections(s.collectionOptions),
  });
  const calls = { ...s.provider.calls };
  const methodReads = s.methodReads();
  for (const state of ["pending", "processing"] as const) {
    await db
      .update(billingPaymentAttempts)
      .set({ state })
      .where(eq(billingPaymentAttempts.id, attemptId));
    expect(
      (await workflow.checkInvoice(s.actors.member, s.ids.elm, id)).ok,
    ).toBe(true);
    expect(s.provider.calls).toEqual(calls);
    expect(s.methodReads()).toBe(methodReads);
    const [attempt] = await db
      .select()
      .from(billingPaymentAttempts)
      .where(eq(billingPaymentAttempts.id, attemptId));
    expect(attempt).toMatchObject({
      state,
      inspectionFailures: 3,
      dispatchCount: 1,
    });
  }
  expect(
    (await workflow.checkInvoice(s.actors.billing, s.ids.elm, id)).ok,
  ).toBe(true);
  expect(s.provider.calls.inspect).toBe(calls.inspect + 1);
  const [attempt] = await db
    .select()
    .from(billingPaymentAttempts)
    .where(eq(billingPaymentAttempts.id, attemptId));
  expect(attempt.inspectionFailures).toBe(4);
  // Turn the same synthetic group into a fully covered automatic invoice with no attempt.
  // Only a live method read can distinguish the detached card from local permission.
  const subscriptionId = randomUUID(),
    periodId = randomUUID();
  const calendar = { timeZone: "UTC", issueHour: 9, chargeHour: 9 };
  const start = new Date(`${invoice.dueDate}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() + 1);
  const periodStart = start.toISOString().slice(0, 10);
  start.setUTCMonth(start.getUTCMonth() + 1);
  const periodEnd = start.toISOString().slice(0, 10);
  await db.transaction(async (tx) => {
    await tx
      .delete(billingPaymentAttempts)
      .where(eq(billingPaymentAttempts.id, attemptId));
    await tx.update(invoices).set({ calendar }).where(eq(invoices.id, id));
    await tx.insert(billingSubscriptions).values({
      ...owner,
      id: subscriptionId,
      createRequestId: randomUUID(),
      createDigest: "0".repeat(64),
      periodAnchorDate: periodStart,
      dueAnchorDate: invoice.dueDate,
      intervalMonths: 1,
      firstUnbilledPeriodIndex: 0,
      calendar,
      createdAt: stamp,
      updatedAt: stamp,
    });
    await tx.insert(billingSubscriptionTerms).values([
      {
        ...owner,
        subscriptionId,
        revision: 1,
        effectivePeriodIndex: 0,
        kind: "commercial",
        label: "Synthetic one-time support",
        amountMinor: 1200,
        currency: "USD",
        paymentArrangement: "automatic",
      },
      {
        ...owner,
        subscriptionId,
        revision: 2,
        effectivePeriodIndex: 0,
        kind: "state",
        billingState: "billable",
      },
    ]);
    await tx.insert(billingEnrollmentScopes).values({
      ...owner,
      enrollmentId,
      subscriptionId,
      commercialRevision: 1,
      fromPeriodIndex: 0,
      periodStart,
      dueDate: invoice.dueDate,
      calendar,
    });
    await tx.insert(billingPeriods).values({
      ...owner,
      id: periodId,
      subscriptionId,
      periodIndex: 0,
      periodStart,
      periodEnd,
      dueDate: invoice.dueDate,
      commercialRevision: 1,
      stateRevision: 2,
      label: "Synthetic one-time support",
      amountMinor: 1200,
      currency: "USD",
      paymentArrangement: "automatic",
      billingState: "billable",
      calendar,
      readinessDate: invoice.readinessDate,
      chargeAt: `${invoice.dueDate}T09:00:00Z`,
      dueEndAt: invoice.dueEndAt,
      sealedAt: stamp,
      invoiceGroupId: groupId,
    });
    await tx
      .update(invoiceLines)
      .set({ originRef: periodId })
      .where(eq(invoiceLines.invoiceId, id));
  });
  s.provider.unavailable = false;
  s.setDate(`${invoice.dueDate}T12:00:00Z`);
  s.setMethodDetached();
  const collections = createInvoiceCollections({
    ...s.collectionOptions,
    wallNow: () => new Date(),
  });
  const detachedWorkflow = createBillingWorkflow({
    ...s.options,
    now: () => new Date(),
    businessNow: s.options.now,
    invoiceCollections: collections,
  });
  const inspected = s.provider.calls.inspect;
  const checked = value(
    await detachedWorkflow.checkInvoice(s.actors.member, s.ids.elm, id),
  );
  expect(checked.invoice).toMatchObject({
    state: "open",
    providerReceipt: { state: "verified", reason: null },
    hostedInvoiceUrl: `https://invoice.stripe.com/i/in_${id}`,
    collection: {
      attempt: null,
      disposition: { kind: "payable", reason: "not_authorized" },
    },
  });
  expect(s.provider.calls.inspect).toBe(inspected + 1);
  expect(s.methodReads()).toBe(1);
  expect(
    (await detachedWorkflow.checkInvoice(s.actors.member, s.ids.elm, id)).ok,
  ).toBe(true);
  expect(s.provider.calls.inspect).toBe(inspected + 1);
  expect((await db.select().from(billingPaymentAttempts)).length).toBe(0);
});

test("frozen recipients and verified terminal receipts prevent misleading provider links after profile or receipt changes", async () => {
  const s = await setup();
  const first = input();
  const old = value(
    await s.workflow.prepareInvoice(s.actors.billing, s.ids.elm, first),
  ).invoice;
  value(
    await s.customers.updateCustomer(s.actors.admin, s.ids.elm, {
      requestId: randomUUID(),
      expectedVersion: 1,
      profile: {
        displayName: "Elm revised (sample)",
        legalName: "Elm revised (sample)",
        billingEmail: null,
      },
    }),
  );
  const renamed = value(
    await s.workflow.prepareInvoice(s.actors.billing, s.ids.elm, input(2)),
  );
  expect(renamed).toMatchObject({
    issueBlocker: "provider_profile_pending",
    invoice: {
      billTo: { legalName: "Elm revised (sample)", profileVersion: 2 },
    },
  });
  expect(
    await s.workflow.confirmIssue(
      s.actors.billing,
      s.ids.elm,
      renamed.invoice.id,
    ),
  ).toEqual({ ok: false, code: "conflict" });
  expect(
    (await pool.query("SELECT provider_customer_id FROM billing_customers"))
      .rows,
  ).toEqual([{ provider_customer_id: null }]);
  expect(await s.billing.requestIssue(renamed.invoice.id)).toEqual({
    kind: "accepted",
  });
  expect(await s.billing.issueInvoice(renamed.invoice.id)).toBe("needs_review");
  expect(
    (await s.billing.getInvoice(renamed.invoice.id))!.invoice,
  ).toMatchObject({
    state: "needs_review",
    reviewReason: "invoice_mismatch",
    providerReceipt: { state: "unverified", reason: null },
  });
  expect(s.provider.calls.customer).toBe(0);
  expect(
    value(await s.workflow.prepareInvoice(s.actors.billing, s.ids.elm, first))
      .invoice.billTo,
  ).toEqual(old.billTo);
  value(
    await s.customers.updateCustomer(s.actors.admin, s.ids.elm, {
      requestId: randomUUID(),
      expectedVersion: 2,
      profile: {
        displayName: "Elm (sample)",
        legalName: "Elm (sample)",
        billingEmail: "billing@elm.test",
      },
    }),
  );
  const contact = value(
    await s.workflow.prepareInvoice(s.actors.billing, s.ids.elm, input(3)),
  );
  expect(contact).toMatchObject({
    issueBlocker: null,
    invoice: {
      billTo: { billingEmail: "billing@elm.test", profileVersion: 3 },
    },
  });
  value(
    await s.workflow.confirmIssue(
      s.actors.billing,
      s.ids.elm,
      contact.invoice.id,
    ),
  );
  expect(await s.billing.issueInvoice(contact.invoice.id)).toBe("complete");
  value(await s.workflow.confirmIssue(s.actors.billing, s.ids.elm, old.id));
  expect(await s.billing.issueInvoice(old.id)).toBe("complete");
  const receipt = s.provider.invoices.get(`in_${old.id}`)!;
  receipt.status = "paid";
  expect(
    value(await s.workflow.checkInvoice(s.actors.billing, s.ids.elm, old.id))
      .invoice,
  ).toMatchObject({
    state: "paid",
    providerReceipt: { state: "verified", reason: null },
    billTo: old.billTo,
  });
  const trusted = (await s.billing.getInvoice(old.id))!.invoice
    .hostedInvoiceUrl;
  s.provider.unavailable = true;
  expect(
    value(await s.workflow.checkInvoice(s.actors.billing, s.ids.elm, old.id))
      .invoice.hostedInvoiceUrl,
  ).toBe(trusted);
  s.provider.unavailable = false;
  receipt.recipientName = "Different (sample)";
  expect(
    value(await s.workflow.checkInvoice(s.actors.billing, s.ids.elm, old.id))
      .invoice,
  ).toMatchObject({
    state: "paid",
    providerStatus: "paid",
    providerReceipt: { state: "mismatch", reason: "invoice_mismatch" },
    hostedInvoiceUrl: null,
  });
  receipt.recipientName = "Elm (sample)";
  expect(
    value(await s.workflow.checkInvoice(s.actors.billing, s.ids.elm, old.id))
      .invoice,
  ).toMatchObject({
    state: "paid",
    providerReceipt: { state: "verified", reason: null },
    hostedInvoiceUrl: trusted,
  });
  await s.billing.assertSyntheticPolicy(
    s.options.allowRequest,
    "acct_synthetic",
  );
  expect(
    (await pool.query("SELECT count(*)::int AS total FROM billing_customers"))
      .rows,
  ).toEqual([{ total: 1 }]);
});

test("reconciliation resumes a finite high-water pass beyond 100 receipts without skipping terminal or failed rows", async () => {
  const s = await setup();
  expect(await s.billing.reconciliationPage()).toEqual({
    invoiceIds: [],
    next: null,
    through: null,
  });
  const ids: string[] = [];
  for (let i = 0; i < 105; i++) {
    const id = value(
      await s.workflow.prepareInvoice(s.actors.billing, s.ids.elm, input()),
    ).invoice.id;
    value(await s.workflow.confirmIssue(s.actors.billing, s.ids.elm, id));
    await s.billing.issueInvoice(id);
    ids.push(id);
  }
  await pool.query(
    "UPDATE invoices SET created_at='2030-01-01T12:00:00.000001Z'::timestamptz + seq.n * interval '1 microsecond' FROM unnest($1::uuid[]) WITH ORDINALITY AS seq(id,n) WHERE invoices.id=seq.id",
    [ids],
  );
  const terminal = s.provider.invoices.get(`in_${ids[0]}`)!;
  terminal.status = "paid";
  await s.billing.refreshInvoice(ids[0]);
  await pool.query(
    "UPDATE invoices SET provider_receipt_state='unverified' WHERE id=$1",
    [ids[0]],
  );
  expect(
    (await s.billing.getInvoice(ids[0]))!.invoice.hostedInvoiceUrl,
  ).toBeNull();
  const first = await s.billing.reconciliationPage({ limit: 50 });
  expect(first.invoiceIds).toEqual(ids.slice(0, 50));
  expect(first.next).not.toBeNull();
  expect(first.through).not.toBeNull();
  s.provider.unavailable = true;
  expect(await s.billing.refreshInvoice(first.invoiceIds[1])).toBe("retry");
  s.provider.unavailable = false;
  expect(await s.billing.refreshInvoice(first.invoiceIds[0])).toBe("complete");
  expect((await s.billing.getInvoice(ids[0]))!.invoice).toMatchObject({
    state: "paid",
    providerReceipt: { state: "verified", reason: null },
  });
  s.setDate("2030-01-02T00:00:00Z");
  const newer = value(
    await s.workflow.prepareInvoice(s.actors.billing, s.ids.elm, input()),
  ).invoice.id;
  value(await s.workflow.confirmIssue(s.actors.billing, s.ids.elm, newer));
  await s.billing.issueInvoice(newer);
  const second = await s.billing.reconciliationPage({
    limit: 50,
    after: first.next,
    through: first.through,
  });
  const last = await s.billing.reconciliationPage({
    limit: 50,
    after: second.next,
    through: second.through,
  });
  expect([
    ...first.invoiceIds,
    ...second.invoiceIds,
    ...last.invoiceIds,
  ]).toEqual(ids);
  expect(last.next).toBeNull();
  expect(last.through).toEqual(first.through);
  const subsequent = await s.billing.reconciliationPage({ limit: 100 });
  const remaining = await s.billing.reconciliationPage({
    limit: 100,
    after: subsequent.next,
    through: subsequent.through,
  });
  expect(remaining.invoiceIds).toContain(newer);
  expect(subsequent.invoiceIds.length + remaining.invoiceIds.length).toBe(106);
}, 20000);
