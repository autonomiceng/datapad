import { Type, type Static, type TProperties } from "@sinclair/typebox";
import {
  CalendarPolicySchema,
  CreateSubscriptionRequestSchema,
} from "./subscriptions-contract";
const object = <T extends TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
const id = Type.String({ format: "uuid" });
const date = Type.String({ format: "date" });
const instant = Type.String({ format: "date-time" });
const index = Type.Integer({ minimum: 0, maximum: 120000 });
const version = Type.Integer({ minimum: 0, maximum: 2147483647 });
const revision = Type.Integer({ minimum: 1, maximum: 2147483647 });
const nullableId = Type.Union([id, Type.Null()]);
export const SAVE_TERMS_VERSION = "save-card-v1";
export const SAVE_TERMS_TEXT =
  "Save this card with the payment provider for future use. Saving does not authorize automatic payments.";
export const ENROLLMENT_TERMS_VERSION = "automatic-payments-v1";
export const ENROLLMENT_TERMS_TEXT =
  "Authorize one automatic payment attempt for each eligible invoice covering only the selected agreements and effective periods, using their scheduled prices and frequency. Changes to commercial terms require renewed consent. You can stop new attempts at any time; an attempt already started may finish. Changing this authorization requires customer payment for invoices already sealed under the previous authorization.";
const scope = object({
  subscriptionId: id,
  commercialRevision: revision,
  fromPeriodIndex: index,
  untilPeriodIndex: Type.Union([index, Type.Null()]),
  periodStart: date,
  dueDate: date,
  calendar: CalendarPolicySchema,
});
const retainedScope = object({
  ...scope.properties,
  label: Type.String({ minLength: 1, maxLength: 256 }),
  amountMinor: Type.Integer({ minimum: 0, maximum: 99999999 }),
  currency: Type.Literal("USD"),
  intervalMonths: CreateSubscriptionRequestSchema.properties.intervalMonths,
  untilPeriodStart: Type.Union([date, Type.Null()]),
});
export const SavedPaymentMethodSchema = object({
  id,
  brand: Type.String({ minLength: 1, maxLength: 32 }),
  last4: Type.String({ pattern: "^[0-9]{4}$" }),
  expiryMonth: Type.Integer({ minimum: 1, maximum: 12 }),
  expiryYear: Type.Integer({ minimum: 2000, maximum: 9999 }),
  verifiedAt: instant,
  usable: Type.Boolean(),
});
export const EnrollmentSchema = object({
  id,
  version: revision,
  predecessorId: nullableId,
  decision: Type.Union([Type.Literal("authorize"), Type.Literal("reduce")]),
  paymentMethodId: nullableId,
  acceptedAt: instant,
  termsVersion: Type.String({ minLength: 1, maxLength: 64 }),
  scopes: Type.Array(scope, { maxItems: 100 }),
});
const setupStatus = Type.Union([
  Type.Literal("pending"),
  Type.Literal("verified"),
  Type.Literal("expired"),
  Type.Literal("needs_review"),
]);
export const PaymentSetupResponseSchema = object({
  setupId: id,
  status: setupStatus,
  paymentMethodId: nullableId,
  checkoutUrl: Type.Union([
    Type.String({
      maxLength: 4096,
      pattern: "^https://checkout\\.stripe\\.com/",
    }),
    Type.Null(),
  ]),
});
export const StartPaymentSetupRequestSchema = object({
  requestId: id,
  saveTermsVersion: Type.Literal(SAVE_TERMS_VERSION),
  acceptSaveTerms: Type.Literal(true),
});
export const RefreshPaymentSetupRequestSchema = object({});
const selection = object({
  subscriptionId: id,
  expectedSubscriptionVersion: revision,
  fromPeriodIndex: index,
});
export const ReplaceEnrollmentRequestSchema = object({
  requestId: id,
  expectedVersion: version,
  paymentMethodId: id,
  termsVersion: Type.Literal(ENROLLMENT_TERMS_VERSION),
  acceptTerms: Type.Literal(true),
  selections: Type.Array(selection, { minItems: 1, maxItems: 100 }),
});
export const ReduceEnrollmentRequestSchema = object({
  requestId: id,
  expectedVersion: revision,
  retainSubscriptionIds: Type.Array(id, { maxItems: 100, uniqueItems: true }),
});
export const ChangeEnrollmentResponseSchema = object({
  outcome: Type.Union([Type.Literal("changed"), Type.Literal("unchanged")]),
  enrollment: EnrollmentSchema,
});
const boundary = object({
  fromPeriodIndex: index,
  untilPeriodStart: Type.Union([date, Type.Null()]),
  periodStart: date,
  dueDate: date,
  commercialRevision: revision,
  untilPeriodIndex: Type.Union([index, Type.Null()]),
  label: Type.String({ minLength: 1, maxLength: 256 }),
  amountMinor: Type.Integer({ minimum: -99999999, maximum: 99999999 }),
  paymentArrangement: Type.Union([
    Type.Literal("manual"),
    Type.Literal("automatic"),
  ]),
});
export const PaymentSettingsResponseSchema = object({
  canManage: Type.Boolean(),
  setupAvailable: Type.Boolean(),
  saveTerms: object({
    version: Type.Literal(SAVE_TERMS_VERSION),
    text: Type.Literal(SAVE_TERMS_TEXT),
  }),
  enrollmentTerms: object({
    version: Type.Literal(ENROLLMENT_TERMS_VERSION),
    text: Type.Literal(ENROLLMENT_TERMS_TEXT),
  }),
  methods: Type.Array(SavedPaymentMethodSchema),
  enrollment: Type.Union([EnrollmentSchema, Type.Null()]),
  consentAdministratorOrigin: Type.Union([
    Type.Literal("staff_invited"),
    Type.Literal("customer_invited"),
    Type.Literal("unknown"),
    Type.Null(),
  ]),
  subscriptions: Type.Array(
    object({
      id,
      label: Type.String({ minLength: 1, maxLength: 256 }),
      version: revision,
      calendar: CalendarPolicySchema,
      intervalMonths: Type.Integer({ minimum: 1, maximum: 36 }),
      retainedScope: Type.Union([retainedScope, Type.Null()]),
      boundaries: Type.Array(boundary, { maxItems: 38 }),
      blocker: Type.Union([Type.Literal("no_future_boundary"), Type.Null()]),
    }),
    { maxItems: 100 },
  ),
  affectedInvoices: Type.Array(
    object({
      invoiceId: id,
      groupId: id,
      dueDate: date,
      totalMinor: Type.Integer({ minimum: 50, maximum: 99999999 }),
    }),
  ),
});
export type StartPaymentSetupRequest = Static<
  typeof StartPaymentSetupRequestSchema
>;
export type PaymentSetupResponse = Static<typeof PaymentSetupResponseSchema>;
export type ReplaceEnrollmentRequest = Static<
  typeof ReplaceEnrollmentRequestSchema
>;
export type ReduceEnrollmentRequest = Static<
  typeof ReduceEnrollmentRequestSchema
>;
export type ChangeEnrollmentResponse = Static<
  typeof ChangeEnrollmentResponseSchema
>;
export type PaymentSettingsResponse = Static<
  typeof PaymentSettingsResponseSchema
>;
export type Enrollment = Static<typeof EnrollmentSchema>;
export type EnrollmentScope = Static<typeof scope>;
