import { randomUUID } from "node:crypto";
import { lockSubscriptionCustomer } from "./subscription-lock";
import { freezeEnrollment } from "./payment-enrollment";
import canonicalize from "canonicalize";
import { Temporal } from "@js-temporal/polyfill";
import { and, asc, desc, eq, gte, lte, inArray, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Value } from "@sinclair/typebox/value";
import { AuditRequestConflict } from "../../access";
import type { AccessResult, HumanActor } from "../../access/types";
import type { AccessErrorCode } from "../../access/contract";
import type { RegisteredCustomer } from "../../customers/types";
import {
  ConfigureScheduleRequestSchema,
  ScheduledGroupsQuerySchema,
  type ScheduleResponse,
  type ScheduledGroup,
  type ScheduledGroupsQuery,
  type ScheduleReviewReason,
} from "../scheduled-contract";
import type {
  ScheduledBilling,
  ScheduledBillingOptions,
  ScheduleCursor,
  ScheduledInvoiceRequest,
} from "../scheduled-types";
import {
  billingSchedules as schedules,
  billingInvoiceGroups as groups,
} from "./scheduled-schema";
import {
  billingSubscriptions as subscriptions,
  billingSubscriptionTerms as terms,
  billingPeriods as periods,
} from "./subscriptions-schema";
import { billingCustomers, invoices, invoiceLines } from "./invoice-schema";
import {
  buildForecast,
  derivePeriod,
  effectiveTerms,
  samePeriod,
  type Subscription,
  type SubscriptionTerm,
  type BillingPeriod,
} from "./forecast";
import {
  periodBoundary,
  indicesInWindow,
  localToday,
  horizon,
  validateWindow,
  validateCalendar,
  periodInstants,
} from "./calendar";
import { ensureMapping, persistInvoice } from "./requests";
import { isUuid, requestDigest, validateScheduledRequest } from "./validate";

class ScheduleFailure extends Error {
  constructor(readonly code: AccessErrorCode) {
    super(code);
  }
}
class SealRejected extends Error {
  constructor(readonly reason: ScheduleReviewReason) {
    super(reason);
  }
}
function fail(code: AccessErrorCode): never {
  throw new ScheduleFailure(code);
}
const instant = (value: string) => new Date(value).toISOString();
const equal = (a: unknown, b: unknown) => canonicalize(a) === canonicalize(b);
function result(error: unknown): AccessResult<never> {
  if (error instanceof ScheduleFailure) return { ok: false, code: error.code };
  if (error instanceof AuditRequestConflict)
    return { ok: false, code: "conflict" };
  if (error instanceof RangeError)
    return { ok: false, code: "invalid_request" };
  throw error;
}

export function createScheduledBilling(
  options: ScheduledBillingOptions,
): ScheduledBilling {
  const {
    pool,
    deploymentKey,
    providerOwnership,
    customerAccess,
    audit,
    workerId,
    allowSubscription,
    allowRequest,
    now = () => new Date(),
  } = options;
  if (
    !/^[A-Za-z0-9_-]{1,64}$/.test(deploymentKey) ||
    providerOwnership.deploymentKey !== deploymentKey ||
    !providerOwnership.accountId ||
    !workerId.trim()
  )
    throw new Error("Invalid scheduled billing configuration");
  const db = drizzle(pool);
  const scheduleScope = (customerId: string) =>
    and(
      eq(schedules.customerId, customerId),
      eq(schedules.deploymentKey, deploymentKey),
    );
  const subScope = (customerId: string) =>
    and(
      eq(subscriptions.customerId, customerId),
      eq(subscriptions.deploymentKey, deploymentKey),
    );
  async function lock(tx: NodePgDatabase, customerId: string) {
    await lockSubscriptionCustomer(tx, deploymentKey, customerId);
  }
  async function authorize(
    tx: NodePgDatabase,
    actor: HumanActor,
    customerId: string,
    mutation: boolean,
  ) {
    if (!isUuid(customerId)) fail("not_found");
    const access = await customerAccess.authorizeCustomer(
      tx,
      actor,
      customerId,
      mutation ? "manage_billing" : "read_billing",
      mutation,
    );
    if (!access.ok) fail(access.code);
    if (mutation) await lock(tx, customerId);
    return access.value.staffRoles.includes("billing");
  }
  async function load(tx: NodePgDatabase, customerId: string) {
    const all = await tx
      .select()
      .from(subscriptions)
      .where(subScope(customerId))
      .orderBy(asc(subscriptions.id))
      .limit(101);
    if (all.length > 100) throw new RangeError("Too many subscriptions");
    const revisions: SubscriptionTerm[] = all.length
      ? await tx
          .select()
          .from(terms)
          .where(
            inArray(
              terms.subscriptionId,
              all.map((sub) => sub.id),
            ),
          )
      : [];
    return { all, revisions };
  }
  function allowed(
    sub: Subscription,
    revisions: SubscriptionTerm[],
    index: number,
  ) {
    const value = effectiveTerms(sub, revisions, index);
    return allowSubscription({
      customerId: sub.customerId,
      serviceId: sub.serviceId,
      periodAnchorDate: sub.periodAnchorDate,
      dueAnchorDate: sub.dueAnchorDate,
      intervalMonths: sub.intervalMonths,
      firstUnbilledPeriodIndex: sub.firstUnbilledPeriodIndex,
      calendar: sub.calendar,
      cancellationReason: sub.cancellationReason,
      label: value.label,
      amountMinor: value.amountMinor,
      paymentArrangement: value.paymentArrangement,
    });
  }
  async function scheduleView(
    tx: NodePgDatabase,
    customerId: string,
    canManage: boolean,
  ): Promise<ScheduleResponse> {
    const [schedule] = await tx
      .select()
      .from(schedules)
      .where(scheduleScope(customerId));
    const { all } = await load(tx, customerId);
    const outstanding = await tx
      .select({
        invoice: invoices,
        mapping: billingCustomers,
        total: sql<number>`count(*) over()`.mapWith(Number),
      })
      .from(groups)
      .innerJoin(invoices, eq(groups.invoiceId, invoices.id))
      .innerJoin(
        billingCustomers,
        eq(groups.billingCustomerId, billingCustomers.id),
      )
      .where(
        and(
          eq(groups.customerId, customerId),
          eq(groups.deploymentKey, deploymentKey),
          inArray(invoices.state, ["preparing", "draft", "needs_review"]),
          sql`(${invoices.createAttemptedAt} is not null or ${invoices.finalizeAttemptedAt} is not null or (${billingCustomers.createAttemptedAt} is not null and ${billingCustomers.providerCustomerId} is null))`,
        ),
      )
      .orderBy(asc(invoices.createdAt), asc(invoices.id))
      .limit(100);
    const continuing = outstanding;
    return {
      schedule: {
        customerId,
        version: schedule?.version ?? 0,
        issuancePaused: schedule?.issuancePaused ?? false,
        canManage,
        activations: all.flatMap((sub) => {
          if (sub.activationFromPeriodIndex === null || !sub.activatedAt)
            return [];
          const index = sub.activationFromPeriodIndex;
          const first = periodBoundary(sub, sub.firstUnbilledPeriodIndex);
          const last =
            index > sub.firstUnbilledPeriodIndex
              ? periodBoundary(sub, index - 1)
              : null;
          return [
            {
              subscriptionId: sub.id,
              activationFromPeriodIndex: index,
              firstPeriod: periodBoundary(sub, index),
              activatedAt: instant(sub.activatedAt),
              beforeActivation: last
                ? {
                    fromPeriodIndex: first.periodIndex,
                    throughPeriodIndex: last.periodIndex,
                    periodStart: first.periodStart,
                    periodEnd: last.periodEnd,
                    fromDueDate: first.dueDate,
                    throughDueDate: last.dueDate,
                  }
                : null,
            },
          ];
        }),
        continuing: continuing.slice(0, 100).map(({ invoice, mapping }) => ({
          invoiceId: invoice.id,
          customerCreateAttempted: mapping.createAttemptedAt !== null,
          invoiceCreateAttempted: invoice.createAttemptedAt !== null,
          finalizeAttempted: invoice.finalizeAttemptedAt !== null,
        })),
        continuingTotal: continuing[0]?.total ?? 0,
      },
    };
  }
  function active(all: Subscription[]) {
    return all
      .filter((sub) => sub.activationFromPeriodIndex !== null)
      .map((sub) => ({
        ...sub,
        firstUnbilledPeriodIndex: sub.activationFromPeriodIndex!,
      }));
  }
  async function facts(
    tx: NodePgDatabase,
    customerId: string,
    all: Subscription[],
    revisions: SubscriptionTerm[],
    query: ScheduledGroupsQuery,
  ) {
    const activated = active(all);
    const stored = await tx
      .select()
      .from(periods)
      .where(
        and(
          eq(periods.customerId, customerId),
          eq(periods.deploymentKey, deploymentKey),
          gte(periods.dueDate, query.fromDueDate),
          lte(periods.dueDate, query.throughDueDate),
        ),
      );
    const expected: BillingPeriod[] = [];
    for (const sub of activated)
      for (const index of indicesInWindow(
        sub,
        sub.firstUnbilledPeriodIndex,
        query.fromDueDate,
        query.throughDueDate,
      )) {
        if (expected.length >= 3700) throw new RangeError("Too many periods");
        const previous = stored.find(
          (row) => row.subscriptionId === sub.id && row.periodIndex === index,
        );
        expected.push(
          previous?.sealedAt
            ? previous
            : {
                id: previous?.id ?? randomUUID(),
                invoiceGroupId: null,
                sealedAt: null,
                ...derivePeriod(sub, revisions, index),
              },
        );
      }
    const forecast = buildForecast(
      activated,
      revisions,
      expected,
      { ...query, limit: 3700, offset: 0 },
      now(),
    );
    return { stored, expected, forecast };
  }
  function requestFor(
    id: string,
    account: RegisteredCustomer,
    key: string,
    group: ScheduledGroup,
  ): ScheduledInvoiceRequest {
    const request = validateScheduledRequest(
      {
        originKey: `scheduled:${id}`,
        customer: { key, name: account.profile.legalName },
        issueDate: Temporal.PlainDate.from(group.dueDate)
          .subtract({ days: 21 })
          .toString(),
        dueDate: group.dueDate,
        calendar: group.calendar,
        issueNotBefore: group.issueAt && instant(group.issueAt),
        firstAttemptBefore: group.dueEndAt && instant(group.dueEndAt),
        dueEndAt: group.dueEndAt && instant(group.dueEndAt),
        currency: "USD",
        lines: group.periods
          .filter((period) => period.billingState === "billable")
          .map((period) => ({
            description: period.label,
            amountMinor: period.amountMinor,
            originRef: period.id,
          })),
      },
      group.totalMinor === 0,
    );
    if (
      !request ||
      !allowRequest({
        request,
        customerId: account.customerId,
        billTo: {
          legalName: account.profile.legalName,
          billingEmail: account.profile.billingEmail,
          profileVersion: account.version,
        },
      })
    )
      throw new SealRejected("ownership_mismatch");
    return request;
  }
  async function projections(
    tx: NodePgDatabase,
    account: RegisteredCustomer,
    all: Subscription[],
    revisions: SubscriptionTerm[],
    query: ScheduledGroupsQuery,
  ) {
    const { stored, expected, forecast } = await facts(
      tx,
      account.customerId,
      all,
      revisions,
      query,
    );
    const sealed = await tx
      .select()
      .from(groups)
      .where(
        and(
          eq(groups.customerId, account.customerId),
          eq(groups.deploymentKey, deploymentKey),
          gte(groups.dueDate, query.fromDueDate),
          lte(groups.dueDate, query.throughDueDate),
        ),
      );
    const [schedule] = await tx
      .select()
      .from(schedules)
      .where(scheduleScope(account.customerId));
    const [mapping] = await tx
      .select()
      .from(billingCustomers)
      .where(
        and(
          eq(billingCustomers.customerId, account.customerId),
          eq(billingCustomers.deploymentKey, deploymentKey),
        ),
      );
    const linkedIds = sealed.flatMap((group) =>
      group.invoiceId ? [group.invoiceId] : [],
    );
    const linked = linkedIds.length
      ? await tx.select().from(invoices).where(inArray(invoices.id, linkedIds))
      : [];
    const output: ScheduledGroup[] = [];
    for (const candidate of forecast.groups) {
      const receipt = sealed.find(
        (group) =>
          group.dueDate === candidate.dueDate &&
          group.paymentArrangement === candidate.paymentArrangement,
      );
      const claimed = receipt
        ? candidate.periods.filter(
            (period) =>
              stored.find((row) => row.id === period.id)?.invoiceGroupId ===
              receipt.id,
          )
        : [];
      const unsealed = candidate.periods.filter(
        (period) => !period.sealedAt && period.billingState === "billable",
      );
      const hasSealedDate = sealed.some(
        (group) => group.dueDate === candidate.dueDate,
      );
      const reviewReasons: ScheduleReviewReason[] =
        candidate.reviewReasons.filter(
          (reason) => reason !== "not_materialized",
        );
      const calendars = forecast.groups
        .filter((group) => group.dueDate === candidate.dueDate)
        .flatMap((group) =>
          group.periods.map((period) => canonicalize(period.calendar)),
        );
      if (
        candidate.periods.some(
          (period) => !period.issueAt || !period.dueEndAt || !period.chargeAt,
        )
      )
        reviewReasons.push("invalid_local_time");
      if (new Set(calendars).size > 1) reviewReasons.push("calendar_mismatch");
      if (
        mapping &&
        (mapping.name !== account.profile.legalName ||
          mapping.providerAccountId !== providerOwnership.accountId)
      )
        reviewReasons.push(
          mapping.name !== account.profile.legalName
            ? "provider_profile_pending"
            : "ownership_mismatch",
        );
      if (schedule?.issuancePaused) reviewReasons.push("issuance_paused");
      if (
        candidate.periods.some(
          (period) =>
            !allowed(
              all.find((sub) => sub.id === period.subscriptionId)!,
              revisions,
              period.periodIndex,
            ),
        )
      )
        reviewReasons.push("ownership_mismatch");
      const first = candidate.periods[0];
      const base: ScheduledGroup = {
        id: null,
        dueDate: candidate.dueDate,
        currency: "USD",
        paymentArrangement: candidate.paymentArrangement,
        kind: "upcoming",
        outcome: null,
        totalMinor: candidate.totalMinor,
        calendar: first.calendar,
        issueAt: first.issueAt,
        dueEndAt: first.dueEndAt,
        sealedAt: null,
        billTo: null,
        invoice: null,
        reviewReasons: [...new Set(reviewReasons)],
        periods: candidate.periods.map((period) => ({
          ...period,
          id: stored.some((row) => row.id === period.id) ? period.id : null,
        })),
      };
      if (receipt) {
        const invoice = linked.find(
          (invoice) => invoice.id === receipt.invoiceId,
        );
        output.push({
          ...base,
          id: receipt.id,
          kind: "sealed",
          outcome: receipt.outcome,
          totalMinor: receipt.totalMinor,
          calendar: receipt.calendar,
          sealedAt: instant(receipt.sealedAt),
          reviewReasons: [],
          billTo: {
            legalName: receipt.billToName,
            billingEmail: receipt.billToEmail,
            profileVersion: receipt.billToProfileVersion,
          },
          invoice: invoice
            ? {
                id: invoice.id,
                customer: { id: account.customerId, name: invoice.billToName },
                issueDate: invoice.issueDate,
                dueDate: invoice.dueDate,
                readinessDate: invoice.readinessDate,
                currency: invoice.currency,
                totalMinor: invoice.totalMinor,
                state: invoice.state,
                providerStatus: invoice.providerStatus,
                reviewReason: invoice.reviewReason,
                lastCheckedAt:
                  invoice.lastCheckedAt && instant(invoice.lastCheckedAt),
                issuedAt: invoice.issuedAt && instant(invoice.issuedAt),
              }
            : null,
          periods: candidate.periods.filter(
            (period) =>
              claimed.includes(period) ||
              (period.sealedAt && period.billingState !== "billable"),
          ),
        });
      }
      if (hasSealedDate && unsealed.length)
        output.push({
          ...base,
          kind: "late",
          reviewReasons: ["late_period"],
          totalMinor: unsealed.reduce(
            (sum, period) => sum + period.amountMinor,
            0,
          ),
          periods: base.periods.filter(
            (period) => !period.sealedAt && period.billingState === "billable",
          ),
        });
      else if (!receipt) {
        if (
          candidate.periods.every(
            (period) => period.billingState !== "billable",
          )
        )
          base.kind = "excluded";
        else if (
          base.dueEndAt &&
          now().getTime() >= Date.parse(base.dueEndAt)
        ) {
          base.kind = "missed";
          base.reviewReasons = [
            ...new Set([...base.reviewReasons, "past_due" as const]),
          ];
        } else if (base.reviewReasons.length) base.kind = "review";
        output.push(base);
      }
    }
    return { output, stored, expected };
  }
  async function sweepCustomer(customerId: string) {
    return db.transaction(async (tx) => {
      const account = await customerAccess.readProfile(tx, customerId, {
        lock: true,
      });
      if (!account) throw new Error("Schedule customer missing");
      await lock(tx, customerId);
      const [schedule] = await tx
        .select()
        .from(schedules)
        .where(scheduleScope(customerId))
        .for("share");
      if (!schedule) throw new Error("Schedule missing");
      const { all, revisions } = await load(tx, customerId);
      const activated = active(all);
      const reviewReasons = new Set<ScheduleReviewReason>();
      const result = {
        customerId,
        groupIds: [] as string[],
        invoiceIds: [] as string[],
        reviewReasons: [] as ScheduleReviewReason[],
        failure: null,
      };
      if (!activated.length) return result;
      const today = activated
        .map((sub) => localToday(now(), sub.calendar))
        .sort();
      const query = {
        fromDueDate: today[0],
        throughDueDate: Temporal.PlainDate.from(today.at(-1)!)
          .add({ days: 21 })
          .toString(),
        limit: 100,
        offset: 0,
      };
      let view = await projections(tx, account, all, revisions, query);
      for (const sub of activated) {
        const ready = view.expected.filter(
          (period) =>
            period.subscriptionId === sub.id &&
            period.issueAt &&
            period.dueEndAt &&
            Date.parse(period.issueAt) <= now().getTime() &&
            now().getTime() < Date.parse(period.dueEndAt),
        );
        if (ready.length > 1)
          return { ...result, reviewReasons: ["multiple_candidates" as const] };
      }
      const dates = [
        ...new Set(
          view.output
            .filter(
              (group) =>
                !group.issueAt || Date.parse(group.issueAt) <= now().getTime(),
            )
            .map((group) => group.dueDate),
        ),
      ];
      for (const dueDate of dates) {
        for (const row of view.expected.filter(
          (row) => row.dueDate === dueDate && !row.sealedAt,
        )) {
          const existing = view.stored.find((value) => value.id === row.id);
          const {
            id,
            invoiceGroupId: _claim,
            sealedAt: _sealed,
            ...derived
          } = row;
          if (!existing) await tx.insert(periods).values({ id, ...derived });
          else if (!samePeriod(existing, derived))
            await tx.update(periods).set(derived).where(eq(periods.id, id));
        }
      }
      view = await projections(tx, account, all, revisions, query);
      for (const dueDate of dates) {
        const candidates = view.output.filter(
          (group) => group.dueDate === dueDate,
        );
        if (
          candidates.some(
            (group) => group.kind === "sealed" || group.kind === "late",
          )
        ) {
          if (candidates.some((group) => group.kind === "late"))
            reviewReasons.add("late_period");
          continue;
        }
        const billable = candidates.filter(
          (group) => group.kind !== "excluded",
        );
        if (!billable.length) continue;
        const reasons = candidates.flatMap((group) => group.reviewReasons);
        if (reasons.length) {
          reasons.forEach((reason) => reviewReasons.add(reason));
          continue;
        }
        if (
          candidates.some(
            (group) =>
              !group.issueAt ||
              !group.dueEndAt ||
              Date.parse(group.issueAt) > now().getTime() ||
              Date.parse(group.dueEndAt) <= now().getTime(),
          )
        )
          continue;
        try {
          const sealed = await tx.transaction(async (seal) => {
            const groupIds: string[] = [],
              invoiceIds: string[] = [];
            const [oldMapping] = await seal
              .select()
              .from(billingCustomers)
              .where(
                and(
                  eq(billingCustomers.customerId, customerId),
                  eq(billingCustomers.deploymentKey, deploymentKey),
                ),
              );
            let mapping: typeof billingCustomers.$inferSelect | undefined =
              oldMapping;
            for (const candidate of billable) {
              const id = randomUUID();
              let invoiceId: string | null = null;
              requestFor(
                id,
                account,
                mapping?.key ?? `customer:${customerId}`,
                candidate,
              );
              if (candidate.totalMinor > 0) {
                mapping =
                  (await ensureMapping(
                    seal,
                    {
                      deploymentKey,
                      provider: { ownership: providerOwnership },
                    },
                    account,
                    mapping?.key ?? `customer:${customerId}`,
                    account.profile.legalName,
                    now().toISOString(),
                  )) ?? undefined;
                if (!mapping || mapping.name !== account.profile.legalName)
                  throw new SealRejected("provider_profile_pending");
                const request = requestFor(id, account, mapping.key, candidate);
                invoiceId = await persistInvoice(
                  seal,
                  deploymentKey,
                  request,
                  account,
                  mapping.id,
                  now().toISOString(),
                );
                await seal
                  .update(invoices)
                  .set({
                    issueRequestedAt: now().toISOString(),
                    state: "preparing",
                  })
                  .where(eq(invoices.id, invoiceId));
                invoiceIds.push(invoiceId);
              }
              const permission = await freezeEnrollment(
                seal,
                deploymentKey,
                customerId,
                candidate,
                invoiceId ? mapping!.id : null,
              );
              await seal.insert(groups).values({
                ...permission,
                id,
                customerId,
                deploymentKey,
                dueDate,
                currency: "USD",
                paymentArrangement: candidate.paymentArrangement,
                calendar: candidate.calendar,
                outcome: invoiceId ? "invoice_requested" : "no_charge",
                sealedAt: now().toISOString(),
                totalMinor: candidate.totalMinor,
                billToName: account.profile.legalName,
                billToEmail: account.profile.billingEmail,
                billToProfileVersion: account.version,
                billingCustomerId: invoiceId ? mapping!.id : null,
                invoiceId,
              });
              const claimed = candidate.periods
                .filter((period) => period.billingState === "billable")
                .map((period) => period.id!);
              await seal
                .update(periods)
                .set({ invoiceGroupId: id, sealedAt: now().toISOString() })
                .where(inArray(periods.id, claimed));
              groupIds.push(id);
              await audit.recordOperator(seal, {
                requestId: id,
                operatorId: workerId,
                customerId,
                targetId: id,
                action: "invoice_group.sealed",
              });
            }
            const applicable = candidates.flatMap((group) =>
              group.periods.map((period) => period.id!),
            );
            await seal
              .update(periods)
              .set({ sealedAt: now().toISOString() })
              .where(inArray(periods.id, applicable));
            return { groupIds, invoiceIds };
          });
          result.groupIds.push(...sealed.groupIds);
          result.invoiceIds.push(...sealed.invoiceIds);
        } catch (error) {
          if (error instanceof SealRejected) reviewReasons.add(error.reason);
          else throw error;
        }
      }
      return { ...result, reviewReasons: [...reviewReasons].sort() };
    });
  }
  return {
    async getSchedule(actor, customerId) {
      try {
        return await db.transaction(
          async (tx) => {
            const canManage = await authorize(tx, actor, customerId, false);
            return {
              ok: true,
              value: await scheduleView(tx, customerId, canManage),
            };
          },
          { isolationLevel: "repeatable read" },
        );
      } catch (error) {
        return result(error);
      }
    },
    async configureSchedule(actor, customerId, input) {
      try {
        if (!Value.Check(ConfigureScheduleRequestSchema, input))
          fail("invalid_request");
        return await db.transaction(async (tx) => {
          await authorize(tx, actor, customerId, true);
          await audit.assertRequestUnused(tx, input.requestId);
          const [schedule] = await tx
            .select()
            .from(schedules)
            .where(scheduleScope(customerId))
            .for("update");
          if ((schedule?.version ?? 0) !== input.expectedVersion)
            fail("conflict");
          const { all, revisions } = await load(tx, customerId);
          const selections: Array<{
            subscriptionId: string;
            firstUnbilledPeriodIndex: number;
            activationFromPeriodIndex: number;
          }> = [];
          let changed = false;
          let paused = schedule?.issuancePaused ?? false;
          if (input.change.kind === "activate") {
            if (
              new Set(
                input.change.subscriptions.map(
                  (selection) => selection.subscriptionId,
                ),
              ).size !== input.change.subscriptions.length
            )
              fail("invalid_request");
            let calendar = all.find(
              (sub) => sub.activationFromPeriodIndex !== null,
            )?.calendar;
            for (const selection of input.change.subscriptions) {
              const sub = all.find(
                (sub) => sub.id === selection.subscriptionId,
              );
              if (!sub) fail("not_found");
              if (sub.version !== selection.expectedVersion) fail("conflict");
              if (sub.activationFromPeriodIndex !== null) {
                if (
                  sub.activationFromPeriodIndex !==
                  selection.activationFromPeriodIndex
                )
                  fail("conflict");
                continue;
              }
              const index = selection.activationFromPeriodIndex;
              if (index < sub.firstUnbilledPeriodIndex) fail("invalid_request");
              validateCalendar(sub.calendar);
              const first = derivePeriod(sub, revisions, index);
              if (
                !first.issueAt ||
                !first.dueEndAt ||
                !first.chargeAt ||
                Date.parse(first.issueAt) <= now().getTime() ||
                first.dueDate > horizon(now(), sub.calendar) ||
                (calendar && !equal(calendar, sub.calendar)) ||
                !allowed(sub, revisions, index)
              )
                fail("invalid_request");
              if (
                all.some(
                  (other) =>
                    other.activationFromPeriodIndex !== null &&
                    !equal(other.calendar, sub.calendar),
                )
              )
                fail("invalid_request");
              const [sealed] = await tx
                .select({ id: groups.id })
                .from(groups)
                .where(
                  and(
                    eq(groups.customerId, customerId),
                    eq(groups.deploymentKey, deploymentKey),
                    eq(groups.dueDate, first.dueDate),
                  ),
                )
                .limit(1);
              if (sealed) fail("conflict");
              calendar = sub.calendar;
              await tx
                .update(subscriptions)
                .set({
                  activationFromPeriodIndex: index,
                  activatedAt: now().toISOString(),
                  activatedBy: actor.userId,
                  version: sub.version + 1,
                  updatedAt: now().toISOString(),
                })
                .where(eq(subscriptions.id, sub.id));
              selections.push({
                subscriptionId: sub.id,
                firstUnbilledPeriodIndex: sub.firstUnbilledPeriodIndex,
                activationFromPeriodIndex: index,
              });
              changed = true;
            }
          } else {
            if (!schedule) fail("conflict");
            paused = input.change.kind === "pause_issuance";
            changed = paused !== schedule.issuancePaused;
          }
          if (changed) {
            if (schedule)
              await tx
                .update(schedules)
                .set({
                  version: schedule.version + 1,
                  issuancePaused: paused,
                  updatedAt: now().toISOString(),
                  updatedBy: actor.userId,
                })
                .where(scheduleScope(customerId));
            else
              await tx.insert(schedules).values({
                customerId,
                deploymentKey,
                version: 1,
                issuancePaused: paused,
                createdAt: now().toISOString(),
                updatedAt: now().toISOString(),
                createdBy: actor.userId,
                updatedBy: actor.userId,
              });
            await audit.append(tx, {
              requestId: input.requestId,
              actor,
              customerId,
              targetId: customerId,
              action: "billing_schedule.changed",
              selections,
              changedFields: [
                input.change.kind === "activate"
                  ? "activation"
                  : "issuancePaused",
              ],
            });
          }
          return {
            ok: true,
            value: {
              ...(await scheduleView(tx, customerId, true)),
              outcome: changed ? "changed" : "unchanged",
            },
          };
        });
      } catch (error) {
        return result(error);
      }
    },
    async listScheduledGroups(actor, customerId, query) {
      try {
        if (!Value.Check(ScheduledGroupsQuerySchema, query))
          fail("invalid_request");
        validateWindow(query.fromDueDate, query.throughDueDate);
        return await db.transaction(
          async (tx) => {
            await authorize(tx, actor, customerId, false);
            const account = await customerAccess.readProfile(tx, customerId);
            if (!account) fail("not_found");
            const { all, revisions } = await load(tx, customerId);
            const { output } = await projections(
              tx,
              account,
              all,
              revisions,
              query,
            );
            return {
              ok: true,
              value: {
                ...query,
                total: output.length,
                groups: output.slice(query.offset, query.offset + query.limit),
              },
            };
          },
          { isolationLevel: "repeatable read" },
        );
      } catch (error) {
        return result(error);
      }
    },
    async sweepScheduled({ limit = 25, after = null, through = null } = {}) {
      const validCursor = (value: ScheduleCursor) =>
        isUuid(value.customerId) &&
        Number.isFinite(Date.parse(value.createdAt));
      if (
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 100 ||
        (after && (!validCursor(after) || !through)) ||
        (through && !validCursor(through))
      )
        throw new RangeError("Invalid schedule cursor");
      const selection = {
        createdAt: schedules.createdAt,
        customerId: schedules.customerId,
      };
      if (!through) {
        const [last] = await db
          .select(selection)
          .from(schedules)
          .where(eq(schedules.deploymentKey, deploymentKey))
          .orderBy(desc(schedules.createdAt), desc(schedules.customerId))
          .limit(1);
        through = last ?? null;
      }
      if (!through) return { next: null, through: null, results: [] };
      const rows = await db
        .select(selection)
        .from(schedules)
        .where(
          and(
            eq(schedules.deploymentKey, deploymentKey),
            sql`(${schedules.createdAt},${schedules.customerId}) <= (${through.createdAt}::timestamptz,${through.customerId}::uuid)`,
            after
              ? sql`(${schedules.createdAt},${schedules.customerId}) > (${after.createdAt}::timestamptz,${after.customerId}::uuid)`
              : undefined,
          ),
        )
        .orderBy(asc(schedules.createdAt), asc(schedules.customerId))
        .limit(limit + 1);
      const page = rows.slice(0, limit);
      const results = [];
      for (const row of page) {
        try {
          results.push(await sweepCustomer(row.customerId));
        } catch {
          results.push({
            customerId: row.customerId,
            groupIds: [],
            invoiceIds: [],
            reviewReasons: [],
            failure: "unavailable" as const,
          });
        }
      }
      return {
        next: rows.length > limit ? page.at(-1)! : null,
        through,
        results,
      };
    },
    async assertSyntheticData() {
      await db.transaction(
        async (tx) => {
          const allGroups = await tx.select().from(groups);
          const allSchedules = await tx.select().from(schedules);
          const allSubscriptions = await tx.select().from(subscriptions);
          const stored = await tx.select().from(periods);
          const revisions = await tx.select().from(terms);
          const allInvoices = await tx.select().from(invoices);
          const mappings = await tx.select().from(billingCustomers);
          const lines = await tx
            .select()
            .from(invoiceLines)
            .orderBy(asc(invoiceLines.position));
          function invalid(): never {
            throw new Error("Scheduled billing outside synthetic policy");
          }
          for (const schedule of allSchedules)
            if (schedule.deploymentKey !== deploymentKey) invalid();
          for (const sub of allSubscriptions) {
            if (sub.deploymentKey !== deploymentKey) invalid();
            if (sub.activationFromPeriodIndex !== null) {
              const schedule = allSchedules.find(
                (row) =>
                  row.customerId === sub.customerId &&
                  row.deploymentKey === deploymentKey,
              );
              const first = derivePeriod(
                sub,
                revisions,
                sub.activationFromPeriodIndex,
              );
              if (
                !schedule ||
                !sub.activatedAt ||
                !first.issueAt ||
                Date.parse(sub.activatedAt) >= Date.parse(first.issueAt) ||
                !allowed(sub, revisions, sub.activationFromPeriodIndex)
              )
                invalid();
            }
          }
          for (const group of allGroups) {
            if (group.deploymentKey !== deploymentKey) invalid();
            const own = stored
              .filter((row) => row.invoiceGroupId === group.id)
              .sort(
                (a, b) =>
                  a.subscriptionId.localeCompare(b.subscriptionId) ||
                  a.periodIndex - b.periodIndex,
              );
            if (
              !own.length ||
              own.some(
                (row) =>
                  !row.sealedAt ||
                  row.customerId !== group.customerId ||
                  row.deploymentKey !== group.deploymentKey ||
                  row.dueDate !== group.dueDate ||
                  row.paymentArrangement !== group.paymentArrangement ||
                  row.billingState !== "billable" ||
                  !equal(row.calendar, group.calendar),
              ) ||
              own.reduce((sum, row) => sum + row.amountMinor, 0) !==
                group.totalMinor
            )
              invalid();
            for (const row of own) {
              const sub = allSubscriptions.find(
                (sub) => sub.id === row.subscriptionId,
              );
              if (
                !sub ||
                sub.activationFromPeriodIndex === null ||
                row.periodIndex < sub.activationFromPeriodIndex ||
                !samePeriod(
                  row,
                  derivePeriod(sub, revisions, row.periodIndex),
                ) ||
                !allowed(sub, revisions, row.periodIndex)
              )
                invalid();
            }
            if (group.invoiceId) {
              const invoice = allInvoices.find(
                (row) => row.id === group.invoiceId,
              );
              const mapping = mappings.find(
                (row) => row.id === group.billingCustomerId,
              );
              if (
                !invoice ||
                !mapping ||
                mapping.customerId !== group.customerId ||
                mapping.providerAccountId !== providerOwnership.accountId ||
                invoice.billingCustomerId !== mapping.id ||
                !equal(invoice.calendar, group.calendar) ||
                invoice.dueDate !== group.dueDate ||
                invoice.totalMinor !== group.totalMinor ||
                invoice.billToName !== group.billToName ||
                invoice.billToEmail !== group.billToEmail ||
                invoice.billToProfileVersion !== group.billToProfileVersion ||
                invoice.originKey !== `scheduled:${group.id}` ||
                !invoice.issueRequestedAt
              )
                invalid();
              const request = validateScheduledRequest({
                originKey: invoice.originKey,
                customer: {
                  key: mapping.key,
                  name: invoice.requestCustomerName,
                },
                issueDate: invoice.issueDate,
                dueDate: invoice.dueDate,
                currency: invoice.currency,
                calendar: invoice.calendar,
                issueNotBefore: instant(invoice.issueNotBefore),
                firstAttemptBefore: instant(invoice.firstAttemptBefore),
                dueEndAt: instant(invoice.dueEndAt),
                lines: lines
                  .filter((line) => line.invoiceId === invoice.id)
                  .map((line) => ({
                    description: line.description,
                    amountMinor: line.amountMinor,
                    originRef: line.originRef,
                  })),
              });
              if (
                !request ||
                requestDigest(request) !== invoice.requestDigest ||
                !equal(
                  request.lines,
                  own.map((row) => ({
                    description: row.label,
                    amountMinor: row.amountMinor,
                    originRef: row.id,
                  })),
                ) ||
                !allowRequest({
                  request,
                  customerId: group.customerId,
                  billTo: {
                    legalName: group.billToName,
                    billingEmail: group.billToEmail,
                    profileVersion: group.billToProfileVersion,
                  },
                })
              )
                invalid();
            } else {
              if (
                group.outcome !== "no_charge" ||
                group.totalMinor !== 0 ||
                group.billingCustomerId !== null
              )
                invalid();
              const times = periodInstants(group.dueDate, group.calendar);
              const request = validateScheduledRequest(
                {
                  originKey: `scheduled:${group.id}`,
                  customer: {
                    key: `customer:${group.customerId}`,
                    name: group.billToName,
                  },
                  issueDate: times.readinessDate,
                  dueDate: group.dueDate,
                  currency: "USD",
                  calendar: group.calendar,
                  issueNotBefore: times.issueAt && instant(times.issueAt),
                  firstAttemptBefore: times.dueEndAt && instant(times.dueEndAt),
                  dueEndAt: times.dueEndAt && instant(times.dueEndAt),
                  lines: own.map((row) => ({
                    description: row.label,
                    amountMinor: row.amountMinor,
                    originRef: row.id,
                  })),
                },
                true,
              );
              if (
                !request ||
                !allowRequest({
                  request,
                  customerId: group.customerId,
                  billTo: {
                    legalName: group.billToName,
                    billingEmail: group.billToEmail,
                    profileVersion: group.billToProfileVersion,
                  },
                })
              )
                invalid();
            }
          }
          for (const row of stored.filter((row) => row.sealedAt)) {
            const sub = allSubscriptions.find(
              (sub) => sub.id === row.subscriptionId,
            );
            if (
              !sub ||
              sub.activationFromPeriodIndex === null ||
              row.periodIndex < sub.activationFromPeriodIndex ||
              !samePeriod(row, derivePeriod(sub, revisions, row.periodIndex)) ||
              (row.billingState === "billable" && !row.invoiceGroupId) ||
              !allGroups.some(
                (group) =>
                  group.customerId === row.customerId &&
                  group.deploymentKey === row.deploymentKey &&
                  group.dueDate === row.dueDate,
              )
            )
              invalid();
          }
        },
        { isolationLevel: "repeatable read" },
      );
    },
  };
}
