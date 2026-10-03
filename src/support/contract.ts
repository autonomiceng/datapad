import { Type, type Static, type TProperties } from "@sinclair/typebox";
import { AccountPaginationSchema, StaffRoleSchema } from "../access/contract";
import { ServiceKindSchema, ComponentKindSchema } from "../services/contract";
const object = <T extends TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
const id = Type.String({ format: "uuid" });
const authId = Type.String({ minLength: 1, maxLength: 128 });
const version = Type.Integer({ minimum: 1, maximum: 2147483647 });
const instant = Type.String({ format: "date-time" });
const prose = (maxLength: number) =>
  Type.String({
    minLength: 1,
    maxLength,
    pattern:
      "^(?=[\\s\\S]*\\S)(?:[\\u0001-\\uD7FF\\uE000-\\uFFFF]|[\\uD800-\\uDBFF][\\uDC00-\\uDFFF])+$",
  });
const message = prose(10000);
const command = { requestId: id, expectedVersion: version };
export const ProposalCostSchema = Type.Union([
  object({
    kind: Type.Literal("known"),
    currency: Type.Literal("USD"),
    amountMinor: Type.Integer({ minimum: 0, maximum: 99999999 }),
    description: prose(2000),
  }),
  object({ kind: Type.Literal("unknown"), reason: prose(2000) }),
]);
export const ProposalDataEffectSchema = Type.Union([
  object({ kind: Type.Literal("known"), description: prose(2000) }),
  object({ kind: Type.Literal("unknown"), reason: prose(2000) }),
]);
export const SupportTargetSchema = object({
  service: object({
    id,
    kind: ServiceKindSchema,
    name: Type.String({ minLength: 1, maxLength: 256 }),
    version,
  }),
  component: Type.Union([
    object({ id, kind: ComponentKindSchema, version }),
    Type.Null(),
  ]),
});
export const SupportApprovalSchema = object({
  id,
  proposalId: id,
  proposalVersion: version,
  approvedByUserId: authId,
  approvedAt: instant,
  staffAttribution: Type.Optional(
    object({
      membershipId: authId,
      invitationId: Type.Union([authId, Type.Null()]),
      invitedByUserId: Type.Union([authId, Type.Null()]),
      invitedByStaff: Type.Union([Type.Boolean(), Type.Null()]),
      staffRoles: Type.Array(StaffRoleSchema, {
        maxItems: 3,
        uniqueItems: true,
      }),
    }),
  ),
});
export const SupportProposalSchema = object({
  id,
  version,
  preparedByUserId: authId,
  createdAt: instant,
  action: prose(2000),
  cost: ProposalCostSchema,
  dataEffect: ProposalDataEffectSchema,
  target: SupportTargetSchema,
  approval: Type.Union([SupportApprovalSchema, Type.Null()]),
});
export const SupportResultSchema = object({
  outcome: Type.Union([Type.Literal("completed"), Type.Literal("unchanged")]),
  verifiedAt: instant,
  proposalId: Type.Union([id, Type.Null()]),
  proposalVersion: Type.Union([version, Type.Null()]),
  approvedTarget: Type.Union([SupportTargetSchema, Type.Null()]),
  observedTarget: SupportTargetSchema,
});
export const TicketEntrySchema = object({
  id,
  kind: Type.Union([
    Type.Literal("reply"),
    Type.Literal("note"),
    Type.Literal("result"),
  ]),
  body: message,
  authorUserId: authId,
  createdAt: instant,
  result: Type.Union([SupportResultSchema, Type.Null()]),
});
export const TicketSummarySchema = object({
  id,
  customerId: id,
  serviceId: id,
  componentId: Type.Union([id, Type.Null()]),
  subject: prose(256),
  status: Type.Union([Type.Literal("open"), Type.Literal("resolved")]),
  version,
  openedByUserId: authId,
  createdAt: instant,
  updatedAt: instant,
});
export const TicketsResponseSchema = object({
  tickets: Type.Array(TicketSummarySchema, { maxItems: 100 }),
  total: Type.Integer({ minimum: 0 }),
  ...AccountPaginationSchema.properties,
});
export const TicketResponseSchema = object({
  ticket: TicketSummarySchema,
  entries: Type.Array(TicketEntrySchema, { maxItems: 100 }),
  total: Type.Integer({ minimum: 0 }),
  ...AccountPaginationSchema.properties,
  latestProposal: Type.Union([SupportProposalSchema, Type.Null()]),
  permissions: object({
    canReply: Type.Boolean(),
    canManage: Type.Boolean(),
    canApprove: Type.Boolean(),
    approvalBlockedReason: Type.Union([
      Type.Literal("no_customer_organization"),
      Type.Literal("administrator_required"),
      Type.Literal("self_invited"),
      Type.Literal("no_proposal"),
      Type.Literal("self_prepared"),
      Type.Literal("unknown_effects"),
      Type.Literal("target_changed"),
      Type.Literal("already_approved"),
      Type.Literal("resolved"),
      Type.Null(),
    ]),
  }),
});
export const OpenTicketRequestSchema = object({
  requestId: id,
  serviceId: id,
  componentId: Type.Union([id, Type.Null()]),
  subject: prose(256),
  body: message,
});
export const ReplyRequestSchema = object({ ...command, body: message });
export const AddNoteRequestSchema = object({ ...command, body: message });
export const ProposeRequestSchema = object({
  ...command,
  action: prose(2000),
  cost: ProposalCostSchema,
  dataEffect: ProposalDataEffectSchema,
});
export const ApproveRequestSchema = object({
  ...command,
  proposalId: id,
  proposalVersion: version,
});
export const RecordResultRequestSchema = Type.Union([
  object({
    ...command,
    outcome: Type.Literal("completed"),
    proposalId: id,
    proposalVersion: version,
    body: message,
    verifiedAt: Type.Union([instant, Type.Literal("now")]),
  }),
  object({
    ...command,
    outcome: Type.Literal("unchanged"),
    body: message,
    verifiedAt: Type.Union([instant, Type.Literal("now")]),
  }),
]);
export type ProposalCost = Static<typeof ProposalCostSchema>;
export type ProposalDataEffect = Static<typeof ProposalDataEffectSchema>;
export type SupportTarget = Static<typeof SupportTargetSchema>;
export type SupportResult = Static<typeof SupportResultSchema>;
export type SupportProposal = Static<typeof SupportProposalSchema>;
export type TicketSummary = Static<typeof TicketSummarySchema>;
export type TicketResponse = Static<typeof TicketResponseSchema>;
export type TicketsResponse = Static<typeof TicketsResponseSchema>;
export type OpenTicketRequest = Static<typeof OpenTicketRequestSchema>;
export type ReplyRequest = Static<typeof ReplyRequestSchema>;
export type AddNoteRequest = Static<typeof AddNoteRequestSchema>;
export type ProposeRequest = Static<typeof ProposeRequestSchema>;
export type ApproveRequest = Static<typeof ApproveRequestSchema>;
export type RecordResultRequest = Static<typeof RecordResultRequestSchema>;
