import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  date,
  boolean,
  check,
  unique,
  uniqueIndex,
  foreignKey,
  primaryKey,
} from "drizzle-orm/pg-core";
import { customers } from "../../customers/schema";
import type {
  ComponentKind,
  RequestedSetting,
  ServiceKind,
  ServiceManager,
} from "../contract";
const instant = (name: string) =>
  timestamp(name, { withTimezone: true, mode: "string" });
export const services = pgTable(
  "services",
  {
    id: uuid("id").primaryKey(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id),
    sourceKey: text("source_key").notNull(),
    kind: text("kind").$type<ServiceKind>().notNull(),
    name: text("name").notNull(),
    packageName: text("package_name"),
    includedComponents: text("included_components")
      .array()
      .$type<ComponentKind[]>()
      .notNull(),
    attachedServiceId: uuid("attached_service_id"),
    attachedServiceKind: text("attached_service_kind").$type<
      "hosting" | "domain_registration"
    >(),
    version: integer("version").notNull().default(1),
    createdAt: instant("created_at").notNull().defaultNow(),
    updatedAt: instant("updated_at").notNull().defaultNow(),
  },
  (t) => [
    unique("service_customer_kind").on(t.id, t.customerId, t.kind),
    unique("service_customer").on(t.id, t.customerId),
    unique("service_source_key").on(t.customerId, t.sourceKey),
    foreignKey({
      name: "service_attachment_customer_kind",
      columns: [t.attachedServiceId, t.customerId, t.attachedServiceKind],
      foreignColumns: [t.id, t.customerId, t.kind],
    }),
    check(
      "service_kind",
      sql`${t.kind} in ('hosting','addon','domain_registration')`,
    ),
    check(
      "service_attachment_pair",
      sql`(${t.attachedServiceId} is null and ${t.attachedServiceKind} is null) or (${t.attachedServiceId} is not null and ${t.attachedServiceKind} in ('hosting','domain_registration') and ${t.attachedServiceKind} is not null)`,
    ),
    check(
      "service_attachment_addon",
      sql`${t.kind} = 'addon' or (${t.attachedServiceId} is null and ${t.attachedServiceKind} is null)`,
    ),
    check("service_version", sql`${t.version} > 0`),
    check("service_name", sql`length(trim(${t.name})) between 1 and 256`),
    check(
      "service_components",
      sql`${t.includedComponents} <@ array['web','email','dns']::text[] and cardinality(${t.includedComponents}) <= 3 and (${t.kind} = 'hosting' or cardinality(${t.includedComponents}) = 0)`,
    ),
  ],
);
export const hostingAccounts = pgTable(
  "hosting_accounts",
  {
    id: uuid("id").primaryKey(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id),
    providerKey: text("provider_key").notNull(),
    providerLabel: text("provider_label").notNull(),
    label: text("label").notNull(),
  },
  (t) => [unique("hosting_account_customer").on(t.id, t.customerId)],
);
export const serviceComponents = pgTable(
  "service_components",
  {
    id: uuid("id").primaryKey(),
    customerId: uuid("customer_id").notNull(),
    serviceId: uuid("service_id").notNull(),
    serviceKind: text("service_kind").notNull().default("hosting"),
    kind: text("kind").$type<ComponentKind>().notNull(),
    delivery: text("delivery").$type<"hosted" | "external">().notNull(),
    providerLabel: text("provider_label").notNull(),
    hostingAccountId: uuid("hosting_account_id"),
    manager: text("manager").$type<ServiceManager>().notNull(),
    requestedSetting: text("requested_setting").$type<RequestedSetting>(),
    providerState: text("provider_state")
      .$type<RequestedSetting | "unknown">()
      .notNull(),
    checkedAt: instant("checked_at"),
    version: integer("version").notNull().default(1),
  },
  (t) => [
    unique("service_component_customer_kind").on(t.id, t.customerId, t.kind),
    unique("service_component_service_customer").on(
      t.id,
      t.serviceId,
      t.customerId,
    ),
    foreignKey({
      name: "component_service_customer",
      columns: [t.serviceId, t.customerId, t.serviceKind],
      foreignColumns: [services.id, services.customerId, services.kind],
    }),
    foreignKey({
      name: "component_hosting_customer",
      columns: [t.hostingAccountId, t.customerId],
      foreignColumns: [hostingAccounts.id, hostingAccounts.customerId],
    }),
    check("component_hosting_service", sql`${t.serviceKind} = 'hosting'`),
    check("component_kind", sql`${t.kind} in ('web','email','dns')`),
    check(
      "component_delivery",
      sql`${t.delivery} in ('hosted','external') and (${t.delivery} = 'external' or ${t.hostingAccountId} is not null)`,
    ),
    check("component_manager", sql`${t.manager} in ('staff','customer')`),
    check(
      "component_requested_setting",
      sql`(${t.delivery} = 'external' and ${t.manager} = 'customer' and ${t.requestedSetting} is null) or (not (${t.delivery} = 'external' and ${t.manager} = 'customer') and ${t.requestedSetting} is not null and ${t.requestedSetting} in ('enabled','disabled'))`,
    ),
    check(
      "component_provider_state",
      sql`(${t.providerState} = 'unknown' and ${t.checkedAt} is null) or (${t.providerState} in ('enabled','disabled') and ${t.checkedAt} is not null)`,
    ),
    check("component_version", sql`${t.version} > 0`),
  ],
);
export const websites = pgTable(
  "websites",
  {
    id: uuid("id").primaryKey(),
    customerId: uuid("customer_id").notNull(),
    componentId: uuid("component_id").notNull(),
    componentKind: text("component_kind").notNull().default("web"),
  },
  (t) => [
    unique("website_component_customer").on(t.id, t.componentId, t.customerId),
    foreignKey({
      name: "website_web_component",
      columns: [t.componentId, t.customerId, t.componentKind],
      foreignColumns: [
        serviceComponents.id,
        serviceComponents.customerId,
        serviceComponents.kind,
      ],
    }),
    check("website_web_kind", sql`${t.componentKind} = 'web'`),
  ],
);
export const componentNames = pgTable(
  "component_names",
  {
    componentId: uuid("component_id").notNull(),
    customerId: uuid("customer_id").notNull(),
    componentKind: text("component_kind").$type<ComponentKind>().notNull(),
    websiteId: uuid("website_id"),
    hostname: text("hostname").notNull(),
    isPrimary: boolean("is_primary").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.componentId, t.hostname] }),
    foreignKey({
      name: "name_component_customer_kind",
      columns: [t.componentId, t.customerId, t.componentKind],
      foreignColumns: [
        serviceComponents.id,
        serviceComponents.customerId,
        serviceComponents.kind,
      ],
    }),
    foreignKey({
      name: "name_website_customer_component",
      columns: [t.websiteId, t.componentId, t.customerId],
      foreignColumns: [websites.id, websites.componentId, websites.customerId],
    }),
    check(
      "component_name_website",
      sql`(${t.componentKind} = 'web') = (${t.websiteId} is not null)`,
    ),
    check(
      "component_name_primary",
      sql`not ${t.isPrimary} or ${t.websiteId} is not null`,
    ),
    uniqueIndex("website_one_primary")
      .on(t.websiteId)
      .where(sql`${t.isPrimary}`),
  ],
);
export const domainRegistrations = pgTable(
  "domain_registrations",
  {
    serviceId: uuid("service_id").primaryKey(),
    customerId: uuid("customer_id").notNull(),
    serviceKind: text("service_kind").notNull().default("domain_registration"),
    registeredName: text("registered_name").notNull(),
    registrarLabel: text("registrar_label").notNull(),
    manager: text("manager").$type<ServiceManager>().notNull(),
    expiresOn: date("expires_on", { mode: "string" }),
    renewalResponsibility: text("renewal_responsibility")
      .$type<"staff" | "customer" | "unknown">()
      .notNull(),
  },
  (t) => [
    foreignKey({
      name: "registration_service_customer",
      columns: [t.serviceId, t.customerId, t.serviceKind],
      foreignColumns: [services.id, services.customerId, services.kind],
    }),
    check(
      "registration_service_kind",
      sql`${t.serviceKind} = 'domain_registration'`,
    ),
    check("registration_manager", sql`${t.manager} in ('staff','customer')`),
    check(
      "registration_renewal_responsibility",
      sql`${t.renewalResponsibility} in ('staff','customer','unknown')`,
    ),
  ],
);
