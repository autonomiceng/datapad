import { billingPaymentSetups } from "../../src/billing/internal/payment-settings-schema";
import {
  BillingProviderError,
  type PaymentSettingsProvider,
} from "../../src/billing/provider";
import { createBillingWorker } from "../../src/worker";
import { afterAll, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { createAuditWriter } from "../../src/access";
import { createPolicy } from "../../src/access/internal/policy";
import { staffGrants, session } from "../../src/access/internal/schema";
import {
  createBilling,
  createBillingOperations,
  createFinancialEffectGuard,
  createPaymentSettings,
} from "../../src/billing";
import { createInvoiceNoticeOperationsReader } from "../../src/notifications";
import { createCustomerRegistry } from "../../src/customers";
import type { AccessResult } from "../../src/access/types";
import { effectsActor, effectsOperations } from "./effects-fixture";
import { SyntheticBillingProvider } from "./billing-provider";

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL is required");
const pool = new Pool({ connectionString: url, max: 6 });
const db = drizzle(pool);
const clear = () =>
  pool.query(
    'TRUNCATE customers, "user", organization, verification, access_audit, access_commands, billing_effect_controls CASCADE',
  );
beforeEach(clear);
afterAll(async () => {
  await clear();
  await pool.end();
});
const value = <T>(result: AccessResult<T>) => {
  if (!result.ok) throw new Error(result.code);
  return result.value;
};
async function fixture(deploymentKey = "billing-test") {
  const provider = new SyntheticBillingProvider();
  provider.ownership.deploymentKey = deploymentKey;
  let time = new Date("2030-01-01T12:00:00Z");
  const billing = createBilling({
    pool,
    provider,
    deploymentKey,
    now: () => time,
    customers: createCustomerRegistry({
      operatorId: "synthetic-effects",
      audit: createAuditWriter(),
      allowProfile: () => true,
    }),
  });
  const actor = await effectsActor(pool);
  const operations = createBillingOperations({
    pool,
    deploymentKey,
    access: createPolicy(pool),
    audit: createAuditWriter(),
    notices: createInvoiceNoticeOperationsReader({
      deploymentKey,
    }),
    reconciliation: {
      inspectCustomer: (id) => billing.inspectCustomer(id),
      inspectInvoice: (id) => billing.inspectInvoice(id),
      inspectSetup: async () => {
        throw new Error("Unexpected setup read");
      },
      inspectResolution: async () => {
        throw new Error("Unexpected resolution read");
      },
      reconcileCollection: async () => {
        throw new Error("Unexpected collection read");
      },
    },
  });
  const request = async () => {
    const result = await billing.requestInvoice({
      originKey: randomUUID(),
      customer: { key: randomUUID(), name: "Synthetic customer" },
      issueDate: "2030-01-01",
      dueDate: "2030-01-22",
      currency: "USD",
      lines: [
        {
          description: "Synthetic service",
          amountMinor: 1200,
          originRef: null,
        },
      ],
    });
    if (result.kind !== "created") throw new Error("Fixture request failed");
    await billing.requestIssue(result.invoiceId);
    return result.invoiceId;
  };
  const change = async (paused: boolean) => {
    const current = value(await operations.getOperations(actor));
    return value(
      await operations.setEffectsPaused(actor, {
        requestId: randomUUID(),
        expectedVersion: current.control.version,
        paused,
        reason: "Synthetic operator decision",
      }),
    );
  };
  return {
    actor,
    operations,
    billing,
    provider,
    request,
    change,
    advance: (ms: number) => {
      time = new Date(time.getTime() + ms);
    },
  };
}

test("operations authority, exact scope, revocation and atomic request/outcome audit", async () => {
  const s = await fixture();
  const input = {
    requestId: randomUUID(),
    expectedVersion: 0,
    paused: false,
    reason: "Enable synthetic fixture",
  };
  for (const roles of [["support"], ["account_administrator"], []] as const) {
    const actor = await effectsActor(pool, [...roles]);
    expect(await s.operations.getOperations(actor)).toEqual({
      ok: false,
      code: "forbidden",
    });
    expect(await s.operations.setEffectsPaused(actor, input)).toEqual({
      ok: false,
      code: "forbidden",
    });
    expect(
      await s.operations.checkStatus(actor, {
        requestId: randomUUID(),
        effect: {
          kind: "invoice",
          customerId: randomUUID(),
          effectId: randomUUID(),
        },
      }),
    ).toEqual({ ok: false, code: "forbidden" });
  }
  const failing = createBillingOperations({
    pool,
    deploymentKey: "billing-test",
    access: createPolicy(pool),
    audit: {
      ...createAuditWriter(),
      recordBillingOperation: async () => {
        throw new Error("Synthetic audit failure");
      },
    },
    notices: createInvoiceNoticeOperationsReader({
      deploymentKey: "billing-test",
    }),
    reconciliation: null,
  });
  const auditFailure = await failing.setEffectsPaused(s.actor, input).then(
    () => null,
    (error: unknown) => error,
  );
  expect(auditFailure).toBeInstanceOf(Error);
  expect(
    value(await s.operations.getOperations(s.actor)).control,
  ).toMatchObject({ paused: true, version: 0 });
  value(await s.operations.setEffectsPaused(s.actor, input));
  expect(
    await s.operations.setEffectsPaused(s.actor, { ...input, paused: true }),
  ).toEqual({ ok: false, code: "conflict" });
  expect(
    await s.operations.setEffectsPaused(s.actor, {
      ...input,
      requestId: randomUUID(),
    }),
  ).toEqual({ ok: false, code: "conflict" });
  const id = await s.request();
  s.provider.createInvoice = async () => {
    s.provider.calls.invoice++;
    throw new Error("Synthetic request never arrived");
  };
  expect(await s.billing.issueInvoice(id)).toBe("retry");
  const detail = (await s.billing.getInvoice(id))!.invoice;
  const effect = {
    kind: "invoice" as const,
    customerId: detail.customer.id,
    effectId: id,
  };
  const writes = { ...s.provider.calls };
  expect(
    await s.operations.checkStatus(s.actor, {
      requestId: randomUUID(),
      effect: { ...effect, customerId: randomUUID() },
    }),
  ).toEqual({ ok: false, code: "not_found" });
  const foreign = effectsOperations(pool, "another-deployment");
  expect(
    await foreign.checkStatus(s.actor, { requestId: randomUUID(), effect }),
  ).toEqual({ ok: false, code: "not_found" });
  await pool.query(
    "update invoices set state='needs_review',review_reason='uncertain_invoice' where id=$1",
    [id],
  );
  const command = { requestId: randomUUID(), effect };
  s.provider.findInvoice = async () => {
    expect(
      (
        await pool.query(
          "select count(*)::int as n from access_audit where request_id=$1 and action='billing.status_requested'",
          [command.requestId],
        )
      ).rows[0].n,
    ).toBe(1);
    return { kind: "absent" };
  };
  expect(value(await s.operations.checkStatus(s.actor, command)).outcome).toBe(
    "retry",
  );
  expect(value(await s.operations.checkStatus(s.actor, command)).outcome).toBe(
    "retry",
  );
  expect(s.provider.calls).toEqual(writes);
  expect(
    (await pool.query("select state from invoices where id=$1", [id])).rows[0]
      .state,
  ).toBe("needs_review");
  expect(
    (
      await pool.query(
        "select count(*)::int as n from access_audit where details->>'commandRequestId'=$1",
        [command.requestId],
      )
    ).rows[0].n,
  ).toBe(1);
  const page = value(await s.operations.getOperations(s.actor));
  expect(page.operations.some((r) => r.effect.effectId === id)).toBe(true);
  expect(JSON.stringify(page)).not.toMatch(
    /acct_|cus_|idempotency|requestDigest/,
  );
  // Repeated explicit setup checks cannot spend automatic recovery during an outage.
  const setupId = randomUUID();
  const mappingId: string = (
    await pool.query("select billing_customer_id from invoices where id=$1", [
      id,
    ])
  ).rows[0].billing_customer_id;
  await db.insert(billingPaymentSetups).values({
    id: setupId,
    customerId: detail.customer.id,
    deploymentKey: "billing-test",
    billingCustomerId: mappingId,
    providerAccountId: s.provider.ownership.accountId,
    requestId: randomUUID(),
    requestDigest: "synthetic-request-digest",
    actorUserId: s.actor.userId,
    actorSessionId: s.actor.sessionId,
    consentingMembershipId: "synthetic-membership",
    membershipProvenance: {
      invitationId: null,
      invitedByUserId: null,
      invitedByStaff: null,
    },
    saveTermsVersion: "synthetic-terms",
    saveTermsDigest: "synthetic-terms-digest",
    acceptedAt: "2030-01-01T11:00:00Z",
    createAttemptedAt: "2030-01-01T11:01:00Z",
    successUrl: "http://localhost/payment-settings/return",
    cancelUrl: "http://localhost/payment-settings/return",
    integrationIdentifier: "datapad_setup_abcdefgh",
    providerSessionId: "cs_synthetic_recovery",
    checkoutUrl: "https://checkout.stripe.com/c/pay/cs_synthetic_recovery",
    status: "pending",
    attempts: 2,
    nextAttemptAt: "2030-01-01T11:59:00Z",
    retrievalRequestedAt: "2030-01-01T11:30:00Z",
    lastCheckedAt: "2030-01-01T11:31:00Z",
  });
  let setupReads = 0,
    cardReads = 0,
    setupWrites = 0,
    definitiveSetupFailure = false;
  const setupProvider: PaymentSettingsProvider = {
    ownership: s.provider.ownership,
    async createSetup() {
      setupWrites++;
      throw new Error("Status check attempted a write");
    },
    async findSetup() {
      throw new Error("Expected recorded Session retrieval");
    },
    async retrieveSetup(expected, providerSessionId) {
      setupReads++;
      if (definitiveSetupFailure)
        throw new BillingProviderError("review", "ownership_mismatch");
      if (setupReads <= 3)
        throw new Error("Synthetic Session retrieval outage");
      return {
        ...expected,
        providerSessionId,
        livemode: false,
        status: "complete",
        checkoutUrl: null,
        setupIntent: {
          providerSetupIntentId: "seti_synthetic_recovery",
          deploymentKey: expected.deploymentKey,
          setupId: expected.setupId,
          providerCustomerId: expected.providerCustomerId,
          livemode: false,
          status: "succeeded",
          usage: "off_session",
          providerPaymentMethodId: "pm_synthetic_recovery",
        },
      };
    },
    async retrieveSavedMethod() {
      cardReads++;
      throw new Error("Synthetic saved-card retrieval outage");
    },
  };
  const settings = createPaymentSettings({
    pool,
    deploymentKey: "billing-test",
    providerOwnership: setupProvider.ownership,
    provider: setupProvider,
    customerAccess: {
      async authorizeCustomer() {
        throw new Error("Inspection uses operations staff authorization");
      },
      async readProfile() {
        throw new Error("Inspection uses persisted setup intent");
      },
    },
    audit: createAuditWriter(),
    allowProfile: () => true,
    allowMappingName: () => true,
    allowSubscription: () => true,
    successUrl: "http://localhost/payment-settings/return",
    cancelUrl: "http://localhost/payment-settings/return",
    async ensureCustomerReceipt() {
      setupWrites++;
      throw new Error("Inspection must use the existing customer receipt");
    },
    now: () => new Date("2030-01-01T12:00:00Z"),
  });
  const setupOperations = createBillingOperations({
    pool,
    deploymentKey: "billing-test",
    access: createPolicy(pool),
    audit: createAuditWriter(),
    notices: createInvoiceNoticeOperationsReader({
      deploymentKey: "billing-test",
    }),
    reconciliation: {
      inspectCustomer: (mappingId) => s.billing.inspectCustomer(mappingId),
      inspectInvoice: (invoiceId) => s.billing.inspectInvoice(invoiceId),
      inspectSetup: (setupId) => settings.inspectSetup(setupId),
      async inspectResolution() {
        throw new Error("Unexpected resolution inspection");
      },
      async reconcileCollection() {
        throw new Error("Unexpected collection inspection");
      },
    },
  });
  await s.change(true);
  const savedSetup = (
    await db
      .select()
      .from(billingPaymentSetups)
      .where(eq(billingPaymentSetups.id, setupId))
  )[0];
  const checkSetup = () =>
    setupOperations.checkStatus(s.actor, {
      requestId: randomUUID(),
      effect: {
        kind: "setup",
        customerId: detail.customer.id,
        effectId: setupId,
      },
    });
  for (let check = 0; check < 5; check++) {
    expect(value(await checkSetup()).outcome).toBe("retry");
    expect(
      (
        await db
          .select()
          .from(billingPaymentSetups)
          .where(eq(billingPaymentSetups.id, setupId))
      )[0],
    ).toEqual(savedSetup);
  }
  expect({ setupReads, cardReads, setupWrites }).toEqual({
    setupReads: 5,
    cardReads: 2,
    setupWrites: 0,
  });
  expect((await settings.pendingSetups()).work).toContainEqual({
    kind: "payment_setup",
    setupId,
  });
  expect(
    (
      await pool.query(
        "select action,count(*)::int as n from access_audit where target_id=$1 group by action order by action",
        [setupId],
      )
    ).rows,
  ).toEqual([
    { action: "billing.status_checked", n: 5 },
    { action: "billing.status_requested", n: 5 },
  ]);
  definitiveSetupFailure = true;
  expect(value(await checkSetup()).outcome).toBe("needs_review");
  expect(
    (
      await db
        .select()
        .from(billingPaymentSetups)
        .where(eq(billingPaymentSetups.id, setupId))
    )[0],
  ).toMatchObject({
    status: "needs_review",
    createAttemptedAt: savedSetup.createAttemptedAt,
  });
  s.provider.findInvoice = async () => {
    await db.delete(staffGrants).where(eq(staffGrants.userId, s.actor.userId));
    return { kind: "absent" };
  };
  expect(
    await s.operations.checkStatus(s.actor, {
      requestId: randomUUID(),
      effect,
    }),
  ).toEqual({ ok: false, code: "forbidden" });
  expect(await s.operations.setEffectsPaused(s.actor, input)).toEqual({
    ok: false,
    code: "forbidden",
  });
  await db.delete(session).where(eq(session.id, s.actor.sessionId));
  expect(await s.operations.getOperations(s.actor)).toEqual({
    ok: false,
    code: "unauthenticated",
  });
});

test("pause defaults, explicit resume, in-flight stamp serialization and bounded replay", async () => {
  const s = await fixture(),
    id = await s.request();
  expect(await s.billing.issueInvoice(id)).toBe("retry");
  expect(s.provider.calls.customer).toBe(0);
  expect(
    (await pool.query("select create_attempted_at from billing_customers"))
      .rows[0].create_attempted_at,
  ).toBeNull();
  expect((await s.billing.pendingWork({ limit: 1 })).work).toEqual([]);
  const resume = {
    requestId: randomUUID(),
    expectedVersion: 0,
    paused: false,
    reason: "Explicit synthetic resume",
  };
  expect(
    value(await s.operations.setEffectsPaused(s.actor, resume)).control.version,
  ).toBe(1);
  s.advance(30000);
  s.provider.onCreate = async () => {
    await s.change(true);
  };
  expect(await s.billing.issueInvoice(id)).toBe("retry");
  expect(s.provider.calls.line).toBe(0);
  expect(
    (
      await pool.query(
        "select create_attempted_at from invoice_lines where invoice_id=$1",
        [id],
      )
    ).rows[0].create_attempted_at,
  ).toBeNull();
  expect(
    value(await s.operations.setEffectsPaused(s.actor, resume)).control.paused,
  ).toBe(true);
  s.provider.onCreate = null;
  await s.request();
  s.advance(30000);
  expect((await s.billing.pendingWork({ limit: 1 })).work).toEqual([
    { kind: "issue", invoiceId: id },
  ]);
  await s.change(false);
  const finalize = s.provider.finalizeInvoice.bind(s.provider);
  s.provider.finalizeInvoice = async () => {
    s.provider.calls.finalize++;
    throw new Error("Synthetic finalize did not arrive");
  };
  expect(await s.billing.issueInvoice(id)).toBe("retry");
  await s.change(true);
  const before = (
    await pool.query(
      "select attempts, finalize_attempted_at from invoices where id=$1",
      [id],
    )
  ).rows[0];
  s.advance(6000);
  const writes = s.provider.calls.finalize;
  expect(await s.billing.issueInvoice(id)).toBe("retry");
  expect(s.provider.calls.finalize).toBe(writes);
  expect(
    (
      await pool.query(
        "select attempts, finalize_attempted_at from invoices where id=$1",
        [id],
      )
    ).rows[0],
  ).toEqual(before);
  s.advance(23 * 60 * 60 * 1000);
  expect(await s.billing.issueInvoice(id)).toBe("needs_review");
  expect(s.provider.calls.finalize).toBe(writes);
  s.provider.finalizeInvoice = finalize;

  await s.change(false);
  const guard = createFinancialEffectGuard("billing-test");
  let release!: () => void, stamped!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    stamped = resolve;
  });
  const stamping = db.transaction(async (tx) => {
    expect(await guard.assertMayStart(tx)).toBe("allowed");
    stamped();
    await held;
  });
  await entered;
  let pauseFinished = false;
  const pausing = s.change(true).then(() => {
    pauseFinished = true;
  });
  // A separate observer sees the exclusive control lock waiting for the stamp commit.
  for (let n = 0; n < 100; n++) {
    const waiting = await pool.query(
      "select 1 from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like '%billing_effect_controls%' and pid<>pg_backend_pid()",
    );
    if (waiting.rowCount) break;
    if (n === 99) throw new Error("Pause did not wait for the guard holder");
  }
  expect(pauseFinished).toBe(false);
  release();
  await stamping;
  await pausing;
  expect(await db.transaction((tx) => guard.assertMayStart(tx))).toBe("paused");

  // A provider invocation whose stamp committed can finish; its next effect cannot start.
  await s.change(false);
  const next = await s.request();
  const add = s.provider.addLine.bind(s.provider);
  s.provider.addLine = async (...args) => {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(
        "select id from invoice_lines where invoice_id=$1 for update nowait",
        [next],
      );
      await client.query("rollback");
    } finally {
      client.release();
    }
    await s.change(true);
    return add(...args);
  };
  const beforeFinalize = s.provider.calls.finalize;
  expect(await s.billing.issueInvoice(next)).toBe("retry");
  expect(s.provider.calls.finalize).toBe(beforeFinalize);
  expect(
    (
      await pool.query(
        "select provider_line_id, create_attempted_at from invoice_lines where invoice_id=$1",
        [next],
      )
    ).rows[0].provider_line_id,
  ).not.toBeNull();
  // One bounded mixed pass survives a permanently failing first item and discovers new work next pass.
  const fair = await fixture("pending-page-test");
  await fair.change(false);
  fair.provider.createInvoice = async () => {
    throw new Error("Synthetic missing response");
  };
  const firstInvoice = await fair.request();
  await fair.billing.issueInvoice(firstInvoice);
  fair.advance(1000);
  const event = (eventId: string) => ({
    ...fair.provider.ownership,
    invoiceId: firstInvoice,
    providerInvoiceId: `in_${firstInvoice}`,
    eventId,
    eventType: "invoice.paid",
    createdAt: "2030-01-01T12:00:01Z",
  });
  await fair.billing.acceptEvent(event("evt_finite_pass"));
  fair.advance(1000);
  const lastInvoice = await fair.request();
  await fair.billing.issueInvoice(lastInvoice);
  fair.advance(30000);
  await fair.change(true);
  const stamps = await pool.query(
    "select id,attempts,create_attempted_at,finalize_attempted_at from invoices where deployment_key='pending-page-test' order by id",
  );
  const firstPage = await fair.billing.pendingWork({ limit: 1 });
  expect(firstPage.work).toEqual([{ kind: "issue", invoiceId: firstInvoice }]);
  expect(firstPage.next).not.toBeNull();
  fair.advance(1000);
  await fair.billing.acceptEvent(event("evt_next_pass"));
  const middlePage = await fair.billing.pendingWork({
    limit: 1,
    after: firstPage.next,
    through: firstPage.through,
  });
  expect(middlePage.work).toEqual([
    { kind: "event", eventId: "evt_finite_pass" },
  ]);
  const lastPage = await fair.billing.pendingWork({
    limit: 1,
    after: middlePage.next,
    through: firstPage.through,
  });
  expect(lastPage.work).toEqual([{ kind: "issue", invoiceId: lastInvoice }]);
  expect(lastPage.next).toBeNull();
  expect(lastPage.through).toEqual(firstPage.through);
  expect((await fair.billing.pendingWork({ limit: 10 })).work).toContainEqual({
    kind: "event",
    eventId: "evt_next_pass",
  });

  type Work = Parameters<
    Awaited<ReturnType<typeof createBillingWorker>>["enqueue"]
  >[0];
  const deliveries: Work[] = [];
  let reports = 0,
    resolutionReads = 0,
    setupReads = 0,
    stoppedQueue = false;
  const resolutionId = randomUUID(),
    setupId = randomUUID();
  const worker = await createBillingWorker({
    databaseUrl: url!,
    queue: {
      on() {},
      async start() {},
      async createQueue() {},
      async work() {},
      async stop() {
        stoppedQueue = true;
      },
      async send(_name, work) {
        deliveries.push(work);
        if (
          (work.kind === "issue" && work.invoiceId === firstInvoice) ||
          work.kind === "resolution"
        )
          throw new Error("Synthetic enqueue failure");
      },
    },
    billing: {
      pendingWork: (input) => fair.billing.pendingWork({ ...input, limit: 1 }),
      issueInvoice: (id) => fair.billing.issueInvoice(id),
      processEvent: (id) => fair.billing.processEvent(id),
    },
    scheduled: {
      async sweepScheduled() {
        throw new Error("Synthetic discovery failure");
      },
    },
    resolutions: {
      async pendingResolutions() {
        if (++resolutionReads === 1)
          throw new Error("Synthetic resolution discovery failure");
        return {
          work: [{ kind: "resolution", resolutionId }],
          next: null,
          through: null,
        };
      },
      async processResolution() {
        throw new Error("No queue handler executes in this boundary check");
      },
    },
    paymentSettings: {
      async pendingSetups() {
        if (++setupReads === 2)
          throw new Error("Synthetic setup discovery failure");
        return {
          work: [{ kind: "payment_setup", setupId }],
          next: null,
          through: null,
        };
      },
      async processSetup() {
        throw new Error("No queue handler executes in this boundary check");
      },
    },
    onError: () => {
      reports++;
    },
  });
  try {
    // Initial sweep failed the first invoice and one kind's discovery; setup still reached enqueue.
    expect(deliveries).toContainEqual({ kind: "payment_setup", setupId });
    await worker.sweep(); // setup discovery and resolution enqueue fail; the event still advances.
    await worker.sweep(); // the later invoice is reached despite the untouched first invoice.
    await worker.sweep(); // fixed upper bound completes at the later event.
    await worker.sweep(); // reset rediscovers the first failed invoice.
    const billingDeliveries = deliveries.filter(
      (work) => work.kind === "issue" || work.kind === "event",
    );
    expect(billingDeliveries).toEqual([
      { kind: "issue", invoiceId: firstInvoice },
      { kind: "event", eventId: "evt_finite_pass" },
      { kind: "issue", invoiceId: lastInvoice },
      { kind: "event", eventId: "evt_next_pass" },
      { kind: "issue", invoiceId: firstInvoice },
    ]);
    expect(
      deliveries.filter((work) => work.kind === "payment_setup"),
    ).toHaveLength(4);
    expect(reports).toBe(13);
    expect(
      (
        await pool.query(
          "select id,attempts,create_attempted_at,finalize_attempted_at from invoices where deployment_key='pending-page-test' order by id",
        )
      ).rows,
    ).toEqual(stamps.rows);
  } finally {
    await worker.stop();
  }
  expect(stoppedQueue).toBe(true);
});
