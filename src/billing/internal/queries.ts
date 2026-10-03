import { and, asc, count, desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Value } from "@sinclair/typebox/value";
import { BillingPaginationSchema, type InvoiceRequest } from "../contract";
import type { BillingReader, BillingReaderOptions } from "../types";
import {
  billingCustomers,
  invoiceLines,
  invoices,
  stripeEvents,
} from "./schema";
import { isUuid, requestDigest, validateRequest } from "./validate";

export function createReader({
  pool,
  deploymentKey,
}: BillingReaderOptions): BillingReader {
  const db = drizzle(pool);
  const instant = (value: string | null) =>
    value === null ? null : new Date(value).toISOString();
  const scope = eq(invoices.deploymentKey, deploymentKey);
  const selection = {
    id: invoices.id,
    customer: { id: billingCustomers.id, name: billingCustomers.name },
    issueDate: invoices.issueDate,
    dueDate: invoices.dueDate,
    readinessDate: invoices.readinessDate,
    currency: invoices.currency,
    totalMinor: invoices.totalMinor,
    state: invoices.state,
    providerStatus: invoices.providerStatus,
    reviewReason: invoices.reviewReason,
    lastCheckedAt: invoices.lastCheckedAt,
    issuedAt: invoices.issuedAt,
  };
  return {
    async listInvoices(page = {}) {
      const pagination = { limit: page.limit ?? 50, offset: page.offset ?? 0 };
      if (!Value.Check(BillingPaginationSchema, pagination))
        throw new RangeError("Invalid pagination");
      const rows = await db
        .select(selection)
        .from(invoices)
        .innerJoin(
          billingCustomers,
          eq(invoices.customerId, billingCustomers.id),
        )
        .where(scope)
        .orderBy(desc(invoices.createdAt), asc(invoices.id))
        .limit(pagination.limit)
        .offset(pagination.offset);
      const [size] = await db
        .select({ total: count() })
        .from(invoices)
        .where(scope);
      return {
        invoices: rows.map((row) => ({
          ...row,
          lastCheckedAt: instant(row.lastCheckedAt),
          issuedAt: instant(row.issuedAt),
        })),
        total: size.total,
        ...pagination,
      };
    },
    async getInvoice(invoiceId) {
      if (!isUuid(invoiceId)) return null;
      const [row] = await db
        .select({ ...selection, hostedInvoiceUrl: invoices.hostedInvoiceUrl })
        .from(invoices)
        .innerJoin(
          billingCustomers,
          eq(invoices.customerId, billingCustomers.id),
        )
        .where(and(scope, eq(invoices.id, invoiceId)));
      if (!row) return null;
      const lines = await db
        .select({
          id: invoiceLines.id,
          position: invoiceLines.position,
          description: invoiceLines.description,
          amountMinor: invoiceLines.amountMinor,
          originRef: invoiceLines.originRef,
        })
        .from(invoiceLines)
        .where(eq(invoiceLines.invoiceId, invoiceId))
        .orderBy(asc(invoiceLines.position));
      const visible = ["open", "paid", "void", "uncollectible"].includes(
        row.state,
      );
      const url = row.hostedInvoiceUrl;
      return {
        invoice: {
          ...row,
          lastCheckedAt: instant(row.lastCheckedAt),
          issuedAt: instant(row.issuedAt),
          lines,
          hostedInvoiceUrl:
            visible && url && url.startsWith("https://invoice.stripe.com/")
              ? url
              : null,
        },
      };
    },
    async assertSyntheticData(
      allowedRequests: InvoiceRequest[],
      accountId?: string,
    ) {
      const fail = () => {
        throw new Error(
          "Billing data is outside the reviewed synthetic dataset",
        );
      };
      const allowed = new Set(
        allowedRequests.map((request) => {
          if (!validateRequest(request)) return fail();
          return requestDigest(request);
        }),
      );
      const customers = await db.select().from(billingCustomers);
      const rows = await db.select().from(invoices);
      const lines = await db
        .select()
        .from(invoiceLines)
        .orderBy(asc(invoiceLines.position));
      const events = await db.select().from(stripeEvents);
      if (
        customers.some(
          (customer) =>
            customer.deploymentKey !== deploymentKey ||
            customer.providerAccountId !== accountId ||
            !rows.some((row) => row.customerId === customer.id),
        )
      )
        fail();
      for (const row of rows) {
        const customer = customers.find((value) => value.id === row.customerId);
        if (!customer || row.deploymentKey !== deploymentKey) return fail();
        const request: InvoiceRequest = {
          originKey: row.originKey,
          customer: { key: customer.key, name: customer.name },
          issueDate: row.issueDate,
          dueDate: row.dueDate,
          currency: row.currency,
          lines: lines
            .filter((line) => line.invoiceId === row.id)
            .map((line) => ({
              description: line.description,
              amountMinor: line.amountMinor,
              originRef: line.originRef,
            })),
        };
        if (
          !validateRequest(request) ||
          requestDigest(request) !== row.requestDigest ||
          !allowed.has(row.requestDigest) ||
          request.lines.reduce((sum, line) => sum + line.amountMinor, 0) !==
            row.totalMinor
        )
          fail();
      }
      if (
        events.some(
          (event) =>
            event.deploymentKey !== deploymentKey ||
            event.providerAccountId !== accountId ||
            !rows.some((row) => row.id === event.invoiceId),
        )
      )
        fail();
    },
  };
}
