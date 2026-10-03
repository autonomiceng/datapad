import { createHash } from "node:crypto";
import canonicalize from "canonicalize";
import { Temporal } from "@js-temporal/polyfill";
import { Type, FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { InvoiceRequestSchema, type InvoiceRequest } from "../contract";
import { CalendarPolicySchema } from "../subscriptions-contract";
import type { ScheduledInvoiceRequest } from "../scheduled-types";
import { periodInstants, validateCalendar } from "./calendar";

function calendarDate(value: string): boolean {
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value) || value.startsWith("0000"))
    return false;
  try {
    return Temporal.PlainDate.from(value).toString() === value;
  } catch {
    return false;
  }
}
FormatRegistry.Set("date", calendarDate);
FormatRegistry.Set("uuid", isUuid);

export function requestDigest(request: InvoiceRequest): string {
  return createHash("sha256").update(canonicalize(request)!).digest("hex");
}
export function readinessDate(dueDate: string): string {
  return Temporal.PlainDate.from(dueDate).subtract({ days: 21 }).toString();
}
function validValues(input: InvoiceRequest, allowNoCharge = false): boolean {
  const strings = [
    input.originKey,
    input.customer.key,
    input.customer.name,
    ...input.lines.flatMap((line) => [
      line.description,
      ...(line.originRef === null ? [] : [line.originRef]),
    ]),
  ];
  if (
    strings.some(
      (value) =>
        !value.trim() || value.includes("\0") || /[\uD800-\uDFFF]/u.test(value),
    )
  )
    return false;
  const total = input.lines.reduce((sum, line) => sum + line.amountMinor, 0);
  if (
    (total < 50 && !(allowNoCharge && total === 0)) ||
    total > 99999999 ||
    input.issueDate < readinessDate(input.dueDate) ||
    input.issueDate >= input.dueDate
  )
    return false;
  return true;
}
export function validateRequest(input: unknown): InvoiceRequest | null {
  return Value.Check(InvoiceRequestSchema, input) && validValues(input)
    ? structuredClone(input)
    : null;
}
const scheduledRequestSchema = Type.Object(
  {
    ...InvoiceRequestSchema.properties,
    lines: Type.Array(
      Type.Object(
        {
          ...InvoiceRequestSchema.properties.lines.items.properties,
          amountMinor: Type.Integer({ minimum: 0, maximum: 99999999 }),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 100 },
    ),
    calendar: CalendarPolicySchema,
    issueNotBefore: Type.String(),
    firstAttemptBefore: Type.String(),
    dueEndAt: Type.String(),
  },
  { additionalProperties: false },
);
export function validateScheduledRequest(
  input: unknown,
  allowNoCharge = false,
): ScheduledInvoiceRequest | null {
  if (
    !Value.Check(scheduledRequestSchema, input) ||
    !validValues(input, allowNoCharge)
  )
    return null;
  try {
    validateCalendar(input.calendar);
    const expected = periodInstants(input.dueDate, input.calendar);
    if (
      !expected.issueAt ||
      !expected.dueEndAt ||
      !expected.chargeAt ||
      input.issueDate !== expected.readinessDate ||
      input.issueNotBefore !== new Date(expected.issueAt).toISOString() ||
      input.firstAttemptBefore !== new Date(expected.dueEndAt).toISOString() ||
      input.dueEndAt !== input.firstAttemptBefore
    )
      return null;
    return structuredClone(input);
  } catch {
    return null;
  }
}
export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value,
  );
}
