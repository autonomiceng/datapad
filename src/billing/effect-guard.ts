import type { NodePgDatabase } from "drizzle-orm/node-postgres";

export interface FinancialEffectGuard {
  /** Acquire the deployment control share lock last in the stamp transaction. Missing control is paused; no network I/O may run in this transaction. */
  assertMayStart(tx: NodePgDatabase): Promise<"allowed" | "paused">;
}
