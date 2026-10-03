import { sql } from "drizzle-orm";
import {
  pgTable,
  primaryKey,
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
import type {
  ReplaceEnrollmentRequest,
  ReduceEnrollmentRequest,
} from "../payment-settings-contract";
import { customers } from "../../customers/schema";
import { billingCustomers } from "./invoice-schema";
const instant = (name: string) =>
  timestamp(name, { withTimezone: true, mode: "string" });
export interface MembershipProvenance {
  invitationId: string | null;
  invitedByUserId: string | null;
  invitedByStaff: boolean | null;
}
export const billingPaymentSetups = pgTable(
  "billing_payment_setups",
  {
    id: uuid("id").primaryKey(),
    customerId: uuid("customer_id").notNull(),
    deploymentKey: text("deployment_key").notNull(),
    billingCustomerId: uuid("billing_customer_id").notNull(),
    providerAccountId: text("provider_account_id").notNull(),
    requestId: uuid("request_id").notNull(),
    requestDigest: text("request_digest").notNull(),
    actorUserId: text("actor_user_id").notNull(),
    actorSessionId: text("actor_session_id").notNull(),
    consentingMembershipId: text("consenting_membership_id").notNull(),
    membershipProvenance: jsonb("membership_provenance")
      .$type<MembershipProvenance>()
      .notNull(),
    saveTermsVersion: text("save_terms_version").notNull(),
    saveTermsDigest: text("save_terms_digest").notNull(),
    acceptedAt: instant("accepted_at").notNull(),
    successUrl: text("success_url").notNull(),
    cancelUrl: text("cancel_url").notNull(),
    integrationIdentifier: text("integration_identifier").notNull(),
    createAttemptedAt: instant("create_attempted_at"),
    providerSessionId: text("provider_session_id"),
    providerSetupIntentId: text("provider_setup_intent_id"),
    providerPaymentMethodId: text("provider_payment_method_id"),
    pendingSessionId: text("pending_session_id"),
    checkoutUrl: text("checkout_url"),
    status: text("status")
      .$type<"pending" | "verified" | "expired" | "needs_review">()
      .notNull(),
    retrievalRequestedAt: instant("retrieval_requested_at").notNull(),
    lastCheckedAt: instant("last_checked_at"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: instant("next_attempt_at"),
  },
  (t) => [
    unique("payment_setup_request").on(t.deploymentKey, t.requestId),
    unique("payment_setup_receipt").on(
      t.providerAccountId,
      t.providerSessionId,
    ),
    unique("payment_setup_intent_receipt").on(
      t.providerAccountId,
      t.providerSetupIntentId,
    ),
    unique("payment_setup_owner").on(
      t.id,
      t.customerId,
      t.deploymentKey,
      t.billingCustomerId,
      t.providerAccountId,
    ),
    foreignKey({
      name: "payment_setup_mapping",
      columns: [t.billingCustomerId, t.customerId, t.deploymentKey],
      foreignColumns: [
        billingCustomers.id,
        billingCustomers.customerId,
        billingCustomers.deploymentKey,
      ],
    }),
    check(
      "payment_setup_status",
      sql`${t.status} in ('pending','verified','expired','needs_review')`,
    ),
    check("payment_setup_attempts", sql`${t.attempts} between 0 and 5`),
    index("payment_setup_pending").on(
      t.deploymentKey,
      t.status,
      t.nextAttemptAt,
    ),
  ],
);
export const billingPaymentMethods = pgTable(
  "billing_payment_methods",
  {
    id: uuid("id").primaryKey(),
    customerId: uuid("customer_id").notNull(),
    deploymentKey: text("deployment_key").notNull(),
    billingCustomerId: uuid("billing_customer_id").notNull(),
    providerAccountId: text("provider_account_id").notNull(),
    setupId: uuid("setup_id").notNull(),
    providerPaymentMethodId: text("provider_payment_method_id").notNull(),
    brand: text("brand").notNull(),
    last4: text("last4").notNull(),
    expiryMonth: integer("expiry_month").notNull(),
    expiryYear: integer("expiry_year").notNull(),
    verifiedAt: instant("verified_at").notNull(),
  },
  (t) => [
    unique("payment_method_receipt").on(
      t.providerAccountId,
      t.providerPaymentMethodId,
    ),
    unique("payment_method_owner").on(t.id, t.customerId, t.deploymentKey),
    unique("payment_method_mapping_owner").on(
      t.id,
      t.customerId,
      t.deploymentKey,
      t.billingCustomerId,
    ),
    foreignKey({
      name: "payment_method_setup",
      columns: [
        t.setupId,
        t.customerId,
        t.deploymentKey,
        t.billingCustomerId,
        t.providerAccountId,
      ],
      foreignColumns: [
        billingPaymentSetups.id,
        billingPaymentSetups.customerId,
        billingPaymentSetups.deploymentKey,
        billingPaymentSetups.billingCustomerId,
        billingPaymentSetups.providerAccountId,
      ],
    }),
    check(
      "payment_method_card",
      sql`length(${t.brand}) between 1 and 32 and ${t.last4} ~ '^[0-9]{4}$' and ${t.expiryMonth} between 1 and 12 and ${t.expiryYear} between 2000 and 9999`,
    ),
  ],
);
export const billingEnrollments = pgTable(
  "billing_enrollments",
  {
    id: uuid("id").primaryKey(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id),
    deploymentKey: text("deployment_key").notNull(),
    version: integer("version").notNull(),
    requestId: uuid("request_id").notNull(),
    requestDigest: text("request_digest").notNull(),
    request: jsonb("request")
      .$type<ReplaceEnrollmentRequest | ReduceEnrollmentRequest>()
      .notNull(),
    predecessorId: uuid("predecessor_id"),
    decision: text("decision").$type<"authorize" | "reduce">().notNull(),
    actorUserId: text("actor_user_id").notNull(),
    actorSessionId: text("actor_session_id").notNull(),
    consentingMembershipId: text("consenting_membership_id").notNull(),
    membershipProvenance: jsonb("membership_provenance")
      .$type<MembershipProvenance>()
      .notNull(),
    acceptedAt: instant("accepted_at").notNull(),
    termsVersion: text("terms_version").notNull(),
    termsDigest: text("terms_digest").notNull(),
    paymentMethodId: uuid("payment_method_id"),
  },
  (t) => [
    unique("enrollment_version").on(t.customerId, t.deploymentKey, t.version),
    unique("enrollment_request").on(t.deploymentKey, t.requestId),
    unique("enrollment_owner").on(t.id, t.customerId, t.deploymentKey),
    unique("enrollment_method_owner").on(
      t.id,
      t.customerId,
      t.deploymentKey,
      t.paymentMethodId,
    ),
    foreignKey({
      name: "enrollment_method",
      columns: [t.paymentMethodId, t.customerId, t.deploymentKey],
      foreignColumns: [
        billingPaymentMethods.id,
        billingPaymentMethods.customerId,
        billingPaymentMethods.deploymentKey,
      ],
    }),
    foreignKey({
      name: "enrollment_predecessor",
      columns: [t.predecessorId, t.customerId, t.deploymentKey],
      foreignColumns: [t.id, t.customerId, t.deploymentKey],
    }),
    check(
      "enrollment_sequence",
      sql`${t.version}>0 and ((${t.version}=1 and ${t.predecessorId} is null) or (${t.version}>1 and ${t.predecessorId} is not null))`,
    ),
    check("enrollment_decision", sql`${t.decision} in ('authorize','reduce')`),
  ],
);

/** Accepted commands that leave consent unchanged still bind their request identity. */
export const billingEnrollmentNoops = pgTable(
  "billing_enrollment_noops",
  {
    deploymentKey: text("deployment_key").notNull(),
    requestId: uuid("request_id").notNull(),
    customerId: uuid("customer_id").notNull(),
    enrollmentId: uuid("enrollment_id").notNull(),
    requestDigest: text("request_digest").notNull(),
    request: jsonb("request")
      .$type<ReplaceEnrollmentRequest | ReduceEnrollmentRequest>()
      .notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.deploymentKey, t.requestId] }),
    foreignKey({
      name: "enrollment_noop_owner",
      columns: [t.enrollmentId, t.customerId, t.deploymentKey],
      foreignColumns: [
        billingEnrollments.id,
        billingEnrollments.customerId,
        billingEnrollments.deploymentKey,
      ],
    }),
  ],
);
