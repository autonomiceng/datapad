import { sql } from "drizzle-orm";
import {
  check,
  date,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  InvoiceState,
  ProviderInvoiceStatus,
  ReviewReason,
} from "../contract";

const instant = (name: string) =>
  timestamp(name, { withTimezone: true, mode: "string" });

export const billingCustomers = pgTable(
  "billing_customers",
  {
    id: uuid("id").primaryKey(),
    deploymentKey: text("deployment_key").notNull(),
    providerAccountId: text("provider_account_id").notNull(),
    key: text("key").notNull(),
    name: text("name").notNull(),
    providerCustomerId: text("provider_customer_id"),
    createAttemptedAt: instant("create_attempted_at"),
    createdAt: instant("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("billing_customer_key").on(table.deploymentKey, table.key),
    unique("billing_customer_scope").on(table.id, table.deploymentKey),
    uniqueIndex("billing_customer_provider_id").on(
      table.providerAccountId,
      table.providerCustomerId,
    ),
  ],
);

export const invoices = pgTable(
  "invoices",
  {
    id: uuid("id").primaryKey(),
    deploymentKey: text("deployment_key").notNull(),
    originKey: text("origin_key").notNull(),
    requestDigest: text("request_digest").notNull(),
    customerId: uuid("customer_id").notNull(),
    issueDate: date("issue_date", { mode: "string" }).notNull(),
    dueDate: date("due_date", { mode: "string" }).notNull(),
    readinessDate: date("readiness_date", { mode: "string" }).notNull(),
    currency: text("currency").$type<"USD">().notNull(),
    totalMinor: integer("total_minor").notNull(),
    state: text("state").$type<InvoiceState>().notNull(),
    providerInvoiceId: text("provider_invoice_id"),
    providerStatus: text("provider_status").$type<ProviderInvoiceStatus>(),
    hostedInvoiceUrl: text("hosted_invoice_url"),
    issuedAt: instant("issued_at"),
    issueRequestedAt: instant("issue_requested_at"),
    createAttemptedAt: instant("create_attempted_at"),
    finalizeAttemptedAt: instant("finalize_attempted_at"),
    lastCheckedAt: instant("last_checked_at"),
    reviewReason: text("review_reason").$type<ReviewReason>(),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: instant("next_attempt_at"),
    createdAt: instant("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("invoice_origin").on(table.deploymentKey, table.originKey),
    uniqueIndex("invoice_provider_id").on(
      table.deploymentKey,
      table.providerInvoiceId,
    ),
    foreignKey({
      columns: [table.customerId, table.deploymentKey],
      foreignColumns: [billingCustomers.id, billingCustomers.deploymentKey],
    }),
    index("invoice_pending").on(table.state, table.nextAttemptAt),
    check("invoice_currency", sql`${table.currency} = 'USD'`),
    check("invoice_total", sql`${table.totalMinor} BETWEEN 50 AND 99999999`),
    check(
      "invoice_readiness",
      sql`${table.readinessDate} = ${table.dueDate} - 21`,
    ),
    check(
      "invoice_dates",
      sql`${table.issueDate} >= ${table.readinessDate} AND ${table.issueDate} < ${table.dueDate}`,
    ),
    check(
      "invoice_state",
      sql`${table.state} IN ('requested', 'preparing', 'needs_review', 'draft', 'open', 'paid', 'void', 'uncollectible')`,
    ),
    check(
      "invoice_provider_status",
      sql`${table.providerStatus} IS NULL OR ${table.providerStatus} IN ('draft', 'open', 'paid', 'void', 'uncollectible')`,
    ),
    check(
      "invoice_review_reason",
      sql`(${table.state} = 'needs_review') = (${table.reviewReason} IS NOT NULL)`,
    ),
    check("invoice_attempts", sql`${table.attempts} >= 0`),
  ],
);

export const invoiceLines = pgTable(
  "invoice_lines",
  {
    id: uuid("id").primaryKey(),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoices.id),
    position: integer("position").notNull(),
    description: text("description").notNull(),
    amountMinor: integer("amount_minor").notNull(),
    originRef: text("origin_ref"),
    providerLineId: text("provider_line_id"),
    createAttemptedAt: instant("create_attempted_at"),
  },
  (table) => [
    uniqueIndex("invoice_line_position").on(table.invoiceId, table.position),
    uniqueIndex("invoice_line_provider_id").on(
      table.invoiceId,
      table.providerLineId,
    ),
    check(
      "invoice_line_amount",
      sql`${table.amountMinor} BETWEEN 1 AND 99999999`,
    ),
    check(
      "invoice_line_position_range",
      sql`${table.position} BETWEEN 0 AND 99`,
    ),
  ],
);

export const stripeEvents = pgTable(
  "stripe_events",
  {
    eventId: text("event_id").primaryKey(),
    deploymentKey: text("deployment_key").notNull(),
    providerAccountId: text("provider_account_id").notNull(),
    eventType: text("event_type").notNull(),
    providerInvoiceId: text("provider_invoice_id").notNull(),
    invoiceId: uuid("invoice_id").references(() => invoices.id),
    createdAt: instant("created_at").notNull(),
    receivedAt: instant("received_at").notNull(),
    processedAt: instant("processed_at"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: instant("next_attempt_at"),
    lastError: text("last_error"),
  },
  (table) => [
    index("stripe_event_pending").on(table.processedAt, table.nextAttemptAt),
    check("stripe_event_attempts", sql`${table.attempts} >= 0`),
  ],
);
