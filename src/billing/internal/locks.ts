import { createHash } from "node:crypto";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";

function lockKey(value: string): string {
  return createHash("sha256")
    .update(value)
    .digest()
    .readBigInt64BE()
    .toString();
}
export async function withLocks<T>(
  pool: Pool,
  keys: string[],
  work: (db: NodePgDatabase) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let broken = false;
  const lost = () => {
    broken = true;
  };
  client.on("error", lost);
  const held: string[] = [];
  try {
    for (const key of keys) {
      const id = lockKey(key);
      await client.query("SELECT pg_advisory_lock($1::bigint)", [id]);
      held.push(id);
    }
    return await work(drizzle(client));
  } finally {
    if (!broken) {
      try {
        for (const id of held.reverse())
          await client.query("SELECT pg_advisory_unlock($1::bigint)", [id]);
      } catch {
        broken = true;
      }
    }
    client.off("error", lost);
    client.release(broken);
  }
}
