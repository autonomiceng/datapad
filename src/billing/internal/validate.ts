import { createHash } from "node:crypto";
import canonicalize from "canonicalize";
import { Temporal } from "@js-temporal/polyfill";
import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { InvoiceRequestSchema, type InvoiceRequest } from "../contract";

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
export function validateRequest(input: unknown): InvoiceRequest | null {
  if (!Value.Check(InvoiceRequestSchema, input)) return null;
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
    return null;
  const total = input.lines.reduce((sum, line) => sum + line.amountMinor, 0);
  if (
    total < 50 ||
    total > 99999999 ||
    input.issueDate < readinessDate(input.dueDate) ||
    input.issueDate >= input.dueDate
  )
    return null;
  return structuredClone(input);
}
export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value,
  );
}
