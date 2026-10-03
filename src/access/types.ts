import type { Pool } from "pg";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type {
  AccessActionResponse,
  AccessErrorCode,
  AccessSessionResponse,
  AccountPagination,
  AcceptInvitationRequest,
  CustomerRole,
  InvitationsResponse,
  InviteMemberRequest,
  MembersResponse,
  RevokeMemberRequest,
  RevokeInvitationRequest,
  StaffRole,
} from "./contract";

/** Identity only. Current authority is resolved for every operation. */
export interface HumanActor {
  userId: string;
  sessionId: string;
}
export type AccessResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: AccessErrorCode };
export interface CustomerAccessTarget {
  customerId: string;
  organizationId: string | null;
}
export type CustomerCapability =
  | "read"
  | "manage_profile"
  | "read_members"
  | "manage_members"
  | "read_billing";
export type CustomerReadScope =
  | { kind: "staff"; roles: StaffRole[]; organizationIds: string[] }
  | { kind: "memberships"; organizationIds: string[] };
export interface CustomerAccess {
  customerId: string;
  organizationId: string | null;
  customerRole: CustomerRole | null;
  staffRoles: StaffRole[];
}

/** Called within the domain transaction; mutations lock current authority rows. */
export interface AccessPolicy {
  readScope(actor: HumanActor): Promise<AccessResult<CustomerReadScope>>;
  authorizeCustomer(
    tx: NodePgDatabase,
    actor: HumanActor,
    target: CustomerAccessTarget,
    capability: CustomerCapability,
    mutation: boolean,
  ): Promise<AccessResult<CustomerAccess>>;
  authorizeStaff(
    tx: NodePgDatabase,
    actor: HumanActor,
    roles: StaffRole[],
    mutation: boolean,
  ): Promise<AccessResult<undefined>>;
}
export interface AuditEntry {
  requestId: string;
  actor: HumanActor;
  customerId: string;
  action: "customer.profile.updated";
  targetId: string;
  changedFields: Array<"displayName" | "legalName" | "billingEmail">;
}
export interface AuditWriter {
  recordOperator(
    tx: NodePgDatabase,
    entry: {
      operatorId: string;
      customerId: string;
      action: "customer.created" | "customer.organization.bound";
      targetId: string;
    },
  ): Promise<void>;
  append(tx: NodePgDatabase, entry: AuditEntry): Promise<void>;
}

/** Headers stay in the access facade, which invokes the authentication library. */
export interface AuthenticationSession {
  actor: HumanActor;
  user: { name: string; email: string; emailVerified: boolean };
  expiresAt: string;
}
/** Better Auth adapter; no raw token or SDK object crosses this interface. */
export interface AuthenticationGateway {
  getSession(headers: Headers): Promise<AuthenticationSession | null>;
  acceptInvitation(
    headers: Headers,
    invitationId: string,
  ): Promise<{ organizationId: string; memberId: string }>;
}
export interface AccessOptions {
  pool: Pool;
  /** Separate bounded pool to the same database; authentication needs data-pool capacity while a lock is held. */
  lockPool: Pool;
  authentication: AuthenticationGateway;
  getCustomerTarget: (
    customerId: string,
  ) => Promise<CustomerAccessTarget | null>;
  getOrganizationTarget: (
    organizationId: string,
  ) => Promise<CustomerAccessTarget | null>;
  allowInvitation: (email: string) => boolean;
  signInMethods: AccessSessionResponse["signInMethods"];
  synthetic: boolean;
  baseURL: string;
  sendInvitation: (message: {
    email: string;
    invitationId: string;
    customerId: string;
  }) => Promise<void>;
}
export interface Access {
  readonly policy: AccessPolicy;
  readonly audit: AuditWriter;
  resolveActor(headers: Headers): Promise<HumanActor | null>;
  getSession(headers: Headers): Promise<AccessSessionResponse>;
  listMembers(
    actor: HumanActor,
    customerId: string,
    page?: Partial<AccountPagination>,
  ): Promise<AccessResult<MembersResponse>>;
  listInvitations(
    actor: HumanActor,
    customerId: string,
    page?: Partial<AccountPagination>,
  ): Promise<AccessResult<InvitationsResponse>>;
  inviteMember(
    headers: Headers,
    customerId: string,
    input: InviteMemberRequest,
  ): Promise<AccessResult<AccessActionResponse>>;
  acceptInvitation(
    headers: Headers,
    invitationId: string,
    input: AcceptInvitationRequest,
  ): Promise<AccessResult<AccessActionResponse>>;
  revokeInvitation(
    headers: Headers,
    customerId: string,
    invitationId: string,
    input: RevokeInvitationRequest,
  ): Promise<AccessResult<AccessActionResponse>>;
  revokeMember(
    headers: Headers,
    customerId: string,
    memberId: string,
    input: RevokeMemberRequest,
  ): Promise<AccessResult<AccessActionResponse>>;
}
