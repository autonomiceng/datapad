import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Value } from "@sinclair/typebox/value";
import canonicalize from "canonicalize";
import { AuditRequestConflict } from "../../access";
import type { AccessResult, HumanActor } from "../../access/types";
import {
  PrepareInvoiceRequestSchema,
  type InvoicePreparationResponse,
  type InvoiceRequest,
} from "../contract";
import type { BillingWorkflow, BillingWorkflowOptions } from "../types";
import { billingCustomers, invoices } from "./schema";
import { createReader } from "./queries";
import { createLifecycle } from "./lifecycle";
import { ensureMapping, persistInvoice } from "./requests";
import { isUuid, requestDigest, validateRequest } from "./validate";

/** Composes scoped staff billing operations with audited synthetic intentions.
 * Provider ownership must match the deployment; callers dispatch issuance only after confirmation commits. */
export function createBillingWorkflow(
  options: BillingWorkflowOptions,
): BillingWorkflow {
  if (
    !/^[A-Za-z0-9_-]{1,64}$/.test(options.deploymentKey) ||
    options.deploymentKey !== options.provider.ownership.deploymentKey ||
    !options.provider.ownership.accountId
  )
    throw new Error("Billing provider ownership differs from deployment");
  const {
    pool,
    deploymentKey,
    customerAccess,
    audit,
    allowRequest,
    now = () => new Date(),
  } = options;
  const db = drizzle(pool);
  const reader = createReader(options);
  const lifecycle = createLifecycle(options);
  const target = (customerId: string, invoiceId: string) =>
    and(
      eq(invoices.deploymentKey, deploymentKey),
      eq(invoices.id, invoiceId),
      eq(billingCustomers.customerId, customerId),
    );
  async function load(
    tx: NodePgDatabase,
    customerId: string,
    invoiceId: string,
    mutation = false,
  ) {
    const query = tx
      .select({ invoice: invoices, mapping: billingCustomers })
      .from(invoices)
      .innerJoin(
        billingCustomers,
        eq(invoices.billingCustomerId, billingCustomers.id),
      )
      .where(target(customerId, invoiceId));
    const [row] = await (mutation
      ? query.for("update", { of: invoices })
      : query);
    return row;
  }
  function blocker(
    row: NonNullable<Awaited<ReturnType<typeof load>>>,
  ): InvoicePreparationResponse["issueBlocker"] {
    if (row.invoice.issueRequestedAt) return "already_issued";
    if (row.invoice.state === "needs_review") return "needs_review";
    if (row.invoice.billToName !== row.mapping.name)
      return "provider_profile_pending";
    if (now().getTime() >= Date.parse(row.invoice.firstAttemptBefore))
      return "past_due";
    return null;
  }
  async function authorized(
    actor: HumanActor,
    customerId: string,
    invoiceId: string,
    capability: "manage_billing" | "read_billing" = "manage_billing",
  ) {
    if (!isUuid(customerId) || !isUuid(invoiceId))
      return { ok: false, code: "not_found" } as const;
    return db.transaction(async (tx) => {
      const access = await customerAccess.authorizeCustomer(
        tx,
        actor,
        customerId,
        capability,
        false,
      );
      if (!access.ok) return access;
      const row = await load(tx, customerId, invoiceId);
      if (!row) return { ok: false, code: "not_found" } as const;
      const canManageBilling =
        capability === "manage_billing" ||
        (
          await customerAccess.authorizeCustomer(
            tx,
            actor,
            customerId,
            "manage_billing",
            false,
          )
        ).ok;
      return { ok: true, value: { ...row, canManageBilling } } as const;
    });
  }
  async function getPreparation(
    actor: HumanActor,
    customerId: string,
    invoiceId: string,
  ): Promise<AccessResult<InvoicePreparationResponse>> {
    const access = await authorized(actor, customerId, invoiceId);
    if (!access.ok) return access;
    const response = await reader.getInvoiceForCustomers(
      [customerId],
      invoiceId,
    );
    return response
      ? {
          ok: true,
          value: { ...response, issueBlocker: blocker(access.value) },
        }
      : { ok: false, code: "not_found" };
  }
  return {
    getPreparation,
    async prepareInvoice(actor, customerId, input) {
      if (
        !isUuid(customerId) ||
        !Value.Check(PrepareInvoiceRequestSchema, input)
      )
        return { ok: false, code: "invalid_request" };
      try {
        const result: AccessResult<{
          invoiceId: string;
          outcome: "created" | "unchanged";
        }> = await db.transaction(async (tx) => {
          const access = await customerAccess.authorizeCustomer(
            tx,
            actor,
            customerId,
            "manage_billing",
            true,
          );
          if (!access.ok) return access;
          const originKey = `staff:${input.requestId}`;
          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(hashtextextended(${`request:${deploymentKey}:${originKey}`},0))`,
          );
          const [existing] = await tx
            .select({ invoice: invoices, mapping: billingCustomers })
            .from(invoices)
            .innerJoin(
              billingCustomers,
              eq(invoices.billingCustomerId, billingCustomers.id),
            )
            .where(
              and(
                eq(invoices.deploymentKey, deploymentKey),
                eq(invoices.originKey, originKey),
              ),
            );
          if (existing) {
            const request: InvoiceRequest = {
              originKey,
              customer: {
                key: existing.mapping.key,
                name: existing.invoice.requestCustomerName,
              },
              issueDate: existing.invoice.issueDate,
              dueDate: input.dueDate,
              currency: input.currency,
              lines: input.lines.map((line) => ({ ...line, originRef: null })),
            };
            if (
              existing.mapping.customerId !== customerId ||
              existing.invoice.billToProfileVersion !==
                input.expectedCustomerVersion ||
              existing.invoice.requestDigest !== requestDigest(request)
            )
              return { ok: false, code: "conflict" };
            return {
              ok: true,
              value: { invoiceId: existing.invoice.id, outcome: "unchanged" },
            };
          }
          const account = await customerAccess.readProfile(tx, customerId);
          if (!account) return { ok: false, code: "not_found" };
          if (account.version !== input.expectedCustomerVersion)
            return { ok: false, code: "conflict" };
          const createdAt = now().toISOString();
          const [existingMapping] = await tx
            .select()
            .from(billingCustomers)
            .where(
              and(
                eq(billingCustomers.deploymentKey, deploymentKey),
                eq(billingCustomers.customerId, customerId),
              ),
            );
          const request = validateRequest({
            originKey,
            customer: {
              key: existingMapping?.key ?? `customer:${customerId}`,
              name: account.profile.legalName,
            },
            issueDate: createdAt.slice(0, 10),
            dueDate: input.dueDate,
            currency: input.currency,
            lines: input.lines.map((line) => ({ ...line, originRef: null })),
          });
          if (
            !request ||
            !allowRequest({
              request,
              customerId,
              billTo: {
                legalName: account.profile.legalName,
                billingEmail: account.profile.billingEmail,
                profileVersion: account.version,
              },
            })
          )
            return { ok: false, code: "invalid_request" };
          const mapping = await ensureMapping(
            tx,
            options,
            account,
            request.customer.key,
            account.profile.legalName,
            createdAt,
          );
          if (!mapping) return { ok: false, code: "conflict" };
          if (request.customer.key !== mapping.key) {
            request.customer.key = mapping.key;
            if (
              !allowRequest({
                request,
                customerId,
                billTo: {
                  legalName: account.profile.legalName,
                  billingEmail: account.profile.billingEmail,
                  profileVersion: account.version,
                },
              })
            )
              return { ok: false, code: "conflict" };
          }
          const invoiceId = await persistInvoice(
            tx,
            deploymentKey,
            request,
            account,
            mapping.id,
            createdAt,
          );
          await audit.append(tx, {
            requestId: input.requestId,
            actor,
            customerId,
            targetId: invoiceId,
            action: "invoice.prepared",
            changedFields: ["billTo", "lines", "issueDate", "dueDate"],
          });
          return { ok: true, value: { invoiceId, outcome: "created" } };
        });
        if (!result.ok) return result;
        const response = await getPreparation(
          actor,
          customerId,
          result.value.invoiceId,
        );
        return response.ok
          ? {
              ok: true,
              value: { ...response.value, outcome: result.value.outcome },
            }
          : response;
      } catch (error) {
        if (error instanceof AuditRequestConflict)
          return { ok: false, code: "conflict" };
        throw error;
      }
    },
    async confirmIssue(actor, customerId, invoiceId) {
      if (!isUuid(customerId) || !isUuid(invoiceId))
        return { ok: false, code: "not_found" };
      try {
        return await db.transaction(async (tx) => {
          const access = await customerAccess.authorizeCustomer(
            tx,
            actor,
            customerId,
            "manage_billing",
            true,
          );
          if (!access.ok) return access;
          const row = await load(tx, customerId, invoiceId, true);
          if (!row) return { ok: false, code: "not_found" };
          if (row.invoice.issueRequestedAt)
            return { ok: true, value: { outcome: "unchanged", invoiceId } };
          if (
            blocker(row) ||
            now().getTime() < Date.parse(row.invoice.issueNotBefore) ||
            now().toISOString().slice(0, 10) < row.invoice.readinessDate
          )
            return { ok: false, code: "conflict" };
          await tx
            .update(invoices)
            .set({ issueRequestedAt: now().toISOString(), state: "preparing" })
            .where(eq(invoices.id, invoiceId));
          await audit.append(tx, {
            requestId: randomUUID(),
            actor,
            customerId,
            targetId: invoiceId,
            action: "invoice.issue_requested",
            changedFields: ["issueRequestedAt"],
          });
          return { ok: true, value: { outcome: "accepted", invoiceId } };
        });
      } catch (error) {
        if (error instanceof AuditRequestConflict)
          return { ok: false, code: "conflict" };
        throw error;
      }
    },
    async checkInvoice(actor, customerId, invoiceId) {
      const access = await authorized(
        actor,
        customerId,
        invoiceId,
        "read_billing",
      );
      if (!access.ok) return access;
      const check = {
        explicitCheck: true,
        canManageBilling: access.value.canManageBilling,
      } as const;
      const collection = options.invoiceCollections
        ? await options.invoiceCollections.getCollectionDisposition(
            invoiceId,
            check,
          )
        : null;
      if (!options.invoiceCollections)
        await lifecycle.refreshInvoice(invoiceId, check);
      const current = await authorized(
        actor,
        customerId,
        invoiceId,
        "read_billing",
      );
      if (!current.ok) return current;
      const response = await reader.getInvoiceForCustomers(
        [customerId],
        invoiceId,
      );
      // Method availability is fresh provider evidence that the SQL-only reader cannot infer.
      // Reject an overlay if any persisted collection facts changed after the shared lock.
      if (
        response &&
        collection?.checkedAt &&
        collection.disposition.kind === "payable" &&
        collection.disposition.reason === "not_authorized" &&
        response.invoice.collection.disposition.kind === "defer" &&
        response.invoice.collection.disposition.reason === "awaiting_collection"
      ) {
        const age = now().getTime() - Date.parse(collection.checkedAt);
        if (
          age >= 0 &&
          age <= 5000 &&
          canonicalize({
            ...response.invoice.collection,
            disposition: collection.disposition,
          }) === canonicalize(collection)
        ) {
          response.invoice.collection = collection;
          response.invoice.hostedInvoiceUrl =
            current.value.invoice.hostedInvoiceUrl?.startsWith(
              "https://invoice.stripe.com/",
            )
              ? current.value.invoice.hostedInvoiceUrl
              : null;
        }
      }
      return response
        ? { ok: true, value: response }
        : { ok: false, code: "not_found" };
    },
  };
}
