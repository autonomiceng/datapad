import { randomUUID, createHash } from "node:crypto";
import canonicalize from "canonicalize";
import { and, asc, eq, isNull, or, lte, lt } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PaymentSettingsOptions } from "../payment-settings-types";
import {
  BillingProviderError,
  type PaymentSetupIntent,
  type ProviderPaymentSetup,
  type ProviderSavedPaymentMethod,
  type VerifiedPaymentSetupEvent,
} from "../provider";
import {
  SAVE_TERMS_VERSION,
  SAVE_TERMS_TEXT,
  type PaymentSetupResponse,
} from "../payment-settings-contract";
import {
  billingPaymentSetups as setups,
  billingPaymentMethods as methods,
} from "./payment-settings-schema";
import { billingCustomers } from "./invoice-schema";
import { withLocks } from "./locks";
import { isUuid } from "./validate";
const digest = (value: unknown) =>
  createHash("sha256").update(canonicalize(value)!).digest("hex");
/** Server-fixed return base plus local navigation identity; never payment evidence. */
export function setupReturnUrl(
  base: string,
  customerId: string,
  setupId: string,
): string {
  const url = new URL(base);
  url.searchParams.set("customerId", customerId);
  url.searchParams.set("setupId", setupId);
  return url.href;
}
export function usableCard(
  card: { expiryMonth: number; expiryYear: number },
  at: Date,
) {
  return (
    card.expiryYear > at.getUTCFullYear() ||
    (card.expiryYear === at.getUTCFullYear() &&
      card.expiryMonth >= at.getUTCMonth() + 1)
  );
}
function checkoutUrl(value: string | null) {
  if (value === null) return null;
  const url = new URL(value);
  if (
    value.length > 4096 ||
    url.protocol !== "https:" ||
    url.hostname !== "checkout.stripe.com" ||
    url.username ||
    url.password ||
    url.port
  )
    throw new Error("Invalid hosted setup URL");
  return value;
}
class SetupReview extends Error {}
function review(): never {
  throw new SetupReview("Payment setup needs review");
}
export function createSetupRecovery(options: PaymentSettingsOptions) {
  const {
      pool,
      deploymentKey,
      providerOwnership,
      provider,
      now = () => new Date(),
    } = options,
    db = drizzle(pool);
  const scope = (id: string) =>
    and(eq(setups.id, id), eq(setups.deploymentKey, deploymentKey));
  function intent(
    row: typeof setups.$inferSelect,
    providerCustomerId: string,
  ): PaymentSetupIntent {
    return {
      deploymentKey,
      accountId: row.providerAccountId,
      setupId: row.id,
      customerId: row.billingCustomerId,
      providerCustomerId,
      currency: "USD",
      successUrl: row.successUrl,
      cancelUrl: row.cancelUrl,
      integrationIdentifier: row.integrationIdentifier,
    };
  }
  function verify(
    expected: PaymentSetupIntent,
    receipt: ProviderPaymentSetup,
    row: typeof setups.$inferSelect,
  ) {
    for (const key of Object.keys(expected) as Array<keyof PaymentSetupIntent>)
      if (receipt[key] !== expected[key]) review();
    if (
      receipt.livemode !== false ||
      !receipt.providerSessionId ||
      (row.providerSessionId &&
        receipt.providerSessionId !== row.providerSessionId) ||
      (row.pendingSessionId &&
        receipt.providerSessionId !== row.pendingSessionId)
    )
      review();
    if (!["open", "complete", "expired"].includes(receipt.status)) review();
    try {
      checkoutUrl(receipt.checkoutUrl);
    } catch {
      review();
    }
    if (receipt.setupIntent) {
      const si = receipt.setupIntent;
      if (
        !si.providerSetupIntentId ||
        si.deploymentKey !== deploymentKey ||
        si.setupId !== row.id ||
        si.providerCustomerId !== expected.providerCustomerId ||
        si.livemode !== false ||
        si.usage !== "off_session" ||
        (row.providerSetupIntentId &&
          row.providerSetupIntentId !== si.providerSetupIntentId)
      )
        review();
    }
  }
  function verifiedCard(
    expected: PaymentSetupIntent,
    providerMethodId: string,
    method: ProviderSavedPaymentMethod,
  ) {
    const card = method.card;
    if (
      method.accountId !== expected.accountId ||
      method.deploymentKey !== deploymentKey ||
      method.livemode !== false ||
      method.providerCustomerId !== expected.providerCustomerId ||
      method.providerPaymentMethodId !== providerMethodId ||
      method.type !== "card" ||
      !card ||
      !/^[a-z0-9_ -]{1,32}$/i.test(card.brand) ||
      !/^\d{4}$/.test(card.last4) ||
      !Number.isInteger(card.expiryMonth) ||
      card.expiryMonth < 1 ||
      card.expiryMonth > 12 ||
      !Number.isInteger(card.expiryYear) ||
      card.expiryYear < 2000 ||
      card.expiryYear > 9999 ||
      !usableCard(card, now())
    )
      review();
    return card;
  }
  async function response(
    connection: NodePgDatabase,
    id: string,
  ): Promise<PaymentSetupResponse> {
    const [row] = await connection.select().from(setups).where(scope(id));
    if (!row) throw new Error("Payment setup missing");
    const [method] = row.providerPaymentMethodId
      ? await connection
          .select({ id: methods.id })
          .from(methods)
          .where(
            and(
              eq(methods.providerPaymentMethodId, row.providerPaymentMethodId),
              eq(methods.providerAccountId, row.providerAccountId),
              eq(methods.customerId, row.customerId),
              eq(methods.deploymentKey, deploymentKey),
            ),
          )
      : [];
    const status =
      row.status === "pending" && row.attempts >= 5
        ? "needs_review"
        : row.status;
    return {
      setupId: id,
      status,
      paymentMethodId: row.status === "verified" ? (method?.id ?? null) : null,
      checkoutUrl: status === "pending" ? checkoutUrl(row.checkoutUrl) : null,
    };
  }
  async function processSetup(
    id: string,
    refresh = false,
  ): Promise<"complete" | "retry" | "needs_review"> {
    if (!isUuid(id)) throw new RangeError("Invalid setup ID");
    if (!provider || !providerOwnership) return "retry";
    const [candidate] = await db.select().from(setups).where(scope(id));
    if (!candidate) return "complete";
    return withLocks(
      pool,
      [`customer:${candidate.billingCustomerId}`, `payment-setup:${id}`],
      async (connection) => {
        const [row] = await connection.select().from(setups).where(scope(id));
        if (!row || row.status === "expired" || row.status === "verified")
          return "complete";
        if (row.status === "needs_review" || (!refresh && row.attempts >= 5))
          return "needs_review";
        if (
          !refresh &&
          row.nextAttemptAt &&
          Date.parse(row.nextAttemptAt) > now().getTime()
        )
          return "retry";
        try {
          const [mapping] = await connection
            .select()
            .from(billingCustomers)
            .where(eq(billingCustomers.id, row.billingCustomerId));
          if (
            !mapping ||
            mapping.customerId !== row.customerId ||
            mapping.deploymentKey !== deploymentKey ||
            mapping.providerAccountId !== row.providerAccountId ||
            !options.allowMappingName(row.customerId, mapping.name) ||
            row.providerAccountId !== providerOwnership.accountId
          )
            review();
          const providerCustomerId = await options.ensureCustomerReceipt(
            connection,
            mapping.id,
          );
          if (
            !providerCustomerId ||
            (mapping.providerCustomerId &&
              mapping.providerCustomerId !== providerCustomerId)
          )
            review();
          const expected = intent(row, providerCustomerId);
          let receipt: ProviderPaymentSetup;
          if (row.providerSessionId || row.pendingSessionId) {
            receipt = await provider.retrieveSetup(
              expected,
              (row.providerSessionId ?? row.pendingSessionId)!,
            );
          } else {
            const found = await provider.findSetup(expected);
            if (found.kind === "ambiguous") review();
            if (found.kind === "found") receipt = found.value;
            else {
              if (
                row.createAttemptedAt &&
                now().getTime() - Date.parse(row.createAttemptedAt) >=
                  23 * 60 * 60 * 1000
              )
                review();
              if (!row.createAttemptedAt) {
                row.createAttemptedAt = now().toISOString();
                await connection
                  .update(setups)
                  .set({ createAttemptedAt: row.createAttemptedAt })
                  .where(scope(id));
              }
              receipt = await provider.createSetup(expected, {
                idempotencyKey: `datapad:${deploymentKey}:payment-setup:${id}:create`,
              });
            }
          }
          verify(expected, receipt, row);
          // Persist the verified Session identity even while customer action is pending.
          await connection
            .update(setups)
            .set({
              status: receipt.status === "expired" ? "expired" : "pending",
              providerSessionId: receipt.providerSessionId,
              providerSetupIntentId:
                receipt.setupIntent?.providerSetupIntentId ?? null,
              checkoutUrl:
                receipt.status === "open" ? receipt.checkoutUrl : null,
              lastCheckedAt: now().toISOString(),
              attempts: 0,
              nextAttemptAt: new Date(now().getTime() + 30000).toISOString(),
            })
            .where(scope(id));
          if (receipt.status === "expired") {
            await connection
              .update(setups)
              .set({ status: "expired", nextAttemptAt: null })
              .where(scope(id));
            return "complete";
          }
          if (
            receipt.status !== "complete" ||
            receipt.setupIntent?.status !== "succeeded"
          ) {
            if (receipt.setupIntent?.status === "canceled") review();
            return "retry";
          }
          const providerMethodId = receipt.setupIntent.providerPaymentMethodId;
          if (
            !providerMethodId ||
            (row.providerPaymentMethodId &&
              row.providerPaymentMethodId !== providerMethodId)
          )
            review();
          const observed = await provider.retrieveSavedMethod(
            expected,
            providerMethodId,
          );
          const card = verifiedCard(expected, providerMethodId, observed);
          await connection.transaction(async (tx) => {
            const [existing] = await tx
              .select()
              .from(methods)
              .where(
                and(
                  eq(methods.providerAccountId, row.providerAccountId),
                  eq(methods.providerPaymentMethodId, providerMethodId),
                ),
              );
            if (
              existing &&
              (existing.billingCustomerId !== row.billingCustomerId ||
                existing.customerId !== row.customerId ||
                existing.deploymentKey !== deploymentKey)
            )
              review();
            if (existing)
              await tx
                .update(methods)
                .set({ ...card, verifiedAt: now().toISOString() })
                .where(eq(methods.id, existing.id));
            else
              await tx.insert(methods).values({
                id: randomUUID(),
                customerId: row.customerId,
                deploymentKey,
                billingCustomerId: row.billingCustomerId,
                providerAccountId: row.providerAccountId,
                setupId: row.id,
                providerPaymentMethodId: providerMethodId,
                ...card,
                verifiedAt: now().toISOString(),
              });
            await tx
              .update(setups)
              .set({
                status: "verified",
                providerPaymentMethodId: providerMethodId,
                checkoutUrl: null,
                nextAttemptAt: null,
              })
              .where(scope(id));
          });
          return "complete";
        } catch (error) {
          const attempts = Math.min(5, row.attempts + 1);
          const definitive =
            error instanceof SetupReview ||
            (error instanceof BillingProviderError && error.kind === "review");
          const needsReview = definitive || attempts >= 5;
          await connection
            .update(setups)
            .set({
              // Exhausted transient retrieval stays eligible for a later completion obligation.
              // Definitive evidence failures must never be reopened by an event or refresh.
              status: definitive ? "needs_review" : row.status,
              attempts,
              checkoutUrl: needsReview ? null : row.checkoutUrl,
              nextAttemptAt: needsReview
                ? null
                : new Date(
                    now().getTime() +
                      [5000, 30000, 120000, 600000][attempts - 1],
                  ).toISOString(),
            })
            .where(scope(id));
          return needsReview ? "needs_review" : "retry";
        }
      },
    );
  }
  async function receiveSetupEvent(event: VerifiedPaymentSetupEvent) {
    if (
      !providerOwnership ||
      event.accountId !== providerOwnership.accountId ||
      event.deploymentKey !== deploymentKey ||
      !event.providerSessionId ||
      !event.eventId
    )
      return;
    const [row] = await db
      .select()
      .from(setups)
      .where(
        and(
          eq(setups.deploymentKey, deploymentKey),
          eq(setups.providerAccountId, event.accountId),
          or(
            eq(setups.providerSessionId, event.providerSessionId),
            event.setupId && isUuid(event.setupId)
              ? eq(setups.id, event.setupId)
              : undefined,
          ),
        ),
      )
      .limit(1);
    if (
      !row ||
      (row.providerSessionId &&
        row.providerSessionId !== event.providerSessionId)
    )
      return;
    await withLocks(
      pool,
      [`customer:${row.billingCustomerId}`, `payment-setup:${row.id}`],
      async (connection) => {
        const [current] = await connection
          .select()
          .from(setups)
          .where(scope(row.id));
        if (
          !current ||
          current.status === "verified" ||
          current.status === "expired" ||
          current.status === "needs_review" ||
          current.pendingSessionId !== null ||
          (current.providerSessionId &&
            current.providerSessionId !== event.providerSessionId)
        )
          return;
        await connection
          .update(setups)
          .set({
            pendingSessionId: event.providerSessionId,
            // One completion obligation gets one fresh bounded budget; duplicates cannot reset it.
            attempts: 0,
            retrievalRequestedAt: now().toISOString(),
            nextAttemptAt: null,
          })
          .where(scope(row.id));
      },
    );
  }
  async function pendingSetups(limit = 100) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new RangeError("Invalid setup batch size");
    return (
      await db
        .select({ id: setups.id })
        .from(setups)
        .where(
          and(
            eq(setups.deploymentKey, deploymentKey),
            eq(setups.status, "pending"),
            lt(setups.attempts, 5),
            or(
              isNull(setups.nextAttemptAt),
              lte(setups.nextAttemptAt, now().toISOString()),
            ),
          ),
        )
        .orderBy(asc(setups.retrievalRequestedAt), asc(setups.id))
        .limit(limit)
    ).map((r) => r.id);
  }
  async function assertSyntheticData() {
    const all = await db.select().from(setups);
    const mappings = await db.select().from(billingCustomers);
    if (
      mappings.some(
        (mapping) =>
          !providerOwnership ||
          mapping.deploymentKey !== deploymentKey ||
          mapping.providerAccountId !== providerOwnership.accountId,
      )
    )
      throw new Error("Unexpected payment mapping ownership");
    const validatedMappingIds = new Set<string>();
    for (const row of all) {
      const mapping = mappings.find((m) => m.id === row.billingCustomerId);
      const profile = await options.customerAccess.readProfile(
        db,
        row.customerId,
      );
      if (
        !providerOwnership ||
        row.deploymentKey !== deploymentKey ||
        row.providerAccountId !== providerOwnership.accountId ||
        !mapping ||
        mapping.deploymentKey !== deploymentKey ||
        mapping.customerId !== row.customerId ||
        mapping.providerAccountId !== row.providerAccountId ||
        !profile ||
        !options.allowProfile(profile.profile) ||
        !options.allowMappingName(row.customerId, mapping.name) ||
        row.saveTermsVersion !== SAVE_TERMS_VERSION ||
        row.saveTermsDigest !== digest(SAVE_TERMS_TEXT) ||
        row.requestDigest !==
          digest({
            customerId: row.customerId,
            input: {
              requestId: row.requestId,
              saveTermsVersion: SAVE_TERMS_VERSION,
              acceptSaveTerms: true,
            },
          }) ||
        row.successUrl !==
          setupReturnUrl(options.successUrl, row.customerId, row.id) ||
        row.cancelUrl !==
          setupReturnUrl(options.cancelUrl, row.customerId, row.id) ||
        !/^datapad_setup_[a-z]{8}$/.test(row.integrationIdentifier) ||
        !row.consentingMembershipId ||
        !row.actorUserId ||
        !row.actorSessionId
      )
        throw new Error("Unexpected payment setup intent");
      checkoutUrl(row.checkoutUrl);
      if (
        row.providerSessionId &&
        (!mapping.providerCustomerId || !row.createAttemptedAt)
      )
        throw new Error("Unexpected setup receipt");
      if (
        row.status === "verified" &&
        (!row.providerSetupIntentId ||
          !row.providerPaymentMethodId ||
          !row.lastCheckedAt)
      )
        throw new Error("Incomplete verified setup");
      validatedMappingIds.add(mapping.id);
    }
    for (const method of await db.select().from(methods)) {
      const setup = all.find((s) => s.id === method.setupId);
      if (
        !providerOwnership ||
        !setup ||
        !setup.providerSetupIntentId ||
        !setup.lastCheckedAt ||
        setup.providerPaymentMethodId !== method.providerPaymentMethodId ||
        method.deploymentKey !== deploymentKey ||
        method.customerId !== setup.customerId ||
        method.billingCustomerId !== setup.billingCustomerId ||
        method.providerAccountId !== providerOwnership.accountId ||
        !/^[a-z0-9_ -]{1,32}$/i.test(method.brand) ||
        !/^\d{4}$/.test(method.last4)
      )
        throw new Error("Unexpected saved method evidence");
    }
    // Every verified setup must resolve to exactly one owned method, including repeated saves.
    for (const setup of all.filter((s) => s.status === "verified")) {
      const result = await response(db, setup.id);
      if (!result.paymentMethodId) throw new Error("Missing saved method");
    }
    return validatedMappingIds;
  }
  return {
    response,
    processSetup,
    receiveSetupEvent,
    pendingSetups,
    assertSyntheticData,
  };
}
