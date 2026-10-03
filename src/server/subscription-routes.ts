import { Elysia, status, t } from "elysia";
import {
  accessErrorResponses,
  accessErrorStatus,
  accessResponse,
} from "./access-response";
import { AccountPaginationSchema } from "../access/contract";
import type { Access, AccessResult, HumanActor } from "../access/types";
import {
  CreateSubscriptionRequestSchema,
  ChangeSubscriptionRequestSchema,
  SubscriptionResponseSchema,
  SubscriptionsResponseSchema,
  CreateSubscriptionResponseSchema,
  ChangeSubscriptionResponseSchema,
  SubscriptionBoundaryRequestSchema,
  SubscriptionBoundariesResponseSchema,
  ForecastQuerySchema,
  ForecastResponseSchema,
  MaterializeForecastRequestSchema,
  MaterializeForecastResponseSchema,
  SubscriptionOptionsResponseSchema,
  type SubscriptionOptionsResponse,
} from "../billing/subscriptions-contract";
import type { Subscriptions } from "../billing/subscriptions-types";

export interface SubscriptionHttp {
  access: Pick<Access, "resolveActor">;
  subscriptions: Subscriptions;
  origin: string;
  readOptions(
    actor: HumanActor,
    customerId: string,
  ): Promise<AccessResult<SubscriptionOptionsResponse>>;
}

const customerParams = t.Object(
  { customerId: t.String({ format: "uuid" }) },
  { additionalProperties: false },
);
const subscriptionParams = t.Object(
  {
    ...customerParams.properties,
    subscriptionId: t.String({ format: "uuid" }),
  },
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

const boundaryQuery = t.Object(
  {
    ...SubscriptionBoundaryRequestSchema.properties,
    intervalMonths: t.NumericEnum({
      monthly: 1,
      quarterly: 3,
      halfYearly: 6,
      yearly: 12,
      twoYearly: 24,
      threeYearly: 36,
    } as const),
  },
  { additionalProperties: false },
);

const forecastQuery = t.Object(
  {
    ...ForecastQuerySchema.properties,
    limit: t.Integer(ForecastQuerySchema.properties.limit),
    offset: t.Integer(ForecastQuerySchema.properties.offset),
  },
  { additionalProperties: false },
);

export function subscriptionRoutes(config?: SubscriptionHttp) {
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
      "/api/customers/:customerId/subscription-options",
      async ({ actor, config, params }) =>
        accessResponse(await config.readOptions(actor, params.customerId)),
      {
        params: customerParams,
        query: empty,
        response: {
          200: SubscriptionOptionsResponseSchema,
          ...accessErrorResponses,
        },
        detail: {
          operationId: "getSubscriptionOptions",
          summary: "Read subscription choices",
        },
      },
    )
    .get(
      "/api/customers/:customerId/subscriptions",
      async ({ actor, config, params, query }) =>
        accessResponse(
          await config.subscriptions.listSubscriptions(
            actor,
            params.customerId,
            query,
          ),
        ),
      {
        params: customerParams,
        query: pagination,
        response: { 200: SubscriptionsResponseSchema, ...accessErrorResponses },
        detail: {
          operationId: "listCustomerSubscriptions",
          summary: "List customer agreements",
        },
      },
    )
    .post(
      "/api/customers/:customerId/subscriptions",
      async ({ actor, config, params, body }) => {
        const result = await config.subscriptions.createSubscription(
          actor,
          params.customerId,
          body,
        );
        if (!result.ok)
          return status(accessErrorStatus[result.code], { code: result.code });
        return status(
          result.value.outcome === "created" ? 201 : 200,
          result.value,
        );
      },
      {
        params: customerParams,
        query: empty,
        body: CreateSubscriptionRequestSchema,
        parse: "json",
        beforeHandle: browserMutation,
        response: {
          200: CreateSubscriptionResponseSchema,
          201: CreateSubscriptionResponseSchema,
          ...accessErrorResponses,
        },
        detail: {
          operationId: "createCustomerSubscription",
          summary: "Record a recurring agreement",
        },
      },
    )
    .get(
      "/api/customers/:customerId/subscriptions/:subscriptionId",
      async ({ actor, config, params }) =>
        accessResponse(
          await config.subscriptions.getSubscription(
            actor,
            params.customerId,
            params.subscriptionId,
          ),
        ),
      {
        params: subscriptionParams,
        query: empty,
        response: { 200: SubscriptionResponseSchema, ...accessErrorResponses },
        detail: {
          operationId: "getCustomerSubscription",
          summary: "Read a recurring agreement",
        },
      },
    )
    .patch(
      "/api/customers/:customerId/subscriptions/:subscriptionId",
      async ({ actor, config, params, body }) =>
        accessResponse(
          await config.subscriptions.changeSubscription(
            actor,
            params.customerId,
            params.subscriptionId,
            body,
          ),
        ),
      {
        params: subscriptionParams,
        query: empty,
        body: ChangeSubscriptionRequestSchema,
        parse: "json",
        beforeHandle: browserMutation,
        response: {
          200: ChangeSubscriptionResponseSchema,
          ...accessErrorResponses,
        },
        detail: {
          operationId: "changeCustomerSubscription",
          summary: "Record future agreement terms or cancellation",
        },
      },
    )
    .get(
      "/api/customers/:customerId/subscription-boundaries",
      async ({ actor, config, params, query }) =>
        accessResponse(
          await config.subscriptions.getBoundaryOptions(
            actor,
            params.customerId,
            query,
          ),
        ),
      {
        params: customerParams,
        query: boundaryQuery,
        response: {
          200: SubscriptionBoundariesResponseSchema,
          ...accessErrorResponses,
        },
        detail: {
          operationId: "getSubscriptionBoundaries",
          summary: "Read service period and due date choices",
        },
      },
    )
    .get(
      "/api/customers/:customerId/billing-forecast",
      async ({ actor, config, params, query }) =>
        accessResponse(
          await config.subscriptions.getForecast(
            actor,
            params.customerId,
            query,
          ),
        ),
      {
        params: customerParams,
        query: forecastQuery,
        response: { 200: ForecastResponseSchema, ...accessErrorResponses },
        detail: {
          operationId: "getCustomerBillingForecast",
          summary: "Read the bounded billing forecast",
        },
      },
    )
    .post(
      "/api/customers/:customerId/billing-forecast",
      async ({ actor, config, params, body }) =>
        accessResponse(
          await config.subscriptions.materializeForecast(
            actor,
            params.customerId,
            body,
          ),
        ),
      {
        params: customerParams,
        query: empty,
        body: MaterializeForecastRequestSchema,
        parse: "json",
        beforeHandle: browserMutation,
        response: {
          200: MaterializeForecastResponseSchema,
          ...accessErrorResponses,
        },
        detail: {
          operationId: "materializeCustomerBillingForecast",
          summary: "Generate durable forecast periods without issuing invoices",
        },
      },
    );
}
