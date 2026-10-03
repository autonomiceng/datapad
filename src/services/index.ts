import { and, count, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { AuditRequestConflict } from "../access";
import type { AccessResult, HumanActor } from "../access/types";
import type { ServiceResponse, ServiceSummary } from "./contract";
import type { Services, ServicesOptions } from "./types";
import {
  services,
  hostingAccounts,
  serviceComponents,
  websites,
  componentNames,
  domainRegistrations,
} from "./internal/schema";
import { serviceRecord, componentRecord, validId } from "./internal/validation";
export { bootstrapSyntheticServices } from "./bootstrap";
export { assertSyntheticServices } from "./inspection";
export type {
  Services,
  ServicesOptions,
  ServiceManifest,
  ServicePolicy,
  SyntheticServiceRecord,
  ServiceBootstrapOptions,
} from "./types";

/** Builds scoped local inventory operations and validates credential-free HTTPS login URLs.
 * Preference and attachment edits are audited locally; no provider provisioning occurs. */
export function createServices(options: ServicesOptions): Services {
  const db = drizzle(options.pool);
  const links = new Map<string, string>();
  for (const [key, value] of Object.entries(options.providerLinks)) {
    const url = new URL(value.url);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.href !== value.url
    )
      throw new Error(
        "Service login URL must be an exact credential-free HTTPS URL",
      );
    links.set(key, url.href);
  }
  async function summaries(
    customerId: string,
    rows: Array<typeof services.$inferSelect>,
  ): Promise<ServiceSummary[]> {
    const parentIds = [
      ...new Set(
        rows.flatMap((row) =>
          row.attachedServiceId ? [row.attachedServiceId] : [],
        ),
      ),
    ];
    const parents = parentIds.length
      ? await db
          .select({ id: services.id, name: services.name })
          .from(services)
          .where(
            and(
              inArray(services.id, parentIds),
              eq(services.customerId, customerId),
            ),
          )
      : [];
    const parentsById = new Map(parents.map((parent) => [parent.id, parent]));
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      name: row.name,
      packageName: row.packageName,
      version: row.version,
      attachedService: row.attachedServiceId
        ? (parentsById.get(row.attachedServiceId) ?? null)
        : null,
    }));
  }
  async function detail(
    actor: HumanActor,
    customerId: string,
    serviceId: string,
  ): Promise<AccessResult<ServiceResponse>> {
    const access = await options.authorizeCustomer(
      db,
      actor,
      customerId,
      "read",
      false,
    );
    if (!access.ok) return access;
    const [row] = await db
      .select()
      .from(services)
      .where(
        and(eq(services.id, serviceId), eq(services.customerId, customerId)),
      );
    if (!row) return { ok: false, code: "not_found" };
    const [components, registration, addons] = await Promise.all([
      db
        .select()
        .from(serviceComponents)
        .where(
          and(
            eq(serviceComponents.serviceId, serviceId),
            eq(serviceComponents.customerId, customerId),
          ),
        )
        .orderBy(
          serviceComponents.kind,
          serviceComponents.delivery,
          serviceComponents.id,
        ),
      db
        .select()
        .from(domainRegistrations)
        .where(
          and(
            eq(domainRegistrations.serviceId, serviceId),
            eq(domainRegistrations.customerId, customerId),
          ),
        ),
      db
        .select()
        .from(services)
        .where(
          and(
            eq(services.attachedServiceId, serviceId),
            eq(services.customerId, customerId),
          ),
        )
        .orderBy(services.name, services.id),
    ]);
    const componentIds = components.map((value) => value.id);
    const accountIds = components.flatMap((value) =>
      value.hostingAccountId ? [value.hostingAccountId] : [],
    );
    const [names, sites, accounts] = await Promise.all([
      componentIds.length
        ? db
            .select()
            .from(componentNames)
            .where(
              and(
                inArray(componentNames.componentId, componentIds),
                eq(componentNames.customerId, customerId),
              ),
            )
            .orderBy(componentNames.hostname)
        : [],
      componentIds.length
        ? db
            .select()
            .from(websites)
            .where(
              and(
                inArray(websites.componentId, componentIds),
                eq(websites.customerId, customerId),
              ),
            )
            .orderBy(websites.id)
        : [],
      accountIds.length
        ? db
            .select()
            .from(hostingAccounts)
            .where(
              and(
                inArray(hostingAccounts.id, accountIds),
                eq(hostingAccounts.customerId, customerId),
              ),
            )
            .orderBy(hostingAccounts.label, hostingAccounts.id)
        : [],
    ]);
    const domain = registration[0];
    const [serviceSummary, ...addonSummaries] = await summaries(customerId, [
      row,
      ...addons,
    ]);
    return {
      ok: true,
      value: {
        service: {
          ...serviceSummary,
          canManage: access.value.staffRoles.some(
            (role) => role === "account_administrator" || role === "support",
          ),
          includedComponents: row.includedComponents,
          hostingAccounts: accounts.map((value) => ({
            id: value.id,
            label: value.label,
            providerLabel: value.providerLabel,
            loginUrl: links.get(value.providerKey) ?? null,
          })),
          components: components.map((component) => ({
            id: component.id,
            kind: component.kind,
            delivery: component.delivery,
            providerLabel: component.providerLabel,
            manager: component.manager,
            requestedSetting: component.requestedSetting,
            providerState: component.providerState,
            checkedAt: component.checkedAt
              ? new Date(component.checkedAt).toISOString()
              : null,
            version: component.version,
            reviewReason:
              component.providerState === "unknown"
                ? null
                : component.delivery === "hosted" &&
                    component.providerState === "enabled" &&
                    !row.includedComponents.includes(component.kind)
                  ? "running_without_entitlement"
                  : component.requestedSetting !== null &&
                      component.requestedSetting !== component.providerState
                    ? "requested_state_differs"
                    : null,
            domains: names
              .filter(
                (value) =>
                  value.componentId === component.id &&
                  value.websiteId === null,
              )
              .map((value) => value.hostname),
          })),
          websites: sites.map((site) => {
            const primary = names.find(
              (value) => value.websiteId === site.id && value.isPrimary,
            );
            if (!primary) throw new Error("Website primary hostname missing");
            return {
              id: site.id,
              componentId: site.componentId,
              primaryHostname: primary.hostname,
              aliases: names
                .filter(
                  (value) => value.websiteId === site.id && !value.isPrimary,
                )
                .map((value) => value.hostname),
            };
          }),
          registration: domain
            ? {
                registeredName: domain.registeredName,
                registrarLabel: domain.registrarLabel,
                manager: domain.manager,
                expiresOn: domain.expiresOn,
                renewalResponsibility: domain.renewalResponsibility,
              }
            : null,
          addons: addonSummaries,
        },
      },
    };
  }
  return {
    async readTarget(tx, customerId, serviceId, componentId, { lock }) {
      if (
        !validId(customerId) ||
        !validId(serviceId) ||
        (componentId !== null && !validId(componentId))
      )
        return null;
      const serviceQuery = tx
        .select({
          id: services.id,
          kind: services.kind,
          name: services.name,
          version: services.version,
        })
        .from(services)
        .where(
          and(eq(services.id, serviceId), eq(services.customerId, customerId)),
        );
      const [service] = lock
        ? await serviceQuery.for("share")
        : await serviceQuery;
      if (!service) return null;
      if (componentId === null) return { service, component: null };
      const componentQuery = tx
        .select({
          id: serviceComponents.id,
          kind: serviceComponents.kind,
          version: serviceComponents.version,
        })
        .from(serviceComponents)
        .where(
          and(
            eq(serviceComponents.id, componentId),
            eq(serviceComponents.serviceId, serviceId),
            eq(serviceComponents.customerId, customerId),
          ),
        );
      const [component] = lock
        ? await componentQuery.for("share")
        : await componentQuery;
      return component ? { service, component } : null;
    },
    async listServices(actor, customerId, page) {
      const access = await options.authorizeCustomer(
        db,
        actor,
        customerId,
        "read",
        false,
      );
      if (!access.ok) return access;
      const limit = Math.min(100, Math.max(1, page?.limit ?? 50)),
        offset = Math.max(0, page?.offset ?? 0);
      const filter = eq(services.customerId, customerId);
      const [rows, totals] = await Promise.all([
        db
          .select()
          .from(services)
          .where(filter)
          .orderBy(services.name, services.id)
          .limit(limit)
          .offset(offset),
        db.select({ total: count() }).from(services).where(filter),
      ]);
      return {
        ok: true,
        value: {
          services: await summaries(customerId, rows),
          total: totals[0]?.total ?? 0,
          limit,
          offset,
        },
      };
    },
    getService: detail,
    async setComponentPreference(
      actor,
      customerId,
      serviceId,
      componentId,
      input,
    ) {
      if (
        !validId(input.requestId) ||
        !Number.isSafeInteger(input.expectedVersion) ||
        input.expectedVersion < 1 ||
        !["enabled", "disabled"].includes(input.requestedSetting)
      )
        return { ok: false, code: "invalid_request" };
      const result = await db
        .transaction(async (tx) => {
          const access = await options.authorizeCustomer(
            tx,
            actor,
            customerId,
            "manage_services",
            true,
          );
          if (!access.ok) return access;
          const [row] = await tx
            .select()
            .from(serviceComponents)
            .where(
              and(
                eq(serviceComponents.id, componentId),
                eq(serviceComponents.serviceId, serviceId),
                eq(serviceComponents.customerId, customerId),
              ),
            )
            .for("update");
          if (!row) return { ok: false as const, code: "not_found" as const };
          if (row.requestedSetting === null)
            return { ok: false as const, code: "invalid_request" as const };
          if (
            row.version !== input.expectedVersion ||
            row.version === 2147483647
          )
            return { ok: false as const, code: "conflict" as const };
          if (
            !options.allowRecord({
              recordType: "component",
              record: componentRecord({
                ...row,
                requestedSetting: input.requestedSetting,
              }),
            })
          )
            return { ok: false as const, code: "invalid_request" as const };
          if (row.requestedSetting === input.requestedSetting)
            return { ok: true as const, value: undefined };
          await tx
            .update(serviceComponents)
            .set({
              requestedSetting: input.requestedSetting,
              version: row.version + 1,
            })
            .where(eq(serviceComponents.id, componentId));
          await options.audit.append(tx, {
            requestId: input.requestId,
            actor,
            customerId,
            action: "service.component_preference.updated",
            targetId: componentId,
            changedFields: ["requestedSetting"],
          });
          return { ok: true as const, value: undefined };
        })
        .catch((error: unknown) => {
          if (error instanceof AuditRequestConflict)
            return { ok: false as const, code: "conflict" as const };
          throw error;
        });
      return result.ok ? detail(actor, customerId, serviceId) : result;
    },
    async attachAddon(actor, customerId, addonId, input) {
      if (
        !validId(input.requestId) ||
        !Number.isSafeInteger(input.expectedVersion) ||
        input.expectedVersion < 1 ||
        (input.attachedServiceId !== null && !validId(input.attachedServiceId))
      )
        return { ok: false, code: "invalid_request" };
      const result = await db
        .transaction(async (tx) => {
          const access = await options.authorizeCustomer(
            tx,
            actor,
            customerId,
            "manage_services",
            true,
          );
          if (!access.ok) return access;
          const ids = input.attachedServiceId
            ? [addonId, input.attachedServiceId].sort()
            : [addonId];
          const rows = await tx
            .select()
            .from(services)
            .where(
              and(
                inArray(services.id, ids),
                eq(services.customerId, customerId),
              ),
            )
            .orderBy(services.id)
            .for("update");
          const addon = rows.find((row) => row.id === addonId);
          const target = rows.find((row) => row.id === input.attachedServiceId);
          if (!addon || (input.attachedServiceId !== null && !target))
            return { ok: false as const, code: "not_found" as const };
          if (addon.kind !== "addon" || target?.kind === "addon")
            return { ok: false as const, code: "invalid_request" as const };
          if (
            addon.version !== input.expectedVersion ||
            addon.version === 2147483647
          )
            return { ok: false as const, code: "conflict" as const };
          if (
            !options.allowRecord({
              recordType: "service",
              record: serviceRecord({
                ...addon,
                attachedServiceId: input.attachedServiceId,
              }),
            })
          )
            return { ok: false as const, code: "invalid_request" as const };
          if (addon.attachedServiceId === input.attachedServiceId)
            return { ok: true as const, value: undefined };
          await tx
            .update(services)
            .set({
              attachedServiceId: input.attachedServiceId,
              attachedServiceKind: target?.kind ?? null,
              version: addon.version + 1,
              updatedAt: new Date().toISOString(),
            })
            .where(eq(services.id, addonId));
          await options.audit.append(tx, {
            requestId: input.requestId,
            actor,
            customerId,
            action: "service.addon.attached",
            targetId: addonId,
            changedFields: ["attachedServiceId"],
          });
          return { ok: true as const, value: undefined };
        })
        .catch((error: unknown) => {
          if (error instanceof AuditRequestConflict)
            return { ok: false as const, code: "conflict" as const };
          throw error;
        });
      return result.ok ? detail(actor, customerId, addonId) : result;
    },
  };
}
