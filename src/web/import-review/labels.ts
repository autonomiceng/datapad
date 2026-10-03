import type { DataIssue, RecordType } from "../../import-review/contract";

export const recordTypes: Record<
  RecordType,
  { label: string; description: string }
> = {
  customer: {
    label: "Customer",
    description:
      "A person or organization with a customer account, which groups their services and domains. A customer account can have several people who sign in.",
  },
  service: {
    label: "Service",
    description:
      "A service on a customer's account, such as web hosting. A product is the offering they choose; the service is their individual instance of it.",
  },
  addon: {
    label: "Add-on",
    description:
      "An extra attached to a service, such as additional storage. It can have its own price and billing cycle.",
  },
  domain: {
    label: "Domain",
    description:
      "A domain registration on a customer's account, such as example.test. A hostname shown on a hosting service does not by itself mean a domain registration is included.",
  },
};

export const issueLabels: Record<DataIssue["code"], string> = {
  missing_related_record: "Missing related record",
  unrecognized_status: "Unrecognized status",
  invalid_date: "Invalid date",
  different_customer: "Different customer",
};

export const fieldLabels: Record<DataIssue["field"], string> = {
  customer: "Customer",
  attachedService: "Attached to service",
  status: "Status",
  dueDate: "Due date",
  nextInvoiceDate: "Next invoice date",
  expiryDate: "Expiry date",
};
