import { useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type {
  PaymentSettingsResponse,
  PaymentSetupResponse,
  ChangeEnrollmentResponse,
  ReplaceEnrollmentRequest,
  ReduceEnrollmentRequest,
} from "../../billing/payment-settings-contract";
import {
  AccountError,
  command,
  request,
  useRequestId,
  useSession,
} from "../accounts/api";
import { date, dateRange, instant, money } from "./format";
import "./payment-settings.css";

type Agreement = PaymentSettingsResponse["subscriptions"][number];
type Boundary = Agreement["boundaries"][number];
type RetainedScope = NonNullable<Agreement["retainedScope"]>;
const frequency = (months: number) =>
  months === 1 ? "Monthly" : `Every ${months} months`;
const cardLabel = (card: PaymentSettingsResponse["methods"][number]) =>
  `${card.brand} ending ${card.last4}, expires ${String(card.expiryMonth).padStart(2, "0")}/${card.expiryYear}`;

function currentScopes(data: PaymentSettingsResponse): RetainedScope[] {
  // The read facade rejects missing or inconsistent consent projections.
  return (
    data.enrollment?.scopes.map(
      ({ subscriptionId }) =>
        data.subscriptions.find(({ id }) => id === subscriptionId)!
          .retainedScope!,
    ) ?? []
  );
}

function scopeChoice(agreement: Agreement, value: string | undefined) {
  const retained = value === "retained" ? agreement.retainedScope : null;
  if (retained)
    return {
      scope: retained,
      intervalMonths: retained.intervalMonths,
      currency: retained.currency,
      timeZone: retained.calendar.timeZone,
      retained: true,
      switchesToAutomatic: false,
    };
  const boundary = agreement.boundaries.find(
    (candidate) => String(candidate.fromPeriodIndex) === value,
  );
  return boundary
    ? {
        scope: boundary,
        intervalMonths: agreement.intervalMonths,
        currency: "USD",
        timeZone: agreement.calendar.timeZone,
        retained: false,
        switchesToAutomatic: boundary.paymentArrangement === "manual",
      }
    : undefined;
}

function choiceText(
  agreement: Agreement,
  scope: Boundary | RetainedScope,
  currency: string,
) {
  const label = scope.label === agreement.label ? "" : `${scope.label}: `;
  const periods =
    scope.untilPeriodStart === null
      ? `From ${date(scope.periodStart)}`
      : dateRange(scope.periodStart, scope.untilPeriodStart);
  return `${label}${periods}, ${money(scope.amountMinor, currency)}`;
}

function hostedUrl(value: string): string {
  const url = new URL(value);
  if (
    url.origin !== "https://checkout.stripe.com" ||
    url.username ||
    url.password
  )
    throw new AccountError(503);
  return url.href;
}

export function PaymentSettingsPage({
  customerId,
  setupId,
}: {
  customerId: string;
  setupId?: string;
}) {
  const session = useSession();
  return (
    <div className="account-page payment-settings-page">
      <header className="account-page-header">
        <Link
          className="account-back"
          to="/customers/$customerId"
          params={{ customerId }}
        >
          Customer account
        </Link>
        <h1>Payment settings</h1>
      </header>
      {session.isPending ? (
        <p className="panel state-panel" role="status">
          Checking your session…
        </p>
      ) : session.isError ? (
        <p className="panel state-panel" role="alert">
          {session.error.message}
        </p>
      ) : !session.data?.user ? (
        <section className="panel state-panel" aria-label="Sign in">
          <p>Sign in to continue.</p>
          <a href={`/sign-in?returnTo=${encodeURIComponent(location.href)}`}>
            Sign in
          </a>
        </section>
      ) : (
        <Settings
          key={`${session.data.user.id}:${customerId}:${setupId ?? ""}`}
          userId={session.data.user.id}
          customerId={customerId}
          setupId={setupId}
        />
      )}
    </div>
  );
}

function Settings({
  userId,
  customerId,
  setupId,
}: {
  userId: string;
  customerId: string;
  setupId?: string;
}) {
  const client = useQueryClient();
  const path = `/api/customers/${encodeURIComponent(customerId)}`;
  const queryKey = ["payment-settings", userId, customerId];
  const [localSetupId, setLocalSetupId] = useState(setupId);
  const [notice, setNotice] = useState("");
  const [generation, setGeneration] = useState(0);
  const settings = useQuery({
    queryKey,
    queryFn: ({ signal }) =>
      request<PaymentSettingsResponse>(`${path}/payment-settings`, { signal }),
    retry: false,
  });
  const refresh = async () => {
    await client.invalidateQueries({ queryKey });
  };
  const reload = async () => {
    await refresh();
    setGeneration((value) => value + 1);
  };
  if (settings.isPending)
    return (
      <p className="panel state-panel" role="status">
        Loading payment settings…
      </p>
    );
  if (settings.isError)
    return (
      <section
        className="panel state-panel"
        aria-label="Payment settings unavailable"
      >
        <p role="alert">{settings.error.message}</p>
        <button
          className="secondary-button"
          onClick={() => void settings.refetch()}
        >
          Reload and review
        </button>
      </section>
    );
  const data = settings.data;
  return (
    <>
      {!data.canManage && (
        <p className="account-note">
          A customer administrator can manage these settings.
        </p>
      )}
      <section className="panel account-section">
        <h2>Saved cards</h2>
        {localSetupId && data.canManage && (
          <SetupReturn
            key={localSetupId}
            path={path}
            userId={userId}
            customerId={customerId}
            setupId={localSetupId}
            reload={refresh}
          />
        )}
        {data.methods.length ? (
          <ul className="payment-records">
            {data.methods.map((card) => (
              <li key={card.id}>
                <span>{cardLabel(card)}</span>
                <span className="payment-support">
                  Verified {instant(card.verifiedAt)}
                </span>
                {!card.usable && (
                  <span className="payment-warning">
                    Unavailable for automatic payments. Save another card.
                  </span>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="account-note">No verified cards saved.</p>
        )}
        {data.canManage && (
          <SaveCard
            key={data.saveTerms.version}
            data={data}
            path={path}
            onSetup={async (result) => {
              setLocalSetupId(result.setupId);
              await refresh();
            }}
          />
        )}
      </section>
      <section className="panel account-section">
        <h2>Automatic payments</h2>
        {notice && <p role="status">{notice}</p>}
        <CurrentConsent data={data} customerId={customerId} />
        {data.canManage && (
          <EnrollmentEditor
            key={`${generation}:${JSON.stringify(data)}`}
            data={data}
            path={path}
            customerId={customerId}
            reload={reload}
            updated={async () => {
              setNotice("Automatic payment settings updated.");
              await reload();
            }}
          />
        )}
      </section>
    </>
  );
}

function SetupReturn({
  path,
  userId,
  customerId,
  setupId,
  reload,
}: {
  path: string;
  userId: string;
  customerId: string;
  setupId: string;
  reload: () => Promise<void>;
}) {
  const setup = useQuery({
    queryKey: ["payment-setup", userId, customerId, setupId],
    queryFn: async ({ signal }) => {
      const result = await request<PaymentSetupResponse>(
        `${path}/payment-setups/${encodeURIComponent(setupId)}/refresh`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
          signal,
        },
      );
      if (result.checkoutUrl) hostedUrl(result.checkoutUrl);
      await reload();
      return result;
    },
    retry: false,
    refetchOnWindowFocus: false,
    refetchInterval: (query) =>
      !query.state.error &&
      query.state.data?.status === "pending" &&
      query.state.dataUpdateCount < 20
        ? 3000
        : false,
  });
  const status = setup.data?.status;
  return (
    <section className="payment-setup" aria-label="Card setup result">
      <p role={setup.isError ? "alert" : "status"}>
        {setup.isError
          ? setup.error.message
          : setup.isPending
            ? "Checking saved card…"
            : status === "verified"
              ? "Card verified. Choose the agreements below to authorize automatic payments."
              : status === "expired"
                ? "This card setup expired. Start a new setup."
                : status === "needs_review"
                  ? "This card setup needs review. Contact support."
                  : "Card setup is pending verification."}
      </p>
      {(setup.isError || status === "pending") && (
        <div className="account-actions">
          <button
            className="secondary-button"
            disabled={setup.isFetching}
            onClick={() => void setup.refetch()}
          >
            {setup.isFetching ? "Checking…" : "Check saved card"}
          </button>
          {!setup.isError && setup.data?.checkoutUrl && (
            <a
              className="secondary-button"
              href={hostedUrl(setup.data.checkoutUrl)}
            >
              Continue card setup with Stripe
            </a>
          )}
        </div>
      )}
    </section>
  );
}

function SaveCard({
  data,
  path,
  onSetup,
}: {
  data: PaymentSettingsResponse;
  path: string;
  onSetup: (result: PaymentSetupResponse) => Promise<void>;
}) {
  const [accepted, setAccepted] = useState(false);
  const identity = useRequestId();
  const setup = useMutation({
    mutationFn: async () => {
      const input = {
        saveTermsVersion: data.saveTerms.version,
        acceptSaveTerms: true,
      };
      const result = await command<PaymentSetupResponse>(
        `${path}/payment-setups`,
        {
          ...input,
          requestId: identity.get(input),
        },
      );
      if (result.checkoutUrl) hostedUrl(result.checkoutUrl);
      return result;
    },
    retry: false,
    onSuccess: async (result) => {
      if (result.checkoutUrl) location.assign(hostedUrl(result.checkoutUrl));
      else await onSetup(result);
    },
  });
  const conflict =
    setup.error instanceof AccountError && setup.error.status === 409;
  return (
    <form
      className="account-form payment-save"
      onSubmit={(event) => {
        event.preventDefault();
        if (accepted && data.setupAvailable && !setup.isPending && !conflict)
          setup.mutate();
      }}
    >
      <label className="payment-check">
        <input
          type="checkbox"
          checked={accepted}
          disabled={!data.setupAvailable || setup.isPending || conflict}
          onChange={(event) => setAccepted(event.target.checked)}
        />
        <span>{data.saveTerms.text}</span>
      </label>
      <p className="account-note payment-terms-version">
        Save-card permission {data.saveTerms.version}
      </p>
      {!data.setupAvailable && (
        <p className="payment-warning">
          Card setup is unavailable. Try again later.
        </p>
      )}
      <button
        className="secondary-button"
        disabled={
          !accepted ||
          !data.setupAvailable ||
          setup.isPending ||
          conflict ||
          setup.isSuccess
        }
      >
        {setup.isPending ? "Opening Stripe…" : "Save card with Stripe"}
      </button>
      {setup.isError && <p role="alert">{setup.error.message}</p>}
      {conflict && (
        <button
          type="button"
          className="secondary-button"
          onClick={() => location.reload()}
        >
          Reload and review
        </button>
      )}
    </form>
  );
}

function EffectivePeriod({
  boundary,
  timeZone,
}: {
  boundary: Pick<Boundary, "periodStart" | "dueDate" | "untilPeriodStart">;
  timeZone: string;
}) {
  return (
    <span className="payment-support">
      {boundary.untilPeriodStart === null
        ? `Service periods from ${date(boundary.periodStart)}. Until commercial terms change or you stop.`
        : `Service periods ${dateRange(boundary.periodStart, boundary.untilPeriodStart)}.`}
      {` First invoice due ${date(boundary.dueDate)}. Dates in ${timeZone}.`}
    </span>
  );
}

function ScopeLine({
  label,
  amountMinor,
  currency,
  intervalMonths,
}: {
  label: ReactNode;
  amountMinor: number;
  currency: string;
  intervalMonths: number;
}) {
  return (
    <span className="payment-line">
      {label}
      <span className="payment-amount">
        {money(amountMinor, currency)} · {frequency(intervalMonths)}
      </span>
    </span>
  );
}

function CurrentConsent({
  data,
  customerId,
}: {
  data: PaymentSettingsResponse;
  customerId: string;
}) {
  const enrollment = data.enrollment;
  const card = data.methods.find(
    (candidate) => candidate.id === enrollment?.paymentMethodId,
  );
  if (!enrollment?.scopes.length) return <p>Automatic payments are stopped.</p>;
  return (
    <div className="payment-current">
      <p>
        Selected card:{" "}
        {card ? cardLabel(card) : "a saved card whose details are unavailable"}
      </p>
      {card && !card.usable && (
        <p className="payment-warning">
          This card is unavailable for automatic payments.
        </p>
      )}
      <ul className="payment-records">
        {currentScopes(data).map((scope) => (
          <li key={scope.subscriptionId}>
            <ScopeLine
              {...scope}
              label={
                <Link
                  to="/customers/$customerId/subscriptions/$subscriptionId"
                  params={{ customerId, subscriptionId: scope.subscriptionId }}
                >
                  {scope.label}
                </Link>
              }
            />
            <EffectivePeriod
              boundary={scope}
              timeZone={scope.calendar.timeZone}
            />
          </li>
        ))}
      </ul>
      <p className="account-note">
        Consent version {enrollment.version}, accepted{" "}
        {instant(enrollment.acceptedAt)} under terms {enrollment.termsVersion}.
        {data.consentAdministratorOrigin === "staff_invited"
          ? " The consenting customer administrator was invited by staff."
          : data.consentAdministratorOrigin === "customer_invited"
            ? " The consenting customer administrator was invited by a customer administrator."
            : data.consentAdministratorOrigin === "unknown"
              ? " The consenting administrator’s invitation origin is unknown."
              : ""}
      </p>
      {!data.canManage && (
        <p className="account-note">{data.enrollmentTerms.text}</p>
      )}
    </div>
  );
}

function AffectedInvoices({ data }: { data: PaymentSettingsResponse }) {
  return (
    <div className="payment-consequence">
      <p className="payment-warning">
        Changing this consent requires customer payment for every unpaid invoice
        already sealed under the previous consent. A payment attempt already
        started may finish.
      </p>
      {data.affectedInvoices.length ? (
        <ul className="payment-records">
          {data.affectedInvoices.map((invoice) => (
            <li key={invoice.invoiceId} className="payment-line">
              <Link
                to="/invoices"
                search={{ invoiceId: invoice.invoiceId, offset: 0 }}
              >
                Invoice due {date(invoice.dueDate)}
              </Link>
              <span className="payment-amount">
                {money(invoice.totalMinor, "USD")}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="account-note">No unpaid invoices are affected.</p>
      )}
    </div>
  );
}

type EnrollmentCommand =
  | { kind: "replace"; input: ReplaceEnrollmentRequest }
  | { kind: "reduce"; input: ReduceEnrollmentRequest };

function EnrollmentEditor({
  data,
  path,
  customerId,
  reload,
  updated,
}: {
  data: PaymentSettingsResponse;
  path: string;
  customerId: string;
  reload: () => Promise<void>;
  updated: () => Promise<void>;
}) {
  const [methodId, setMethodId] = useState("");
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [accepted, setAccepted] = useState(false);
  const [retained, setRetained] = useState(
    () => data.enrollment?.scopes.map((scope) => scope.subscriptionId) ?? [],
  );
  const identity = useRequestId();
  const change = useMutation({
    mutationFn: (action: EnrollmentCommand) =>
      command<ChangeEnrollmentResponse>(
        `${path}/automatic-payment-enrollment${action.kind === "reduce" ? "/reduce" : ""}`,
        action.input,
      ),
    retry: false,
    onSuccess: updated,
  });
  const conflict =
    change.error instanceof AccountError && change.error.status === 409;
  const locked = change.isPending || change.isSuccess || conflict;
  const picks = data.subscriptions.flatMap((agreement) => {
    const choice = scopeChoice(agreement, selected[agreement.id]);
    return choice ? [{ agreement, ...choice }] : [];
  });
  const method = data.methods.find(
    (candidate) => candidate.id === methodId && candidate.usable,
  );
  const valid = Boolean(method && picks.length && accepted);
  const reduce = (ids: string[]) => {
    if (!data.enrollment || locked) return;
    const input = {
      expectedVersion: data.enrollment.version,
      retainSubscriptionIds: ids,
    };
    change.mutate({
      kind: "reduce",
      input: {
        ...input,
        requestId: identity.get({ kind: "reduce", ...input }),
      },
    });
  };
  const edit = () => {
    setAccepted(false);
    change.reset();
  };
  return (
    <div className="payment-editor">
      <AffectedInvoices data={data} />
      {data.enrollment && data.enrollment.scopes.length > 0 && (
        <form
          className="account-form payment-reduce"
          aria-label="Reduce automatic payments"
          onSubmit={(event) => {
            event.preventDefault();
            reduce(retained);
          }}
        >
          <fieldset disabled={locked}>
            <legend>Keep automatic payments for</legend>
            {currentScopes(data).map((scope) => (
              <label className="payment-check" key={scope.subscriptionId}>
                <input
                  type="checkbox"
                  checked={retained.includes(scope.subscriptionId)}
                  onChange={(event) => {
                    setRetained((ids) =>
                      event.target.checked
                        ? [...ids, scope.subscriptionId]
                        : ids.filter((id) => id !== scope.subscriptionId),
                    );
                    change.reset();
                  }}
                />
                <span>{scope.label}</span>
              </label>
            ))}
          </fieldset>
          <p className="account-note">
            Applies immediately to new payment attempts. An attempt already
            started may finish. Invoices stay on schedule and agreements left
            out need manual payment.
          </p>
          <div className="account-actions">
            <button
              className="secondary-button"
              disabled={
                locked ||
                retained.length === data.enrollment.scopes.length ||
                retained.length === 0
              }
            >
              Save reduced scope
            </button>
            <button
              type="button"
              className="secondary-button"
              disabled={locked}
              onClick={() => reduce([])}
            >
              Stop automatic payments
            </button>
          </div>
        </form>
      )}
      <form
        className="account-form payment-replace"
        aria-label="Authorize automatic payments"
        onSubmit={(event) => {
          event.preventDefault();
          if (!valid || locked || !method) return;
          const input = {
            expectedVersion: data.enrollment?.version ?? 0,
            paymentMethodId: method.id,
            termsVersion: data.enrollmentTerms.version,
            acceptTerms: true as const,
            selections: picks.map(({ agreement, scope }) => ({
              subscriptionId: agreement.id,
              expectedSubscriptionVersion: agreement.version,
              fromPeriodIndex: scope.fromPeriodIndex,
            })),
          };
          change.mutate({
            kind: "replace",
            input: {
              ...input,
              requestId: identity.get({ kind: "replace", ...input }),
            },
          });
        }}
      >
        <fieldset disabled={locked}>
          {data.enrollment && data.enrollment.scopes.length > 0 && (
            <legend>Change card or agreements</legend>
          )}
          <label>
            Card for automatic payments
            <select
              value={methodId}
              onChange={(event) => {
                setMethodId(event.target.value);
                edit();
              }}
            >
              <option value="">Choose a saved card</option>
              {data.methods
                .filter((card) => card.usable)
                .map((card) => (
                  <option key={card.id} value={card.id}>
                    {cardLabel(card)}
                  </option>
                ))}
            </select>
          </label>
          {!data.methods.some((card) => card.usable) && (
            <p className="account-note">Save and verify a card first.</p>
          )}
          <ul className="payment-records payment-agreements">
            {data.subscriptions.map((agreement) => {
              const choice = scopeChoice(agreement, selected[agreement.id]);
              const retained = agreement.retainedScope;
              return (
                <li className="payment-agreement" key={agreement.id}>
                  <span>
                    <Link
                      to="/customers/$customerId/subscriptions/$subscriptionId"
                      params={{ customerId, subscriptionId: agreement.id }}
                    >
                      {agreement.label}
                    </Link>
                    <span className="payment-support">
                      {frequency(agreement.intervalMonths)}
                    </span>
                  </span>
                  {retained || agreement.boundaries.length ? (
                    <div className="payment-choice">
                      <label>
                        Effective service period
                        <select
                          value={selected[agreement.id] ?? ""}
                          onChange={(event) => {
                            setSelected((values) => ({
                              ...values,
                              [agreement.id]: event.target.value,
                            }));
                            edit();
                          }}
                        >
                          <option value="">Not included</option>
                          {retained && (
                            <option value="retained">
                              {`Keep existing scope: ${choiceText(agreement, retained, retained.currency)}`}
                            </option>
                          )}
                          {agreement.boundaries.map((boundary) => (
                            <option
                              key={boundary.fromPeriodIndex}
                              value={boundary.fromPeriodIndex}
                            >
                              {choiceText(agreement, boundary, "USD")}
                            </option>
                          ))}
                        </select>
                      </label>
                      {choice?.switchesToAutomatic && (
                        <span className="payment-warning">
                          This agreement will switch to automatic payment from
                          this service period.
                        </span>
                      )}
                      {agreement.blocker && retained && (
                        <span className="account-note">
                          No new future service period is available. You can
                          keep the existing scope.
                        </span>
                      )}
                    </div>
                  ) : (
                    <p
                      className={
                        agreement.blocker ? "payment-warning" : "account-note"
                      }
                    >
                      {agreement.blocker
                        ? "No future service period is available. Review this agreement."
                        : "Manual payment. No automatic payment period is available."}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
          {data.subscriptions.length === 0 && (
            <p className="account-note">No agreements available.</p>
          )}
          {picks.length > 0 && (
            <div className="payment-confirmation">
              <p>
                {method
                  ? `Automatic payments will be charged to ${cardLabel(method)} for:`
                  : "Choose a card to authorize automatic payments for:"}
              </p>
              <ul className="payment-records">
                {picks.map(
                  ({
                    agreement,
                    scope,
                    currency,
                    intervalMonths,
                    timeZone,
                    retained,
                    switchesToAutomatic,
                  }) => (
                    <li key={agreement.id}>
                      <ScopeLine
                        label={<strong>{scope.label}</strong>}
                        amountMinor={scope.amountMinor}
                        currency={currency}
                        intervalMonths={intervalMonths}
                      />
                      <EffectivePeriod boundary={scope} timeZone={timeZone} />
                      {retained && (
                        <span className="payment-support">
                          Existing scope and recorded price retained.
                        </span>
                      )}
                      {switchesToAutomatic && (
                        <span className="payment-warning">
                          Switches from manual to automatic payment from this
                          service period.
                        </span>
                      )}
                    </li>
                  ),
                )}
              </ul>
              {data.subscriptions.length > picks.length && (
                <p className="account-note">
                  Agreements not included will not be paid automatically.
                </p>
              )}
            </div>
          )}
          <label className="payment-check">
            <input
              type="checkbox"
              checked={accepted}
              disabled={!method || !picks.length}
              onChange={(event) => setAccepted(event.target.checked)}
            />
            <span>{data.enrollmentTerms.text}</span>
          </label>
          <p className="account-note payment-terms-version">
            Automatic payment terms {data.enrollmentTerms.version}
          </p>
          <button
            className="account-primary-button"
            disabled={locked || !valid}
          >
            {change.isPending ? "Saving…" : "Confirm automatic payments"}
          </button>
        </fieldset>
      </form>
      {change.isError && <p role="alert">{change.error.message}</p>}
      {conflict && (
        <button className="secondary-button" onClick={() => void reload()}>
          Reload and review
        </button>
      )}
    </div>
  );
}
