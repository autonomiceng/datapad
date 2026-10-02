import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

export function createDatabase(url: string) {
  const pool = new Pool({
    connectionString: url,
    connectionTimeoutMillis: 3000,
  });
  const db = drizzle(pool);
  return { db, close: () => pool.end() };
}
