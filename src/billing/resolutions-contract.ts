import { Type, type Static, type TProperties } from "@sinclair/typebox";

const object = <T extends TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
const id = Type.String({ format: "uuid" });
const instant = Type.String({ format: "date-time" });
const amount = Type.Integer({ minimum: 0, maximum: 99999999 });
const reason = Type.String({ minLength: 1, maxLength: 500 });
export const ResolutionStateSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("confirmed"),
  Type.Literal("needs_review"),
  Type.Literal("withdrawn"),
]);
export const ResolutionReviewReasonSchema = Type.Union([
  Type.Literal("provider_unavailable"),
  Type.Literal("collection_conflict"),
  Type.Literal("possible_overpayment"),
  Type.Literal("amount_mismatch"),
  Type.Literal("uncertain_outcome"),
  Type.Literal("retry_exhausted"),
  Type.Literal("receipt_correction"),
  Type.Literal("provider_mismatch"),
]);
export const CollectionStateSchema = Type.Union([
  Type.Literal("idle"),
  Type.Literal("active"),
  Type.Literal("unknown"),
]);
export const ExternalPaymentRequestSchema = object({
  requestId: id,
  amountMinor: Type.Integer({ minimum: 1, maximum: 99999999 }),
  receivedDate: Type.String({ format: "date" }),
  method: Type.Union([Type.Literal("zelle"), Type.Literal("check")]),
  reference: Type.String({ minLength: 1, maxLength: 256 }),
});
export const VoidInvoiceRequestSchema = object({ requestId: id, reason });
export const ReceiptCorrectionRequestSchema = object({ requestId: id, reason });
export const ReconcileResolutionRequestSchema = object({ requestId: id });
/** Safe for a customer-scoped member read. Staff assertion and provider confirmation are separate. */
export const ResolutionSummarySchema = object({
  id,
  kind: Type.Union([Type.Literal("external_payment"), Type.Literal("void")]),
  state: ResolutionStateSchema,
  amountMinor: Type.Union([amount, Type.Null()]),
  receivedDate: Type.Union([Type.String({ format: "date" }), Type.Null()]),
  method: Type.Union([
    Type.Literal("zelle"),
    Type.Literal("check"),
    Type.Null(),
  ]),
  createdAt: instant,
  confirmedAt: Type.Union([instant, Type.Null()]),
  reviewReason: Type.Union([
    ...ResolutionReviewReasonSchema.anyOf,
    Type.Null(),
  ]),
});
export const ResolutionDetailSchema = object({
  ...ResolutionSummarySchema.properties,
  reference: Type.Union([Type.String(), Type.Null()]),
  reason: Type.Union([reason, Type.Null()]),
  attemptedAt: Type.Union([instant, Type.Null()]),
});
export const ResolutionActionResponseSchema = object({
  resolution: ResolutionSummarySchema,
});
export const ResolutionReviewResponseSchema = object({
  invoiceId: id,
  remainingMinor: Type.Union([amount, Type.Null()]),
  collectionState: CollectionStateSchema,
  lastCheckedAt: Type.Union([instant, Type.Null()]),
  actions: Type.Array(
    Type.Union([
      Type.Literal("record_external_payment"),
      Type.Literal("void"),
      Type.Literal("correct_receipt"),
      Type.Literal("reconcile"),
    ]),
  ),
  blockers: Type.Array(
    Type.Union([
      ...ResolutionReviewReasonSchema.anyOf,
      Type.Literal("not_finalized"),
      Type.Literal("terminal"),
      Type.Literal("existing_resolution"),
    ]),
  ),
  resolution: Type.Union([ResolutionDetailSchema, Type.Null()]),
  history: Type.Array(ResolutionDetailSchema, { maxItems: 100 }),
});
export type ResolutionState = Static<typeof ResolutionStateSchema>;
export type ResolutionReviewReason = Static<
  typeof ResolutionReviewReasonSchema
>;
export type ExternalPaymentRequest = Static<
  typeof ExternalPaymentRequestSchema
>;
export type VoidInvoiceRequest = Static<typeof VoidInvoiceRequestSchema>;
export type ReceiptCorrectionRequest = Static<
  typeof ReceiptCorrectionRequestSchema
>;
export type ReconcileResolutionRequest = Static<
  typeof ReconcileResolutionRequestSchema
>;
export type ResolutionSummary = Static<typeof ResolutionSummarySchema>;
export type ResolutionDetail = Static<typeof ResolutionDetailSchema>;
export type ResolutionActionResponse = Static<
  typeof ResolutionActionResponseSchema
>;
export type ResolutionReviewResponse = Static<
  typeof ResolutionReviewResponseSchema
>;
