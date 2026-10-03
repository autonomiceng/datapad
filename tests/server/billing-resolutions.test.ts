import { resumeEffects } from "./effects-fixture";
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
import { user, session, auditEntries } from "../../src/access/internal/schema";
import type { HumanActor } from "../../src/access/types";
import type { StaffRole } from "../../src/access/contract";
import { createCustomers, createCustomerRegistry } from "../../src/customers";
import type { Customers } from "../../src/customers/types";
import {
  createBilling,
  createBillingWorkflow,
  createInvoiceResolutions,
} from "../../src/billing";
import type { PrepareInvoiceRequest } from "../../src/billing/contract";
import { billingInvoiceResolutions } from "../../src/billing/internal/resolutions-schema";
import { invoices, stripeEvents } from "../../src/billing/internal/schema";
import type { ExternalPaymentRequest } from "../../src/billing/resolutions-contract";
import type { SyntheticInvoicePolicy } from "../../src/billing/types";
import { SyntheticBillingProvider } from "./billing-provider";
import { BillingProviderError } from "../../src/billing/provider";

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL is required");
const pool = new Pool({ connectionString: url, max: 2 });
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
  const provider = new SyntheticBillingProvider();
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
    resolutionProvider: provider,
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
    workflow: createBillingWorkflow(options),
    resolutions: createInvoiceResolutions({
      ...options,
      resolutionProvider: provider,
      workerId: "resolution-tests",
      allowResolution: (r) =>
        r.kind === "external_payment"
          ? r.input.reference === "Synthetic received funds"
          : r.input.reason === "Synthetic correction" ||
            r.input.reason === "Synthetic void",
    }),
    billing: createBilling(options),
    setDate: (date: string) => {
      now = new Date(date);
    },
  };
}

const receipt = (amountMinor = 1200): ExternalPaymentRequest => ({
  requestId: randomUUID(),
  amountMinor,
  receivedDate: "2030-01-01",
  method: "zelle",
  reference: "Synthetic received funds",
});
async function issued(s: Awaited<ReturnType<typeof setup>>) {
  const prepared = value(
    await s.workflow.prepareInvoice(s.actors.billing, s.ids.elm, input()),
  );
  const id = prepared.invoice.id;
  value(await s.workflow.confirmIssue(s.actors.billing, s.ids.elm, id));
  expect(await s.billing.issueInvoice(id)).toBe("complete");
  return id;
}
const stored = async (id: string) =>
  (
    await db
      .select()
      .from(billingInvoiceResolutions)
      .where(eq(billingInvoiceResolutions.id, id))
  )[0];
const correct = (s: Awaited<ReturnType<typeof setup>>, id: string) =>
  s.resolutions.flagReceiptCorrection(s.actors.billing, s.ids.elm, id, {
    requestId: randomUUID(),
    reason: "Synthetic correction",
  });
const record = (
  s: Awaited<ReturnType<typeof setup>>,
  id: string,
  data = receipt(),
) => s.resolutions.recordExternalPayment(s.actors.billing, s.ids.elm, id, data);

// Four grouped cases cover financial and authorization failures with the real audit writer and PostgreSQL.
test("resolution authority, ownership, exact remaining and audit atomicity guard received funds", async () => {
  const s = await setup();
  const id = await issued(s);
  for (const actor of [s.actors.admin, s.actors.member])
    expect(
      await s.resolutions.recordExternalPayment(
        actor,
        s.ids.elm,
        id,
        receipt(),
      ),
    ).toEqual({ ok: false, code: "forbidden" });
  expect(
    await s.resolutions.recordExternalPayment(
      s.actors.outsider,
      s.ids.elm,
      id,
      receipt(),
    ),
  ).toEqual({ ok: false, code: "not_found" });
  expect(
    await s.resolutions.recordExternalPayment(
      s.actors.billing,
      s.ids.birch,
      id,
      receipt(),
    ),
  ).toEqual({ ok: false, code: "not_found" });
  expect(
    await record(s, id, { ...receipt(), receivedDate: "2030-02-30" }),
  ).toEqual({ ok: false, code: "invalid_request" });
  const request = receipt(1199);
  const received = value(await record(s, id, request)).resolution;
  const unwired = createBilling({
    ...s.options,
    resolutionProvider: undefined,
  });
  const retrieves = s.provider.calls.retrieve;
  expect(await unwired.refreshInvoice(id)).toBe("retry");
  expect(s.provider.calls.retrieve).toBe(retrieves);
  const memberInvoice = await s.billing.getInvoiceForCustomers([s.ids.elm], id);
  expect(memberInvoice!.invoice.hostedInvoiceUrl).toBeNull();
  expect(JSON.stringify(memberInvoice)).not.toContain(request.reference);
  expect(await s.resolutions.processResolution(received.id)).toBe(
    "needs_review",
  );
  expect((await stored(received.id)).reviewReason).toBe("amount_mismatch");
  expect(s.provider.calls.settle).toBe(0);
  expect(await record(s, id, request)).toEqual({ ok: false, code: "conflict" });
  expect(
    await s.resolutions.requestVoid(s.actors.billing, s.ids.elm, id, {
      requestId: randomUUID(),
      reason: "Synthetic void",
    }),
  ).toEqual({ ok: false, code: "conflict" });
  const entries = await db
    .select()
    .from(auditEntries)
    .where(eq(auditEntries.targetId, received.id));
  expect(
    entries.filter((e) => e.action === "invoice.external_payment_recorded"),
  ).toHaveLength(1);
  expect((await stored(received.id)).reference).toBe(request.reference);
  const id2 = await issued(s);
  const failing = createInvoiceResolutions({
    ...s.options,
    resolutionProvider: s.provider,
    workerId: "resolution-tests",
    allowResolution: () => true,
    audit: {
      ...s.audit,
      append: async () => {
        throw new Error("Synthetic audit failure");
      },
    },
  });
  expect(
    await rejection(
      failing.recordExternalPayment(
        s.actors.billing,
        s.ids.elm,
        id2,
        receipt(),
      ),
    ),
  ).toBeInstanceOf(Error);
  expect(
    await db
      .select()
      .from(billingInvoiceResolutions)
      .where(eq(billingInvoiceResolutions.invoiceId, id2)),
  ).toHaveLength(0);
  expect(s.provider.calls.settle).toBe(0);

  const pending = value(await record(s, id2)).resolution;
  s.provider.afterResolution = () => {
    s.provider.unavailable = true;
  };
  expect(await s.resolutions.processResolution(pending.id)).toBe("retry");
  s.provider.unavailable = false;
  s.provider.afterResolution = null;
  let rejectAudit = true;
  const audited = createInvoiceResolutions({
    ...s.options,
    workerId: "configured-resolution-worker",
    allowResolution: () => true,
    audit: {
      ...s.audit,
      recordOperator: async (tx, entry) => {
        await s.audit.recordOperator(tx, entry);
        if (rejectAudit) throw new Error("Synthetic operator audit failure");
      },
    },
  });
  const review = () =>
    audited.getResolutionReview(s.actors.billing, s.ids.elm, id2);
  // Confirmation and both review paths must roll back their state and audit together.
  for (const transition of ["confirmation", "snapshot", "failure"]) {
    if (transition === "snapshot")
      s.provider.evidence(`in_${id2}`).overpaidMinor = 1200;
    if (transition === "failure")
      s.provider.collectionError = new BillingProviderError(
        "review",
        "provider_conflict",
      );
    s.setDate(
      `2030-01-01T12:0${transition === "confirmation" ? 1 : transition === "snapshot" ? 2 : 3}:00Z`,
    );
    const beforeResolution = await stored(pending.id);
    const beforeInvoice = await db
      .select()
      .from(invoices)
      .where(eq(invoices.id, id2));
    const beforeAudit = await db
      .select()
      .from(auditEntries)
      .where(eq(auditEntries.targetId, pending.id));
    rejectAudit = true;
    expect(value(await review()).blockers).toContain("provider_unavailable");
    expect(await stored(pending.id)).toEqual(beforeResolution);
    expect(
      await db.select().from(invoices).where(eq(invoices.id, id2)),
    ).toEqual(beforeInvoice);
    expect(
      await db
        .select()
        .from(auditEntries)
        .where(eq(auditEntries.targetId, pending.id)),
    ).toEqual(beforeAudit);
    rejectAudit = false;
    const result = value(await review()).resolution!;
    expect(result.state).toBe(
      transition === "confirmation" ? "confirmed" : "needs_review",
    );
    if (transition !== "confirmation")
      expect(result.reviewReason).toBe(
        transition === "snapshot"
          ? "possible_overpayment"
          : "collection_conflict",
      );
    const entries = await db
      .select()
      .from(auditEntries)
      .where(eq(auditEntries.targetId, pending.id));
    const added = entries.filter(
      (entry) => !beforeAudit.some((previous) => previous.id === entry.id),
    );
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      actorId: "configured-resolution-worker",
      action:
        transition === "confirmation"
          ? "invoice.resolution_confirmed"
          : "invoice.resolution_needs_review",
    });
  }
});

test("unattempted withdrawal preserves facts and processing-cleared recovery requires explicit current authority", async () => {
  const s = await setup();
  const id = await issued(s);
  const first = value(await record(s, id)).resolution;
  const evidence = s.provider.evidence(`in_${id}`);
  evidence.collectionState = "active";
  expect(await s.resolutions.processResolution(first.id)).toBe("needs_review");
  const before = await stored(first.id);
  expect(before.baselineRemainingMinor).toBe(1200);
  expect(value(await correct(s, id)).resolution.state).toBe("withdrawn");
  const withdrawn = await stored(first.id);
  expect(withdrawn.reference).toBe(before.reference);
  expect(withdrawn.attemptedAt).toBeNull();
  // A fresh review supersedes historical remaining, without rewriting the withdrawn receipt.
  evidence.collectionState = "idle";
  evidence.remainingMinor = 1000;
  evidence.paidMinor = 200;
  evidence.payments = [
    {
      invoicePaymentId: "inpay_intervening",
      paymentIntentId: "pi_intervening",
      providerPaymentMethodId: null,
      status: "paid",
      paidMinor: 200,
      intentState: "succeeded",
      receivedMinor: 200,
      capturableMinor: 0,
    },
  ];
  const fresh = value(
    await s.resolutions.getResolutionReview(s.actors.billing, s.ids.elm, id),
  );
  expect(fresh.remainingMinor).toBe(1000);
  expect(await stored(first.id)).toEqual(withdrawn);
  const inspections = s.provider.calls.inspect;
  expect(await record(s, id, receipt(1200))).toEqual({
    ok: false,
    code: "conflict",
  });
  const replacement = value(await record(s, id, receipt(1000))).resolution;
  expect(s.provider.calls.inspect).toBe(inspections);
  evidence.collectionState = "active";
  evidence.payments.push({
    invoicePaymentId: "inpay_pending",
    paymentIntentId: "pi_pending",
    providerPaymentMethodId: null,
    status: "open",
    paidMinor: null,
    intentState: "processing",
    receivedMinor: 0,
    capturableMinor: 0,
  });
  expect(await s.resolutions.processResolution(replacement.id)).toBe(
    "needs_review",
  );
  const baseline = (await stored(replacement.id)).baselineAt;
  evidence.collectionState = "idle";
  evidence.payments[1].intentState = "requires_payment_method";
  expect(await s.billing.refreshInvoice(id)).toBe("complete");
  expect((await stored(replacement.id)).state).toBe("needs_review");
  expect(
    await s.resolutions.reconcileResolution(s.actors.member, s.ids.elm, id, {
      requestId: randomUUID(),
    }),
  ).toEqual({ ok: false, code: "forbidden" });
  expect(
    value(
      await s.resolutions.reconcileResolution(s.actors.billing, s.ids.elm, id, {
        requestId: randomUUID(),
      }),
    ).resolution.state,
  ).toBe("pending");
  expect((await stored(replacement.id)).baselineAt).toBe(baseline);
  expect(await s.resolutions.processResolution(replacement.id)).toBe(
    "complete",
  );
  expect((await stored(replacement.id)).state).toBe("confirmed");
  expect(value(await correct(s, id)).resolution.state).toBe("needs_review");
  expect((await stored(replacement.id)).reviewReason).toBe(
    "receipt_correction",
  );
  expect(await record(s, id)).toEqual({ ok: false, code: "conflict" });
  const review = value(
    await s.resolutions.getResolutionReview(s.actors.billing, s.ids.elm, id),
  );
  expect(review.history.map((r) => r.state)).toContain("withdrawn");
  expect(review.actions).not.toContain("reconcile");
});

test("outages preserve assertions, lost responses recover one key and expiry bounds unknown attribution", async () => {
  const s = await setup();
  const id = await issued(s);
  s.provider.unavailable = true;
  const inspectCount = s.provider.calls.inspect;
  const received = value(await record(s, id)).resolution;
  expect(s.provider.calls.inspect).toBe(inspectCount);
  expect((await stored(received.id)).baselineAt).toBeNull();
  expect(await s.resolutions.processResolution(received.id)).toBe("retry");
  s.provider.unavailable = false;
  s.setDate("2030-01-01T12:00:10Z");
  s.provider.interrupt.add("settle");
  expect(await s.resolutions.processResolution(received.id)).toBe("retry");
  expect((await stored(received.id)).responseAt).toBeNull();
  s.setDate("2030-01-01T12:01:00Z");
  expect(await s.resolutions.processResolution(received.id)).toBe("complete");
  expect(new Set(s.provider.resolutionKeys).size).toBe(1);
  expect((await stored(received.id)).state).toBe("confirmed");
  const id2 = await issued(s);
  const received2 = value(await record(s, id2)).resolution;
  s.provider.interrupt.add("settle");
  expect(await s.resolutions.processResolution(received2.id)).toBe("retry");
  s.setDate("2030-01-02T11:02:00Z");
  const count = s.provider.calls.settle;
  expect(await s.resolutions.processResolution(received2.id)).toBe(
    "needs_review",
  );
  expect(s.provider.calls.settle).toBe(count);
  expect((await stored(received2.id)).reviewReason).toBe("uncertain_outcome");
  expect((await stored(received2.id)).reference).toBe(
    "Synthetic received funds",
  );
  const id3 = await issued(s);
  const received3 = value(await record(s, id3)).resolution;
  s.provider.afterResolution = () => {
    s.provider.unavailable = true;
  };
  expect(await s.resolutions.processResolution(received3.id)).toBe("retry");
  expect((await stored(received3.id)).responseAt).not.toBeNull();
  s.provider.unavailable = false;
  s.setDate("2030-01-02T11:03:00Z");
  const calls = s.provider.calls.settle;
  expect(await s.resolutions.processResolution(received3.id)).toBe("complete");
  expect(s.provider.calls.settle).toBe(calls);
});

test("hosted-payment races and late events preserve receipt facts, terminal state and exact void intent", async () => {
  const s = await setup();
  const id = await issued(s);
  const evidence = s.provider.evidence(`in_${id}`);
  // Existing successful electronic funds reduce the external remaining amount.
  evidence.remainingMinor = 1000;
  evidence.paidMinor = 200;
  evidence.payments = [
    {
      invoicePaymentId: "inpay_old",
      paymentIntentId: "pi_old",
      providerPaymentMethodId: null,
      status: "paid",
      paidMinor: 200,
      intentState: "succeeded",
      receivedMinor: 200,
      capturableMinor: 0,
    },
  ];
  const received = value(await record(s, id, receipt(1000))).resolution;
  expect(await s.resolutions.processResolution(received.id)).toBe("complete");
  evidence.payments.push({
    invoicePaymentId: "inpay_late",
    paymentIntentId: "pi_late",
    providerPaymentMethodId: null,
    status: "paid",
    paidMinor: 1000,
    intentState: "succeeded",
    receivedMinor: 1000,
    capturableMinor: 0,
  });
  evidence.overpaidMinor = 1000;
  evidence.paidMinor += 1000;
  const event = {
    ...s.provider.ownership,
    eventId: "evt_late_payment",
    eventType: "invoice.paid",
    providerInvoiceId: `in_${id}`,
    invoiceId: id,
    createdAt: "2030-01-01T12:00:00Z",
  };
  expect(await s.billing.acceptEvent(event)).toBe("accepted");
  s.provider.unavailable = true;
  expect(await s.billing.processEvent(event.eventId)).toBe("retry");
  expect(
    (
      await db
        .select()
        .from(stripeEvents)
        .where(eq(stripeEvents.eventId, event.eventId))
    )[0].processedAt,
  ).toBeNull();
  s.provider.unavailable = false;
  s.setDate("2030-01-01T12:01:00Z");
  expect(await s.billing.processEvent(event.eventId)).toBe("complete");
  expect((await stored(received.id)).reviewReason).toBe("possible_overpayment");
  expect((await stored(received.id)).confirmedAt).not.toBeNull();
  expect(
    (await db.select().from(invoices).where(eq(invoices.id, id)))[0]
      .providerStatus,
  ).toBe("paid");
  s.provider.invoices.get(`in_${id}`)!.status = "open";
  expect(await s.billing.refreshInvoice(id)).toBe("complete");
  const terminal = (
    await db.select().from(invoices).where(eq(invoices.id, id))
  )[0];
  expect(terminal.providerStatus).toBe("paid");
  expect(terminal.providerReceiptState).toBe("mismatch");
  const id2 = await issued(s);
  const voided = value(
    await s.resolutions.requestVoid(s.actors.billing, s.ids.elm, id2, {
      requestId: randomUUID(),
      reason: "Synthetic void",
    }),
  ).resolution;
  const originalVoid = await stored(voided.id);
  const voidEvidence = s.provider.evidence(`in_${id2}`);
  voidEvidence.collectionState = "active";
  expect(await s.resolutions.processResolution(voided.id)).toBe("needs_review");
  expect((await stored(voided.id)).attemptedAt).toBeNull();
  expect(s.provider.calls.void).toBe(0);
  expect(
    value(
      await s.resolutions.getResolutionReview(s.actors.billing, s.ids.elm, id2),
    ).actions,
  ).not.toContain("reconcile");
  expect(
    await s.resolutions.reconcileResolution(s.actors.billing, s.ids.elm, id2, {
      requestId: randomUUID(),
    }),
  ).toEqual({ ok: false, code: "conflict" });
  voidEvidence.collectionState = "idle";
  expect(
    value(
      await s.resolutions.getResolutionReview(s.actors.billing, s.ids.elm, id2),
    ).actions,
  ).toContain("reconcile");
  expect((await stored(voided.id)).state).toBe("needs_review");
  expect(
    await s.resolutions.reconcileResolution(s.actors.admin, s.ids.elm, id2, {
      requestId: randomUUID(),
    }),
  ).toEqual({ ok: false, code: "forbidden" });
  const resumedVoid = value(
    await s.resolutions.reconcileResolution(s.actors.billing, s.ids.elm, id2, {
      requestId: randomUUID(),
    }),
  ).resolution;
  expect(resumedVoid.id).toBe(originalVoid.id);
  expect(resumedVoid.state).toBe("pending");
  expect(await stored(voided.id)).toMatchObject({
    requestId: originalVoid.requestId,
    reason: originalVoid.reason,
    baselineAt: originalVoid.baselineAt,
    baselineRemainingMinor: originalVoid.baselineRemainingMinor,
    baselinePaidOffStripeMinor: originalVoid.baselinePaidOffStripeMinor,
    baselinePayments: originalVoid.baselinePayments,
    attemptedAt: null,
  });
  // Exhaustion before the effect stamp can only restart this same authorized intention.
  s.provider.unavailable = true;
  for (let attempt = 0; attempt < 5; attempt++) {
    s.setDate(
      `2030-01-01T12:${String(10 + attempt * 10).padStart(2, "0")}:00Z`,
    );
    expect(await s.resolutions.processResolution(voided.id)).toBe(
      attempt === 4 ? "needs_review" : "retry",
    );
  }
  expect(await stored(voided.id)).toMatchObject({
    attempts: 5,
    attemptedAt: null,
    reviewReason: "retry_exhausted",
  });
  s.provider.unavailable = false;
  expect(
    value(
      await s.resolutions.reconcileResolution(
        s.actors.billing,
        s.ids.elm,
        id2,
        { requestId: randomUUID() },
      ),
    ).resolution.id,
  ).toBe(originalVoid.id);
  expect(await stored(voided.id)).toMatchObject({
    attempts: 0,
    attemptedAt: null,
    requestId: originalVoid.requestId,
    baselineAt: originalVoid.baselineAt,
  });
  s.provider.interrupt.add("void");
  expect(await s.resolutions.processResolution(voided.id)).toBe("retry");
  s.setDate("2030-01-01T12:51:00Z");
  expect(await s.resolutions.processResolution(voided.id)).toBe("complete");
  expect((await stored(voided.id)).state).toBe("confirmed");
  expect(
    (await db.select().from(invoices).where(eq(invoices.id, id2)))[0]
      .providerStatus,
  ).toBe("void");
  expect(await record(s, id2)).toEqual({ ok: false, code: "conflict" });
  const confirmedVoid = await stored(voided.id);
  s.provider.collectionError = new BillingProviderError(
    "review",
    "provider_conflict",
  );
  const voidReview = value(
    await s.resolutions.getResolutionReview(s.actors.billing, s.ids.elm, id2),
  );
  expect(voidReview.resolution?.state).toBe("needs_review");
  expect(voidReview.blockers).toContain("collection_conflict");
  expect(voidReview.blockers).not.toContain("provider_unavailable");
  expect((await stored(voided.id)).confirmedAt).toBe(confirmedVoid.confirmedAt);
  expect(
    (await db.select().from(invoices).where(eq(invoices.id, id2)))[0]
      .providerStatus,
  ).toBe("void");
  s.provider.collectionError = null;
  const attemptedVoid = await stored(voided.id);
  expect(
    value(
      await s.resolutions.getResolutionReview(s.actors.billing, s.ids.elm, id2),
    ).actions,
  ).not.toContain("reconcile");
  const voidCalls = s.provider.calls.void;
  expect(
    await s.resolutions.reconcileResolution(s.actors.billing, s.ids.elm, id2, {
      requestId: randomUUID(),
    }),
  ).toEqual({ ok: false, code: "conflict" });
  expect(await stored(voided.id)).toMatchObject({
    state: "needs_review",
    attemptedAt: attemptedVoid.attemptedAt,
    attempts: attemptedVoid.attempts,
    baselineAt: originalVoid.baselineAt,
    requestId: originalVoid.requestId,
    confirmedAt: confirmedVoid.confirmedAt,
  });
  expect(s.provider.calls.void).toBe(voidCalls);
  expect(
    new Set(s.provider.resolutionKeys.filter((key) => key.includes(voided.id))),
  ).toEqual(new Set([`datapad:billing-test:resolution:${voided.id}:void`]));
  const id3 = await issued(s);
  const raced = value(await record(s, id3)).resolution;
  s.provider.afterResolution = () => {
    const raceEvidence = s.provider.evidence(`in_${id3}`);
    raceEvidence.payments.push({
      invoicePaymentId: "inpay_race",
      paymentIntentId: "pi_race",
      providerPaymentMethodId: null,
      status: "paid",
      paidMinor: 1200,
      intentState: "succeeded",
      receivedMinor: 1200,
      capturableMinor: 0,
    });
    raceEvidence.overpaidMinor = 1200;
    raceEvidence.paidMinor += 1200;
  };
  expect(await s.resolutions.processResolution(raced.id)).toBe("needs_review");
  expect((await stored(raced.id)).reviewReason).toBe("possible_overpayment");
  expect((await stored(raced.id)).responseAt).not.toBeNull();
  expect((await stored(raced.id)).amountMinor).toBe(1200);
  s.provider.afterResolution = null;
  const id4 = await issued(s);
  const late = value(await record(s, id4)).resolution;
  expect(await s.resolutions.processResolution(late.id)).toBe("complete");
  const confirmed = await stored(late.id);
  const lateEvent = {
    ...event,
    eventId: "evt_definitive_collection",
    providerInvoiceId: `in_${id4}`,
    invoiceId: id4,
  };
  expect(await s.billing.acceptEvent(lateEvent)).toBe("accepted");
  s.provider.collectionError = new BillingProviderError(
    "review",
    "provider_conflict",
  );
  expect(await s.billing.processEvent(lateEvent.eventId)).toBe("needs_review");
  const held = await stored(late.id);
  expect(held.state).toBe("needs_review");
  expect(held.reviewReason).toBe("collection_conflict");
  expect(held.confirmedAt).toBe(confirmed.confirmedAt);
  expect(held.responseAt).toBe(confirmed.responseAt);
  expect(held.baselinePayments).toEqual(confirmed.baselinePayments);
  expect(held.reference).toBe(confirmed.reference);
  const financial = (
    await db.select().from(invoices).where(eq(invoices.id, id4))
  )[0];
  expect(financial.providerStatus).toBe("paid");
  expect(financial.state).toBe("paid");
  expect(financial.providerReceiptState).toBe("verified");
  const member = (await s.billing.getInvoiceForCustomers([s.ids.elm], id4))!;
  expect(member.invoice.resolution?.state).toBe("needs_review");
  expect(member.invoice.hostedInvoiceUrl).toBeNull();
  const operatorEntries = await db
    .select()
    .from(auditEntries)
    .where(eq(auditEntries.targetId, late.id));
  expect(
    operatorEntries.filter(
      (entry) => entry.action === "invoice.resolution_needs_review",
    ),
  ).toHaveLength(1);
  const staffReview = value(
    await s.resolutions.getResolutionReview(s.actors.billing, s.ids.elm, id4),
  );
  expect(staffReview.resolution?.reviewReason).toBe("collection_conflict");
  const repeatedEntries = await db
    .select()
    .from(auditEntries)
    .where(eq(auditEntries.targetId, late.id));
  expect(
    repeatedEntries.filter(
      (entry) => entry.action === "invoice.resolution_needs_review",
    ),
  ).toHaveLength(1);
  await s.resolutions.assertSyntheticData();
});
