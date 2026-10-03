import { sql } from "drizzle-orm";
import {
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  ResolutionReviewReason,
  ResolutionState,
} from "../resolutions-contract";
import { invoices, billingCustomers } from "./invoice-schema";
const instant = (name: string) =>
  timestamp(name, { withTimezone: true, mode: "string" });
export interface ElectronicPaymentBaseline {
  invoicePaymentId: string;
  paymentIntentId: string;
  paidMinor: number;
  receivedMinor: number;
}
export const billingInvoiceResolutions = pgTable(
  "billing_invoice_resolutions",
  {
    id: uuid("id").primaryKey(),
    deploymentKey: text("deployment_key").notNull(),
    invoiceId: uuid("invoice_id").notNull(),
    billingCustomerId: uuid("billing_customer_id").notNull(),
    customerId: uuid("customer_id").notNull(),
    requestId: uuid("request_id").notNull(),
    actorId: text("actor_id").notNull(),
    sessionId: text("session_id").notNull(),
    kind: text("kind").$type<"external_payment" | "void">().notNull(),
    state: text("state").$type<ResolutionState>().notNull(),
    amountMinor: integer("amount_minor"),
    receivedDate: date("received_date", { mode: "string" }),
    method: text("method").$type<"zelle" | "check">(),
    reference: text("reference"),
    reason: text("reason"),
    createdAt: instant("created_at").notNull(),
    attemptedAt: instant("attempted_at"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: instant("next_attempt_at"),
    confirmedAt: instant("confirmed_at"),
    reviewReason: text("review_reason").$type<ResolutionReviewReason>(),
    baselineAt: instant("baseline_at"),
    baselineRemainingMinor: integer("baseline_remaining_minor"),
    baselinePaidOffStripeMinor: integer("baseline_paid_off_stripe_minor"),
    baselinePayments:
      jsonb("baseline_payments").$type<ElectronicPaymentBaseline[]>(),
    responseAt: instant("response_at"),
    responsePaidOffStripeMinor: integer("response_paid_off_stripe_minor"),
    lastCheckedAt: instant("last_checked_at"),
    lastRemainingMinor: integer("last_remaining_minor"),
    lastCollectionState: text("last_collection_state").$type<
      "idle" | "active" | "unknown"
    >(),
  },
  (t) => [
    foreignKey({
      columns: [t.invoiceId, t.billingCustomerId, t.deploymentKey],
      foreignColumns: [
        invoices.id,
        invoices.billingCustomerId,
        invoices.deploymentKey,
      ],
    }),
    foreignKey({
      columns: [t.billingCustomerId, t.customerId, t.deploymentKey],
      foreignColumns: [
        billingCustomers.id,
        billingCustomers.customerId,
        billingCustomers.deploymentKey,
      ],
    }),
    uniqueIndex("invoice_resolution_request").on(t.requestId),
    uniqueIndex("invoice_resolution_active")
      .on(t.invoiceId)
      .where(sql`${t.state} <> 'withdrawn'`),
    index("invoice_resolution_pending").on(
      t.deploymentKey,
      t.state,
      t.nextAttemptAt,
    ),
    check(
      "invoice_resolution_kind",
      sql`${t.kind} IN ('external_payment','void')`,
    ),
    check(
      "invoice_resolution_state",
      sql`${t.state} IN ('pending','confirmed','needs_review','withdrawn')`,
    ),
    check(
      "invoice_resolution_actor",
      sql`length(btrim(${t.actorId}))>0 AND length(btrim(${t.sessionId}))>0`,
    ),
    check(
      "invoice_resolution_facts",
      sql`(
    ${t.kind}='external_payment' AND ${t.amountMinor} IS NOT NULL AND ${t.amountMinor} BETWEEN 1 AND 99999999
    AND ${t.receivedDate} IS NOT NULL AND ${t.receivedDate} <= (${t.createdAt} AT TIME ZONE 'UTC')::date
    AND ${t.method} IS NOT NULL AND ${t.method} IN ('zelle','check')
    AND ${t.reference} IS NOT NULL AND length(btrim(${t.reference})) BETWEEN 1 AND 256 AND ${t.reason} IS NULL
  ) OR (
    ${t.kind}='void' AND ${t.amountMinor} IS NULL AND ${t.receivedDate} IS NULL AND ${t.method} IS NULL AND ${t.reference} IS NULL
    AND ${t.reason} IS NOT NULL AND length(btrim(${t.reason})) BETWEEN 1 AND 500
  )`,
    ),
    check(
      "invoice_resolution_review",
      sql`(${t.state}='needs_review') = (${t.reviewReason} IS NOT NULL) AND (${t.reviewReason} IS NULL OR ${t.reviewReason} IN ('provider_unavailable','collection_conflict','possible_overpayment','amount_mismatch','uncertain_outcome','retry_exhausted','receipt_correction','provider_mismatch'))`,
    ),
    check(
      "invoice_resolution_confirmation",
      sql`(${t.state}<>'confirmed' OR (${t.confirmedAt} IS NOT NULL AND ${t.responseAt} IS NOT NULL)) AND (${t.confirmedAt} IS NULL OR (${t.attemptedAt} IS NOT NULL AND ${t.confirmedAt}>=${t.attemptedAt} AND ${t.state} IN ('confirmed','needs_review')))`,
    ),
    check(
      "invoice_resolution_withdrawal",
      sql`${t.state}<>'withdrawn' OR (${t.kind}='external_payment' AND ${t.attemptedAt} IS NULL AND ${t.confirmedAt} IS NULL)`,
    ),
    check(
      "invoice_resolution_retry",
      sql`${t.attempts} BETWEEN 0 AND 5 AND (${t.nextAttemptAt} IS NULL OR (${t.state}='pending' AND ${t.attempts}<5 AND ${t.nextAttemptAt}>=${t.createdAt})) AND (${t.state}<>'pending' OR ${t.attempts}<5)`,
    ),
    check(
      "invoice_resolution_baseline",
      sql`(
    ${t.baselineAt} IS NULL AND ${t.baselineRemainingMinor} IS NULL AND ${t.baselinePaidOffStripeMinor} IS NULL AND ${t.baselinePayments} IS NULL
  ) OR (
    ${t.baselineAt} IS NOT NULL AND ${t.baselineAt}>=${t.createdAt}
    AND ${t.baselineRemainingMinor} IS NOT NULL AND ${t.baselineRemainingMinor} BETWEEN 0 AND 99999999
    AND ${t.baselinePaidOffStripeMinor} IS NOT NULL AND ${t.baselinePaidOffStripeMinor} BETWEEN 0 AND 99999999
    AND ${t.baselinePayments} IS NOT NULL AND jsonb_typeof(${t.baselinePayments})='array'
  )`,
    ),
    check(
      "invoice_resolution_baseline_payments",
      sql`${t.baselinePayments} IS NULL OR NOT jsonb_path_exists(${t.baselinePayments}, '$[*] ? (@.type() != "object" || !(exists(@.invoicePaymentId)) || @.invoicePaymentId.type() != "string" || @.invoicePaymentId == "" || !(exists(@.paymentIntentId)) || @.paymentIntentId.type() != "string" || @.paymentIntentId == "" || !(exists(@.paidMinor)) || @.paidMinor.type() != "number" || @.paidMinor < 0 || @.paidMinor > 99999999 || @.paidMinor.floor() != @.paidMinor || !(exists(@.receivedMinor)) || @.receivedMinor.type() != "number" || @.receivedMinor < 0 || @.receivedMinor > 99999999 || @.receivedMinor.floor() != @.receivedMinor)')`,
    ),
    check(
      "invoice_resolution_attempt",
      sql`${t.attemptedAt} IS NULL OR (${t.baselineAt} IS NOT NULL AND ${t.attemptedAt}>=${t.baselineAt})`,
    ),
    check(
      "invoice_resolution_response",
      sql`(${t.responseAt} IS NULL AND ${t.responsePaidOffStripeMinor} IS NULL) OR (${t.responseAt} IS NOT NULL AND ${t.attemptedAt} IS NOT NULL AND ${t.responseAt}>=${t.attemptedAt} AND ((${t.kind}='void' AND ${t.responsePaidOffStripeMinor} IS NULL) OR (${t.kind}='external_payment' AND ${t.responsePaidOffStripeMinor} IS NOT NULL AND ${t.responsePaidOffStripeMinor} BETWEEN 0 AND 99999999)))`,
    ),
    check(
      "invoice_resolution_inspection",
      sql`(${t.lastCheckedAt} IS NULL AND ${t.lastRemainingMinor} IS NULL AND ${t.lastCollectionState} IS NULL) OR (${t.lastCheckedAt} IS NOT NULL AND ${t.lastCheckedAt}>=${t.createdAt} AND ${t.lastRemainingMinor} IS NOT NULL AND ${t.lastRemainingMinor} BETWEEN 0 AND 99999999 AND ${t.lastCollectionState} IS NOT NULL AND ${t.lastCollectionState} IN ('idle','active','unknown'))`,
    ),
  ],
);
