import { Type, type Static, type TProperties } from "@sinclair/typebox";
import { AccountPaginationSchema } from "../access/contract";
import { InvoiceDetailSchema, InvoiceSummarySchema } from "./contract";
import {
  CalendarPolicySchema,
  ForecastResponseSchema,
  SubscriptionBoundariesResponseSchema,
} from "./subscriptions-contract";

const object = <T extends TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
const id = Type.String({ format: "uuid" });
const date = Type.String({ format: "date" });
const instant = Type.String({ format: "date-time" });
const periodIndex = Type.Integer({ minimum: 0, maximum: 120000 });
const version = Type.Integer({ minimum: 1, maximum: 2147483647 });
const boundary =
  SubscriptionBoundariesResponseSchema.properties.boundaries.items;
const period =
  ForecastResponseSchema.properties.groups.items.properties.periods.items;
const arrangement = Type.Union([
  Type.Literal("manual"),
  Type.Literal("automatic"),
]);

export const ConfigureScheduleRequestSchema = object({
  requestId: id,
  expectedVersion: Type.Integer({ minimum: 0, maximum: 2147483647 }),
  change: Type.Union([
    object({
      kind: Type.Literal("activate"),
      subscriptions: Type.Array(
        object({
          subscriptionId: id,
          expectedVersion: version,
          activationFromPeriodIndex: periodIndex,
        }),
        { minItems: 1, maxItems: 100 },
      ),
    }),
    object({ kind: Type.Literal("pause_issuance") }),
    object({ kind: Type.Literal("resume_issuance") }),
  ]),
});
export const ScheduleResponseSchema = object({
  schedule: object({
    customerId: id,
    version: Type.Integer({ minimum: 0, maximum: 2147483647 }),
    issuancePaused: Type.Boolean(),
    canManage: Type.Boolean(),
    activations: Type.Array(
      object({
        subscriptionId: id,
        activationFromPeriodIndex: periodIndex,
        firstPeriod: boundary,
        activatedAt: instant,
        beforeActivation: Type.Union([
          object({
            fromPeriodIndex: periodIndex,
            throughPeriodIndex: periodIndex,
            periodStart: date,
            periodEnd: date,
            fromDueDate: date,
            throughDueDate: date,
          }),
          Type.Null(),
        ]),
      }),
      { maxItems: 100 },
    ),
    continuing: Type.Array(
      object({
        invoiceId: id,
        customerCreateAttempted: Type.Boolean(),
        invoiceCreateAttempted: Type.Boolean(),
        finalizeAttempted: Type.Boolean(),
      }),
      { maxItems: 100 },
    ),
    continuingTotal: Type.Integer({ minimum: 0 }),
  }),
});
export const ConfigureScheduleResponseSchema = object({
  ...ScheduleResponseSchema.properties,
  outcome: Type.Union([Type.Literal("changed"), Type.Literal("unchanged")]),
});
export const ScheduledGroupsQuerySchema = object({
  fromDueDate: date,
  throughDueDate: date,
  ...AccountPaginationSchema.properties,
});
export const ScheduleReviewReasonSchema = Type.Union([
  Type.Literal("negative_amount"),
  Type.Literal("unsupported_total"),
  Type.Literal("too_many_lines"),
  Type.Literal("past_due"),
  Type.Literal("invalid_local_time"),
  Type.Literal("calendar_mismatch"),
  Type.Literal("overlapping_agreement"),
  Type.Literal("provider_profile_pending"),
  Type.Literal("ownership_mismatch"),
  Type.Literal("issuance_paused"),
  Type.Literal("late_period"),
  Type.Literal("multiple_candidates"),
]);
export const ScheduledGroupSchema = object({
  id: Type.Union([id, Type.Null()]),
  dueDate: date,
  currency: Type.Literal("USD"),
  paymentArrangement: arrangement,
  kind: Type.Union([
    Type.Literal("sealed"),
    Type.Literal("upcoming"),
    Type.Literal("excluded"),
    Type.Literal("review"),
    Type.Literal("missed"),
    Type.Literal("late"),
  ]),
  outcome: Type.Union([
    Type.Literal("invoice_requested"),
    Type.Literal("no_charge"),
    Type.Null(),
  ]),
  totalMinor: Type.Integer({ minimum: -9999999900, maximum: 9999999900 }),
  calendar: CalendarPolicySchema,
  issueAt: Type.Union([instant, Type.Null()]),
  dueEndAt: Type.Union([instant, Type.Null()]),
  sealedAt: Type.Union([instant, Type.Null()]),
  billTo: Type.Union([InvoiceDetailSchema.properties.billTo, Type.Null()]),
  invoice: Type.Union([InvoiceSummarySchema, Type.Null()]),
  reviewReasons: Type.Array(ScheduleReviewReasonSchema, {
    maxItems: 12,
    uniqueItems: true,
  }),
  periods: Type.Array(period, { maxItems: 100 }),
});
export const ScheduledGroupsResponseSchema = object({
  groups: Type.Array(ScheduledGroupSchema, { maxItems: 100 }),
  total: Type.Integer({ minimum: 0 }),
  ...ScheduledGroupsQuerySchema.properties,
});
export type ConfigureScheduleRequest = Static<
  typeof ConfigureScheduleRequestSchema
>;
export type ScheduleResponse = Static<typeof ScheduleResponseSchema>;
export type ConfigureScheduleResponse = Static<
  typeof ConfigureScheduleResponseSchema
>;
export type ScheduledGroupsQuery = Static<typeof ScheduledGroupsQuerySchema>;
export type ScheduleReviewReason = Static<typeof ScheduleReviewReasonSchema>;
export type ScheduledGroup = Static<typeof ScheduledGroupSchema>;
export type ScheduledGroupsResponse = Static<
  typeof ScheduledGroupsResponseSchema
>;
