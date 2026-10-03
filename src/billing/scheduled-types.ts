import type { Pool } from "pg";
import type { AccessResult, AuditWriter, HumanActor } from "../access/types";
import type { Customers } from "../customers/types";
import type { InvoiceRequest, InvoiceResponse } from "./contract";
import type { ProviderOwnership } from "./provider";
import type { CalendarPolicy } from "./subscriptions-contract";
import type { SubscriptionPolicy } from "./subscriptions-types";
import type {
  ConfigureScheduleRequest,
  ConfigureScheduleResponse,
  ScheduleResponse,
  ScheduledGroupsQuery,
  ScheduledGroupsResponse,
  ScheduleReviewReason,
} from "./scheduled-contract";

/** Normalized group facts; only positive groups become invoice requests. */
export interface ScheduledInvoiceRequest extends InvoiceRequest {
  calendar: CalendarPolicy;
  issueNotBefore: string;
  firstAttemptBefore: string;
  dueEndAt: string;
}
export interface SyntheticScheduledInvoice {
  request: ScheduledInvoiceRequest;
  customerId: string;
  billTo: InvoiceResponse["invoice"]["billTo"];
}
export interface ScheduledBillingOptions {
  pool: Pool;
  deploymentKey: string;
  providerOwnership: ProviderOwnership;
  customerAccess: Pick<Customers, "authorizeCustomer" | "readProfile">;
  audit: AuditWriter;
  workerId: string;
  allowSubscription: SubscriptionPolicy;
  /** Approves the exact positive invoice and frozen bill-to facts before sealing or startup inspection. */
  allowRequest: (invoice: SyntheticScheduledInvoice) => boolean;
  /** Clock for captured-calendar eligibility and schedule timestamps; production uses wall time. */
  now?: () => Date;
}
export interface ScheduleCursor {
  createdAt: string;
  customerId: string;
}
export interface ScheduleSweepInput {
  limit?: number;
  after?: ScheduleCursor | null;
  through?: ScheduleCursor | null;
}
export interface ScheduleSweepResult {
  next: ScheduleCursor | null;
  through: ScheduleCursor | null;
  results: Array<{
    customerId: string;
    groupIds: string[];
    invoiceIds: string[];
    reviewReasons: ScheduleReviewReason[];
    failure: "unavailable" | null;
  }>;
}
/** Staff configure issuance authority; worker sweeps consume it without provider I/O. */
export interface ScheduledBilling {
  /** Requires manage_billing and current versions. Activation selects future unbilled boundaries; stopping or pausing preserves sealed groups. */
  configureSchedule(
    actor: HumanActor,
    customerId: string,
    input: ConfigureScheduleRequest,
  ): Promise<AccessResult<ConfigureScheduleResponse>>;
  /** Requires read_billing and reads the customer's activation, pause state and selectable future boundaries. */
  getSchedule(
    actor: HumanActor,
    customerId: string,
  ): Promise<AccessResult<ScheduleResponse>>;
  /** Requires read_billing; compares sealed groups with the bounded forecast without issuing invoices. */
  listScheduledGroups(
    actor: HumanActor,
    customerId: string,
    input: ScheduledGroupsQuery,
  ): Promise<AccessResult<ScheduledGroupsResponse>>;
  /** Transactionally seals eligible groups and durable issue requests; zero totals become No charge. Carry next and through together across pages; per-customer failures remain in results. */
  sweepScheduled(input?: ScheduleSweepInput): Promise<ScheduleSweepResult>;
  /** Reads captured schedules, claims and invoice intentions; throws if any ownership or synthetic-policy invariant fails. */
  assertSyntheticData(): Promise<void>;
}
