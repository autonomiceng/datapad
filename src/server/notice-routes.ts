import { Elysia, status } from "elysia";
import type { Access } from "../access/types";
import type { InvoiceNotices } from "../notifications/types";
import {
  InvoiceNoticeParamsSchema,
  InvoiceNoticeQuerySchema,
  InvoiceNoticesResponseSchema,
} from "../notifications/contract";
import { accessErrorResponses, accessResponse } from "./access-response";

export interface NoticeHttp {
  access: Pick<Access, "resolveActor">;
  notices?: Pick<InvoiceNotices, "getInvoiceNotices">;
}

/** Registers read-only, no-store notice detail; the injected reader requires current scoped staff manage_billing before exposing content. */
export function noticeRoutes(config?: NoticeHttp) {
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
      "/api/customers/:customerId/invoices/:invoiceId/notices",
      async ({ actor, config, params }) => {
        if (!config.notices) return status(503, { code: "unavailable" });
        return accessResponse(
          await config.notices.getInvoiceNotices(
            actor,
            params.customerId,
            params.invoiceId,
          ),
        );
      },
      {
        params: InvoiceNoticeParamsSchema,
        query: InvoiceNoticeQuerySchema,
        response: {
          200: InvoiceNoticesResponseSchema,
          ...accessErrorResponses,
        },
        detail: {
          operationId: "getInvoiceNotices",
          summary: "Inspect invoice notices and saved message content",
        },
      },
    );
}
