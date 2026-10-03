import { and, asc, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import {
  BillingProviderError,
  type InvoiceIntent,
  type ProviderInvoice,
  type ProviderLine,
  type ProviderOwnership,
} from "../provider";
import type { ReviewReason } from "../contract";
import { billingCustomers, invoices, invoiceLines } from "./invoice-schema";
import { withLocks } from "./locks";
import { isUuid } from "./validate";
type Invoice = typeof invoices.$inferSelect;
type Customer = typeof billingCustomers.$inferSelect;
type Line = typeof invoiceLines.$inferSelect;
export interface StoredInvoice {
  invoice: Invoice;
  customer: Customer;
  lines: Line[];
}
const terminal = (status: string | null) =>
  status === "paid" || status === "void";
function review(reason: ReviewReason, receiptMismatch = false): never {
  throw new BillingProviderError("review", reason, receiptMismatch);
}
export function createInvoiceContext({
  pool,
  deploymentKey,
  ownership,
  now = () => new Date(),
}: {
  pool: Pool;
  deploymentKey: string;
  ownership: ProviderOwnership;
  now?: () => Date;
}) {
  const db = drizzle(pool);
  const at = () => now().toISOString();
  const scope = (id: string) =>
    and(eq(invoices.id, id), eq(invoices.deploymentKey, deploymentKey));
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
    if (row.customer.providerAccountId !== ownership.accountId)
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
      ...ownership,
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
      snapshot.accountId !== ownership.accountId ||
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
    tx: NodePgDatabase,
    record: StoredInvoice,
    snapshot: ProviderInvoice,
  ) {
    verify(record, snapshot);
    const previous = record.invoice.providerStatus;
    const regress =
      (terminal(previous) && previous !== snapshot.status) ||
      (previous === "uncollectible" &&
        ["draft", "open"].includes(snapshot.status)) ||
      (previous === "open" && snapshot.status === "draft");
    if (regress) review("provider_conflict", true);
    await tx
      .update(invoices)
      .set({
        providerInvoiceId: snapshot.providerInvoiceId,
        providerReceiptState: "verified",
        providerStatus: snapshot.status,
        state:
          snapshot.status === "draft" && record.invoice.state === "needs_review"
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
  async function mismatch(
    tx: NodePgDatabase,
    record: StoredInvoice,
    reason: ReviewReason,
  ) {
    await tx
      .update(invoices)
      .set({
        providerReceiptState: "mismatch",
        state: terminal(record.invoice.providerStatus)
          ? record.invoice.state
          : "needs_review",
        reviewReason: reason,
        nextAttemptAt: null,
      })
      .where(scope(record.invoice.id));
  }
  return { load, locked, intent, verifyLine, verify, project, mismatch };
}
