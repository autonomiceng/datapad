import type { Pool } from "pg";
import type { AccountPagination } from "../access/contract";
import type { AccessResult, AuditWriter, HumanActor } from "../access/types";
import type { Customers } from "../customers/types";
import type {
  ServiceKind,
  ComponentKind,
  RequestedSetting,
  ServiceManager,
  ServicesResponse,
  ServiceResponse,
  SetComponentPreferenceRequest,
  AttachAddonRequest,
} from "./contract";

export interface ServiceRecord {
  id: string;
  customerId: string;
  sourceKey: string;
  kind: ServiceKind;
  name: string;
  packageName: string | null;
  includedComponents: ComponentKind[];
  attachedServiceId: string | null;
}
export interface HostingAccountRecord {
  id: string;
  customerId: string;
  providerKey: string;
  providerLabel: string;
  label: string;
}
export interface ComponentRecord {
  id: string;
  customerId: string;
  serviceId: string;
  kind: ComponentKind;
  delivery: "hosted" | "external";
  providerLabel: string;
  hostingAccountId: string | null;
  manager: ServiceManager;
  requestedSetting: RequestedSetting | null;
  providerState: RequestedSetting | "unknown";
  checkedAt: string | null;
}
export interface WebsiteRecord {
  id: string;
  customerId: string;
  componentId: string;
}
export interface ComponentNameRecord {
  componentId: string;
  customerId: string;
  componentKind: ComponentKind;
  websiteId: string | null;
  hostname: string;
  isPrimary: boolean;
}
export interface RegistrationRecord {
  serviceId: string;
  customerId: string;
  registeredName: string;
  registrarLabel: string;
  manager: ServiceManager;
  expiresOn: string | null;
  renewalResponsibility: "staff" | "customer" | "unknown";
}
export interface ServiceManifest {
  services: ServiceRecord[];
  hostingAccounts: HostingAccountRecord[];
  components: ComponentRecord[];
  websites: WebsiteRecord[];
  names: ComponentNameRecord[];
  registrations: RegistrationRecord[];
}
export type SyntheticServiceRecord =
  | { recordType: "service"; record: ServiceRecord }
  | { recordType: "hosting_account"; record: HostingAccountRecord }
  | { recordType: "component"; record: ComponentRecord }
  | { recordType: "website"; record: WebsiteRecord }
  | { recordType: "component_name"; record: ComponentNameRecord }
  | { recordType: "domain_registration"; record: RegistrationRecord };
export interface ServicePolicy {
  manifest: ServiceManifest;
  /** Approves synthetic bootstrap records and local edits; false rejects the candidate. */
  allowRecord: (record: SyntheticServiceRecord) => boolean;
}
export interface ServicesOptions {
  pool: Pool;
  authorizeCustomer: Customers["authorizeCustomer"];
  audit: AuditWriter;
  allowRecord: ServicePolicy["allowRecord"];
  providerLinks: Readonly<Record<string, { url: string }>>;
}
export interface ServiceBootstrapOptions extends ServicePolicy {
  operatorId: string;
  bootstrapKey: string;
  audit: AuditWriter;
}
/** Reads require customer read access; edits require manage_services and preserve provider state. */
export interface Services {
  /** Lists only this customer's inventory, including attached add-ons; performs no provider reads. */
  listServices(
    actor: HumanActor,
    customerId: string,
    page?: Partial<AccountPagination>,
  ): Promise<AccessResult<ServicesResponse>>;
  /** Reads scoped components and observed provider state; missing or foreign services return not_found. */
  getService(
    actor: HumanActor,
    customerId: string,
    serviceId: string,
  ): Promise<AccessResult<ServiceResponse>>;
  /** Audits a local requested setting under the expected version. Stale versions conflict; no provider effect runs. */
  setComponentPreference(
    actor: HumanActor,
    customerId: string,
    serviceId: string,
    componentId: string,
    input: SetComponentPreferenceRequest,
  ): Promise<AccessResult<ServiceResponse>>;
  /** Attaches or detaches an add-on within the same customer under the expected version; cross-customer targets are not_found. */
  attachAddon(
    actor: HumanActor,
    customerId: string,
    addonId: string,
    input: AttachAddonRequest,
  ): Promise<AccessResult<ServiceResponse>>;
}
