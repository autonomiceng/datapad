import type { Pool } from "pg";
import type { AuditWriter } from "../access/types";
import type { InvoiceCollectionProvider } from "./provider";
import type { WorkResult, ReconciliationCursor } from "./work-types";
import type { InvoiceCollection } from "./collection-contract";
export interface InvoiceCollectionsOptions {
  pool: Pool;
  deploymentKey: string;
  provider: InvoiceCollectionProvider;
  audit: AuditWriter;
  workerId: string;
  /** Calendar eligibility only. Provider effects and observations use wallNow. */
  businessNow?: () => Date;
  /** Supplies real effect, evidence-age and recovery time; defaults to the system clock. */
  wallNow?: () => Date;
}
export interface InvoiceCollections {
  /** Executes eligible due-day work under customer and invoice locks; uncertain retries reuse the durable attempt key. */
  collectDueInvoice(invoiceId: string): Promise<WorkResult>;
  /** Retrieves and projects existing payment evidence under locks without initiating a payment. */
  reconcileCollection(invoiceId: string): Promise<WorkResult>;
  /** Lists at most 100 eligible deployment invoices; preserve the through cursor between pages and tolerate repeated work. */
  pendingCollections(input?: {
    limit?: number;
    after?: ReconciliationCursor | null;
    through?: ReconciliationCursor | null;
  }): Promise<{
    invoiceIds: string[];
    next: ReconciliationCursor | null;
    through: ReconciliationCursor | null;
  }>;
  /** Reads the payment disposition under locks; an authorized explicit check may refresh evidence and saved-card availability without charging. */
  getCollectionDisposition(
    invoiceId: string,
    check?: { explicitCheck: true; canManageBilling: boolean },
  ): Promise<InvoiceCollection | null>;
  /** Rejects collection rows outside this deployment, provider account or approved synthetic provenance. */
  assertSyntheticData(): Promise<void>;
}
