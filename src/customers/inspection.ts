import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import type { CustomerProfile } from "./contract";
import { customers } from "./internal/schema";
import { profileOf } from "./validation";
/**
 * Inspect all stored customer identities and profiles; throw on any
 * unapproved registry key, organization binding or profile without changing
 * data.
 */
export async function assertSyntheticCustomers(
  pool: Pool,
  policy: {
    registryKeys: readonly string[];
    organizationIds: readonly string[];
    /**
     * Approve each stored customer profile against the reviewed synthetic
     * dataset; this check does not authorize edits.
     */
    allowProfile: (profile: CustomerProfile) => boolean;
  },
): Promise<void> {
  const rows = await drizzle(pool).select().from(customers);
  if (
    rows.some(
      (row) =>
        !policy.registryKeys.includes(row.registryKey) ||
        (row.organizationId !== null &&
          !policy.organizationIds.includes(row.organizationId)) ||
        !policy.allowProfile(profileOf(row)),
    )
  )
    throw new Error("Portal database contains an unapproved customer profile");
}
