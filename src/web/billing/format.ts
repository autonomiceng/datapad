import type { InvoiceState } from "../../billing/contract";

export const invoiceStateLabels: Record<InvoiceState, string> = {
  requested: "Requested",
  preparing: "Preparing",
  needs_review: "Needs review",
  draft: "Draft",
  open: "Unpaid",
  paid: "Paid",
  void: "Void",
  uncollectible: "Uncollectible",
};
export const money = (amountMinor: number, currency: string) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency }).format(
    amountMinor / 100,
  );
export const date = (value: string) =>
  new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${value}T00:00:00Z`));
export const dateRange = (start: string, end: string) =>
  start.slice(0, 4) === end.slice(0, 4)
    ? `${date(start).replace(/, \d{4}$/, "")} to ${date(end)}`
    : `${date(start)} to ${date(end)}`;
export const instant = (value: string) =>
  new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(value));
