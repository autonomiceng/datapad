import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { createAuditWriter } from "../../src/access";
import { createPolicy } from "../../src/access/internal/policy";
import { user, session, staffGrants } from "../../src/access/internal/schema";
import { createBillingOperations } from "../../src/billing";
import { createInvoiceNoticeOperationsReader } from "../../src/notifications";
import type { StaffRole } from "../../src/access/contract";

export async function effectsActor(
  pool: Pool,
  roles: StaffRole[] = ["billing"],
) {
  const db = drizzle(pool),
    userId = randomUUID(),
    sessionId = randomUUID();
  await db.transaction(async (tx) => {
    await tx.insert(user).values({
      id: userId,
      name: "Synthetic billing operator",
      email: `${userId}@effects.test`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await tx.insert(session).values({
      id: sessionId,
      userId,
      token: randomUUID(),
      expiresAt: new Date(Date.now() + 86400000),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    if (roles.length)
      await tx
        .insert(staffGrants)
        .values(roles.map((role) => ({ userId, role })));
  });
  return { userId, sessionId };
}
export function effectsOperations(pool: Pool, deploymentKey: string) {
  return createBillingOperations({
    pool,
    deploymentKey,
    access: createPolicy(pool),
    audit: createAuditWriter(),
    notices: createInvoiceNoticeOperationsReader({ deploymentKey }),
    reconciliation: null,
  });
}
export async function resumeEffects(pool: Pool, deploymentKey: string) {
  const actor = await effectsActor(pool);
  const operations = effectsOperations(pool, deploymentKey);
  const current = await operations.getOperations(actor);
  if (!current.ok) throw new Error(current.code);
  const result = await operations.setEffectsPaused(actor, {
    requestId: randomUUID(),
    expectedVersion: current.value.control.version,
    paused: false,
    reason: "Enable synthetic effect fixture",
  });
  if (!result.ok) throw new Error(result.code);
  return { actor, operations };
}
