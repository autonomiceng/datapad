import { pendingPage } from "./pending-page";
import { withLocks } from "./locks";
import {
  createFinancialEffectGuard,
  FinancialEffectsPaused,
} from "./effect-guard";
import { and, eq, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { createAuditWriter } from "../../access";
import { BillingProviderError, type ProviderInvoice } from "../provider";
import type { ReviewReason } from "../contract";
import type {
  BillingCommands,
  BillingOptions,
  IssueResult,
  PendingWork,
  WorkResult,
} from "../types";
import {
  billingCustomers,
  invoiceLines,
  invoices,
  stripeEvents,
} from "./schema";
import { createInvoiceContext, type StoredInvoice } from "./invoice-context";
import { billingInvoiceResolutions } from "./resolutions-schema";
import {
  reconcileResolutionSnapshot,
  reconcileResolutionFailure,
} from "./resolutions";
import { billingSchedules, billingInvoiceGroups } from "./scheduled-schema";
import { billingPaymentAttempts } from "./collection-schema";
import {
  reconcileCollectionSnapshot,
  reconcileCollectionFailure,
} from "./collection-observation";
import { isUuid } from "./validate";
import { createCustomerReceipt } from "./customer-receipt";

class IssuanceDeferred extends Error {}

const terminal = (status: string | null) =>
  status === "paid" || status === "void";
const delays = [5000, 30000, 120000, 600000];
function review(reason: ReviewReason, receiptMismatch = false): never {
  throw new BillingProviderError("review", reason, receiptMismatch);
}

export function createLifecycle(
  options: BillingOptions,
): Omit<BillingCommands, "requestInvoice"> {
  const {
    pool,
    provider,
    deploymentKey,
    now = () => new Date(),
    businessNow = now,
  } = options;
  for (const inspectionProvider of [
    options.resolutionProvider,
    options.collectionProvider,
  ]) {
    if (
      inspectionProvider &&
      (inspectionProvider.ownership.accountId !==
        provider.ownership.accountId ||
        inspectionProvider.ownership.deploymentKey !== deploymentKey)
    )
      throw new Error(
        "Collection inspection provider ownership differs from billing",
      );
  }
  const reconciliationAudit = {
    audit: createAuditWriter(),
    operatorId: "billing-reconciliation",
  };
  const guard = createFinancialEffectGuard(deploymentKey);
  const db = drizzle(pool);
  const at = () => now().toISOString();
  const scope = (id: string) =>
    and(eq(invoices.id, id), eq(invoices.deploymentKey, deploymentKey));
  const due = (value: string | null) =>
    value === null || new Date(value).getTime() <= now().getTime();
  const effectKey = (kind: string, id: string, action = "create") => ({
    idempotencyKey: `datapad:${deploymentKey}:${kind}:${id}:${action}`,
  });

  const context = createInvoiceContext({
    pool,
    deploymentKey,
    ownership: provider.ownership,
    now,
  });
  const { locked, intent, verify, verifyLine } = context;
  async function project(
    connection: NodePgDatabase,
    record: StoredInvoice,
    snapshot: ProviderInvoice,
  ) {
    await connection.transaction(async (tx) => {
      const current = await context.load(tx, record.invoice.id);
      if (!current) review("ownership_mismatch");
      await context.project(tx, current, snapshot);
    });
  }
  async function failure(
    connection: NodePgDatabase,
    record: StoredInvoice,
    error: unknown,
    eventId?: string,
    collectionInspection = false,
  ): Promise<WorkResult> {
    const reason =
      error instanceof BillingProviderError && error.kind === "review"
        ? error.reason
        : "retry_exhausted";
    const definitive =
      error instanceof BillingProviderError && error.kind === "review";
    const eventOnly =
      eventId && !definitive && !record.invoice.providerInvoiceId;
    const [event] = eventId
      ? await connection
          .select()
          .from(stripeEvents)
          .where(eq(stripeEvents.eventId, eventId))
      : [];
    const attempts = (event?.attempts ?? record.invoice.attempts) + 1;
    const exhausted = definitive || attempts >= 5;
    const nextAttemptAt = exhausted
      ? null
      : new Date(now().getTime() + delays[attempts - 1]).toISOString();
    await connection.transaction(async (tx) => {
      if (collectionInspection) {
        const safeError =
          error instanceof BillingProviderError
            ? error
            : new BillingProviderError("retryable", "retry_exhausted");
        await reconcileResolutionFailure(
          tx,
          record.invoice.id,
          safeError,
          reconciliationAudit,
        );
        await reconcileCollectionFailure(
          tx,
          record.invoice.id,
          safeError,
          now(),
        );
      }
      if (eventId)
        await tx
          .update(stripeEvents)
          .set({
            attempts,
            nextAttemptAt,
            lastError: exhausted ? reason : "provider_unavailable",
          })
          .where(eq(stripeEvents.eventId, eventId));
      if (
        definitive &&
        (!collectionInspection || error.receiptMismatch) &&
        (error.receiptMismatch || !terminal(record.invoice.providerStatus))
      ) {
        if (error.receiptMismatch) {
          await context.mismatch(tx, record, reason);
          if (!eventId)
            await tx
              .update(invoices)
              .set({ attempts })
              .where(scope(record.invoice.id));
        } else
          await tx
            .update(invoices)
            .set({
              state: "needs_review",
              reviewReason: reason,
              nextAttemptAt: null,
              ...(eventId ? {} : { attempts }),
            })
            .where(scope(record.invoice.id));
      } else if (
        !eventOnly &&
        (record.invoice.providerReceiptState === "unverified" ||
          (record.invoice.providerReceiptState === "verified" &&
            record.invoice.providerStatus === "draft")) &&
        !terminal(record.invoice.providerStatus) &&
        (exhausted || !eventId)
      )
        await tx
          .update(invoices)
          .set(
            exhausted
              ? {
                  state: "needs_review",
                  reviewReason: reason,
                  nextAttemptAt: null,
                  ...(eventId ? {} : { attempts }),
                }
              : { attempts, nextAttemptAt },
          )
          .where(scope(record.invoice.id));
    });
    return exhausted ? "needs_review" : "retry";
  }
  function canRetry(attemptedAt: string | null, reason: ReviewReason) {
    if (
      attemptedAt &&
      now().getTime() - Date.parse(attemptedAt) >= 23 * 60 * 60 * 1000
    )
      review(reason);
  }
  async function checkIssuance(
    tx: NodePgDatabase,
    record: StoredInvoice,
    attemptedAt: string | null,
    finalizing = false,
  ) {
    if (attemptedAt) return;
    const [group] = await tx
      .select()
      .from(billingInvoiceGroups)
      .where(
        and(
          eq(billingInvoiceGroups.invoiceId, record.invoice.id),
          eq(billingInvoiceGroups.deploymentKey, deploymentKey),
        ),
      );
    if (group) {
      const [schedule] = await tx
        .select()
        .from(billingSchedules)
        .where(
          and(
            eq(billingSchedules.customerId, group.customerId),
            eq(billingSchedules.deploymentKey, deploymentKey),
          ),
        )
        .for("share");
      if (!schedule || group.customerId !== record.customer.customerId)
        review("ownership_mismatch");
      const calendarNow = businessNow().getTime();
      if (calendarNow < Date.parse(record.invoice.issueNotBefore))
        throw new IssuanceDeferred();
      if (calendarNow >= Date.parse(record.invoice.firstAttemptBefore))
        review("provider_conflict");
      if (schedule.issuancePaused) throw new IssuanceDeferred();
    } else if (
      !finalizing &&
      !record.invoice.createAttemptedAt &&
      now().getTime() >= Date.parse(record.invoice.firstAttemptBefore)
    )
      review("provider_conflict");
  }
  async function stampEffect(
    connection: NodePgDatabase,
    record: StoredInvoice,
    effect: "invoice" | "finalize",
  ) {
    const attemptedAt =
      effect === "invoice"
        ? record.invoice.createAttemptedAt
        : record.invoice.finalizeAttemptedAt;
    const stamp = await connection.transaction(async (tx) => {
      await checkIssuance(tx, record, attemptedAt, effect === "finalize");
      await tx
        .select({ id: invoices.id })
        .from(invoices)
        .where(scope(record.invoice.id))
        .for("update");
      if ((await guard.assertMayStart(tx)) === "paused")
        throw new FinancialEffectsPaused();
      if (attemptedAt) return attemptedAt;
      const stamp = at();
      await tx
        .update(invoices)
        .set(
          effect === "invoice"
            ? { createAttemptedAt: stamp }
            : { finalizeAttemptedAt: stamp },
        )
        .where(scope(record.invoice.id));
      return stamp;
    });
    if (effect === "invoice") record.invoice.createAttemptedAt = stamp;
    else record.invoice.finalizeAttemptedAt = stamp;
  }
  const recoverCustomer = createCustomerReceipt({
    provider,
    deploymentKey,
    now,
  });
  async function customerReceipt(
    connection: NodePgDatabase,
    record: StoredInvoice,
  ) {
    record.customer.providerCustomerId = await recoverCustomer(
      connection,
      record.customer.id,
      (tx) => checkIssuance(tx, record, record.customer.createAttemptedAt),
    );
  }
  async function issuanceNow(connection: NodePgDatabase, invoiceId: string) {
    if (!options.businessNow) return now();
    const [group] = await connection
      .select({ id: billingInvoiceGroups.id })
      .from(billingInvoiceGroups)
      .where(
        and(
          eq(billingInvoiceGroups.invoiceId, invoiceId),
          eq(billingInvoiceGroups.deploymentKey, deploymentKey),
        ),
      );
    return group ? businessNow() : now();
  }
  async function issue(
    connection: NodePgDatabase,
    record: StoredInvoice,
    retrievalOnly = false,
  ): Promise<WorkResult> {
    const invoice = record.invoice;
    if (
      !invoice.issueRequestedAt ||
      terminal(invoice.providerStatus) ||
      ["open", "uncollectible"].includes(invoice.state)
    )
      return "complete";
    if (!retrievalOnly && invoice.state === "needs_review")
      return "needs_review";
    if (!retrievalOnly && !due(invoice.nextAttemptAt)) return "retry";
    if (
      (await issuanceNow(connection, invoice.id)).getTime() <
      Date.parse(invoice.issueNotBefore)
    )
      return "retry";
    try {
      if (!retrievalOnly)
        await connection
          .update(invoices)
          .set({ state: "preparing" })
          .where(scope(invoice.id));
      if (invoice.billToName !== record.customer.name)
        review("invoice_mismatch");
      if (retrievalOnly) {
        record.customer.providerCustomerId = await recoverCustomer(
          connection,
          record.customer.id,
          undefined,
          { retrievalOnly: true },
        );
      } else await customerReceipt(connection, record);
      const expected = intent(record);
      let snapshot: ProviderInvoice;
      if (invoice.providerInvoiceId)
        snapshot = await provider.retrieveInvoice(
          expected,
          invoice.providerInvoiceId,
        );
      else {
        if (retrievalOnly && !invoice.createAttemptedAt) return "complete";
        const found = await provider.findInvoice(expected);
        if (found.kind === "ambiguous") review("uncertain_invoice");
        if (found.kind === "found") snapshot = found.value;
        else {
          canRetry(invoice.createAttemptedAt, "uncertain_invoice");
          if (retrievalOnly) return "retry";
          await stampEffect(connection, record, "invoice");
          snapshot = await provider.createInvoice(
            expected,
            effectKey("invoice", invoice.id),
          );
        }
      }
      verify(record, snapshot);
      await connection
        .update(invoices)
        .set({
          providerInvoiceId: snapshot.providerInvoiceId,
          providerStatus: snapshot.status,
        })
        .where(scope(invoice.id));
      invoice.providerInvoiceId = snapshot.providerInvoiceId;
      if (snapshot.status !== "draft") {
        await project(connection, record, snapshot);
        return "complete";
      }
      for (const line of record.lines) {
        const found = snapshot.lines.find((value) => value.lineId === line.id);
        if (found) {
          await connection
            .update(invoiceLines)
            .set({ providerLineId: found.providerLineId })
            .where(eq(invoiceLines.id, line.id));
          line.providerLineId = found.providerLineId;
          continue;
        }
        if (line.providerLineId) review("invoice_mismatch", true);
        canRetry(line.createAttemptedAt, "uncertain_line");
        if (retrievalOnly) return "retry";
        await connection.transaction(async (tx) => {
          await tx
            .select({ id: invoiceLines.id })
            .from(invoiceLines)
            .where(eq(invoiceLines.id, line.id))
            .for("update");
          if ((await guard.assertMayStart(tx)) === "paused")
            throw new FinancialEffectsPaused();
          await tx
            .update(invoiceLines)
            .set({ createAttemptedAt: line.createAttemptedAt ?? at() })
            .where(eq(invoiceLines.id, line.id));
        });
        const receipt = await provider.addLine(
          expected,
          snapshot.providerInvoiceId,
          expected.lines[line.position],
          effectKey("line", line.id),
        );
        verifyLine(receipt, line);
        await connection
          .update(invoiceLines)
          .set({ providerLineId: receipt.providerLineId })
          .where(eq(invoiceLines.id, line.id));
        line.providerLineId = receipt.providerLineId;
      }
      snapshot = await provider.retrieveInvoice(
        expected,
        snapshot.providerInvoiceId,
      );
      verify(record, snapshot, true);
      if (snapshot.status === "draft") {
        canRetry(invoice.finalizeAttemptedAt, "provider_conflict");
        if (retrievalOnly) return "retry";
        await stampEffect(connection, record, "finalize");
        snapshot = await provider.finalizeInvoice(
          expected,
          snapshot.providerInvoiceId,
          effectKey("invoice", invoice.id, "finalize"),
        );
        if (snapshot.status === "draft") review("provider_conflict", true);
      }
      await project(connection, record, snapshot);
      return "complete";
    } catch (error) {
      if (
        error instanceof FinancialEffectsPaused ||
        error instanceof IssuanceDeferred
      ) {
        if (retrievalOnly) return "retry";
        await connection
          .update(invoices)
          .set({
            nextAttemptAt: new Date(now().getTime() + 30000).toISOString(),
          })
          .where(scope(invoice.id));
        return "retry";
      }
      return failure(connection, record, error);
    }
  }
  async function refresh(
    connection: NodePgDatabase,
    record: StoredInvoice,
    providerId: string | null,
    eventId?: string,
    check?: Parameters<BillingCommands["refreshInvoice"]>[1],
  ): Promise<WorkResult> {
    if (!providerId) return "complete";
    if (
      check?.explicitCheck &&
      record.invoice.collectionCheckedAt &&
      record.invoice.collectionState !== null &&
      record.invoice.collectionState !== "unknown"
    ) {
      const age =
        now().getTime() - Date.parse(record.invoice.collectionCheckedAt);
      if (age >= 0 && age <= 5000) return "complete";
    }
    let collectionInspection = false;
    try {
      const [resolution] = await connection
        .select()
        .from(billingInvoiceResolutions)
        .where(
          and(
            eq(billingInvoiceResolutions.invoiceId, record.invoice.id),
            sql`${billingInvoiceResolutions.state} <> 'withdrawn'`,
          ),
        );
      const [attempt] = await connection
        .select({ state: billingPaymentAttempts.state })
        .from(billingPaymentAttempts)
        .where(eq(billingPaymentAttempts.invoiceId, record.invoice.id));
      // Customer checks cannot spend the worker's inspection failure budget.
      if (
        check?.explicitCheck &&
        !check.canManageBilling &&
        attempt &&
        ["pending", "processing"].includes(attempt.state)
      )
        return "complete";
      const [automaticGroup] = await connection
        .select({ id: billingInvoiceGroups.id })
        .from(billingInvoiceGroups)
        .where(
          and(
            eq(billingInvoiceGroups.invoiceId, record.invoice.id),
            eq(billingInvoiceGroups.deploymentKey, deploymentKey),
            eq(billingInvoiceGroups.paymentArrangement, "automatic"),
            sql`${billingInvoiceGroups.totalMinor} > 0`,
          ),
        );
      const inspectionProvider =
        options.collectionProvider ?? options.resolutionProvider;
      collectionInspection = Boolean(
        resolution ||
        attempt ||
        automaticGroup ||
        (check?.explicitCheck && inspectionProvider),
      );
      if (collectionInspection && !inspectionProvider)
        throw new BillingProviderError("retryable", "retry_exhausted");
      const observedAt = now();
      const inspection =
        collectionInspection && inspectionProvider
          ? await inspectionProvider.inspectCollection(
              intent(record),
              providerId,
            )
          : null;
      const snapshot =
        inspection?.invoice ??
        (await provider.retrieveInvoice(intent(record), providerId));
      if (snapshot.providerInvoiceId !== providerId)
        review("ownership_mismatch", true);
      await connection.transaction(async (tx) => {
        const current = await context.load(tx, record.invoice.id);
        if (!current) review("ownership_mismatch");
        if (inspection) {
          context.verify(current, snapshot);
          const wallNow = now();
          await reconcileResolutionSnapshot(
            tx,
            current,
            inspection,
            wallNow,
            reconciliationAudit,
          );
          await reconcileCollectionSnapshot(
            tx,
            current,
            inspection,
            wallNow,
            observedAt,
          );
          try {
            await context.project(tx, current, snapshot);
          } catch (error) {
            if (
              !(error instanceof BillingProviderError) ||
              error.reason !== "provider_conflict" ||
              !error.receiptMismatch
            )
              throw error;
            await context.mismatch(tx, current, error.reason);
          }
        } else await context.project(tx, current, snapshot);
        if (eventId)
          await tx
            .update(stripeEvents)
            .set({ processedAt: at(), nextAttemptAt: null, lastError: null })
            .where(eq(stripeEvents.eventId, eventId));
      });
      return "complete";
    } catch (error) {
      if (
        eventId &&
        error instanceof BillingProviderError &&
        error.kind === "review" &&
        error.reason === "ownership_mismatch" &&
        record.invoice.providerInvoiceId !== providerId
      ) {
        await connection
          .update(stripeEvents)
          .set({
            processedAt: at(),
            nextAttemptAt: null,
            lastError: "ownership_mismatch",
          })
          .where(eq(stripeEvents.eventId, eventId));
        return "complete";
      }
      return failure(connection, record, error, eventId, collectionInspection);
    }
  }

  return {
    inspectInvoice: (id) =>
      locked<WorkResult>(id, "complete", (connection, record) =>
        record.invoice.providerInvoiceId
          ? refresh(connection, record, record.invoice.providerInvoiceId)
          : issue(connection, record, true),
      ),
    async inspectCustomer(id) {
      if (!isUuid(id)) return "complete";
      return withLocks(pool, [`customer:${id}`], async (connection) => {
        const [row] = await connection
          .select()
          .from(billingCustomers)
          .where(
            and(
              eq(billingCustomers.id, id),
              eq(billingCustomers.deploymentKey, deploymentKey),
            ),
          );
        if (!row || (!row.createAttemptedAt && !row.providerCustomerId))
          return "complete";
        try {
          await recoverCustomer(connection, id, undefined, {
            retrievalOnly: true,
          });
          return "complete";
        } catch (error) {
          if (error instanceof FinancialEffectsPaused) return "retry";
          if (error instanceof BillingProviderError && error.kind === "review")
            return "needs_review";
          return "retry";
        }
      });
    },
    requestIssue: (id) =>
      locked<IssueResult>(
        id,
        { kind: "not_found" },
        async (connection, { invoice }) => {
          if (invoice.state === "needs_review") return { kind: "needs_review" };
          if (invoice.issueRequestedAt) return { kind: "unchanged" };
          const calendarNow = await issuanceNow(connection, id);
          if (calendarNow.getTime() < Date.parse(invoice.issueNotBefore))
            return { kind: "not_ready" };
          if (calendarNow.getTime() >= Date.parse(invoice.firstAttemptBefore))
            return { kind: "past_due" };
          await connection
            .update(invoices)
            .set({ issueRequestedAt: at(), state: "preparing" })
            .where(scope(id));
          return { kind: "accepted" };
        },
      ),
    issueInvoice: (id) => locked<WorkResult>(id, "complete", issue),
    refreshInvoice: (id, check) =>
      locked<WorkResult>(id, "complete", (connection, record) =>
        refresh(
          connection,
          record,
          record.invoice.providerInvoiceId,
          undefined,
          check,
        ),
      ),
    async acceptEvent(event) {
      if (
        event.deploymentKey !== deploymentKey ||
        event.accountId !== provider.ownership.accountId
      )
        return "ignored";
      const mapping = or(
        eq(invoices.providerInvoiceId, event.providerInvoiceId),
        event.invoiceId && isUuid(event.invoiceId)
          ? eq(invoices.id, event.invoiceId)
          : undefined,
      );
      const matches = await db
        .select()
        .from(invoices)
        .where(and(eq(invoices.deploymentKey, deploymentKey), mapping));
      if (matches.length !== 1) return "ignored";
      const invoice = matches[0];
      if (
        !invoice.issueRequestedAt ||
        (invoice.providerInvoiceId &&
          invoice.providerInvoiceId !== event.providerInvoiceId)
      )
        return "ignored";
      const stored = await db
        .insert(stripeEvents)
        .values({
          eventId: event.eventId,
          deploymentKey,
          providerAccountId: event.accountId,
          eventType: event.eventType,
          providerInvoiceId: event.providerInvoiceId,
          invoiceId: invoice.id,
          createdAt: event.createdAt,
          receivedAt: at(),
        })
        .onConflictDoNothing()
        .returning({ id: stripeEvents.eventId });
      return stored.length ? "accepted" : "duplicate";
    },
    async processEvent(eventId) {
      const [initial] = await db
        .select()
        .from(stripeEvents)
        .where(
          and(
            eq(stripeEvents.eventId, eventId),
            eq(stripeEvents.deploymentKey, deploymentKey),
          ),
        );
      if (!initial?.invoiceId || initial.processedAt) return "complete";
      return locked<WorkResult>(
        initial.invoiceId,
        "complete",
        async (connection, record) => {
          const [event] = await connection
            .select()
            .from(stripeEvents)
            .where(eq(stripeEvents.eventId, eventId));
          if (event.processedAt) return "complete";
          if (
            event.attempts >= 5 ||
            (event.lastError && event.nextAttemptAt === null)
          )
            return "needs_review";
          if (!due(event.nextAttemptAt)) return "retry";
          return refresh(connection, record, event.providerInvoiceId, eventId);
        },
      );
    },
    async pendingWork(input = {}) {
      const paused = await db.transaction(
        async (tx) => (await guard.assertMayStart(tx)) === "paused",
      );
      const eligible = db
        .select({
          id: sql`${invoices.id}::text`.as("id"),
          kind: sql`'issue'::text`.as("kind"),
          createdAt: sql`${invoices.createdAt}`.as("created_at"),
        })
        .from(invoices)
        .innerJoin(
          billingCustomers,
          eq(invoices.billingCustomerId, billingCustomers.id),
        )
        .leftJoin(
          billingInvoiceGroups,
          and(
            eq(billingInvoiceGroups.invoiceId, invoices.id),
            eq(billingInvoiceGroups.deploymentKey, invoices.deploymentKey),
          ),
        )
        .leftJoin(
          billingSchedules,
          and(
            eq(billingSchedules.customerId, billingInvoiceGroups.customerId),
            eq(
              billingSchedules.deploymentKey,
              billingInvoiceGroups.deploymentKey,
            ),
          ),
        )
        .where(
          and(
            eq(invoices.deploymentKey, deploymentKey),
            isNotNull(invoices.issueRequestedAt),
            paused
              ? or(
                  isNotNull(invoices.createAttemptedAt),
                  and(
                    isNotNull(billingCustomers.createAttemptedAt),
                    isNull(billingCustomers.providerCustomerId),
                  ),
                )
              : undefined,
            sql`${invoices.issueNotBefore} <= case when ${billingInvoiceGroups.id} is null then ${at()}::timestamptz else ${businessNow().toISOString()}::timestamptz end`,
            inArray(invoices.state, ["preparing", "draft"]),
            or(
              isNull(billingInvoiceGroups.id),
              isNull(billingSchedules.customerId),
              eq(billingSchedules.issuancePaused, false),
              sql`${invoices.firstAttemptBefore} <= case when ${billingInvoiceGroups.id} is null then ${at()}::timestamptz else ${businessNow().toISOString()}::timestamptz end`,
              sql`case
                when ${billingCustomers.providerCustomerId} is null then ${billingCustomers.createAttemptedAt} is not null
                when ${invoices.providerInvoiceId} is null then ${invoices.createAttemptedAt} is not null
                when ${invoices.providerStatus} is distinct from 'draft' then true
                else ${invoices.finalizeAttemptedAt} is not null or exists (
                  select 1 from ${invoiceLines} where ${invoiceLines.invoiceId} = ${invoices.id} and ${invoiceLines.providerLineId} is null
                )
              end`,
            ),
            or(
              isNull(invoices.nextAttemptAt),
              lte(invoices.nextAttemptAt, at()),
            ),
          ),
        );
      const events = db
        .select({
          id: sql`${stripeEvents.eventId}`.as("id"),
          kind: sql`'event'::text`.as("kind"),
          createdAt: sql`${stripeEvents.receivedAt}`.as("created_at"),
        })
        .from(stripeEvents)
        .where(
          and(
            eq(stripeEvents.deploymentKey, deploymentKey),
            isNull(stripeEvents.processedAt),
            or(
              isNull(stripeEvents.lastError),
              isNotNull(stripeEvents.nextAttemptAt),
            ),
            or(
              isNull(stripeEvents.nextAttemptAt),
              lte(stripeEvents.nextAttemptAt, at()),
            ),
          ),
        );
      const page = await pendingPage(
        db,
        sql`${eligible.getSQL()} union all ${events.getSQL()}`,
        ["issue", "event"],
        input,
      );
      return {
        ...page,
        work: page.work.map((row): PendingWork =>
          row.kind === "issue"
            ? { kind: "issue", invoiceId: row.id }
            : { kind: "event", eventId: row.id },
        ),
      };
    },
  };
}
