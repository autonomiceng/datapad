import type { Pool } from "pg";
import type { AccountPagination } from "../access/contract";
import type { AccessResult, AuditWriter, HumanActor } from "../access/types";
import type { Customers } from "../customers/types";
import type {
  CalendarPolicy,
  CreateSubscriptionRequest,
  ChangeSubscriptionRequest,
  SubscriptionResponse,
  SubscriptionsResponse,
  CreateSubscriptionResponse,
  ChangeSubscriptionResponse,
  SubscriptionBoundaryRequest,
  SubscriptionBoundariesResponse,
  ForecastQuery,
  MaterializeForecastRequest,
  ForecastResponse,
  MaterializeForecastResponse,
} from "./subscriptions-contract";
export interface SyntheticSubscription extends Omit<
  CreateSubscriptionRequest,
  "requestId"
> {
  customerId: string;
  calendar: CalendarPolicy;
  cancellationReason: string | null;
}
/** Approves the complete synthetic commercial terms and captured calendar before persistence or startup inspection. */
export type SubscriptionPolicy = (
  subscription: SyntheticSubscription,
) => boolean;
export interface SubscriptionsOptions {
  pool: Pool;
  deploymentKey: string;
  authorizeCustomer: Customers["authorizeCustomer"];
  audit: AuditWriter;
  calendar: CalendarPolicy;
  allowSubscription: SubscriptionPolicy;
  /** Clock for calendar eligibility and local timestamps; production uses wall time. */
  now?: () => Date;
}
/** Reads require read_billing; mutations require manage_billing and make only local, audited changes. */
export interface Subscriptions {
  /** Reads a customer-scoped page of commercial agreements without provider I/O. */
  listSubscriptions(
    actor: HumanActor,
    customerId: string,
    page?: Partial<AccountPagination>,
  ): Promise<AccessResult<SubscriptionsResponse>>;
  /** Reads scoped terms and revision history; foreign or missing subscription IDs return not_found. */
  getSubscription(
    actor: HumanActor,
    customerId: string,
    subscriptionId: string,
  ): Promise<AccessResult<SubscriptionResponse>>;
  /** Snapshots the configured calendar and initial terms. Identical create request IDs replay; changed content under that identity conflicts. */
  createSubscription(
    actor: HumanActor,
    customerId: string,
    input: CreateSubscriptionRequest,
  ): Promise<AccessResult<CreateSubscriptionResponse>>;
  /** Requires the current version and an unused request ID; edits eligible unsealed boundaries while preserving billed history. */
  changeSubscription(
    actor: HumanActor,
    customerId: string,
    subscriptionId: string,
    input: ChangeSubscriptionRequest,
  ): Promise<AccessResult<ChangeSubscriptionResponse>>;
  /** Derives selectable calendar boundaries within the bounded forecast horizon without persisting periods. */
  getBoundaryOptions(
    actor: HumanActor,
    customerId: string,
    input: SubscriptionBoundaryRequest,
  ): Promise<AccessResult<SubscriptionBoundariesResponse>>;
  /** Refreshes unsealed forecast rows transactionally with audit; never seals or issues an invoice. */
  materializeForecast(
    actor: HumanActor,
    customerId: string,
    input: MaterializeForecastRequest,
  ): Promise<AccessResult<MaterializeForecastResponse>>;
  /** Reads a bounded, customer-scoped forecast without materializing missing periods. */
  getForecast(
    actor: HumanActor,
    customerId: string,
    input: ForecastQuery,
  ): Promise<AccessResult<ForecastResponse>>;
  /** Reads stored agreements and revisions; throws when ownership, history or commercial facts fail the synthetic policy. */
  assertSyntheticData(): Promise<void>;
}
