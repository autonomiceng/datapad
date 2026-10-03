/** Durable worker outcomes: retry resumes the same intent; review stops automation. */
export type WorkResult = "complete" | "retry" | "needs_review";

/** Stable invoice traversal cursor, ordered by creation time and invoice identity. */
export interface ReconciliationCursor {
  createdAt: string;
  invoiceId: string;
}

/** Stable pending-work position. Eligibility times never participate in traversal order. */
export interface PendingCursor {
  createdAt: string;
  kind: "issue" | "event" | "resolution" | "payment_setup";
  id: string;
}
export interface PendingInput {
  limit?: number;
  after?: PendingCursor | null;
  through?: PendingCursor | null;
}
/** Retain through while next is nonnull; restart without cursors after completion. */
export interface PendingPage<T> {
  work: T[];
  next: PendingCursor | null;
  through: PendingCursor | null;
}
