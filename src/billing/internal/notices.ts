import { and, asc, desc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type {
  InvoiceNoticeBilling,
  InvoiceNoticeBillingOptions,
  InvoiceNoticeFacts,
} from "../notice-types";
import { createInvoiceContext, type StoredInvoice } from "./invoice-context";
import {
  createCollectionObservation,
  readCollectionProjection,
} from "./collection";
import { billingCustomers, invoices } from "./invoice-schema";
import { isUuid } from "./validate";
const iso = (s: string | null) =>
  s === null ? null : new Date(s).toISOString();
function summary(record: Pick<StoredInvoice, "invoice" | "customer">) {
  const { invoice: i, customer: c } = record;
  return {
    invoiceId: i.id,
    customerId: c.customerId,
    billingCustomerId: c.id,
    billTo: {
      legalName: i.billToName,
      billingEmail: i.billToEmail,
      profileVersion: i.billToProfileVersion,
    },
    issuedAt: iso(i.issuedAt),
    dueDate: i.dueDate,
    dueEndAt: iso(i.dueEndAt)!,
    calendar: i.calendar,
    currency: i.currency,
    totalMinor: i.totalMinor,
  };
}
/** Constructs financial observation under billing session locks. observe() retrieves provider facts and commits local collection, resolution and payment-attempt reconciliation with worker audit records; it never issues invoices or charges. Expected provider failures defer delivery; SQL failures propagate. */
export function createInvoiceNoticeBilling(
  options: InvoiceNoticeBillingOptions,
): InvoiceNoticeBilling {
  const { pool, deploymentKey, provider, wallNow = () => new Date() } = options;
  if (
    !/^[A-Za-z0-9_-]{1,64}$/.test(deploymentKey) ||
    provider.ownership.deploymentKey !== deploymentKey ||
    !provider.ownership.accountId ||
    !options.workerId.trim()
  )
    throw new Error("Invalid notice billing ownership");
  const businessNow = options.businessNow ?? wallNow;
  const db = drizzle(pool);
  const context = createInvoiceContext({
    pool,
    deploymentKey,
    ownership: provider.ownership,
    now: wallNow,
  });
  const observation = createCollectionObservation(options);
  return {
    async finalizedNoticePage({
      limit = 100,
      after = null,
      through = null,
    } = {}) {
      const valid = (c: NonNullable<typeof after>) =>
        isUuid(c.invoiceId) && Number.isFinite(Date.parse(c.createdAt));
      if (
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 100 ||
        (after && (!through || !valid(after))) ||
        (through && !valid(through))
      )
        throw new RangeError("Invalid notice discovery cursor");
      const eligible = and(
        eq(invoices.deploymentKey, deploymentKey),
        eq(invoices.providerReceiptState, "verified"),
        sql`${invoices.providerStatus} in ('open','paid','void','uncollectible') and ${invoices.issuedAt} is not null and ${invoices.totalMinor}>0`,
        eq(billingCustomers.providerAccountId, provider.ownership.accountId),
      );
      const selection = {
        createdAt: invoices.createdAt,
        invoiceId: invoices.id,
      };
      if (!through) {
        const [last] = await db
          .select(selection)
          .from(invoices)
          .innerJoin(
            billingCustomers,
            eq(invoices.billingCustomerId, billingCustomers.id),
          )
          .where(eligible)
          .orderBy(desc(invoices.createdAt), desc(invoices.id))
          .limit(1);
        through = last ?? null;
      }
      if (!through) return { invoices: [], next: null, through: null };
      const rows = await db
        .select({ invoice: invoices, customer: billingCustomers })
        .from(invoices)
        .innerJoin(
          billingCustomers,
          eq(invoices.billingCustomerId, billingCustomers.id),
        )
        .where(
          and(
            eligible,
            sql`(${invoices.createdAt},${invoices.id})<=(${through.createdAt}::timestamptz,${through.invoiceId}::uuid)`,
            after
              ? sql`(${invoices.createdAt},${invoices.id})>(${after.createdAt}::timestamptz,${after.invoiceId}::uuid)`
              : undefined,
          ),
        )
        .orderBy(asc(invoices.createdAt), asc(invoices.id))
        .limit(limit + 1);
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        invoices: page.map(summary),
        next:
          rows.length > limit && last
            ? { createdAt: last.invoice.createdAt, invoiceId: last.invoice.id }
            : null,
        through,
      };
    },
    withInvoiceNoticeContext(invoiceId, work) {
      return context.locked(invoiceId, null, async (connection, initial) => {
        let latest: InvoiceNoticeFacts | null = null;
        let identity: Awaited<ReturnType<typeof observation.identity>> = null;
        const facts = (
          record: StoredInvoice,
          collection: InvoiceNoticeFacts["collection"],
          start: string | null,
          end: string | null,
        ): InvoiceNoticeFacts => ({
          ...summary(record),
          collection,
          verifiedFinalization:
            record.invoice.providerReceiptState === "verified" &&
            record.invoice.issuedAt !== null &&
            ["open", "paid", "void", "uncollectible"].includes(
              record.invoice.providerStatus ?? "",
            ),
          remainingMinor: record.invoice.collectionRemainingMinor,
          paymentUrl:
            collection.disposition.kind === "payable"
              ? record.invoice.hostedInvoiceUrl
              : null,
          observedFrom: start,
          observedThrough: end,
        });
        return work({
          connection,
          async observe() {
            const start = wallNow().toISOString();
            const current =
              (await context.load(connection, invoiceId)) ?? initial;
            const collection = await observation.read(connection, current);
            const record = (await context.load(connection, invoiceId))!;
            identity =
              collection.disposition.kind === "payable" &&
              collection.disposition.reason === "not_authorized"
                ? await observation.identity(connection, record)
                : null;
            latest = facts(record, collection, start, wallNow().toISOString());
            return structuredClone(latest);
          },
          async recheck(tx) {
            const record = (await context.load(tx, invoiceId))!;
            let collection = await readCollectionProjection(
              tx,
              record,
              businessNow(),
              wallNow(),
            );
            const now = wallNow().getTime();
            const fresh =
              latest?.observedFrom &&
              latest.observedThrough &&
              Date.parse(latest.observedFrom) <=
                Date.parse(latest.observedThrough) &&
              Date.parse(latest.observedThrough) <= now &&
              now - Date.parse(latest.observedFrom) <= 5000 &&
              collection.checkedAt === latest.collection.checkedAt;
            if (collection.disposition.kind !== "suppress") {
              if (!fresh)
                collection = {
                  ...collection,
                  disposition: { kind: "defer", reason: "stale" },
                };
              else if (
                latest?.collection.disposition.reason === "provider_unavailable"
              )
                collection = {
                  ...collection,
                  disposition: {
                    kind: "defer",
                    reason: "provider_unavailable",
                  },
                };
              else if (
                collection.disposition.kind === "defer" &&
                collection.disposition.reason === "awaiting_collection" &&
                collection.attempt === null &&
                latest?.collection.disposition.kind === "payable" &&
                latest.collection.disposition.reason === "not_authorized"
              ) {
                const currentIdentity = await observation.identity(tx, record);
                if (
                  identity &&
                  currentIdentity &&
                  identity.groupId === currentIdentity.groupId &&
                  identity.enrollmentId === currentIdentity.enrollmentId &&
                  identity.paymentMethodId === currentIdentity.paymentMethodId
                )
                  collection = {
                    ...collection,
                    disposition: { kind: "payable", reason: "not_authorized" },
                  };
              }
            }
            return facts(
              record,
              collection,
              latest?.observedFrom ?? null,
              latest?.observedThrough ?? null,
            );
          },
        });
      });
    },
  };
}
