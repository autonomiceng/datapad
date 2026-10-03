import {
  createFinancialEffectGuard,
  FinancialEffectsPaused,
} from "./effect-guard";
import { and, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  BillingProviderError,
  type BillingProvider,
  type CustomerIntent,
} from "../provider";
import { billingCustomers } from "./invoice-schema";

/**
 * Shared mapping recovery. Caller holds the mapping-customer session lock on
 * the supplied connection, with no enclosing transaction across provider I/O.
 *
 * The optional callback enforces issuance rules in the supplied short transaction.
 * The receipt path always checks the guard and commits the first stamp itself,
 * including when a callback is supplied. Neither callback nor transaction may
 * perform network I/O. Retrieval-only calls never invoke the callback.
 * Paused or absent read-only evidence throws FinancialEffectsPaused for deferral.
 */
export function createCustomerReceipt(options: {
  provider: BillingProvider;
  deploymentKey: string;
  now?: () => Date;
}) {
  const { provider, deploymentKey, now = () => new Date() } = options;
  if (provider.ownership.deploymentKey !== deploymentKey)
    throw new Error("Customer provider ownership differs from deployment.");
  const guard = createFinancialEffectGuard(deploymentKey);
  const review = (
    reason: "ownership_mismatch" | "uncertain_customer",
  ): never => {
    throw new BillingProviderError("review", reason);
  };
  return async (
    connection: NodePgDatabase,
    billingCustomerId: string,
    beforeCreate?: (tx: NodePgDatabase) => Promise<void>,
    check?: { retrievalOnly: true },
  ): Promise<string> => {
    const scope = and(
      eq(billingCustomers.id, billingCustomerId),
      eq(billingCustomers.deploymentKey, deploymentKey),
    );
    const [customer] = await connection
      .select()
      .from(billingCustomers)
      .where(scope);
    if (
      !customer ||
      customer.providerAccountId !== provider.ownership.accountId
    )
      return review("ownership_mismatch");
    if (
      check?.retrievalOnly &&
      !customer.createAttemptedAt &&
      !customer.providerCustomerId
    )
      throw new FinancialEffectsPaused();
    const expected: CustomerIntent = {
      ...provider.ownership,
      customerId: customer.id,
      name: customer.name,
    };
    const found = await provider.findCustomer(expected);
    if (
      found.kind === "ambiguous" ||
      (customer.providerCustomerId && found.kind !== "found")
    )
      return review("uncertain_customer");
    let receipt;
    if (found.kind === "found") receipt = found.value;
    else {
      if (
        customer.createAttemptedAt &&
        now().getTime() - Date.parse(customer.createAttemptedAt) >=
          23 * 60 * 60 * 1000
      )
        return review("uncertain_customer");
      if (check?.retrievalOnly) throw new FinancialEffectsPaused();
      await connection.transaction(async (tx) => {
        if (beforeCreate) await beforeCreate(tx);
        await tx
          .select({ id: billingCustomers.id })
          .from(billingCustomers)
          .where(scope)
          .for("update");
        if ((await guard.assertMayStart(tx)) === "paused")
          throw new FinancialEffectsPaused();
        if (!customer.createAttemptedAt)
          await tx
            .update(billingCustomers)
            .set({ createAttemptedAt: now().toISOString() })
            .where(scope);
      });
      receipt = await provider.createCustomer(expected, {
        idempotencyKey: `datapad:${deploymentKey}:customer:${customer.id}:create`,
      });
    }
    if (
      receipt.livemode !== false ||
      receipt.accountId !== expected.accountId ||
      receipt.deploymentKey !== deploymentKey ||
      receipt.customerId !== expected.customerId ||
      receipt.name !== expected.name ||
      !receipt.providerCustomerId ||
      (customer.providerCustomerId &&
        customer.providerCustomerId !== receipt.providerCustomerId)
    )
      return review("ownership_mismatch");
    await connection
      .update(billingCustomers)
      .set({ providerCustomerId: receipt.providerCustomerId })
      .where(scope);
    return receipt.providerCustomerId;
  };
}
