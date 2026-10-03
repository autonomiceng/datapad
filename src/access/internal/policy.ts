import { and, eq, gt } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import type { StaffRole, CustomerRole } from "../contract";
import type { AccessPolicy, HumanActor } from "../types";
import { session, user, member, staffGrants } from "./schema";

export function customerRole(role: string | undefined): CustomerRole | null {
  if (role === "admin" || role === "owner") return "administrator";
  return role === "member" ? "member" : null;
}
export function staffRole(role: string): StaffRole | null {
  return role === "account_administrator" ||
    role === "billing" ||
    role === "support"
    ? role
    : null;
}
export function createPolicy(pool: Pool): AccessPolicy {
  const db = drizzle(pool);
  async function authority(
    tx: NodePgDatabase,
    actor: HumanActor,
    mutation: boolean,
  ) {
    const query = tx
      .select({ id: session.id })
      .from(session)
      .innerJoin(user, eq(session.userId, user.id))
      .where(
        and(
          eq(session.id, actor.sessionId),
          eq(session.userId, actor.userId),
          gt(session.expiresAt, new Date()),
          eq(user.emailVerified, true),
        ),
      );
    const sessions = mutation
      ? await query.for("share", { of: session })
      : await query;
    if (!sessions.length) return null;
    const grantsQuery = tx
      .select()
      .from(staffGrants)
      .where(eq(staffGrants.userId, actor.userId));
    const grants = mutation
      ? await grantsQuery.for("share")
      : await grantsQuery;
    const roles = grants.flatMap((row) => {
      const role = staffRole(row.role);
      return role ? [role] : [];
    });
    return roles;
  }
  return {
    async readScope(actor) {
      const roles = await authority(db, actor, false);
      if (!roles) return { ok: false, code: "unauthenticated" };
      const memberships = await db
        .select({ organizationId: member.organizationId, role: member.role })
        .from(member)
        .where(eq(member.userId, actor.userId));
      const organizationIds = memberships
        .filter((row) => customerRole(row.role))
        .map((row) => row.organizationId);
      return {
        ok: true,
        value: roles.length
          ? { kind: "staff", roles, organizationIds }
          : { kind: "memberships", organizationIds },
      };
    },
    async authorizeStaff(tx, actor, roles, mutation) {
      const current = await authority(tx, actor, mutation);
      if (!current) return { ok: false, code: "unauthenticated" };
      return current.some((role) => roles.includes(role))
        ? { ok: true, value: undefined }
        : { ok: false, code: "forbidden" };
    },
    async authorizeCustomer(tx, actor, target, capability, mutation) {
      const roles = await authority(tx, actor, mutation);
      if (!roles) return { ok: false, code: "unauthenticated" };
      const membershipQuery = target.organizationId
        ? tx
            .select()
            .from(member)
            .where(
              and(
                eq(member.userId, actor.userId),
                eq(member.organizationId, target.organizationId),
              ),
            )
        : null;
      const memberships = membershipQuery
        ? mutation
          ? await membershipQuery.for("share")
          : await membershipQuery
        : [];
      const role = customerRole(memberships[0]?.role);
      const administrator = roles.includes("account_administrator");
      const visible = roles.length > 0 || role !== null;
      if (!visible) return { ok: false, code: "not_found" };
      const permitted =
        capability === "read" ||
        (capability === "read_billing" &&
          (administrator || roles.includes("billing") || role !== null)) ||
        (capability === "manage_profile" && administrator) ||
        ((capability === "read_members" || capability === "manage_members") &&
          target.organizationId !== null &&
          (administrator || role === "administrator"));
      return permitted
        ? {
            ok: true,
            value: { ...target, customerRole: role, staffRoles: roles },
          }
        : { ok: false, code: "forbidden" };
    },
  };
}
