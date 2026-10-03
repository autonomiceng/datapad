import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  sql,
  type SQL,
} from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Value } from "@sinclair/typebox/value";
import { BillingPaginationSchema, type InvoiceRequest } from "../contract";
import type {
  BillingReader,
  BillingReaderOptions,
  SyntheticInvoicePolicy,
} from "../types";
import {
  billingCustomers,
  invoiceLines,
  invoices,
  stripeEvents,
} from "./schema";
import {
  isUuid,
  requestDigest,
  validateRequest,
  validateScheduledRequest,
} from "./validate";
import { billingInvoiceGroups } from "./scheduled-schema";
import type { SyntheticScheduledInvoice } from "../scheduled-types";

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
    customer: { id: billingCustomers.customerId, name: invoices.billToName },
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
  const listInvoices = async (
    page: Parameters<BillingReader["listInvoices"]>[0] = {},
    customerScope?: SQL,
  ) => {
    const pagination = { limit: page.limit ?? 50, offset: page.offset ?? 0 };
    if (!Value.Check(BillingPaginationSchema, pagination))
      throw new RangeError("Invalid pagination");
    const rows = await db
      .select(selection)
      .from(invoices)
      .innerJoin(
        billingCustomers,
        eq(invoices.billingCustomerId, billingCustomers.id),
      )
      .where(and(scope, customerScope))
      .orderBy(desc(invoices.createdAt), asc(invoices.id))
      .limit(pagination.limit)
      .offset(pagination.offset);
    const [size] = await db
      .select({ total: count() })
      .from(invoices)
      .innerJoin(
        billingCustomers,
        eq(invoices.billingCustomerId, billingCustomers.id),
      )
      .where(and(scope, customerScope));
    return {
      invoices: rows.map((row) => ({
        ...row,
        lastCheckedAt: instant(row.lastCheckedAt),
        issuedAt: instant(row.issuedAt),
      })),
      total: size.total,
      ...pagination,
    };
  };
  const getInvoice = async (invoiceId: string, customerScope?: SQL) => {
    if (!isUuid(invoiceId)) return null;
    const [row] = await db
      .select({
        ...selection,
        calendar: invoices.calendar,
        hostedInvoiceUrl: invoices.hostedInvoiceUrl,
        receiptState: invoices.providerReceiptState,
        billTo: {
          legalName: invoices.billToName,
          billingEmail: invoices.billToEmail,
          profileVersion: invoices.billToProfileVersion,
        },
      })
      .from(invoices)
      .innerJoin(
        billingCustomers,
        eq(invoices.billingCustomerId, billingCustomers.id),
      )
      .where(and(scope, customerScope, eq(invoices.id, invoiceId)));
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
    const { receiptState, ...detail } = row;
    const url = row.hostedInvoiceUrl;
    return {
      invoice: {
        ...detail,
        providerReceipt: {
          state: receiptState,
          reason: receiptState === "mismatch" ? row.reviewReason : null,
        },
        lastCheckedAt: instant(row.lastCheckedAt),
        issuedAt: instant(row.issuedAt),
        lines,
        hostedInvoiceUrl:
          receiptState === "verified" &&
          visible &&
          url &&
          url.startsWith("https://invoice.stripe.com/")
            ? url
            : null,
      },
    };
  };
  const customerScope = (ids: string[]) => {
    if (ids.some((id) => !isUuid(id)))
      throw new RangeError("Invalid customer scope");
    return ids.length ? inArray(billingCustomers.customerId, ids) : sql`false`;
  };
  async function assertSyntheticPolicy(
    allowRequest: SyntheticInvoicePolicy,
    accountId?: string,
    allowScheduledRequest?: (invoice: SyntheticScheduledInvoice) => boolean,
  ) {
    const fail = () => {
      throw new Error("Billing data is outside the reviewed synthetic dataset");
    };
    const customers = await db.select().from(billingCustomers);
    const rows = await db.select().from(invoices);
    const lines = await db
      .select()
      .from(invoiceLines)
      .orderBy(asc(invoiceLines.position));
    const events = await db.select().from(stripeEvents);
    const groups = await db.select().from(billingInvoiceGroups);
    if (
      customers.some(
        (customer) =>
          customer.deploymentKey !== deploymentKey ||
          customer.providerAccountId !== accountId ||
          !rows.some(
            (row) =>
              row.billingCustomerId === customer.id &&
              row.requestCustomerName === customer.name,
          ),
      )
    )
      fail();
    for (const row of rows) {
      const customer = customers.find(
        (value) => value.id === row.billingCustomerId,
      );
      if (!customer || row.deploymentKey !== deploymentKey) return fail();
      const request: InvoiceRequest = {
        originKey: row.originKey,
        customer: { key: customer.key, name: row.requestCustomerName },
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
      const group = groups.find((group) => group.invoiceId === row.id);
      const billTo = {
        legalName: row.billToName,
        billingEmail: row.billToEmail,
        profileVersion: row.billToProfileVersion,
      };
      const normalized = group
        ? validateScheduledRequest({
            ...request,
            calendar: row.calendar,
            issueNotBefore: instant(row.issueNotBefore),
            firstAttemptBefore: instant(row.firstAttemptBefore),
            dueEndAt: instant(row.dueEndAt),
          })
        : validateRequest(request);
      if (
        !normalized ||
        requestDigest(normalized) !== row.requestDigest ||
        request.lines.reduce((sum, line) => sum + line.amountMinor, 0) !==
          row.totalMinor
      )
        return fail();
      if (group) {
        const scheduled = validateScheduledRequest(normalized);
        if (
          !scheduled ||
          !allowScheduledRequest ||
          group.customerId !== customer.customerId ||
          group.deploymentKey !== deploymentKey ||
          group.billingCustomerId !== customer.id ||
          !allowScheduledRequest({
            request: scheduled,
            customerId: customer.customerId,
            billTo,
          })
        )
          fail();
      } else if (
        row.calendar !== null ||
        instant(row.issueNotBefore) !== `${request.issueDate}T00:00:00.000Z` ||
        instant(row.firstAttemptBefore) !==
          `${request.dueDate}T00:00:00.000Z` ||
        instant(row.dueEndAt) !== `${request.dueDate}T23:59:59.000Z` ||
        !allowRequest({ request, customerId: customer.customerId, billTo })
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
  }
  return {
    listInvoices,
    getInvoice,
    listInvoicesForCustomers: (ids, page) =>
      listInvoices(page, customerScope(ids)),
    getInvoiceForCustomers: (ids, invoiceId) =>
      getInvoice(invoiceId, customerScope(ids)),
    async providerProfile(customerId, profile) {
      if (!isUuid(customerId)) return "not_linked";
      const mappings = await db
        .select({
          name: billingCustomers.name,
          providerCustomerId: billingCustomers.providerCustomerId,
        })
        .from(billingCustomers)
        .where(
          and(
            eq(billingCustomers.deploymentKey, deploymentKey),
            eq(billingCustomers.customerId, customerId),
          ),
        );
      const linked = mappings.filter(
        (mapping) => mapping.providerCustomerId !== null,
      );
      if (linked.length === 0) return "not_linked";
      return linked.every(
        (mapping) =>
          mapping.name === profile.legalName && profile.billingEmail === null,
      )
        ? "unchanged"
        : "pending";
    },
    assertSyntheticPolicy,
    async assertSyntheticData(
      allowedRequests,
      accountId,
      allowedBillTo = allowedRequests.map((request) => ({
        legalName: request.customer.name,
        billingEmail: null as string | null,
      })),
    ) {
      const allowed = new Set(
        allowedRequests.map((request) => {
          if (!validateRequest(request))
            throw new Error("Invalid synthetic invoice request");
          return requestDigest(request);
        }),
      );
      return assertSyntheticPolicy(
        ({ request, billTo }) =>
          allowed.has(requestDigest(request)) &&
          allowedBillTo.some(
            (profile) =>
              profile.legalName === billTo.legalName &&
              profile.billingEmail === billTo.billingEmail,
          ),
        accountId,
      );
    },
    async reconciliationPage({
      limit = 100,
      after = null,
      through = null,
    } = {}) {
      const validCursor = (cursor: NonNullable<typeof after>) =>
        isUuid(cursor.invoiceId) &&
        /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}(?::?\d{2})?)$/.test(
          cursor.createdAt,
        ) &&
        Number.isFinite(Date.parse(cursor.createdAt));
      if (
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 100 ||
        (after && !validCursor(after)) ||
        (through && !validCursor(through)) ||
        (after && !through)
      )
        throw new RangeError("Invalid reconciliation cursor");
      const selection = {
        createdAt: invoices.createdAt,
        invoiceId: invoices.id,
      };
      const eligible = and(scope, isNotNull(invoices.providerInvoiceId));
      if (!through) {
        const [last] = await db
          .select(selection)
          .from(invoices)
          .where(eligible)
          .orderBy(desc(invoices.createdAt), desc(invoices.id))
          .limit(1);
        through = last ?? null;
      }
      if (!through) return { invoiceIds: [], next: null, through: null };
      const rows = await db
        .select(selection)
        .from(invoices)
        .where(
          and(
            eligible,
            sql`(${invoices.createdAt},${invoices.id}) <= (${through.createdAt}::timestamptz,${through.invoiceId}::uuid)`,
            after
              ? sql`(${invoices.createdAt},${invoices.id}) > (${after.createdAt}::timestamptz,${after.invoiceId}::uuid)`
              : undefined,
          ),
        )
        .orderBy(asc(invoices.createdAt), asc(invoices.id))
        .limit(limit + 1);
      const page = rows.slice(0, limit);
      return {
        invoiceIds: page.map((row) => row.invoiceId),
        next: rows.length > limit ? page[page.length - 1] : null,
        through,
      };
    },
  };
}
