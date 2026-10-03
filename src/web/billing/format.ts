import type { InvoiceState } from "../../billing/contract";
import type {
  InvoiceCollection,
  CollectionReason,
  CollectionState,
} from "../../billing/collection-contract";

const collectionLabels: Record<CollectionState, string> = {
  pending: "Pending",
  processing: "Processing",
  failed: "Declined",
  requires_action: "Customer action required",
  succeeded: "Paid",
  needs_review: "Staff review",
};
const collectionReasons: Record<CollectionReason, string> = {
  declined: "The automatic payment was declined.",
  authentication_required:
    "Complete the payment verification on the hosted invoice.",
  provider_unavailable:
    "Payment status could not be confirmed. Please check again later.",
  consent_changed:
    "Automatic payment permission changed. Staff need to review this invoice.",
  method_unavailable:
    "The saved payment method could not be used. Staff need to review this invoice.",
  resolution_conflict: "Another payment or invoice change needs staff review.",
  amount_changed:
    "The amount remaining changed. Staff need to review this invoice.",
  competing_payment: "Another payment needs staff review.",
  provider_mismatch:
    "Payment details could not be verified. Staff need to review this invoice.",
  uncertain_outcome:
    "The payment outcome could not be confirmed. Staff need to review this invoice.",
  retry_exhausted:
    "Payment status could not be confirmed after repeated checks. Staff need to review this invoice.",
};

/** Presentation only; the server disposition decides whether payment is allowed. */
export function collectionDisplay(collection: InvoiceCollection) {
  const { attempt, disposition } = collection;
  let label = attempt ? collectionLabels[attempt.state] : null;
  let note = attempt?.reason ? collectionReasons[attempt.reason] : null;
  let review = attempt?.state === "needs_review";
  if (disposition.kind === "payable") {
    if (disposition.reason === "missed") {
      label = "Staff review";
      note = "Automatic payment was not attempted. Payment is needed.";
      review = true;
    } else if (disposition.reason === "before_charge" && !attempt) {
      label = "Pending";
      note = "You can pay before the scheduled automatic payment.";
    }
  } else if (disposition.kind === "defer") {
    if (
      ["awaiting_collection", "pending", "processing"].includes(
        disposition.reason,
      )
    ) {
      label ??= disposition.reason === "processing" ? "Processing" : "Pending";
      note ??=
        "Payment is being handled. Please wait before paying separately.";
    } else if (
      disposition.reason === "stale" ||
      disposition.reason === "unknown"
    ) {
      // Routine: evidence expires after five seconds and payment rechecks it.
      label ??= "Check payment status";
      note ??= "Payment status is checked again before payment.";
    } else if (disposition.reason === "provider_unavailable") {
      label ??= "Status unavailable";
      note =
        "Payment status could not be confirmed. The payment link is unavailable. Please check again later.";
    } else if (disposition.reason !== "not_payable") {
      label ??= "Staff review";
      note =
        disposition.reason === "resolution_pending" ||
        disposition.reason === "resolution_conflict"
          ? "Another payment or invoice change needs staff review. The payment link is unavailable."
          : "Payment status needs to be checked. The payment link is unavailable.";
      review = true;
    }
  } else if (disposition.reason === "paid" && !attempt) {
    label = "Paid";
  }
  if (attempt?.state === "failed" && attempt.reason !== "declined") {
    label = "Staff review";
    review = true;
  }
  return { label, note, review };
}

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
