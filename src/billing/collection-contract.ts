import { Type, type Static, type TProperties } from "@sinclair/typebox";
const object = <T extends TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
const instant = Type.Union([Type.String({ format: "date-time" }), Type.Null()]);
export const CollectionAttemptStateSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("processing"),
  Type.Literal("failed"),
  Type.Literal("requires_action"),
  Type.Literal("succeeded"),
  Type.Literal("needs_review"),
]);
export const CollectionReasonSchema = Type.Union([
  Type.Literal("declined"),
  Type.Literal("authentication_required"),
  Type.Literal("provider_unavailable"),
  Type.Literal("consent_changed"),
  Type.Literal("method_unavailable"),
  Type.Literal("resolution_conflict"),
  Type.Literal("amount_changed"),
  Type.Literal("competing_payment"),
  Type.Literal("provider_mismatch"),
  Type.Literal("uncertain_outcome"),
  Type.Literal("retry_exhausted"),
]);
const suppressReason = Type.Union([Type.Literal("paid"), Type.Literal("void")]);
const deferReason = Type.Union([
  Type.Literal("awaiting_collection"),
  Type.Literal("pending"),
  Type.Literal("processing"),
  Type.Literal("unknown"),
  Type.Literal("stale"),
  Type.Literal("provider_unavailable"),
  Type.Literal("resolution_pending"),
  Type.Literal("resolution_conflict"),
  Type.Literal("collection_review"),
  Type.Literal("not_payable"),
]);
const payableReason = Type.Union([
  Type.Literal("manual"),
  Type.Literal("before_charge"),
  Type.Literal("not_authorized"),
  Type.Literal("declined"),
  Type.Literal("requires_action"),
  Type.Literal("missed"),
]);
export const CollectionDispositionReasonSchema = Type.Union([
  ...suppressReason.anyOf,
  ...deferReason.anyOf,
  ...payableReason.anyOf,
]);
export const CollectionDispositionSchema = Type.Union([
  object({ kind: Type.Literal("suppress"), reason: suppressReason }),
  object({ kind: Type.Literal("defer"), reason: deferReason }),
  object({ kind: Type.Literal("payable"), reason: payableReason }),
]);
export const InvoiceCollectionSchema = object({
  chargeAt: instant,
  checkedAt: instant,
  disposition: CollectionDispositionSchema,
  attempt: Type.Union([
    Type.Null(),
    object({
      state: CollectionAttemptStateSchema,
      attemptedAt: Type.String({ format: "date-time" }),
      reason: Type.Union([CollectionReasonSchema, Type.Null()]),
    }),
  ]),
});
export type CollectionState = Static<typeof CollectionAttemptStateSchema>;
export type CollectionReason = Static<typeof CollectionReasonSchema>;
export type CollectionDisposition = Static<typeof CollectionDispositionSchema>;
export type InvoiceCollection = Static<typeof InvoiceCollectionSchema>;
