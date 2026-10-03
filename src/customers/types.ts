import type { Pool } from "pg";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { AccountPagination } from "../access/contract";
import type {
  AccessPolicy,
  AccessResult,
  AuditWriter,
  CustomerAccess,
  CustomerAccessTarget,
  CustomerCapability,
  HumanActor,
} from "../access/types";
import type {
  CustomerProfile,
  ProviderProfileState,
  CustomerResponse,
  CustomersResponse,
  UpdateCustomerRequest,
  UpdateCustomerResponse,
} from "./contract";

/** Read-only billing projection for the configured provider deployment. */
export type ProviderProfileReader = (
  customerId: string,
  profile: Pick<CustomerProfile, "legalName" | "billingEmail">,
) => Promise<ProviderProfileState>;

export interface CustomersOptions {
  pool: Pool;
  access: AccessPolicy;
  audit: AuditWriter;
  providerProfile: ProviderProfileReader;
  /** Runtime composition supplies the reviewed synthetic profile policy. */
  allowProfile: (profile: CustomerProfile) => boolean;
}
export interface Customers {
  /** Customer-owned profile read in the caller transaction; confers no authorization. */
  readProfile(
    tx: NodePgDatabase,
    customerId: string,
    options?: { lock?: boolean },
  ): Promise<RegisteredCustomer | null>;
  /**
   * Resolve current billing visibility: billing staff and account
   * administrators see all, other actors use their organization
   * memberships.
   */
  billingScope(
    actor: HumanActor,
  ): Promise<
    AccessResult<{ kind: "all" } | { kind: "customers"; customerIds: string[] }>
  >;
  /**
   * List customers visible to the current actor, ordered by display name
   * and ID with bounded pagination.
   */
  listCustomers(
    actor: HumanActor,
    page?: Partial<AccountPagination>,
  ): Promise<AccessResult<CustomersResponse>>;
  /**
   * Read an authorized customer profile and local provider-profile
   * projection; absent or out-of-scope customers return not_found.
   */
  getCustomer(
    actor: HumanActor,
    customerId: string,
  ): Promise<AccessResult<CustomerResponse>>;
  /**
   * Require current profile-management authority and expectedVersion.
   * Commit changed fields with audit; unchanged profiles consume no request
   * ID.
   */
  updateCustomer(
    actor: HumanActor,
    customerId: string,
    input: UpdateCustomerRequest,
  ): Promise<AccessResult<UpdateCustomerResponse>>;
  /** Internal ID mapping only; this does not confer customer access. */
  getOrganizationTarget(
    organizationId: string,
  ): Promise<CustomerAccessTarget | null>;
  /**
   * Resolve customer identity and organization binding without
   * authorization; null means no matching customer.
   */
  getAccessTarget(customerId: string): Promise<CustomerAccessTarget | null>;
  /** Billing and later modules check customer scope within their own transaction. */
  authorizeCustomer(
    tx: NodePgDatabase,
    actor: HumanActor,
    customerId: string,
    capability: CustomerCapability,
    mutation: boolean,
  ): Promise<AccessResult<CustomerAccess>>;
}

/** Operator-only identity registry; caller transaction also owns the invoice write. */
export interface RegisteredCustomer {
  customerId: string;
  profile: CustomerProfile;
  version: number;
}
export interface CustomerRegistry {
  /**
   * Bind an unbound customer in the caller transaction with operator audit;
   * the same binding is a no-op and a different binding throws.
   */
  bindOrganization(
    tx: NodePgDatabase,
    input: { customerId: string; organizationId: string },
  ): Promise<void>;
  /**
   * Resolve a durable registry key or create its customer and operator
   * audit in the caller transaction. Existing profiles are preserved and
   * checked against policy.
   */
  ensureCustomer(
    tx: NodePgDatabase,
    input: {
      registryKey: string;
      initialProfile: CustomerProfile;
      organizationId?: string | null;
    },
  ): Promise<RegisteredCustomer>;
}
export interface CustomerRegistryOptions {
  audit: AuditWriter;
  operatorId: string;
  /**
   * Approve both newly supplied and existing registry profiles against the
   * reviewed synthetic dataset.
   */
  allowProfile: (profile: CustomerProfile) => boolean;
}
