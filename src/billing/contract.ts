import { Type, type Static, type TProperties } from "@sinclair/typebox";
import { CalendarPolicySchema } from "./subscriptions-contract";

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
  providerStatus: Type.Union([
    ...ProviderInvoiceStatusSchema.anyOf,
    Type.Null(),
  ]),
  reviewReason: Type.Union([...ReviewReasonSchema.anyOf, Type.Null()]),
  lastCheckedAt: Type.Union([instant, Type.Null()]),
  issuedAt: Type.Union([instant, Type.Null()]),
});
export const ProviderReceiptStateSchema = Type.Union([
  Type.Literal("unverified"),
  Type.Literal("verified"),
  Type.Literal("mismatch"),
]);
export const InvoiceDetailSchema = object({
  calendar: Type.Union([CalendarPolicySchema, Type.Null()]),
  providerReceipt: object({
    state: ProviderReceiptStateSchema,
    reason: Type.Union([...ReviewReasonSchema.anyOf, Type.Null()]),
  }),
  ...InvoiceSummarySchema.properties,
  billTo: object({
    legalName: label,
    billingEmail: Type.Union([
      Type.String({ format: "email", maxLength: 254 }),
      Type.Null(),
    ]),
    profileVersion: Type.Integer({ minimum: 1, maximum: 2147483647 }),
  }),
  lines: Type.Array(
    object({
      id,
      position: Type.Integer({ minimum: 0, maximum: 99 }),
      description: label,
      amountMinor: Type.Integer({ minimum: 0, maximum: 99999999 }),
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

export const PrepareInvoiceRequestSchema = object({
  requestId: id,
  expectedCustomerVersion: Type.Integer({ minimum: 1, maximum: 2147483647 }),
  dueDate: date,
  currency: Type.Literal("USD"),
  lines: Type.Array(object({ description: label, amountMinor: amount }), {
    minItems: 1,
    maxItems: 100,
  }),
});
export const InvoicePreparationResponseSchema = object({
  ...InvoiceResponseSchema.properties,
  issueBlocker: Type.Union([
    Type.Null(),
    Type.Literal("past_due"),
    Type.Literal("provider_profile_pending"),
    Type.Literal("needs_review"),
    Type.Literal("already_issued"),
  ]),
});
export const PrepareInvoiceResponseSchema = object({
  ...InvoicePreparationResponseSchema.properties,
  outcome: Type.Union([Type.Literal("created"), Type.Literal("unchanged")]),
});
export const ConfirmIssueResponseSchema = object({
  outcome: Type.Union([Type.Literal("accepted"), Type.Literal("unchanged")]),
  invoiceId: id,
});
export type ProviderReceiptState = Static<typeof ProviderReceiptStateSchema>;
export type PrepareInvoiceRequest = Static<typeof PrepareInvoiceRequestSchema>;
export type InvoicePreparationResponse = Static<
  typeof InvoicePreparationResponseSchema
>;
export type PrepareInvoiceResponse = Static<
  typeof PrepareInvoiceResponseSchema
>;
export type ConfirmIssueResponse = Static<typeof ConfirmIssueResponseSchema>;
export const InvoicePreparationOptionsResponseSchema = object({
  available: Type.Boolean(),
  lines: Type.Array(object({ description: label, amountMinor: amount }), {
    maxItems: 100,
  }),
  issueDate: date,
  dueDate: date,
});
export type InvoicePreparationOptionsResponse = Static<
  typeof InvoicePreparationOptionsResponseSchema
>;
