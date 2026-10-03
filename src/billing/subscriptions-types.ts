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
  now?: () => Date;
}
export interface Subscriptions {
  listSubscriptions(
    actor: HumanActor,
    customerId: string,
    page?: Partial<AccountPagination>,
  ): Promise<AccessResult<SubscriptionsResponse>>;
  getSubscription(
    actor: HumanActor,
    customerId: string,
    subscriptionId: string,
  ): Promise<AccessResult<SubscriptionResponse>>;
  createSubscription(
    actor: HumanActor,
    customerId: string,
    input: CreateSubscriptionRequest,
  ): Promise<AccessResult<CreateSubscriptionResponse>>;
  changeSubscription(
    actor: HumanActor,
    customerId: string,
    subscriptionId: string,
    input: ChangeSubscriptionRequest,
  ): Promise<AccessResult<ChangeSubscriptionResponse>>;
  getBoundaryOptions(
    actor: HumanActor,
    customerId: string,
    input: SubscriptionBoundaryRequest,
  ): Promise<AccessResult<SubscriptionBoundariesResponse>>;
  materializeForecast(
    actor: HumanActor,
    customerId: string,
    input: MaterializeForecastRequest,
  ): Promise<AccessResult<MaterializeForecastResponse>>;
  getForecast(
    actor: HumanActor,
    customerId: string,
    input: ForecastQuery,
  ): Promise<AccessResult<ForecastResponse>>;
  assertSyntheticData(): Promise<void>;
}
