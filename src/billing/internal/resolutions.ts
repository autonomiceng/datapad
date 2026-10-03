import { pendingPage } from "./pending-page";
import { sql } from "drizzle-orm";
import {
  createFinancialEffectGuard,
  FinancialEffectsPaused,
} from "./effect-guard";
import { randomUUID } from "node:crypto";
import canonicalize from "canonicalize";
import { and, desc, eq, isNull, lte, ne, or } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Value } from "@sinclair/typebox/value";
import { AuditRequestConflict } from "../../access";
import type { AccessResult, AuditWriter, HumanActor } from "../../access/types";
import { BillingProviderError, type CollectionInspection } from "../provider";
import type {
  InvoiceResolutions,
  InvoiceResolutionsOptions,
} from "../resolutions-types";
import {
  ExternalPaymentRequestSchema,
  VoidInvoiceRequestSchema,
  ReceiptCorrectionRequestSchema,
  ReconcileResolutionRequestSchema,
  type ResolutionSummary,
  type ResolutionDetail,
  type ResolutionReviewReason,
  type ResolutionReviewResponse,
  type ResolutionActionResponse,
} from "../resolutions-contract";
import type { WorkResult } from "../types";
import { createInvoiceContext, type StoredInvoice } from "./invoice-context";
import {
  billingInvoiceResolutions as resolutions,
  type ElectronicPaymentBaseline,
} from "./resolutions-schema";
import { isUuid } from "./validate";
import { invoices } from "./invoice-schema";
import { billingPaymentAttempts } from "./collection-schema";
import {
  reconcileCollectionSnapshot,
  reconcileCollectionFailure,
} from "./collection-observation";

/** The caller holds the customer and invoice session locks. A locally uncertain send still holds P6 even if Stripe currently looks idle. */
async function collectionHolds(tx: NodePgDatabase, invoiceId: string) {
  const [attempt] = await tx
    .select({ state: billingPaymentAttempts.state })
    .from(billingPaymentAttempts)
    .where(eq(billingPaymentAttempts.invoiceId, invoiceId));
  return (
    attempt !== undefined &&
    ["pending", "processing", "requires_action", "needs_review"].includes(
      attempt.state,
    )
  );
}

type Resolution = typeof resolutions.$inferSelect;
type ReconciliationAudit = {
  audit: Pick<AuditWriter, "recordOperator">;
  operatorId: string;
};
const delays = [5000, 30000, 120000, 600000];
const editable = (row: StoredInvoice) =>
  row.invoice.providerReceiptState === "verified" &&
  ["open", "uncollectible"].includes(row.invoice.providerStatus ?? "");
const validText = (value: string) =>
  Boolean(value.trim()) &&
  !value.includes("\0") &&
  !/[\uD800-\uDFFF]/u.test(value);
const safeAmount = (value: number) =>
  Number.isSafeInteger(value) && value >= 0 && value <= 99999999;
const activeScope = (invoiceId: string) =>
  and(eq(resolutions.invoiceId, invoiceId), ne(resolutions.state, "withdrawn"));
async function active(tx: NodePgDatabase, invoiceId: string) {
  const [row] = await tx
    .select()
    .from(resolutions)
    .where(activeScope(invoiceId));
  return row ?? null;
}
function electronic(
  inspection: CollectionInspection,
): ElectronicPaymentBaseline[] {
  return inspection.payments
    .filter(
      (p) =>
        p.status === "paid" ||
        p.intentState === "succeeded" ||
        p.receivedMinor > 0,
    )
    .map((p) => ({
      invoicePaymentId: p.invoicePaymentId,
      paymentIntentId: p.paymentIntentId,
      paidMinor: p.paidMinor ?? 0,
      receivedMinor: p.receivedMinor,
    }))
    .sort((a, b) => a.invoicePaymentId.localeCompare(b.invoicePaymentId));
}
function validateInspection(inspection: CollectionInspection) {
  if (
    ![
      inspection.remainingMinor,
      inspection.paidMinor,
      inspection.paidOffStripeMinor,
      inspection.overpaidMinor,
    ].every(safeAmount) ||
    !["idle", "active", "unknown"].includes(inspection.collectionState)
  )
    throw new BillingProviderError("review", "invoice_mismatch", true);
  const ids = new Set<string>();
  for (const p of inspection.payments) {
    if (
      !p.invoicePaymentId ||
      !p.paymentIntentId ||
      ids.has(p.invoicePaymentId) ||
      !["open", "paid", "canceled"].includes(p.status) ||
      (p.paidMinor !== null && !safeAmount(p.paidMinor)) ||
      !safeAmount(p.receivedMinor) ||
      !safeAmount(p.capturableMinor)
    )
      throw new BillingProviderError("review", "invoice_mismatch", true);
    ids.add(p.invoicePaymentId);
  }
  if (
    inspection.collectionState === "idle" &&
    inspection.payments.some(
      (p) =>
        !["requires_payment_method", "canceled", "succeeded"].includes(
          p.intentState,
        ) ||
        p.capturableMinor > 0 ||
        (p.intentState === "succeeded" && p.status !== "paid"),
    )
  )
    throw new BillingProviderError("review", "provider_conflict");
}
function conflict(
  row: Resolution,
  inspection: CollectionInspection,
): ResolutionReviewReason | null {
  const unchanged =
    canonicalize(row.baselinePayments) === canonicalize(electronic(inspection));
  if (!unchanged || inspection.overpaidMinor > 0)
    return row.kind === "external_payment"
      ? "possible_overpayment"
      : "collection_conflict";
  if (inspection.collectionState !== "idle") return "collection_conflict";
  const status = inspection.invoice.status;
  if (row.kind === "void") {
    if (
      inspection.paidMinor > 0 ||
      inspection.paidOffStripeMinor > 0 ||
      status === "paid"
    )
      return "collection_conflict";
    if (status === "void" && row.attemptedAt) return null;
    return ["open", "uncollectible"].includes(status) &&
      inspection.remainingMinor === row.baselineRemainingMinor
      ? null
      : "collection_conflict";
  }
  if (status === "void" || status === "draft") return "collection_conflict";
  if (!row.attemptedAt) {
    if (status === "paid") return "possible_overpayment";
    if (
      inspection.remainingMinor !== row.amountMinor ||
      inspection.remainingMinor !== row.baselineRemainingMinor
    )
      return "amount_mismatch";
    if (inspection.paidOffStripeMinor !== row.baselinePaidOffStripeMinor)
      return "collection_conflict";
    return null;
  }
  const expectedOffStripe = row.baselinePaidOffStripeMinor! + row.amountMinor!;
  if (
    status === "paid" &&
    inspection.remainingMinor === 0 &&
    inspection.paidOffStripeMinor === expectedOffStripe
  )
    return null;
  if (
    ["open", "uncollectible"].includes(status) &&
    inspection.remainingMinor === row.amountMinor &&
    inspection.paidOffStripeMinor === row.baselinePaidOffStripeMinor &&
    !row.responseAt
  )
    return null;
  return "possible_overpayment";
}
function summary(row: Resolution): ResolutionSummary {
  return {
    id: row.id,
    kind: row.kind,
    state: row.state,
    amountMinor: row.amountMinor,
    receivedDate: row.receivedDate,
    method: row.method,
    createdAt: new Date(row.createdAt).toISOString(),
    confirmedAt:
      row.confirmedAt === null ? null : new Date(row.confirmedAt).toISOString(),
    reviewReason: row.reviewReason,
  };
}
function detail(row: Resolution): ResolutionDetail {
  return {
    ...summary(row),
    reference: row.reference,
    reason: row.reason,
    attemptedAt:
      row.attemptedAt === null ? null : new Date(row.attemptedAt).toISOString(),
  };
}

function inspectionFailureReason(
  error: BillingProviderError,
): ResolutionReviewReason {
  return error.receiptMismatch ||
    ["ownership_mismatch", "invoice_mismatch"].includes(error.reason)
    ? "provider_mismatch"
    : "collection_conflict";
}

/** A definitive rejection of collection evidence requires durable review, including after confirmation. */
export async function reconcileResolutionFailure(
  tx: NodePgDatabase,
  invoiceId: string,
  error: BillingProviderError,
  { audit, operatorId }: ReconciliationAudit,
): Promise<void> {
  if (error.kind !== "review") return;
  const row = await active(tx, invoiceId);
  if (!row) return;
  const reason = inspectionFailureReason(error);
  if (row.state === "needs_review" && row.reviewReason === reason) return;
  await tx
    .update(resolutions)
    .set({ state: "needs_review", reviewReason: reason, nextAttemptAt: null })
    .where(eq(resolutions.id, row.id));
  await audit.recordOperator(tx, {
    operatorId,
    customerId: row.customerId,
    targetId: row.id,
    action: "invoice.resolution_needs_review",
  });
}

/** Caller owns the invoice lock and short transaction. No provider I/O or lock acquisition. */
export async function reconcileResolutionSnapshot(
  tx: NodePgDatabase,
  invoice: StoredInvoice,
  inspection: CollectionInspection,
  now: Date,
  { audit, operatorId }: ReconciliationAudit,
): Promise<void> {
  validateInspection(inspection);
  const at = now.toISOString();
  await tx
    .update(invoices)
    .set({
      collectionCheckedAt: at,
      collectionRemainingMinor: inspection.remainingMinor,
    })
    .where(
      and(
        eq(invoices.id, invoice.invoice.id),
        eq(invoices.deploymentKey, invoice.invoice.deploymentKey),
      ),
    );
  let row = await active(tx, invoice.invoice.id);
  if (!row) return;
  if (!row.baselineAt) {
    const baseline = {
      baselineAt: at,
      baselineRemainingMinor: inspection.remainingMinor,
      baselinePaidOffStripeMinor: inspection.paidOffStripeMinor,
      baselinePayments: electronic(inspection),
    };
    await tx
      .update(resolutions)
      .set(baseline)
      .where(eq(resolutions.id, row.id));
    row = { ...row, ...baseline };
  }
  const observation = {
    lastCheckedAt: at,
    lastRemainingMinor: inspection.remainingMinor,
    lastCollectionState: inspection.collectionState,
  };
  const terminalConflict =
    ["paid", "void"].includes(invoice.invoice.providerStatus ?? "") &&
    invoice.invoice.providerStatus !== inspection.invoice.status;
  const reason = terminalConflict
    ? "provider_mismatch"
    : conflict(row, inspection);
  if (reason) {
    await tx
      .update(resolutions)
      .set({
        ...observation,
        state: "needs_review",
        reviewReason: reason,
        nextAttemptAt: null,
      })
      .where(eq(resolutions.id, row.id));
    if (row.state !== "needs_review" || row.reviewReason !== reason)
      await audit.recordOperator(tx, {
        operatorId,
        customerId: row.customerId,
        targetId: row.id,
        action: "invoice.resolution_needs_review",
      });
    return;
  }
  const confirmed = Boolean(
    row.attemptedAt &&
    row.responseAt &&
    (row.kind === "void"
      ? inspection.invoice.status === "void"
      : inspection.invoice.status === "paid" &&
        inspection.remainingMinor === 0 &&
        row.responsePaidOffStripeMinor ===
          row.baselinePaidOffStripeMinor! + row.amountMinor!),
  );
  // A review never silently authorizes a retry; staff explicitly resumes unattempted work.
  await tx
    .update(resolutions)
    .set({
      ...observation,
      ...(confirmed && row.state !== "needs_review"
        ? {
            state: "confirmed" as const,
            confirmedAt: row.confirmedAt ?? at,
            reviewReason: null,
            nextAttemptAt: null,
          }
        : {}),
    })
    .where(eq(resolutions.id, row.id));
  if (confirmed && row.state !== "needs_review" && row.state !== "confirmed")
    await audit.recordOperator(tx, {
      operatorId,
      customerId: row.customerId,
      targetId: row.id,
      action: "invoice.resolution_confirmed",
    });
}

/** Composes scoped staff receipt/void intentions and worker recovery for one verified deployment.
 * Session locks span provider I/O; durable intentions and audit commit in short transactions. */
export function createInvoiceResolutions(
  options: InvoiceResolutionsOptions,
): InvoiceResolutions {
  const {
    pool,
    deploymentKey,
    resolutionProvider: provider,
    customerAccess,
    audit,
    workerId,
    allowResolution,
    now = () => new Date(),
  } = options;
  if (
    !/^[A-Za-z0-9_-]{1,64}$/.test(deploymentKey) ||
    provider.ownership.deploymentKey !== deploymentKey ||
    !provider.ownership.accountId ||
    !workerId.trim()
  )
    throw new Error("Invalid resolution ownership");
  const reconciliationAudit = { audit, operatorId: workerId };
  const guard = createFinancialEffectGuard(deploymentKey);
  const db = drizzle(pool);
  const context = createInvoiceContext({
    pool,
    deploymentKey,
    ownership: provider.ownership,
    now,
  });
  const at = () => now().toISOString();
  async function authorized(
    actor: HumanActor,
    customerId: string,
    invoiceId: string,
  ): Promise<AccessResult<undefined>> {
    if (!isUuid(customerId) || !isUuid(invoiceId))
      return { ok: false, code: "not_found" };
    return db.transaction(async (tx) => {
      const access = await customerAccess.authorizeCustomer(
        tx,
        actor,
        customerId,
        "manage_billing",
        true,
      );
      if (!access.ok) return access;
      const row = await context.load(tx, invoiceId);
      return row?.customer.customerId === customerId
        ? { ok: true, value: undefined }
        : { ok: false, code: "not_found" };
    });
  }
  async function human<T>(
    actor: HumanActor,
    customerId: string,
    invoiceId: string,
    work: (
      connection: NodePgDatabase,
      row: StoredInvoice,
    ) => Promise<AccessResult<T>>,
  ): Promise<AccessResult<T>> {
    const access = await authorized(actor, customerId, invoiceId);
    if (!access.ok) return access;
    try {
      return await context.locked<AccessResult<T>>(
        invoiceId,
        { ok: false, code: "not_found" },
        async (connection, row) =>
          row.customer.customerId === customerId
            ? work(connection, row)
            : { ok: false, code: "not_found" },
      );
    } catch (error) {
      if (error instanceof AuditRequestConflict)
        return { ok: false, code: "conflict" };
      if (error instanceof BillingProviderError)
        return { ok: false, code: "unavailable" };
      throw error;
    }
  }
  async function inspect(
    connection: NodePgDatabase,
    row: StoredInvoice,
  ): Promise<CollectionInspection> {
    if (!row.invoice.providerInvoiceId)
      throw new BillingProviderError("review", "provider_conflict");
    try {
      const observedAt = now();
      const inspection = await provider.inspectCollection(
        context.intent(row),
        row.invoice.providerInvoiceId,
      );
      validateInspection(inspection);
      await connection.transaction(async (tx) => {
        const current = await context.load(tx, row.invoice.id);
        if (!current)
          throw new BillingProviderError("review", "ownership_mismatch");
        context.verify(current, inspection.invoice);
        await reconcileResolutionSnapshot(
          tx,
          current,
          inspection,
          now(),
          reconciliationAudit,
        );
        await reconcileCollectionSnapshot(
          tx,
          current,
          inspection,
          now(),
          observedAt,
        );
        try {
          await context.project(tx, current, inspection.invoice);
        } catch (error) {
          if (
            !(error instanceof BillingProviderError) ||
            error.reason !== "provider_conflict" ||
            !error.receiptMismatch
          )
            throw error;
          await context.mismatch(tx, current, error.reason);
        }
      });
      return inspection;
    } catch (error) {
      if (error instanceof BillingProviderError) {
        await connection.transaction(async (tx) => {
          await reconcileResolutionFailure(
            tx,
            row.invoice.id,
            error,
            reconciliationAudit,
          );
          await reconcileCollectionFailure(tx, row.invoice.id, error, now());
          if (error.receiptMismatch) {
            const current = await context.load(tx, row.invoice.id);
            if (current) await context.mismatch(tx, current, error.reason);
          }
        });
      }
      throw error;
    }
  }
  async function noteReview(
    connection: NodePgDatabase,
    row: Resolution,
    reason: ResolutionReviewReason,
  ) {
    await connection.transaction(async (tx) => {
      await tx
        .update(resolutions)
        .set({
          state: "needs_review",
          reviewReason: reason,
          nextAttemptAt: null,
        })
        .where(eq(resolutions.id, row.id));
      if (row.state !== "needs_review" || row.reviewReason !== reason)
        await audit.recordOperator(tx, {
          operatorId: workerId,
          customerId: row.customerId,
          targetId: row.id,
          action: "invoice.resolution_needs_review",
        });
    });
  }
  async function failure(
    connection: NodePgDatabase,
    invoice: StoredInvoice,
    row: Resolution,
    error: unknown,
  ): Promise<WorkResult> {
    if (error instanceof BillingProviderError && error.kind === "review") {
      await connection.transaction(async (tx) => {
        await reconcileResolutionFailure(
          tx,
          invoice.invoice.id,
          error,
          reconciliationAudit,
        );
        if (error.receiptMismatch)
          await context.mismatch(tx, invoice, error.reason);
      });
      return "needs_review";
    }
    const attempts = row.attempts + 1;
    const expired =
      row.attemptedAt &&
      now().getTime() - Date.parse(row.attemptedAt) >= 23 * 60 * 60 * 1000;
    if (attempts >= 5 || expired) {
      await noteReview(
        connection,
        row,
        expired ? "uncertain_outcome" : "retry_exhausted",
      );
      await connection
        .update(resolutions)
        .set({ attempts: Math.min(attempts, 5) })
        .where(eq(resolutions.id, row.id));
      return "needs_review";
    }
    await connection
      .update(resolutions)
      .set({
        attempts,
        nextAttemptAt: new Date(
          now().getTime() + delays[attempts - 1],
        ).toISOString(),
      })
      .where(eq(resolutions.id, row.id));
    return "retry";
  }
  async function process(
    connection: NodePgDatabase,
    invoice: StoredInvoice,
    resolutionId: string,
  ): Promise<WorkResult> {
    let row = await active(connection, invoice.invoice.id);
    if (!row || row.id !== resolutionId || row.state === "confirmed")
      return "complete";
    if (row.state === "needs_review") return "needs_review";
    if (row.nextAttemptAt && Date.parse(row.nextAttemptAt) > now().getTime())
      return "retry";
    try {
      await inspect(connection, invoice);
      row = (await active(connection, invoice.invoice.id))!;
      if (row.state === "confirmed") return "complete";
      if (row.state === "needs_review") return "needs_review";
      if (
        row.attemptedAt &&
        now().getTime() - Date.parse(row.attemptedAt) >= 23 * 60 * 60 * 1000
      ) {
        await noteReview(connection, row, "uncertain_outcome");
        return "needs_review";
      }
      if (await collectionHolds(connection, invoice.invoice.id)) {
        await noteReview(connection, row, "collection_conflict");
        return "needs_review";
      }
      if (!row.responseAt) {
        const attemptedAt = row.attemptedAt ?? at();
        await connection.transaction(async (tx) => {
          await tx
            .select({ id: resolutions.id })
            .from(resolutions)
            .where(eq(resolutions.id, row!.id))
            .for("update");
          if ((await guard.assertMayStart(tx)) === "paused")
            throw new FinancialEffectsPaused();
          if (!row!.attemptedAt) {
            await tx
              .update(resolutions)
              .set({ attemptedAt })
              .where(eq(resolutions.id, row!.id));
            await audit.recordOperator(tx, {
              operatorId: workerId,
              customerId: row!.customerId,
              targetId: row!.id,
              action: "invoice.resolution_attempted",
            });
          }
        });
        row = { ...row, attemptedAt };
      }
      const effect = {
        idempotencyKey: `datapad:${deploymentKey}:resolution:${row.id}:${row.kind === "external_payment" ? "settle" : "void"}`,
      };
      const current = await context.load(connection, invoice.invoice.id);
      if (!current?.invoice.providerInvoiceId)
        throw new BillingProviderError("review", "ownership_mismatch");
      // Successful response attribution is durable before the subsequent inspection.
      if (!row.responseAt) {
        const response =
          row.kind === "external_payment"
            ? await provider.settleExternally(
                context.intent(current),
                current.invoice.providerInvoiceId,
                effect,
              )
            : {
                invoice: await provider.voidInvoice(
                  context.intent(current),
                  current.invoice.providerInvoiceId,
                  effect,
                ),
                paidOffStripeMinor: null,
              };
        if (
          response.paidOffStripeMinor !== null &&
          !safeAmount(response.paidOffStripeMinor)
        )
          throw new BillingProviderError("review", "invoice_mismatch", true);
        await connection.transaction(async (tx) => {
          const latest = await context.load(tx, invoice.invoice.id);
          if (!latest)
            throw new BillingProviderError("review", "ownership_mismatch");
          await context.project(tx, latest, response.invoice);
          await tx
            .update(resolutions)
            .set({
              responseAt: at(),
              responsePaidOffStripeMinor: response.paidOffStripeMinor,
            })
            .where(eq(resolutions.id, row!.id));
        });
      }
      const latest = await context.load(connection, invoice.invoice.id);
      if (!latest)
        throw new BillingProviderError("review", "ownership_mismatch");
      await inspect(connection, latest);
      row = (await active(connection, invoice.invoice.id))!;
      if (row.state === "confirmed") return "complete";
      if (row.state === "needs_review") return "needs_review";
      await noteReview(connection, row, "uncertain_outcome");
      return "needs_review";
    } catch (error) {
      if (error instanceof FinancialEffectsPaused) {
        await connection
          .update(resolutions)
          .set({
            nextAttemptAt: new Date(now().getTime() + 30000).toISOString(),
          })
          .where(eq(resolutions.id, resolutionId));
        return "retry";
      }
      const latest = await context.load(connection, invoice.invoice.id);
      const resolution = await active(connection, invoice.invoice.id);
      if (!latest || !resolution) throw error;
      return failure(connection, latest, resolution, error);
    }
  }
  return {
    async recordExternalPayment(actor, customerId, invoiceId, input) {
      if (
        !Value.Check(ExternalPaymentRequestSchema, input) ||
        !validText(input.reference) ||
        input.receivedDate > at().slice(0, 10) ||
        !allowResolution({
          kind: "external_payment",
          customerId,
          invoiceId,
          input,
        })
      )
        return { ok: false, code: "invalid_request" };
      return human(actor, customerId, invoiceId, (connection, invoice) =>
        connection.transaction(
          async (tx): Promise<AccessResult<ResolutionActionResponse>> => {
            const access = await customerAccess.authorizeCustomer(
              tx,
              actor,
              customerId,
              "manage_billing",
              true,
            );
            if (!access.ok) return access;
            await audit.assertRequestUnused(tx, input.requestId);
            if (!editable(invoice) || (await active(tx, invoiceId)))
              return { ok: false, code: "conflict" };
            if (
              invoice.invoice.collectionRemainingMinor !== null &&
              invoice.invoice.collectionRemainingMinor !== input.amountMinor
            )
              return { ok: false, code: "conflict" };
            const held = await collectionHolds(tx, invoiceId);
            const [row] = await tx
              .insert(resolutions)
              .values({
                id: randomUUID(),
                deploymentKey,
                invoiceId,
                billingCustomerId: invoice.customer.id,
                customerId,
                requestId: input.requestId,
                actorId: actor.userId,
                sessionId: actor.sessionId,
                kind: "external_payment",
                state: held ? "needs_review" : "pending",
                reviewReason: held ? "collection_conflict" : null,
                amountMinor: input.amountMinor,
                receivedDate: input.receivedDate,
                method: input.method,
                reference: input.reference,
                createdAt: at(),
              })
              .returning();
            await audit.append(tx, {
              actor,
              customerId,
              targetId: row.id,
              requestId: input.requestId,
              action: "invoice.external_payment_recorded",
              changedFields: ["receipt"],
            });
            return { ok: true, value: { resolution: summary(row) } };
          },
        ),
      );
    },
    async requestVoid(actor, customerId, invoiceId, input) {
      if (
        !Value.Check(VoidInvoiceRequestSchema, input) ||
        !validText(input.reason) ||
        !allowResolution({ kind: "void", customerId, invoiceId, input })
      )
        return { ok: false, code: "invalid_request" };
      return human(
        actor,
        customerId,
        invoiceId,
        async (connection, invoice) => {
          if (
            !editable(invoice) ||
            (await active(connection, invoiceId)) ||
            (await collectionHolds(connection, invoiceId))
          )
            return { ok: false, code: "conflict" };
          const inspection = await inspect(connection, invoice);
          if (
            !["open", "uncollectible"].includes(inspection.invoice.status) ||
            inspection.collectionState !== "idle" ||
            inspection.paidMinor !== 0 ||
            inspection.paidOffStripeMinor !== 0 ||
            inspection.overpaidMinor !== 0 ||
            electronic(inspection).length > 0
          )
            return { ok: false, code: "conflict" };
          return connection.transaction(
            async (tx): Promise<AccessResult<ResolutionActionResponse>> => {
              const access = await customerAccess.authorizeCustomer(
                tx,
                actor,
                customerId,
                "manage_billing",
                true,
              );
              if (!access.ok) return access;
              await audit.assertRequestUnused(tx, input.requestId);
              const createdAt = at();
              const [row] = await tx
                .insert(resolutions)
                .values({
                  id: randomUUID(),
                  deploymentKey,
                  invoiceId,
                  billingCustomerId: invoice.customer.id,
                  customerId,
                  requestId: input.requestId,
                  actorId: actor.userId,
                  sessionId: actor.sessionId,
                  kind: "void",
                  state: "pending",
                  reason: input.reason,
                  createdAt,
                  baselineAt: createdAt,
                  baselineRemainingMinor: inspection.remainingMinor,
                  baselinePaidOffStripeMinor: inspection.paidOffStripeMinor,
                  baselinePayments: electronic(inspection),
                  lastCheckedAt: createdAt,
                  lastRemainingMinor: inspection.remainingMinor,
                  lastCollectionState: inspection.collectionState,
                })
                .returning();
              await audit.append(tx, {
                actor,
                customerId,
                targetId: row.id,
                requestId: input.requestId,
                action: "invoice.void_requested",
                changedFields: ["reason"],
              });
              return { ok: true, value: { resolution: summary(row) } };
            },
          );
        },
      );
    },
    async flagReceiptCorrection(actor, customerId, invoiceId, input) {
      if (
        !Value.Check(ReceiptCorrectionRequestSchema, input) ||
        !validText(input.reason) ||
        !allowResolution({ kind: "correction", customerId, invoiceId, input })
      )
        return { ok: false, code: "invalid_request" };
      return human(actor, customerId, invoiceId, (connection) =>
        connection.transaction(
          async (tx): Promise<AccessResult<ResolutionActionResponse>> => {
            const access = await customerAccess.authorizeCustomer(
              tx,
              actor,
              customerId,
              "manage_billing",
              true,
            );
            if (!access.ok) return access;
            await audit.assertRequestUnused(tx, input.requestId);
            const row = await active(tx, invoiceId);
            if (!row || row.kind !== "external_payment")
              return { ok: false, code: "conflict" };
            const [updated] = await tx
              .update(resolutions)
              .set({
                state: row.attemptedAt ? "needs_review" : "withdrawn",
                reviewReason: row.attemptedAt ? "receipt_correction" : null,
                nextAttemptAt: null,
              })
              .where(eq(resolutions.id, row.id))
              .returning();
            await audit.append(tx, {
              actor,
              customerId,
              targetId: row.id,
              requestId: input.requestId,
              action: "invoice.receipt_correction_requested",
              changedFields: ["correction"],
              reason: input.reason,
            });
            return { ok: true, value: { resolution: summary(updated) } };
          },
        ),
      );
    },
    async reconcileResolution(actor, customerId, invoiceId, input) {
      if (!Value.Check(ReconcileResolutionRequestSchema, input))
        return { ok: false, code: "invalid_request" };
      return human(
        actor,
        customerId,
        invoiceId,
        async (connection, invoice) => {
          const previous = await active(connection, invoiceId);
          if (
            !previous ||
            previous.attemptedAt ||
            previous.state !== "needs_review"
          )
            return { ok: false, code: "conflict" };
          const inspection = await inspect(connection, invoice);
          const row = (await active(connection, invoiceId))!;
          if (
            !editable((await context.load(connection, invoiceId))!) ||
            conflict(row, inspection) ||
            (await collectionHolds(connection, invoiceId))
          )
            return { ok: false, code: "conflict" };
          return connection.transaction(
            async (tx): Promise<AccessResult<ResolutionActionResponse>> => {
              const access = await customerAccess.authorizeCustomer(
                tx,
                actor,
                customerId,
                "manage_billing",
                true,
              );
              if (!access.ok) return access;
              await audit.assertRequestUnused(tx, input.requestId);
              const [updated] = await tx
                .update(resolutions)
                .set({
                  state: "pending",
                  reviewReason: null,
                  attempts: 0,
                  nextAttemptAt: null,
                })
                .where(eq(resolutions.id, row.id))
                .returning();
              await audit.append(tx, {
                actor,
                customerId,
                targetId: row.id,
                requestId: input.requestId,
                action: "invoice.resolution_reconciled",
                changedFields: ["state"],
              });
              return { ok: true, value: { resolution: summary(updated) } };
            },
          );
        },
      );
    },
    async getResolutionReview(actor, customerId, invoiceId) {
      return human(
        actor,
        customerId,
        invoiceId,
        async (connection, invoice) => {
          let inspection: CollectionInspection | null = null;
          const blockers: ResolutionReviewResponse["blockers"] = [];
          if (invoice.invoice.providerInvoiceId) {
            try {
              inspection = await inspect(connection, invoice);
            } catch (error) {
              blockers.push(
                error instanceof BillingProviderError && error.kind === "review"
                  ? inspectionFailureReason(error)
                  : "provider_unavailable",
              );
            }
          } else blockers.push("not_finalized");
          return connection.transaction(
            async (tx): Promise<AccessResult<ResolutionReviewResponse>> => {
              const access = await customerAccess.authorizeCustomer(
                tx,
                actor,
                customerId,
                "manage_billing",
                true,
              );
              if (!access.ok) return access;
              const history = await tx
                .select()
                .from(resolutions)
                .where(eq(resolutions.invoiceId, invoiceId))
                .orderBy(desc(resolutions.createdAt), desc(resolutions.id))
                .limit(100);
              const row = await active(tx, invoiceId);
              const current = await context.load(tx, invoiceId);
              const actions: ResolutionReviewResponse["actions"] = [];
              const collectionHeld = await collectionHolds(tx, invoiceId);
              if (collectionHeld) blockers.push("collection_conflict");
              if (row) {
                blockers.push("existing_resolution");
                if (row.reviewReason) blockers.push(row.reviewReason);
                if (row.kind === "external_payment")
                  actions.push("correct_receipt");
                if (
                  !row.attemptedAt &&
                  row.state === "needs_review" &&
                  current &&
                  editable(current) &&
                  inspection &&
                  !conflict(row, inspection) &&
                  !collectionHeld
                )
                  actions.push("reconcile");
              } else if (inspection) {
                if (!current || !editable(current)) blockers.push("terminal");
                else if (inspection.collectionState !== "idle") {
                  blockers.push("collection_conflict");
                  if (inspection.remainingMinor > 0)
                    actions.push("record_external_payment");
                } else if (inspection.remainingMinor > 0) {
                  actions.push("record_external_payment");
                  if (
                    inspection.paidMinor === 0 &&
                    inspection.paidOffStripeMinor === 0 &&
                    inspection.overpaidMinor === 0 &&
                    electronic(inspection).length === 0 &&
                    !collectionHeld
                  )
                    actions.push("void");
                }
              } else if (current && editable(current))
                actions.push("record_external_payment");
              return {
                ok: true,
                value: {
                  invoiceId,
                  remainingMinor: inspection?.remainingMinor ?? null,
                  collectionState: inspection?.collectionState ?? "unknown",
                  lastCheckedAt: inspection ? at() : null,
                  actions,
                  blockers,
                  resolution: row ? detail(row) : null,
                  history: history.map(detail),
                },
              };
            },
          );
        },
      );
    },
    async inspectResolution(id) {
      if (!isUuid(id)) return "complete";
      const [row] = await db
        .select()
        .from(resolutions)
        .where(
          and(
            eq(resolutions.id, id),
            eq(resolutions.deploymentKey, deploymentKey),
          ),
        );
      if (!row) return "complete";
      return context.locked<WorkResult>(
        row.invoiceId,
        "complete",
        async (connection, invoice) => {
          try {
            await inspect(connection, invoice);
            const current = await active(connection, invoice.invoice.id);
            return current?.state === "needs_review"
              ? "needs_review"
              : current?.state === "pending"
                ? "retry"
                : "complete";
          } catch (error) {
            return error instanceof BillingProviderError &&
              error.kind === "review"
              ? "needs_review"
              : "retry";
          }
        },
      );
    },
    async processResolution(id) {
      if (!isUuid(id)) return "complete";
      const [row] = await db
        .select()
        .from(resolutions)
        .where(
          and(
            eq(resolutions.id, id),
            eq(resolutions.deploymentKey, deploymentKey),
          ),
        );
      if (!row) return "complete";
      return context.locked<WorkResult>(
        row.invoiceId,
        "complete",
        (connection, invoice) => process(connection, invoice, id),
      );
    },
    async pendingResolutions(input = {}) {
      const paused = await db.transaction(
        async (tx) => (await guard.assertMayStart(tx)) === "paused",
      );
      const candidates = db
        .select({
          id: sql`${resolutions.id}::text`.as("id"),
          kind: sql`'resolution'::text`.as("kind"),
          createdAt: sql`${resolutions.createdAt}`.as("created_at"),
        })
        .from(resolutions)
        .where(
          and(
            eq(resolutions.deploymentKey, deploymentKey),
            eq(resolutions.state, "pending"),
            paused ? sql`${resolutions.attemptedAt} is not null` : undefined,
            or(
              isNull(resolutions.nextAttemptAt),
              lte(resolutions.nextAttemptAt, at()),
            ),
          ),
        );
      const page = await pendingPage(
        db,
        candidates.getSQL(),
        ["resolution"],
        input,
      );
      return {
        ...page,
        work: page.work.map((row) => ({
          kind: "resolution" as const,
          resolutionId: row.id,
        })),
      };
    },
    async assertSyntheticData() {
      const rows = await db.select().from(resolutions);
      for (const row of rows) {
        const invoice = await context.load(db, row.invoiceId);
        if (
          !invoice ||
          row.deploymentKey !== deploymentKey ||
          row.customerId !== invoice.customer.customerId ||
          !allowResolution(
            row.kind === "external_payment"
              ? {
                  kind: "external_payment",
                  customerId: row.customerId,
                  invoiceId: row.invoiceId,
                  input: {
                    requestId: row.requestId,
                    amountMinor: row.amountMinor!,
                    receivedDate: row.receivedDate!,
                    method: row.method!,
                    reference: row.reference!,
                  },
                }
              : {
                  kind: "void",
                  customerId: row.customerId,
                  invoiceId: row.invoiceId,
                  input: { requestId: row.requestId, reason: row.reason! },
                },
          )
        )
          throw new Error("Resolution outside synthetic policy");
      }
    },
  };
}
