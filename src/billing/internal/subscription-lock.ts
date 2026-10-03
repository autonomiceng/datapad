import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
/** Subscription revisions, sealing and consent serialize on this same lock. */
export async function lockSubscriptionCustomer(
  tx: NodePgDatabase,
  deploymentKey: string,
  customerId: string,
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`subscription-customer:${deploymentKey}:${customerId}`},0))`,
  );
}
