import type { Pool } from "pg";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { AccessResult, AuditWriter, HumanActor } from "../access/types";
import type { Customers } from "../customers/types";
import type { CustomerProfile } from "../customers/contract";
import type {
  PaymentSettingsProvider,
  ProviderOwnership,
  VerifiedPaymentSetupEvent,
} from "./provider";
import type { SubscriptionPolicy } from "./subscriptions-types";
import type {
  StartPaymentSetupRequest,
  PaymentSetupResponse,
  ReplaceEnrollmentRequest,
  ReduceEnrollmentRequest,
  ChangeEnrollmentResponse,
  PaymentSettingsResponse,
} from "./payment-settings-contract";
export interface PaymentSettingsOptions {
  pool: Pool;
  deploymentKey: string;
  /** Null is allowed only without an effect provider and without stored provider facts. */
  providerOwnership: ProviderOwnership | null;
  provider: PaymentSettingsProvider | null;
  customerAccess: Pick<Customers, "authorizeCustomer" | "readProfile">;
  audit: AuditWriter;
  /** Accepts only reviewed synthetic billing profiles before setup or startup inspection. */
  allowProfile: (profile: CustomerProfile) => boolean;
  /** Validates the preserved provider-mapping name independently of the current profile. */
  allowMappingName: (customerId: string, name: string) => boolean;
  allowSubscription: SubscriptionPolicy;
  /** Server-fixed return bases; local customer/setup IDs are appended before persistence. */
  successUrl: string;
  cancelUrl: string;
  /** Existing customer receipt recovery, called under the mapping-customer session lock. */
  ensureCustomerReceipt: (
    connection: NodePgDatabase,
    billingCustomerId: string,
  ) => Promise<string>;
  /** Use wall time for setup recovery, consent evidence and card expiry checks. */
  now?: () => Date;
}
/** Customer administrators alone may change settings; saving a card grants no collection consent. */
export interface PaymentSettings {
  /** Requires read_billing and returns persisted safe card/consent facts without provider I/O. */
  getPaymentSettings(
    actor: HumanActor,
    customerId: string,
  ): Promise<AccessResult<PaymentSettingsResponse>>;
  /** Requires customer administration and accepted save terms. Persists intent before provider I/O; identical request IDs recover the same setup. */
  startSetup(
    actor: HumanActor,
    customerId: string,
    input: StartPaymentSetupRequest,
  ): Promise<AccessResult<PaymentSetupResponse>>;
  /** Rechecks customer administration around retrieval of this owned setup; a browser return alone never verifies the saved method. */
  refreshSetup(
    actor: HumanActor,
    customerId: string,
    setupId: string,
  ): Promise<AccessResult<PaymentSetupResponse>>;
  /** Records explicit all-selected-subscription consent transactionally. Expected-version conflicts require review; identical requests replay unchanged. */
  replaceEnrollment(
    actor: HumanActor,
    customerId: string,
    input: ReplaceEnrollmentRequest,
  ): Promise<AccessResult<ChangeEnrollmentResponse>>;
  /** Removes consent scopes immediately, preserving history and sealed invoices; cannot add scope or change the saved method. */
  reduceEnrollment(
    actor: HumanActor,
    customerId: string,
    input: ReduceEnrollmentRequest,
  ): Promise<AccessResult<ChangeEnrollmentResponse>>;
  /** Local intent must exist. Persists the retrieval obligation before acknowledgement. */
  receiveSetupEvent(event: VerifiedPaymentSetupEvent): Promise<void>;
  /** Worker recovery holds the mapping/setup locks across provider I/O and never charges. Reuses the original key; uncertain recovery beyond 23 hours needs review. */
  processSetup(setupId: string): Promise<"complete" | "retry" | "needs_review">;
  /** Reads due, non-exhausted setup work for this deployment; limits outside 1 through 100 throw. */
  pendingSetups(limit?: number): Promise<string[]>;
  /** Returns only mapping IDs backed by fully validated owned setup intentions. */
  assertSyntheticData(): Promise<ReadonlySet<string>>;
}
