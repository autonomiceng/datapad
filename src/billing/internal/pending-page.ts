import { sql, type SQL } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PendingCursor, PendingInput, PendingPage } from "../work-types";
import { isUuid } from "./validate";

export async function pendingPage(
  db: NodePgDatabase,
  candidates: SQL,
  kinds: PendingCursor["kind"][],
  { limit = 100, after = null, through = null }: PendingInput = {},
): Promise<PendingPage<PendingCursor>> {
  const valid = (c: PendingCursor) =>
    kinds.includes(c.kind) &&
    typeof c.createdAt === "string" &&
    /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}(?::?\d{2})?)$/.test(
      c.createdAt,
    ) &&
    Number.isFinite(Date.parse(c.createdAt)) &&
    typeof c.id === "string" &&
    (c.kind === "event"
      ? c.id.length > 0 && !/[\0\uD800-\uDFFF]/u.test(c.id)
      : isUuid(c.id));
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    (after && (!through || !valid(after))) ||
    (through && !valid(through))
  )
    throw new RangeError("Invalid pending work cursor");
  type Row = PendingCursor & Record<string, unknown>;
  if (!through) {
    const bound = await db.execute<Row>(sql`
      with candidates as (${candidates})
      select created_at::text as "createdAt", kind, id from candidates
      order by created_at desc, kind collate "C" desc, id collate "C" desc limit 1
    `);
    through = bound.rows[0] ?? null;
  }
  if (!through) return { work: [], next: null, through: null };
  const rows = await db.execute<Row>(sql`
    with candidates as (${candidates})
    select created_at::text as "createdAt", kind, id from candidates
    where (created_at, kind collate "C", id collate "C") <= (${through.createdAt}::timestamptz, ${through.kind}, ${through.id})
      ${after ? sql`and (created_at, kind collate "C", id collate "C") > (${after.createdAt}::timestamptz, ${after.kind}, ${after.id})` : sql``}
    order by created_at, kind collate "C", id collate "C" limit ${limit + 1}
  `);
  const work = rows.rows.slice(0, limit);
  return {
    work,
    next: rows.rows.length > limit ? work[work.length - 1] : null,
    through,
  };
}
