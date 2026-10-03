import { Elysia, status, t } from "elysia";
import { accessErrorResponses, accessResponse } from "./access-response";
import { AccountPaginationSchema } from "../access/contract";
import type { Access } from "../access/types";
import {
  AttachAddonRequestSchema,
  ServiceResponseSchema,
  ServicesResponseSchema,
  SetComponentPreferenceRequestSchema,
} from "../services/contract";
import type { Services } from "../services/types";

export interface ServiceHttp {
  origin: string;
  access: Pick<Access, "resolveActor">;
  services: Services;
}

const id = t.String({ format: "uuid" });
const customerParams = t.Object(
  { customerId: id },
  { additionalProperties: false },
);
const serviceParams = t.Object(
  { ...customerParams.properties, serviceId: id },
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

export function serviceRoutes(options?: ServiceHttp) {
  return new Elysia({ normalize: false })
    .onRequest(({ set }) => {
      set.headers["cache-control"] = "no-store";
    })
    .onBeforeHandle(({ request }) => {
      if (!options) return status(503, { code: "unavailable" });
      if (request.method !== "POST" && request.method !== "PATCH") return;
      if (request.headers.get("origin") !== options.origin)
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
    .resolve(async ({ request }) => {
      if (!options) return status(503, { code: "unavailable" });
      const actor = await options.access.resolveActor(request.headers);
      if (!actor) return status(401, { code: "unauthenticated" });
      return { actor, services: options.services };
    })
    .get(
      "/api/customers/:customerId/services",
      async ({ actor, services, params, query }) =>
        accessResponse(
          await services.listServices(actor, params.customerId, query),
        ),
      {
        params: customerParams,
        query: paginationQuery,
        response: { 200: ServicesResponseSchema, ...accessErrorResponses },
        detail: {
          operationId: "listCustomerServices",
          summary: "List customer services",
          tags: ["Services"],
        },
      },
    )
    .get(
      "/api/customers/:customerId/services/:serviceId",
      async ({ actor, services, params }) =>
        accessResponse(
          await services.getService(actor, params.customerId, params.serviceId),
        ),
      {
        params: serviceParams,
        response: { 200: ServiceResponseSchema, ...accessErrorResponses },
        detail: {
          operationId: "getCustomerService",
          summary: "Read a customer service",
          tags: ["Services"],
        },
      },
    )
    .patch(
      "/api/customers/:customerId/services/:serviceId/components/:componentId/preference",
      async ({ actor, services, params, body }) =>
        accessResponse(
          await services.setComponentPreference(
            actor,
            params.customerId,
            params.serviceId,
            params.componentId,
            body,
          ),
        ),
      {
        params: t.Object(
          { ...serviceParams.properties, componentId: id },
          { additionalProperties: false },
        ),
        body: SetComponentPreferenceRequestSchema,
        parse: "json",
        response: { 200: ServiceResponseSchema, ...accessErrorResponses },
        detail: {
          operationId: "setComponentPreference",
          summary: "Set a service component preference",
          tags: ["Services"],
        },
      },
    )
    .post(
      "/api/customers/:customerId/addons/:addonId/attach",
      async ({ actor, services, params, body }) =>
        accessResponse(
          await services.attachAddon(
            actor,
            params.customerId,
            params.addonId,
            body,
          ),
        ),
      {
        params: t.Object(
          { ...customerParams.properties, addonId: id },
          { additionalProperties: false },
        ),
        body: AttachAddonRequestSchema,
        parse: "json",
        response: { 200: ServiceResponseSchema, ...accessErrorResponses },
        detail: {
          operationId: "attachAddon",
          summary: "Attach or detach a customer add-on",
          tags: ["Services"],
        },
      },
    );
}
