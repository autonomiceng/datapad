import { and, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { AuditWriter } from "./types";
import { auditEntries } from "./internal/schema";
export class AuditRequestConflict extends Error {}
export function createAuditWriter(): AuditWriter {
  return {
    async getServicesBootstrap(tx, bootstrapKey) {
      const [entry] = await tx
        .select({ details: auditEntries.details })
        .from(auditEntries)
        .where(
          and(
            eq(auditEntries.action, "services.bootstrapped"),
            eq(auditEntries.targetId, bootstrapKey),
          ),
        );
      if (!entry) return null;
      if (typeof entry.details.manifestDigest !== "string")
        throw new Error("Invalid services bootstrap receipt");
      return { manifestDigest: entry.details.manifestDigest };
    },
    async recordServicesBootstrap(tx, input) {
      await tx.insert(auditEntries).values({
        id: randomUUID(),
        actorId: input.operatorId,
        action: "services.bootstrapped",
        targetId: input.bootstrapKey,
        details: { manifestDigest: input.manifestDigest },
      });
    },
    async append(tx, entry) {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`audit-request:${entry.requestId}`},0))`,
      );
      const [existing] = await tx
        .select({ id: auditEntries.id })
        .from(auditEntries)
        .where(eq(auditEntries.requestId, entry.requestId));
      if (existing)
        throw new AuditRequestConflict(
          "Mutation request identity already used",
        );
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
