import { Type, type Static, type TProperties } from "@sinclair/typebox";

const object = <T extends TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
const authId = Type.String({ minLength: 1, maxLength: 128 });
const id = Type.String({ format: "uuid" });
const instant = Type.String({ format: "date-time" });
const email = Type.String({ format: "email", maxLength: 254 });

export const StaffRoleSchema = Type.Union([
  Type.Literal("account_administrator"),
  Type.Literal("billing"),
  Type.Literal("support"),
]);
export const CustomerRoleSchema = Type.Union([
  Type.Literal("administrator"),
  Type.Literal("member"),
]);
export const AccessErrorSchema = object({
  code: Type.Union([
    Type.Literal("unauthenticated"),
    Type.Literal("forbidden"),
    Type.Literal("not_found"),
    Type.Literal("conflict"),
    Type.Literal("invalid_request"),
    Type.Literal("unavailable"),
  ]),
});
export const AccessSessionResponseSchema = object({
  user: Type.Union([
    object({
      id: authId,
      name: Type.String({ maxLength: 256 }),
      emailVerified: Type.Boolean(),
    }),
    Type.Null(),
  ]),
  staffRoles: Type.Array(StaffRoleSchema, { maxItems: 3, uniqueItems: true }),
  signInMethods: Type.Array(
    Type.Union([
      Type.Literal("email_link"),
      Type.Literal("google"),
      Type.Literal("microsoft"),
    ]),
    { maxItems: 3, uniqueItems: true },
  ),
  synthetic: Type.Boolean(),
});
export const AccountPaginationSchema = object({
  limit: Type.Integer({ minimum: 1, maximum: 100 }),
  offset: Type.Integer({ minimum: 0, maximum: 1000000 }),
});
export const MemberSchema = object({
  id: authId,
  userId: authId,
  name: Type.String({ maxLength: 256 }),
  email,
  role: CustomerRoleSchema,
});
export const MembersResponseSchema = object({
  members: Type.Array(MemberSchema, { maxItems: 100 }),
  total: Type.Integer({ minimum: 0 }),
  ...AccountPaginationSchema.properties,
});
export const InvitationSchema = object({
  id: authId,
  email,
  role: CustomerRoleSchema,
  status: Type.Union([
    Type.Literal("pending"),
    Type.Literal("accepted"),
    Type.Literal("revoked"),
    Type.Literal("expired"),
  ]),
  expiresAt: instant,
});
export const InvitationsResponseSchema = object({
  invitations: Type.Array(InvitationSchema, { maxItems: 100 }),
  total: Type.Integer({ minimum: 0 }),
  ...AccountPaginationSchema.properties,
});
export const InviteMemberRequestSchema = object({
  requestId: id,
  email,
  role: CustomerRoleSchema,
});
export const AcceptInvitationRequestSchema = object({ requestId: id });
export const RevokeMemberRequestSchema = object({ requestId: id });
export const RevokeInvitationRequestSchema = object({ requestId: id });
export const AccessActionResponseSchema = object({
  actionId: id,
  state: Type.Union([
    Type.Literal("completed"),
    Type.Literal("pending"),
    Type.Literal("needs_review"),
  ]),
  invitationId: Type.Union([authId, Type.Null()]),
});

export type StaffRole = Static<typeof StaffRoleSchema>;
export type CustomerRole = Static<typeof CustomerRoleSchema>;
export type AccessErrorCode = Static<typeof AccessErrorSchema>["code"];
export type AccessSessionResponse = Static<typeof AccessSessionResponseSchema>;
export type AccountPagination = Static<typeof AccountPaginationSchema>;
export type MembersResponse = Static<typeof MembersResponseSchema>;
export type InvitationsResponse = Static<typeof InvitationsResponseSchema>;
export type InviteMemberRequest = Static<typeof InviteMemberRequestSchema>;
export type AcceptInvitationRequest = Static<
  typeof AcceptInvitationRequestSchema
>;
export type RevokeMemberRequest = Static<typeof RevokeMemberRequestSchema>;
export type AccessActionResponse = Static<typeof AccessActionResponseSchema>;

export type RevokeInvitationRequest = Static<
  typeof RevokeInvitationRequestSchema
>;
