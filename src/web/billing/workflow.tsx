import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type {
  ConfirmIssueResponse,
  InvoicePreparationOptionsResponse,
  InvoicePreparationResponse,
  InvoiceResponse,
  PrepareInvoiceRequest,
  PrepareInvoiceResponse,
} from "../../billing/contract";
import type { CustomerResponse } from "../../customers/contract";
import {
  AccountError,
  command,
  request,
  useRequestId,
  useSession,
} from "../accounts/api";
import { Invoice } from "./invoices";
import { date, money } from "./format";
import { InvoiceResolutions } from "./resolutions";
import "./workflow.css";

// The invoice's status and review warning already explain the other blockers.
const blockers: Partial<
  Record<NonNullable<InvoicePreparationResponse["issueBlocker"]>, string>
> = {
  past_due:
    "The due date has passed. Prepare a new invoice with a future due date.",
  provider_profile_pending:
    "This billing name differs from the original payment account details. A provider profile update is required before issuing.",
};

export function StaffInvoicePage({
  customerId,
  invoiceId,
}: {
  customerId: string;
  invoiceId?: string;
}) {
  const session = useSession();
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
  if (!session.data?.user)
    return (
      <section className="panel state-panel">
        <h1>Sign in to continue</h1>
        <a href={`/sign-in?returnTo=${encodeURIComponent(location.href)}`}>
          Sign in
        </a>
      </section>
    );
  if (!session.data.staffRoles.includes("billing"))
    return (
      <section className="panel state-panel">
        <h1>Billing access required</h1>
        <Link to="/customers/$customerId" params={{ customerId }}>
          Return to customer
        </Link>
      </section>
    );
  return (
    <div className="account-page">
      <header className="account-page-header">
        <Link
          className="account-back"
          to="/customers/$customerId"
          params={{ customerId }}
        >
          Customer account
        </Link>
        <h1>{invoiceId ? "Review invoice" : "Prepare invoice"}</h1>
      </header>
      {invoiceId ? (
        <Review
          key={`${session.data.user.id}:${customerId}:${invoiceId}`}
          userId={session.data.user.id}
          customerId={customerId}
          invoiceId={invoiceId}
        />
      ) : (
        <Preparation
          key={`${session.data.user.id}:${customerId}`}
          userId={session.data.user.id}
          customerId={customerId}
        />
      )}
    </div>
  );
}

function Preparation({
  userId,
  customerId,
}: {
  userId: string;
  customerId: string;
}) {
  const [generation, setGeneration] = useState(0);
  const path = `/api/customers/${encodeURIComponent(customerId)}`;
  const customer = useQuery({
    queryKey: ["accounts", userId, "customer", customerId],
    queryFn: ({ signal }) => request<CustomerResponse>(path, { signal }),
    retry: false,
  });
  const options = useQuery({
    queryKey: ["invoice-options", userId, customerId],
    queryFn: ({ signal }) =>
      request<InvoicePreparationOptionsResponse>(`${path}/invoice-options`, {
        signal,
      }),
    retry: false,
  });
  const reload = async () => {
    const results = await Promise.all([customer.refetch(), options.refetch()]);
    if (results.every((result) => !result.isError))
      setGeneration((value) => value + 1);
  };
  return (
    <section className="panel invoice-detail">
      {(customer.isPending || options.isPending) && (
        <p className="state-panel" role="status">
          Loading invoice choices…
        </p>
      )}
      {(customer.isError || options.isError) && (
        <p className="state-panel error-state" role="alert">
          {customer.error?.message ?? options.error?.message}
        </p>
      )}
      {!customer.isError &&
        !options.isError &&
        customer.data &&
        options.data &&
        (options.data.available ? (
          <PrepareForm
            key={generation}
            customer={customer.data.customer}
            options={options.data}
            path={path}
            reload={reload}
          />
        ) : (
          <p className="state-panel">
            Invoice preparation is unavailable. Stripe sandbox billing is not
            configured.
          </p>
        ))}
    </section>
  );
}

function PrepareForm({
  customer,
  options,
  path,
  reload,
}: {
  customer: CustomerResponse["customer"];
  options: InvoicePreparationOptionsResponse;
  path: string;
  reload: () => Promise<void>;
}) {
  const [customerSnapshot] = useState(customer);
  const [dueDate, setDueDate] = useState(options.dueDate);
  const [selected, setSelected] = useState<number[]>(
    options.lines.length ? [0] : [],
  );
  const requestId = useRequestId();
  const prepare = useMutation({
    mutationFn: (input: PrepareInvoiceRequest) =>
      command<PrepareInvoiceResponse>(`${path}/invoices`, input),
    retry: false,
    onSuccess: (result) =>
      location.assign(
        `/customers/${encodeURIComponent(result.invoice.customer.id)}/invoices/${encodeURIComponent(result.invoice.id)}/review`,
      ),
  });
  const conflict =
    prepare.error instanceof AccountError && prepare.error.status === 409;
  const locked = prepare.isPending || prepare.isSuccess || conflict;
  const lines = selected.map((index) => options.lines[index]!);
  const total = lines.reduce((sum, line) => sum + line.amountMinor, 0);
  const nextDay = new Date(`${options.issueDate}T00:00:00Z`);
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  const lastDay = new Date(`${options.issueDate}T00:00:00Z`);
  lastDay.setUTCDate(lastDay.getUTCDate() + 21);
  const firstDue = nextDay.toISOString().slice(0, 10);
  const lastDue = lastDay.toISOString().slice(0, 10);
  const problem =
    lines.length === 0
      ? "Choose at least one line."
      : total < 50
        ? `The total must be at least ${money(50, "USD")}.`
        : total > 99999999
          ? `The total must be at most ${money(99999999, "USD")}.`
          : null;
  return (
    <form
      className="account-form invoice-prepare-form"
      onSubmit={(event) => {
        event.preventDefault();
        const input = {
          expectedCustomerVersion: customerSnapshot.version,
          dueDate,
          currency: "USD" as const,
          lines,
        };
        prepare.mutate({ ...input, requestId: requestId.get(input) });
      }}
    >
      <h2>{customerSnapshot.profile.legalName}</h2>
      <dl className="invoice-facts">
        <div>
          <dt>Billing contact</dt>
          <dd>{customerSnapshot.profile.billingEmail ?? "Not recorded"}</dd>
        </div>
        <div>
          <dt>Issue date (UTC)</dt>
          <dd>{date(options.issueDate)}</dd>
        </div>
      </dl>
      <div className="invoice-due-date">
        <label>
          Due date (UTC)
          <input
            type="date"
            required
            disabled={locked}
            min={firstDue}
            max={lastDue}
            value={dueDate}
            aria-describedby="invoice-due-range"
            onChange={(event) => {
              requestId.reset();
              setDueDate(event.target.value);
              prepare.reset();
            }}
          />
        </label>
        <p id="invoice-due-range" className="account-note">
          {date(firstDue)} to {date(lastDue)}
        </p>
      </div>
      <fieldset className="invoice-choices" disabled={locked}>
        <legend>Invoice line choices</legend>
        {options.lines.map((line, index) => (
          <label
            className="invoice-choice"
            key={`${line.description}:${line.amountMinor}`}
          >
            <input
              type="checkbox"
              checked={selected.includes(index)}
              onChange={(event) => {
                requestId.reset();
                setSelected((values) =>
                  event.target.checked
                    ? [...values, index].sort((a, b) => a - b)
                    : values.filter((value) => value !== index),
                );
                prepare.reset();
              }}
            />
            <span>{line.description}</span>{" "}
            <span className="invoice-choice-amount">
              {money(line.amountMinor, "USD")}
            </span>
          </label>
        ))}
        <p className="invoice-choice-total" aria-live="polite">
          <span>Total</span>{" "}
          <span>
            {money(total, "USD")} <span className="invoice-currency">USD</span>
          </span>
        </p>
      </fieldset>
      <div className="invoice-workflow">
        <div className="account-actions">
          <button
            className="account-primary-button"
            type="submit"
            disabled={locked || problem !== null || lines.length > 100}
          >
            {prepare.isPending ? "Preparing…" : "Review invoice"}
          </button>
          {problem && <p className="account-note">{problem}</p>}
        </div>
        {prepare.isError && (
          <p role="alert">
            {conflict
              ? "This preparation conflicts with stored information. Reload the customer and choices, then review before preparing again."
              : prepare.error.message}
          </p>
        )}
        {conflict && (
          <button
            className="secondary-button"
            type="button"
            onClick={() => void reload()}
          >
            Reload customer and choices
          </button>
        )}
      </div>
    </form>
  );
}

function Review({
  userId,
  customerId,
  invoiceId,
}: {
  userId: string;
  customerId: string;
  invoiceId: string;
}) {
  const client = useQueryClient();
  const path = `/api/customers/${encodeURIComponent(customerId)}/invoices/${encodeURIComponent(invoiceId)}`;
  const key = ["invoice-preparation", userId, customerId, invoiceId];
  const preparation = useQuery({
    queryKey: key,
    queryFn: ({ signal }) =>
      request<InvoicePreparationResponse>(`${path}/preparation`, { signal }),
    retry: false,
    refetchInterval: 5000,
  });
  const issue = useMutation({
    mutationFn: () => command<ConfirmIssueResponse>(`${path}/issue`, {}),
    retry: false,
    onSuccess: () => {
      void preparation.refetch();
      void client.invalidateQueries({ queryKey: ["invoices", userId] });
    },
  });
  const check = useMutation({
    mutationFn: () => command<InvoiceResponse>(`${path}/check`, {}),
    retry: false,
    onSuccess: () => {
      void preparation.refetch();
      void client.invalidateQueries({ queryKey: ["invoices", userId] });
    },
  });
  const conflict =
    issue.error instanceof AccountError && issue.error.status === 409;
  const reload = async () => {
    const result = await preparation.refetch();
    if (!result.isError) {
      issue.reset();
      check.reset();
    }
  };
  const blocker = preparation.data?.issueBlocker;
  return (
    <section className="panel invoice-detail">
      {preparation.isPending && (
        <p className="state-panel" role="status">
          Loading the stored invoice…
        </p>
      )}
      {preparation.isError && (
        <div className="state-panel error-state">
          <p role="alert">{preparation.error.message}</p>
          <button className="secondary-button" onClick={() => void reload()}>
            Reload invoice
          </button>
        </div>
      )}
      {!preparation.isError && preparation.data && (
        <>
          <Invoice invoice={preparation.data.invoice} showResolution={false} />
          <div className="invoice-workflow">
            {blocker && blockers[blocker] && (
              <p className="invoice-review">{blockers[blocker]}</p>
            )}
            <div className="account-actions">
              {blocker === null && !issue.isSuccess && (
                <button
                  className="account-primary-button"
                  disabled={issue.isPending || check.isPending || conflict}
                  onClick={() => issue.mutate()}
                >
                  {issue.isPending ? "Requesting issuance…" : "Issue invoice"}
                </button>
              )}
              {blocker === "past_due" && (
                <Link
                  className="secondary-button"
                  to="/customers/$customerId/invoices/new"
                  params={{ customerId }}
                >
                  Prepare invoice
                </Link>
              )}
              <button
                className="secondary-button"
                disabled={check.isPending || issue.isPending}
                onClick={() => check.mutate()}
              >
                {check.isPending ? "Checking…" : "Check status"}
              </button>
            </div>
            {issue.isSuccess && (
              <p className="sr-only" role="status">
                Issuance requested.
              </p>
            )}
            {issue.isError && (
              <p role="alert">
                {conflict
                  ? "Issuance conflicts with the stored invoice. Reload and review its current status before trying again."
                  : issue.error.message}
              </p>
            )}
            {check.isError && <p role="alert">{check.error.message}</p>}
            {conflict && (
              <button
                className="secondary-button"
                onClick={() => void reload()}
              >
                Reload invoice
              </button>
            )}
            <p className="account-note">
              Stripe sandbox uses a placeholder address; no email is sent.
            </p>
          </div>
          <InvoiceResolutions
            userId={userId}
            customerId={customerId}
            invoiceId={invoiceId}
            currency={preparation.data.invoice.currency}
          />
        </>
      )}
    </section>
  );
}
