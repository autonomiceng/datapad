import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  integer,
  jsonb,
  timestamp,
  date,
  unique,
  uniqueIndex,
  check,
  foreignKey,
  index,
} from "drizzle-orm/pg-core";
import { billingInvoiceGroups } from "./scheduled-schema";
import { customers } from "../../customers/schema";
import { services } from "../../services/schema";
import type {
  CalendarPolicy,
  CreateSubscriptionRequest,
} from "../subscriptions-contract";
const instant = (name: string) =>
  timestamp(name, { withTimezone: true, mode: "string" });
const day = (name: string) => date(name, { mode: "string" });
export const billingSubscriptions = pgTable(
  "billing_subscriptions",
  {
    id: uuid("id").primaryKey(),
    deploymentKey: text("deployment_key").notNull(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id),
    serviceId: uuid("service_id"),
    createRequestId: uuid("create_request_id").notNull(),
    createDigest: text("create_digest").notNull(),
    version: integer("version").notNull().default(1),
    periodAnchorDate: day("period_anchor_date").notNull(),
    dueAnchorDate: day("due_anchor_date").notNull(),
    intervalMonths: integer("interval_months")
      .$type<CreateSubscriptionRequest["intervalMonths"]>()
      .notNull(),
    firstUnbilledPeriodIndex: integer("first_unbilled_period_index").notNull(),
    activationFromPeriodIndex: integer("activation_from_period_index"),
    activatedAt: instant("activated_at"),
    activatedBy: text("activated_by"),
    calendar: jsonb("calendar").$type<CalendarPolicy>().notNull(),
    cancellationStatus: text("cancellation_status")
      .$type<"none" | "requested" | "declined" | "approved">()
      .notNull()
      .default("none"),
    cancellationReason: text("cancellation_reason"),
    cancellationEffectivePeriodIndex: integer(
      "cancellation_effective_period_index",
    ),
    createdAt: instant("created_at").notNull(),
    updatedAt: instant("updated_at").notNull(),
  },
  (t) => [
    unique("subscription_scope").on(t.id, t.customerId, t.deploymentKey),
    unique("subscription_create_request").on(
      t.deploymentKey,
      t.createRequestId,
    ),
    foreignKey({
      name: "subscription_service_customer",
      columns: [t.serviceId, t.customerId],
      foreignColumns: [services.id, services.customerId],
    }),
    check(
      "subscription_interval",
      sql`${t.intervalMonths} in (1,3,6,12,24,36)`,
    ),
    check(
      "subscription_first_index",
      sql`${t.firstUnbilledPeriodIndex} between 0 and 120000`,
    ),
    check("subscription_version", sql`${t.version}>0`),
    check(
      "subscription_activation",
      sql`(${t.activationFromPeriodIndex} IS NULL AND ${t.activatedAt} IS NULL AND ${t.activatedBy} IS NULL) OR (${t.activationFromPeriodIndex} IS NOT NULL AND ${t.activatedAt} IS NOT NULL AND ${t.activatedBy} IS NOT NULL AND ${t.activationFromPeriodIndex} BETWEEN ${t.firstUnbilledPeriodIndex} AND 120000)`,
    ),
    check(
      "subscription_cancel",
      sql`${t.cancellationStatus} in ('none','requested','declined','approved') and ((${t.cancellationStatus}='none' and ${t.cancellationReason} is null) or (${t.cancellationStatus}<>'none' and ${t.cancellationReason} is not null)) and ((${t.cancellationStatus}='approved' and ${t.cancellationEffectivePeriodIndex} is not null and ${t.cancellationEffectivePeriodIndex} >= ${t.firstUnbilledPeriodIndex} and ${t.cancellationEffectivePeriodIndex} <= 120000) or (${t.cancellationStatus}<>'approved' and ${t.cancellationEffectivePeriodIndex} is null))`,
    ),
  ],
);
export const billingSubscriptionTerms = pgTable(
  "billing_subscription_terms",
  {
    subscriptionId: uuid("subscription_id").notNull(),
    customerId: uuid("customer_id").notNull(),
    deploymentKey: text("deployment_key").notNull(),
    revision: integer("revision").notNull(),
    effectivePeriodIndex: integer("effective_period_index").notNull(),
    kind: text("kind").$type<"commercial" | "state">().notNull(),
    label: text("label"),
    amountMinor: integer("amount_minor"),
    currency: text("currency").$type<"USD">(),
    paymentArrangement: text("payment_arrangement").$type<
      "manual" | "automatic"
    >(),
    billingState: text("billing_state").$type<
      "billable" | "paused" | "cancelled"
    >(),
  },
  (t) => [
    unique("subscription_terms_revision").on(t.subscriptionId, t.revision),
    unique("subscription_terms_scope").on(
      t.subscriptionId,
      t.customerId,
      t.deploymentKey,
      t.revision,
    ),
    foreignKey({
      name: "subscription_terms_owner",
      columns: [t.subscriptionId, t.customerId, t.deploymentKey],
      foreignColumns: [
        billingSubscriptions.id,
        billingSubscriptions.customerId,
        billingSubscriptions.deploymentKey,
      ],
    }),
    check(
      "subscription_terms_bounds",
      sql`${t.revision}>0 and ${t.effectivePeriodIndex} between 0 and 120000`,
    ),
    check(
      "subscription_terms_union",
      sql`(${t.kind}='commercial' and ${t.label} is not null and length(trim(${t.label})) between 1 and 256 and ${t.amountMinor} is not null and ${t.amountMinor} between -99999999 and 99999999 and ${t.currency} is not null and ${t.currency}='USD' and ${t.paymentArrangement} is not null and ${t.paymentArrangement} in ('manual','automatic') and ${t.billingState} is null) or (${t.kind}='state' and ${t.label} is null and ${t.amountMinor} is null and ${t.currency} is null and ${t.paymentArrangement} is null and ${t.billingState} is not null and ${t.billingState} in ('billable','paused','cancelled'))`,
    ),
    uniqueIndex("subscription_one_cancellation")
      .on(t.subscriptionId)
      .where(sql`${t.billingState}='cancelled'`),
    index("subscription_terms_effective").on(
      t.subscriptionId,
      t.kind,
      t.effectivePeriodIndex,
      t.revision,
    ),
  ],
);
export const billingPeriods = pgTable(
  "billing_periods",
  {
    id: uuid("id").primaryKey(),
    subscriptionId: uuid("subscription_id").notNull(),
    customerId: uuid("customer_id").notNull(),
    deploymentKey: text("deployment_key").notNull(),
    periodIndex: integer("period_index").notNull(),
    periodStart: day("period_start").notNull(),
    periodEnd: day("period_end").notNull(),
    dueDate: day("due_date").notNull(),
    commercialRevision: integer("commercial_revision").notNull(),
    stateRevision: integer("state_revision").notNull(),
    label: text("label").notNull(),
    amountMinor: integer("amount_minor").notNull(),
    currency: text("currency").$type<"USD">().notNull(),
    paymentArrangement: text("payment_arrangement")
      .$type<"manual" | "automatic">()
      .notNull(),
    billingState: text("billing_state")
      .$type<"billable" | "paused" | "cancelled">()
      .notNull(),
    calendar: jsonb("calendar").$type<CalendarPolicy>().notNull(),
    readinessDate: day("readiness_date").notNull(),
    issueAt: instant("issue_at"),
    dueEndAt: instant("due_end_at"),
    chargeAt: instant("charge_at"),
    sealedAt: instant("sealed_at"),
    invoiceGroupId: uuid("invoice_group_id"),
  },
  (t) => [
    unique("billing_period_identity").on(t.subscriptionId, t.periodIndex),
    foreignKey({
      name: "billing_period_invoice_group",
      columns: [t.invoiceGroupId, t.customerId, t.deploymentKey],
      foreignColumns: [
        billingInvoiceGroups.id,
        billingInvoiceGroups.customerId,
        billingInvoiceGroups.deploymentKey,
      ],
    }),
    check(
      "billing_period_sealed_claim",
      sql`${t.invoiceGroupId} IS NULL OR ${t.sealedAt} IS NOT NULL`,
    ),
    foreignKey({
      name: "billing_period_owner",
      columns: [t.subscriptionId, t.customerId, t.deploymentKey],
      foreignColumns: [
        billingSubscriptions.id,
        billingSubscriptions.customerId,
        billingSubscriptions.deploymentKey,
      ],
    }),
    foreignKey({
      name: "billing_period_commercial_terms",
      columns: [
        t.subscriptionId,
        t.customerId,
        t.deploymentKey,
        t.commercialRevision,
      ],
      foreignColumns: [
        billingSubscriptionTerms.subscriptionId,
        billingSubscriptionTerms.customerId,
        billingSubscriptionTerms.deploymentKey,
        billingSubscriptionTerms.revision,
      ],
    }),
    foreignKey({
      name: "billing_period_state_terms",
      columns: [
        t.subscriptionId,
        t.customerId,
        t.deploymentKey,
        t.stateRevision,
      ],
      foreignColumns: [
        billingSubscriptionTerms.subscriptionId,
        billingSubscriptionTerms.customerId,
        billingSubscriptionTerms.deploymentKey,
        billingSubscriptionTerms.revision,
      ],
    }),
    check("billing_period_index", sql`${t.periodIndex} between 0 and 120000`),
    check(
      "billing_period_dates",
      sql`${t.periodStart}<${t.periodEnd} and ${t.readinessDate}=${t.dueDate}-21`,
    ),
    check(
      "billing_period_money",
      sql`${t.currency}='USD' and ${t.amountMinor} between -99999999 and 99999999`,
    ),
    check(
      "billing_period_arrangement",
      sql`${t.paymentArrangement} in ('manual','automatic')`,
    ),
    check(
      "billing_period_state",
      sql`${t.billingState} in ('billable','paused','cancelled')`,
    ),
    index("billing_period_due").on(t.deploymentKey, t.customerId, t.dueDate),
  ],
);
