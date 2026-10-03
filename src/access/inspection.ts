import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import type { StaffRole } from "./contract";
import {
  user,
  organization,
  staffGrants,
  invitation,
  member,
} from "./internal/schema";
export interface SyntheticAccessPolicy {
  users: ReadonlyArray<{
    email: string;
    names: readonly string[];
    staffRoles: readonly StaffRole[];
  }>;
  organizations: ReadonlyArray<{ id: string; name: string; slug: string }>;
}
/** Refuse unknown identities before mounting the synthetic portal. Revocation is preserved. */
export async function assertSyntheticAccess(
  pool: Pool,
  policy: SyntheticAccessPolicy,
): Promise<void> {
  const db = drizzle(pool);
  const [users, organizations, grants, invitations, memberships] =
    await Promise.all([
      db.select().from(user),
      db.select().from(organization),
      db.select().from(staffGrants),
      db.select().from(invitation),
      db.select().from(member),
    ]);
  for (const row of users) {
    const allowed = policy.users.find((value) => value.email === row.email);
    if (!allowed || !allowed.names.includes(row.name))
      throw new Error("Portal database contains an unapproved user profile");
    if (
      grants.some(
        (grant) =>
          grant.userId === row.id &&
          !allowed.staffRoles.some((role) => role === grant.role),
      )
    )
      throw new Error("Portal database contains an unapproved staff grant");
  }
  for (const row of organizations)
    if (
      !policy.organizations.some(
        (value) =>
          value.id === row.id &&
          value.name === row.name &&
          value.slug === row.slug,
      )
    )
      throw new Error("Portal database contains an unapproved organization");
  for (const row of invitations)
    if (
      !policy.users.some((value) => value.email === row.email) ||
      !["admin", "member"].includes(row.role ?? "")
    )
      throw new Error("Portal database contains an unapproved invitation");
  if (
    memberships.some((row) => !["admin", "owner", "member"].includes(row.role))
  )
    throw new Error("Portal database contains an unapproved member role");
}
