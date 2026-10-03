import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { BillingOptions, RequestResult } from "../types";
import { billingCustomers, invoiceLines, invoices } from "./schema";
import { readinessDate, requestDigest, validateRequest } from "./validate";

export function createRequester({
  pool,
  provider,
  deploymentKey,
  customers,
  now = () => new Date(),
}: BillingOptions) {
  const db = drizzle(pool);
  return async (input: unknown): Promise<RequestResult> => {
    const request = validateRequest(input);
    if (!request) return { kind: "invalid", fields: ["/"] };
    const digest = requestDigest(request);
    return db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`request:${deploymentKey}:${request.originKey}`}, 0))`,
      );
      const [existing] = await tx
        .select()
        .from(invoices)
        .where(
          and(
            eq(invoices.deploymentKey, deploymentKey),
            eq(invoices.originKey, request.originKey),
          ),
        );
      if (existing)
        return existing.requestDigest === digest
          ? { kind: "unchanged", invoiceId: existing.id }
          : { kind: "conflict" };
      if (request.dueDate <= now().toISOString().slice(0, 10))
        return { kind: "invalid", fields: ["/dueDate"] };
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`customer-key:${deploymentKey}:${request.customer.key}`}, 0))`,
      );
      let [customer] = await tx
        .select()
        .from(billingCustomers)
        .where(
          and(
            eq(billingCustomers.deploymentKey, deploymentKey),
            eq(billingCustomers.key, request.customer.key),
          ),
        );
      if (
        customer &&
        customer.providerAccountId !== provider.ownership.accountId
      )
        return { kind: "conflict" };
      const createdAt = now().toISOString();
      const account = await customers.ensureCustomer(tx, {
        registryKey: JSON.stringify([deploymentKey, request.customer.key]),
        initialProfile: {
          displayName: request.customer.name,
          legalName: request.customer.name,
          billingEmail: null,
        },
      });
      if (!customer) {
        [customer] = await tx
          .insert(billingCustomers)
          .values({
            id: randomUUID(),
            customerId: account.customerId,
            deploymentKey,
            providerAccountId: provider.ownership.accountId,
            key: request.customer.key,
            name: request.customer.name,
            createdAt,
          })
          .returning();
      }
      const invoiceId = randomUUID();
      await tx.insert(invoices).values({
        id: invoiceId,
        deploymentKey,
        originKey: request.originKey,
        requestDigest: digest,
        requestCustomerName: request.customer.name,
        billingCustomerId: customer.id,
        billToName: account.profile.legalName,
        billToEmail: account.profile.billingEmail,
        billToProfileVersion: account.version,
        issueDate: request.issueDate,
        dueDate: request.dueDate,
        readinessDate: readinessDate(request.dueDate),
        currency: request.currency,
        totalMinor: request.lines.reduce(
          (sum, line) => sum + line.amountMinor,
          0,
        ),
        state: "requested",
        createdAt,
      });
      await tx.insert(invoiceLines).values(
        request.lines.map((line, position) => ({
          id: randomUUID(),
          invoiceId,
          position,
          ...line,
        })),
      );
      return { kind: "created", invoiceId };
    });
  };
}
