import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  BillingProviderError,
  type CustomerIntent,
  type InvoiceIntent,
  type ProviderInvoice,
  type ProviderLine,
} from "../provider";
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
import { withLocks } from "./locks";
import { billingSchedules, billingInvoiceGroups } from "./scheduled-schema";
import { isUuid } from "./validate";

class IssuanceDeferred extends Error {}

type Invoice = typeof invoices.$inferSelect;
type Customer = typeof billingCustomers.$inferSelect;
type Line = typeof invoiceLines.$inferSelect;
interface StoredInvoice {
  invoice: Invoice;
  customer: Customer;
  lines: Line[];
}
const terminal = (status: string | null) =>
  status === "paid" || status === "void";
const delays = [5000, 30000, 120000, 600000];
function review(reason: ReviewReason, receiptMismatch = false): never {
  throw new BillingProviderError("review", reason, receiptMismatch);
}

export function createLifecycle(
  options: BillingOptions,
): Omit<BillingCommands, "requestInvoice"> {
  const { pool, provider, deploymentKey, now = () => new Date() } = options;
  const db = drizzle(pool);
  const at = () => now().toISOString();
  const scope = (id: string) =>
    and(eq(invoices.id, id), eq(invoices.deploymentKey, deploymentKey));
  const due = (value: string | null) =>
    value === null || new Date(value).getTime() <= now().getTime();
  const effectKey = (kind: string, id: string, action = "create") => ({
    idempotencyKey: `datapad:${deploymentKey}:${kind}:${id}:${action}`,
  });

  async function load(
    connection: NodePgDatabase,
    id: string,
  ): Promise<StoredInvoice | null> {
    const [row] = await connection
      .select({ invoice: invoices, customer: billingCustomers })
      .from(invoices)
      .innerJoin(
        billingCustomers,
        eq(invoices.billingCustomerId, billingCustomers.id),
      )
      .where(scope(id));
    if (!row) return null;
    if (row.customer.providerAccountId !== provider.ownership.accountId)
      review("ownership_mismatch");
    const lines = await connection
      .select()
      .from(invoiceLines)
      .where(eq(invoiceLines.invoiceId, id))
      .orderBy(asc(invoiceLines.position));
    return { ...row, lines };
  }
  async function locked<T>(
    id: string,
    missing: T,
    work: (connection: NodePgDatabase, record: StoredInvoice) => Promise<T>,
  ): Promise<T> {
    if (!isUuid(id)) return missing;
    const [row] = await db
      .select({ billingCustomerId: invoices.billingCustomerId })
      .from(invoices)
      .where(scope(id));
    if (!row) return missing;
    return withLocks(
      pool,
      [`customer:${row.billingCustomerId}`, `invoice:${id}`],
      async (connection) => {
        const record = await load(connection, id);
        return record ? work(connection, record) : missing;
      },
    );
  }
  function intent(record: StoredInvoice): InvoiceIntent {
    if (!record.customer.providerCustomerId) review("ownership_mismatch");
    return {
      ...provider.ownership,
      invoiceId: record.invoice.id,
      customerId: record.customer.id,
      providerCustomerId: record.customer.providerCustomerId,
      recipientName: record.customer.name,
      issueDate: record.invoice.issueDate,
      dueDate: record.invoice.dueDate,
      dueEndAt: new Date(record.invoice.dueEndAt).toISOString(),
      currency: "USD",
      totalMinor: record.invoice.totalMinor,
      lines: record.lines.map((line) => ({
        lineId: line.id,
        position: line.position,
        description: line.description,
        amountMinor: line.amountMinor,
      })),
    };
  }
  function verifyLine(line: ProviderLine, expected: Line) {
    if (
      line.lineId !== expected.id ||
      line.position !== expected.position ||
      line.amountMinor !== expected.amountMinor ||
      line.description !== expected.description ||
      line.currency !== "USD" ||
      !line.providerLineId ||
      (expected.providerLineId !== null &&
        line.providerLineId !== expected.providerLineId)
    )
      review("invoice_mismatch", true);
  }
  function verify(
    record: StoredInvoice,
    snapshot: ProviderInvoice,
    complete = snapshot.status !== "draft",
  ) {
    const expected = intent(record);
    if (
      snapshot.livemode !== false ||
      snapshot.deploymentKey !== deploymentKey ||
      snapshot.accountId !== provider.ownership.accountId ||
      snapshot.invoiceId !== expected.invoiceId ||
      snapshot.customerId !== expected.customerId ||
      snapshot.providerCustomerId !== expected.providerCustomerId ||
      !snapshot.providerInvoiceId ||
      (record.invoice.providerInvoiceId &&
        snapshot.providerInvoiceId !== record.invoice.providerInvoiceId)
    )
      review("ownership_mismatch", true);
    if (
      snapshot.recipientName !== expected.recipientName ||
      snapshot.recipientEmail !== `${expected.customerId}@billing.test` ||
      snapshot.currency !== "USD" ||
      snapshot.issueDate !== expected.issueDate ||
      snapshot.dueDate !== expected.dueDate ||
      Date.parse(snapshot.dueEndAt) !== Date.parse(expected.dueEndAt) ||
      snapshot.collectionMethod !== "send_invoice" ||
      snapshot.autoAdvance !== false ||
      !["draft", "open", "paid", "void", "uncollectible"].includes(
        snapshot.status,
      )
    )
      review("invoice_mismatch", true);
    const ids = new Set<string>();
    const providerIds = new Set<string>();
    for (const line of snapshot.lines) {
      const expectedLine = record.lines.find(
        (value) => value.id === line.lineId,
      );
      if (
        !expectedLine ||
        ids.has(line.lineId) ||
        providerIds.has(line.providerLineId)
      )
        review("invoice_mismatch", true);
      verifyLine(line, expectedLine);
      ids.add(line.lineId);
      providerIds.add(line.providerLineId);
    }
    if (
      snapshot.totalMinor !==
        snapshot.lines.reduce((sum, line) => sum + line.amountMinor, 0) ||
      (complete &&
        (ids.size !== record.lines.length ||
          snapshot.totalMinor !== expected.totalMinor))
    )
      review("invoice_mismatch", true);
    if (
      snapshot.hostedInvoiceUrl !== null &&
      !snapshot.hostedInvoiceUrl.startsWith("https://invoice.stripe.com/")
    )
      review("invoice_mismatch", true);
    if (
      snapshot.status !== "draft" &&
      (!snapshot.finalizedAt ||
        !Number.isFinite(Date.parse(snapshot.finalizedAt)))
    )
      review("invoice_mismatch", true);
  }
  async function project(
    connection: NodePgDatabase,
    record: StoredInvoice,
    snapshot: ProviderInvoice,
    eventId?: string,
  ) {
    verify(record, snapshot);
    const previous = record.invoice.providerStatus;
    const regress =
      (terminal(previous) && previous !== snapshot.status) ||
      (previous === "uncollectible" &&
        ["draft", "open"].includes(snapshot.status)) ||
      (previous === "open" && snapshot.status === "draft");
    if (regress) review("provider_conflict", true);
    await connection.transaction(async (tx) => {
      await tx
        .update(invoices)
        .set({
          providerInvoiceId: snapshot.providerInvoiceId,
          providerReceiptState: "verified",
          providerStatus: snapshot.status,
          state:
            snapshot.status === "draft" &&
            record.invoice.state === "needs_review"
              ? "needs_review"
              : snapshot.status,
          hostedInvoiceUrl: snapshot.hostedInvoiceUrl,
          issuedAt: snapshot.finalizedAt,
          lastCheckedAt: at(),
          reviewReason:
            snapshot.status === "draft" ? record.invoice.reviewReason : null,
          attempts: snapshot.status === "draft" ? record.invoice.attempts : 0,
          nextAttemptAt:
            snapshot.status === "draft" ? record.invoice.nextAttemptAt : null,
        })
        .where(scope(record.invoice.id));
      for (const line of snapshot.lines)
        await tx
          .update(invoiceLines)
          .set({ providerLineId: line.providerLineId })
          .where(eq(invoiceLines.id, line.lineId));
      if (eventId)
        await tx
          .update(stripeEvents)
          .set({
            processedAt: at(),
            nextAttemptAt: null,
            lastError: null,
          })
          .where(eq(stripeEvents.eventId, eventId));
    });
  }
  async function failure(
    connection: NodePgDatabase,
    record: StoredInvoice,
    error: unknown,
    eventId?: string,
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
        (error.receiptMismatch || !terminal(record.invoice.providerStatus))
      ) {
        await tx
          .update(invoices)
          .set({
            ...(error.receiptMismatch
              ? { providerReceiptState: "mismatch" as const }
              : {}),
            state: terminal(record.invoice.providerStatus)
              ? record.invoice.state
              : "needs_review",
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
  async function stampEffect(
    connection: NodePgDatabase,
    record: StoredInvoice,
    effect: "customer" | "invoice" | "finalize",
  ) {
    const attemptedAt =
      effect === "customer"
        ? record.customer.createAttemptedAt
        : effect === "invoice"
          ? record.invoice.createAttemptedAt
          : record.invoice.finalizeAttemptedAt;
    if (attemptedAt) return;
    const stamp = await connection.transaction(async (tx) => {
      let stamp = at();
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
        stamp = at();
        if (!schedule || group.customerId !== record.customer.customerId)
          review("ownership_mismatch");
        if (Date.parse(stamp) < Date.parse(record.invoice.issueNotBefore))
          throw new IssuanceDeferred();
        if (Date.parse(stamp) >= Date.parse(record.invoice.firstAttemptBefore))
          review("provider_conflict");
        if (schedule.issuancePaused) throw new IssuanceDeferred();
      } else if (
        effect !== "finalize" &&
        !record.invoice.createAttemptedAt &&
        Date.parse(stamp) >= Date.parse(record.invoice.firstAttemptBefore)
      )
        review("provider_conflict");
      if (effect === "customer")
        await tx
          .update(billingCustomers)
          .set({ createAttemptedAt: stamp })
          .where(eq(billingCustomers.id, record.customer.id));
      else
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
    if (effect === "customer") record.customer.createAttemptedAt = stamp;
    else if (effect === "invoice") record.invoice.createAttemptedAt = stamp;
    else record.invoice.finalizeAttemptedAt = stamp;
  }
  async function customerReceipt(
    connection: NodePgDatabase,
    record: StoredInvoice,
  ) {
    const customer = record.customer;
    const expected: CustomerIntent = {
      ...provider.ownership,
      customerId: customer.id,
      name: customer.name,
    };
    const found = await provider.findCustomer(expected);
    if (found.kind === "ambiguous") review("uncertain_customer");
    if (customer.providerCustomerId && found.kind !== "found")
      review("uncertain_customer");
    let receipt;
    if (found.kind === "found") receipt = found.value;
    else {
      canRetry(customer.createAttemptedAt, "uncertain_customer");
      await stampEffect(connection, record, "customer");
      receipt = await provider.createCustomer(
        expected,
        effectKey("customer", customer.id),
      );
    }
    if (
      receipt.livemode !== false ||
      receipt.accountId !== expected.accountId ||
      receipt.deploymentKey !== deploymentKey ||
      receipt.customerId !== expected.customerId ||
      receipt.name !== expected.name ||
      !receipt.providerCustomerId ||
      (customer.providerCustomerId &&
        customer.providerCustomerId !== receipt.providerCustomerId)
    )
      review("ownership_mismatch");
    await connection
      .update(billingCustomers)
      .set({ providerCustomerId: receipt.providerCustomerId })
      .where(eq(billingCustomers.id, customer.id));
    customer.providerCustomerId = receipt.providerCustomerId;
  }
  async function issue(
    connection: NodePgDatabase,
    record: StoredInvoice,
  ): Promise<WorkResult> {
    const invoice = record.invoice;
    if (
      !invoice.issueRequestedAt ||
      terminal(invoice.providerStatus) ||
      ["open", "uncollectible"].includes(invoice.state)
    )
      return "complete";
    if (invoice.state === "needs_review") return "needs_review";
    if (!due(invoice.nextAttemptAt)) return "retry";
    if (now().getTime() < Date.parse(invoice.issueNotBefore)) return "retry";
    try {
      await connection
        .update(invoices)
        .set({ state: "preparing" })
        .where(scope(invoice.id));
      if (invoice.billToName !== record.customer.name)
        review("invoice_mismatch");
      await customerReceipt(connection, record);
      const expected = intent(record);
      let snapshot: ProviderInvoice;
      if (invoice.providerInvoiceId)
        snapshot = await provider.retrieveInvoice(
          expected,
          invoice.providerInvoiceId,
        );
      else {
        const found = await provider.findInvoice(expected);
        if (found.kind === "ambiguous") review("uncertain_invoice");
        if (found.kind === "found") snapshot = found.value;
        else {
          canRetry(invoice.createAttemptedAt, "uncertain_invoice");
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
        await connection
          .update(invoiceLines)
          .set({ createAttemptedAt: line.createAttemptedAt ?? at() })
          .where(eq(invoiceLines.id, line.id));
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
      if (error instanceof IssuanceDeferred) {
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
  ): Promise<WorkResult> {
    if (!providerId) return "complete";
    try {
      const snapshot = await provider.retrieveInvoice(
        intent(record),
        providerId,
      );
      if (snapshot.providerInvoiceId !== providerId)
        review("ownership_mismatch", true);
      await project(connection, record, snapshot, eventId);
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
      return failure(connection, record, error, eventId);
    }
  }

  return {
    requestIssue: (id) =>
      locked<IssueResult>(
        id,
        { kind: "not_found" },
        async (connection, { invoice }) => {
          if (invoice.state === "needs_review") return { kind: "needs_review" };
          if (invoice.issueRequestedAt) return { kind: "unchanged" };
          if (now().getTime() < Date.parse(invoice.issueNotBefore))
            return { kind: "not_ready" };
          if (now().getTime() >= Date.parse(invoice.firstAttemptBefore))
            return { kind: "past_due" };
          await connection
            .update(invoices)
            .set({ issueRequestedAt: at(), state: "preparing" })
            .where(scope(id));
          return { kind: "accepted" };
        },
      ),
    issueInvoice: (id) => locked<WorkResult>(id, "complete", issue),
    refreshInvoice: (id) =>
      locked<WorkResult>(id, "complete", (connection, record) =>
        refresh(connection, record, record.invoice.providerInvoiceId),
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
    async pendingWork(limit = 100): Promise<PendingWork[]> {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100)
        throw new RangeError("Invalid work limit");
      const eligible = await db
        .select({
          id: invoices.id,
          dueAt: invoices.nextAttemptAt,
          createdAt: invoices.createdAt,
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
            lte(invoices.issueNotBefore, at()),
            inArray(invoices.state, ["preparing", "draft"]),
            or(
              isNull(billingInvoiceGroups.id),
              isNull(billingSchedules.customerId),
              eq(billingSchedules.issuancePaused, false),
              lte(invoices.firstAttemptBefore, at()),
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
        )
        .orderBy(
          asc(invoices.nextAttemptAt),
          asc(invoices.createdAt),
          asc(invoices.id),
        )
        .limit(limit);
      const events = await db
        .select({
          id: stripeEvents.eventId,
          dueAt: stripeEvents.nextAttemptAt,
          createdAt: stripeEvents.receivedAt,
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
        )
        .orderBy(
          asc(stripeEvents.nextAttemptAt),
          asc(stripeEvents.receivedAt),
          asc(stripeEvents.eventId),
        )
        .limit(limit);
      return [
        ...eligible.map((row) => ({ ...row, kind: "issue" as const })),
        ...events.map((row) => ({ ...row, kind: "event" as const })),
      ]
        .sort(
          (a, b) =>
            (a.dueAt ?? a.createdAt).localeCompare(b.dueAt ?? b.createdAt) ||
            a.id.localeCompare(b.id),
        )
        .slice(0, limit)
        .map((row) =>
          row.kind === "issue"
            ? { kind: "issue", invoiceId: row.id }
            : { kind: "event", eventId: row.id },
        );
    },
  };
}
