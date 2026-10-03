import type { Pool } from "pg";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type {
  AccessPolicy,
  AccessResult,
  AuditWriter,
  HumanActor,
} from "../access/types";
import type {
  BillingOperation,
  BillingEffectScope,
  BillingOperationsResponse,
  SetEffectsPausedRequest,
  SetEffectsPausedResponse,
  CheckEffectStatusRequest,
  CheckEffectStatusResponse,
} from "./operations-contract";
import type { WorkResult } from "./work-types";

/** Notifications supplies safe persisted evidence only. These methods never construct or call a sender. */
export interface BillingNoticeOperationsReader {
  /** Reads a bounded deployment-only page without payloads, destinations or keys. */
  listOperations(
    tx: NodePgDatabase,
    limit: number,
  ): Promise<BillingOperation[]>;
  /** Reads the exact deployment/customer/notice scope, including terminal evidence. */
  readOperation(
    tx: NodePgDatabase,
    scope: BillingEffectScope,
  ): Promise<BillingOperation | null>;
}
export interface BillingOperationsOptions {
  pool: Pool;
  deploymentKey: string;
  access: Pick<AccessPolicy, "authorizeStaff">;
  audit: AuditWriter;
  notices: BillingNoticeOperationsReader;
  reconciliation: {
    /** Recovers an attempted mapping without dispatch. */
    inspectCustomer(customerId: string): Promise<WorkResult>;
    /** Retrieves invoice and line evidence without advancing issuance. */
    inspectInvoice(invoiceId: string): Promise<WorkResult>;
    /** Retrieves an existing setup without starting another session. */
    inspectSetup(setupId: string): Promise<WorkResult>;
    /** Inspects settlement evidence without settling or voiding. */
    inspectResolution(resolutionId: string): Promise<WorkResult>;
    /** Inspects the existing invoice payment without charging. */
    reconcileCollection(invoiceId: string): Promise<WorkResult>;
  } | null;
  /** Wall clock for safe queue eligibility and command timestamps. */
  now?: () => Date;
}
export interface BillingOperations {
  /** Requires current billing staff authority; returns at most 100 safe persisted effects with no network I/O. */
  getOperations(
    actor: HumanActor,
  ): Promise<AccessResult<BillingOperationsResponse>>;
  /** Serializes current authority, expected version, command identity, control and audit. A replay never changes later control state. */
  setEffectsPaused(
    actor: HumanActor,
    input: SetEffectsPausedRequest,
  ): Promise<AccessResult<SetEffectsPausedResponse>>;
  /** Audits the exact scoped request before retrieval and outcome afterwards. Never dispatches a provider or SMTP write, including when unpaused. */
  checkStatus(
    actor: HumanActor,
    input: CheckEffectStatusRequest,
  ): Promise<AccessResult<CheckEffectStatusResponse>>;
}
