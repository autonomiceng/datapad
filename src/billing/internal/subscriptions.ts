import { randomUUID, createHash } from "node:crypto";
import canonicalize from "canonicalize";
import { and, eq, gte, inArray, lte, sql, asc } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Value } from "@sinclair/typebox/value";
import { AuditRequestConflict } from "../../access";
import type { AccessResult, HumanActor } from "../../access/types";
import type { AccessErrorCode } from "../../access/contract";
import { AccountPaginationSchema } from "../../access/contract";
import {
  CalendarPolicySchema,
  CreateSubscriptionRequestSchema,
  ChangeSubscriptionRequestSchema,
  SubscriptionBoundaryRequestSchema,
  ForecastQuerySchema,
  MaterializeForecastRequestSchema,
  type CreateSubscriptionRequest,
  type SubscriptionResponse,
  type SubscriptionSummary,
  type ForecastQuery,
} from "../subscriptions-contract";
import type {
  Subscriptions,
  SubscriptionsOptions,
  SyntheticSubscription,
} from "../subscriptions-types";
import {
  billingSubscriptions as subscriptions,
  billingSubscriptionTerms as terms,
  billingPeriods as periods,
} from "./subscriptions-schema";
import {
  validateCalendar,
  validateAnchors,
  periodBoundary,
  localToday,
  horizon,
  validateWindow,
  indicesInWindow,
  nearIndex,
} from "./calendar";
import {
  effectiveTerms,
  derivePeriod,
  samePeriod,
  buildForecast,
  type Subscription,
  type SubscriptionTerm,
} from "./forecast";
import { isUuid } from "./validate";
import { lockSubscriptionCustomer } from "./subscription-lock";
class SubscriptionFailure extends Error {
  constructor(readonly code: AccessErrorCode) {
    super(code);
  }
}
function fail(code: AccessErrorCode): never {
  throw new SubscriptionFailure(code);
}
function errorResult(error: unknown): AccessResult<never> {
  if (error instanceof SubscriptionFailure)
    return { ok: false, code: error.code };
  if (error instanceof AuditRequestConflict)
    return { ok: false, code: "conflict" };
  if (error instanceof RangeError)
    return { ok: false, code: "invalid_request" };
  const cause = error instanceof Error ? error.cause : undefined;
  if (
    cause &&
    typeof cause === "object" &&
    "code" in cause &&
    cause.code === "23503"
  )
    return { ok: false, code: "invalid_request" };
  throw error;
}
function digest(input: unknown) {
  return createHash("sha256").update(canonicalize(input)!).digest("hex");
}
function label(value: string) {
  return (
    value.trim().length > 0 &&
    !value.includes("\0") &&
    !/[\uD800-\uDFFF]/u.test(value)
  );
}
/** Validates and captures the billing calendar for audited local commercial agreements.
 * The caller supplies customer authorization and a synthetic policy; this module performs no provider I/O. */
export function createSubscriptions(
  options: SubscriptionsOptions,
): Subscriptions {
  const {
    pool,
    deploymentKey,
    authorizeCustomer,
    audit,
    allowSubscription,
    now = () => new Date(),
  } = options;
  if (
    !/^[A-Za-z0-9_-]{1,64}$/.test(deploymentKey) ||
    !Value.Check(CalendarPolicySchema, options.calendar)
  )
    throw new Error("Invalid subscriptions configuration");
  const calendar = structuredClone(options.calendar);
  validateCalendar(calendar);
  const db = drizzle(pool);
  const scope = (customerId: string) =>
    and(
      eq(subscriptions.deploymentKey, deploymentKey),
      eq(subscriptions.customerId, customerId),
    );
  async function authorize(
    tx: NodePgDatabase,
    actor: HumanActor,
    customerId: string,
    mutation: boolean,
  ) {
    if (!isUuid(customerId)) fail("not_found");
    const access = await authorizeCustomer(
      tx,
      actor,
      customerId,
      mutation ? "manage_billing" : "read_billing",
      mutation,
    );
    if (!access.ok) fail(access.code);
    if (mutation) await lockSubscriptionCustomer(tx, deploymentKey, customerId);
    return access.value;
  }
  async function loadTerms(
    tx: NodePgDatabase,
    ids: string[],
  ): Promise<SubscriptionTerm[]> {
    return ids.length
      ? tx
          .select()
          .from(terms)
          .where(inArray(terms.subscriptionId, ids))
          .orderBy(asc(terms.revision))
      : [];
  }
  async function loadCustomer(tx: NodePgDatabase, customerId: string) {
    const rows = await tx
      .select()
      .from(subscriptions)
      .where(scope(customerId))
      .orderBy(asc(subscriptions.id))
      .limit(101);
    if (rows.length > 100)
      throw new RangeError("Too many subscriptions for forecast");
    return {
      rows,
      revisions: await loadTerms(
        tx,
        rows.map((row) => row.id),
      ),
    };
  }
  const policyInput = (
    sub: Subscription,
    commercial: {
      label: string;
      amountMinor: number;
      paymentArrangement: "manual" | "automatic";
    },
    reason = sub.cancellationReason,
  ): SyntheticSubscription => ({
    customerId: sub.customerId,
    serviceId: sub.serviceId,
    periodAnchorDate: sub.periodAnchorDate,
    dueAnchorDate: sub.dueAnchorDate,
    intervalMonths: sub.intervalMonths,
    firstUnbilledPeriodIndex: sub.firstUnbilledPeriodIndex,
    calendar: sub.calendar,
    label: commercial.label,
    amountMinor: commercial.amountMinor,
    paymentArrangement: commercial.paymentArrangement,
    cancellationReason: reason,
  });
  function summary(
    sub: Subscription,
    revisions: SubscriptionTerm[],
  ): SubscriptionSummary {
    const today = localToday(now(), sub.calendar);
    let index = Math.max(
      sub.firstUnbilledPeriodIndex,
      nearIndex(sub.periodAnchorDate, sub.intervalMonths, today),
    );
    while (periodBoundary(sub, index + 1).periodStart <= today) index++;
    const current = effectiveTerms(sub, revisions, index);
    const next = indicesInWindow(
      sub,
      sub.firstUnbilledPeriodIndex,
      today,
      horizon(now(), sub.calendar),
    ).find(
      (index) =>
        effectiveTerms(sub, revisions, index).billingState === "billable",
    );
    return {
      id: sub.id,
      customerId: sub.customerId,
      serviceId: sub.serviceId,
      version: sub.version,
      periodAnchorDate: sub.periodAnchorDate,
      dueAnchorDate: sub.dueAnchorDate,
      intervalMonths: sub.intervalMonths,
      firstUnbilledPeriodIndex: sub.firstUnbilledPeriodIndex,
      calendar: sub.calendar,
      label: current.label,
      amountMinor: current.amountMinor,
      paymentArrangement: current.paymentArrangement,
      billingState: current.billingState,
      nextRenewal:
        next === undefined ? null : periodBoundary(sub, next).dueDate,
      cancellation: {
        status: sub.cancellationStatus,
        reason: sub.cancellationReason,
        effectivePeriodIndex: sub.cancellationEffectivePeriodIndex,
      },
    };
  }
  async function detail(
    tx: NodePgDatabase,
    sub: Subscription,
    canManage: boolean,
  ): Promise<SubscriptionResponse> {
    const revisions = await loadTerms(tx, [sub.id]);
    const seen = new Set<string>();
    const upcoming = [...revisions]
      .reverse()
      .filter((term) => {
        const key = `${term.kind}:${term.effectivePeriodIndex}`;
        if (seen.has(key)) return false;
        seen.add(key);
        if (
          periodBoundary(sub, term.effectivePeriodIndex).periodStart <=
          localToday(now(), sub.calendar)
        )
          return false;
        return !(
          term.kind === "state" &&
          sub.cancellationEffectivePeriodIndex !== null &&
          term.effectivePeriodIndex >= sub.cancellationEffectivePeriodIndex &&
          term.billingState !== "cancelled"
        );
      })
      .sort(
        (a, b) =>
          a.effectivePeriodIndex - b.effectivePeriodIndex ||
          a.revision - b.revision,
      );
    return {
      subscription: {
        ...summary(sub, revisions),
        canManage,
        firstUnbilled: periodBoundary(sub, sub.firstUnbilledPeriodIndex),
        upcomingChanges: upcoming.slice(0, 100).map((term) =>
          term.kind === "commercial"
            ? {
                kind: "commercial",
                revision: term.revision,
                effectivePeriodIndex: term.effectivePeriodIndex,
                label: term.label!,
                amountMinor: term.amountMinor!,
                paymentArrangement: term.paymentArrangement!,
              }
            : {
                kind: "state",
                revision: term.revision,
                effectivePeriodIndex: term.effectivePeriodIndex,
                billingState: term.billingState!,
              },
        ),
        changesTruncated: upcoming.length > 100,
      },
    };
  }
  async function forecast(
    tx: NodePgDatabase,
    customerId: string,
    query: ForecastQuery,
  ) {
    const { rows, revisions } = await loadCustomer(tx, customerId);
    const stored = await tx
      .select()
      .from(periods)
      .where(
        and(
          eq(periods.deploymentKey, deploymentKey),
          eq(periods.customerId, customerId),
          gte(periods.dueDate, query.fromDueDate),
          lte(periods.dueDate, query.throughDueDate),
        ),
      );
    return buildForecast(rows, revisions, stored, query, now());
  }
  const page = (input?: { limit?: number; offset?: number }) => {
    const value = { limit: input?.limit ?? 50, offset: input?.offset ?? 0 };
    if (!Value.Check(AccountPaginationSchema, value)) fail("invalid_request");
    return value;
  };
  return {
    async listSubscriptions(actor, customerId, input) {
      try {
        const pagination = page(input);
        return await db.transaction(
          async (tx) => {
            await authorize(tx, actor, customerId, false);
            const { rows, revisions } = await loadCustomer(tx, customerId);
            return {
              ok: true,
              value: {
                subscriptions: rows
                  .slice(
                    pagination.offset,
                    pagination.offset + pagination.limit,
                  )
                  .map((row) => summary(row, revisions)),
                total: rows.length,
                ...pagination,
              },
            };
          },
          { isolationLevel: "repeatable read" },
        );
      } catch (error) {
        return errorResult(error);
      }
    },
    async getSubscription(actor, customerId, subscriptionId) {
      try {
        if (!isUuid(subscriptionId)) fail("not_found");
        return await db.transaction(
          async (tx) => {
            const access = await authorize(tx, actor, customerId, false);
            const [sub] = await tx
              .select()
              .from(subscriptions)
              .where(
                and(scope(customerId), eq(subscriptions.id, subscriptionId)),
              );
            if (!sub) fail("not_found");
            return {
              ok: true,
              value: await detail(
                tx,
                sub,
                access.staffRoles.includes("billing"),
              ),
            };
          },
          { isolationLevel: "repeatable read" },
        );
      } catch (error) {
        return errorResult(error);
      }
    },
    async getBoundaryOptions(actor, customerId, input) {
      try {
        if (!Value.Check(SubscriptionBoundaryRequestSchema, input))
          fail("invalid_request");
        validateAnchors(input);
        validateWindow(input.fromDueDate, input.throughDueDate);
        if (input.throughDueDate > horizon(now(), calendar))
          fail("invalid_request");
        return await db.transaction(async (tx) => {
          await authorize(tx, actor, customerId, false);
          return {
            ok: true,
            value: {
              calendar,
              boundaries: indicesInWindow(
                input,
                0,
                input.fromDueDate,
                input.throughDueDate,
              ).map((index) => periodBoundary(input, index)),
            },
          };
        });
      } catch (error) {
        return errorResult(error);
      }
    },
    async createSubscription(actor, customerId, input) {
      try {
        if (
          !Value.Check(CreateSubscriptionRequestSchema, input) ||
          !label(input.label)
        )
          fail("invalid_request");
        validateAnchors(input);
        return await db.transaction(async (tx) => {
          await authorize(tx, actor, customerId, true);
          const [existing] = await tx
            .select()
            .from(subscriptions)
            .where(
              and(
                eq(subscriptions.deploymentKey, deploymentKey),
                eq(subscriptions.createRequestId, input.requestId),
              ),
            );
          if (existing) {
            if (
              existing.customerId !== customerId ||
              existing.createDigest !==
                digest({ customerId, input, calendar: existing.calendar })
            )
              fail("conflict");
            return {
              ok: true,
              value: {
                ...(await detail(tx, existing, true)),
                outcome: "unchanged",
              },
            };
          }
          await audit.assertRequestUnused(tx, input.requestId);
          const boundary = periodBoundary(
            input,
            input.firstUnbilledPeriodIndex,
          );
          if (
            boundary.dueDate > horizon(now(), calendar) ||
            !allowSubscription({
              serviceId: input.serviceId,
              periodAnchorDate: input.periodAnchorDate,
              dueAnchorDate: input.dueAnchorDate,
              intervalMonths: input.intervalMonths,
              firstUnbilledPeriodIndex: input.firstUnbilledPeriodIndex,
              label: input.label,
              amountMinor: input.amountMinor,
              paymentArrangement: input.paymentArrangement,
              customerId,
              calendar,
              cancellationReason: null,
            })
          )
            fail("invalid_request");
          const existingRows = await tx
            .select({ id: subscriptions.id })
            .from(subscriptions)
            .where(scope(customerId))
            .limit(100);
          if (existingRows.length >= 100) fail("invalid_request");
          const id = randomUUID(),
            at = now().toISOString();
          const [sub] = await tx
            .insert(subscriptions)
            .values({
              id,
              customerId,
              deploymentKey,
              serviceId: input.serviceId,
              createRequestId: input.requestId,
              createDigest: digest({ customerId, input, calendar }),
              periodAnchorDate: input.periodAnchorDate,
              dueAnchorDate: input.dueAnchorDate,
              intervalMonths: input.intervalMonths,
              firstUnbilledPeriodIndex: input.firstUnbilledPeriodIndex,
              calendar,
              createdAt: at,
              updatedAt: at,
            })
            .returning();
          const base = {
            subscriptionId: id,
            customerId,
            deploymentKey,
            effectivePeriodIndex: input.firstUnbilledPeriodIndex,
          };
          await tx.insert(terms).values([
            {
              ...base,
              revision: 1,
              kind: "commercial",
              label: input.label,
              amountMinor: input.amountMinor,
              currency: "USD",
              paymentArrangement: input.paymentArrangement,
            },
            { ...base, revision: 2, kind: "state", billingState: "billable" },
          ]);
          await audit.append(tx, {
            requestId: input.requestId,
            actor,
            customerId,
            targetId: id,
            action: "subscription.created",
            changedFields: [
              "serviceId",
              "anchors",
              "firstUnbilledPeriodIndex",
              "terms",
              "calendarPolicy",
            ],
          });
          return {
            ok: true,
            value: { ...(await detail(tx, sub, true)), outcome: "created" },
          };
        });
      } catch (error) {
        return errorResult(error);
      }
    },
    async changeSubscription(actor, customerId, subscriptionId, input) {
      try {
        if (
          !isUuid(subscriptionId) ||
          !Value.Check(ChangeSubscriptionRequestSchema, input)
        )
          fail("invalid_request");
        return await db.transaction(async (tx) => {
          await authorize(tx, actor, customerId, true);
          await audit.assertRequestUnused(tx, input.requestId);
          const [sub] = await tx
            .select()
            .from(subscriptions)
            .where(and(scope(customerId), eq(subscriptions.id, subscriptionId)))
            .for("update");
          if (!sub) fail("not_found");
          if (sub.version !== input.expectedVersion) fail("conflict");
          const revisions = await loadTerms(tx, [sub.id]);
          const change = input.change;
          const affectedIndex =
            "effectivePeriodIndex" in change
              ? change.effectivePeriodIndex
              : null;
          const affected =
            affectedIndex === null
              ? []
              : await tx
                  .select()
                  .from(periods)
                  .where(
                    and(
                      eq(periods.subscriptionId, sub.id),
                      gte(periods.periodIndex, affectedIndex),
                    ),
                  )
                  .limit(Math.ceil(36 / sub.intervalMonths) + 3)
                  .for("update");
          if (affectedIndex !== null) {
            if (
              affectedIndex < sub.firstUnbilledPeriodIndex ||
              periodBoundary(sub, affectedIndex).periodStart <=
                localToday(now(), sub.calendar)
            )
              fail("conflict");
            const [sealed] = await tx
              .select({ id: periods.id })
              .from(periods)
              .where(
                and(
                  eq(periods.subscriptionId, sub.id),
                  gte(periods.periodIndex, affectedIndex),
                  sql`${periods.sealedAt} is not null`,
                ),
              )
              .limit(1);
            if (sealed) fail("conflict");
            if (affected.length > Math.ceil(36 / sub.intervalMonths) + 2)
              fail("invalid_request");
          }
          let changedField: "terms" | "billingState" | "cancellation";
          let revision: typeof terms.$inferInsert | undefined;
          const base = {
            subscriptionId: sub.id,
            customerId,
            deploymentKey,
            revision: Math.max(...revisions.map((row) => row.revision)) + 1,
          };
          if (change.kind === "terms") {
            if (
              !label(change.label) ||
              !allowSubscription(policyInput(sub, change))
            )
              fail("invalid_request");
            const current = effectiveTerms(
              sub,
              revisions,
              change.effectivePeriodIndex,
            );
            if (
              current.label === change.label &&
              current.amountMinor === change.amountMinor &&
              current.paymentArrangement === change.paymentArrangement
            )
              return {
                ok: true,
                value: {
                  ...(await detail(tx, sub, true)),
                  outcome: "unchanged",
                },
              };
            revision = {
              ...base,
              effectivePeriodIndex: change.effectivePeriodIndex,
              kind: "commercial",
              label: change.label,
              amountMinor: change.amountMinor,
              paymentArrangement: change.paymentArrangement,
              currency: "USD",
            };
            changedField = "terms";
          } else if (
            change.kind === "pause_billing" ||
            change.kind === "resume_billing"
          ) {
            if (
              sub.cancellationEffectivePeriodIndex !== null &&
              change.effectivePeriodIndex >=
                sub.cancellationEffectivePeriodIndex
            )
              fail("conflict");
            const state =
              change.kind === "pause_billing" ? "paused" : "billable";
            if (
              effectiveTerms(sub, revisions, change.effectivePeriodIndex)
                .billingState === state
            )
              return {
                ok: true,
                value: {
                  ...(await detail(tx, sub, true)),
                  outcome: "unchanged",
                },
              };
            revision = {
              ...base,
              effectivePeriodIndex: change.effectivePeriodIndex,
              kind: "state",
              billingState: state,
            };
            changedField = "billingState";
          } else {
            if (
              !label(change.reason) ||
              !allowSubscription(
                policyInput(
                  sub,
                  effectiveTerms(sub, revisions, sub.firstUnbilledPeriodIndex),
                  change.reason,
                ),
              )
            )
              fail("invalid_request");
            if (sub.cancellationStatus === "approved") fail("conflict");
            if (change.kind === "request_cancellation") {
              if (
                sub.cancellationStatus === "requested" &&
                sub.cancellationReason === change.reason
              )
                return {
                  ok: true,
                  value: {
                    ...(await detail(tx, sub, true)),
                    outcome: "unchanged",
                  },
                };
              sub.cancellationStatus = "requested";
            } else {
              if (sub.cancellationStatus !== "requested") fail("conflict");
              sub.cancellationStatus =
                change.decision === "approve" ? "approved" : "declined";
              if (change.decision === "approve") {
                sub.cancellationEffectivePeriodIndex =
                  change.effectivePeriodIndex;
                revision = {
                  ...base,
                  effectivePeriodIndex: change.effectivePeriodIndex,
                  kind: "state",
                  billingState: "cancelled",
                };
              }
            }
            sub.cancellationReason = change.reason;
            changedField = "cancellation";
          }
          if (revision) {
            const [inserted] = await tx
              .insert(terms)
              .values(revision)
              .returning();
            revisions.push(inserted);
          }
          const [updated] = await tx
            .update(subscriptions)
            .set({
              version: sub.version + 1,
              updatedAt: now().toISOString(),
              cancellationStatus: sub.cancellationStatus,
              cancellationReason: sub.cancellationReason,
              cancellationEffectivePeriodIndex:
                sub.cancellationEffectivePeriodIndex,
            })
            .where(eq(subscriptions.id, sub.id))
            .returning();
          for (const row of affected) {
            const facts = derivePeriod(updated, revisions, row.periodIndex);
            if (!samePeriod(row, facts))
              await tx.update(periods).set(facts).where(eq(periods.id, row.id));
          }
          await audit.append(tx, {
            requestId: input.requestId,
            actor,
            customerId,
            targetId: sub.id,
            action: "subscription.changed",
            changedFields: [changedField],
          });
          return {
            ok: true,
            value: { ...(await detail(tx, updated, true)), outcome: "changed" },
          };
        });
      } catch (error) {
        return errorResult(error);
      }
    },
    async materializeForecast(actor, customerId, input) {
      try {
        if (!Value.Check(MaterializeForecastRequestSchema, input))
          fail("invalid_request");
        validateWindow(input.fromDueDate, input.throughDueDate);
        return await db.transaction(async (tx) => {
          await authorize(tx, actor, customerId, true);
          await audit.assertRequestUnused(tx, input.requestId);
          const { rows, revisions } = await loadCustomer(tx, customerId);
          if (input.throughDueDate > horizon(now(), calendar))
            fail("invalid_request");
          const existingRows = await tx
            .select()
            .from(periods)
            .where(
              and(
                eq(periods.deploymentKey, deploymentKey),
                eq(periods.customerId, customerId),
                gte(periods.dueDate, input.fromDueDate),
                lte(periods.dueDate, input.throughDueDate),
              ),
            )
            .for("update");
          const existingByPeriod = new Map(
            existingRows.map((row) => [
              `${row.subscriptionId}:${row.periodIndex}`,
              row,
            ]),
          );
          let changed = false,
            total = 0;
          for (const sub of rows) {
            if (input.throughDueDate > horizon(now(), sub.calendar))
              fail("invalid_request");
            for (const index of indicesInWindow(
              sub,
              sub.firstUnbilledPeriodIndex,
              input.fromDueDate,
              input.throughDueDate,
            )) {
              if (++total > 3700) fail("invalid_request");
              const facts = derivePeriod(sub, revisions, index);
              const existing = existingByPeriod.get(`${sub.id}:${index}`);
              if (existing?.sealedAt) continue;
              if (existing) {
                if (samePeriod(existing, facts)) continue;
                await tx
                  .update(periods)
                  .set(facts)
                  .where(eq(periods.id, existing.id));
              } else
                await tx.insert(periods).values({ id: randomUUID(), ...facts });
              changed = true;
            }
          }
          if (changed)
            await audit.append(tx, {
              requestId: input.requestId,
              actor,
              customerId,
              targetId: customerId,
              action: "forecast.materialized",
              changedFields: ["periods"],
            });
          return {
            ok: true,
            value: {
              ...(await forecast(tx, customerId, {
                fromDueDate: input.fromDueDate,
                throughDueDate: input.throughDueDate,
                limit: 50,
                offset: 0,
              })),
              outcome: changed ? "changed" : "unchanged",
            },
          };
        });
      } catch (error) {
        return errorResult(error);
      }
    },
    async getForecast(actor, customerId, input) {
      try {
        if (!Value.Check(ForecastQuerySchema, input)) fail("invalid_request");
        validateWindow(input.fromDueDate, input.throughDueDate);
        return await db.transaction(
          async (tx) => {
            await authorize(tx, actor, customerId, false);
            return { ok: true, value: await forecast(tx, customerId, input) };
          },
          { isolationLevel: "repeatable read" },
        );
      } catch (error) {
        return errorResult(error);
      }
    },
    async assertSyntheticData() {
      await db.transaction(
        async (tx) => {
          const rows = await tx.select().from(subscriptions),
            revisions = await tx.select().from(terms),
            stored = await tx.select().from(periods);
          for (const sub of rows) {
            if (
              sub.deploymentKey !== deploymentKey ||
              !Value.Check(CalendarPolicySchema, sub.calendar)
            )
              throw new Error("Subscription outside synthetic policy");
            validateCalendar(sub.calendar);
            validateAnchors(sub);
            const own = revisions.filter(
              (term) => term.subscriptionId === sub.id,
            );
            effectiveTerms(sub, own, sub.firstUnbilledPeriodIndex);
            const cancelled = own.find(
              (term) => term.billingState === "cancelled",
            );
            if (
              (sub.cancellationEffectivePeriodIndex === null) !==
                (cancelled === undefined) ||
              (cancelled &&
                cancelled.effectivePeriodIndex !==
                  sub.cancellationEffectivePeriodIndex)
            )
              throw new Error("Subscription cancellation facts differ");

            const initial = own.find(
              (term) => term.kind === "commercial" && term.revision === 1,
            );
            if (
              !initial ||
              initial.label === null ||
              initial.amountMinor === null ||
              initial.paymentArrangement === null
            )
              throw new Error("Missing original subscription terms");
            const input: CreateSubscriptionRequest = {
              requestId: sub.createRequestId,
              serviceId: sub.serviceId,
              periodAnchorDate: sub.periodAnchorDate,
              dueAnchorDate: sub.dueAnchorDate,
              intervalMonths: sub.intervalMonths,
              firstUnbilledPeriodIndex: sub.firstUnbilledPeriodIndex,
              label: initial.label,
              amountMinor: initial.amountMinor,
              paymentArrangement: initial.paymentArrangement,
            };
            if (
              sub.createDigest !==
              digest({
                customerId: sub.customerId,
                input,
                calendar: sub.calendar,
              })
            )
              throw new Error(
                "Subscription intent differs from original request",
              );
            for (const term of own)
              if (term.kind === "commercial") {
                if (
                  term.label === null ||
                  term.amountMinor === null ||
                  term.paymentArrangement === null ||
                  !allowSubscription(
                    policyInput(sub, {
                      label: term.label,
                      amountMinor: term.amountMinor,
                      paymentArrangement: term.paymentArrangement,
                    }),
                  )
                )
                  throw new Error("Subscription outside synthetic policy");
              }
            for (const row of stored.filter(
              (row) => row.subscriptionId === sub.id,
            ))
              if (!samePeriod(row, derivePeriod(sub, own, row.periodIndex)))
                throw new Error(
                  "Stored period differs from subscription facts",
                );
          }
        },
        { isolationLevel: "repeatable read" },
      );
    },
  };
}
