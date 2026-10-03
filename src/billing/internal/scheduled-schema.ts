import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  jsonb,
  timestamp,
  date,
  primaryKey,
  unique,
  check,
  foreignKey,
  index,
} from "drizzle-orm/pg-core";
import { customers } from "../../customers/schema";
import type { CalendarPolicy } from "../subscriptions-contract";
import { billingCustomers, invoices } from "./invoice-schema";
import {
  billingEnrollments,
  billingPaymentMethods,
} from "./payment-settings-schema";

const instant = (name: string) =>
  timestamp(name, { withTimezone: true, mode: "string" });
export const billingSchedules = pgTable(
  "billing_schedules",
  {
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id),
    deploymentKey: text("deployment_key").notNull(),
    version: integer("version").notNull().default(1),
    issuancePaused: boolean("issuance_paused").notNull().default(false),
    createdAt: instant("created_at").notNull(),
    updatedAt: instant("updated_at").notNull(),
    createdBy: text("created_by").notNull(),
    updatedBy: text("updated_by").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.customerId, t.deploymentKey] }),
    check("billing_schedule_version", sql`${t.version}>0`),
    index("billing_schedule_scan").on(
      t.deploymentKey,
      t.createdAt,
      t.customerId,
    ),
  ],
);
export const billingInvoiceGroups = pgTable(
  "billing_invoice_groups",
  {
    id: uuid("id").primaryKey(),
    customerId: uuid("customer_id").notNull(),
    deploymentKey: text("deployment_key").notNull(),
    dueDate: date("due_date", { mode: "string" }).notNull(),
    currency: text("currency").$type<"USD">().notNull(),
    paymentArrangement: text("payment_arrangement")
      .$type<"manual" | "automatic">()
      .notNull(),
    calendar: jsonb("calendar").$type<CalendarPolicy>().notNull(),
    outcome: text("outcome")
      .$type<"invoice_requested" | "no_charge">()
      .notNull(),
    sealedAt: instant("sealed_at").notNull(),
    totalMinor: integer("total_minor").notNull(),
    billToName: text("bill_to_name").notNull(),
    billToEmail: text("bill_to_email"),
    billToProfileVersion: integer("bill_to_profile_version").notNull(),
    billingCustomerId: uuid("billing_customer_id"),
    invoiceId: uuid("invoice_id"),
    enrollmentId: uuid("enrollment_id"),
    paymentMethodId: uuid("payment_method_id"),
    collectionMissedAt: instant("collection_missed_at"),
  },
  (t) => [
    check(
      "invoice_group_permission_pair",
      sql`(${t.enrollmentId} is null and ${t.paymentMethodId} is null) or (${t.enrollmentId} is not null and ${t.paymentMethodId} is not null and ${t.paymentArrangement}='automatic' and ${t.totalMinor}>0)`,
    ),
    foreignKey({
      name: "invoice_group_enrollment",
      columns: [
        t.enrollmentId,
        t.customerId,
        t.deploymentKey,
        t.paymentMethodId,
      ],
      foreignColumns: [
        billingEnrollments.id,
        billingEnrollments.customerId,
        billingEnrollments.deploymentKey,
        billingEnrollments.paymentMethodId,
      ],
    }),
    foreignKey({
      name: "invoice_group_method",
      columns: [
        t.paymentMethodId,
        t.customerId,
        t.deploymentKey,
        t.billingCustomerId,
      ],
      foreignColumns: [
        billingPaymentMethods.id,
        billingPaymentMethods.customerId,
        billingPaymentMethods.deploymentKey,
        billingPaymentMethods.billingCustomerId,
      ],
    }),
    unique("invoice_group_collection_owner").on(
      t.id,
      t.customerId,
      t.deploymentKey,
      t.invoiceId,
    ),
    unique("invoice_group_scope").on(t.id, t.customerId, t.deploymentKey),
    unique("invoice_group_date").on(
      t.customerId,
      t.deploymentKey,
      t.dueDate,
      t.currency,
      t.paymentArrangement,
    ),
    unique("invoice_group_invoice").on(t.invoiceId),
    foreignKey({
      name: "invoice_group_schedule",
      columns: [t.customerId, t.deploymentKey],
      foreignColumns: [
        billingSchedules.customerId,
        billingSchedules.deploymentKey,
      ],
    }),
    foreignKey({
      name: "invoice_group_mapping",
      columns: [t.billingCustomerId, t.customerId, t.deploymentKey],
      foreignColumns: [
        billingCustomers.id,
        billingCustomers.customerId,
        billingCustomers.deploymentKey,
      ],
    }),
    foreignKey({
      name: "invoice_group_invoice_owner",
      columns: [t.invoiceId, t.billingCustomerId, t.deploymentKey],
      foreignColumns: [
        invoices.id,
        invoices.billingCustomerId,
        invoices.deploymentKey,
      ],
    }),
    check("invoice_group_currency", sql`${t.currency}='USD'`),
    check(
      "invoice_group_arrangement",
      sql`${t.paymentArrangement} in ('manual','automatic')`,
    ),
    check(
      "invoice_group_bill_to",
      sql`${t.billToProfileVersion}>0 and length(trim(${t.billToName})) between 1 and 256`,
    ),
    check(
      "invoice_group_outcome",
      sql`(${t.outcome}='invoice_requested' and ${t.totalMinor} between 50 and 99999999 and ${t.billingCustomerId} is not null and ${t.invoiceId} is not null) or (${t.outcome}='no_charge' and ${t.totalMinor}=0 and ${t.billingCustomerId} is null and ${t.invoiceId} is null)`,
    ),
  ],
);
