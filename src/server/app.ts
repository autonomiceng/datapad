import { openapi } from "@elysia/openapi";
import { staticPlugin } from "@elysia/static";
import { Type } from "@sinclair/typebox";
import { Elysia, t } from "elysia";
import { join } from "node:path";
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
}: {
  importReview: ImportReviewReader;
  assetsDir?: string;
  billing?: BillingHttp;
}) {
  const app = new Elysia({ normalize: false })
    .onRequest(({ request, set }) => {
      const path = new URL(request.url).pathname;
      if (path === "/api" || path.startsWith("/api/"))
        set.headers["cache-control"] = "no-store";
    })
    .onError(({ code, status, request }) => {
      if (code === "VALIDATION" || code === "PARSE")
        return status(422, {
          code: new URL(request.url).pathname.startsWith("/api/billing/")
            ? "invalid_request"
            : "invalid_query",
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
  return app;
}
