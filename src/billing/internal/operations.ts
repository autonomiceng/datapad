import { createHash } from "node:crypto";
import canonicalize from "canonicalize";
import { and, eq, inArray, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Value } from "@sinclair/typebox/value";
import { AuditRequestConflict } from "../../access";
import type {
  AccessResult,
  BillingOperationReceipt,
  HumanActor,
} from "../../access/types";
import {
  CheckEffectStatusRequestSchema,
  SetEffectsPausedRequestSchema,
  type BillingEffectScope,
  type CheckEffectStatusResponse,
  type EffectsControl,
  type SetEffectsPausedResponse,
} from "../operations-contract";
import type {
  BillingOperations,
  BillingOperationsOptions,
} from "../operations-types";
import { billingEffectControls as controls } from "./operations-schema";
import { billingCustomers } from "./invoice-schema";
import { readProviderOperations } from "./operations-reader";

/** Compose current billing-staff operations and audited controls. Retrieval dependencies must implement the read-only billing facades; no command holds a transaction across I/O. */
export function createBillingOperations(
  options: BillingOperationsOptions,
): BillingOperations {
  const {
    pool,
    deploymentKey,
    access,
    audit,
    notices,
    reconciliation,
    now = () => new Date(),
  } = options;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(deploymentKey))
    throw new Error("Invalid billing deployment");
  const db = drizzle(pool);
  const digest = (input: unknown) =>
    createHash("sha256")
      .update(canonicalize({ deploymentKey, input })!)
      .digest("hex");
  const matches = (
    receipt: BillingOperationReceipt,
    actor: HumanActor,
    hash: string,
    action: string,
  ) =>
    receipt.actorId === actor.userId &&
    receipt.digest === hash &&
    receipt.action === action;
  async function control(tx: NodePgDatabase): Promise<EffectsControl> {
    const [row] = await tx
      .select()
      .from(controls)
      .where(eq(controls.deploymentKey, deploymentKey));
    return row
      ? {
          paused: row.paused,
          version: row.version,
          updatedAt: new Date(row.updatedAt).toISOString(),
        }
      : { paused: true, version: 0, updatedAt: null };
  }
  async function readEffect(tx: NodePgDatabase, scope: BillingEffectScope) {
    return scope.kind === "notice"
      ? notices.readOperation(tx, scope)
      : ((await readProviderOperations(tx, deploymentKey, now(), scope))[0] ??
          null);
  }
  return {
    async getOperations(actor) {
      return db.transaction(async (tx) => {
        const allowed = await access.authorizeStaff(
          tx,
          actor,
          ["billing"],
          true,
        );
        if (!allowed.ok) return allowed;
        const mail = await notices.listOperations(tx, 100);
        if (mail.length) {
          const customers = await tx
            .select({
              customerId: billingCustomers.customerId,
              name: billingCustomers.name,
            })
            .from(billingCustomers)
            .where(
              and(
                eq(billingCustomers.deploymentKey, deploymentKey),
                inArray(
                  billingCustomers.customerId,
                  mail.map((row) => row.effect.customerId),
                ),
              ),
            );
          for (const row of mail)
            row.customerLabel =
              customers.find(
                (customer) => customer.customerId === row.effect.customerId,
              )?.name ?? row.customerLabel;
        }
        const operations = [
          ...(await readProviderOperations(tx, deploymentKey, now())),
          ...mail,
        ]
          .sort(
            (a, b) =>
              Date.parse(a.createdAt) - Date.parse(b.createdAt) ||
              a.effect.kind.localeCompare(b.effect.kind) ||
              a.effect.effectId.localeCompare(b.effect.effectId),
          )
          .slice(0, 100);
        return { ok: true, value: { control: await control(tx), operations } };
      });
    },
    async setEffectsPaused(actor, input) {
      if (
        !Value.Check(SetEffectsPausedRequestSchema, input) ||
        !input.reason.trim() ||
        input.reason.includes("\0") ||
        /[\uD800-\uDFFF]/u.test(input.reason)
      )
        return { ok: false, code: "invalid_request" };
      try {
        return await db.transaction(
          async (tx): Promise<AccessResult<SetEffectsPausedResponse>> => {
            const allowed = await access.authorizeStaff(
              tx,
              actor,
              ["billing"],
              true,
            );
            if (!allowed.ok) return allowed;
            const receipt = await audit.readBillingOperation(
              tx,
              input.requestId,
            );
            const hash = digest(input);
            if (receipt)
              return matches(receipt, actor, hash, "billing.effects_changed")
                ? {
                    ok: true,
                    value: { control: await control(tx), outcome: "unchanged" },
                  }
                : { ok: false, code: "conflict" };
            // Serializes creation of the absent row; guards fail closed without it.
            await tx.execute(
              sql`select pg_advisory_xact_lock(hashtextextended(${`billing-control:${deploymentKey}`},0))`,
            );
            await tx
              .select()
              .from(controls)
              .where(eq(controls.deploymentKey, deploymentKey))
              .for("update");
            const previous = await control(tx);
            if (previous.version !== input.expectedVersion)
              return { ok: false, code: "conflict" };
            const updated = {
              deploymentKey,
              paused: input.paused,
              version: previous.version + 1,
              updatedAt: now().toISOString(),
              updatedBy: actor.userId,
            };
            await tx.insert(controls).values(updated).onConflictDoUpdate({
              target: controls.deploymentKey,
              set: updated,
            });
            await audit.recordBillingOperation(tx, {
              requestId: input.requestId,
              actor,
              customerId: null,
              targetId: deploymentKey,
              action: "billing.effects_changed",
              digest: hash,
              reason: input.reason,
              previousPaused: previous.paused,
              paused: input.paused,
              version: updated.version,
              effectKind: null,
            });
            return {
              ok: true,
              value: {
                control: {
                  paused: updated.paused,
                  version: updated.version,
                  updatedAt: updated.updatedAt,
                },
                outcome: "changed",
              },
            };
          },
        );
      } catch (error) {
        if (error instanceof AuditRequestConflict)
          return { ok: false, code: "conflict" };
        throw error;
      }
    },
    async checkStatus(actor, input) {
      if (!Value.Check(CheckEffectStatusRequestSchema, input))
        return { ok: false, code: "invalid_request" };
      const authorized = await db.transaction(async (tx) => {
        const allowed = await access.authorizeStaff(
          tx,
          actor,
          ["billing"],
          true,
        );
        if (!allowed.ok) return allowed;
        const receipt = await audit.readBillingOperation(tx, input.requestId);
        if (
          receipt &&
          !matches(receipt, actor, digest(input), "billing.status_requested")
        )
          return { ok: false as const, code: "conflict" as const };
        const effect = await readEffect(tx, input.effect);
        if (!effect) return { ok: false as const, code: "not_found" as const };
        if (!receipt)
          await audit.recordBillingOperation(tx, {
            requestId: input.requestId,
            actor,
            customerId: input.effect.customerId,
            targetId: input.effect.effectId,
            action: "billing.status_requested",
            digest: digest(input),
            reason: null,
            previousPaused: null,
            paused: null,
            version: null,
            effectKind: input.effect.kind,
          });
        return { ok: true as const, value: { effect, receipt } };
      });
      if (!authorized.ok) return authorized;
      const { effect, receipt } = authorized.value;
      if (receipt)
        return { ok: true, value: { outcome: receipt.outcome ?? "pending" } };
      let outcome: Exclude<CheckEffectStatusResponse["outcome"], "pending"> =
        "unavailable";
      try {
        const scope = input.effect;
        if (scope.kind === "notice")
          outcome =
            effect.state === "needs_review" ? "needs_review" : "complete";
        else if (reconciliation) {
          switch (scope.kind) {
            case "customer":
              outcome = await reconciliation.inspectCustomer(scope.effectId);
              break;
            case "setup":
              outcome = await reconciliation.inspectSetup(scope.effectId);
              break;
            case "resolution":
              outcome = await reconciliation.inspectResolution(scope.effectId);
              break;
            case "collection":
              outcome = await reconciliation.reconcileCollection(
                effect.invoiceId!,
              );
              break;
            default:
              outcome = await reconciliation.inspectInvoice(effect.invoiceId!);
          }
        }
      } catch {
        outcome = "unavailable";
      }
      return db.transaction(
        async (tx): Promise<AccessResult<CheckEffectStatusResponse>> => {
          await audit.recordBillingOperationOutcome(tx, {
            requestId: input.requestId,
            actor,
            customerId: input.effect.customerId,
            targetId: input.effect.effectId,
            outcome,
          });
          const allowed = await access.authorizeStaff(
            tx,
            actor,
            ["billing"],
            true,
          );
          return allowed.ok ? { ok: true, value: { outcome } } : allowed;
        },
      );
    },
  };
}
