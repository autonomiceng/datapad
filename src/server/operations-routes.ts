import { Elysia, status, t } from "elysia";
import type { Access } from "../access/types";
import type { BillingOperations } from "../billing/operations-types";
import {
  BillingOperationsResponseSchema,
  SetEffectsPausedRequestSchema,
  SetEffectsPausedResponseSchema,
  CheckEffectStatusRequestSchema,
  CheckEffectStatusResponseSchema,
} from "../billing/operations-contract";
import { accessErrorResponses, accessResponse } from "./access-response";

export interface OperationsHttp {
  access: Pick<Access, "resolveActor">;
  operations: BillingOperations;
  origin: string;
}
const empty = t.Object({}, { additionalProperties: false });
export function operationsRoutes(config?: OperationsHttp) {
  return new Elysia({ normalize: false })
    .onRequest(({ set }) => {
      set.headers["cache-control"] = "no-store";
    })
    .onBeforeHandle(({ request }) => {
      if (!config) return status(503, { code: "unavailable" });
      if (request.method === "GET") return;
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
      return { actor, operations: config.operations };
    })
    .get(
      "/api/billing/operations",
      async ({ actor, operations }) =>
        accessResponse(await operations.getOperations(actor)),
      {
        query: empty,
        response: {
          200: BillingOperationsResponseSchema,
          ...accessErrorResponses,
        },
        detail: {
          operationId: "getBillingOperations",
          summary: "Review billing work and effect controls",
        },
      },
    )
    .post(
      "/api/billing/operations/control",
      async ({ actor, operations, body }) =>
        accessResponse(await operations.setEffectsPaused(actor, body)),
      {
        query: empty,
        body: SetEffectsPausedRequestSchema,
        response: {
          200: SetEffectsPausedResponseSchema,
          ...accessErrorResponses,
        },
        detail: {
          operationId: "setBillingEffectsPaused",
          summary: "Pause or resume financial writes",
        },
      },
    )
    .post(
      "/api/billing/operations/check",
      async ({ actor, operations, body }) =>
        accessResponse(await operations.checkStatus(actor, body)),
      {
        query: empty,
        body: CheckEffectStatusRequestSchema,
        response: {
          200: CheckEffectStatusResponseSchema,
          ...accessErrorResponses,
        },
        detail: {
          operationId: "checkBillingEffectStatus",
          summary:
            "Retrieve an existing effect outcome without dispatching writes",
        },
      },
    );
}
