import type { NoticePreview } from "./contract";
import type { NoticeTemplateInput } from "./types";

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ]!,
  );
const date = (value: Date, timeZone: string) =>
  new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone,
  }).format(value);

/** Renders prospective or stamped USD invoice copy from caller-verified billing facts; rendering never authorizes delivery or payment. */
export function renderInvoiceNotice(input: NoticeTemplateInput): NoticePreview {
  const due = date(new Date(`${input.dueDate}T00:00:00Z`), "UTC");
  const issued = date(new Date(input.issuedAt), input.timeZone);
  const amount = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: input.currency,
  }).format(input.remainingMinor / 100);
  const subject = {
    invoice: `Your invoice is ready: due ${due}`,
    before_due: `Invoice reminder: due ${due}`,
    due: `Invoice reminder: due ${due}`,
    overdue: `Your invoice is overdue: due ${due}`,
  }[input.stage];
  const opening = {
    invoice: `Your invoice was issued on ${issued}.`,
    before_due: `A reminder that your invoice is due on ${due}.`,
    due: `Your invoice due date is ${due}.`,
    overdue: `Your invoice was due on ${due} and still has an unpaid balance.`,
  }[input.stage];
  const action = {
    manual: "Please pay using the invoice link below.",
    before_charge:
      "Automatic payment is scheduled. You can pay using the invoice link before the scheduled charge.",
    not_authorized:
      "Automatic payment is not authorized for this invoice. Please pay using the invoice link below.",
    declined:
      "The automatic payment was declined. Please pay using the invoice link below.",
    requires_action:
      "Your payment needs verification. Open the invoice link to complete the required action.",
    missed:
      "Automatic payment was not attempted. Please pay using the invoice link below.",
  }[input.paymentReason];
  const paragraphs = [
    `Hello ${input.billToName},`,
    opening,
    `Invoice: ${input.invoiceId}\nIssued: ${issued}\nDue: ${due}\nAmount remaining: ${amount} USD`,
    action,
  ];
  return {
    subject,
    text: `${paragraphs.join("\n\n")}\n\nView invoice: ${input.paymentUrl}`,
    html: `${paragraphs.map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, "<br>")}</p>`).join("")}<p><a href="${escapeHtml(input.paymentUrl)}">View invoice</a></p>`,
  };
}
