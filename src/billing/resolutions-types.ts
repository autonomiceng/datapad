import type { Pool } from "pg";
import type { AccessResult, AuditWriter, HumanActor } from "../access/types";
import type { Customers } from "../customers/types";
import type { InvoiceResolutionProvider } from "./provider";
import type { WorkResult } from "./types";
import type {
  ExternalPaymentRequest,
  VoidInvoiceRequest,
  ReceiptCorrectionRequest,
  ReconcileResolutionRequest,
  ResolutionActionResponse,
  ResolutionReviewResponse,
} from "./resolutions-contract";
export type SyntheticResolution = { customerId: string; invoiceId: string } & (
  | { kind: "external_payment"; input: ExternalPaymentRequest }
  | { kind: "void"; input: VoidInvoiceRequest }
  | { kind: "correction"; input: ReceiptCorrectionRequest }
);
export interface InvoiceResolutionsOptions {
  pool: Pool;
  deploymentKey: string;
  resolutionProvider: InvoiceResolutionProvider;
  customerAccess: Pick<Customers, "authorizeCustomer">;
  audit: AuditWriter;
  workerId: string;
  allowResolution: (resolution: SyntheticResolution) => boolean;
  now?: () => Date;
}
export interface InvoiceResolutions {
  getResolutionReview(
    actor: HumanActor,
    customerId: string,
    invoiceId: string,
  ): Promise<AccessResult<ResolutionReviewResponse>>;
  recordExternalPayment(
    actor: HumanActor,
    customerId: string,
    invoiceId: string,
    input: ExternalPaymentRequest,
  ): Promise<AccessResult<ResolutionActionResponse>>;
  requestVoid(
    actor: HumanActor,
    customerId: string,
    invoiceId: string,
    input: VoidInvoiceRequest,
  ): Promise<AccessResult<ResolutionActionResponse>>;
  flagReceiptCorrection(
    actor: HumanActor,
    customerId: string,
    invoiceId: string,
    input: ReceiptCorrectionRequest,
  ): Promise<AccessResult<ResolutionActionResponse>>;
  reconcileResolution(
    actor: HumanActor,
    customerId: string,
    invoiceId: string,
    input: ReconcileResolutionRequest,
  ): Promise<AccessResult<ResolutionActionResponse>>;
  processResolution(resolutionId: string): Promise<WorkResult>;
  pendingResolutions(
    limit?: number,
  ): Promise<Array<{ kind: "resolution"; resolutionId: string }>>;
  assertSyntheticData(): Promise<void>;
}
