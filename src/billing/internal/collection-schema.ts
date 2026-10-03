import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  integer,
  jsonb,
  timestamp,
  unique,
  check,
  foreignKey,
  index,
} from "drizzle-orm/pg-core";
import type { CollectionState, CollectionReason } from "../collection-contract";
import type { CollectionInspection, CollectionPayRequest } from "../provider";
import type { ProviderInvoiceStatus } from "../contract";
import { billingCustomers, invoices } from "./invoice-schema";
import { billingInvoiceGroups } from "./scheduled-schema";
import {
  billingEnrollments,
  billingPaymentMethods,
} from "./payment-settings-schema";
const instant = (name: string) =>
  timestamp(name, { withTimezone: true, mode: "string" });
export const billingPaymentAttempts = pgTable(
  "billing_payment_attempts",
  {
    id: uuid("id").primaryKey(),
    deploymentKey: text("deployment_key").notNull(),
    invoiceId: uuid("invoice_id").notNull(),
    groupId: uuid("group_id").notNull(),
    customerId: uuid("customer_id").notNull(),
    billingCustomerId: uuid("billing_customer_id").notNull(),
    providerAccountId: text("provider_account_id").notNull(),
    enrollmentId: uuid("enrollment_id").notNull(),
    paymentMethodId: uuid("payment_method_id").notNull(),
    chargeAt: instant("charge_at").notNull(),
    dueEndAt: instant("due_end_at").notNull(),
    currency: text("currency").$type<"USD">().notNull(),
    remainingMinor: integer("remaining_minor").notNull(),
    request: jsonb("request").$type<CollectionPayRequest>().notNull(),
    requestDigest: text("request_digest").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    firstAttemptedAt: instant("first_attempted_at").notNull(),
    baselineObservedAt: instant("baseline_observed_at").notNull(),
    baselinePaidMinor: integer("baseline_paid_minor").notNull(),
    baselinePaidOffStripeMinor: integer(
      "baseline_paid_off_stripe_minor",
    ).notNull(),
    baselineOverpaidMinor: integer("baseline_overpaid_minor").notNull(),
    baselinePayments: jsonb("baseline_payments")
      .$type<CollectionInspection["payments"]>()
      .notNull(),
    state: text("state").$type<CollectionState>().notNull(),
    reason: text("reason").$type<CollectionReason>(),
    dispatchCount: integer("dispatch_count").notNull(),
    inspectionFailures: integer("inspection_failures").notNull().default(0),
    nextAttemptAt: instant("next_attempt_at"),
    lastDispatchedAt: instant("last_dispatched_at").notNull(),
    responseAt: instant("response_at"),
    responseInvoiceStatus: text(
      "response_invoice_status",
    ).$type<ProviderInvoiceStatus>(),
    responseKind: text("response_kind").$type<
      "response" | "declined" | "requires_action"
    >(),
    responsePaymentIntentId: text("response_payment_intent_id"),
    responseInvoicePaymentId: text("response_invoice_payment_id"),
    attributedInvoicePaymentId: text("attributed_invoice_payment_id"),
    attributedPaymentIntentId: text("attributed_payment_intent_id"),
    lastCheckedAt: instant("last_checked_at"),
    completedAt: instant("completed_at"),
  },
  (t) => [
    unique("payment_attempt_invoice").on(t.invoiceId),
    unique("payment_attempt_key").on(t.deploymentKey, t.idempotencyKey),
    foreignKey({
      name: "payment_attempt_invoice_owner",
      columns: [t.invoiceId, t.billingCustomerId, t.deploymentKey],
      foreignColumns: [
        invoices.id,
        invoices.billingCustomerId,
        invoices.deploymentKey,
      ],
    }),
    foreignKey({
      name: "payment_attempt_mapping",
      columns: [t.billingCustomerId, t.customerId, t.deploymentKey],
      foreignColumns: [
        billingCustomers.id,
        billingCustomers.customerId,
        billingCustomers.deploymentKey,
      ],
    }),
    foreignKey({
      name: "payment_attempt_group",
      columns: [t.groupId, t.customerId, t.deploymentKey, t.invoiceId],
      foreignColumns: [
        billingInvoiceGroups.id,
        billingInvoiceGroups.customerId,
        billingInvoiceGroups.deploymentKey,
        billingInvoiceGroups.invoiceId,
      ],
    }),
    foreignKey({
      name: "payment_attempt_enrollment",
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
      name: "payment_attempt_method",
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
    index("payment_attempt_pending").on(
      t.deploymentKey,
      t.state,
      t.nextAttemptAt,
    ),
    check(
      "payment_attempt_state",
      sql`${t.state} in ('pending','processing','failed','requires_action','succeeded','needs_review')`,
    ),
    check(
      "payment_attempt_money",
      sql`${t.currency}='USD' and ${t.remainingMinor} between 1 and 99999999 and ${t.baselinePaidMinor} between 0 and 99999999 and ${t.baselinePaidOffStripeMinor} between 0 and 99999999 and ${t.baselineOverpaidMinor}=0`,
    ),
    check(
      "payment_attempt_calendar",
      sql`${t.chargeAt}<${t.dueEndAt} and ${t.firstAttemptedAt}<${t.dueEndAt} and ${t.baselineObservedAt}<=${t.firstAttemptedAt} and ${t.lastDispatchedAt}>=${t.firstAttemptedAt}`,
    ),
    check(
      "payment_attempt_budget",
      sql`${t.dispatchCount} between 1 and 5 and ${t.inspectionFailures} between 0 and 5 and (${t.nextAttemptAt} is null or (${t.state} in ('pending','processing') and ${t.nextAttemptAt}>=${t.firstAttemptedAt}))`,
    ),
    check(
      "payment_attempt_reason",
      sql`(${t.state}='needs_review' and ${t.reason} is not null and ${t.reason} in ('provider_unavailable','consent_changed','method_unavailable','resolution_conflict','amount_changed','competing_payment','provider_mismatch','uncertain_outcome','retry_exhausted')) or (${t.state}='failed' and ${t.reason} is not null and ${t.reason}='declined') or (${t.state}='requires_action' and ${t.reason} is not null and ${t.reason}='authentication_required') or (${t.state} in ('pending','processing','succeeded') and ${t.reason} is null)`,
    ),
    check(
      "payment_attempt_request",
      sql`jsonb_typeof(${t.request})='object' and ${t.request}->>'providerInvoiceId' is not null and length(${t.request}->>'providerInvoiceId')>0 and ${t.request}->>'providerPaymentMethodId' is not null and length(${t.request}->>'providerPaymentMethodId')>0 and ${t.request}->'offSession'='true'::jsonb and ${t.requestDigest} ~ '^[0-9a-f]{64}$' and ${t.idempotencyKey}='datapad:' || ${t.deploymentKey} || ':payment:' || ${t.id}::text || ':pay' and jsonb_typeof(${t.baselinePayments})='array'`,
    ),
    check(
      "payment_attempt_response",
      sql`(${t.responseAt} is null and ${t.responseKind} is null and ${t.responseInvoiceStatus} is null and ${t.responsePaymentIntentId} is null and ${t.responseInvoicePaymentId} is null) or (${t.responseAt} is not null and ${t.responseAt}>=${t.firstAttemptedAt} and ${t.responseKind} is not null and ((${t.responseKind}='response' and ${t.responseInvoiceStatus} is not null and ${t.responseInvoiceStatus} in ('draft','open','paid','void','uncollectible') and ((${t.responsePaymentIntentId} is null and ${t.responseInvoicePaymentId} is null) or (${t.responsePaymentIntentId} is not null and ${t.responseInvoicePaymentId} is not null and length(${t.responsePaymentIntentId})>0 and length(${t.responseInvoicePaymentId})>0))) or (${t.responseKind} in ('declined','requires_action') and ${t.responseInvoiceStatus} is null and ${t.responseInvoicePaymentId} is null)))`,
    ),
    check(
      "payment_attempt_attribution",
      sql`(${t.attributedInvoicePaymentId} is null) = (${t.attributedPaymentIntentId} is null) and (${t.state}<>'succeeded' or (${t.responseKind}='response' and ${t.responseAt} is not null and ${t.responseInvoicePaymentId} is not null and ${t.responsePaymentIntentId} is not null and ${t.responseInvoicePaymentId}=${t.attributedInvoicePaymentId} and ${t.responsePaymentIntentId}=${t.attributedPaymentIntentId} and ${t.attributedInvoicePaymentId} is not null and ${t.attributedPaymentIntentId} is not null and ${t.completedAt} is not null))`,
    ),
  ],
);
