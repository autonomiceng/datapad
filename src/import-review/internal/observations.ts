import type { Static } from "@sinclair/typebox";
import type { DateObservationSchema, RecordType } from "../contract";

export function calendarDate(
  raw: string | null,
): Static<typeof DateObservationSchema> {
  if (raw === null) return { raw, state: "unset", value: null };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw))
    return { raw, state: "invalid", value: null };
  const [year, month, day] = raw.split("-").map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const valid =
    year > 0 && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1];
  return { raw, state: valid ? "valid" : "invalid", value: valid ? raw : null };
}
const statuses: Record<RecordType, readonly string[]> = {
  customer: ["Active", "Inactive", "Closed"],
  service: [
    "Pending",
    "Active",
    "Suspended",
    "Terminated",
    "Cancelled",
    "Fraud",
  ],
  addon: ["Pending", "Active", "Suspended", "Terminated", "Cancelled", "Fraud"],
  domain: [
    "Pending",
    "Pending Transfer",
    "Active",
    "Grace",
    "Redemption",
    "Expired",
    "Cancelled",
    "Fraud",
    "Transferred Away",
  ],
};
export function statusObservation(recordType: RecordType, raw: string | null) {
  return { raw, known: raw !== null && statuses[recordType].includes(raw) };
}
