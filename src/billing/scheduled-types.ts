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
  allowRequest: (invoice: SyntheticScheduledInvoice) => boolean;
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
export interface ScheduledBilling {
  configureSchedule(
    actor: HumanActor,
    customerId: string,
    input: ConfigureScheduleRequest,
  ): Promise<AccessResult<ConfigureScheduleResponse>>;
  getSchedule(
    actor: HumanActor,
    customerId: string,
  ): Promise<AccessResult<ScheduleResponse>>;
  listScheduledGroups(
    actor: HumanActor,
    customerId: string,
    input: ScheduledGroupsQuery,
  ): Promise<AccessResult<ScheduledGroupsResponse>>;
  sweepScheduled(input?: ScheduleSweepInput): Promise<ScheduleSweepResult>;
  assertSyntheticData(): Promise<void>;
}
