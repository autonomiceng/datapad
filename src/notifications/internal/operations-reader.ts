import { and, asc, eq, inArray } from "drizzle-orm";
import type { BillingNoticeOperationsReader } from "../../billing/operations-types";
import type { BillingOperation } from "../../billing/operations-contract";
import { invoiceNotices } from "./schema";

/** Construct a deployment-only reader of safe delivery evidence. No sender or provider is constructed; callers supply current billing authority. */
export function createInvoiceNoticeOperationsReader({
  deploymentKey,
}: {
  deploymentKey: string;
}): BillingNoticeOperationsReader {
  const project = (
    row: typeof invoiceNotices.$inferSelect,
  ): BillingOperation => ({
    effect: { kind: "notice", customerId: row.customerId, effectId: row.id },
    customerLabel: "Customer",
    label: `Invoice notice: ${row.stage}`,
    invoiceId: row.invoiceId,
    state:
      row.state === "needs_review" || row.state === "sending"
        ? "needs_review"
        : "pending",
    reason: row.state === "sending" ? "uncertain_delivery" : row.reason,
    createdAt: new Date(row.createdAt).toISOString(),
    attemptedAt: row.attemptedAt
      ? new Date(row.attemptedAt).toISOString()
      : null,
    lastCheckedAt: row.acceptedAt
      ? new Date(row.acceptedAt).toISOString()
      : null,
    nextEligibleAt: row.nextAttemptAt ?? row.scheduledAt,
    canCheckStatus: true,
  });
  return {
    async listOperations(tx, limit) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100)
        throw new RangeError("Invalid operations limit");
      const rows = await tx
        .select()
        .from(invoiceNotices)
        .where(
          and(
            eq(invoiceNotices.deploymentKey, deploymentKey),
            inArray(invoiceNotices.state, [
              "pending",
              "sending",
              "needs_review",
            ]),
          ),
        )
        .orderBy(asc(invoiceNotices.createdAt), asc(invoiceNotices.id))
        .limit(limit);
      return rows.map(project);
    },
    async readOperation(tx, scope) {
      if (scope.kind !== "notice") return null;
      const [row] = await tx
        .select()
        .from(invoiceNotices)
        .where(
          and(
            eq(invoiceNotices.deploymentKey, deploymentKey),
            eq(invoiceNotices.customerId, scope.customerId),
            eq(invoiceNotices.id, scope.effectId),
          ),
        );
      return row ? project(row) : null;
    },
  };
}
