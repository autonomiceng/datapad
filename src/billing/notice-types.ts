import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { InvoiceResponse } from "./contract";
import type { CalendarPolicy } from "./subscriptions-contract";
import type { InvoiceCollection } from "./collection-contract";
import type { ReconciliationCursor } from "./work-types";
import type { InvoiceCollectionsOptions } from "./collection-types";
export type InvoiceNoticeBillingOptions = InvoiceCollectionsOptions;
export interface InvoiceNoticeFacts {
  invoiceId: string;
  customerId: string;
  billingCustomerId: string;
  billTo: InvoiceResponse["invoice"]["billTo"];
  issuedAt: string | null;
  dueDate: string;
  dueEndAt: string;
  calendar: CalendarPolicy | null;
  currency: "USD";
  totalMinor: number;
  verifiedFinalization: boolean;
  remainingMinor: number | null;
  collection: InvoiceCollection;
  paymentUrl: string | null;
  observedFrom: string | null;
  observedThrough: string | null;
}
export type FinalizedNoticeInvoice = Pick<
  InvoiceNoticeFacts,
  | "invoiceId"
  | "customerId"
  | "billingCustomerId"
  | "billTo"
  | "issuedAt"
  | "dueDate"
  | "dueEndAt"
  | "calendar"
  | "currency"
  | "totalMinor"
>;
export interface LockedInvoiceNoticeContext {
  connection: NodePgDatabase;
  /** Performs fresh complete inspection outside a SQL transaction, while the existing invoice locks remain held. */
  observe(): Promise<InvoiceNoticeFacts>;
  /** Rechecks private latest evidence and current local guards in the caller transaction without network calls or lock reacquisition. */
  recheck(tx: NodePgDatabase): Promise<InvoiceNoticeFacts>;
}
export interface InvoiceNoticeBilling {
  /** Provider-free verified-finalization discovery; preserve through until the pass finishes, then restart to discover late finalizations. */
  finalizedNoticePage(input?: {
    limit?: number;
    after?: ReconciliationCursor | null;
    through?: ReconciliationCursor | null;
  }): Promise<{
    invoices: FinalizedNoticeInvoice[];
    next: ReconciliationCursor | null;
    through: ReconciliationCursor | null;
  }>;
  /** Holds mapping-customer then invoice session locks through work and outcome recording; unknown deployment IDs return null. Never nests these locks. */
  withInvoiceNoticeContext<T>(
    invoiceId: string,
    work: (context: LockedInvoiceNoticeContext) => Promise<T>,
  ): Promise<T | null>;
}
