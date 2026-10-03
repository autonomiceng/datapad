import { Elysia, status, t } from "elysia";
import { AccountPaginationSchema } from "../access/contract";
import type { Access } from "../access/types";
import type { Support } from "../support/types";
import {
  TicketsResponseSchema,
  TicketResponseSchema,
  OpenTicketRequestSchema,
  ReplyRequestSchema,
  AddNoteRequestSchema,
  ProposeRequestSchema,
  ApproveRequestSchema,
  RecordResultRequestSchema,
} from "../support/contract";
import {
  accessResponse,
  accessErrorResponses,
  accessErrorStatus,
} from "./access-response";

const customerParams = t.Object(
  { customerId: t.String({ format: "uuid" }) },
  { additionalProperties: false },
);
const ticketParams = t.Object(
  { ...customerParams.properties, ticketId: t.String({ format: "uuid" }) },
  { additionalProperties: false },
);
const empty = t.Object({}, { additionalProperties: false });
const pagination = t.Object(
  {
    limit: t.Optional(
      t.Integer({ ...AccountPaginationSchema.properties.limit, default: 50 }),
    ),
    offset: t.Optional(
      t.Integer({ ...AccountPaginationSchema.properties.offset, default: 0 }),
    ),
  },
  { additionalProperties: false },
);

export function supportRoutes(config?: {
  access: Pick<Access, "resolveActor">;
  support?: Support;
  origin: string;
}) {
  const browserMutation = ({ request }: { request: Request }) => {
    if (!config?.support) return status(503, { code: "unavailable" });
    if (request.headers.get("origin") !== config.origin)
      return status(403, { code: "forbidden" });
    if (
      request.headers
        .get("content-type")
        ?.split(";")[0]
        ?.trim()
        .toLowerCase() !== "application/json"
    )
      return status(422, { code: "invalid_request" });
  };
  return new Elysia({ normalize: false })
    .onRequest(({ set }) => {
      set.headers["cache-control"] = "no-store";
    })
    .onError(({ code }) => {
      if (code === "VALIDATION" || code === "PARSE")
        return status(422, { code: "invalid_request" });
      if (code === "NOT_FOUND") return status(404, { code: "not_found" });
      return status(503, { code: "unavailable" });
    })
    .resolve(async ({ request }) => {
      if (!config?.support) return status(503, { code: "unavailable" });
      const actor = await config.access.resolveActor(request.headers);
      if (!actor) return status(401, { code: "unauthenticated" });
      return { actor, support: config.support };
    })
    .get(
      "/api/customers/:customerId/tickets",
      async ({ actor, support, params, query }) =>
        accessResponse(
          await support.listTickets(actor, params.customerId, query),
        ),
      {
        params: customerParams,
        query: pagination,
        response: { 200: TicketsResponseSchema, ...accessErrorResponses },
        detail: {
          operationId: "listCustomerTickets",
          summary: "List customer support requests",
        },
      },
    )
    .get(
      "/api/customers/:customerId/tickets/:ticketId",
      async ({ actor, support, params, query }) =>
        accessResponse(
          await support.getTicket(
            actor,
            params.customerId,
            params.ticketId,
            query,
          ),
        ),
      {
        params: ticketParams,
        query: pagination,
        response: { 200: TicketResponseSchema, ...accessErrorResponses },
        detail: {
          operationId: "getCustomerTicket",
          summary: "Read a support request and permitted entries",
        },
      },
    )
    .post(
      "/api/customers/:customerId/tickets",
      async ({ actor, support, params, body }) => {
        const result = await support.openTicket(actor, params.customerId, body);
        if (!result.ok)
          return status(accessErrorStatus[result.code], { code: result.code });
        return status(201, result.value);
      },
      {
        params: customerParams,
        query: empty,
        body: OpenTicketRequestSchema,
        parse: "json",
        beforeHandle: browserMutation,
        response: { 201: TicketResponseSchema, ...accessErrorResponses },
        detail: {
          operationId: "openCustomerTicket",
          summary: "Open a service-linked support request",
        },
      },
    )
    .post(
      "/api/customers/:customerId/tickets/:ticketId/replies",
      async ({ actor, support, params, body }) =>
        accessResponse(
          await support.reply(actor, params.customerId, params.ticketId, body),
        ),
      {
        params: ticketParams,
        query: empty,
        body: ReplyRequestSchema,
        parse: "json",
        beforeHandle: browserMutation,
        response: { 200: TicketResponseSchema, ...accessErrorResponses },
        detail: {
          operationId: "replyToCustomerTicket",
          summary: "Reply and reopen a support request",
        },
      },
    )
    .post(
      "/api/customers/:customerId/tickets/:ticketId/notes",
      async ({ actor, support, params, body }) =>
        accessResponse(
          await support.addNote(
            actor,
            params.customerId,
            params.ticketId,
            body,
          ),
        ),
      {
        params: ticketParams,
        query: empty,
        body: AddNoteRequestSchema,
        parse: "json",
        beforeHandle: browserMutation,
        response: { 200: TicketResponseSchema, ...accessErrorResponses },
        detail: {
          operationId: "addCustomerTicketNote",
          summary: "Add a staff-only internal note",
        },
      },
    )
    .post(
      "/api/customers/:customerId/tickets/:ticketId/proposals",
      async ({ actor, support, params, body }) =>
        accessResponse(
          await support.propose(
            actor,
            params.customerId,
            params.ticketId,
            body,
          ),
        ),
      {
        params: ticketParams,
        query: empty,
        body: ProposeRequestSchema,
        parse: "json",
        beforeHandle: browserMutation,
        response: { 200: TicketResponseSchema, ...accessErrorResponses },
        detail: {
          operationId: "proposeCustomerTicketChange",
          summary: "Prepare a new service change revision",
        },
      },
    )
    .post(
      "/api/customers/:customerId/tickets/:ticketId/approvals",
      async ({ actor, support, params, body }) =>
        accessResponse(
          await support.approve(
            actor,
            params.customerId,
            params.ticketId,
            body,
          ),
        ),
      {
        params: ticketParams,
        query: empty,
        body: ApproveRequestSchema,
        parse: "json",
        beforeHandle: browserMutation,
        response: { 200: TicketResponseSchema, ...accessErrorResponses },
        detail: {
          operationId: "approveCustomerTicketProposal",
          summary: "Approve the exact latest service change revision",
        },
      },
    )
    .post(
      "/api/customers/:customerId/tickets/:ticketId/result",
      async ({ actor, support, params, body }) =>
        accessResponse(
          await support.recordResult(
            actor,
            params.customerId,
            params.ticketId,
            body,
          ),
        ),
      {
        params: ticketParams,
        query: empty,
        body: RecordResultRequestSchema,
        parse: "json",
        beforeHandle: browserMutation,
        response: { 200: TicketResponseSchema, ...accessErrorResponses },
        detail: {
          operationId: "recordCustomerTicketResult",
          summary: "Record a manually verified support result",
        },
      },
    );
}
