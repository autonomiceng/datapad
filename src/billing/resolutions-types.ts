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
  /** Approves the exact synthetic receipt, void or correction intention before it is recorded. */
  allowResolution: (resolution: SyntheticResolution) => boolean;
  /** Use wall time for receipt dates, provider observations and finite effect recovery. */
  now?: () => Date;
}
/** Human operations require scoped manage_billing; provider effects belong to durable worker recovery. */
export interface InvoiceResolutions {
  /** Retrieves owned payment evidence under invoice locks and persists its projection; provider failures become safe blockers. */
  getResolutionReview(
    actor: HumanActor,
    customerId: string,
    invoiceId: string,
  ): Promise<AccessResult<ResolutionReviewResponse>>;
  /** Records received funds and audit locally without provider I/O; pending evidence does not claim confirmed invoice settlement. */
  recordExternalPayment(
    actor: HumanActor,
    customerId: string,
    invoiceId: string,
    input: ExternalPaymentRequest,
  ): Promise<AccessResult<ResolutionActionResponse>>;
  /** Inspects owned payment evidence before persisting a void intention; conflicting payments hold the operation and no void is dispatched here. */
  requestVoid(
    actor: HumanActor,
    customerId: string,
    invoiceId: string,
    input: VoidInvoiceRequest,
  ): Promise<AccessResult<ResolutionActionResponse>>;
  /** Preserves the received-funds record: withdraws an unattempted resolution, otherwise requires review; never reverses provider settlement. */
  flagReceiptCorrection(
    actor: HumanActor,
    customerId: string,
    invoiceId: string,
    input: ReceiptCorrectionRequest,
  ): Promise<AccessResult<ResolutionActionResponse>>;
  /** Explicitly resumes only an unattempted review item after fresh compatible inspection; attempted effects cannot be restarted. */
  reconcileResolution(
    actor: HumanActor,
    customerId: string,
    invoiceId: string,
    input: ReconcileResolutionRequest,
  ): Promise<AccessResult<ResolutionActionResponse>>;
  /** Worker effect recovery holds customer then invoice locks across I/O. Replays the same key within 23 hours; unknown IDs are complete no-ops. */
  processResolution(resolutionId: string): Promise<WorkResult>;
  /** Reads due pending resolutions for this deployment without provider I/O; limits outside 1 through 100 throw. */
  pendingResolutions(
    limit?: number,
  ): Promise<Array<{ kind: "resolution"; resolutionId: string }>>;
  /** Reads stored intentions, receipts and ownership links; throws for unapproved synthetic evidence. */
  assertSyntheticData(): Promise<void>;
}
