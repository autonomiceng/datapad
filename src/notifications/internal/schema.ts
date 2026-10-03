import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { invoices, billingCustomers } from "../../billing/schema";
import type {
  NoticePreview,
  NoticeReason,
  NoticeStage,
  NoticeState,
} from "../contract";
import type { NoticeTemplateInput } from "../types";
const instant = (name: string) =>
  timestamp(name, { withTimezone: true, mode: "string" });
export const invoiceNotices = pgTable(
  "invoice_notices",
  {
    id: uuid("id").primaryKey(),
    deploymentKey: text("deployment_key").notNull(),
    invoiceId: uuid("invoice_id").notNull(),
    billingCustomerId: uuid("billing_customer_id").notNull(),
    customerId: uuid("customer_id").notNull(),
    stage: text("stage").$type<NoticeStage>().notNull(),
    state: text("state").$type<NoticeState>().notNull(),
    reason: text("reason").$type<NoticeReason>(),
    timeZone: text("time_zone").notNull(),
    hour: integer("hour").notNull(),
    scheduledAt: instant("scheduled_at"),
    windowEndAt: instant("window_end_at"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: instant("next_attempt_at"),
    attemptedAt: instant("attempted_at"),
    acceptedAt: instant("accepted_at"),
    recipient: text("recipient"),
    profileVersion: integer("profile_version"),
    preview: jsonb("preview").$type<NoticePreview>(),
    templateInput: jsonb("template_input").$type<NoticeTemplateInput>(),
    templateVersion: integer("template_version"),
    messageId: text("message_id"),
    createdAt: instant("created_at").notNull(),
  },
  (t) => [
    unique("invoice_notice_stage").on(t.deploymentKey, t.invoiceId, t.stage),
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
    check(
      "invoice_notice_stage_check",
      sql`${t.stage} in ('invoice','before_due','due','overdue')`,
    ),
    check(
      "invoice_notice_state",
      sql`${t.state} in ('pending','sending','accepted','suppressed','needs_review')`,
    ),
    check("invoice_notice_hour", sql`${t.hour} between 0 and 23`),
    check("invoice_notice_attempts", sql`${t.attempts} between 0 and 3`),
    check(
      "invoice_notice_snapshot",
      sql`(${t.attempts}=0 and ${t.recipient} is null and ${t.profileVersion} is null and ${t.preview} is null and ${t.templateInput} is null and ${t.templateVersion} is null and ${t.messageId} is null and ${t.attemptedAt} is null) or (${t.attempts}>0 and ${t.recipient} is not null and ${t.profileVersion} is not null and ${t.profileVersion}>0 and ${t.preview} is not null and ${t.templateInput} is not null and ${t.templateVersion} is not null and ${t.templateVersion}=1 and ${t.messageId} is not null and ${t.attemptedAt} is not null)`,
    ),
    check(
      "invoice_notice_acceptance",
      sql`(${t.state}='accepted')=(${t.acceptedAt} is not null)`,
    ),
    check(
      "invoice_notice_sending",
      sql`${t.state} not in ('sending','accepted') or ${t.attempts}>0`,
    ),
    check(
      "invoice_notice_calendar",
      sql`${t.scheduledAt} is not null or (${t.state}='needs_review' and ${t.reason} is not null and ${t.reason}='calendar_invalid')`,
    ),
    index("invoice_notice_pending").on(
      t.deploymentKey,
      t.state,
      t.nextAttemptAt,
      t.createdAt,
      t.id,
    ),
  ],
);
