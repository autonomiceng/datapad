import { and, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { AuditWriter } from "./types";
import { auditEntries } from "./internal/schema";
export class AuditRequestConflict extends Error {}
export function createAuditWriter(): AuditWriter {
  return {
    async append(tx, entry) {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`profile-request:${entry.requestId}`},0))`,
      );
      const [existing] = await tx
        .select({ id: auditEntries.id })
        .from(auditEntries)
        .where(
          and(
            eq(auditEntries.requestId, entry.requestId),
            eq(auditEntries.action, entry.action),
          ),
        );
      if (existing)
        throw new AuditRequestConflict("Profile request identity already used");
      await tx.insert(auditEntries).values({
        id: randomUUID(),
        requestId: entry.requestId,
        actorId: entry.actor.userId,
        sessionId: entry.actor.sessionId,
        customerId: entry.customerId,
        action: entry.action,
        targetId: entry.targetId,
        details: { changedFields: entry.changedFields },
      });
    },
    async recordOperator(tx, entry) {
      await tx.insert(auditEntries).values({
        id: randomUUID(),
        actorId: entry.operatorId,
        customerId: entry.customerId,
        action: entry.action,
        targetId: entry.targetId,
        details: { operator: true },
      });
    },
  };
}
