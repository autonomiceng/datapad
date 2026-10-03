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
  | "manage_services"
  | "read_members"
  | "manage_members"
  | "read_billing"
  | "manage_billing";
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
interface AuditEntryIdentity {
  requestId: string;
  actor: HumanActor;
  customerId: string;
  targetId: string;
}
export type AuditEntry = AuditEntryIdentity &
  (
    | {
        action: "customer.profile.updated";
        changedFields: Array<"displayName" | "legalName" | "billingEmail">;
      }
    | {
        action: "service.component_preference.updated";
        changedFields: Array<"requestedSetting">;
      }
    | {
        action: "invoice.prepared";
        changedFields: Array<"billTo" | "lines" | "issueDate" | "dueDate">;
      }
    | {
        action: "invoice.issue_requested";
        changedFields: Array<"issueRequestedAt">;
      }
    | {
        action: "subscription.created";
        changedFields: Array<
          | "serviceId"
          | "anchors"
          | "firstUnbilledPeriodIndex"
          | "terms"
          | "calendarPolicy"
        >;
      }
    | {
        action: "subscription.changed";
        changedFields: Array<"terms" | "billingState" | "cancellation">;
      }
    | {
        action: "billing_schedule.changed";
        changedFields: Array<"activation" | "issuancePaused">;
        selections: Array<{
          subscriptionId: string;
          firstUnbilledPeriodIndex: number;
          activationFromPeriodIndex: number;
        }>;
      }
    | {
        action: "forecast.materialized";
        changedFields: Array<"periods">;
      }
    | {
        action: "service.addon.attached";
        changedFields: Array<"attachedServiceId">;
      }
  );
export interface AuditWriter {
  /** Locks and checks an identity without reserving it for a no-op. */
  assertRequestUnused(tx: NodePgDatabase, requestId: string): Promise<void>;
  getServicesBootstrap(
    tx: NodePgDatabase,
    bootstrapKey: string,
  ): Promise<{ manifestDigest: string } | null>;
  recordServicesBootstrap(
    tx: NodePgDatabase,
    input: {
      operatorId: string;
      bootstrapKey: string;
      manifestDigest: string;
    },
  ): Promise<void>;

  recordOperator(
    tx: NodePgDatabase,
    entry: {
      operatorId: string;
      customerId: string;
      targetId: string;
    } & (
      | {
          action:
            | "customer.created"
            | "customer.organization.bound"
            | "service.created";
        }
      | { action: "invoice_group.sealed"; requestId: string }
    ),
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
