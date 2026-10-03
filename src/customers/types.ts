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
  ): Promise<RegisteredCustomer | null>;
  billingScope(
    actor: HumanActor,
  ): Promise<
    AccessResult<{ kind: "all" } | { kind: "customers"; customerIds: string[] }>
  >;
  listCustomers(
    actor: HumanActor,
    page?: Partial<AccountPagination>,
  ): Promise<AccessResult<CustomersResponse>>;
  getCustomer(
    actor: HumanActor,
    customerId: string,
  ): Promise<AccessResult<CustomerResponse>>;
  updateCustomer(
    actor: HumanActor,
    customerId: string,
    input: UpdateCustomerRequest,
  ): Promise<AccessResult<UpdateCustomerResponse>>;
  /** Internal ID mapping only; this does not confer customer access. */
  getOrganizationTarget(
    organizationId: string,
  ): Promise<CustomerAccessTarget | null>;
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
  bindOrganization(
    tx: NodePgDatabase,
    input: { customerId: string; organizationId: string },
  ): Promise<void>;
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
  allowProfile: (profile: CustomerProfile) => boolean;
}
