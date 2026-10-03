import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useSearch } from "@tanstack/react-router";
import type {
  InvoiceDetail,
  InvoiceResponse,
  InvoicesResponse,
  InvoiceState,
  ReviewReason,
} from "../../billing/contract";
import { useSession } from "../accounts/api";
import "./invoices.css";

const pageSize = 50;
const labels: Record<InvoiceState, string> = {
  requested: "Requested",
  preparing: "Preparing",
  needs_review: "Needs review",
  draft: "Draft",
  open: "Unpaid",
  paid: "Paid",
  void: "Void",
  uncollectible: "Uncollectible",
};
const notes: Partial<Record<InvoiceState, string>> = {
  requested:
    "Not issued yet. The payment link appears once the invoice is issued.",
  preparing:
    "Being prepared in Stripe. The payment link appears when it is ready.",
  draft: "Created in Stripe but not issued yet.",
};
const reasons: Record<ReviewReason, string> = {
  uncertain_customer:
    "We could not confirm whether Stripe created the customer.",
  uncertain_invoice: "We could not confirm whether Stripe created the invoice.",
  uncertain_line:
    "We could not confirm whether Stripe added every invoice line.",
  ownership_mismatch: "The Stripe record belongs to a different account.",
  invoice_mismatch: "The invoice in Stripe differs from the requested invoice.",
  provider_conflict:
    "The request or invoice status could not be confirmed with Stripe.",
  retry_exhausted: "Processing stopped after repeated failures.",
};
export const money = (amountMinor: number, currency: string) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency }).format(
    amountMinor / 100,
  );
export const date = (value: string) =>
  new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${value}T00:00:00Z`));
const instant = (value: string) =>
  new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(value));
class InvoiceReadError extends Error {
  constructor(readonly status: number) {
    super(
      status === 404
        ? "Invoice not found."
        : status === 422
          ? "Invalid invoice request."
          : "Invoices are unavailable right now. This page keeps trying.",
    );
  }
}
async function read<T>(path: string): Promise<T> {
  const response = await fetch(path, { cache: "no-store" });
  if (!response.ok) throw new InvoiceReadError(response.status);
  return response.json();
}
function Status({ state }: { state: InvoiceState }) {
  return (
    <span className={`status-tag invoice-status invoice-status-${state}`}>
      {labels[state]}
    </span>
  );
}
export function Invoices() {
  const { invoiceId, offset } = useSearch({ from: "/invoices" });
  const session = useSession();
  const userId = session.data?.user?.id;
  const enabled =
    !session.isPending &&
    !session.isError &&
    (session.data === null || Boolean(userId));
  // React Query pauses the interval while the tab is hidden and refetches on return.
  const list = useQuery({
    queryKey: ["invoices", userId, offset],
    enabled,
    queryFn: () =>
      read<InvoicesResponse>(
        `/api/billing/invoices?limit=${pageSize}&offset=${offset}`,
      ),
    refetchInterval: 5000,
  });
  const detail = useQuery({
    queryKey: ["invoice", userId, invoiceId],
    queryFn: () =>
      read<InvoiceResponse>(
        `/api/billing/invoices/${encodeURIComponent(invoiceId!)}`,
      ),
    enabled: enabled && Boolean(invoiceId),
    refetchInterval: (query) =>
      query.state.error instanceof InvoiceReadError &&
      [404, 422].includes(query.state.error.status)
        ? false
        : 5000,
  });
  const detailRef = useRef<HTMLElement>(null);
  useEffect(() => {
    detailRef.current?.scrollIntoView({ block: "nearest" });
  }, [invoiceId]);
  if (session.isPending)
    return (
      <p className="panel state-panel" role="status">
        Checking your session…
      </p>
    );
  if (session.isError)
    return (
      <section className="panel state-panel">
        <h1>Invoices unavailable</h1>
        <p role="alert">{session.error.message}</p>
      </section>
    );
  if (session.data && !session.data.user)
    return (
      <section className="panel state-panel">
        <h1>Sign in to continue</h1>
        <a href={`/sign-in?returnTo=${encodeURIComponent(location.href)}`}>
          Sign in
        </a>
      </section>
    );
  const shown = list.data?.invoices.length ?? 0;
  return (
    <>
      <header className="page-heading intro">
        <h1>Invoices</h1>
        <span className="sample-badge">Sample data</span>
      </header>
      <div className="billing-layout">
        <section className="panel invoice-list" aria-label="Invoice list">
          {list.isPending && (
            <p className="state-panel" role="status">
              Loading invoices…
            </p>
          )}
          {list.isError &&
            (list.data ? (
              <p className="invoice-stale" role="alert">
                Could not refresh. Showing the last loaded invoices.
              </p>
            ) : (
              <p className="state-panel error-state" role="alert">
                {list.error.message}
              </p>
            ))}
          {list.data?.total === 0 && (
            <p className="state-panel">No invoices yet.</p>
          )}
          {shown > 0 && (
            <ul className="invoice-rows">
              {list.data?.invoices.map((item) => (
                <li key={item.id}>
                  <Link
                    to="/invoices"
                    search={{ invoiceId: item.id, offset }}
                    resetScroll={false}
                    className="invoice-row"
                  >
                    <span className="invoice-row-customer">
                      {item.customer.name}
                    </span>
                    <span className="invoice-row-amount">
                      {money(item.totalMinor, item.currency)}
                    </span>
                    <span className="invoice-row-due">
                      Due {date(item.dueDate)}
                    </span>
                    <Status state={item.state} />
                    {item.reviewReason && (
                      <span className="invoice-row-warning">
                        {reasons[item.reviewReason]}
                      </span>
                    )}
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {list.data && (offset > 0 || list.data.total > pageSize) && (
            <nav className="pagination" aria-label="Invoice pages">
              <span>
                {shown === 0
                  ? `0 of ${list.data.total}`
                  : `${offset + 1}–${offset + shown} of ${list.data.total}`}
              </span>
              <div>
                {offset > 0 && (
                  <Link
                    className="secondary-button"
                    to="/invoices"
                    search={{
                      invoiceId,
                      offset: Math.max(0, offset - pageSize),
                    }}
                  >
                    Previous
                  </Link>
                )}
                {offset + pageSize < list.data.total && (
                  <Link
                    className="secondary-button"
                    to="/invoices"
                    search={{ invoiceId, offset: offset + pageSize }}
                  >
                    Next
                  </Link>
                )}
              </div>
            </nav>
          )}
        </section>
        {invoiceId ? (
          <section
            ref={detailRef}
            className="panel invoice-detail"
            aria-label="Invoice details"
          >
            {detail.isPending && (
              <p className="state-panel" role="status">
                Loading invoice…
              </p>
            )}
            {detail.isError &&
              (detail.data ? (
                <p className="invoice-stale" role="alert">
                  Could not refresh. Showing the last loaded details.
                </p>
              ) : (
                <p className="state-panel error-state" role="alert">
                  {detail.error.message}
                </p>
              ))}
            {detail.data && (
              <>
                <Invoice invoice={detail.data.invoice} />
                {session.data?.staffRoles.includes("billing") && (
                  <Link
                    className="secondary-button"
                    to="/customers/$customerId/invoices/$invoiceId/review"
                    params={{
                      customerId: detail.data.invoice.customer.id,
                      invoiceId: detail.data.invoice.id,
                    }}
                  >
                    Review invoice
                  </Link>
                )}
              </>
            )}
          </section>
        ) : (
          shown > 0 && (
            <p className="panel state-panel invoice-placeholder">
              Select an invoice to see its lines and payment link.
            </p>
          )
        )}
      </div>
    </>
  );
}
export function Invoice({ invoice }: { invoice: InvoiceDetail }) {
  return (
    <>
      <header className="invoice-header">
        <h2>{invoice.billTo.legalName}</h2>
        <Status state={invoice.state} />
        <p className="invoice-total">
          {money(invoice.totalMinor, invoice.currency)}{" "}
          <span className="invoice-currency">{invoice.currency}</span>
        </p>
      </header>
      {invoice.state === "needs_review" &&
      invoice.providerReceipt.state !== "mismatch" ? (
        <p className="invoice-review">
          {invoice.reviewReason && `${reasons[invoice.reviewReason]} `}
          Processing is paused until an operator checks it.
        </p>
      ) : (
        notes[invoice.state] && (
          <p className="invoice-note">{notes[invoice.state]}</p>
        )
      )}
      {invoice.providerReceipt.state === "mismatch" && (
        <p className="invoice-review" role="alert">
          {invoice.providerReceipt.reason &&
            `${reasons[invoice.providerReceipt.reason]} `}
          The payment link is unavailable until the provider receipt is
          verified.
        </p>
      )}
      {invoice.providerReceipt.state === "unverified" &&
        invoice.providerStatus !== null && (
          <p className="invoice-review" role="alert">
            The provider receipt has not been verified. The payment link is
            unavailable.
          </p>
        )}
      <dl className="invoice-facts">
        <div>
          <dt>Billing contact</dt>
          <dd>{invoice.billTo.billingEmail ?? "Not recorded"}</dd>
        </div>
        <div>
          <dt>{invoice.issuedAt ? "Issued at" : "Issue date (UTC)"}</dt>
          <dd>
            {invoice.issuedAt
              ? instant(invoice.issuedAt)
              : date(invoice.issueDate)}
          </dd>
        </div>
        <div>
          <dt>Due date (UTC)</dt>
          <dd>{date(invoice.dueDate)}</dd>
        </div>
        <div>
          <dt>Last checked with Stripe</dt>
          <dd>
            {invoice.lastCheckedAt ? (
              <time dateTime={invoice.lastCheckedAt}>
                {instant(invoice.lastCheckedAt)}
              </time>
            ) : (
              "Not yet"
            )}
          </dd>
        </div>
      </dl>
      {invoice.providerReceipt.state === "verified" &&
        invoice.hostedInvoiceUrl && (
          <div className="invoice-payment">
            <a
              className={
                invoice.state === "open"
                  ? "secondary-button invoice-pay"
                  : "secondary-button"
              }
              href={invoice.hostedInvoiceUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              {invoice.state === "open" ? "Pay invoice" : "View invoice"}
              <span aria-hidden="true">↗</span>
              <span className="sr-only"> on Stripe, opens a new tab</span>
            </a>
            {invoice.state === "open" && (
              <p className="invoice-note">
                Stripe test mode. No real money moves.
              </p>
            )}
          </div>
        )}
      <table className="invoice-lines">
        <thead>
          <tr>
            <th scope="col">Description</th>
            <th scope="col">Amount</th>
          </tr>
        </thead>
        <tbody>
          {invoice.lines.map((line) => (
            <tr key={line.id}>
              <th scope="row">{line.description}</th>
              <td>{money(line.amountMinor, invoice.currency)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row">Total</th>
            <td>{money(invoice.totalMinor, invoice.currency)}</td>
          </tr>
        </tfoot>
      </table>
      <p className="invoice-reference">Invoice ID {invoice.id}</p>
    </>
  );
}
