import type { Pool } from "pg";
import type { AccessResult, AuditWriter, HumanActor } from "../access/types";
import type { Customers } from "../customers/types";
import type { BillingReader } from "../billing/types";
import type { InvoiceNoticeBilling } from "../billing/notice-types";
import type { WorkResult, ReconciliationCursor } from "../billing/work-types";
import type { CollectionDisposition } from "../billing/collection-contract";
import type {
  InvoiceNoticesResponse,
  NoticePreview,
  NoticeStage,
} from "./contract";
export interface NoticeCursor {
  createdAt: string;
  noticeId: string;
}
export interface NoticeSweepInput {
  limit?: number;
  discovery?: {
    after: ReconciliationCursor | null;
    through: ReconciliationCursor | null;
  };
  pending?: { after: NoticeCursor | null; through: NoticeCursor | null };
}
export interface InvoiceNotices {
  /** Requires current scoped manage_billing; reads exact stamped content without effects or materializing obligations. */
  getInvoiceNotices(
    actor: HumanActor,
    customerId: string,
    invoiceId: string,
  ): Promise<AccessResult<InvoiceNoticesResponse>>;
  /** Materializes four obligations per verified invoice and pages recoverable work; preserve both independent cursors and tolerate repeats. */
  sweepNotices(input?: NoticeSweepInput): Promise<{
    noticeIds: string[];
    discovery: NonNullable<NoticeSweepInput["discovery"]>;
    pending: NonNullable<NoticeSweepInput["pending"]>;
  }>;
  /** Inspects billing under its session locks, commits the immutable sending stamp, then sends; uncertain delivery never automatically resends. */
  processNotice(noticeId: string): Promise<WorkResult>;
  /** Rejects foreign deployment rows or stamped recipients outside the configured synthetic policy, without network calls. */
  assertSyntheticData(): Promise<void>;
}
export interface NoticeTemplateInput {
  stage: NoticeStage;
  invoiceId: string;
  billToName: string;
  issuedAt: string;
  dueDate: string;
  timeZone: string;
  currency: "USD";
  remainingMinor: number;
  paymentReason: Extract<CollectionDisposition, { kind: "payable" }>["reason"];
  paymentUrl: string;
}
export interface NoticeSmtp {
  /** Delivers one explicit recipient; only proven nonacceptance permits retry and ambiguous transport outcomes must be uncertain. */
  send(
    message: NoticePreview & { recipient: string; messageId: string },
  ): Promise<
    | { kind: "accepted" }
    | { kind: "definitively_unaccepted"; transient: boolean }
    | { kind: "uncertain" }
  >;
}
export interface InvoiceNoticesOptions {
  pool: Pool;
  deploymentKey: string;
  customerAccess: Pick<Customers, "authorizeCustomer" | "readProfile">;
  billing: InvoiceNoticeBilling | null;
  billingReader: Pick<BillingReader, "getInvoiceForCustomers">;
  smtp: NoticeSmtp;
  audit: AuditWriter;
  workerId: string;
  /** Explicit synthetic destination policy; no member or provider address fallback is allowed. */
  allowRecipient: (recipient: string) => boolean;
  noticeCalendar: { timeZone: string; hour: number };
  portalOrigin: string;
  /** Calendar eligibility only; moving this clock never refreshes financial evidence. */
  businessNow?: () => Date;
  /** Real evidence age, attempt timestamps and bounded retry delays; defaults to system time. */
  wallNow?: () => Date;
}
