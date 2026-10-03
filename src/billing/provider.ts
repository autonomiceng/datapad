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
  recipientName: string;
  invoiceId: string;
  customerId: string;
  providerCustomerId: string;
  issueDate: string;
  dueDate: string;
  dueEndAt: string;
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
export interface ProviderInvoice extends Omit<InvoiceIntent, "recipientName"> {
  recipientName: string | null;
  recipientEmail: string | null;
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
    /** True only when an observed invoice or line receipt contradicts its intent. */
    readonly receiptMismatch = false,
  ) {
    super(reason);
    this.name = "BillingProviderError";
  }
}

/** Transport failures throw; ambiguous recovery is an explicit result. */
export interface BillingProvider {
  readonly ownership: ProviderOwnership;
  /**
   * Look up a customer by owned durable intent; incomplete or multiple
   * matches are ambiguous and absence does not prove a prior create failed.
   */
  findCustomer(intent: CustomerIntent): Promise<Lookup<ProviderCustomer>>;
  /**
   * Create an owned sandbox customer using the supplied stable effect key;
   * retries must preserve intent and key.
   */
  createCustomer(
    intent: CustomerIntent,
    effect: ProviderEffect,
  ): Promise<ProviderCustomer>;
  /**
   * Look up an owned invoice by durable intent and verify its receipt;
   * incomplete or multiple matches are ambiguous.
   */
  findInvoice(intent: InvoiceIntent): Promise<Lookup<ProviderInvoice>>;
  /**
   * Create a draft manual-collection invoice without pending items or
   * automatic advancement, using the stable effect key.
   */
  createInvoice(
    intent: InvoiceIntent,
    effect: ProviderEffect,
  ): Promise<ProviderInvoice>;
  /**
   * Retrieve the identified invoice and verify ownership and intended
   * content; draft receipts may contain only some intended lines.
   */
  retrieveInvoice(
    intent: InvoiceIntent,
    providerInvoiceId: string,
  ): Promise<ProviderInvoice>;
  /**
   * Add an intended line to its owned draft invoice using the stable effect
   * key; callers recover existing lines before replaying this operation.
   */
  addLine(
    intent: InvoiceIntent,
    providerInvoiceId: string,
    line: LineIntent,
    effect: ProviderEffect,
  ): Promise<ProviderLine>;
  /**
   * Verify complete intended lines and total before finalizing with
   * automatic advancement disabled; an already finalized receipt is
   * returned.
   */
  finalizeInvoice(
    intent: InvoiceIntent,
    providerInvoiceId: string,
    effect: ProviderEffect,
  ): Promise<ProviderInvoice>;
}

/** Kept outside BillingProvider so billing never handles HTTP or signatures. */
export interface BillingEventVerifier {
  /**
   * Verify the original body bytes and signature, sandbox mode and account.
   * Unhandled event types return null; rejected evidence throws.
   */
  verifyEvent(
    rawBody: string,
    signature: string,
  ): Promise<VerifiedInvoiceEvent | VerifiedPaymentSetupEvent | null>;
}

/** Persisted setup parameters. No browser-supplied provider identifiers. */
export interface PaymentSetupIntent extends ProviderOwnership {
  setupId: string;
  customerId: string;
  providerCustomerId: string;
  currency: "USD";
  successUrl: string;
  cancelUrl: string;
  integrationIdentifier: string;
}
/** Session and SetupIntent observations, independently retrieved by the adapter. */
export interface ProviderPaymentSetup extends PaymentSetupIntent {
  livemode: false;
  providerSessionId: string;
  status: "open" | "complete" | "expired";
  checkoutUrl: string | null;
  setupIntent: {
    providerSetupIntentId: string;
    deploymentKey: string;
    setupId: string;
    providerCustomerId: string;
    livemode: false;
    status:
      | "succeeded"
      | "processing"
      | "requires_action"
      | "requires_payment_method"
      | "requires_confirmation"
      | "canceled";
    usage: "off_session" | "on_session";
    providerPaymentMethodId: string | null;
  } | null;
}
export interface ProviderSavedPaymentMethod extends ProviderOwnership {
  providerPaymentMethodId: string;
  providerCustomerId: string | null;
  livemode: false;
  type: "card" | "unsupported";
  card: {
    brand: string;
    last4: string;
    expiryMonth: number;
    expiryYear: number;
  } | null;
}
export interface VerifiedPaymentSetupEvent extends ProviderOwnership {
  eventId: string;
  providerSessionId: string;
  setupId: string | null;
}
/** Capability composed with the existing verified client; never charges. */
export interface PaymentSettingsProvider {
  readonly ownership: ProviderOwnership;
  /** Creates a hosted save-card session using persisted intent and the caller's stable effect key; retries must preserve both and never charge. */
  createSetup(
    intent: PaymentSetupIntent,
    effect: ProviderEffect,
  ): Promise<ProviderPaymentSetup>;
  /** Fully paginate the owned customer's Sessions; incomplete inspection is ambiguous. */
  findSetup(intent: PaymentSetupIntent): Promise<Lookup<ProviderPaymentSetup>>;
  /** Retrieves and verifies the exact owned Session and its SetupIntent; a completed browser redirect is insufficient evidence. */
  retrieveSetup(
    intent: PaymentSetupIntent,
    providerSessionId: string,
  ): Promise<ProviderPaymentSetup>;
  /** Retrieves safe card facts with verified account/mode ownership; a detached method may have no customer, so callers must check attachment and expiry. */
  retrieveSavedMethod(
    intent: PaymentSetupIntent,
    providerPaymentMethodId: string,
  ): Promise<ProviderSavedPaymentMethod>;
}

/** Complete, owned payment evidence. Unsupported or incomplete evidence must fail closed. */
export interface CollectionInspection {
  invoice: ProviderInvoice;
  remainingMinor: number;
  paidMinor: number;
  paidOffStripeMinor: number;
  overpaidMinor: number;
  collectionState: "idle" | "active" | "unknown";
  payments: Array<{
    invoicePaymentId: string;
    paymentIntentId: string;
    status: "open" | "paid" | "canceled";
    paidMinor: number | null;
    intentState:
      | "requires_payment_method"
      | "requires_confirmation"
      | "requires_action"
      | "processing"
      | "requires_capture"
      | "canceled"
      | "succeeded";
    receivedMinor: number;
    capturableMinor: number;
  }>;
}
/** Added to the existing provider factory; ownership must equal BillingProvider ownership. */
export interface InvoiceResolutionProvider {
  readonly ownership: ProviderOwnership;
  /** Retrieves complete owned invoice/payment allocations without charging; incomplete or unsupported evidence must fail closed. */
  inspectCollection(
    intent: InvoiceIntent,
    id: string,
  ): Promise<CollectionInspection>;
  /** Records the full remaining balance as paid off-provider without charging.
   * Caller verifies received funds; recovery preserves the exact pay parameters and key. */
  settleExternally(
    intent: InvoiceIntent,
    id: string,
    effect: ProviderEffect,
  ): Promise<{ invoice: ProviderInvoice; paidOffStripeMinor: number }>;
  /** Voids the exact owned invoice with the supplied stable key; caller must first exclude conflicting payment evidence and preserve recovery intent. */
  voidInvoice(
    intent: InvoiceIntent,
    id: string,
    effect: ProviderEffect,
  ): Promise<ProviderInvoice>;
}
