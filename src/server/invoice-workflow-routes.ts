import { Elysia, status, t } from "elysia";
import {
  accessErrorResponses,
  accessErrorStatus,
  accessResponse,
} from "./access-response";
import type { Access, AccessResult, HumanActor } from "../access/types";
import {
  ConfirmIssueResponseSchema,
  InvoicePreparationOptionsResponseSchema,
  InvoicePreparationResponseSchema,
  InvoiceResponseSchema,
  PrepareInvoiceRequestSchema,
  PrepareInvoiceResponseSchema,
  type InvoicePreparationOptionsResponse,
} from "../billing/contract";
import type { BillingWorkflow } from "../billing/types";

export interface InvoiceWorkflowHttp {
  access: Pick<Access, "resolveActor">;
  workflow?: BillingWorkflow;
  origin: string;
  readOptions(
    actor: HumanActor,
    customerId: string,
  ): Promise<AccessResult<InvoicePreparationOptionsResponse>>;
}

const id = t.String({ format: "uuid" });
const customerParams = t.Object(
  { customerId: id },
  { additionalProperties: false },
);
const invoiceParams = t.Object(
  { customerId: id, invoiceId: id },
  { additionalProperties: false },
);
const empty = t.Object({}, { additionalProperties: false });

export function invoiceWorkflowRoutes(config?: InvoiceWorkflowHttp) {
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
      "/api/customers/:customerId/invoice-options",
      async ({ actor, config, params }) => {
        const result = await config.readOptions(actor, params.customerId);
        return accessResponse(
          result.ok
            ? {
                ok: true,
                value: {
                  ...result.value,
                  available: Boolean(config.workflow) && result.value.available,
                },
              }
            : result,
        );
      },
      {
        params: customerParams,
        query: empty,
        response: {
          200: InvoicePreparationOptionsResponseSchema,
          ...accessErrorResponses,
        },
        detail: {
          operationId: "getInvoicePreparationOptions",
          summary: "Read invoice preparation choices",
        },
      },
    )
    .post(
      "/api/customers/:customerId/invoices",
      async ({ actor, config, params, body }) => {
        if (!config.workflow) return status(503, { code: "unavailable" });
        const result = await config.workflow.prepareInvoice(
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
        body: PrepareInvoiceRequestSchema,
        parse: "json",
        beforeHandle: browserMutation,
        response: {
          200: PrepareInvoiceResponseSchema,
          201: PrepareInvoiceResponseSchema,
          ...accessErrorResponses,
        },
        detail: {
          operationId: "prepareCustomerInvoice",
          summary: "Prepare an immutable invoice for review",
        },
      },
    )
    .get(
      "/api/customers/:customerId/invoices/:invoiceId/preparation",
      async ({ actor, config, params }) => {
        if (!config.workflow) return status(503, { code: "unavailable" });
        return accessResponse(
          await config.workflow.getPreparation(
            actor,
            params.customerId,
            params.invoiceId,
          ),
        );
      },
      {
        params: invoiceParams,
        query: empty,
        response: {
          200: InvoicePreparationResponseSchema,
          ...accessErrorResponses,
        },
        detail: {
          operationId: "getInvoicePreparation",
          summary: "Review a prepared customer invoice",
        },
      },
    )
    .post(
      "/api/customers/:customerId/invoices/:invoiceId/issue",
      async ({ actor, config, params }) => {
        if (!config.workflow) return status(503, { code: "unavailable" });
        const result = await config.workflow.confirmIssue(
          actor,
          params.customerId,
          params.invoiceId,
        );
        if (!result.ok)
          return status(accessErrorStatus[result.code], { code: result.code });
        return status(
          result.value.outcome === "accepted" ? 202 : 200,
          result.value,
        );
      },
      {
        params: invoiceParams,
        query: empty,
        body: empty,
        parse: "json",
        beforeHandle: browserMutation,
        response: {
          200: ConfirmIssueResponseSchema,
          202: ConfirmIssueResponseSchema,
          ...accessErrorResponses,
        },
        detail: {
          operationId: "issueCustomerInvoice",
          summary: "Authorize issuance of the reviewed invoice",
        },
      },
    )
    .post(
      "/api/customers/:customerId/invoices/:invoiceId/check",
      async ({ actor, config, params }) => {
        if (!config.workflow) return status(503, { code: "unavailable" });
        return accessResponse(
          await config.workflow.checkInvoice(
            actor,
            params.customerId,
            params.invoiceId,
          ),
        );
      },
      {
        params: invoiceParams,
        query: empty,
        body: empty,
        parse: "json",
        beforeHandle: browserMutation,
        response: { 200: InvoiceResponseSchema, ...accessErrorResponses },
        detail: {
          operationId: "checkCustomerInvoice",
          summary: "Retrieve the existing invoice status",
        },
      },
    );
}
