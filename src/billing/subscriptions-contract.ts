import { Type, type Static, type TProperties } from "@sinclair/typebox";
import { AccountPaginationSchema } from "../access/contract";
const object = <T extends TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
const id = Type.String({ format: "uuid" });
const date = Type.String({ format: "date" });
const instant = Type.Union([Type.String({ format: "date-time" }), Type.Null()]);
const label = Type.String({ minLength: 1, maxLength: 256 });
const index = Type.Integer({ minimum: 0, maximum: 120000 });
const revision = Type.Integer({ minimum: 1, maximum: 2147483647 });
const amount = Type.Integer({ minimum: 0, maximum: 99999999 });
const signedAmount = Type.Integer({ minimum: -99999999, maximum: 99999999 });
const interval = Type.Union([
  Type.Literal(1),
  Type.Literal(3),
  Type.Literal(6),
  Type.Literal(12),
  Type.Literal(24),
  Type.Literal(36),
]);
const arrangement = Type.Union([
  Type.Literal("manual"),
  Type.Literal("automatic"),
]);
const billingState = Type.Union([
  Type.Literal("billable"),
  Type.Literal("paused"),
  Type.Literal("cancelled"),
]);
export const CalendarPolicySchema = object({
  timeZone: Type.String({ minLength: 1, maxLength: 128 }),
  issueHour: Type.Integer({ minimum: 0, maximum: 23 }),
  chargeHour: Type.Integer({ minimum: 0, maximum: 23 }),
});
const anchors = {
  periodAnchorDate: date,
  dueAnchorDate: date,
  intervalMonths: interval,
};
const commercial = {
  label,
  amountMinor: amount,
  paymentArrangement: arrangement,
};
export const CreateSubscriptionRequestSchema = object({
  requestId: id,
  serviceId: Type.Union([id, Type.Null()]),
  ...anchors,
  firstUnbilledPeriodIndex: index,
  ...commercial,
});
export const ChangeSubscriptionRequestSchema = object({
  requestId: id,
  expectedVersion: revision,
  change: Type.Union([
    object({
      kind: Type.Literal("terms"),
      effectivePeriodIndex: index,
      ...commercial,
    }),
    object({
      kind: Type.Literal("pause_billing"),
      effectivePeriodIndex: index,
    }),
    object({
      kind: Type.Literal("resume_billing"),
      effectivePeriodIndex: index,
    }),
    object({ kind: Type.Literal("request_cancellation"), reason: label }),
    object({
      kind: Type.Literal("decide_cancellation"),
      decision: Type.Literal("decline"),
      reason: label,
    }),
    object({
      kind: Type.Literal("decide_cancellation"),
      decision: Type.Literal("approve"),
      reason: label,
      effectivePeriodIndex: index,
    }),
  ]),
});
const boundary = object({
  periodIndex: index,
  periodStart: date,
  periodEnd: date,
  dueDate: date,
});
const cancellation = object({
  status: Type.Union([
    Type.Literal("none"),
    Type.Literal("requested"),
    Type.Literal("declined"),
    Type.Literal("approved"),
  ]),
  reason: Type.Union([label, Type.Null()]),
  effectivePeriodIndex: Type.Union([index, Type.Null()]),
});
export const SubscriptionSummarySchema = object({
  id,
  customerId: id,
  serviceId: Type.Union([id, Type.Null()]),
  version: revision,
  ...anchors,
  firstUnbilledPeriodIndex: index,
  calendar: CalendarPolicySchema,
  label,
  amountMinor: signedAmount,
  paymentArrangement: arrangement,
  billingState,
  nextRenewal: Type.Union([date, Type.Null()]),
  cancellation,
});
const termRevision = Type.Union([
  object({
    kind: Type.Literal("commercial"),
    revision,
    effectivePeriodIndex: index,
    label,
    amountMinor: signedAmount,
    paymentArrangement: arrangement,
  }),
  object({
    kind: Type.Literal("state"),
    revision,
    effectivePeriodIndex: index,
    billingState,
  }),
]);
export const SubscriptionResponseSchema = object({
  subscription: object({
    ...SubscriptionSummarySchema.properties,
    canManage: Type.Boolean(),
    firstUnbilled: boundary,
    upcomingChanges: Type.Array(termRevision, { maxItems: 100 }),
    changesTruncated: Type.Boolean(),
  }),
});
export const SubscriptionsResponseSchema = object({
  subscriptions: Type.Array(SubscriptionSummarySchema, { maxItems: 100 }),
  total: Type.Integer({ minimum: 0 }),
  ...AccountPaginationSchema.properties,
});
export const CreateSubscriptionResponseSchema = object({
  ...SubscriptionResponseSchema.properties,
  outcome: Type.Union([Type.Literal("created"), Type.Literal("unchanged")]),
});
export const ChangeSubscriptionResponseSchema = object({
  ...SubscriptionResponseSchema.properties,
  outcome: Type.Union([Type.Literal("changed"), Type.Literal("unchanged")]),
});
export const SubscriptionBoundaryRequestSchema = object({
  ...anchors,
  fromDueDate: date,
  throughDueDate: date,
});
export const SubscriptionBoundariesResponseSchema = object({
  boundaries: Type.Array(boundary, { maxItems: 38 }),
  calendar: CalendarPolicySchema,
});
const window = { fromDueDate: date, throughDueDate: date };
export const ForecastQuerySchema = object({
  ...window,
  ...AccountPaginationSchema.properties,
});
export const MaterializeForecastRequestSchema = object({
  requestId: id,
  ...window,
});
const reviewReason = Type.Union([
  Type.Literal("not_materialized"),
  Type.Literal("negative_amount"),
  Type.Literal("unsupported_total"),
  Type.Literal("too_many_lines"),
  Type.Literal("past_due"),
  Type.Literal("invalid_local_time"),
  Type.Literal("calendar_mismatch"),
  Type.Literal("overlapping_agreement"),
]);
const period = object({
  id: Type.Union([id, Type.Null()]),
  subscriptionId: id,
  serviceId: Type.Union([id, Type.Null()]),
  ...boundary.properties,
  commercialRevision: revision,
  stateRevision: revision,
  label,
  amountMinor: signedAmount,
  paymentArrangement: arrangement,
  billingState,
  calendar: CalendarPolicySchema,
  readinessDate: date,
  issueAt: instant,
  dueEndAt: instant,
  chargeAt: instant,
  sealedAt: instant,
});
const group = object({
  dueDate: date,
  currency: Type.Literal("USD"),
  paymentArrangement: arrangement,
  totalMinor: Type.Integer({ minimum: -370000000000, maximum: 370000000000 }),
  outcome: Type.Union([
    Type.Literal("billable"),
    Type.Literal("no_charge"),
    Type.Literal("needs_review"),
    Type.Literal("inactive"),
  ]),
  reviewReasons: Type.Array(reviewReason, { maxItems: 8, uniqueItems: true }),
  periods: Type.Array(period, { maxItems: 3700 }),
});
export const ForecastResponseSchema = object({
  groups: Type.Array(group, { maxItems: 100 }),
  complete: Type.Boolean(),
  total: Type.Integer({ minimum: 0 }),
  ...window,
  ...AccountPaginationSchema.properties,
});
export const MaterializeForecastResponseSchema = object({
  ...ForecastResponseSchema.properties,
  outcome: Type.Union([Type.Literal("changed"), Type.Literal("unchanged")]),
});
export type CalendarPolicy = Static<typeof CalendarPolicySchema>;
export type CreateSubscriptionRequest = Static<
  typeof CreateSubscriptionRequestSchema
>;
export type ChangeSubscriptionRequest = Static<
  typeof ChangeSubscriptionRequestSchema
>;
export type SubscriptionSummary = Static<typeof SubscriptionSummarySchema>;
export type SubscriptionResponse = Static<typeof SubscriptionResponseSchema>;
export type SubscriptionsResponse = Static<typeof SubscriptionsResponseSchema>;
export type CreateSubscriptionResponse = Static<
  typeof CreateSubscriptionResponseSchema
>;
export type ChangeSubscriptionResponse = Static<
  typeof ChangeSubscriptionResponseSchema
>;
export type SubscriptionBoundaryRequest = Static<
  typeof SubscriptionBoundaryRequestSchema
>;
export type SubscriptionBoundariesResponse = Static<
  typeof SubscriptionBoundariesResponseSchema
>;
export type ForecastQuery = Static<typeof ForecastQuerySchema>;
export type MaterializeForecastRequest = Static<
  typeof MaterializeForecastRequestSchema
>;
export type ForecastResponse = Static<typeof ForecastResponseSchema>;
export type MaterializeForecastResponse = Static<
  typeof MaterializeForecastResponseSchema
>;

export const SubscriptionOptionsResponseSchema = object({
  cancellationReasons: Type.Array(label, { maxItems: 10, uniqueItems: true }),
  choices: Type.Array(
    object({
      serviceId: Type.Union([id, Type.Null()]),
      ...commercial,
      intervalMonths: interval,
    }),
    { maxItems: 100 },
  ),
  calendar: CalendarPolicySchema,
  periodAnchorDate: date,
  dueAnchorDate: date,
});
export type SubscriptionOptionsResponse = Static<
  typeof SubscriptionOptionsResponseSchema
>;
