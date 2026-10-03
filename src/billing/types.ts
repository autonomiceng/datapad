import type { Pool } from "pg";
import type {
  BillingPagination,
  InvoiceRequest,
  InvoiceResponse,
  InvoicesResponse,
} from "./contract";
import type { BillingProvider, VerifiedInvoiceEvent } from "./provider";
import type {
  CustomerRegistry,
  ProviderProfileReader,
} from "../customers/types";

export interface BillingReaderOptions {
  pool: Pool;
  deploymentKey: string;
}
export interface BillingOptions extends BillingReaderOptions {
  provider: BillingProvider;
  customers: CustomerRegistry;
  now?: () => Date;
}
export interface BillingReader {
  listInvoices(page?: Partial<BillingPagination>): Promise<InvoicesResponse>;
  getInvoice(invoiceId: string): Promise<InvoiceResponse | null>;
  listInvoicesForCustomers(
    customerIds: string[],
    page?: Partial<BillingPagination>,
  ): Promise<InvoicesResponse>;
  getInvoiceForCustomers(
    customerIds: string[],
    invoiceId: string,
  ): Promise<InvoiceResponse | null>;
  providerProfile: ProviderProfileReader;
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
export type WorkResult = "complete" | "retry" | "needs_review";
export type PendingWork =
  | { kind: "issue"; invoiceId: string }
  | { kind: "event"; eventId: string };
export interface BillingCommands {
  requestInvoice(input: unknown): Promise<RequestResult>;
  requestIssue(invoiceId: string): Promise<IssueResult>;
  issueInvoice(invoiceId: string): Promise<WorkResult>;
  refreshInvoice(invoiceId: string): Promise<WorkResult>;
  acceptEvent(
    event: VerifiedInvoiceEvent,
  ): Promise<"accepted" | "duplicate" | "ignored">;
  processEvent(eventId: string): Promise<WorkResult>;
  pendingWork(limit?: number): Promise<PendingWork[]>;
}
export interface Billing extends BillingReader, BillingCommands {}
