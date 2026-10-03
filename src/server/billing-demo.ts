import { Temporal } from "@js-temporal/polyfill";
import type { InvoiceRequest } from "../billing/contract";

/** Reviewed synthetic commercial content. Dates are frozen by the operator on first run. */
export function demoInvoice(issueDate: string): InvoiceRequest {
  const date = Temporal.PlainDate.from(issueDate);
  if (date.toString() !== issueDate)
    throw new Error("Invalid demo issue date.");
  return {
    originKey: "synthetic-monthly-services",
    customer: { key: "synthetic-elm", name: "Elm Studio (sample)" },
    issueDate,
    dueDate: date.add({ days: 21 }).toString(),
    currency: "USD",
    lines: [
      {
        description: "Web hosting",
        amountMinor: 2300,
        originRef: "synthetic-hosting",
      },
      {
        description: "Storage add-on",
        amountMinor: 500,
        originRef: "synthetic-storage",
      },
    ],
  };
}
