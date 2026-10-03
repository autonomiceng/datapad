import { AuditRequestConflict } from "../access";
import { and, count, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Customers, CustomersOptions } from "./types";
import type { CustomerResponse } from "./contract";
import type { CustomerAccess } from "../access/types";
import { customers } from "./internal/schema";
import { profileOf, validateProfile } from "./validation";
export { createCustomerRegistry } from "./registry";
export type {
  Customers,
  CustomersOptions,
  CustomerRegistry,
  CustomerRegistryOptions,
  RegisteredCustomer,
} from "./types";

const pagination = (page?: { limit?: number; offset?: number }) => ({
  limit: Math.min(100, Math.max(1, page?.limit ?? 50)),
  offset: Math.max(0, page?.offset ?? 0),
});
export function createCustomers(options: CustomersOptions): Customers {
  const db = drizzle(options.pool);
  const target = (row: typeof customers.$inferSelect) => ({
    customerId: row.id,
    organizationId: row.organizationId,
  });
  async function project(
    row: typeof customers.$inferSelect,
    access: CustomerAccess,
  ): Promise<CustomerResponse> {
    const profile = profileOf(row);
    return {
      customer: {
        id: row.id,
        displayName: row.displayName,
        role: access.customerRole,
        profile,
        version: row.version,
        canEditProfile: access.staffRoles.includes("account_administrator"),
        canManageMembers:
          row.organizationId !== null &&
          (access.staffRoles.includes("account_administrator") ||
            access.customerRole === "administrator"),
        providerProfileState: await options.providerProfile(row.id, profile),
      },
    };
  }
  return {
    async readProfile(tx, id) {
      const [row] = await tx
        .select()
        .from(customers)
        .where(eq(customers.id, id));
      return row
        ? { customerId: row.id, profile: profileOf(row), version: row.version }
        : null;
    },
    async billingScope(actor) {
      const scope = await options.access.readScope(actor);
      if (!scope.ok) return scope;
      if (
        scope.value.kind === "staff" &&
        scope.value.roles.some(
          (role) => role === "account_administrator" || role === "billing",
        )
      )
        return { ok: true, value: { kind: "all" } };
      if (!scope.value.organizationIds.length)
        return scope.value.kind === "staff"
          ? { ok: false, code: "forbidden" }
          : { ok: true, value: { kind: "customers", customerIds: [] } };
      const rows = await db
        .select({ id: customers.id })
        .from(customers)
        .where(inArray(customers.organizationId, scope.value.organizationIds));
      return {
        ok: true,
        value: { kind: "customers", customerIds: rows.map((row) => row.id) },
      };
    },
    async getOrganizationTarget(id) {
      const [row] = await db
        .select()
        .from(customers)
        .where(eq(customers.organizationId, id));
      return row ? target(row) : null;
    },
    async getAccessTarget(id) {
      const [row] = await db
        .select()
        .from(customers)
        .where(eq(customers.id, id));
      return row ? target(row) : null;
    },
    async authorizeCustomer(tx, actor, id, capability, mutation) {
      const query = tx.select().from(customers).where(eq(customers.id, id));
      const [row] = mutation ? await query.for("share") : await query;
      return row
        ? options.access.authorizeCustomer(
            tx,
            actor,
            target(row),
            capability,
            mutation,
          )
        : { ok: false, code: "not_found" };
    },
    async listCustomers(actor, page) {
      const scope = await options.access.readScope(actor);
      if (!scope.ok) return scope;
      const bounds = pagination(page);
      if (
        scope.value.kind === "memberships" &&
        !scope.value.organizationIds.length
      )
        return { ok: true, value: { customers: [], total: 0, ...bounds } };
      const filter =
        scope.value.kind === "staff"
          ? undefined
          : inArray(customers.organizationId, scope.value.organizationIds);
      const [rows, totals] = await Promise.all([
        db
          .select()
          .from(customers)
          .where(filter)
          .orderBy(customers.displayName, customers.id)
          .limit(bounds.limit)
          .offset(bounds.offset),
        db.select({ total: count() }).from(customers).where(filter),
      ]);
      const visible = [];
      for (const row of rows) {
        const access = await options.access.authorizeCustomer(
          db,
          actor,
          target(row),
          "read",
          false,
        );
        if (access.ok)
          visible.push({
            id: row.id,
            displayName: row.displayName,
            role: access.value.customerRole,
          });
      }
      return {
        ok: true,
        value: { customers: visible, total: totals[0]?.total ?? 0, ...bounds },
      };
    },
    async getCustomer(actor, id) {
      const scope = await options.access.readScope(actor);
      if (!scope.ok) return scope;
      if (
        scope.value.kind === "memberships" &&
        !scope.value.organizationIds.length
      )
        return { ok: false, code: "not_found" };
      const filter =
        scope.value.kind === "staff"
          ? eq(customers.id, id)
          : and(
              eq(customers.id, id),
              inArray(customers.organizationId, scope.value.organizationIds),
            );
      const [row] = await db.select().from(customers).where(filter);
      if (!row) return { ok: false, code: "not_found" };
      const access = await options.access.authorizeCustomer(
        db,
        actor,
        target(row),
        "read",
        false,
      );
      return access.ok
        ? { ok: true, value: await project(row, access.value) }
        : access;
    },
    async updateCustomer(actor, id, input) {
      if (
        !validateProfile(input.profile) ||
        !options.allowProfile(input.profile) ||
        !Number.isSafeInteger(input.expectedVersion) ||
        input.expectedVersion < 1 ||
        !/^[0-9a-f-]{36}$/i.test(input.requestId)
      )
        return { ok: false, code: "invalid_request" };
      const result = await db
        .transaction(async (tx) => {
          const [row] = await tx
            .select()
            .from(customers)
            .where(eq(customers.id, id))
            .for("update");
          if (!row) return { ok: false as const, code: "not_found" as const };
          const access = await options.access.authorizeCustomer(
            tx,
            actor,
            target(row),
            "manage_profile",
            true,
          );
          if (!access.ok) return access;
          if (row.version !== input.expectedVersion)
            return { ok: false as const, code: "conflict" as const };
          const fields = (
            ["displayName", "legalName", "billingEmail"] as const
          ).filter((key) => row[key] !== input.profile[key]);
          if (!fields.length)
            return {
              ok: true as const,
              value: {
                outcome: "unchanged" as const,
                row,
                access: access.value,
              },
            };
          const [updated] = await tx
            .update(customers)
            .set({
              ...input.profile,
              version: row.version + 1,
              updatedAt: new Date(),
            })
            .where(eq(customers.id, id))
            .returning();
          if (!updated) throw new Error("Customer update unavailable");
          await options.audit.append(tx, {
            requestId: input.requestId,
            actor,
            customerId: id,
            action: "customer.profile.updated",
            targetId: id,
            changedFields: fields,
          });
          return {
            ok: true as const,
            value: {
              outcome: "updated" as const,
              row: updated,
              access: access.value,
            },
          };
        })
        .catch((error: unknown) => {
          if (error instanceof AuditRequestConflict)
            return { ok: false as const, code: "conflict" as const };
          throw error;
        });
      if (!result.ok) return result;
      return {
        ok: true,
        value: {
          outcome: result.value.outcome,
          ...(await project(result.value.row, result.value.access)),
        },
      };
    },
  };
}
export { assertSyntheticCustomers } from "./inspection";
