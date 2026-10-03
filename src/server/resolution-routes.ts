import { Elysia, status, t } from "elysia";
import { accessErrorResponses, accessResponse } from "./access-response";
import type { Access } from "../access/types";
import {
  ExternalPaymentRequestSchema,
  ReceiptCorrectionRequestSchema,
  ReconcileResolutionRequestSchema,
  ResolutionActionResponseSchema,
  ResolutionReviewResponseSchema,
  VoidInvoiceRequestSchema,
} from "../billing/resolutions-contract";
import type { InvoiceResolutions } from "../billing/resolutions-types";

export interface ResolutionHttp {
  access: Pick<Access, "resolveActor">;
  resolutions?: Pick<
    InvoiceResolutions,
    | "getResolutionReview"
    | "recordExternalPayment"
    | "requestVoid"
    | "flagReceiptCorrection"
    | "reconcileResolution"
  >;
  origin: string;
}

const id = t.String({ format: "uuid" });
const params = t.Object(
  { customerId: id, invoiceId: id },
  { additionalProperties: false },
);
const empty = t.Object({}, { additionalProperties: false });
const path = "/api/customers/:customerId/invoices/:invoiceId";

export function resolutionRoutes(config?: ResolutionHttp) {
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
      `${path}/resolution-review`,
      async ({ actor, config, params }) => {
        if (!config.resolutions) return status(503, { code: "unavailable" });
        return accessResponse(
          await config.resolutions.getResolutionReview(
            actor,
            params.customerId,
            params.invoiceId,
          ),
        );
      },
      {
        params,
        query: empty,
        response: {
          200: ResolutionReviewResponseSchema,
          ...accessErrorResponses,
        },
        detail: {
          operationId: "getInvoiceResolutionReview",
          summary: "Review remaining balance and permitted invoice resolutions",
        },
      },
    )
    .post(
      `${path}/external-payment`,
      async ({ actor, config, params, body }) => {
        if (!config.resolutions) return status(503, { code: "unavailable" });
        return accessResponse(
          await config.resolutions.recordExternalPayment(
            actor,
            params.customerId,
            params.invoiceId,
            body,
          ),
        );
      },
      {
        params,
        query: empty,
        body: ExternalPaymentRequestSchema,
        parse: "json",
        beforeHandle: browserMutation,
        response: {
          200: ResolutionActionResponseSchema,
          ...accessErrorResponses,
        },
        detail: {
          operationId: "recordInvoiceExternalPayment",
          summary: "Record received funds and request provider reconciliation",
        },
      },
    )
    .post(
      `${path}/void`,
      async ({ actor, config, params, body }) => {
        if (!config.resolutions) return status(503, { code: "unavailable" });
        return accessResponse(
          await config.resolutions.requestVoid(
            actor,
            params.customerId,
            params.invoiceId,
            body,
          ),
        );
      },
      {
        params,
        query: empty,
        body: VoidInvoiceRequestSchema,
        parse: "json",
        beforeHandle: browserMutation,
        response: {
          200: ResolutionActionResponseSchema,
          ...accessErrorResponses,
        },
        detail: {
          operationId: "requestInvoiceVoid",
          summary: "Authorize voiding this unpaid invoice with a reason",
        },
      },
    )
    .post(
      `${path}/receipt-correction`,
      async ({ actor, config, params, body }) => {
        if (!config.resolutions) return status(503, { code: "unavailable" });
        return accessResponse(
          await config.resolutions.flagReceiptCorrection(
            actor,
            params.customerId,
            params.invoiceId,
            body,
          ),
        );
      },
      {
        params,
        query: empty,
        body: ReceiptCorrectionRequestSchema,
        parse: "json",
        beforeHandle: browserMutation,
        response: {
          200: ResolutionActionResponseSchema,
          ...accessErrorResponses,
        },
        detail: {
          operationId: "flagInvoiceReceiptCorrection",
          summary: "Preserve receipt facts and request their correction",
        },
      },
    )
    .post(
      `${path}/reconcile`,
      async ({ actor, config, params, body }) => {
        if (!config.resolutions) return status(503, { code: "unavailable" });
        return accessResponse(
          await config.resolutions.reconcileResolution(
            actor,
            params.customerId,
            params.invoiceId,
            body,
          ),
        );
      },
      {
        params,
        query: empty,
        body: ReconcileResolutionRequestSchema,
        parse: "json",
        beforeHandle: browserMutation,
        response: {
          200: ResolutionActionResponseSchema,
          ...accessErrorResponses,
        },
        detail: {
          operationId: "reconcileInvoiceResolution",
          summary:
            "Recheck an unattempted receipt before resuming reconciliation",
        },
      },
    );
}
