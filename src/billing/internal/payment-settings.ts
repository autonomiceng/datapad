import { billingEnrollmentScopes as scopes } from "./payment-scope-schema";
import { randomUUID, randomInt, createHash } from "node:crypto";
import canonicalize from "canonicalize";
import { and, asc, eq, gte, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Value } from "@sinclair/typebox/value";
import { AuditRequestConflict } from "../../access";
import type { HumanActor, AccessResult } from "../../access/types";
import type { AccessErrorCode } from "../../access/contract";
import type {
  PaymentSettingsOptions,
  PaymentSettings,
} from "../payment-settings-types";
import {
  SAVE_TERMS_VERSION,
  SAVE_TERMS_TEXT,
  ENROLLMENT_TERMS_VERSION,
  ENROLLMENT_TERMS_TEXT,
  StartPaymentSetupRequestSchema,
  ReplaceEnrollmentRequestSchema,
  ReduceEnrollmentRequestSchema,
  type EnrollmentScope,
  type ReplaceEnrollmentRequest,
  type ReduceEnrollmentRequest,
  type PaymentSettingsResponse,
} from "../payment-settings-contract";
import {
  billingPaymentSetups as setups,
  billingPaymentMethods as methods,
  billingEnrollments as enrollments,
  billingEnrollmentNoops as noops,
} from "./payment-settings-schema";
import {
  billingSubscriptions as subscriptions,
  billingSubscriptionTerms as terms,
  billingPeriods as periods,
} from "./subscriptions-schema";
import { billingInvoiceGroups as groups } from "./scheduled-schema";
import { billingCustomers, invoices } from "./invoice-schema";
import {
  currentEnrollment,
  enrollmentView,
  covers,
} from "./payment-enrollment";
import { lockSubscriptionCustomer } from "./subscription-lock";
import { ensureMapping } from "./requests";
import {
  periodBoundary,
  localToday,
  horizon,
  indicesInWindow,
  nearIndex,
} from "./calendar";
import {
  derivePeriod,
  effectiveTerms,
  type Subscription,
  type SubscriptionTerm,
} from "./forecast";
import { isUuid } from "./validate";
import {
  createSetupRecovery,
  usableCard,
  setupReturnUrl,
} from "./payment-setup";
const equal = (a: unknown, b: unknown) => canonicalize(a) === canonicalize(b);
const digest = (value: unknown) =>
  createHash("sha256").update(canonicalize(value)!).digest("hex");
class PaymentSettingsFailure extends Error {
  constructor(readonly code: AccessErrorCode) {
    super(code);
  }
}
function fail(code: AccessErrorCode): never {
  throw new PaymentSettingsFailure(code);
}
async function result<T>(work: () => Promise<T>): Promise<AccessResult<T>> {
  try {
    return { ok: true, value: await work() };
  } catch (error) {
    if (error instanceof PaymentSettingsFailure)
      return { ok: false, code: error.code };
    if (error instanceof AuditRequestConflict)
      return { ok: false, code: "conflict" };
    if (error instanceof RangeError)
      return { ok: false, code: "invalid_request" };
    throw error;
  }
}
/** Composes administrator consent and hosted card setup with matching sandbox ownership.
 * A null provider supports persisted reads; setup effects run outside transactions and never collect payment. */
export function createPaymentSettings(
  options: PaymentSettingsOptions,
): PaymentSettings {
  const {
    pool,
    deploymentKey,
    providerOwnership,
    customerAccess,
    audit,
    now = () => new Date(),
  } = options;
  if (
    !/^[A-Za-z0-9_-]{1,64}$/.test(deploymentKey) ||
    (providerOwnership !== null &&
      (providerOwnership.deploymentKey !== deploymentKey ||
        !providerOwnership.accountId)) ||
    (options.provider && !equal(options.provider.ownership, providerOwnership))
  )
    throw new Error("Invalid payment settings configuration");
  const returnUrls = [options.successUrl, options.cancelUrl].map(
    (address) => new URL(address),
  );
  if (
    returnUrls.some(
      (url) =>
        url.username ||
        url.password ||
        url.hash ||
        !["http:", "https:"].includes(url.protocol),
    ) ||
    returnUrls[0].origin !== returnUrls[1].origin
  )
    throw new Error("Invalid payment setup return URL");
  const db = drizzle(pool),
    recovery = createSetupRecovery(options);
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
      mutation ? "manage_payment_settings" : "read_billing",
      mutation,
    );
    if (!access.ok) fail(access.code);
    if (
      mutation &&
      (access.value.customerRole !== "administrator" ||
        !access.value.customerMembership)
    )
      fail("forbidden");
    return access.value;
  }
  async function assertCustomerOwnership(
    tx: NodePgDatabase,
    customerId: string,
  ) {
    const [mapping] = await tx
      .select({ accountId: billingCustomers.providerAccountId })
      .from(billingCustomers)
      .where(
        and(
          eq(billingCustomers.customerId, customerId),
          eq(billingCustomers.deploymentKey, deploymentKey),
        ),
      );
    if (
      mapping &&
      (!providerOwnership || mapping.accountId !== providerOwnership.accountId)
    )
      fail("unavailable");
  }
  const owner = (customerId: string) =>
    and(
      eq(subscriptions.customerId, customerId),
      eq(subscriptions.deploymentKey, deploymentKey),
    );
  async function load(tx: NodePgDatabase, customerId: string) {
    const rows = await tx
      .select()
      .from(subscriptions)
      .where(owner(customerId))
      .orderBy(asc(subscriptions.id))
      .limit(101);
    if (rows.length > 100) fail("invalid_request");
    const revisions = rows.length
      ? await tx
          .select()
          .from(terms)
          .where(
            inArray(
              terms.subscriptionId,
              rows.map((s) => s.id),
            ),
          )
          .orderBy(asc(terms.revision))
      : [];
    return { rows, revisions };
  }
  function allowed(
    sub: Subscription,
    commercial: ReturnType<typeof effectiveTerms>,
  ) {
    return options.allowSubscription({
      customerId: sub.customerId,
      serviceId: sub.serviceId,
      periodAnchorDate: sub.periodAnchorDate,
      dueAnchorDate: sub.dueAnchorDate,
      intervalMonths: sub.intervalMonths,
      firstUnbilledPeriodIndex: sub.firstUnbilledPeriodIndex,
      calendar: sub.calendar,
      cancellationReason: sub.cancellationReason,
      label: commercial.label,
      amountMinor: commercial.amountMinor,
      paymentArrangement: commercial.paymentArrangement,
    });
  }
  const nextRevision = (
    sub: Subscription,
    revisions: SubscriptionTerm[],
    from: number,
  ) =>
    revisions
      .filter(
        (t) =>
          t.subscriptionId === sub.id &&
          t.kind === "commercial" &&
          t.effectivePeriodIndex > from,
      )
      .sort((a, b) => a.effectivePeriodIndex - b.effectivePeriodIndex)[0]
      ?.effectivePeriodIndex ?? null;
  function retainedScopeView(
    scope: EnrollmentScope,
    sub: Subscription,
    revisions: SubscriptionTerm[],
  ): NonNullable<
    PaymentSettingsResponse["subscriptions"][number]["retainedScope"]
  > {
    const term = revisions.find(
      (revision) =>
        revision.subscriptionId === scope.subscriptionId &&
        revision.revision === scope.commercialRevision,
    );
    if (
      !term ||
      term.customerId !== sub.customerId ||
      term.deploymentKey !== sub.deploymentKey ||
      term.kind !== "commercial" ||
      term.paymentArrangement !== "automatic" ||
      term.currency !== "USD" ||
      term.label === null ||
      term.amountMinor === null ||
      term.amountMinor < 0 ||
      term.effectivePeriodIndex > scope.fromPeriodIndex ||
      !equal(scope.calendar, sub.calendar)
    )
      fail("unavailable");
    try {
      const start = periodBoundary(sub, scope.fromPeriodIndex);
      if (
        start.periodStart !== scope.periodStart ||
        start.dueDate !== scope.dueDate ||
        (scope.untilPeriodIndex !== null &&
          scope.untilPeriodIndex <= scope.fromPeriodIndex)
      )
        fail("unavailable");
      return {
        ...scope,
        label: term.label,
        amountMinor: term.amountMinor,
        currency: term.currency,
        intervalMonths: sub.intervalMonths,
        untilPeriodStart:
          scope.untilPeriodIndex === null
            ? null
            : periodBoundary(sub, scope.untilPeriodIndex).periodStart,
      };
    } catch (error) {
      if (error instanceof RangeError) fail("unavailable");
      throw error;
    }
  }
  async function view(
    tx: NodePgDatabase,
    actor: HumanActor,
    customerId: string,
  ): Promise<PaymentSettingsResponse> {
    const access = await authorize(tx, actor, customerId, false);
    const current = await currentEnrollment(tx, deploymentKey, customerId);
    const { rows, revisions } = await load(tx, customerId);
    await assertCustomerOwnership(tx, customerId);
    const enrollment = current ? await enrollmentView(tx, current) : null;
    const retained = new Map(
      (enrollment?.scopes ?? []).map((scope) => {
        const sub = rows.find((sub) => sub.id === scope.subscriptionId);
        if (!sub) fail("unavailable");
        return [sub.id, retainedScopeView(scope, sub, revisions)] as const;
      }),
    );
    const sealed = await tx
      .select({
        subscriptionId: periods.subscriptionId,
        periodIndex: periods.periodIndex,
      })
      .from(periods)
      .where(
        and(
          eq(periods.customerId, customerId),
          eq(periods.deploymentKey, deploymentKey),
          isNotNull(periods.sealedAt),
        ),
      );
    const saved = await tx
      .select()
      .from(methods)
      .where(
        and(
          eq(methods.customerId, customerId),
          eq(methods.deploymentKey, deploymentKey),
        ),
      )
      .orderBy(asc(methods.verifiedAt), asc(methods.id));
    if (
      saved.some(
        (method) =>
          !providerOwnership ||
          method.providerAccountId !== providerOwnership.accountId,
      )
    )
      fail("unavailable");
    const affected = current
      ? await tx
          .select({
            invoiceId: invoices.id,
            groupId: groups.id,
            dueDate: groups.dueDate,
            totalMinor: groups.totalMinor,
          })
          .from(groups)
          .innerJoin(invoices, eq(invoices.id, groups.invoiceId))
          .where(
            and(
              eq(groups.enrollmentId, current.id),
              sql`${invoices.state} not in ('paid','void')`,
            ),
          )
          .orderBy(asc(groups.dueDate), asc(groups.id))
      : [];
    return {
      canManage:
        access.customerRole === "administrator" && !!access.customerMembership,
      setupAvailable: !!options.provider,
      saveTerms: { version: SAVE_TERMS_VERSION, text: SAVE_TERMS_TEXT },
      enrollmentTerms: {
        version: ENROLLMENT_TERMS_VERSION,
        text: ENROLLMENT_TERMS_TEXT,
      },
      methods: saved.map((m) => ({
        id: m.id,
        brand: m.brand,
        last4: m.last4,
        expiryMonth: m.expiryMonth,
        expiryYear: m.expiryYear,
        verifiedAt: new Date(m.verifiedAt).toISOString(),
        usable: usableCard(m, now()),
      })),
      enrollment,
      consentAdministratorOrigin:
        !current || !access.staffRoles.length
          ? null
          : current.membershipProvenance.invitedByStaff === true
            ? "staff_invited"
            : current.membershipProvenance.invitedByStaff === false
              ? "customer_invited"
              : "unknown",
      affectedInvoices: affected,
      subscriptions: rows.map((sub) => {
        const today = localToday(now(), sub.calendar);
        let currentIndex = Math.max(
          sub.firstUnbilledPeriodIndex,
          nearIndex(sub.periodAnchorDate, sub.intervalMonths, today),
        );
        while (periodBoundary(sub, currentIndex + 1).periodStart <= today)
          currentIndex++;
        const currentTerms = effectiveTerms(sub, revisions, currentIndex);
        const boundaries = indicesInWindow(
          sub,
          sub.firstUnbilledPeriodIndex,
          localToday(now(), sub.calendar),
          horizon(now(), sub.calendar),
        )
          .filter(
            (i) =>
              i !== retained.get(sub.id)?.fromPeriodIndex &&
              periodBoundary(sub, i).periodStart >
                localToday(now(), sub.calendar) &&
              !sealed.some(
                (p) => p.subscriptionId === sub.id && p.periodIndex >= i,
              ),
          )
          .map((i) => {
            const commercial = effectiveTerms(sub, revisions, i),
              boundary = periodBoundary(sub, i),
              untilPeriodIndex = nextRevision(sub, revisions, i);
            return {
              fromPeriodIndex: i,
              periodStart: boundary.periodStart,
              dueDate: boundary.dueDate,
              commercialRevision: commercial.commercialRevision,
              untilPeriodIndex,
              untilPeriodStart:
                untilPeriodIndex === null
                  ? null
                  : periodBoundary(sub, untilPeriodIndex).periodStart,
              label: commercial.label,
              amountMinor: commercial.amountMinor,
              paymentArrangement: commercial.paymentArrangement,
            };
          });
        return {
          id: sub.id,
          label: currentTerms.label,
          version: sub.version,
          calendar: sub.calendar,
          intervalMonths: sub.intervalMonths,
          retainedScope: retained.get(sub.id) ?? null,
          boundaries,
          blocker: boundaries.length ? null : "no_future_boundary",
        };
      }),
    };
  }
  async function noopReceipt(tx: NodePgDatabase, requestId: string) {
    const [receipt] = await tx
      .select()
      .from(noops)
      .where(
        and(
          eq(noops.deploymentKey, deploymentKey),
          eq(noops.requestId, requestId),
        ),
      );
    return receipt;
  }
  async function change(
    actor: HumanActor,
    customerId: string,
    input: ReplaceEnrollmentRequest | ReduceEnrollmentRequest,
    reducing: boolean,
  ) {
    if (
      !Value.Check(
        reducing
          ? ReduceEnrollmentRequestSchema
          : ReplaceEnrollmentRequestSchema,
        input,
      )
    )
      fail("invalid_request");
    return db.transaction(async (tx) => {
      const access = await authorize(tx, actor, customerId, true);
      await assertCustomerOwnership(tx, customerId);
      if (!reducing && !providerOwnership) fail("unavailable");
      await lockSubscriptionCustomer(tx, deploymentKey, customerId);
      const requestDigest = digest({
        customerId,
        input,
        decision: reducing ? "reduce" : "authorize",
      });
      const [replayed] = await tx
        .select()
        .from(enrollments)
        .where(
          and(
            eq(enrollments.deploymentKey, deploymentKey),
            eq(enrollments.requestId, input.requestId),
          ),
        );
      if (replayed) {
        if (
          replayed.customerId !== customerId ||
          replayed.requestDigest !== requestDigest
        )
          fail("conflict");
        return {
          outcome: "unchanged" as const,
          enrollment: await enrollmentView(tx, replayed),
        };
      }
      async function replayNoop() {
        const receipt = await noopReceipt(tx, input.requestId);
        if (!receipt) return null;
        if (
          receipt.customerId !== customerId ||
          receipt.requestDigest !== requestDigest
        )
          fail("conflict");
        const [enrollment] = await tx
          .select()
          .from(enrollments)
          .where(
            and(
              eq(enrollments.id, receipt.enrollmentId),
              eq(enrollments.customerId, customerId),
              eq(enrollments.deploymentKey, deploymentKey),
            ),
          );
        if (!enrollment) fail("unavailable");
        return {
          outcome: "unchanged" as const,
          enrollment: await enrollmentView(tx, enrollment),
        };
      }
      const replay = await replayNoop();
      if (replay) return replay;
      await audit.assertRequestUnused(tx, input.requestId);
      // Another customer's command may have claimed this ID while we waited for its request lock.
      const lockedReplay = await replayNoop();
      if (lockedReplay) return lockedReplay;
      const current = await currentEnrollment(tx, deploymentKey, customerId),
        old = current ? await enrollmentView(tx, current) : null;
      if ((current?.version ?? 0) !== input.expectedVersion) fail("conflict");
      let paymentMethodId: string | null;
      let selected: EnrollmentScope[];
      if ("retainSubscriptionIds" in input) {
        if (!old) fail("conflict");
        if (
          input.retainSubscriptionIds.some(
            (id) => !old.scopes.some((s) => s.subscriptionId === id),
          )
        )
          fail("invalid_request");
        selected = old.scopes.filter((s) =>
          input.retainSubscriptionIds.includes(s.subscriptionId),
        );
        paymentMethodId = selected.length ? old.paymentMethodId : null;
      } else {
        if (!providerOwnership) fail("unavailable");
        const [method] = await tx
          .select()
          .from(methods)
          .where(
            and(
              eq(methods.id, input.paymentMethodId),
              eq(methods.customerId, customerId),
              eq(methods.deploymentKey, deploymentKey),
            ),
          );
        if (!method) fail("not_found");
        if (
          method.providerAccountId !== providerOwnership.accountId ||
          !usableCard(method, now())
        )
          fail("conflict");
        paymentMethodId = method.id;
        if (
          new Set(input.selections.map((s) => s.subscriptionId)).size !==
          input.selections.length
        )
          fail("invalid_request");
        const { rows, revisions } = await load(tx, customerId);
        selected = [];
        for (const selection of [...input.selections].sort((a, b) =>
          a.subscriptionId.localeCompare(b.subscriptionId),
        )) {
          const sub = rows.find((s) => s.id === selection.subscriptionId);
          if (!sub) fail("not_found");
          if (sub.version !== selection.expectedSubscriptionVersion)
            fail("conflict");
          const retained = old?.scopes.find(
            (s) =>
              s.subscriptionId === sub.id &&
              s.fromPeriodIndex === selection.fromPeriodIndex,
          );
          if (retained) {
            selected.push(retained);
            continue;
          }
          const from = selection.fromPeriodIndex,
            boundary = periodBoundary(sub, from);
          if (
            from < sub.firstUnbilledPeriodIndex ||
            boundary.periodStart <= localToday(now(), sub.calendar) ||
            boundary.dueDate > horizon(now(), sub.calendar)
          )
            fail("conflict");
          const [sealed] = await tx
            .select({ id: periods.id })
            .from(periods)
            .where(
              and(
                eq(periods.subscriptionId, sub.id),
                gte(periods.periodIndex, from),
                isNotNull(periods.sealedAt),
              ),
            )
            .limit(1);
          if (sealed) fail("conflict");
          let commercial = effectiveTerms(sub, revisions, from);
          if (
            commercial.billingState !== "billable" ||
            commercial.amountMinor < 0
          )
            fail("conflict");
          if (commercial.paymentArrangement === "manual") {
            const revision =
              Math.max(
                ...revisions
                  .filter((t) => t.subscriptionId === sub.id)
                  .map((t) => t.revision),
              ) + 1;
            commercial = {
              ...commercial,
              paymentArrangement: "automatic",
              commercialRevision: revision,
            };
            if (!allowed(sub, commercial)) fail("invalid_request");
            const [term] = await tx
              .insert(terms)
              .values({
                subscriptionId: sub.id,
                customerId,
                deploymentKey,
                revision,
                kind: "commercial",
                effectivePeriodIndex: from,
                label: commercial.label,
                amountMinor: commercial.amountMinor,
                currency: "USD",
                paymentArrangement: "automatic",
              })
              .returning();
            revisions.push(term);
            await tx
              .update(subscriptions)
              .set({ version: sub.version + 1, updatedAt: now().toISOString() })
              .where(eq(subscriptions.id, sub.id));
            const until = nextRevision(sub, revisions, from);
            const affected = await tx
              .select()
              .from(periods)
              .where(
                and(
                  eq(periods.subscriptionId, sub.id),
                  gte(periods.periodIndex, from),
                  until === null ? undefined : lt(periods.periodIndex, until),
                ),
              );
            for (const period of affected)
              await tx
                .update(periods)
                .set(derivePeriod(sub, revisions, period.periodIndex))
                .where(eq(periods.id, period.id));
          } else if (!allowed(sub, commercial)) fail("invalid_request");
          selected.push({
            subscriptionId: sub.id,
            commercialRevision: commercial.commercialRevision,
            fromPeriodIndex: from,
            untilPeriodIndex: nextRevision(sub, revisions, from),
            periodStart: boundary.periodStart,
            dueDate: boundary.dueDate,
            calendar: sub.calendar,
          });
        }
      }
      selected.sort((a, b) => a.subscriptionId.localeCompare(b.subscriptionId));
      if (
        old &&
        paymentMethodId === old.paymentMethodId &&
        equal(selected, old.scopes)
      ) {
        await tx.insert(noops).values({
          deploymentKey,
          requestId: input.requestId,
          customerId,
          enrollmentId: old.id,
          requestDigest,
          request: input,
        });
        return { outcome: "unchanged" as const, enrollment: old };
      }
      const membership = access.customerMembership!;
      const provenance = {
        invitationId: membership.invitationId,
        invitedByUserId: membership.invitedByUserId,
        invitedByStaff: membership.invitedByStaff,
      };
      const [created] = await tx
        .insert(enrollments)
        .values({
          id: randomUUID(),
          customerId,
          deploymentKey,
          version: (current?.version ?? 0) + 1,
          requestId: input.requestId,
          requestDigest,
          request: input,
          predecessorId: current?.id ?? null,
          decision: reducing ? "reduce" : "authorize",
          actorUserId: actor.userId,
          actorSessionId: actor.sessionId,
          consentingMembershipId: membership.id,
          membershipProvenance: provenance,
          acceptedAt: now().toISOString(),
          termsVersion: ENROLLMENT_TERMS_VERSION,
          termsDigest: digest(ENROLLMENT_TERMS_TEXT),
          paymentMethodId,
        })
        .returning();
      if (selected.length)
        await tx.insert(scopes).values(
          selected.map((s) => ({
            ...s,
            enrollmentId: created.id,
            customerId,
            deploymentKey,
          })),
        );
      await audit.append(tx, {
        requestId: input.requestId,
        actor,
        customerId,
        targetId: created.id,
        action: "payment_enrollment.changed",
        changedFields: ["method", "scopes"],
        consentingMembershipId: membership.id,
        membershipProvenance: provenance,
      });
      return {
        outcome: "changed" as const,
        enrollment: await enrollmentView(tx, created),
      };
    });
  }
  return {
    getPaymentSettings: (actor, customerId) =>
      result(() =>
        db.transaction((tx) => view(tx, actor, customerId), {
          isolationLevel: "repeatable read",
        }),
      ),
    replaceEnrollment: (actor, customerId, input) =>
      result(() => change(actor, customerId, input, false)),
    reduceEnrollment: (actor, customerId, input) =>
      result(() => change(actor, customerId, input, true)),
    startSetup: (actor, customerId, input) =>
      result(async () => {
        if (!Value.Check(StartPaymentSetupRequestSchema, input))
          fail("invalid_request");
        const id = await db.transaction(async (tx) => {
          const access = await authorize(tx, actor, customerId, true);
          if (!options.provider || !providerOwnership) fail("unavailable");
          const profile = await customerAccess.readProfile(tx, customerId, {
            lock: true,
          });
          if (!profile) fail("not_found");
          await lockSubscriptionCustomer(tx, deploymentKey, customerId);
          const requestDigest = digest({ customerId, input });
          const [old] = await tx
            .select()
            .from(setups)
            .where(
              and(
                eq(setups.deploymentKey, deploymentKey),
                eq(setups.requestId, input.requestId),
              ),
            );
          if (old) {
            if (
              old.customerId !== customerId ||
              old.requestDigest !== requestDigest
            )
              fail("conflict");
            return old.id;
          }
          await audit.assertRequestUnused(tx, input.requestId);
          if (await noopReceipt(tx, input.requestId)) fail("conflict");
          if (!options.allowProfile(profile.profile)) fail("invalid_request");
          const mapping = await ensureMapping(
            tx,
            { deploymentKey, provider: { ownership: providerOwnership } },
            profile,
            `customer:${customerId}`,
            profile.profile.legalName,
            now().toISOString(),
          );
          if (!mapping || !options.allowMappingName(customerId, mapping.name))
            fail("conflict");
          const id = randomUUID(),
            membership = access.customerMembership!;
          const provenance = {
            invitationId: membership.invitationId,
            invitedByUserId: membership.invitedByUserId,
            invitedByStaff: membership.invitedByStaff,
          };
          await tx.insert(setups).values({
            id,
            customerId,
            deploymentKey,
            billingCustomerId: mapping.id,
            providerAccountId: providerOwnership.accountId,
            requestId: input.requestId,
            requestDigest,
            actorUserId: actor.userId,
            actorSessionId: actor.sessionId,
            consentingMembershipId: membership.id,
            membershipProvenance: provenance,
            saveTermsVersion: SAVE_TERMS_VERSION,
            saveTermsDigest: digest(SAVE_TERMS_TEXT),
            acceptedAt: now().toISOString(),
            successUrl: setupReturnUrl(options.successUrl, customerId, id),
            cancelUrl: setupReturnUrl(options.cancelUrl, customerId, id),
            integrationIdentifier: `datapad_setup_${Array.from({ length: 8 }, () => String.fromCharCode(97 + randomInt(26))).join("")}`,
            status: "pending",
            retrievalRequestedAt: now().toISOString(),
          });
          await audit.append(tx, {
            requestId: input.requestId,
            actor,
            customerId,
            targetId: id,
            action: "payment_setup.started",
            changedFields: ["saveTerms"],
            consentingMembershipId: membership.id,
            membershipProvenance: provenance,
          });
          return id;
        });
        await recovery.processSetup(id);
        return db.transaction(async (tx) => {
          await authorize(tx, actor, customerId, true);
          return recovery.response(tx, id);
        });
      }),
    refreshSetup: (actor, customerId, setupId) =>
      result(async () => {
        if (!isUuid(setupId)) fail("not_found");
        await db.transaction(async (tx) => {
          await authorize(tx, actor, customerId, true);
          const [setup] = await tx
            .select()
            .from(setups)
            .where(
              and(
                eq(setups.id, setupId),
                eq(setups.customerId, customerId),
                eq(setups.deploymentKey, deploymentKey),
              ),
            );
          if (!setup) fail("not_found");
          await assertCustomerOwnership(tx, customerId);
        });
        await recovery.processSetup(setupId, true);
        return db.transaction(async (tx) => {
          await authorize(tx, actor, customerId, true);
          return recovery.response(tx, setupId);
        });
      }),
    receiveSetupEvent: recovery.receiveSetupEvent,
    processSetup: recovery.processSetup,
    inspectSetup: recovery.inspectSetup,
    pendingSetups: recovery.pendingSetups,
    async assertSyntheticData() {
      const setupMappingIds = await recovery.assertSyntheticData();
      const all = await db
        .select()
        .from(enrollments)
        .orderBy(asc(enrollments.customerId), asc(enrollments.version));
      const previous = new Map<string, typeof enrollments.$inferSelect>();
      for (const row of all) {
        if (
          !providerOwnership ||
          row.deploymentKey !== deploymentKey ||
          row.termsVersion !== ENROLLMENT_TERMS_VERSION ||
          row.termsDigest !== digest(ENROLLMENT_TERMS_TEXT) ||
          !row.consentingMembershipId ||
          !Value.Check(
            row.decision === "reduce"
              ? ReduceEnrollmentRequestSchema
              : ReplaceEnrollmentRequestSchema,
            row.request,
          ) ||
          row.request.requestId !== row.requestId ||
          row.request.expectedVersion !== row.version - 1 ||
          row.requestDigest !==
            digest({
              customerId: row.customerId,
              input: row.request,
              decision: row.decision,
            })
        )
          throw new Error("Unexpected enrollment evidence");
        const profile = await customerAccess.readProfile(db, row.customerId);
        if (!profile || !options.allowProfile(profile.profile))
          throw new Error("Unexpected enrollment customer");
        const prior = previous.get(row.customerId);
        if (
          row.version !== (prior?.version ?? 0) + 1 ||
          row.predecessorId !== (prior?.id ?? null)
        )
          throw new Error("Unexpected enrollment sequence");
        const enrollment = await enrollmentView(db, row),
          old = prior ? await enrollmentView(db, prior) : null;
        if (
          enrollment.scopes.length > 100 ||
          enrollment.scopes.length > 0 !== !!row.paymentMethodId
        )
          throw new Error("Unexpected enrollment scope");
        if ("selections" in row.request) {
          const request = row.request;
          if (
            row.paymentMethodId !== request.paymentMethodId ||
            enrollment.scopes.length !== request.selections.length ||
            !enrollment.scopes.every((scope) =>
              request.selections.some(
                (selection) =>
                  selection.subscriptionId === scope.subscriptionId &&
                  selection.fromPeriodIndex === scope.fromPeriodIndex,
              ),
            )
          )
            throw new Error("Unexpected enrollment selection");
        } else if (
          enrollment.scopes.length !==
            row.request.retainSubscriptionIds.length ||
          !enrollment.scopes.every(
            (scope) =>
              "retainSubscriptionIds" in row.request &&
              row.request.retainSubscriptionIds.includes(scope.subscriptionId),
          )
        )
          throw new Error("Unexpected enrollment reduction");
        const { rows, revisions } = await load(db, row.customerId);
        for (const scope of enrollment.scopes) {
          const sub = rows.find((s) => s.id === scope.subscriptionId),
            term = revisions.find(
              (t) =>
                t.subscriptionId === scope.subscriptionId &&
                t.revision === scope.commercialRevision,
            );
          if (
            !sub ||
            !term ||
            term.kind !== "commercial" ||
            term.paymentArrangement !== "automatic" ||
            !equal(scope.calendar, sub.calendar)
          )
            throw new Error("Unexpected enrollment revision");
          const retained = old?.scopes.some((previousScope) =>
            equal(previousScope, scope),
          );
          if (
            !retained &&
            scope.periodStart <=
              localToday(new Date(row.acceptedAt), scope.calendar)
          )
            throw new Error("Unexpected enrollment effective date");
          const boundary = periodBoundary(sub, scope.fromPeriodIndex);
          if (
            scope.periodStart !== boundary.periodStart ||
            scope.dueDate !== boundary.dueDate ||
            scope.fromPeriodIndex < sub.firstUnbilledPeriodIndex ||
            !allowed(sub, {
              ...effectiveTerms(
                sub,
                [term, ...revisions.filter((t) => t.kind === "state")],
                scope.fromPeriodIndex,
              ),
            })
          )
            throw new Error("Unexpected enrollment boundary");
          if (
            row.decision === "reduce" &&
            (!old?.scopes.some((s) => equal(s, scope)) ||
              row.paymentMethodId !== old.paymentMethodId)
          )
            throw new Error("Unexpected reducing enrollment");
        }
        previous.set(row.customerId, row);
      }
      for (const receipt of await db.select().from(noops)) {
        const reducing = "retainSubscriptionIds" in receipt.request;
        const enrollment = all.find((row) => row.id === receipt.enrollmentId);
        if (
          receipt.deploymentKey !== deploymentKey ||
          !enrollment ||
          enrollment.customerId !== receipt.customerId ||
          enrollment.deploymentKey !== receipt.deploymentKey ||
          !Value.Check(
            reducing
              ? ReduceEnrollmentRequestSchema
              : ReplaceEnrollmentRequestSchema,
            receipt.request,
          ) ||
          receipt.request.requestId !== receipt.requestId ||
          receipt.request.expectedVersion !== enrollment.version ||
          receipt.requestDigest !==
            digest({
              customerId: receipt.customerId,
              input: receipt.request,
              decision: reducing ? "reduce" : "authorize",
            }) ||
          all.some((row) => row.requestId === receipt.requestId)
        )
          throw new Error("Unexpected unchanged enrollment receipt");
        const view = await enrollmentView(db, enrollment);
        const request = receipt.request;
        if ("retainSubscriptionIds" in request) {
          if (
            view.scopes.length !== request.retainSubscriptionIds.length ||
            !view.scopes.every((scope) =>
              request.retainSubscriptionIds.includes(scope.subscriptionId),
            )
          )
            throw new Error("Unexpected unchanged enrollment reduction");
        } else if (
          view.paymentMethodId !== request.paymentMethodId ||
          view.scopes.length !== request.selections.length ||
          !view.scopes.every((scope) =>
            request.selections.some(
              (selection) =>
                selection.subscriptionId === scope.subscriptionId &&
                selection.fromPeriodIndex === scope.fromPeriodIndex,
            ),
          )
        )
          throw new Error("Unexpected unchanged enrollment selection");
        const [setup] = await db
          .select({ id: setups.id })
          .from(setups)
          .where(
            and(
              eq(setups.deploymentKey, deploymentKey),
              eq(setups.requestId, receipt.requestId),
            ),
          );
        if (setup) throw new Error("Unexpected reused payment request");
      }
      for (const group of await db
        .select()
        .from(groups)
        .where(isNotNull(groups.enrollmentId))) {
        const enrollment = all.find((row) => row.id === group.enrollmentId);
        if (
          !enrollment ||
          enrollment.customerId !== group.customerId ||
          enrollment.deploymentKey !== group.deploymentKey ||
          group.paymentArrangement !== "automatic" ||
          group.totalMinor <= 0 ||
          group.paymentMethodId !== enrollment.paymentMethodId ||
          !group.paymentMethodId
        )
          throw new Error("Unexpected frozen enrollment");
        const frozen = await enrollmentView(db, enrollment);
        const lines = await db
          .select()
          .from(periods)
          .where(eq(periods.invoiceGroupId, group.id));
        if (
          !lines.length ||
          !lines.every((line) =>
            frozen.scopes.some((scope) => covers(scope, line)),
          )
        )
          throw new Error("Unexpected frozen enrollment coverage");
      }
      return setupMappingIds;
    },
  };
}
