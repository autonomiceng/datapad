import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { CustomerRegistry, CustomerRegistryOptions } from "./types";
import { customers } from "./internal/schema";
import { validateProfile, profileOf } from "./validation";

/**
 * Construct operator-only customer identity operations using caller
 * transactions; a nonblank operator identity is required.
 */
export function createCustomerRegistry(
  options: CustomerRegistryOptions,
): CustomerRegistry {
  if (!options.operatorId.trim())
    throw new Error("Customer registry requires an operator identity");
  const project = (row: typeof customers.$inferSelect) => {
    const profile = profileOf(row);
    if (!validateProfile(profile) || !options.allowProfile(profile))
      throw new Error(
        "Current customer profile is outside the configured policy",
      );
    return { customerId: row.id, profile, version: row.version };
  };
  return {
    async bindOrganization(tx, input) {
      const [row] = await tx
        .select()
        .from(customers)
        .where(eq(customers.id, input.customerId))
        .for("update");
      if (
        !row ||
        (row.organizationId && row.organizationId !== input.organizationId)
      )
        throw new Error("Customer organization binding conflict");
      if (row.organizationId === input.organizationId) return;
      await tx
        .update(customers)
        .set({ organizationId: input.organizationId, updatedAt: new Date() })
        .where(eq(customers.id, input.customerId));
      await options.audit.recordOperator(tx, {
        operatorId: options.operatorId,
        customerId: input.customerId,
        action: "customer.organization.bound",
        targetId: input.organizationId,
      });
    },
    async ensureCustomer(tx, input) {
      if (
        !input.registryKey ||
        input.registryKey.length > 1024 ||
        input.registryKey.includes("\0")
      )
        throw new Error("Invalid customer registry key");
      const [existing] = await tx
        .select()
        .from(customers)
        .where(eq(customers.registryKey, input.registryKey));
      if (existing) {
        if (
          input.organizationId &&
          existing.organizationId !== input.organizationId
        )
          throw new Error(
            "Customer organization requires explicit bootstrap binding",
          );
        return project(existing);
      }
      if (
        !validateProfile(input.initialProfile) ||
        !options.allowProfile(input.initialProfile)
      )
        throw new Error("Customer profile is outside the configured policy");
      const inserted = await tx
        .insert(customers)
        .values({
          id: randomUUID(),
          registryKey: input.registryKey,
          organizationId: input.organizationId ?? null,
          ...input.initialProfile,
        })
        .onConflictDoNothing({ target: customers.registryKey })
        .returning({ id: customers.id });
      if (inserted[0])
        await options.audit.recordOperator(tx, {
          operatorId: options.operatorId,
          customerId: inserted[0].id,
          action: "customer.created",
          targetId: inserted[0].id,
        });
      const [row] = await tx
        .select()
        .from(customers)
        .where(eq(customers.registryKey, input.registryKey));
      if (!row) throw new Error("Customer registry write unavailable");
      if (input.organizationId && row.organizationId !== input.organizationId)
        throw new Error("Customer organization binding conflict");
      return project(row);
    },
  };
}
