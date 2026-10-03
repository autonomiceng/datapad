import canonicalize from "canonicalize";
import type {
  ForecastResponse,
  ForecastQuery,
} from "../subscriptions-contract";
import {
  billingSubscriptions,
  billingSubscriptionTerms,
  billingPeriods,
} from "./subscriptions-schema";
import {
  periodBoundary,
  periodInstants,
  indicesInWindow,
  nearIndex,
  localToday,
} from "./calendar";
export type Subscription = typeof billingSubscriptions.$inferSelect;
export type SubscriptionTerm = typeof billingSubscriptionTerms.$inferSelect;
export type BillingPeriod = typeof billingPeriods.$inferSelect;
export function effectiveTerms(
  subscription: Subscription,
  terms: SubscriptionTerm[],
  index: number,
) {
  const eligible = terms
    .filter(
      (term) =>
        term.subscriptionId === subscription.id &&
        term.effectivePeriodIndex <= index,
    )
    .sort(
      (a, b) =>
        b.effectivePeriodIndex - a.effectivePeriodIndex ||
        b.revision - a.revision,
    );
  const commercial = eligible.find((term) => term.kind === "commercial");
  const state =
    subscription.cancellationEffectivePeriodIndex !== null &&
    index >= subscription.cancellationEffectivePeriodIndex
      ? terms.find(
          (term) =>
            term.subscriptionId === subscription.id &&
            term.kind === "state" &&
            term.billingState === "cancelled" &&
            term.effectivePeriodIndex ===
              subscription.cancellationEffectivePeriodIndex,
        )
      : eligible.find((term) => term.kind === "state");
  if (
    !commercial ||
    commercial.label === null ||
    commercial.amountMinor === null ||
    commercial.paymentArrangement === null ||
    !state?.billingState
  )
    throw new Error("Subscription terms are incomplete");
  return {
    commercialRevision: commercial.revision,
    stateRevision: state.revision,
    label: commercial.label,
    amountMinor: commercial.amountMinor,
    paymentArrangement: commercial.paymentArrangement,
    billingState: state.billingState,
  };
}
export function derivePeriod(
  subscription: Subscription,
  terms: SubscriptionTerm[],
  periodIndex: number,
) {
  const boundary = periodBoundary(subscription, periodIndex);
  return {
    subscriptionId: subscription.id,
    customerId: subscription.customerId,
    deploymentKey: subscription.deploymentKey,
    ...boundary,
    ...effectiveTerms(subscription, terms, periodIndex),
    currency: "USD" as const,
    calendar: subscription.calendar,
    ...periodInstants(boundary.dueDate, subscription.calendar),
  };
}
const instant = (value: string | null) =>
  value === null ? null : new Date(value).toISOString();
export function samePeriod(
  row: BillingPeriod,
  facts: ReturnType<typeof derivePeriod>,
): boolean {
  const {
    id: _id,
    sealedAt: _sealedAt,
    invoiceGroupId: _invoiceGroupId,
    ...stored
  } = row;
  return (
    canonicalize({
      ...stored,
      issueAt: instant(stored.issueAt),
      chargeAt: instant(stored.chargeAt),
      dueEndAt: instant(stored.dueEndAt),
    }) ===
    canonicalize({
      ...facts,
      issueAt: instant(facts.issueAt),
      chargeAt: instant(facts.chargeAt),
      dueEndAt: instant(facts.dueEndAt),
    })
  );
}
export function buildForecast(
  subscriptions: Subscription[],
  terms: SubscriptionTerm[],
  stored: BillingPeriod[],
  query: ForecastQuery,
  now: Date,
): ForecastResponse {
  if (subscriptions.length > 100)
    throw new RangeError("Too many subscriptions for one forecast");
  type Group = ForecastResponse["groups"][number];
  const groups = new Map<string, Group>();
  const deriveCache = new Map<string, ReturnType<typeof derivePeriod>>();
  const derive = (sub: Subscription, index: number) => {
    const key = `${sub.id}:${index}`;
    let period = deriveCache.get(key);
    if (!period) {
      period = derivePeriod(sub, terms, index);
      deriveCache.set(key, period);
    }
    return period;
  };
  let complete = true,
    count = 0;
  for (const sub of subscriptions)
    for (const index of indicesInWindow(
      sub,
      sub.firstUnbilledPeriodIndex,
      query.fromDueDate,
      query.throughDueDate,
    )) {
      if (++count > 3700) throw new RangeError("Too many forecast periods");
      const expected = derive(sub, index);
      const row = stored.find(
        (row) => row.subscriptionId === sub.id && row.periodIndex === index,
      );
      const facts = row?.sealedAt
        ? (({ invoiceGroupId: _claim, ...facts }) => facts)(row)
        : expected;
      const key = `${facts.dueDate}:${facts.paymentArrangement}`;
      let group = groups.get(key);
      if (!group) {
        group = {
          dueDate: facts.dueDate,
          currency: "USD",
          paymentArrangement: facts.paymentArrangement,
          totalMinor: 0,
          outcome: "inactive",
          reviewReasons: [],
          periods: [],
        };
        groups.set(key, group);
      }
      const warn = (reason: Group["reviewReasons"][number]) => {
        if (!group.reviewReasons.includes(reason))
          group.reviewReasons.push(reason);
      };
      if (!row || (!row.sealedAt && !samePeriod(row, expected))) {
        complete = false;
        warn("not_materialized");
      }
      if (
        group.periods.length &&
        canonicalize(group.periods[0].calendar) !== canonicalize(facts.calendar)
      )
        warn("calendar_mismatch");
      const {
        customerId: _customerId,
        deploymentKey: _deploymentKey,
        currency: _currency,
        ...publicFacts
      } = facts;
      group.periods.push({
        ...publicFacts,
        id: row?.id ?? null,
        serviceId: sub.serviceId,
        issueAt: instant(facts.issueAt),
        chargeAt: instant(facts.chargeAt),
        dueEndAt: instant(facts.dueEndAt),
        sealedAt: instant(row?.sealedAt ?? null),
      });
      if (facts.billingState !== "billable") continue;
      group.totalMinor += facts.amountMinor;
      if (facts.amountMinor < 0) warn("negative_amount");
      if (!facts.issueAt || !facts.chargeAt || !facts.dueEndAt)
        warn("invalid_local_time");
      if (!row?.sealedAt && facts.dueDate < localToday(now, facts.calendar))
        warn("past_due");
      if (sub.serviceId && facts.amountMinor > 0) {
        for (const other of subscriptions) {
          if (other.id === sub.id || other.serviceId !== sub.serviceId)
            continue;
          for (
            let i = Math.max(
              other.firstUnbilledPeriodIndex,
              nearIndex(
                other.periodAnchorDate,
                other.intervalMonths,
                facts.periodStart,
              ),
            );
            i <= 120000;
            i++
          ) {
            const candidate = derive(other, i);
            if (candidate.periodStart >= facts.periodEnd) break;
            if (
              candidate.periodEnd > facts.periodStart &&
              candidate.billingState === "billable" &&
              candidate.amountMinor > 0
            ) {
              warn("overlapping_agreement");
              break;
            }
          }
        }
      }
    }
  for (const group of groups.values()) {
    const active = group.periods.filter(
      (period) => period.billingState === "billable",
    );
    if (active.length > 100 && !group.reviewReasons.includes("too_many_lines"))
      group.reviewReasons.push("too_many_lines");
    if (
      (group.totalMinor > 0 && group.totalMinor < 50) ||
      group.totalMinor > 99999999
    )
      group.reviewReasons.push("unsupported_total");
    group.outcome = group.reviewReasons.length
      ? "needs_review"
      : !active.length
        ? "inactive"
        : group.totalMinor === 0
          ? "no_charge"
          : "billable";
    group.periods.sort(
      (a, b) =>
        a.subscriptionId.localeCompare(b.subscriptionId) ||
        a.periodIndex - b.periodIndex,
    );
    group.reviewReasons.sort();
  }
  const result = [...groups.values()].sort(
    (a, b) =>
      a.dueDate.localeCompare(b.dueDate) ||
      a.paymentArrangement.localeCompare(b.paymentArrangement),
  );
  return {
    ...query,
    groups: result.slice(query.offset, query.offset + query.limit),
    total: result.length,
    complete,
  };
}
