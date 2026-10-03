import { Elysia, status, t } from "elysia";
import { accessErrorResponses, accessResponse } from "./access-response";
import {
  AcceptInvitationRequestSchema,
  AccessActionResponseSchema,
  AccessSessionResponseSchema,
  AccountPaginationSchema,
  InvitationsResponseSchema,
  InviteMemberRequestSchema,
  MembersResponseSchema,
  RevokeInvitationRequestSchema,
  RevokeMemberRequestSchema,
} from "../access/contract";
import type { Access } from "../access/types";
import {
  CustomerResponseSchema,
  CustomersResponseSchema,
  UpdateCustomerRequestSchema,
  UpdateCustomerResponseSchema,
} from "../customers/contract";
import type { Customers } from "../customers/types";

export interface AccountHttp {
  access: Pick<
    Access,
    | "resolveActor"
    | "getSession"
    | "listMembers"
    | "listInvitations"
    | "inviteMember"
    | "revokeMember"
    | "revokeInvitation"
    | "acceptInvitation"
  >;
  customers: Pick<
    Customers,
    "listCustomers" | "getCustomer" | "updateCustomer"
  >;
  origin: string;
}

const customerParams = t.Object(
  { customerId: t.String({ format: "uuid" }) },
  { additionalProperties: false },
);
const invitationId = t.String({ minLength: 1, maxLength: 128 });
const invitationParams = t.Object(
  { invitationId },
  { additionalProperties: false },
);
const paginationQuery = t.Object(
  {
    limit: t.Optional(
      t.Integer({
        minimum: AccountPaginationSchema.properties.limit.minimum,
        maximum: AccountPaginationSchema.properties.limit.maximum,
        default: 50,
      }),
    ),
    offset: t.Optional(
      t.Integer({
        minimum: AccountPaginationSchema.properties.offset.minimum,
        maximum: AccountPaginationSchema.properties.offset.maximum,
        default: 0,
      }),
    ),
  },
  { additionalProperties: false },
);

export function accountRoutes({ access, customers, origin }: AccountHttp) {
  return new Elysia({ normalize: false })
    .onRequest(({ set }) => {
      set.headers["cache-control"] = "no-store";
    })
    .as("global")
    .onRequest(({ request }) => {
      if (request.method !== "POST" && request.method !== "PATCH") return;
      if (request.headers.get("origin") !== origin)
        return status(403, { code: "forbidden" });
      if (
        request.headers
          .get("content-type")
          ?.split(";")[0]
          ?.trim()
          .toLowerCase() !== "application/json"
      )
        return status(422, { code: "invalid_request" });
    })
    .onError(({ code }) => {
      if (code === "VALIDATION" || code === "PARSE")
        return status(422, { code: "invalid_request" });
      if (code === "NOT_FOUND") return status(404, { code: "not_found" });
      return status(503, { code: "unavailable" });
    })
    .get(
      "/api/access/session",
      ({ request }) => access.getSession(request.headers),
      {
        response: { 200: AccessSessionResponseSchema, ...accessErrorResponses },
        detail: {
          operationId: "getAccessSession",
          summary: "Read the current session",
        },
      },
    )
    .resolve(async ({ request }) => {
      const actor = await access.resolveActor(request.headers);
      if (!actor) return status(401, { code: "unauthenticated" });
      return { actor };
    })
    .get(
      "/api/customers",
      async ({ actor, query }) =>
        accessResponse(await customers.listCustomers(actor, query)),
      {
        query: paginationQuery,
        response: { 200: CustomersResponseSchema, ...accessErrorResponses },
        detail: {
          operationId: "listCustomers",
          summary: "List accessible customers",
        },
      },
    )
    .get(
      "/api/customers/:customerId",
      async ({ actor, params }) =>
        accessResponse(await customers.getCustomer(actor, params.customerId)),
      {
        params: customerParams,
        response: { 200: CustomerResponseSchema, ...accessErrorResponses },
        detail: { operationId: "getCustomer", summary: "Read a customer" },
      },
    )
    .patch(
      "/api/customers/:customerId",
      async ({ actor, params, body }) =>
        accessResponse(
          await customers.updateCustomer(actor, params.customerId, body),
        ),
      {
        params: customerParams,
        body: UpdateCustomerRequestSchema,
        parse: "json",
        response: {
          200: UpdateCustomerResponseSchema,
          ...accessErrorResponses,
        },
        detail: {
          operationId: "updateCustomer",
          summary: "Update a customer profile",
        },
      },
    )
    .get(
      "/api/customers/:customerId/members",
      async ({ actor, params, query }) =>
        accessResponse(
          await access.listMembers(actor, params.customerId, query),
        ),
      {
        params: customerParams,
        query: paginationQuery,
        response: { 200: MembersResponseSchema, ...accessErrorResponses },
        detail: {
          operationId: "listCustomerMembers",
          summary: "List customer members",
        },
      },
    )
    .get(
      "/api/customers/:customerId/invitations",
      async ({ actor, params, query }) =>
        accessResponse(
          await access.listInvitations(actor, params.customerId, query),
        ),
      {
        params: customerParams,
        query: paginationQuery,
        response: { 200: InvitationsResponseSchema, ...accessErrorResponses },
        detail: {
          operationId: "listCustomerInvitations",
          summary: "List customer invitations",
        },
      },
    )
    .post(
      "/api/customers/:customerId/invitations",
      async ({ request, params, body }) =>
        accessResponse(
          await access.inviteMember(request.headers, params.customerId, body),
        ),
      {
        params: customerParams,
        body: InviteMemberRequestSchema,
        parse: "json",
        response: { 200: AccessActionResponseSchema, ...accessErrorResponses },
        detail: {
          operationId: "inviteCustomerMember",
          summary: "Invite a customer member",
        },
      },
    )
    .post(
      "/api/customers/:customerId/invitations/:invitationId/revoke",
      async ({ request, params, body }) =>
        accessResponse(
          await access.revokeInvitation(
            request.headers,
            params.customerId,
            params.invitationId,
            body,
          ),
        ),
      {
        params: t.Object(
          { ...customerParams.properties, invitationId },
          { additionalProperties: false },
        ),
        body: RevokeInvitationRequestSchema,
        parse: "json",
        response: { 200: AccessActionResponseSchema, ...accessErrorResponses },
        detail: {
          operationId: "revokeCustomerInvitation",
          summary: "Revoke a customer invitation",
        },
      },
    )
    .post(
      "/api/access/invitations/:invitationId/accept",
      async ({ request, params, body }) =>
        accessResponse(
          await access.acceptInvitation(
            request.headers,
            params.invitationId,
            body,
          ),
        ),
      {
        params: invitationParams,
        body: AcceptInvitationRequestSchema,
        parse: "json",
        response: { 200: AccessActionResponseSchema, ...accessErrorResponses },
        detail: {
          operationId: "acceptCustomerInvitation",
          summary: "Accept a customer invitation",
        },
      },
    )
    .post(
      "/api/customers/:customerId/members/:memberId/revoke",
      async ({ request, params, body }) =>
        accessResponse(
          await access.revokeMember(
            request.headers,
            params.customerId,
            params.memberId,
            body,
          ),
        ),
      {
        params: t.Object(
          {
            ...customerParams.properties,
            memberId: t.String({ minLength: 1, maxLength: 128 }),
          },
          { additionalProperties: false },
        ),
        body: RevokeMemberRequestSchema,
        parse: "json",
        response: { 200: AccessActionResponseSchema, ...accessErrorResponses },
        detail: {
          operationId: "revokeCustomerMember",
          summary: "Revoke a customer member",
        },
      },
    );
}
