import { createHash, randomUUID } from "node:crypto";
import canonicalize from "canonicalize";
import type { Pool } from "pg";
import { and, asc, desc, eq, ne, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { BillingProviderError, type CollectionPayRequest } from "../provider";
import type {
  InvoiceCollections,
  InvoiceCollectionsOptions,
} from "../collection-types";
import type {
  CollectionDisposition,
  CollectionReason,
  InvoiceCollection,
} from "../collection-contract";
import type { WorkResult } from "../types";
import { createInvoiceContext, type StoredInvoice } from "./invoice-context";
import { invoices } from "./invoice-schema";
import { billingPaymentAttempts as attempts } from "./collection-schema";
import { billingInvoiceGroups as groups } from "./scheduled-schema";
import { billingPeriods as periods } from "./subscriptions-schema";
import {
  billingEnrollments as enrollments,
  billingPaymentMethods as methods,
  billingPaymentSetups as setups,
} from "./payment-settings-schema";
import { billingInvoiceResolutions as resolutions } from "./resolutions-schema";
import {
  currentEnrollment,
  enrollmentView,
  covers,
} from "./payment-enrollment";
import { paymentSetupIntent, usableCard } from "./payment-setup";
import { lockSubscriptionCustomer } from "./subscription-lock";
import {
  reconcileResolutionSnapshot,
  reconcileResolutionFailure,
} from "./resolutions";
import {
  reconcileCollectionSnapshot,
  reconcileCollectionFailure,
  reviewCollectionAttempt,
  recordCollectionResponse,
  collectionBaselineUnchanged,
} from "./collection-observation";
import { isUuid } from "./validate";
type Attempt = typeof attempts.$inferSelect;
const digest = (value: unknown) =>
  createHash("sha256").update(canonicalize(value)!).digest("hex");
const equal = (a: unknown, b: unknown) => canonicalize(a) === canonicalize(b);
const lifetime = 23 * 60 * 60 * 1000;
const observationInterval = 60000;
const delays = [5000, 30000, 120000, 600000];
const iso = (value: string | null) =>
  value === null ? null : new Date(value).toISOString();
const cutoff = (dueEndAt: string, business: Date, wall: Date) =>
  Math.max(business.getTime(), wall.getTime()) >= Date.parse(dueEndAt);
const fresh = (start: Date, end: Date, now: Date) =>
  start.getTime() <= end.getTime() &&
  end.getTime() <= now.getTime() &&
  now.getTime() - start.getTime() <= 5000;
function mismatch(): never {
  throw new BillingProviderError("review", "invoice_mismatch", true);
}
async function attemptFor(tx: NodePgDatabase, invoiceId: string) {
  const [row] = await tx
    .select()
    .from(attempts)
    .where(eq(attempts.invoiceId, invoiceId));
  return row ?? null;
}
async function resolutionFor(tx: NodePgDatabase, invoiceId: string) {
  const [row] = await tx
    .select()
    .from(resolutions)
    .where(
      and(
        eq(resolutions.invoiceId, invoiceId),
        ne(resolutions.state, "withdrawn"),
      ),
    );
  return row ?? null;
}
/** Explicit claims establish authority; line origin strings only verify that relation. */
async function collectionFacts(tx: NodePgDatabase, record: StoredInvoice) {
  const [group] = await tx
    .select()
    .from(groups)
    .where(eq(groups.invoiceId, record.invoice.id));
  if (!group) return null;
  if (
    group.customerId !== record.customer.customerId ||
    group.deploymentKey !== record.invoice.deploymentKey ||
    group.billingCustomerId !== record.customer.id ||
    group.outcome !== "invoice_requested" ||
    group.totalMinor !== record.invoice.totalMinor ||
    group.dueDate !== record.invoice.dueDate ||
    group.currency !== "USD" ||
    !equal(group.calendar, record.invoice.calendar)
  )
    mismatch();
  const claimed = await tx
    .select()
    .from(periods)
    .where(eq(periods.invoiceGroupId, group.id));
  if (!claimed.length || claimed.length !== record.lines.length) mismatch();
  const first = claimed[0];
  if (
    !first.chargeAt ||
    !first.dueEndAt ||
    Date.parse(first.chargeAt) >= Date.parse(first.dueEndAt) ||
    Date.parse(first.dueEndAt) !== Date.parse(record.invoice.dueEndAt)
  )
    mismatch();
  if (
    claimed.some(
      (p) =>
        p.customerId !== group.customerId ||
        p.deploymentKey !== group.deploymentKey ||
        !p.sealedAt ||
        p.billingState !== "billable" ||
        p.paymentArrangement !== group.paymentArrangement ||
        p.currency !== group.currency ||
        p.dueDate !== group.dueDate ||
        !equal(p.calendar, group.calendar) ||
        !p.chargeAt ||
        !p.dueEndAt ||
        Date.parse(p.chargeAt) !== Date.parse(first.chargeAt!) ||
        Date.parse(p.dueEndAt) !== Date.parse(first.dueEndAt!),
    )
  )
    mismatch();
  const origins = new Set(record.lines.map((l) => l.originRef));
  if (
    origins.size !== claimed.length ||
    !claimed.every((p) =>
      record.lines.some(
        (l) =>
          l.originRef === p.id &&
          l.description === p.label &&
          l.amountMinor === p.amountMinor,
      ),
    )
  )
    mismatch();
  const current = await currentEnrollment(
    tx,
    group.deploymentKey,
    group.customerId,
  );
  const [frozen] =
    group.enrollmentId && current?.id !== group.enrollmentId
      ? await tx
          .select()
          .from(enrollments)
          .where(eq(enrollments.id, group.enrollmentId))
      : [];
  const enrollmentRow = current?.id === group.enrollmentId ? current : frozen;
  const enrollment = enrollmentRow
    ? await enrollmentView(tx, enrollmentRow)
    : null;
  const frozenCovered =
    group.paymentArrangement === "automatic" &&
    group.totalMinor > 0 &&
    group.enrollmentId !== null &&
    group.paymentMethodId !== null &&
    enrollment?.id === group.enrollmentId &&
    enrollment.paymentMethodId === group.paymentMethodId &&
    claimed.every((p) => enrollment.scopes.some((scope) => covers(scope, p)));
  const authorized = frozenCovered && current?.id === group.enrollmentId;
  const [method] = group.paymentMethodId
    ? await tx
        .select()
        .from(methods)
        .where(eq(methods.id, group.paymentMethodId))
    : [];
  const [setup] = method
    ? await tx.select().from(setups).where(eq(setups.id, method.setupId))
    : [];
  const ownedMethod =
    method &&
    setup &&
    method.customerId === group.customerId &&
    method.deploymentKey === group.deploymentKey &&
    method.billingCustomerId === record.customer.id &&
    method.providerAccountId === record.customer.providerAccountId &&
    setup.customerId === group.customerId &&
    setup.billingCustomerId === record.customer.id &&
    setup.deploymentKey === group.deploymentKey &&
    setup.providerAccountId === method.providerAccountId &&
    setup.status === "verified" &&
    setup.providerSessionId &&
    setup.providerSetupIntentId &&
    setup.providerPaymentMethodId === method.providerPaymentMethodId &&
    setup.lastCheckedAt
      ? { method, setup }
      : null;
  return {
    group,
    claimed,
    chargeAt: first.chargeAt,
    dueEndAt: first.dueEndAt,
    frozenCovered: Boolean(frozenCovered),
    authorized: Boolean(authorized),
    ownedMethod,
  };
}
/** SQL-only persisted projection. Reads never stamp or dispatch an effect. */
export async function readCollectionProjection(
  tx: NodePgDatabase,
  record: StoredInvoice,
  businessNow: Date,
  wallNow: Date,
): Promise<InvoiceCollection> {
  const attempt = await attemptFor(tx, record.invoice.id);
  let facts: Awaited<ReturnType<typeof collectionFacts>> = null;
  let badFacts = false;
  try {
    facts = await collectionFacts(tx, record);
  } catch (error) {
    if (!(error instanceof BillingProviderError)) throw error;
    badFacts = true;
  }
  const resolution = await resolutionFor(tx, record.invoice.id);
  const checkedAt = iso(record.invoice.collectionCheckedAt);
  const result = (disposition: CollectionDisposition): InvoiceCollection => ({
    chargeAt: iso(attempt?.chargeAt ?? facts?.chargeAt ?? null),
    checkedAt,
    disposition,
    attempt: attempt
      ? {
          state: attempt.state,
          attemptedAt: iso(attempt.firstAttemptedAt)!,
          reason: attempt.reason,
        }
      : null,
  });
  const defer = (
    reason: Extract<CollectionDisposition, { kind: "defer" }>["reason"],
  ) => result({ kind: "defer", reason });
  const payable = (
    reason: Extract<CollectionDisposition, { kind: "payable" }>["reason"],
  ) => result({ kind: "payable", reason });
  if (
    record.invoice.providerStatus === "paid" ||
    record.invoice.providerStatus === "void"
  )
    return result({ kind: "suppress", reason: record.invoice.providerStatus });
  if (resolution)
    return defer(
      resolution.state === "pending"
        ? "resolution_pending"
        : "resolution_conflict",
    );
  if (badFacts || attempt?.state === "needs_review")
    return defer("collection_review");
  if (attempt?.state === "pending" || attempt?.state === "processing")
    return defer(attempt.state);
  if (
    record.invoice.providerReceiptState !== "verified" ||
    record.invoice.providerStatus !== "open" ||
    !record.invoice.collectionRemainingMinor ||
    !record.invoice.hostedInvoiceUrl?.startsWith("https://invoice.stripe.com/")
  )
    return defer("not_payable");
  if (
    !checkedAt ||
    Date.parse(checkedAt) > wallNow.getTime() ||
    wallNow.getTime() - Date.parse(checkedAt) > 5000
  )
    return defer("stale");
  if (
    record.invoice.collectionState === "unknown" ||
    record.invoice.collectionState === null
  )
    return defer("unknown");
  if (attempt?.state === "requires_action") {
    if (
      record.invoice.collectionState === "active" &&
      attempt.responseKind === "requires_action" &&
      attempt.responsePaymentIntentId &&
      attempt.responsePaymentIntentId === attempt.attributedPaymentIntentId &&
      attempt.attributedInvoicePaymentId &&
      attempt.lastCheckedAt &&
      Date.parse(attempt.lastCheckedAt) === Date.parse(checkedAt)
    )
      return payable("requires_action");
    return defer("collection_review");
  }
  if (record.invoice.collectionState !== "idle") return defer("processing");
  if (attempt?.state === "failed") return payable("declined");
  if (attempt) return defer("collection_review");
  if (!facts || facts.group.paymentArrangement === "manual")
    return payable("manual");
  if (facts.group.collectionMissedAt) return payable("missed");
  if (
    !facts.authorized ||
    !facts.ownedMethod ||
    !usableCard(facts.ownedMethod.method, wallNow)
  )
    return payable("not_authorized");
  if (cutoff(facts.dueEndAt, businessNow, wallNow))
    return defer("awaiting_collection");
  if (businessNow.getTime() < Date.parse(facts.chargeAt))
    return payable("before_charge");
  return defer("awaiting_collection");
}
/** Read-only startup validation; an unavailable provider grants no dispatch capability. */
export async function assertSyntheticCollectionData({
  pool,
  deploymentKey,
  accountId,
}: {
  pool: Pool;
  deploymentKey: string;
  accountId?: string | null;
}): Promise<void> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(deploymentKey))
    throw new Error("Invalid collection deployment");
  const db = drizzle(pool);
  const rows = await db.select().from(attempts);
  const storedGroups = await db.select().from(groups);
  if (storedGroups.some((group) => group.deploymentKey !== deploymentKey))
    throw new Error("Unexpected collection group ownership");
  if (!accountId) {
    // A linked group already has a provider-owned mapping, even before invoice issuance.
    if (rows.length || storedGroups.some((group) => group.invoiceId !== null))
      throw new Error("Missing collection account identity");
    return;
  }
  const context = createInvoiceContext({
    pool,
    deploymentKey,
    ownership: { deploymentKey, accountId },
  });
  for (const row of rows) {
    const record = await context.load(db, row.invoiceId);
    if (!record) throw new Error("Unknown collection invoice");
    const facts = await collectionFacts(db, record);
    if (
      !facts ||
      !facts.ownedMethod ||
      !facts.frozenCovered ||
      row.deploymentKey !== deploymentKey ||
      row.providerAccountId !== accountId ||
      row.groupId !== facts.group.id ||
      row.customerId !== record.customer.customerId ||
      row.billingCustomerId !== record.customer.id ||
      row.enrollmentId !== facts.group.enrollmentId ||
      row.paymentMethodId !== facts.group.paymentMethodId ||
      row.currency !== "USD" ||
      row.requestDigest !== digest(row.request) ||
      !equal(row.request, {
        providerInvoiceId: record.invoice.providerInvoiceId,
        providerPaymentMethodId:
          facts.ownedMethod.method.providerPaymentMethodId,
        offSession: true,
      }) ||
      row.idempotencyKey !== `datapad:${deploymentKey}:payment:${row.id}:pay` ||
      Date.parse(row.chargeAt) !== Date.parse(facts.chargeAt) ||
      Date.parse(row.dueEndAt) !== Date.parse(facts.dueEndAt) ||
      Date.parse(row.firstAttemptedAt) >= Date.parse(row.dueEndAt) ||
      facts.group.collectionMissedAt
    )
      throw new Error("Unexpected collection intention");
  }
  for (const group of storedGroups) {
    if (group.invoiceId) {
      const record = await context.load(db, group.invoiceId);
      if (!record) throw new Error("Unknown collection group invoice");
      const facts = await collectionFacts(db, record);
      if (group.enrollmentId && (!facts?.frozenCovered || !facts.ownedMethod))
        throw new Error("Unexpected frozen collection permission");
    }
  }
}

/** Builds deployment-scoped automatic collection and reconciliation; callers supply the trusted provider, audit writer and separate calendar/effect clocks. */
export function createInvoiceCollections(
  options: InvoiceCollectionsOptions,
): InvoiceCollections {
  const {
    pool,
    deploymentKey,
    provider,
    audit,
    workerId,
    wallNow = () => new Date(),
  } = options;
  const businessNow = options.businessNow ?? wallNow;
  const reconciliationAudit = { audit, operatorId: workerId };
  if (
    !/^[A-Za-z0-9_-]{1,64}$/.test(deploymentKey) ||
    provider.ownership.deploymentKey !== deploymentKey ||
    !provider.ownership.accountId ||
    !workerId.trim()
  )
    throw new Error("Invalid collection ownership");
  const db = drizzle(pool);
  const context = createInvoiceContext({
    pool,
    deploymentKey,
    ownership: provider.ownership,
    now: wallNow,
  });
  const resultFor = (row: Attempt | null): WorkResult =>
    row?.state === "needs_review"
      ? "needs_review"
      : row && ["pending", "processing"].includes(row.state)
        ? "retry"
        : "complete";
  async function inspect(connection: NodePgDatabase, record: StoredInvoice) {
    if (!record.invoice.providerInvoiceId)
      throw new BillingProviderError("review", "provider_conflict");
    const observedAt = wallNow();
    const inspection = await provider.inspectCollection(
      context.intent(record),
      record.invoice.providerInvoiceId,
    );
    const ended = wallNow();
    await connection.transaction(async (tx) => {
      const current = (await context.load(tx, record.invoice.id))!;
      context.verify(current, inspection.invoice);
      await reconcileResolutionSnapshot(
        tx,
        current,
        inspection,
        ended,
        reconciliationAudit,
      );
      await reconcileCollectionSnapshot(
        tx,
        current,
        inspection,
        ended,
        observedAt,
      );
      await context.project(tx, current, inspection.invoice);
    });
    return { inspection, ended };
  }
  async function failedInspection(
    connection: NodePgDatabase,
    record: StoredInvoice,
    error: unknown,
  ) {
    const safe =
      error instanceof BillingProviderError
        ? error
        : new BillingProviderError("retryable", "retry_exhausted");
    await connection.transaction(async (tx) => {
      await reconcileResolutionFailure(
        tx,
        record.invoice.id,
        safe,
        reconciliationAudit,
      );
      await reconcileCollectionFailure(tx, record.invoice.id, safe, wallNow());
      if (safe.receiptMismatch) await context.mismatch(tx, record, safe.reason);
    });
    return resultFor(await attemptFor(connection, record.invoice.id)) ===
      "complete"
      ? ("retry" as const)
      : resultFor(await attemptFor(connection, record.invoice.id));
  }
  async function methodAvailable(
    facts: NonNullable<Awaited<ReturnType<typeof collectionFacts>>>,
    record: StoredInvoice,
  ) {
    if (!facts.ownedMethod || !record.customer.providerCustomerId) return false;
    const { method, setup } = facts.ownedMethod;
    const observed = await provider.retrieveSavedMethod(
      paymentSetupIntent(setup, record.customer.providerCustomerId),
      method.providerPaymentMethodId,
    );
    return (
      observed.accountId === provider.ownership.accountId &&
      observed.deploymentKey === deploymentKey &&
      observed.livemode === false &&
      observed.providerCustomerId === record.customer.providerCustomerId &&
      observed.providerPaymentMethodId === method.providerPaymentMethodId &&
      observed.type === "card" &&
      observed.card !== null &&
      Number.isInteger(observed.card.expiryMonth) &&
      observed.card.expiryMonth >= 1 &&
      observed.card.expiryMonth <= 12 &&
      Number.isInteger(observed.card.expiryYear) &&
      usableCard(observed.card, wallNow())
    );
  }
  async function hold(
    connection: NodePgDatabase,
    row: Attempt,
    reason: CollectionReason,
  ) {
    await connection.transaction((tx) =>
      reviewCollectionAttempt(tx, row, reason, wallNow()),
    );
    return "needs_review" as const;
  }
  async function run(
    connection: NodePgDatabase,
    initial: StoredInvoice,
    dispatch: boolean,
  ): Promise<WorkResult> {
    const invoiceId = initial.invoice.id;
    let attempt = await attemptFor(connection, invoiceId);
    if (!initial.invoice.providerInvoiceId) return "complete";
    if (
      dispatch &&
      attempt?.nextAttemptAt &&
      Date.parse(attempt.nextAttemptAt) > wallNow().getTime() &&
      wallNow().getTime() - Date.parse(attempt.firstAttemptedAt) < lifetime
    )
      return "retry";
    const started = wallNow();
    let facts: Awaited<ReturnType<typeof collectionFacts>>;
    let methodOk = false;
    let inspected: Awaited<ReturnType<typeof inspect>>;
    try {
      facts = await collectionFacts(connection, initial);
      if (
        dispatch &&
        !attempt &&
        facts?.group.paymentArrangement === "automatic"
      ) {
        const nextCheckAt = Date.parse(
          initial.invoice.collectionNextCheckAt ?? "",
        );
        if (
          !cutoff(facts.dueEndAt, businessNow(), wallNow()) &&
          nextCheckAt > wallNow().getTime()
        )
          return "retry";
        // Financial observations from notices and customer reads cannot postpone this worker's retry.
        await connection
          .update(invoices)
          .set({
            collectionNextCheckAt: new Date(
              wallNow().getTime() + observationInterval,
            ).toISOString(),
          })
          .where(eq(invoices.id, invoiceId));
      }
      if (
        dispatch &&
        !attempt &&
        facts?.authorized &&
        facts.ownedMethod &&
        !facts.group.collectionMissedAt &&
        cutoff(facts.dueEndAt, businessNow(), wallNow()) &&
        !["paid", "void"].includes(initial.invoice.providerStatus ?? "")
      ) {
        // Cutoff is a local calendar fact. An outage cannot leave an unstamped invoice awaiting collection forever.
        await connection.transaction(async (tx) => {
          await lockSubscriptionCustomer(
            tx,
            deploymentKey,
            initial.customer.customerId,
          );
          const latest = await collectionFacts(tx, initial);
          if (
            latest?.authorized &&
            latest.ownedMethod &&
            !latest.group.collectionMissedAt &&
            !(await attemptFor(tx, invoiceId)) &&
            cutoff(latest.dueEndAt, businessNow(), wallNow())
          ) {
            await tx
              .update(groups)
              .set({ collectionMissedAt: wallNow().toISOString() })
              .where(eq(groups.id, latest.group.id));
            await audit.recordOperator(tx, {
              operatorId: workerId,
              customerId: initial.customer.customerId,
              targetId: invoiceId,
              invoiceId,
              action: "invoice.collection_missed",
              reason: "missed",
            });
          }
        });
        facts = await collectionFacts(connection, initial);
      }
      if (
        dispatch &&
        facts?.authorized &&
        facts.ownedMethod &&
        !facts.group.collectionMissedAt &&
        (!attempt || attempt.state === "pending")
      )
        methodOk = await methodAvailable(facts, initial);
      inspected = await inspect(connection, initial);
    } catch (error) {
      return failedInspection(connection, initial, error);
    }
    attempt = await attemptFor(connection, invoiceId);
    if (!dispatch) return resultFor(attempt);
    const current = (await context.load(connection, invoiceId))!;
    if (["paid", "void"].includes(current.invoice.providerStatus ?? ""))
      return resultFor(attempt);
    if (attempt && attempt.state !== "pending") return resultFor(attempt);
    if (attempt && attempt.responseKind !== null) return resultFor(attempt);
    if (
      !facts ||
      facts.group.paymentArrangement !== "automatic" ||
      facts.group.totalMinor <= 0 ||
      facts.group.collectionMissedAt
    )
      return "complete";
    if (
      attempt &&
      (wallNow().getTime() - Date.parse(attempt.firstAttemptedAt) >= lifetime ||
        attempt.dispatchCount >= 5)
    )
      return hold(connection, attempt, "retry_exhausted");
    const { inspection, ended } = inspected;
    const reserved = await connection.transaction(async (tx) => {
      await lockSubscriptionCustomer(
        tx,
        deploymentKey,
        current.customer.customerId,
      );
      const latest = (await context.load(tx, invoiceId))!;
      const eligible = await collectionFacts(tx, latest);
      const row = await attemptFor(tx, invoiceId);
      if (!eligible || (row && row.state !== "pending")) return null;
      const resolution = await resolutionFor(tx, invoiceId);
      const reason: CollectionReason | null = resolution
        ? "resolution_conflict"
        : !eligible.authorized
          ? "consent_changed"
          : !eligible.ownedMethod || !methodOk
            ? "method_unavailable"
            : row && !collectionBaselineUnchanged(row, inspection)
              ? "amount_changed"
              : null;
      if (reason) {
        if (row) await reviewCollectionAttempt(tx, row, reason, wallNow());
        return null;
      }
      if (
        inspection.invoice.status !== "open" ||
        inspection.collectionState !== "idle" ||
        inspection.remainingMinor <= 0 ||
        inspection.overpaidMinor !== 0
      ) {
        if (row)
          await reviewCollectionAttempt(
            tx,
            row,
            "competing_payment",
            wallNow(),
          );
        return null;
      }
      if (!fresh(started, ended, wallNow())) return null;
      if (!row && cutoff(eligible.dueEndAt, businessNow(), wallNow())) {
        if (!eligible.group.collectionMissedAt) {
          await tx
            .update(groups)
            .set({ collectionMissedAt: wallNow().toISOString() })
            .where(eq(groups.id, eligible.group.id));
          await audit.recordOperator(tx, {
            operatorId: workerId,
            customerId: latest.customer.customerId,
            targetId: invoiceId,
            invoiceId,
            action: "invoice.collection_missed",
            reason: "missed",
          });
        }
        return null;
      }
      if (!row && businessNow().getTime() < Date.parse(eligible.chargeAt))
        return null;
      if (
        row &&
        (row.dispatchCount >= 5 ||
          wallNow().getTime() - Date.parse(row.firstAttemptedAt) >= lifetime)
      ) {
        await reviewCollectionAttempt(tx, row, "retry_exhausted", wallNow());
        return null;
      }
      const at = wallNow().toISOString();
      const count = row ? row.dispatchCount + 1 : 1;
      const nextAttemptAt =
        count < 5
          ? new Date(wallNow().getTime() + delays[count - 1]).toISOString()
          : null;
      let stamped: Attempt;
      if (row) {
        [stamped] = await tx
          .update(attempts)
          .set({ dispatchCount: count, lastDispatchedAt: at, nextAttemptAt })
          .where(eq(attempts.id, row.id))
          .returning();
      } else {
        const id = randomUUID();
        const request: CollectionPayRequest = {
          providerInvoiceId: latest.invoice.providerInvoiceId!,
          providerPaymentMethodId:
            eligible.ownedMethod!.method.providerPaymentMethodId,
          offSession: true,
        };
        [stamped] = await tx
          .insert(attempts)
          .values({
            id,
            deploymentKey,
            invoiceId,
            groupId: eligible.group.id,
            customerId: latest.customer.customerId,
            billingCustomerId: latest.customer.id,
            providerAccountId: provider.ownership.accountId,
            enrollmentId: eligible.group.enrollmentId!,
            paymentMethodId: eligible.group.paymentMethodId!,
            chargeAt: eligible.chargeAt,
            dueEndAt: eligible.dueEndAt,
            currency: "USD",
            remainingMinor: inspection.remainingMinor,
            request,
            requestDigest: digest(request),
            idempotencyKey: `datapad:${deploymentKey}:payment:${id}:pay`,
            firstAttemptedAt: at,
            baselineObservedAt: started.toISOString(),
            baselinePaidMinor: inspection.paidMinor,
            baselinePaidOffStripeMinor: inspection.paidOffStripeMinor,
            baselineOverpaidMinor: inspection.overpaidMinor,
            baselinePayments: inspection.payments,
            state: "pending",
            dispatchCount: 1,
            inspectionFailures: 0,
            lastDispatchedAt: at,
            nextAttemptAt,
          })
          .returning();
      }
      await audit.recordOperator(tx, {
        operatorId: workerId,
        customerId: stamped.customerId,
        targetId: stamped.id,
        invoiceId,
        attemptId: stamped.id,
        action: "invoice.collection_attempted",
        dispatchCount: count,
        enrollmentId: stamped.enrollmentId,
      });
      return stamped;
    });
    if (!reserved) {
      const row = await attemptFor(connection, invoiceId);
      if (row) return resultFor(row);
      return !fresh(started, ended, wallNow()) ? "retry" : "complete";
    }
    if (
      !fresh(started, ended, wallNow()) ||
      (!attempt && cutoff(reserved.dueEndAt, businessNow(), wallNow())) ||
      wallNow().getTime() - Date.parse(reserved.firstAttemptedAt) >= lifetime
    )
      return hold(connection, reserved, "uncertain_outcome");
    // Consent revocation after the committed reservation cannot retract this invocation's send.
    try {
      const outcome = await provider.payInvoice(
        context.intent(current),
        reserved.request,
        { idempotencyKey: reserved.idempotencyKey },
      );
      if (outcome.kind === "response") {
        const receipt = outcome.receipt;
        if (
          receipt.accountId !== provider.ownership.accountId ||
          receipt.deploymentKey !== deploymentKey ||
          receipt.invoiceId !== invoiceId ||
          receipt.providerInvoiceId !== reserved.request.providerInvoiceId ||
          receipt.providerCustomerId !== current.customer.providerCustomerId ||
          (receipt.payment &&
            receipt.payment.providerPaymentMethodId !==
              reserved.request.providerPaymentMethodId)
        )
          mismatch();
      }
      await connection.transaction(async (tx) => {
        await recordCollectionResponse(tx, reserved, outcome, wallNow());
      });
    } catch (error) {
      if (error instanceof BillingProviderError && error.kind === "review")
        await hold(
          connection,
          reserved,
          error.receiptMismatch ? "provider_mismatch" : "uncertain_outcome",
        );
      // The committed reservation survives missing responses. Only identical-key bounded recovery may dispatch again.
    }
    try {
      await inspect(connection, (await context.load(connection, invoiceId))!);
    } catch (error) {
      return failedInspection(
        connection,
        (await context.load(connection, invoiceId))!,
        error,
      );
    }
    return resultFor(await attemptFor(connection, invoiceId));
  }
  return {
    collectDueInvoice: (invoiceId) =>
      context.locked<WorkResult>(invoiceId, "complete", (connection, record) =>
        run(connection, record, true),
      ),
    reconcileCollection: (invoiceId) =>
      context.locked<WorkResult>(invoiceId, "complete", (connection, record) =>
        run(connection, record, false),
      ),
    getCollectionDisposition: (
      invoiceId,
      check?: { explicitCheck: true; canManageBilling: boolean },
    ) =>
      context.locked<InvoiceCollection | null>(
        invoiceId,
        null,
        async (connection, record) => {
          const localAttempt =
            check && !check.canManageBilling
              ? await attemptFor(connection, invoiceId)
              : null;
          if (
            localAttempt &&
            ["pending", "processing"].includes(localAttempt.state)
          )
            return readCollectionProjection(
              connection,
              record,
              businessNow(),
              wallNow(),
            );
          const checkedAt = record.invoice.collectionCheckedAt
            ? Date.parse(record.invoice.collectionCheckedAt)
            : NaN;
          const reuse =
            check?.explicitCheck &&
            record.invoice.collectionState !== null &&
            record.invoice.collectionState !== "unknown" &&
            checkedAt <= wallNow().getTime() &&
            wallNow().getTime() - checkedAt <= 5000;
          let unavailable = false;
          if (record.invoice.providerInvoiceId && !reuse) {
            try {
              await inspect(connection, record);
            } catch (error) {
              await failedInspection(connection, record, error);
              unavailable = true;
            }
          }
          const current = (await context.load(connection, invoiceId))!;
          const projection = await readCollectionProjection(
            connection,
            current,
            businessNow(),
            wallNow(),
          );
          if (
            !unavailable &&
            projection.disposition.kind === "defer" &&
            projection.disposition.reason === "awaiting_collection" &&
            !projection.attempt
          ) {
            const facts = await collectionFacts(connection, current);
            if (
              facts?.authorized &&
              facts.ownedMethod &&
              !facts.group.collectionMissedAt
            ) {
              try {
                const available = await methodAvailable(facts, current);
                const updated = await readCollectionProjection(
                  connection,
                  (await context.load(connection, invoiceId))!,
                  businessNow(),
                  wallNow(),
                );
                if (
                  !available &&
                  updated.disposition.kind === "defer" &&
                  updated.disposition.reason === "awaiting_collection"
                )
                  return {
                    ...updated,
                    disposition: { kind: "payable", reason: "not_authorized" },
                  };
                return updated;
              } catch (error) {
                await failedInspection(connection, current, error);
                return {
                  ...projection,
                  disposition: {
                    kind: "defer",
                    reason: "provider_unavailable",
                  },
                };
              }
            }
          }
          return unavailable && projection.disposition.kind !== "suppress"
            ? {
                ...projection,
                disposition: { kind: "defer", reason: "provider_unavailable" },
              }
            : projection;
        },
      ),
    async pendingCollections({
      limit = 100,
      after = null,
      through = null,
    } = {}) {
      const valid = (c: NonNullable<typeof after>) =>
        isUuid(c.invoiceId) &&
        /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}(?::?\d{2})?)$/.test(
          c.createdAt,
        ) &&
        Number.isFinite(Date.parse(c.createdAt));
      if (
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 100 ||
        (after && (!through || !valid(after))) ||
        (through && !valid(through))
      )
        throw new RangeError("Invalid collection cursor");
      const selection = {
        createdAt: invoices.createdAt,
        invoiceId: invoices.id,
      };
      const eligible = sql`${invoices.deploymentKey}=${deploymentKey} and ${invoices.providerInvoiceId} is not null and (
        exists (select 1 from ${attempts} where ${attempts.invoiceId}=${invoices.id} and ${attempts.state} in ('pending','processing') and (${attempts.nextAttemptAt} is null or ${attempts.nextAttemptAt}<=${wallNow().toISOString()}::timestamptz or ${attempts.firstAttemptedAt}<=${new Date(wallNow().getTime() - lifetime).toISOString()}::timestamptz))
        or (not exists (select 1 from ${attempts} where ${attempts.invoiceId}=${invoices.id}) and ${invoices.providerStatus}='open' and ${invoices.providerReceiptState}='verified' and not exists (select 1 from ${resolutions} where ${resolutions.invoiceId}=${invoices.id} and ${resolutions.state}<>'withdrawn') and exists (
          select 1 from ${groups} where ${groups.invoiceId}=${invoices.id} and ${groups.paymentArrangement}='automatic' and ${groups.totalMinor}>0 and ${groups.enrollmentId} is not null and ${groups.enrollmentId}=(select ${enrollments.id} from ${enrollments} where ${enrollments.customerId}=${groups.customerId} and ${enrollments.deploymentKey}=${groups.deploymentKey} order by ${enrollments.version} desc limit 1) and ${groups.collectionMissedAt} is null and exists (
            select 1 from ${periods} where ${periods.invoiceGroupId}=${groups.id} and (${periods.chargeAt}<=${businessNow().toISOString()}::timestamptz or ${periods.dueEndAt}<=${wallNow().toISOString()}::timestamptz)
            and (${invoices.collectionNextCheckAt} is null or ${invoices.collectionNextCheckAt}<=${wallNow().toISOString()}::timestamptz or ${periods.dueEndAt}<=${businessNow().toISOString()}::timestamptz or ${periods.dueEndAt}<=${wallNow().toISOString()}::timestamptz)
          )
        ))
      )`;
      if (!through) {
        const [last] = await db
          .select(selection)
          .from(invoices)
          .where(eligible)
          .orderBy(desc(invoices.createdAt), desc(invoices.id))
          .limit(1);
        through = last ?? null;
      }
      if (!through) return { invoiceIds: [], next: null, through: null };
      const rows = await db
        .select(selection)
        .from(invoices)
        .where(
          and(
            eligible,
            sql`(${invoices.createdAt},${invoices.id})<=(${through.createdAt}::timestamptz,${through.invoiceId}::uuid)`,
            after
              ? sql`(${invoices.createdAt},${invoices.id})>(${after.createdAt}::timestamptz,${after.invoiceId}::uuid)`
              : undefined,
          ),
        )
        .orderBy(asc(invoices.createdAt), asc(invoices.id))
        .limit(limit + 1);
      const page = rows.slice(0, limit);
      return {
        invoiceIds: page.map((r) => r.invoiceId),
        next: rows.length > limit ? page[page.length - 1] : null,
        through,
      };
    },
    assertSyntheticData: () =>
      assertSyntheticCollectionData({
        pool,
        deploymentKey,
        accountId: provider.ownership.accountId,
      }),
  };
}
