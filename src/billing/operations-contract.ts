import { Type, type Static, type TProperties } from "@sinclair/typebox";
const object = <T extends TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
const id = Type.String({ format: "uuid" });
const instant = Type.Union([Type.String({ format: "date-time" }), Type.Null()]);
export const BillingEffectKindSchema = Type.Union([
  Type.Literal("customer"),
  Type.Literal("invoice"),
  Type.Literal("line"),
  Type.Literal("finalize"),
  Type.Literal("setup"),
  Type.Literal("resolution"),
  Type.Literal("collection"),
  Type.Literal("notice"),
]);
export const BillingEffectScopeSchema = object({
  kind: BillingEffectKindSchema,
  customerId: id,
  effectId: id,
});
export const EffectsControlSchema = object({
  paused: Type.Boolean(),
  version: Type.Integer({ minimum: 0 }),
  updatedAt: instant,
});
export const SetEffectsPausedRequestSchema = object({
  requestId: id,
  expectedVersion: Type.Integer({ minimum: 0 }),
  paused: Type.Boolean(),
  reason: Type.String({ minLength: 1, maxLength: 500 }),
});
export const SetEffectsPausedResponseSchema = object({
  control: EffectsControlSchema,
  outcome: Type.Union([Type.Literal("changed"), Type.Literal("unchanged")]),
});
export const CheckEffectStatusRequestSchema = object({
  requestId: id,
  effect: BillingEffectScopeSchema,
});
export const CheckEffectStatusResponseSchema = object({
  outcome: Type.Union([
    Type.Literal("complete"),
    Type.Literal("retry"),
    Type.Literal("needs_review"),
    Type.Literal("unavailable"),
    Type.Literal("pending"),
  ]),
});
export const BillingOperationSchema = object({
  effect: BillingEffectScopeSchema,
  customerLabel: Type.String(),
  label: Type.String(),
  invoiceId: Type.Union([id, Type.Null()]),
  state: Type.Union([
    Type.Literal("pending"),
    Type.Literal("stalled"),
    Type.Literal("needs_review"),
  ]),
  reason: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.String({ format: "date-time" }),
  attemptedAt: instant,
  lastCheckedAt: instant,
  nextEligibleAt: instant,
  canCheckStatus: Type.Boolean(),
});
export const BillingOperationsResponseSchema = object({
  control: EffectsControlSchema,
  operations: Type.Array(BillingOperationSchema, { maxItems: 100 }),
});
export type BillingEffectScope = Static<typeof BillingEffectScopeSchema>;
export type EffectsControl = Static<typeof EffectsControlSchema>;
export type SetEffectsPausedRequest = Static<
  typeof SetEffectsPausedRequestSchema
>;
export type SetEffectsPausedResponse = Static<
  typeof SetEffectsPausedResponseSchema
>;
export type CheckEffectStatusRequest = Static<
  typeof CheckEffectStatusRequestSchema
>;
export type CheckEffectStatusResponse = Static<
  typeof CheckEffectStatusResponseSchema
>;
export type BillingOperation = Static<typeof BillingOperationSchema>;
export type BillingOperationsResponse = Static<
  typeof BillingOperationsResponseSchema
>;
