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
  | "manage_billing"
  | "manage_payment_settings"
  | "read_support"
  | "request_support"
  | "manage_support"
  | "approve_support";
export type CustomerReadScope =
  | { kind: "staff"; roles: StaffRole[]; organizationIds: string[] }
  | { kind: "memberships"; organizationIds: string[] };
export interface CustomerAccess {
  customerId: string;
  organizationId: string | null;
  customerRole: CustomerRole | null;
  customerMembership: {
    id: string;
    invitationId: string | null;
    invitedByUserId: string | null;
    invitedByStaff: boolean | null;
  } | null;
  staffRoles: StaffRole[];
}

/** Authorization uses caller transactions; readScope computes current visibility. */
export interface AccessPolicy {
  /**
   * Recheck the verified, unexpired session and return current staff roles
   * and organization memberships.
   */
  readScope(actor: HumanActor): Promise<AccessResult<CustomerReadScope>>;
  /**
   * Check a capability for the caller-resolved current customer binding in
   * its transaction. Set mutation to hold shared authority locks until commit.
   */
  authorizeCustomer(
    tx: NodePgDatabase,
    actor: HumanActor,
    target: CustomerAccessTarget,
    capability: CustomerCapability,
    mutation: boolean,
  ): Promise<AccessResult<CustomerAccess>>;
  /**
   * Require at least one listed staff role in the caller transaction;
   * mutation locks current authority rows.
   */
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
        action:
          | "ticket.opened"
          | "ticket.replied"
          | "ticket.note_added"
          | "ticket.proposed"
          | "ticket.approved"
          | "ticket.result_recorded";
        changedFields: Array<
          "ticket" | "reply" | "note" | "proposal" | "approval" | "result"
        >;
        support: {
          ticketVersion: number;
          entryId?: string;
          proposalId?: string;
          proposalVersion?: number;
          approvalId?: string;
        };
      }
    | {
        action: "payment_setup.started";
        changedFields: ["saveTerms"];
        consentingMembershipId: string;
        membershipProvenance: {
          invitationId: string | null;
          invitedByUserId: string | null;
          invitedByStaff: boolean | null;
        };
      }
    | {
        action: "payment_enrollment.changed";
        changedFields: ["method", "scopes"];
        consentingMembershipId: string;
        membershipProvenance: {
          invitationId: string | null;
          invitedByUserId: string | null;
          invitedByStaff: boolean | null;
        };
      }
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
        action: "invoice.external_payment_recorded";
        changedFields: Array<"receipt">;
      }
    | {
        action: "invoice.void_requested";
        changedFields: Array<"reason">;
      }
    | {
        action: "invoice.receipt_correction_requested";
        changedFields: Array<"correction">;
        reason: string;
      }
    | {
        action: "invoice.resolution_reconciled";
        changedFields: Array<"state">;
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
export interface BillingOperationAudit {
  requestId: string;
  actor: HumanActor;
  customerId: string | null;
  targetId: string;
  action: "billing.effects_changed" | "billing.status_requested";
  digest: string;
  reason: string | null;
  previousPaused: boolean | null;
  paused: boolean | null;
  version: number | null;
  effectKind: string | null;
}
export interface BillingOperationReceipt {
  actorId: string;
  sessionId: string | null;
  action: string;
  digest: string | null;
  outcome: "complete" | "retry" | "needs_review" | "unavailable" | null;
}
export interface AuditWriter {
  /** Serializes the command request identity and reads its safe receipt; a foreign action remains a conflicting receipt. */
  readBillingOperation(
    tx: NodePgDatabase,
    requestId: string,
  ): Promise<BillingOperationReceipt | null>;
  /** Appends staff control or retrieval authorization in the same transaction as its local command. */
  recordBillingOperation(
    tx: NodePgDatabase,
    entry: BillingOperationAudit,
  ): Promise<void>;
  /** Appends a separate safe retrieval outcome linked to the original request after network I/O. */
  recordBillingOperationOutcome(
    tx: NodePgDatabase,
    entry: {
      requestId: string;
      actor: HumanActor;
      customerId: string;
      targetId: string;
      outcome: "complete" | "retry" | "needs_review" | "unavailable";
    },
  ): Promise<void>;
  /** Locks and checks an identity without reserving it for a no-op. */
  assertRequestUnused(tx: NodePgDatabase, requestId: string): Promise<void>;
  /** Read the manifest digest recorded for a bootstrap key; malformed receipts throw. */
  getServicesBootstrap(
    tx: NodePgDatabase,
    bootstrapKey: string,
  ): Promise<{ manifestDigest: string } | null>;
  /** Append the bootstrap receipt in the caller transaction; the caller owns replay checks. */
  recordServicesBootstrap(
    tx: NodePgDatabase,
    input: {
      operatorId: string;
      bootstrapKey: string;
      manifestDigest: string;
    },
  ): Promise<void>;

  /**
   * Append an operator audit record in the caller transaction; operator
   * authorization belongs to composition.
   */
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
            | "service.created"
            | "invoice.resolution_attempted"
            | "invoice.resolution_confirmed"
            | "invoice.resolution_needs_review";
        }
      | {
          action:
            | "invoice.notice_attempted"
            | "invoice.notice_accepted"
            | "invoice.notice_suppressed"
            | "invoice.notice_needs_review";
          invoiceId: string;
          noticeId: string;
          stage: "invoice" | "before_due" | "due" | "overdue";
          reason: string | null;
          attempts: number;
          recipientSource: "billing_contact";
          profileVersion: number | null;
        }
      | { action: "invoice_group.sealed"; requestId: string }
      | {
          action: "invoice.collection_attempted";
          invoiceId: string;
          attemptId: string;
          dispatchCount: number;
          enrollmentId: string;
        }
      | {
          action:
            | "invoice.collection_processing"
            | "invoice.collection_succeeded";
          invoiceId: string;
          attemptId: string;
        }
      | {
          action: "invoice.collection_failed";
          invoiceId: string;
          attemptId: string;
          reason: "declined";
        }
      | {
          action: "invoice.collection_requires_action";
          invoiceId: string;
          attemptId: string;
          reason: "authentication_required";
        }
      | {
          action: "invoice.collection_needs_review";
          invoiceId: string;
          attemptId: string;
          reason:
            | "provider_unavailable"
            | "consent_changed"
            | "method_unavailable"
            | "resolution_conflict"
            | "amount_changed"
            | "competing_payment"
            | "provider_mismatch"
            | "uncertain_outcome"
            | "retry_exhausted";
        }
      | {
          action: "invoice.collection_missed";
          invoiceId: string;
          reason: "missed";
        }
    ),
  ): Promise<void>;
  /**
   * Record changed profile fields atomically with the caller write. Reused
   * profile request IDs throw AuditRequestConflict.
   */
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
  /**
   * Read the library session with cookie caching disabled; callers must check
   * email verification and current domain authority.
   */
  getSession(headers: Headers): Promise<AuthenticationSession | null>;
  /**
   * Invoke library invitation acceptance for the supplied session. The
   * access facade owns recipient checks and organization serialization.
   */
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
  /**
   * Resolve the current customer-to-organization mapping, or null if
   * absent; this lookup grants no authority.
   */
  getCustomerTarget: (
    customerId: string,
  ) => Promise<CustomerAccessTarget | null>;
  /**
   * Resolve an invitation organization to its customer, or null when no
   * customer is bound.
   */
  getOrganizationTarget: (
    organizationId: string,
  ) => Promise<CustomerAccessTarget | null>;
  /**
   * Approve invitation recipients against the reviewed synthetic dataset;
   * creation passes a lowercase email.
   */
  allowInvitation: (email: string) => boolean;
  signInMethods: AccessSessionResponse["signInMethods"];
  synthetic: boolean;
  baseURL: string;
  /**
   * Deliver an already committed invitation. Pending request replays may
   * call again; rejection leaves delivery pending.
   */
  sendInvitation: (message: {
    email: string;
    invitationId: string;
    customerId: string;
  }) => Promise<void>;
}
/** Membership commands require a verified session and the configured Origin. */
export interface Access {
  readonly policy: AccessPolicy;
  readonly audit: AuditWriter;
  /**
   * Resolve identity only for an email-verified session; each domain
   * operation must recheck current authority.
   */
  resolveActor(headers: Headers): Promise<HumanActor | null>;
  /**
   * Return sign-in options and current staff roles; absent or expired
   * sessions appear signed out.
   */
  getSession(headers: Headers): Promise<AccessSessionResponse>;
  /**
   * List recognized roles in the customer organization after checking
   * read_members authority, with bounded pagination.
   */
  listMembers(
    actor: HumanActor,
    customerId: string,
    page?: Partial<AccountPagination>,
  ): Promise<AccessResult<MembersResponse>>;
  /**
   * List invitations for the customer organization after checking
   * read_members authority; expiry is evaluated at read time.
   */
  listInvitations(
    actor: HumanActor,
    customerId: string,
    page?: Partial<AccountPagination>,
  ): Promise<AccessResult<InvitationsResponse>>;
  /**
   * Require member-management authority, persist an invitation, then
   * deliver it. Matching request replays resume pending delivery.
   */
  inviteMember(
    headers: Headers,
    customerId: string,
    input: InviteMemberRequest,
  ): Promise<AccessResult<AccessActionResponse>>;
  /**
   * Require the verified recipient session and reconcile library acceptance
   * under the organization lock; pending is not a membership grant.
   */
  acceptInvitation(
    headers: Headers,
    invitationId: string,
    input: AcceptInvitationRequest,
  ): Promise<AccessResult<AccessActionResponse>>;
  /**
   * Cancel a scoped invitation under current member-management authority;
   * accepted invitations conflict and matching request IDs replay.
   */
  revokeInvitation(
    headers: Headers,
    customerId: string,
    invitationId: string,
    input: RevokeInvitationRequest,
  ): Promise<AccessResult<AccessActionResponse>>;
  /**
   * Remove a scoped membership under current member-management authority;
   * preserve the last administrator and replay matching request IDs.
   */
  revokeMember(
    headers: Headers,
    customerId: string,
    memberId: string,
    input: RevokeMemberRequest,
  ): Promise<AccessResult<AccessActionResponse>>;
}
