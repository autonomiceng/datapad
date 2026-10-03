import { Type, type Static, type TProperties } from "@sinclair/typebox";
import { CollectionDispositionReasonSchema } from "../billing/collection-contract";
const object = <T extends TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
const nullable = <T extends ReturnType<typeof Type.String>>(schema: T) =>
  Type.Union([schema, Type.Null()]);
const id = Type.String({ format: "uuid" });
const instant = nullable(Type.String({ format: "date-time" }));
export const NoticeStageSchema = Type.Union([
  Type.Literal("invoice"),
  Type.Literal("before_due"),
  Type.Literal("due"),
  Type.Literal("overdue"),
]);
export const NoticeStateSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("sending"),
  Type.Literal("accepted"),
  Type.Literal("suppressed"),
  Type.Literal("needs_review"),
]);
export const NoticeReasonSchema = Type.Union([
  ...CollectionDispositionReasonSchema.anyOf,
  Type.Literal("calendar_invalid"),
  Type.Literal("billing_contact_missing"),
  Type.Literal("billing_contact_changed"),
  Type.Literal("recipient_not_allowed"),
  Type.Literal("initial_notice_pending"),
  Type.Literal("initial_notice_needs_review"),
  Type.Literal("obsolete_after_delay"),
  Type.Literal("obsolete"),
  Type.Literal("uncertain_delivery"),
  Type.Literal("evidence_expired_before_send"),
  Type.Literal("smtp_transient"),
  Type.Literal("smtp_rejected"),
  Type.Literal("retry_exhausted"),
  Type.Literal("content_changed"),
]);
export const NoticePreviewSchema = object({
  subject: Type.String({
    minLength: 1,
    maxLength: 200,
    pattern: "^[^\\r\\n]*$",
  }),
  text: Type.String({ maxLength: 32768 }),
  html: Type.String({ maxLength: 65536 }),
});
export const InvoiceNoticeParamsSchema = object({
  customerId: id,
  invoiceId: id,
});
export const InvoiceNoticeQuerySchema = object({});
export const InvoiceNoticesResponseSchema = object({
  invoiceId: id,
  notices: Type.Array(
    object({
      id,
      stage: NoticeStageSchema,
      state: NoticeStateSchema,
      reason: Type.Union([NoticeReasonSchema, Type.Null()]),
      calendar: object({
        timeZone: Type.String({ minLength: 1, maxLength: 100 }),
        hour: Type.Integer({ minimum: 0, maximum: 23 }),
      }),
      scheduledAt: instant,
      attempts: Type.Integer({ minimum: 0, maximum: 3 }),
      nextAttemptAt: instant,
      attemptedAt: instant,
      acceptedAt: instant,
      recipient: nullable(Type.String({ format: "email", maxLength: 254 })),
      profileVersion: Type.Union([
        Type.Integer({ minimum: 1, maximum: 2147483647 }),
        Type.Null(),
      ]),
      preview: Type.Union([NoticePreviewSchema, Type.Null()]),
      previewKind: Type.Union([Type.Literal("stamped"), Type.Null()]),
      messageId: nullable(Type.String({ minLength: 1, maxLength: 254 })),
    }),
    { maxItems: 4 },
  ),
});
export type NoticeStage = Static<typeof NoticeStageSchema>;
export type NoticeState = Static<typeof NoticeStateSchema>;
export type NoticeReason = Static<typeof NoticeReasonSchema>;
export type NoticePreview = Static<typeof NoticePreviewSchema>;
export type InvoiceNoticesResponse = Static<
  typeof InvoiceNoticesResponseSchema
>;
