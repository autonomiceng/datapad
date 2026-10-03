import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  jsonb,
  boolean,
  unique,
  foreignKey,
  check,
  index,
} from "drizzle-orm/pg-core";
import { services, serviceComponents } from "../../services/schema";
import type { StaffRole } from "../../access/contract";
import type {
  ProposalCost,
  ProposalDataEffect,
  SupportTarget,
  SupportResult,
} from "../contract";
const instant = (name: string) =>
  timestamp(name, { withTimezone: true, mode: "string" });
export const supportTickets = pgTable(
  "support_tickets",
  {
    id: uuid("id").primaryKey(),
    customerId: uuid("customer_id").notNull(),
    serviceId: uuid("service_id").notNull(),
    componentId: uuid("component_id"),
    subject: text("subject").notNull(),
    status: text("status")
      .$type<"open" | "resolved">()
      .notNull()
      .default("open"),
    version: integer("version").notNull().default(1),
    openedByUserId: text("opened_by_user_id").notNull(),
    createdAt: instant("created_at").notNull().defaultNow(),
    updatedAt: instant("updated_at").notNull().defaultNow(),
  },
  (t) => [
    unique("support_ticket_customer").on(t.id, t.customerId),
    unique("support_ticket_service").on(t.id, t.customerId, t.serviceId),
    unique("support_ticket_component").on(
      t.id,
      t.customerId,
      t.serviceId,
      t.componentId,
    ),
    foreignKey({
      name: "support_ticket_service_customer",
      columns: [t.serviceId, t.customerId],
      foreignColumns: [services.id, services.customerId],
    }),
    foreignKey({
      name: "support_ticket_component_customer",
      columns: [t.componentId, t.serviceId, t.customerId],
      foreignColumns: [
        serviceComponents.id,
        serviceComponents.serviceId,
        serviceComponents.customerId,
      ],
    }),
    check("support_ticket_version", sql`${t.version} > 0`),
    check(
      "support_ticket_subject",
      sql`length(trim(${t.subject})) between 1 and 256`,
    ),
    check("support_ticket_status", sql`${t.status} in ('open','resolved')`),
    index("support_ticket_activity").on(t.customerId, t.updatedAt, t.id),
  ],
);
export const supportProposals = pgTable(
  "support_proposals",
  {
    id: uuid("id").primaryKey(),
    ticketId: uuid("ticket_id").notNull(),
    customerId: uuid("customer_id").notNull(),
    serviceId: uuid("service_id").notNull(),
    componentId: uuid("component_id"),
    version: integer("version").notNull(),
    preparedByUserId: text("prepared_by_user_id").notNull(),
    action: text("action").notNull(),
    cost: jsonb("cost").$type<ProposalCost>().notNull(),
    dataEffect: jsonb("data_effect").$type<ProposalDataEffect>().notNull(),
    target: jsonb("target").$type<SupportTarget>().notNull(),
    createdAt: instant("created_at").notNull().defaultNow(),
  },
  (t) => [
    unique("support_proposal_revision").on(t.ticketId, t.version),
    unique("support_proposal_customer_revision").on(
      t.id,
      t.ticketId,
      t.customerId,
      t.version,
    ),
    foreignKey({
      name: "support_proposal_ticket_service",
      columns: [t.ticketId, t.customerId, t.serviceId],
      foreignColumns: [
        supportTickets.id,
        supportTickets.customerId,
        supportTickets.serviceId,
      ],
    }),
    foreignKey({
      name: "support_proposal_ticket_component",
      columns: [t.ticketId, t.customerId, t.serviceId, t.componentId],
      foreignColumns: [
        supportTickets.id,
        supportTickets.customerId,
        supportTickets.serviceId,
        supportTickets.componentId,
      ],
    }),
    check("support_proposal_version", sql`${t.version} > 0`),
    check(
      "support_proposal_action",
      sql`length(trim(${t.action})) between 1 and 2000`,
    ),
    check(
      "support_proposal_target",
      sql`(${t.target}->'service'->>'id')::uuid = ${t.serviceId} and (${t.target}->'component'->>'id')::uuid is not distinct from ${t.componentId}`,
    ),
  ],
);
export const supportApprovals = pgTable(
  "support_approvals",
  {
    id: uuid("id").primaryKey(),
    ticketId: uuid("ticket_id").notNull(),
    customerId: uuid("customer_id").notNull(),
    proposalId: uuid("proposal_id").notNull().unique(),
    proposalVersion: integer("proposal_version").notNull(),
    approvedByUserId: text("approved_by_user_id").notNull(),
    sessionId: text("session_id").notNull(),
    membershipId: text("membership_id").notNull(),
    invitationId: text("invitation_id"),
    invitedByUserId: text("invited_by_user_id"),
    invitedByStaff: boolean("invited_by_staff"),
    staffRoles: jsonb("staff_roles").$type<StaffRole[]>().notNull(),
    approvedAt: instant("approved_at").notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "support_approval_exact_proposal",
      columns: [t.proposalId, t.ticketId, t.customerId, t.proposalVersion],
      foreignColumns: [
        supportProposals.id,
        supportProposals.ticketId,
        supportProposals.customerId,
        supportProposals.version,
      ],
    }),
    check(
      "support_approval_not_self_invited",
      sql`${t.invitedByUserId} is null or ${t.invitedByUserId} <> ${t.approvedByUserId}`,
    ),
  ],
);
export const supportEntries = pgTable(
  "support_entries",
  {
    id: uuid("id").primaryKey(),
    ticketId: uuid("ticket_id").notNull(),
    customerId: uuid("customer_id").notNull(),
    kind: text("kind").$type<"reply" | "note" | "result">().notNull(),
    body: text("body").notNull(),
    authorUserId: text("author_user_id").notNull(),
    createdAt: instant("created_at").notNull().defaultNow(),
    result: jsonb("result").$type<SupportResult>(),
    proposalId: uuid("proposal_id"),
    proposalVersion: integer("proposal_version"),
  },
  (t) => [
    foreignKey({
      name: "support_entry_ticket_customer",
      columns: [t.ticketId, t.customerId],
      foreignColumns: [supportTickets.id, supportTickets.customerId],
    }),
    foreignKey({
      name: "support_result_exact_proposal",
      columns: [t.proposalId, t.ticketId, t.customerId, t.proposalVersion],
      foreignColumns: [
        supportProposals.id,
        supportProposals.ticketId,
        supportProposals.customerId,
        supportProposals.version,
      ],
    }),
    check(
      "support_entry_body",
      sql`length(trim(${t.body})) between 1 and 10000`,
    ),
    check("support_entry_kind", sql`${t.kind} in ('reply','note','result')`),
    check(
      "support_entry_result",
      sql`(${t.kind} = 'result' and ${t.result} is not null and ((${t.result}->>'outcome' = 'completed' and ${t.proposalId} is not null and ${t.proposalVersion} is not null) or (${t.result}->>'outcome' = 'unchanged' and ${t.proposalId} is null and ${t.proposalVersion} is null))) or (${t.kind} <> 'result' and ${t.result} is null and ${t.proposalId} is null and ${t.proposalVersion} is null)`,
    ),
    index("support_entry_thread").on(
      t.customerId,
      t.ticketId,
      t.createdAt,
      t.id,
    ),
  ],
);
