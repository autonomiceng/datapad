import { Elysia, t } from "elysia";
import {
  BillingErrorSchema,
  InvoiceResponseSchema,
  InvoicesResponseSchema,
  WebhookResponseSchema,
} from "../billing/contract";
import type { BillingCommands, BillingReader } from "../billing/types";
import type {
  BillingEventVerifier,
  VerifiedPaymentSetupEvent,
} from "../billing/provider";
import { AccessErrorSchema } from "../access/contract";
import type { AccessResult } from "../access/types";

export interface BillingHttp {
  reader: Pick<BillingReader, "listInvoices" | "getInvoice">;
  authorizeRead?: (
    headers: Headers,
  ) => Promise<
    AccessResult<Pick<BillingReader, "listInvoices" | "getInvoice">>
  >;
  webhook?: {
    verifier: BillingEventVerifier;
    acceptEvent: BillingCommands["acceptEvent"];
    acceptSetupEvent?: (event: VerifiedPaymentSetupEvent) => Promise<void>;
  };
}

const maxBodyBytes = 1024 * 1024;
async function rawBody(request: Request): Promise<string | null> {
  if (Number(request.headers.get("content-length")) > maxBodyBytes) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return text + decoder.decode();
      bytes += value.byteLength;
      if (bytes > maxBodyBytes) {
        await reader.cancel();
        return null;
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

export function billingRoutes(billing?: BillingHttp) {
  return new Elysia({ normalize: false })
    .get(
      "/api/billing/invoices",
      async ({ query, request, status }) => {
        if (!billing) return status(503, { code: "unavailable" });
        const authorized = billing.authorizeRead
          ? await billing.authorizeRead(request.headers)
          : { ok: true as const, value: billing.reader };
        if (!authorized.ok) {
          if (authorized.code === "unauthenticated")
            return status(401, { code: "unauthenticated" });
          if (authorized.code === "forbidden")
            return status(403, { code: "forbidden" });
          return status(503, { code: "unavailable" });
        }
        return authorized.value.listInvoices(query);
      },
      {
        query: t.Object(
          {
            limit: t.Optional(
              t.Integer({ minimum: 1, maximum: 100, default: 50 }),
            ),
            offset: t.Optional(
              t.Integer({ minimum: 0, maximum: 1000000, default: 0 }),
            ),
          },
          { additionalProperties: false },
        ),
        response: {
          200: InvoicesResponseSchema,
          401: AccessErrorSchema,
          403: AccessErrorSchema,
          422: BillingErrorSchema,
          503: BillingErrorSchema,
        },
        detail: { operationId: "listInvoices", summary: "List invoices" },
      },
    )
    .get(
      "/api/billing/invoices/:invoiceId",
      async ({ params, request, status }) => {
        if (!billing) return status(503, { code: "unavailable" });
        const authorized = billing.authorizeRead
          ? await billing.authorizeRead(request.headers)
          : { ok: true as const, value: billing.reader };
        if (!authorized.ok) {
          if (authorized.code === "unauthenticated")
            return status(401, { code: "unauthenticated" });
          if (authorized.code === "forbidden")
            return status(403, { code: "forbidden" });
          return status(503, { code: "unavailable" });
        }
        const result = await authorized.value.getInvoice(params.invoiceId);
        return result ?? status(404, { code: "not_found" });
      },
      {
        params: t.Object({ invoiceId: t.String({ format: "uuid" }) }),
        response: {
          200: InvoiceResponseSchema,
          401: AccessErrorSchema,
          403: AccessErrorSchema,
          404: BillingErrorSchema,
          422: BillingErrorSchema,
          503: BillingErrorSchema,
        },
        detail: { operationId: "getInvoice", summary: "Read an invoice" },
      },
    )
    .post(
      "/api/billing/webhooks/stripe",
      async ({ request, status }) => {
        if (!billing?.webhook) return status(503, { code: "unavailable" });
        let body: string | null;
        try {
          body = await rawBody(request);
        } catch {
          return status(400, { code: "invalid_request" });
        }
        if (body === null) return status(413, { code: "invalid_request" });
        const signature = request.headers.get("stripe-signature");
        if (!signature) return status(400, { code: "invalid_request" });
        let event;
        try {
          event = await billing.webhook.verifier.verifyEvent(body, signature);
        } catch {
          return status(400, { code: "invalid_request" });
        }
        // Commit the inbox before acknowledging. The worker sweeps durable pending work.
        if (event) {
          if ("providerSessionId" in event)
            await billing.webhook.acceptSetupEvent?.(event);
          else await billing.webhook.acceptEvent(event);
        }
        return { received: true as const };
      },
      {
        parse: "none",
        response: {
          200: WebhookResponseSchema,
          400: BillingErrorSchema,
          413: BillingErrorSchema,
          503: BillingErrorSchema,
        },
        detail: {
          operationId: "receiveStripeBillingEvent",
          summary: "Receive a signed Stripe sandbox billing event",
          parameters: [
            {
              in: "header",
              name: "Stripe-Signature",
              required: true,
              schema: { type: "string" },
            },
          ],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { type: "object" } } },
          },
        },
      },
    );
}
