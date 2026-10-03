/** Durable worker outcomes: retry resumes the same intent; review stops automation. */
export type WorkResult = "complete" | "retry" | "needs_review";

/** Stable invoice traversal cursor, ordered by creation time and invoice identity. */
export interface ReconciliationCursor {
  createdAt: string;
  invoiceId: string;
}
