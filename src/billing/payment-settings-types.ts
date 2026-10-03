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
  now?: () => Date;
}
export interface PaymentSettings {
  getPaymentSettings(
    actor: HumanActor,
    customerId: string,
  ): Promise<AccessResult<PaymentSettingsResponse>>;
  startSetup(
    actor: HumanActor,
    customerId: string,
    input: StartPaymentSetupRequest,
  ): Promise<AccessResult<PaymentSetupResponse>>;
  refreshSetup(
    actor: HumanActor,
    customerId: string,
    setupId: string,
  ): Promise<AccessResult<PaymentSetupResponse>>;
  replaceEnrollment(
    actor: HumanActor,
    customerId: string,
    input: ReplaceEnrollmentRequest,
  ): Promise<AccessResult<ChangeEnrollmentResponse>>;
  reduceEnrollment(
    actor: HumanActor,
    customerId: string,
    input: ReduceEnrollmentRequest,
  ): Promise<AccessResult<ChangeEnrollmentResponse>>;
  /** Local intent must exist. Persists the retrieval obligation before acknowledgement. */
  receiveSetupEvent(event: VerifiedPaymentSetupEvent): Promise<void>;
  processSetup(setupId: string): Promise<"complete" | "retry" | "needs_review">;
  pendingSetups(limit?: number): Promise<string[]>;
  /** Returns only mapping IDs backed by fully validated owned setup intentions. */
  assertSyntheticData(): Promise<ReadonlySet<string>>;
}
