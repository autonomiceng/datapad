import { randomUUID } from "node:crypto";
import { and, asc, count, desc, eq, ne } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Value } from "@sinclair/typebox/value";
import { AuditRequestConflict } from "../access";
import type { AccountPagination } from "../access/contract";
import type {
  AccessResult,
  AuditEntry,
  CustomerAccess,
  HumanActor,
} from "../access/types";
import {
  OpenTicketRequestSchema,
  ReplyRequestSchema,
  AddNoteRequestSchema,
  ProposeRequestSchema,
  ApproveRequestSchema,
  RecordResultRequestSchema,
  type OpenTicketRequest,
  type ReplyRequest,
  type AddNoteRequest,
  type ProposeRequest,
  type ApproveRequest,
  type RecordResultRequest,
  type TicketResponse,
  type TicketSummary,
  type SupportTarget,
  type SupportProposal,
} from "./contract";
import type { Support, SupportOptions } from "./types";
import {
  supportTickets as tickets,
  supportEntries as entries,
  supportProposals as proposals,
  supportApprovals as approvals,
} from "./internal/schema";
import { pagination, validId } from "./internal/validation";
export type { Support, SupportOptions } from "./types";
type Ticket = typeof tickets.$inferSelect;
type Proposal = typeof proposals.$inferSelect;
type Approval = typeof approvals.$inferSelect;
type Command =
  | { kind: "open"; input: OpenTicketRequest }
  | { kind: "reply"; input: ReplyRequest }
  | { kind: "note"; input: AddNoteRequest }
  | { kind: "propose"; input: ProposeRequest }
  | { kind: "approve"; input: ApproveRequest }
  | { kind: "result"; input: RecordResultRequest };
const iso = (value: string) => new Date(value).toISOString();
const summary = (ticket: Ticket): TicketSummary => ({
  ...ticket,
  createdAt: iso(ticket.createdAt),
  updatedAt: iso(ticket.updatedAt),
});
const sameVersions = (a: SupportTarget, b: SupportTarget) =>
  a.service.version === b.service.version &&
  a.component?.version === b.component?.version;
function approvalBlock(
  access: CustomerAccess,
  actor: HumanActor,
  ticket: Ticket,
  proposal: Proposal | null,
  approval: Approval | null,
  target: SupportTarget | null,
): TicketResponse["permissions"]["approvalBlockedReason"] {
  if (!access.organizationId) return "no_customer_organization";
  if (access.customerRole !== "administrator" || !access.customerMembership)
    return "administrator_required";
  if (access.customerMembership.invitedByUserId === actor.userId)
    return "self_invited";
  if (ticket.status === "resolved") return "resolved";
  if (!proposal) return "no_proposal";
  if (proposal.preparedByUserId === actor.userId) return "self_prepared";
  if (
    proposal.cost.kind === "unknown" ||
    proposal.dataEffect.kind === "unknown"
  )
    return "unknown_effects";
  if (!target || !sameVersions(proposal.target, target))
    return "target_changed";
  if (approval) return "already_approved";
  return null;
}
async function latest(tx: NodePgDatabase, ticket: Ticket) {
  const [proposal] = await tx
    .select()
    .from(proposals)
    .where(
      and(
        eq(proposals.ticketId, ticket.id),
        eq(proposals.customerId, ticket.customerId),
      ),
    )
    .orderBy(desc(proposals.version))
    .limit(1);
  const [approval] = proposal
    ? await tx
        .select()
        .from(approvals)
        .where(
          and(
            eq(approvals.proposalId, proposal.id),
            eq(approvals.customerId, ticket.customerId),
          ),
        )
    : [];
  return { proposal: proposal ?? null, approval: approval ?? null };
}
/** Creates human support operations with current customer authority, transactional audit and local persistence only. Failed audit throws and rolls back; reused requests and stale versions conflict. */
export function createSupport(options: SupportOptions): Support {
  const db = drizzle(options.pool);
  async function detail(
    tx: NodePgDatabase,
    actor: HumanActor,
    access: CustomerAccess,
    ticket: Ticket,
    page: AccountPagination,
  ): Promise<TicketResponse> {
    const canManage = access.staffRoles.includes("support");
    const visible = and(
      eq(entries.ticketId, ticket.id),
      eq(entries.customerId, ticket.customerId),
      canManage ? undefined : ne(entries.kind, "note"),
    );
    const rows = await tx
      .select()
      .from(entries)
      .where(visible)
      .orderBy(asc(entries.createdAt), asc(entries.id))
      .limit(page.limit)
      .offset(page.offset);
    const [total] = await tx
      .select({ count: count() })
      .from(entries)
      .where(visible);
    const { proposal, approval } = await latest(tx, ticket);
    const target = proposal
      ? await options.readTarget(
          tx,
          ticket.customerId,
          ticket.serviceId,
          ticket.componentId,
          { lock: false },
        )
      : null;
    const blocked = approvalBlock(
      access,
      actor,
      ticket,
      proposal,
      approval,
      target,
    );
    const latestProposal: SupportProposal | null = proposal
      ? {
          id: proposal.id,
          version: proposal.version,
          preparedByUserId: proposal.preparedByUserId,
          createdAt: iso(proposal.createdAt),
          action: proposal.action,
          cost: proposal.cost,
          dataEffect: proposal.dataEffect,
          target: proposal.target,
          approval: approval
            ? {
                id: approval.id,
                proposalId: approval.proposalId,
                proposalVersion: approval.proposalVersion,
                approvedByUserId: approval.approvedByUserId,
                approvedAt: iso(approval.approvedAt),
                ...(canManage
                  ? {
                      staffAttribution: {
                        membershipId: approval.membershipId,
                        invitationId: approval.invitationId,
                        invitedByUserId: approval.invitedByUserId,
                        invitedByStaff: approval.invitedByStaff,
                        staffRoles: approval.staffRoles,
                      },
                    }
                  : {}),
              }
            : null,
        }
      : null;
    return {
      ticket: summary(ticket),
      entries: rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        body: row.body,
        authorUserId: row.authorUserId,
        createdAt: iso(row.createdAt),
        result: row.result,
      })),
      total: total.count,
      ...page,
      latestProposal,
      permissions: {
        canReply: true,
        canManage,
        canApprove: blocked === null,
        approvalBlockedReason: blocked,
      },
    };
  }
  async function mutate(
    actor: HumanActor,
    customerId: string,
    ticketId: string | null,
    command: Command,
  ): Promise<AccessResult<TicketResponse>> {
    if (!validId(customerId) || (ticketId !== null && !validId(ticketId)))
      return { ok: false, code: "invalid_request" };
    try {
      return await db.transaction(
        async (tx): Promise<AccessResult<TicketResponse>> => {
          const capability =
            command.kind === "open" || command.kind === "reply"
              ? "request_support"
              : command.kind === "approve"
                ? "approve_support"
                : "manage_support";
          const authorized = await options.authorizeCustomer(
            tx,
            actor,
            customerId,
            capability,
            true,
          );
          if (!authorized.ok) return authorized;
          const access = authorized.value;
          let ticket: Ticket;
          let audit: Extract<AuditEntry, { support: unknown }>;
          const identity = {
            actor,
            customerId,
            requestId: command.input.requestId.toLowerCase(),
          };
          if (command.kind === "open") {
            const { input } = command;
            const target = await options.readTarget(
              tx,
              customerId,
              input.serviceId,
              input.componentId,
              { lock: true },
            );
            if (!target) return { ok: false, code: "not_found" };
            const now = new Date().toISOString();
            const [created] = await tx
              .insert(tickets)
              .values({
                id: randomUUID(),
                customerId,
                serviceId: input.serviceId,
                componentId: input.componentId,
                subject: input.subject,
                openedByUserId: actor.userId,
                createdAt: now,
                updatedAt: now,
              })
              .returning();
            ticket = created;
            const entryId = randomUUID();
            await tx.insert(entries).values({
              id: entryId,
              ticketId: ticket.id,
              customerId,
              kind: "reply",
              body: input.body,
              authorUserId: actor.userId,
              createdAt: now,
            });
            audit = {
              ...identity,
              targetId: ticket.id,
              action: "ticket.opened",
              changedFields: ["ticket", "reply"],
              support: { ticketVersion: ticket.version, entryId },
            };
          } else {
            if (!ticketId) return { ok: false, code: "not_found" };
            const [current] = await tx
              .select()
              .from(tickets)
              .where(
                and(
                  eq(tickets.id, ticketId),
                  eq(tickets.customerId, customerId),
                ),
              )
              .for("update");
            if (!current) return { ok: false, code: "not_found" };
            if (
              current.version !== command.input.expectedVersion ||
              (command.kind !== "note" && current.version === 2147483647)
            )
              return { ok: false, code: "conflict" };
            ticket = current;
            const now = new Date().toISOString();
            const nextVersion =
              command.kind === "note" ? current.version : current.version + 1;
            const common = {
              ...identity,
              targetId: ticket.id,
              support: { ticketVersion: nextVersion },
            };
            if (command.kind === "reply" || command.kind === "note") {
              const entryId = randomUUID();
              await tx.insert(entries).values({
                id: entryId,
                ticketId: ticket.id,
                customerId,
                kind: command.kind,
                body: command.input.body,
                authorUserId: actor.userId,
                createdAt: now,
              });
              audit = {
                ...common,
                action:
                  command.kind === "reply"
                    ? "ticket.replied"
                    : "ticket.note_added",
                changedFields: [command.kind],
                support: { ...common.support, entryId },
              };
            } else {
              if (ticket.status !== "open")
                return { ok: false, code: "conflict" };
              const target = await options.readTarget(
                tx,
                customerId,
                ticket.serviceId,
                ticket.componentId,
                { lock: true },
              );
              if (!target) return { ok: false, code: "not_found" };
              const { proposal, approval } = await latest(tx, ticket);
              if (command.kind === "propose") {
                const version = (proposal?.version ?? 0) + 1;
                if (version > 2147483647)
                  return { ok: false, code: "conflict" };
                const proposalId = randomUUID();
                await tx.insert(proposals).values({
                  id: proposalId,
                  ticketId: ticket.id,
                  customerId,
                  serviceId: ticket.serviceId,
                  componentId: ticket.componentId,
                  version,
                  action: command.input.action,
                  cost: command.input.cost,
                  dataEffect: command.input.dataEffect,
                  preparedByUserId: actor.userId,
                  target,
                  createdAt: now,
                });
                audit = {
                  ...common,
                  action: "ticket.proposed",
                  changedFields: ["proposal"],
                  support: {
                    ...common.support,
                    proposalId,
                    proposalVersion: version,
                  },
                };
              } else if (command.kind === "approve") {
                const blocked = approvalBlock(
                  access,
                  actor,
                  ticket,
                  proposal,
                  approval,
                  target,
                );
                if (
                  blocked === "self_prepared" ||
                  blocked === "self_invited" ||
                  blocked === "administrator_required" ||
                  blocked === "no_customer_organization"
                )
                  return { ok: false, code: "forbidden" };
                if (
                  blocked ||
                  !proposal ||
                  proposal.id !== command.input.proposalId ||
                  proposal.version !== command.input.proposalVersion
                )
                  return { ok: false, code: "conflict" };
                const membership = access.customerMembership;
                if (!membership) return { ok: false, code: "forbidden" };
                const approvalId = randomUUID();
                await tx.insert(approvals).values({
                  id: approvalId,
                  ticketId: ticket.id,
                  customerId,
                  proposalId: proposal.id,
                  proposalVersion: proposal.version,
                  approvedByUserId: actor.userId,
                  sessionId: actor.sessionId,
                  membershipId: membership.id,
                  invitationId: membership.invitationId,
                  invitedByUserId: membership.invitedByUserId,
                  invitedByStaff: membership.invitedByStaff,
                  staffRoles: access.staffRoles,
                  approvedAt: now,
                });
                audit = {
                  ...common,
                  action: "ticket.approved",
                  changedFields: ["approval"],
                  support: {
                    ...common.support,
                    approvalId,
                    proposalId: proposal.id,
                    proposalVersion: proposal.version,
                  },
                };
              } else {
                const { input } = command;
                if (
                  input.outcome === "completed" &&
                  (!proposal ||
                    !approval ||
                    proposal.id !== input.proposalId ||
                    proposal.version !== input.proposalVersion)
                )
                  return { ok: false, code: "conflict" };
                const recordedAt = new Date();
                const verifiedAt =
                  input.verifiedAt === "now"
                    ? recordedAt
                    : new Date(input.verifiedAt);
                const earliest =
                  input.outcome === "completed" && approval
                    ? approval.approvedAt
                    : ticket.createdAt;
                if (
                  !Number.isFinite(verifiedAt.getTime()) ||
                  verifiedAt.getTime() > recordedAt.getTime() ||
                  verifiedAt.getTime() < new Date(earliest).getTime()
                )
                  return { ok: false, code: "invalid_request" };
                const approved =
                  input.outcome === "completed" ? proposal : null;
                const entryId = randomUUID();
                await tx.insert(entries).values({
                  id: entryId,
                  ticketId: ticket.id,
                  customerId,
                  kind: "result",
                  body: input.body,
                  authorUserId: actor.userId,
                  createdAt: now,
                  proposalId: approved?.id ?? null,
                  proposalVersion: approved?.version ?? null,
                  result: {
                    outcome: input.outcome,
                    verifiedAt: verifiedAt.toISOString(),
                    proposalId: approved?.id ?? null,
                    proposalVersion: approved?.version ?? null,
                    approvedTarget: approved?.target ?? null,
                    observedTarget: target,
                  },
                });
                audit = {
                  ...common,
                  action: "ticket.result_recorded",
                  changedFields: ["result"],
                  support: {
                    ...common.support,
                    entryId,
                    ...(approved
                      ? {
                          proposalId: approved.id,
                          proposalVersion: approved.version,
                        }
                      : {}),
                  },
                };
              }
            }
            if (command.kind !== "note") {
              const [updated] = await tx
                .update(tickets)
                .set({
                  version: nextVersion,
                  updatedAt: now,
                  status: command.kind === "result" ? "resolved" : "open",
                })
                .where(
                  and(
                    eq(tickets.id, ticket.id),
                    eq(tickets.customerId, customerId),
                  ),
                )
                .returning();
              ticket = updated;
            }
          }
          await options.audit.append(tx, audit);
          return {
            ok: true,
            value: await detail(tx, actor, access, ticket, {
              limit: 50,
              offset: 0,
            }),
          };
        },
      );
    } catch (error) {
      if (error instanceof AuditRequestConflict)
        return { ok: false, code: "conflict" };
      throw error;
    }
  }
  return {
    async listTickets(actor, customerId, input) {
      const page = pagination(input);
      if (!validId(customerId) || !page)
        return { ok: false, code: "invalid_request" };
      return db.transaction(
        async (tx) => {
          const access = await options.authorizeCustomer(
            tx,
            actor,
            customerId,
            "read_support",
            false,
          );
          if (!access.ok) return access;
          const where = eq(tickets.customerId, customerId);
          const rows = await tx
            .select()
            .from(tickets)
            .where(where)
            .orderBy(desc(tickets.updatedAt), desc(tickets.id))
            .limit(page.limit)
            .offset(page.offset);
          const [total] = await tx
            .select({ count: count() })
            .from(tickets)
            .where(where);
          return {
            ok: true,
            value: { tickets: rows.map(summary), total: total.count, ...page },
          };
        },
        { isolationLevel: "repeatable read", accessMode: "read only" },
      );
    },
    async getTicket(actor, customerId, ticketId, input) {
      const page = pagination(input);
      if (!validId(customerId) || !validId(ticketId) || !page)
        return { ok: false, code: "invalid_request" };
      return db.transaction(
        async (tx) => {
          const access = await options.authorizeCustomer(
            tx,
            actor,
            customerId,
            "read_support",
            false,
          );
          if (!access.ok) return access;
          const [ticket] = await tx
            .select()
            .from(tickets)
            .where(
              and(eq(tickets.id, ticketId), eq(tickets.customerId, customerId)),
            );
          if (!ticket) return { ok: false, code: "not_found" };
          return {
            ok: true,
            value: await detail(tx, actor, access.value, ticket, page),
          };
        },
        { isolationLevel: "repeatable read", accessMode: "read only" },
      );
    },
    async openTicket(actor, customerId, input) {
      if (!Value.Check(OpenTicketRequestSchema, input))
        return { ok: false, code: "invalid_request" };
      return mutate(actor, customerId, null, { kind: "open", input });
    },
    async reply(actor, customerId, ticketId, input) {
      if (!Value.Check(ReplyRequestSchema, input))
        return { ok: false, code: "invalid_request" };
      return mutate(actor, customerId, ticketId, { kind: "reply", input });
    },
    async addNote(actor, customerId, ticketId, input) {
      if (!Value.Check(AddNoteRequestSchema, input))
        return { ok: false, code: "invalid_request" };
      return mutate(actor, customerId, ticketId, { kind: "note", input });
    },
    async propose(actor, customerId, ticketId, input) {
      if (!Value.Check(ProposeRequestSchema, input))
        return { ok: false, code: "invalid_request" };
      return mutate(actor, customerId, ticketId, { kind: "propose", input });
    },
    async approve(actor, customerId, ticketId, input) {
      if (!Value.Check(ApproveRequestSchema, input))
        return { ok: false, code: "invalid_request" };
      return mutate(actor, customerId, ticketId, { kind: "approve", input });
    },
    async recordResult(actor, customerId, ticketId, input) {
      if (!Value.Check(RecordResultRequestSchema, input))
        return { ok: false, code: "invalid_request" };
      return mutate(actor, customerId, ticketId, { kind: "result", input });
    },
  };
}
