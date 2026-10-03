import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  integer,
  date,
  jsonb,
  primaryKey,
  foreignKey,
  check,
} from "drizzle-orm/pg-core";
import type { CalendarPolicy } from "../subscriptions-contract";
import { billingEnrollments } from "./payment-settings-schema";
import {
  billingSubscriptions,
  billingSubscriptionTerms,
} from "./subscriptions-schema";
export const billingEnrollmentScopes = pgTable(
  "billing_enrollment_scopes",
  {
    enrollmentId: uuid("enrollment_id").notNull(),
    customerId: uuid("customer_id").notNull(),
    deploymentKey: text("deployment_key").notNull(),
    subscriptionId: uuid("subscription_id").notNull(),
    commercialRevision: integer("commercial_revision").notNull(),
    fromPeriodIndex: integer("from_period_index").notNull(),
    untilPeriodIndex: integer("until_period_index"),
    periodStart: date("period_start", { mode: "string" }).notNull(),
    dueDate: date("due_date", { mode: "string" }).notNull(),
    calendar: jsonb("calendar").$type<CalendarPolicy>().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.enrollmentId, t.subscriptionId] }),
    foreignKey({
      name: "enrollment_scope_owner",
      columns: [t.enrollmentId, t.customerId, t.deploymentKey],
      foreignColumns: [
        billingEnrollments.id,
        billingEnrollments.customerId,
        billingEnrollments.deploymentKey,
      ],
    }),
    foreignKey({
      name: "enrollment_scope_subscription",
      columns: [t.subscriptionId, t.customerId, t.deploymentKey],
      foreignColumns: [
        billingSubscriptions.id,
        billingSubscriptions.customerId,
        billingSubscriptions.deploymentKey,
      ],
    }),
    foreignKey({
      name: "enrollment_scope_revision",
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
    check(
      "enrollment_scope_range",
      sql`${t.fromPeriodIndex} between 0 and 120000 and (${t.untilPeriodIndex} is null or ${t.untilPeriodIndex}>${t.fromPeriodIndex} and ${t.untilPeriodIndex}<=120000)`,
    ),
  ],
);
