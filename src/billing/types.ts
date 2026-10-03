import type { WorkResult, ReconciliationCursor } from "./work-types";
export type { WorkResult, ReconciliationCursor } from "./work-types";
import type { SyntheticScheduledInvoice } from "./scheduled-types";
import type { InvoiceCollections } from "./collection-types";
import type { AccessResult, AuditWriter, HumanActor } from "../access/types";
import type { Customers } from "../customers/types";
import type {
  PrepareInvoiceRequest,
  PrepareInvoiceResponse,
  InvoicePreparationResponse,
  ConfirmIssueResponse,
} from "./contract";
import type { Pool } from "pg";
import type {
  BillingPagination,
  InvoiceRequest,
  InvoiceResponse,
  InvoicesResponse,
} from "./contract";
import type {
  BillingProvider,
  InvoiceResolutionProvider,
  InvoiceCollectionProvider,
  VerifiedInvoiceEvent,
} from "./provider";
import type {
  CustomerRegistry,
  ProviderProfileReader,
} from "../customers/types";

export interface BillingReaderOptions {
  pool: Pool;
  deploymentKey: string;
  /** Calendar decisions only; provider evidence and effects use wall time. */
  businessNow?: () => Date;
}
export interface BillingOptions extends BillingReaderOptions {
  provider: BillingProvider;
  resolutionProvider?: InvoiceResolutionProvider;
  collectionProvider?: Pick<
    InvoiceCollectionProvider,
    "ownership" | "inspectCollection"
  >;
  customers: CustomerRegistry;
  /** Wall clock for effects, observations, recovery and manual invoice dates. */
  now?: () => Date;
}
export interface SyntheticInvoice {
  request: InvoiceRequest;
  customerId: string;
  billTo: InvoiceResponse["invoice"]["billTo"];
}
/** Approves an exact synthetic request with its operational customer and frozen bill-to facts. */
export type SyntheticInvoicePolicy = (invoice: SyntheticInvoice) => boolean;
/** Allows a reviewed setup-backed mapping with no invoice; names alone must not establish synthetic provenance. */
export type SyntheticCustomerMappingPolicy = (mapping: {
  id: string;
  customerId: string;
  key: string;
  name: string;
}) => boolean;
export interface BillingReader {
  /** Returns persisted account identity; inconsistent deployment or account facts throw. */
  storedProviderAccountId(): Promise<string | null>;
  /** Reads a bounded deployment-only page of provider-linked invoices. Carry next with the same through cursor; invalid cursors throw. */
  reconciliationPage(input?: {
    limit?: number;
    after?: ReconciliationCursor | null;
    through?: ReconciliationCursor | null;
  }): Promise<{
    invoiceIds: string[];
    next: ReconciliationCursor | null;
    through: ReconciliationCursor | null;
  }>;
  /** Reads all stored billing facts and throws on foreign ownership or unapproved intentions; setup-only mappings need explicit approval. */
  assertSyntheticPolicy(
    allowRequest: SyntheticInvoicePolicy,
    accountId?: string,
    allowScheduledRequest?: (invoice: SyntheticScheduledInvoice) => boolean,
    allowCustomerMapping?: SyntheticCustomerMappingPolicy,
  ): Promise<void>;

  /**
   * Read invoices for this deployment in creation order, newest first;
   * callers enforce read authority and invalid pagination throws.
   */
  listInvoices(page?: Partial<BillingPagination>): Promise<InvoicesResponse>;
  /**
   * Read one deployment-owned invoice; invalid or absent IDs return null
   * and the hosted link is visible only for finalized states.
   */
  getInvoice(invoiceId: string): Promise<InvoiceResponse | null>;
  /**
   * Restrict deployment reads to caller-authorized customer IDs; an empty
   * scope returns no invoices and invalid IDs throw.
   */
  listInvoicesForCustomers(
    customerIds: string[],
    page?: Partial<BillingPagination>,
  ): Promise<InvoicesResponse>;
  /**
   * Read within the supplied customer scope; out-of-scope invoices return
   * null. Callers must derive scope from current authority.
   */
  getInvoiceForCustomers(
    customerIds: string[],
    invoiceId: string,
  ): Promise<InvoiceResponse | null>;
  providerProfile: ProviderProfileReader;
  /**
   * Inspect all stored billing rows against approved requests, recipients
   * and account ownership; reject unapproved data without provider calls.
   */
  assertSyntheticData(
    allowedRequests: InvoiceRequest[],
    accountId?: string,
    allowedBillTo?: Array<{ legalName: string; billingEmail: string | null }>,
  ): Promise<void>;
}
export type RequestResult =
  | { kind: "created" | "unchanged"; invoiceId: string }
  | { kind: "conflict" }
  | { kind: "invalid"; fields: string[] };
export type IssueResult =
  | { kind: "accepted" | "unchanged" }
  | { kind: "not_found" | "not_ready" | "past_due" | "needs_review" };
export type PendingWork =
  | { kind: "issue"; invoiceId: string }
  | { kind: "event"; eventId: string };
export interface BillingCommands {
  /**
   * Stage an immutable request and customer profile snapshot atomically.
   * Matching deployment/origin-key content replays; changed content
   * conflicts without provider effects.
   */
  requestInvoice(input: unknown): Promise<RequestResult>;
  /**
   * Persist issuance intent for a ready, not-past-due invoice under its
   * locks. Review state blocks requests; existing intent replays and no
   * provider effect runs here.
   */
  requestIssue(invoiceId: string): Promise<IssueResult>;
  /**
   * Resume requested issuance under customer and invoice locks, recovering
   * provider receipts before effects and persisting retry or review
   * outcomes.
   */
  issueInvoice(invoiceId: string): Promise<WorkResult>;
  /** Retrieves current provider state under invoice locks; explicit checks carry the caller's current billing authority and never authorize issuance. */
  refreshInvoice(
    invoiceId: string,
    options?: { explicitCheck: true; canManageBilling: boolean },
  ): Promise<WorkResult>;
  /** Persists an owned invoice event retrieval obligation; repeated events are duplicate and unrelated events are ignored. */
  acceptEvent(
    event: VerifiedInvoiceEvent,
  ): Promise<"accepted" | "duplicate" | "ignored">;
  /**
   * Retrieve current invoice state for a stored event under invoice locks;
   * honor retry eligibility and mark processed with the committed
   * projection or an unrelated receipt rejection.
   */
  processEvent(eventId: string): Promise<WorkResult>;
  /**
   * List due issuance and event obligations without claiming them; limit is
   * 1 through 100 and consumers must tolerate repeated delivery.
   */
  pendingWork(limit?: number): Promise<PendingWork[]>;
}
export interface Billing extends BillingReader, BillingCommands {}

export interface BillingWorkflowOptions extends BillingOptions {
  invoiceCollections?: Pick<InvoiceCollections, "getCollectionDisposition">;
  customerAccess: Pick<Customers, "authorizeCustomer" | "readProfile">;
  audit: AuditWriter;
  allowRequest: SyntheticInvoicePolicy;
}
/** Scoped staff billing preparation and confirmation; no provider effects run inside authority transactions. */
export interface BillingWorkflow {
  /** Persists immutable bill-to and lines without issuing. Requires manage_billing; identical request IDs replay and changed content conflicts. */
  prepareInvoice(
    actor: HumanActor,
    customerId: string,
    input: PrepareInvoiceRequest,
  ): Promise<AccessResult<PrepareInvoiceResponse>>;
  /** Requires scoped manage_billing and reads the persisted review with current issue blockers, without provider I/O. */
  getPreparation(
    actor: HumanActor,
    customerId: string,
    invoiceId: string,
  ): Promise<AccessResult<InvoicePreparationResponse>>;
  /** Atomically records first issuance authority and audit under manage_billing; repeats are unchanged. Caller schedules work after commit. */
  confirmIssue(
    actor: HumanActor,
    customerId: string,
    invoiceId: string,
  ): Promise<AccessResult<ConfirmIssueResponse>>;
  /** Requires scoped read_billing and rechecks access after retrieval; billing authority controls refreshes during an active payment attempt. Never initiates a charge. */
  checkInvoice(
    actor: HumanActor,
    customerId: string,
    invoiceId: string,
  ): Promise<AccessResult<InvoiceResponse>>;
}
