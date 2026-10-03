import { and, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { createAuditWriter } from "../../access";
import type { CollectionReason, CollectionState } from "../collection-contract";
import type {
  BillingProviderError,
  CollectionInspection,
  CollectionPayOutcome,
} from "../provider";
import type { StoredInvoice } from "./invoice-context";
import { invoices } from "./invoice-schema";
import { billingPaymentAttempts as attempts } from "./collection-schema";
type Attempt = typeof attempts.$inferSelect;
const lifetime = 23 * 60 * 60 * 1000;
const nextRead = (now: Date) => new Date(now.getTime() + 30000).toISOString();
async function transition(
  tx: NodePgDatabase,
  row: Attempt,
  state: CollectionState,
  reason: CollectionReason | null,
  now: Date,
  extra: Partial<typeof attempts.$inferInsert> = {},
) {
  await tx
    .update(attempts)
    .set({
      state,
      reason,
      nextAttemptAt:
        state === "pending"
          ? row.nextAttemptAt
          : state === "processing"
            ? nextRead(now)
            : null,
      completedAt: [
        "failed",
        "requires_action",
        "succeeded",
        "needs_review",
      ].includes(state)
        ? (row.completedAt ?? now.toISOString())
        : null,
      ...extra,
    })
    .where(eq(attempts.id, row.id));
  if (row.state === state && row.reason === reason) return;
  const base = {
    operatorId: "billing-reconciliation",
    customerId: row.customerId,
    targetId: row.id,
    invoiceId: row.invoiceId,
    attemptId: row.id,
  };
  const audit = createAuditWriter();
  if (state === "failed")
    await audit.recordOperator(tx, {
      ...base,
      action: "invoice.collection_failed",
      reason: "declined",
    });
  else if (state === "requires_action")
    await audit.recordOperator(tx, {
      ...base,
      action: "invoice.collection_requires_action",
      reason: "authentication_required",
    });
  else if (
    state === "needs_review" &&
    reason !== null &&
    reason !== "declined" &&
    reason !== "authentication_required"
  )
    await audit.recordOperator(tx, {
      ...base,
      action: "invoice.collection_needs_review",
      reason,
    });
  else if (state === "processing")
    await audit.recordOperator(tx, {
      ...base,
      action: "invoice.collection_processing",
    });
  else if (state === "succeeded")
    await audit.recordOperator(tx, {
      ...base,
      action: "invoice.collection_succeeded",
    });
}
export async function reviewCollectionAttempt(
  tx: NodePgDatabase,
  row: Attempt,
  reason: CollectionReason,
  wallNow: Date,
) {
  await transition(tx, row, "needs_review", reason, wallNow);
}
/** Persist the definitive dispatch classification before any subsequent retrieval. */
export async function recordCollectionResponse(
  tx: NodePgDatabase,
  row: Attempt,
  outcome: CollectionPayOutcome,
  wallNow: Date,
) {
  const extra = {
    responseAt: row.responseAt ?? wallNow.toISOString(),
    responseKind: outcome.kind,
    responseInvoiceStatus:
      outcome.kind === "response" ? outcome.receipt.status : null,
    responsePaymentIntentId:
      outcome.kind === "response"
        ? (outcome.receipt.payment?.paymentIntentId ?? null)
        : outcome.paymentIntentId,
    responseInvoicePaymentId:
      outcome.kind === "response"
        ? (outcome.receipt.payment?.invoicePaymentId ?? null)
        : null,
  };
  if (outcome.kind === "response") {
    await tx.update(attempts).set(extra).where(eq(attempts.id, row.id));
  } else {
    await transition(
      tx,
      row,
      outcome.kind === "declined" ? "failed" : "requires_action",
      outcome.kind === "declined" ? "declined" : "authentication_required",
      wallNow,
      extra,
    );
  }
}
function unchangedMoney(row: Attempt, inspection: CollectionInspection) {
  if (
    inspection.remainingMinor !== row.remainingMinor ||
    inspection.paidMinor !== row.baselinePaidMinor ||
    inspection.paidOffStripeMinor !== row.baselinePaidOffStripeMinor ||
    inspection.overpaidMinor !== row.baselineOverpaidMinor
  )
    return false;
  const baseline = new Map(
    row.baselinePayments.map((p) => [p.invoicePaymentId, p]),
  );
  for (const payment of inspection.payments) {
    const before = baseline.get(payment.invoicePaymentId);
    if (
      (payment.paidMinor ?? 0) !== (before?.paidMinor ?? 0) ||
      payment.receivedMinor !== (before?.receivedMinor ?? 0) ||
      (before && payment.paymentIntentId !== before.paymentIntentId)
    )
      return false;
    baseline.delete(payment.invoicePaymentId);
  }
  return baseline.size === 0;
}
/** The request's complete pre-effect monetary baseline is required for any replay. */
export function collectionBaselineUnchanged(
  row: Attempt,
  inspection: CollectionInspection,
) {
  return (
    unchangedMoney(row, inspection) &&
    inspection.collectionState === "idle" &&
    inspection.payments.every((p) => {
      const before = row.baselinePayments.find(
        (b) => b.invoicePaymentId === p.invoicePaymentId,
      );
      return (
        before !== undefined &&
        p.intentState === before.intentState &&
        p.status === before.status &&
        p.providerPaymentMethodId === before.providerPaymentMethodId &&
        p.capturableMinor === before.capturableMinor
      );
    }) &&
    inspection.payments.length === row.baselinePayments.length
  );
}
function attributablePayment(row: Attempt, inspection: CollectionInspection) {
  if (
    !row.responseInvoicePaymentId ||
    !row.responsePaymentIntentId ||
    inspection.invoice.status !== "paid" ||
    inspection.remainingMinor !== 0 ||
    inspection.paidMinor - row.baselinePaidMinor !== row.remainingMinor ||
    inspection.paidOffStripeMinor !== row.baselinePaidOffStripeMinor ||
    inspection.overpaidMinor !== 0 ||
    inspection.collectionState !== "idle"
  )
    return null;
  const baseline = new Map(
    row.baselinePayments.map((p) => [p.invoicePaymentId, p]),
  );
  const changed: CollectionInspection["payments"] = [];
  for (const p of inspection.payments) {
    const before = baseline.get(p.invoicePaymentId);
    if (before && before.paymentIntentId !== p.paymentIntentId) return null;
    const paidDelta = (p.paidMinor ?? 0) - (before?.paidMinor ?? 0);
    const receivedDelta = p.receivedMinor - (before?.receivedMinor ?? 0);
    if (paidDelta !== 0 || receivedDelta !== 0) {
      if (
        p.invoicePaymentId !== row.responseInvoicePaymentId ||
        p.paymentIntentId !== row.responsePaymentIntentId ||
        paidDelta !== row.remainingMinor ||
        receivedDelta !== row.remainingMinor ||
        p.status !== "paid" ||
        p.intentState !== "succeeded" ||
        p.providerPaymentMethodId !== row.request.providerPaymentMethodId ||
        p.capturableMinor !== 0
      )
        return null;
      changed.push(p);
    } else if (
      p.capturableMinor !== 0 ||
      !["requires_payment_method", "canceled", "succeeded"].includes(
        p.intentState,
      ) ||
      (p.intentState === "succeeded" && p.status !== "paid")
    )
      return null;
    baseline.delete(p.invoicePaymentId);
  }
  return baseline.size === 0 && changed.length === 1 ? changed[0] : null;
}
/** Caller holds the invoice session lock and a short transaction. Never dispatches. */
export async function reconcileCollectionSnapshot(
  tx: NodePgDatabase,
  storedInvoice: StoredInvoice,
  inspection: CollectionInspection,
  wallNow: Date,
  observedAt: Date = wallNow,
): Promise<void> {
  const at = observedAt.toISOString();
  await tx
    .update(invoices)
    .set({
      collectionCheckedAt: at,
      collectionRemainingMinor: inspection.remainingMinor,
      collectionState: inspection.collectionState,
    })
    .where(
      and(
        eq(invoices.id, storedInvoice.invoice.id),
        eq(invoices.deploymentKey, storedInvoice.invoice.deploymentKey),
      ),
    );
  const [row] = await tx
    .select()
    .from(attempts)
    .where(eq(attempts.invoiceId, storedInvoice.invoice.id));
  if (!row) return;
  await tx
    .update(attempts)
    .set({ lastCheckedAt: at, inspectionFailures: 0 })
    .where(eq(attempts.id, row.id));
  const paid = attributablePayment(row, inspection);
  if (paid && row.responseKind === "response" && row.responseAt) {
    await transition(tx, row, "succeeded", null, wallNow, {
      attributedInvoicePaymentId: paid.invoicePaymentId,
      attributedPaymentIntentId: paid.paymentIntentId,
    });
    return;
  }
  if (
    inspection.invoice.status === "paid" ||
    inspection.invoice.status === "void" ||
    !unchangedMoney(row, inspection)
  ) {
    await reviewCollectionAttempt(
      tx,
      row,
      inspection.invoice.status === "paid" && !row.responseAt
        ? "uncertain_outcome"
        : "competing_payment",
      wallNow,
    );
    return;
  }
  if (inspection.collectionState === "unknown") {
    await reviewCollectionAttempt(tx, row, "provider_mismatch", wallNow);
    return;
  }
  const active = inspection.payments.filter(
    (p) =>
      !["requires_payment_method", "canceled"].includes(p.intentState) &&
      !(p.intentState === "succeeded" && p.status === "paid"),
  );
  const ownedActive =
    active.length === 1 &&
    active[0].providerPaymentMethodId === row.request.providerPaymentMethodId &&
    active[0].capturableMinor === 0 &&
    active[0].status === "open"
      ? active[0]
      : null;
  if (
    ownedActive?.intentState === "requires_action" &&
    row.responseKind === "requires_action" &&
    row.responsePaymentIntentId === ownedActive.paymentIntentId
  ) {
    // This association grants only the hosted action exception, never a replay.
    await transition(
      tx,
      row,
      "requires_action",
      "authentication_required",
      wallNow,
      {
        attributedInvoicePaymentId: ownedActive.invoicePaymentId,
        attributedPaymentIntentId: ownedActive.paymentIntentId,
      },
    );
    return;
  }
  if (
    ownedActive?.intentState === "processing" &&
    !["declined", "requires_action"].includes(row.responseKind ?? "")
  ) {
    if (wallNow.getTime() - Date.parse(row.firstAttemptedAt) >= lifetime)
      await reviewCollectionAttempt(tx, row, "uncertain_outcome", wallNow);
    else if (
      row.responseKind === "response" &&
      (row.responseInvoicePaymentId !== ownedActive.invoicePaymentId ||
        row.responsePaymentIntentId !== ownedActive.paymentIntentId)
    )
      await reviewCollectionAttempt(tx, row, "competing_payment", wallNow);
    else if (row.state !== "needs_review")
      await transition(tx, row, "processing", null, wallNow);
    return;
  }
  if (inspection.collectionState !== "idle" || active.length > 0) {
    await reviewCollectionAttempt(tx, row, "competing_payment", wallNow);
    return;
  }
  if (row.responseKind === "declined") {
    if (row.state !== "needs_review")
      await transition(tx, row, "failed", "declined", wallNow);
    return;
  }
  if (row.responseKind === "requires_action") {
    // A hint alone cannot make a held hosted URL safe.
    await tx
      .update(attempts)
      .set({
        attributedInvoicePaymentId: null,
        attributedPaymentIntentId: null,
      })
      .where(eq(attempts.id, row.id));
    return;
  }
  if (row.state === "succeeded") {
    await reviewCollectionAttempt(tx, row, "provider_mismatch", wallNow);
    return;
  }
  if (row.state === "needs_review") return;
  if (
    wallNow.getTime() - Date.parse(row.firstAttemptedAt) >= lifetime ||
    (row.state === "pending" && row.dispatchCount >= 5)
  )
    await reviewCollectionAttempt(tx, row, "retry_exhausted", wallNow);
  else if (
    row.state === "processing" ||
    (row.state === "pending" && row.responseKind !== null)
  )
    await tx
      .update(attempts)
      .set({ nextAttemptAt: nextRead(wallNow) })
      .where(eq(attempts.id, row.id));
  // Processing attempts and recorded responses remain retrieval-only after an idle observation.
}
/** Failed retrieval invalidates usable evidence even when old money facts remain. */
export async function reconcileCollectionFailure(
  tx: NodePgDatabase,
  invoiceId: string,
  error: BillingProviderError,
  wallNow: Date,
): Promise<void> {
  await tx
    .update(invoices)
    .set({ collectionState: "unknown" })
    .where(eq(invoices.id, invoiceId));
  const [row] = await tx
    .select()
    .from(attempts)
    .where(eq(attempts.invoiceId, invoiceId));
  if (!row) return;
  const failures = Math.min(5, row.inspectionFailures + 1);
  await tx
    .update(attempts)
    .set({ inspectionFailures: failures })
    .where(eq(attempts.id, row.id));
  if (error.kind === "review")
    await reviewCollectionAttempt(tx, row, "provider_mismatch", wallNow);
  else if (["pending", "processing"].includes(row.state)) {
    if (
      failures >= 5 ||
      wallNow.getTime() - Date.parse(row.firstAttemptedAt) >= lifetime ||
      (row.state === "pending" && row.dispatchCount >= 5)
    )
      await reviewCollectionAttempt(
        tx,
        row,
        failures >= 5 ? "provider_unavailable" : "retry_exhausted",
        wallNow,
      );
    else
      await tx
        .update(attempts)
        .set({ nextAttemptAt: nextRead(wallNow) })
        .where(eq(attempts.id, row.id));
  }
}
