import { createHash, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { CustomerRole, StaffRole } from "./contract";
import {
  user,
  organization,
  member,
  staffGrants,
  auditEntries,
} from "./internal/schema";

export interface SyntheticAccessBootstrap {
  operatorId: string;
  allowedEmails: readonly string[];
  users: Array<{
    id: string;
    name: string;
    email: string;
    staffRoles: StaffRole[];
  }>;
  organizations: Array<{
    id: string;
    name: string;
    slug: string;
    members: Array<{ userId: string; role: CustomerRole }>;
  }>;
}
/** Operator composition only; no HTTP route creates users, organizations, or staff grants. */
export async function bootstrapSyntheticAccess(
  tx: NodePgDatabase,
  input: SyntheticAccessBootstrap,
): Promise<void> {
  if (!input.operatorId.trim())
    throw new Error("Bootstrap operator identity is required");
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${"synthetic-bootstrap"},0))`,
  );
  const manifestHash = createHash("sha256")
    .update(JSON.stringify(input))
    .digest("hex");
  const [receipt] = await tx
    .select()
    .from(auditEntries)
    .where(
      and(
        eq(auditEntries.action, "bootstrap.completed"),
        eq(auditEntries.targetId, input.operatorId),
      ),
    );
  if (receipt) {
    if (receipt.details.manifestHash !== manifestHash)
      throw new Error(
        "Bootstrap manifest changed; use an explicit operator change",
      );
    return;
  }
  const allowed = new Set(
    input.allowedEmails.map((email) => email.toLowerCase()),
  );
  for (const entry of input.users) {
    if (
      !allowed.has(entry.email.toLowerCase()) ||
      !entry.name.trim() ||
      entry.name.length > 256
    )
      throw new Error("Bootstrap user outside configured policy");
    const [existing] = await tx
      .select()
      .from(user)
      .where(eq(user.id, entry.id));
    if (
      existing &&
      (existing.email !== entry.email.toLowerCase() ||
        existing.name !== entry.name)
    )
      throw new Error("Bootstrap user identity conflict");
    if (!existing)
      await tx.insert(user).values({
        id: entry.id,
        name: entry.name,
        email: entry.email.toLowerCase(),
        emailVerified: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    for (const role of entry.staffRoles) {
      if (!["account_administrator", "billing", "support"].includes(role))
        throw new Error("Unsupported staff role");
      const inserted = await tx
        .insert(staffGrants)
        .values({ userId: entry.id, role })
        .onConflictDoNothing()
        .returning();
      if (inserted.length)
        await tx.insert(auditEntries).values({
          id: randomUUID(),
          actorId: input.operatorId,
          action: "staff.granted",
          targetId: entry.id,
          details: { role, operator: true },
        });
    }
    if (!existing)
      await tx.insert(auditEntries).values({
        id: randomUUID(),
        actorId: input.operatorId,
        action: "user.preprovisioned",
        targetId: entry.id,
        details: { operator: true },
      });
  }
  for (const entry of input.organizations) {
    if (
      !entry.name.trim() ||
      !entry.slug.trim() ||
      !entry.members.some((value) => value.role === "administrator")
    )
      throw new Error("Bootstrap organization requires an administrator");
    const [existing] = await tx
      .select()
      .from(organization)
      .where(eq(organization.id, entry.id));
    if (
      existing &&
      (existing.name !== entry.name || existing.slug !== entry.slug)
    )
      throw new Error("Bootstrap organization conflict");
    if (!existing) {
      await tx.insert(organization).values({
        id: entry.id,
        name: entry.name,
        slug: entry.slug,
        createdAt: new Date(),
      });
      await tx.insert(auditEntries).values({
        id: randomUUID(),
        actorId: input.operatorId,
        action: "organization.created",
        targetId: entry.id,
        details: { operator: true },
      });
    }
    for (const membership of entry.members) {
      if (
        !input.users.some((value) => value.id === membership.userId) ||
        !["administrator", "member"].includes(membership.role)
      )
        throw new Error("Unknown bootstrap member");
      const role = membership.role === "administrator" ? "admin" : "member";
      const [present] = await tx
        .select()
        .from(member)
        .where(
          and(
            eq(member.organizationId, entry.id),
            eq(member.userId, membership.userId),
          ),
        );
      if (present && present.role !== role)
        throw new Error("Bootstrap member role conflict");
      if (!present) {
        const id = randomUUID();
        await tx.insert(member).values({
          id,
          organizationId: entry.id,
          userId: membership.userId,
          role,
          createdAt: new Date(),
        });
        await tx.insert(auditEntries).values({
          id: randomUUID(),
          actorId: input.operatorId,
          action: "member.bootstrapped",
          targetId: id,
          details: { organizationId: entry.id, role, operator: true },
        });
      }
    }
  }
  await tx.insert(auditEntries).values({
    id: randomUUID(),
    actorId: input.operatorId,
    action: "bootstrap.completed",
    targetId: input.operatorId,
    details: { manifestHash },
  });
}
