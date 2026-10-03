import { Type, type Static, type TProperties } from "@sinclair/typebox";

const object = <T extends TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
const id = Type.String({ format: "uuid" });
const date = Type.String({ format: "date" });
const instant = Type.String({ format: "date-time" });
const label = Type.String({ minLength: 1, maxLength: 256 });
const key = Type.String({ minLength: 1, maxLength: 128 });
const amount = Type.Integer({ minimum: 1, maximum: 99999999 });

export const ProviderInvoiceStatusSchema = Type.Union([
  Type.Literal("draft"),
  Type.Literal("open"),
  Type.Literal("paid"),
  Type.Literal("void"),
  Type.Literal("uncollectible"),
]);
export const InvoiceStateSchema = Type.Union([
  Type.Literal("requested"),
  Type.Literal("preparing"),
  Type.Literal("needs_review"),
  ProviderInvoiceStatusSchema,
]);
export const ReviewReasonSchema = Type.Union([
  Type.Literal("uncertain_customer"),
  Type.Literal("uncertain_invoice"),
  Type.Literal("uncertain_line"),
  Type.Literal("ownership_mismatch"),
  Type.Literal("invoice_mismatch"),
  Type.Literal("provider_conflict"),
  Type.Literal("retry_exhausted"),
]);
export const InvoiceRequestSchema = object({
  originKey: key,
  customer: object({ key, name: label }),
  issueDate: date,
  dueDate: date,
  currency: Type.Literal("USD"),
  lines: Type.Array(
    object({
      description: label,
      amountMinor: amount,
      originRef: Type.Union([key, Type.Null()]),
    }),
    { minItems: 1, maxItems: 100 },
  ),
});
export const InvoiceSummarySchema = object({
  id,
  customer: object({ id, name: label }),
  issueDate: date,
  dueDate: date,
  readinessDate: date,
  currency: Type.Literal("USD"),
  totalMinor: Type.Integer({ minimum: 50, maximum: 99999999 }),
  state: InvoiceStateSchema,
  providerStatus: Type.Union([ProviderInvoiceStatusSchema, Type.Null()]),
  reviewReason: Type.Union([ReviewReasonSchema, Type.Null()]),
  lastCheckedAt: Type.Union([instant, Type.Null()]),
  issuedAt: Type.Union([instant, Type.Null()]),
});
export const InvoiceDetailSchema = object({
  ...InvoiceSummarySchema.properties,
  lines: Type.Array(
    object({
      id,
      position: Type.Integer({ minimum: 0, maximum: 99 }),
      description: label,
      amountMinor: amount,
      originRef: Type.Union([key, Type.Null()]),
    }),
    { minItems: 1, maxItems: 100 },
  ),
  hostedInvoiceUrl: Type.Union([
    Type.String({
      maxLength: 2048,
      pattern: "^https://invoice\\.stripe\\.com/",
    }),
    Type.Null(),
  ]),
});
export const BillingPaginationSchema = object({
  limit: Type.Integer({ minimum: 1, maximum: 100 }),
  offset: Type.Integer({ minimum: 0, maximum: 1000000 }),
});
export const InvoicesResponseSchema = object({
  invoices: Type.Array(InvoiceSummarySchema, { maxItems: 100 }),
  total: Type.Integer({ minimum: 0 }),
  ...BillingPaginationSchema.properties,
});
export const InvoiceResponseSchema = object({ invoice: InvoiceDetailSchema });
export const BillingErrorSchema = object({
  code: Type.Union([
    Type.Literal("invalid_request"),
    Type.Literal("not_found"),
    Type.Literal("unavailable"),
  ]),
});
export const WebhookResponseSchema = object({ received: Type.Literal(true) });

export type InvoiceRequest = Static<typeof InvoiceRequestSchema>;
export type InvoiceState = Static<typeof InvoiceStateSchema>;
export type ProviderInvoiceStatus = Static<typeof ProviderInvoiceStatusSchema>;
export type ReviewReason = Static<typeof ReviewReasonSchema>;
export type InvoiceDetail = Static<typeof InvoiceDetailSchema>;
export type BillingPagination = Static<typeof BillingPaginationSchema>;
export type InvoicesResponse = Static<typeof InvoicesResponseSchema>;
export type InvoiceResponse = Static<typeof InvoiceResponseSchema>;
