import { and, asc, eq, inArray, isNotNull, isNull, lte, or } from "drizzle-orm";
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
import { isUuid } from "./validate";

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
function review(reason: ReviewReason): never {
  throw new BillingProviderError("review", reason);
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
      issueDate: record.invoice.issueDate,
      dueDate: record.invoice.dueDate,
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
      review("invoice_mismatch");
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
      review("ownership_mismatch");
    if (
      snapshot.currency !== "USD" ||
      snapshot.issueDate !== expected.issueDate ||
      snapshot.dueDate !== expected.dueDate ||
      snapshot.collectionMethod !== "send_invoice" ||
      snapshot.autoAdvance !== false ||
      !["draft", "open", "paid", "void", "uncollectible"].includes(
        snapshot.status,
      )
    )
      review("invoice_mismatch");
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
        review("invoice_mismatch");
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
      review("invoice_mismatch");
    if (
      snapshot.hostedInvoiceUrl !== null &&
      !snapshot.hostedInvoiceUrl.startsWith("https://invoice.stripe.com/")
    )
      review("invoice_mismatch");
    if (
      snapshot.status !== "draft" &&
      (!snapshot.finalizedAt ||
        !Number.isFinite(Date.parse(snapshot.finalizedAt)))
    )
      review("invoice_mismatch");
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
    await connection.transaction(async (tx) => {
      if (!regress) {
        await tx
          .update(invoices)
          .set({
            providerInvoiceId: snapshot.providerInvoiceId,
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
      }
      if (eventId)
        await tx
          .update(stripeEvents)
          .set({
            processedAt: at(),
            nextAttemptAt: null,
            lastError: regress ? "provider_conflict" : null,
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
        !eventOnly &&
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
      await connection
        .update(billingCustomers)
        .set({ createAttemptedAt: customer.createAttemptedAt ?? at() })
        .where(eq(billingCustomers.id, customer.id));
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
    const today = at().slice(0, 10);
    if (today < invoice.readinessDate || today < invoice.issueDate)
      return "retry";
    try {
      if (!invoice.createAttemptedAt && today >= invoice.dueDate)
        review("provider_conflict");
      await connection
        .update(invoices)
        .set({ state: "preparing" })
        .where(scope(invoice.id));
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
          await connection
            .update(invoices)
            .set({ createAttemptedAt: invoice.createAttemptedAt ?? at() })
            .where(scope(invoice.id));
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
        if (line.providerLineId) review("invoice_mismatch");
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
        await connection
          .update(invoices)
          .set({ finalizeAttemptedAt: invoice.finalizeAttemptedAt ?? at() })
          .where(scope(invoice.id));
        snapshot = await provider.finalizeInvoice(
          expected,
          snapshot.providerInvoiceId,
          effectKey("invoice", invoice.id, "finalize"),
        );
        if (snapshot.status === "draft") review("provider_conflict");
      }
      await project(connection, record, snapshot);
      return "complete";
    } catch (error) {
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
        review("ownership_mismatch");
      await project(connection, record, snapshot, eventId);
      return "complete";
    } catch (error) {
      if (
        eventId &&
        error instanceof BillingProviderError &&
        error.kind === "review" &&
        error.reason === "ownership_mismatch"
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
          const today = at().slice(0, 10);
          if (today < invoice.readinessDate || today < invoice.issueDate)
            return { kind: "not_ready" };
          if (today >= invoice.dueDate) return { kind: "past_due" };
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
        .where(
          and(
            eq(invoices.deploymentKey, deploymentKey),
            isNotNull(invoices.issueRequestedAt),
            inArray(invoices.state, ["preparing", "draft"]),
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
