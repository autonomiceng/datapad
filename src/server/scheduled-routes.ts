import { Elysia, status, t } from "elysia";
import { accessErrorResponses, accessResponse } from "./access-response";
import type { Access } from "../access/types";
import {
  ConfigureScheduleRequestSchema,
  ConfigureScheduleResponseSchema,
  ScheduleResponseSchema,
  ScheduledGroupsQuerySchema,
  ScheduledGroupsResponseSchema,
} from "../billing/scheduled-contract";
import type { ScheduledBilling } from "../billing/scheduled-types";

export interface ScheduledHttp {
  access: Pick<Access, "resolveActor">;
  scheduled?: ScheduledBilling;
  origin: string;
}

const customerParams = t.Object(
  { customerId: t.String({ format: "uuid" }) },
  { additionalProperties: false },
);
const empty = t.Object({}, { additionalProperties: false });
const groupsQuery = t.Object(
  {
    ...ScheduledGroupsQuerySchema.properties,
    limit: t.Integer(ScheduledGroupsQuerySchema.properties.limit),
    offset: t.Integer(ScheduledGroupsQuerySchema.properties.offset),
  },
  { additionalProperties: false },
);

export function scheduledRoutes(config?: ScheduledHttp) {
  const browserMutation = ({ request }: { request: Request }) => {
    if (!config) return status(503, { code: "unavailable" });
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
      if (!config) return status(503, { code: "unavailable" });
      const actor = await config.access.resolveActor(request.headers);
      if (!actor) return status(401, { code: "unauthenticated" });
      return { actor, config };
    })
    .get(
      "/api/customers/:customerId/billing-schedule",
      async ({ actor, config, params }) => {
        if (!config.scheduled) return status(503, { code: "unavailable" });
        return accessResponse(
          await config.scheduled.getSchedule(actor, params.customerId),
        );
      },
      {
        params: customerParams,
        query: empty,
        response: { 200: ScheduleResponseSchema, ...accessErrorResponses },
        detail: {
          operationId: "getCustomerBillingSchedule",
          summary: "Read explicit invoice activation and issuance hold",
        },
      },
    )
    .post(
      "/api/customers/:customerId/billing-schedule",
      async ({ actor, config, params, body }) => {
        if (!config.scheduled) return status(503, { code: "unavailable" });
        return accessResponse(
          await config.scheduled.configureSchedule(
            actor,
            params.customerId,
            body,
          ),
        );
      },
      {
        params: customerParams,
        query: empty,
        body: ConfigureScheduleRequestSchema,
        parse: "json",
        beforeHandle: browserMutation,
        response: {
          200: ConfigureScheduleResponseSchema,
          ...accessErrorResponses,
        },
        detail: {
          operationId: "configureCustomerBillingSchedule",
          summary: "Activate selected agreements or hold new issuance",
        },
      },
    )
    .get(
      "/api/customers/:customerId/scheduled-groups",
      async ({ actor, config, params, query }) => {
        if (!config.scheduled) return status(503, { code: "unavailable" });
        return accessResponse(
          await config.scheduled.listScheduledGroups(
            actor,
            params.customerId,
            query,
          ),
        );
      },
      {
        params: customerParams,
        query: groupsQuery,
        response: {
          200: ScheduledGroupsResponseSchema,
          ...accessErrorResponses,
        },
        detail: {
          operationId: "listCustomerScheduledGroups",
          summary: "Read bounded invoice groups and review history",
        },
      },
    );
}
