import type { ProviderInvoiceStatus, ReviewReason } from "./contract";

/** A configured sandbox account and this deployment's durable namespace. */
export interface ProviderOwnership {
  deploymentKey: string;
  accountId: string;
}
export interface CustomerIntent extends ProviderOwnership {
  customerId: string;
  name: string;
}
export interface LineIntent {
  lineId: string;
  position: number;
  description: string;
  amountMinor: number;
}
export interface InvoiceIntent extends ProviderOwnership {
  invoiceId: string;
  customerId: string;
  providerCustomerId: string;
  issueDate: string;
  dueDate: string;
  currency: "USD";
  totalMinor: number;
  lines: LineIntent[];
}
export interface ProviderCustomer extends CustomerIntent {
  providerCustomerId: string;
  livemode: false;
}
export interface ProviderLine extends LineIntent {
  providerLineId: string;
  currency: "USD";
}
/** Observed data: draft totals may be zero and lines may be a partial set. */
export interface ProviderInvoice extends InvoiceIntent {
  providerInvoiceId: string;
  livemode: false;
  status: ProviderInvoiceStatus;
  lines: ProviderLine[];
  hostedInvoiceUrl: string | null;
  finalizedAt: string | null;
  collectionMethod: "send_invoice";
  autoAdvance: false;
}
/** Absence never establishes that a previously attempted effect did not run. */
export type Lookup<T> =
  | { kind: "found"; value: T }
  | { kind: "absent" }
  | { kind: "ambiguous" };
export interface ProviderEffect {
  idempotencyKey: string;
}
/** Returned only after signature, account, mode and event-shape verification. */
export interface VerifiedInvoiceEvent extends ProviderOwnership {
  eventId: string;
  eventType: string;
  providerInvoiceId: string;
  invoiceId: string | null;
  createdAt: string;
}

/** Adapter errors expose safe classification, never raw provider responses. */
export class BillingProviderError extends Error {
  constructor(
    readonly kind: "retryable" | "review",
    readonly reason: ReviewReason,
  ) {
    super(reason);
    this.name = "BillingProviderError";
  }
}

/** Transport failures throw; ambiguous recovery is an explicit result. */
export interface BillingProvider {
  readonly ownership: ProviderOwnership;
  findCustomer(intent: CustomerIntent): Promise<Lookup<ProviderCustomer>>;
  createCustomer(
    intent: CustomerIntent,
    effect: ProviderEffect,
  ): Promise<ProviderCustomer>;
  findInvoice(intent: InvoiceIntent): Promise<Lookup<ProviderInvoice>>;
  createInvoice(
    intent: InvoiceIntent,
    effect: ProviderEffect,
  ): Promise<ProviderInvoice>;
  retrieveInvoice(
    intent: InvoiceIntent,
    providerInvoiceId: string,
  ): Promise<ProviderInvoice>;
  addLine(
    intent: InvoiceIntent,
    providerInvoiceId: string,
    line: LineIntent,
    effect: ProviderEffect,
  ): Promise<ProviderLine>;
  finalizeInvoice(
    intent: InvoiceIntent,
    providerInvoiceId: string,
    effect: ProviderEffect,
  ): Promise<ProviderInvoice>;
}

/** Kept outside BillingProvider so billing never handles HTTP or signatures. */
export interface BillingEventVerifier {
  verifyEvent(
    rawBody: string,
    signature: string,
  ): Promise<VerifiedInvoiceEvent | null>;
}
