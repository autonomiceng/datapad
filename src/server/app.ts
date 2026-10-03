import { openapi } from "@elysia/openapi";
import { staticPlugin } from "@elysia/static";
import { Type } from "@sinclair/typebox";
import { Elysia, t } from "elysia";
import { join } from "node:path";
import {
  invoiceWorkflowRoutes,
  type InvoiceWorkflowHttp,
} from "./invoice-workflow-routes";
import { serviceRoutes, type ServiceHttp } from "./service-routes";
import {
  subscriptionRoutes,
  type SubscriptionHttp,
} from "./subscription-routes";
import { scheduledRoutes, type ScheduledHttp } from "./scheduled-routes";
import { resolutionRoutes, type ResolutionHttp } from "./resolution-routes";
import { billingRoutes, type BillingHttp } from "./billing-routes";
import {
  CustomerObservationSchema,
  CustomerResponseSchema,
  CustomersResponseSchema,
  ErrorResponseSchema,
  DataIssuesResponseSchema,
  PaginationSchema,
  ImportFileSchema,
  ImportsResponseSchema,
  SourcesResponseSchema,
} from "../import-review/contract";
import type { ImportReviewReader } from "../import-review";
import { accountRoutes } from "./account-routes";
import type { AccessResult } from "../access/types";
import { AccessErrorSchema } from "../access/contract";

const sourceParams = Type.Object(
  { sourceId: ImportFileSchema.properties.sourceId },
  { additionalProperties: false },
);
const importParams = Type.Object(
  { importId: Type.String({ format: "uuid" }) },
  { additionalProperties: false },
);
const customerParams = Type.Object(
  {
    ...importParams.properties,
    customerId: CustomerObservationSchema.properties.sourceRecordId,
  },
  { additionalProperties: false },
);
const errors = {
  401: AccessErrorSchema,
  403: AccessErrorSchema,
  404: ErrorResponseSchema,
  422: ErrorResponseSchema,
  503: ErrorResponseSchema,
};
const paginationInteger = (schema: typeof PaginationSchema.properties.limit) =>
  t.Optional(
    t.Integer({
      minimum: schema.minimum,
      maximum: schema.maximum,
      default: schema.default,
    }),
  );
const paginationQuery = Type.Object(
  {
    limit: paginationInteger(PaginationSchema.properties.limit),
    offset: paginationInteger(PaginationSchema.properties.offset),
  },
  { additionalProperties: false },
);

export function createApp({
  importReview,
  assetsDir,
  billing,
  services,
  invoiceWorkflow,
  subscriptions,
  scheduled,
  resolutions,
  accounts,
}: {
  importReview: ImportReviewReader;
  assetsDir?: string;
  billing?: BillingHttp;
  services?: ServiceHttp;
  invoiceWorkflow?: InvoiceWorkflowHttp;
  subscriptions?: SubscriptionHttp;
  scheduled?: ScheduledHttp;
  resolutions?: ResolutionHttp;
  accounts?: {
    routes: Parameters<typeof accountRoutes>[0];
    authHandler: (request: Request) => Promise<Response>;
    authorizeImport: (headers: Headers) => Promise<AccessResult<undefined>>;
  };
}) {
  if (accounts && billing && !billing.authorizeRead)
    throw new Error(
      "Authenticated billing requires current account authorization.",
    );
  const app = new Elysia({ normalize: false })
    .onRequest(({ request, set }) => {
      const path = new URL(request.url).pathname;
      if (path === "/api" || path.startsWith("/api/"))
        set.headers["cache-control"] = "no-store";
    })
    .onBeforeHandle(async ({ request, status }) => {
      if (
        !accounts ||
        !new URL(request.url).pathname.startsWith("/api/import-review/")
      )
        return;
      const result = await accounts.authorizeImport(request.headers);
      if (!result.ok) {
        if (result.code === "unauthenticated")
          return status(401, { code: "unauthenticated" });
        if (result.code === "forbidden")
          return status(403, { code: "forbidden" });
        return status(503, { code: "unavailable" });
      }
    })
    .onError(({ code, status, request }) => {
      if (code === "VALIDATION" || code === "PARSE")
        return status(422, {
          code: new URL(request.url).pathname.startsWith("/api/import-review/")
            ? "invalid_query"
            : "invalid_request",
        });
      if (code === "NOT_FOUND") return status(404, { code: "not_found" });
      return status(503, { code: "unavailable" });
    })
    .use(
      openapi({
        path: "/api/openapi",
        provider: null,
        documentation: {
          info: { title: "Datapad API", version: "1.0.0" },
          security: accounts ? [{ portalSession: [] }] : [],
          components: {
            securitySchemes: {
              ...(accounts
                ? {
                    portalSession: {
                      type: "apiKey" as const,
                      in: "cookie" as const,
                      // Authentication uses Better Auth's default cookie names.
                      name: `${new URL(accounts.routes.origin).protocol === "https:" ? "__Secure-" : ""}better-auth.session_token`,
                      description:
                        "Verified portal session. Each operation also checks current staff or customer permissions.",
                    },
                  }
                : {}),
              stripeSignature: {
                type: "apiKey",
                in: "header",
                name: "Stripe-Signature",
                description:
                  "Stripe signature over the raw request body, verified with the configured webhook signing secret. No portal session is required.",
              },
            },
          },
        },
      }),
    )
    .get(
      "/api/import-review/sources",
      ({ query }) => importReview.listSources(query),
      {
        query: paginationQuery,
        response: {
          200: SourcesResponseSchema,
          401: AccessErrorSchema,
          403: AccessErrorSchema,
          422: ErrorResponseSchema,
          503: ErrorResponseSchema,
        },
        detail: {
          operationId: "listImportReviewSources",
          summary: "List import sources",
        },
      },
    )
    .get(
      "/api/import-review/sources/:sourceId/imports",
      async ({ params, query, status }) => {
        const result = await importReview.listImports(params.sourceId, query);
        return result ?? status(404, { code: "not_found" });
      },
      {
        params: sourceParams,
        query: paginationQuery,
        response: { 200: ImportsResponseSchema, ...errors },
        detail: {
          operationId: "listImportReviewImports",
          summary: "List imports under a source",
        },
      },
    )
    .get(
      "/api/import-review/imports/:importId/customers",
      async ({ params, query, status }) => {
        const result = await importReview.listCustomers(params.importId, query);
        return result ?? status(404, { code: "not_found" });
      },
      {
        params: importParams,
        query: paginationQuery,
        response: { 200: CustomersResponseSchema, ...errors },
        detail: {
          operationId: "listImportReviewCustomers",
          summary: "List customers in an import",
        },
      },
    )
    .get(
      "/api/import-review/imports/:importId/customers/:customerId",
      async ({ params, query, status }) => {
        const result = await importReview.getCustomer(
          params.importId,
          params.customerId,
          query,
        );
        return result ?? status(404, { code: "not_found" });
      },
      {
        params: customerParams,
        query: paginationQuery,
        response: { 200: CustomerResponseSchema, ...errors },
        detail: {
          operationId: "getImportReviewCustomer",
          summary: "Read a customer and paginated related records",
        },
      },
    )
    .get(
      "/api/import-review/imports/:importId/data-issues",
      async ({ params, query, status }) => {
        const result = await importReview.listDataIssues(
          params.importId,
          query,
        );
        return result ?? status(404, { code: "not_found" });
      },
      {
        params: importParams,
        query: paginationQuery,
        response: { 200: DataIssuesResponseSchema, ...errors },
        detail: {
          operationId: "listDataIssues",
          summary: "List data issues in an import",
        },
      },
    );

  app.use(billingRoutes(billing));
  app
    .use(serviceRoutes(services))
    .use(invoiceWorkflowRoutes(invoiceWorkflow))
    .use(subscriptionRoutes(subscriptions))
    .use(scheduledRoutes(scheduled))
    .use(resolutionRoutes(resolutions));
  if (accounts) {
    app.use(accountRoutes(accounts.routes));
    app.get("/api/auth/*", ({ request }) => accounts.authHandler(request), {
      detail: { hide: true },
    });
    app.post("/api/auth/*", ({ request }) => accounts.authHandler(request), {
      parse: "none",
      detail: { hide: true },
    });
  }

  if (assetsDir) {
    app.use(
      staticPlugin({
        assets: assetsDir,
        prefix: "",
        alwaysStatic: true,
        indexHTML: false,
        detail: { hide: true },
      }),
    );
    app.get(
      "/*",
      ({ path, status }) => {
        if (path === "/api" || path.startsWith("/api/"))
          return status(404, { code: "not_found" });
        return Bun.file(join(assetsDir, "index.html"));
      },
      { detail: { hide: true } },
    );
  }
  // OpenAPI reads the composed route metadata lazily. Override only exceptions
  // to the composition's default; preserve generated request/response schemas.
  for (const route of app.routes) {
    if (
      route.method === "POST" &&
      route.path === "/api/billing/webhooks/stripe"
    ) {
      route.hooks.detail = {
        ...route.hooks.detail,
        security: [{ stripeSignature: [] }],
      };
    } else if (
      (route.method === "GET" && route.path === "/api/access/session") ||
      route.path.startsWith("/api/auth/") ||
      route.path === "/api/openapi/json"
    ) {
      route.hooks.detail = { ...route.hooks.detail, security: [] };
    }
  }
  return app;
}
