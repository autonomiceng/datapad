import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import type {
  ChangeSubscriptionRequest,
  ChangeSubscriptionResponse,
  CreateSubscriptionRequest,
  CreateSubscriptionResponse,
  ForecastResponse,
  MaterializeForecastRequest,
  MaterializeForecastResponse,
  SubscriptionBoundariesResponse,
  SubscriptionBoundaryRequest,
  SubscriptionOptionsResponse,
  SubscriptionResponse,
  SubscriptionsResponse,
  SubscriptionSummary,
} from "../../billing/subscriptions-contract";
import type { ServiceResponse } from "../../services/contract";
import {
  AccountError,
  command,
  request,
  useRequestId,
  useSession,
} from "../accounts/api";
import { date, money } from "./invoices";
import "./subscriptions.css";

const pageSize = 50;
const customerPath = (id: string) => `/api/customers/${encodeURIComponent(id)}`;
function today(timeZone = "UTC") {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  return ["year", "month", "day"]
    .map((key) => parts.find((part) => part.type === key)?.value)
    .join("-");
}
/** Date inputs report "" while incomplete; only calendar dates reach queries. */
const validDate = (value: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  new Date(`${value}T00:00:00Z`).toISOString().startsWith(value);
function monthsAfter(value: string, months: number) {
  const result = new Date(`${value}T00:00:00Z`);
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  return result.toISOString().slice(0, 10);
}
function parameters(values: object) {
  return new URLSearchParams(
    Object.entries(values).map(([key, value]) => [key, String(value)]),
  ).toString();
}
type Boundary = SubscriptionBoundariesResponse["boundaries"][number];
type Choice = SubscriptionOptionsResponse["choices"][number];
type BillingState = SubscriptionSummary["billingState"];
const range = (start: string, end: string) =>
  start.slice(0, 4) === end.slice(0, 4)
    ? `${date(start).replace(/, \d{4}$/, "")} to ${date(end)}`
    : `${date(start)} to ${date(end)}`;
const boundaryLabel = (boundary: Boundary) =>
  `${range(boundary.periodStart, boundary.periodEnd)}, due ${date(boundary.dueDate)}`;
const periodNames: Record<number, string> = {
  1: "month",
  3: "3 months",
  6: "6 months",
  12: "year",
  24: "2 years",
  36: "3 years",
};
const frequency = (months: number) =>
  months === 1
    ? "Monthly"
    : months === 12
      ? "Yearly"
      : `Every ${periodNames[months]}`;
const price = (amountMinor: number, months: number) =>
  amountMinor === 0
    ? "Free"
    : `${money(amountMinor, "USD")} ${months === 1 || months === 12 ? "per" : "every"} ${periodNames[months]}`;
const arrangement = (value: string) =>
  value === "automatic" ? "Automatic" : "Manual";
const states: Record<BillingState, string> = {
  billable: "Billable",
  paused: "Paused",
  cancelled: "Cancelled",
};
const conflictError = (error: Error | null) =>
  error instanceof AccountError && error.status === 409;

function MutationFeedback({
  error,
  reload,
  success,
}: {
  error: Error | null;
  reload: () => void;
  success?: string;
}) {
  return (
    <>
      {success && <p role="status">{success}</p>}
      {error && (
        <p role="alert">
          {conflictError(error)
            ? "This subscription changed or this request was already recorded. Reload and review before trying again."
            : error.message}
        </p>
      )}
      {conflictError(error) && (
        <div className="account-actions">
          <button type="button" className="secondary-button" onClick={reload}>
            Reload and review
          </button>
        </div>
      )}
    </>
  );
}
function Header({ back, title }: { back: ReactNode; title: string }) {
  return (
    <header className="account-page-header">
      {back}
      <h1>{title}</h1>
    </header>
  );
}
function SessionPage({
  customerId,
  subscriptionId,
}: {
  customerId: string;
  subscriptionId?: string;
}) {
  const session = useSession();
  if (session.isPending) return <p role="status">Checking your session…</p>;
  if (session.isError) return <p role="alert">{session.error.message}</p>;
  if (!session.data?.user)
    return (
      <section className="panel state-panel">
        <h1>Sign in to continue</h1>
        <a href={`/sign-in?returnTo=${encodeURIComponent(location.href)}`}>
          Sign in
        </a>
      </section>
    );
  const props = {
    customerId,
    userId: session.data.user.id,
    billingStaff: session.data.staffRoles.includes("billing"),
  };
  return (
    <div className="account-page subscription-page">
      {subscriptionId ? (
        <Agreement
          key={`${props.userId}:${customerId}:${subscriptionId}`}
          {...props}
          subscriptionId={subscriptionId}
        />
      ) : (
        <Overview key={`${props.userId}:${customerId}`} {...props} />
      )}
    </div>
  );
}
export function SubscriptionsPage({ customerId }: { customerId: string }) {
  return <SessionPage customerId={customerId} />;
}
export function SubscriptionPage({
  customerId,
  subscriptionId,
}: {
  customerId: string;
  subscriptionId: string;
}) {
  return (
    <SessionPage customerId={customerId} subscriptionId={subscriptionId} />
  );
}
type Scope = { customerId: string; userId: string; billingStaff: boolean };

function ServiceRelationship({
  customerId,
  serviceId,
  userId,
}: {
  customerId: string;
  serviceId: string | null;
  userId: string;
}) {
  const service = useQuery({
    queryKey: ["services", userId, customerId, serviceId],
    enabled: serviceId !== null,
    queryFn: ({ signal }) =>
      request<ServiceResponse>(
        `${customerPath(customerId)}/services/${encodeURIComponent(serviceId ?? "")}`,
        { signal },
      ),
    retry: false,
  });
  return serviceId ? (
    <Link
      to="/customers/$customerId/services/$serviceId"
      params={{ customerId, serviceId }}
    >
      {service.data?.service.name ?? "Linked service"}
    </Link>
  ) : (
    <>Not linked to a service</>
  );
}
function Pages({
  offset,
  total,
  onChange,
}: {
  offset: number;
  total: number;
  onChange: (offset: number) => void;
}) {
  if (total <= pageSize && offset === 0) return null;
  return (
    <nav className="pagination" aria-label="Result pages">
      <span>
        {offset + 1}–{Math.min(offset + pageSize, total)} of {total}
      </span>
      <div>
        <button
          className="secondary-button"
          disabled={offset === 0}
          onClick={() => onChange(Math.max(0, offset - pageSize))}
        >
          Previous
        </button>
        <button
          className="secondary-button"
          disabled={offset + pageSize >= total}
          onClick={() => onChange(offset + pageSize)}
        >
          Next
        </button>
      </div>
    </nav>
  );
}
function Overview(scope: Scope) {
  const [offset, setOffset] = useState(0);
  const [generation, setGeneration] = useState(0);
  const path = customerPath(scope.customerId);
  const list = useQuery({
    queryKey: ["subscriptions", scope.userId, scope.customerId, offset],
    queryFn: ({ signal }) =>
      request<SubscriptionsResponse>(
        `${path}/subscriptions?limit=${pageSize}&offset=${offset}`,
        { signal },
      ),
    retry: false,
  });
  const options = useQuery({
    queryKey: ["subscription-options", scope.userId, scope.customerId],
    enabled: scope.billingStaff,
    queryFn: ({ signal }) =>
      request<SubscriptionOptionsResponse>(`${path}/subscription-options`, {
        signal,
      }),
    retry: false,
  });
  const reload = async () => {
    const results = await Promise.all([list.refetch(), options.refetch()]);
    if (results.every((result) => !result.isError))
      setGeneration((value) => value + 1);
  };
  return (
    <>
      <Header
        back={
          <Link
            className="account-back"
            to="/customers/$customerId"
            params={{ customerId: scope.customerId }}
          >
            Customer account
          </Link>
        }
        title="Subscriptions"
      />
      <section className="panel account-section" aria-label="Subscriptions">
        {list.isPending && <p role="status">Loading subscriptions…</p>}
        {list.isError && <p role="alert">{list.error.message}</p>}
        {!list.isError && list.data && (
          <>
            {list.data.total === 0 && (
              <p className="account-note">No subscriptions recorded.</p>
            )}
            <ul className="subscription-rows">
              {list.data.subscriptions.map((subscription) => (
                <li key={subscription.id}>
                  <Link
                    to="/customers/$customerId/subscriptions/$subscriptionId"
                    params={{
                      customerId: scope.customerId,
                      subscriptionId: subscription.id,
                    }}
                  >
                    {subscription.label}
                  </Link>
                  <span className="subscription-amount">
                    {price(
                      subscription.amountMinor,
                      subscription.intervalMonths,
                    )}
                  </span>
                  <span className="account-note">
                    {arrangement(subscription.paymentArrangement)} payment.{" "}
                    {subscription.nextRenewal
                      ? `Next renewal ${date(subscription.nextRenewal)}.`
                      : "No renewal scheduled."}
                  </span>
                  {(subscription.billingState !== "billable" ||
                    subscription.cancellation.status === "requested") && (
                    <span className="status-tag">
                      {subscription.billingState === "billable"
                        ? "Cancellation requested"
                        : states[subscription.billingState]}
                    </span>
                  )}
                </li>
              ))}
            </ul>
            <Pages
              offset={offset}
              total={list.data.total}
              onChange={setOffset}
            />
          </>
        )}
      </section>
      {scope.billingStaff && (
        <section className="panel account-section">
          <h2>Create subscription</h2>
          {options.isPending && <p role="status">Loading choices…</p>}
          {options.isError && <p role="alert">{options.error.message}</p>}
          {!options.isError &&
            options.data &&
            (options.data.choices.length === 0 ? (
              <p className="account-note">
                No subscription choices are configured.
              </p>
            ) : (
              <CreateForm
                key={generation}
                {...scope}
                options={options.data}
                reload={() => void reload()}
              />
            ))}
        </section>
      )}
      <Forecast {...scope} />
    </>
  );
}
function useBoundaries(
  scope: Pick<Scope, "customerId" | "userId">,
  input: SubscriptionBoundaryRequest | undefined,
) {
  return useQuery({
    queryKey: [
      "subscription-boundaries",
      scope.userId,
      scope.customerId,
      input,
    ],
    enabled: input !== undefined,
    queryFn: ({ signal }) =>
      request<SubscriptionBoundariesResponse>(
        `${customerPath(scope.customerId)}/subscription-boundaries?${parameters(input ?? {})}`,
        { signal },
      ),
    retry: false,
  });
}
function BoundarySelect({
  boundaries,
  value,
  onChange,
  disabled,
  label,
}: {
  boundaries: Boundary[];
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  label: string;
}) {
  return (
    <label>
      {label}
      <select
        required
        disabled={disabled}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">Choose a service period</option>
        {boundaries.map((boundary) => (
          <option key={boundary.periodIndex} value={boundary.periodIndex}>
            {boundaryLabel(boundary)}
          </option>
        ))}
      </select>
    </label>
  );
}

const dimensions = ["service", "interval", "amount", "arrangement"] as const;
type Dimension = (typeof dimensions)[number];
const read: Record<Dimension, (choice: Choice) => string> = {
  service: (choice) => JSON.stringify([choice.serviceId, choice.label]),
  interval: (choice) => String(choice.intervalMonths),
  amount: (choice) => String(choice.amountMinor),
  arrangement: (choice) => choice.paymentArrangement,
};
/** Lists values offered with the earlier selections; every option is a configured choice. */
function available(choices: Choice[], current: Choice, dimension: Dimension) {
  const earlier = dimensions.slice(0, dimensions.indexOf(dimension));
  const matches = choices.filter((choice) =>
    earlier.every((key) => read[key](choice) === read[key](current)),
  );
  return [
    ...new Map(matches.map((choice) => [read[dimension](choice), choice])),
  ];
}
/** Returns the configured choice closest to the current one with a new value. */
function select(
  choices: Choice[],
  current: Choice,
  dimension: Dimension,
  value: string,
) {
  const position = dimensions.indexOf(dimension);
  let pool = choices.filter(
    (choice) =>
      dimensions
        .slice(0, position)
        .every((key) => read[key](choice) === read[key](current)) &&
      read[dimension](choice) === value,
  );
  for (const key of dimensions.slice(position + 1)) {
    const kept = pool.filter(
      (choice) => read[key](choice) === read[key](current),
    );
    if (kept.length) pool = kept;
  }
  return pool[0] ?? current;
}
const fieldLabels: Record<Dimension, string> = {
  service: "Service",
  interval: "Billing frequency",
  amount: "Price",
  arrangement: "Payment arrangement",
};
function ChoiceFields({
  choices,
  value,
  onChange,
  fields,
}: {
  choices: Choice[];
  value: Choice;
  onChange: (choice: Choice) => void;
  fields: readonly Dimension[];
}) {
  const text: Record<Dimension, (choice: Choice) => string> = {
    service: (choice) => choice.label,
    interval: (choice) => frequency(choice.intervalMonths),
    amount: (choice) =>
      choice.amountMinor === 0 ? "Free" : money(choice.amountMinor, "USD"),
    arrangement: (choice) => arrangement(choice.paymentArrangement),
  };
  return (
    <div className="subscription-choice">
      {fields.map((dimension) => (
        <label key={dimension}>
          {fieldLabels[dimension]}
          <select
            value={read[dimension](value)}
            onChange={(event) =>
              onChange(select(choices, value, dimension, event.target.value))
            }
          >
            {available(choices, value, dimension).map(([key, choice]) => (
              <option key={key} value={key}>
                {text[dimension](choice)}
              </option>
            ))}
          </select>
        </label>
      ))}
    </div>
  );
}
const automaticNote = (
  <p className="account-note">
    Automatic payment still needs the customer’s payment consent before any
    charge.
  </p>
);

function CreateForm({
  options,
  reload,
  ...scope
}: Scope & { options: SubscriptionOptionsResponse; reload: () => void }) {
  const [choice, setChoice] = useState(options.choices[0]!);
  const [periodAnchorDate, setPeriodAnchorDate] = useState(
    options.periodAnchorDate,
  );
  const [dueAnchorDate, setDueAnchorDate] = useState(options.dueAnchorDate);
  const [fromDueDate, setFromDueDate] = useState(
    today(options.calendar.timeZone),
  );
  const [throughDueDate, setThroughDueDate] = useState(
    monthsAfter(today(options.calendar.timeZone), 36),
  );
  const [first, setFirst] = useState("");
  const anchorsValid = validDate(periodAnchorDate) && validDate(dueAnchorDate);
  const windowValid =
    validDate(fromDueDate) &&
    validDate(throughDueDate) &&
    fromDueDate <= throughDueDate;
  const boundaries = useBoundaries(
    scope,
    anchorsValid && windowValid
      ? {
          periodAnchorDate,
          dueAnchorDate,
          intervalMonths: choice.intervalMonths,
          fromDueDate,
          throughDueDate,
        }
      : undefined,
  );
  const requestId = useRequestId();
  const create = useMutation({
    mutationFn: (body: CreateSubscriptionRequest) =>
      command<CreateSubscriptionResponse>(
        `${customerPath(scope.customerId)}/subscriptions`,
        body,
      ),
    retry: false,
    onSuccess: (result) =>
      location.assign(
        `/customers/${encodeURIComponent(scope.customerId)}/subscriptions/${encodeURIComponent(result.subscription.id)}`,
      ),
  });
  const locked =
    create.isPending || create.isSuccess || conflictError(create.error);
  const edit = (action: () => void) => {
    requestId.reset();
    create.reset();
    setFirst("");
    action();
  };
  const periodsReady = anchorsValid && windowValid && !boundaries.isError;
  const firstBoundary = periodsReady
    ? boundaries.data?.boundaries.find(
        (boundary) => String(boundary.periodIndex) === first,
      )
    : undefined;
  const dateField = (
    label: string,
    value: string,
    onChange: (value: string) => void,
  ) => (
    <div className="subscription-field">
      <label>
        {label}
        <input
          required
          type="date"
          value={value}
          onChange={(event) => edit(() => onChange(event.target.value))}
        />
      </label>
      {!validDate(value) && (
        <p className="subscription-warning">Enter a complete date.</p>
      )}
    </div>
  );
  return (
    <form
      className="account-form subscription-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (!firstBoundary) return;
        const body = {
          ...choice,
          periodAnchorDate,
          dueAnchorDate,
          firstUnbilledPeriodIndex: firstBoundary.periodIndex,
        };
        create.mutate({ ...body, requestId: requestId.get(body) });
      }}
    >
      <fieldset disabled={locked}>
        <ChoiceFields
          choices={options.choices}
          value={choice}
          onChange={(value) => edit(() => setChoice(value))}
          fields={dimensions}
        />
        <p className="account-note">
          {choice.serviceId ? (
            <>
              Linked to{" "}
              <ServiceRelationship {...scope} serviceId={choice.serviceId} />.
            </>
          ) : (
            "Not linked to a service."
          )}
        </p>
        {choice.paymentArrangement === "automatic" && automaticNote}
        <div className="subscription-choice">
          {dateField(
            "Service periods repeat from",
            periodAnchorDate,
            setPeriodAnchorDate,
          )}
          {dateField("Due dates repeat from", dueAnchorDate, setDueAnchorDate)}
        </div>
        <p className="account-note">
          Times use {options.calendar.timeZone}: issue at{" "}
          {hour(options.calendar.issueHour)}, charge at{" "}
          {hour(options.calendar.chargeHour)}.
        </p>
        <p className="account-note">
          Find the first unbilled period by its due date. Search up to 36 months
          without changing the original repeat dates.
        </p>
        <div className="subscription-choice">
          {dateField("First unbilled due from", fromDueDate, setFromDueDate)}
          {dateField(
            "First unbilled due through",
            throughDueDate,
            setThroughDueDate,
          )}
        </div>
        {validDate(fromDueDate) &&
          validDate(throughDueDate) &&
          fromDueDate > throughDueDate && (
            <p className="subscription-warning" role="alert">
              The search end must be on or after its start.
            </p>
          )}
        <div className="subscription-field">
          <BoundarySelect
            boundaries={periodsReady ? (boundaries.data?.boundaries ?? []) : []}
            value={first}
            onChange={(value) => {
              requestId.reset();
              create.reset();
              setFirst(value);
            }}
            disabled={locked || !periodsReady || boundaries.isFetching}
            label="First unbilled period"
          />
          {anchorsValid && windowValid && boundaries.isFetching && (
            <p className="account-note" role="status">
              Loading service periods…
            </p>
          )}
          {anchorsValid && windowValid && boundaries.isError && (
            <p className="subscription-warning" role="alert">
              {boundaries.error instanceof AccountError &&
              boundaries.error.status === 422
                ? "Keep the original repeat dates within one billing period of each other. Search up to 36 months, ending within the next 36 months."
                : boundaries.error.message}
            </p>
          )}
          {periodsReady &&
            !boundaries.isFetching &&
            boundaries.data?.boundaries.length === 0 && (
              <p className="account-note">
                No service periods are due in this window. Adjust the search
                dates.
              </p>
            )}
          <p className="account-note">
            Earlier periods stay with the previous billing system. Choosing this
            does not mark them paid.
          </p>
        </div>
      </fieldset>
      <div className="account-actions">
        <button
          className="account-primary-button"
          disabled={locked || !firstBoundary || boundaries.isFetching}
        >
          Create subscription
        </button>
      </div>
      <MutationFeedback error={create.error} reload={reload} />
    </form>
  );
}
function BoundaryDates({
  boundary,
  fallback,
}: {
  boundary?: Boundary;
  fallback: string;
}) {
  return (
    <span>
      {boundary ? range(boundary.periodStart, boundary.periodEnd) : fallback}
      {boundary && (
        <span className="subscription-support">
          Due {date(boundary.dueDate)}
        </span>
      )}
    </span>
  );
}
const hour = (value: number) => `${String(value).padStart(2, "0")}:00`;

function Agreement(scope: Scope & { subscriptionId: string }) {
  const client = useQueryClient();
  const [saved, setSaved] = useState(false);
  const [generation, setGeneration] = useState(0);
  const path = `${customerPath(scope.customerId)}/subscriptions/${encodeURIComponent(scope.subscriptionId)}`;
  const detail = useQuery({
    queryKey: [
      "subscription",
      scope.userId,
      scope.customerId,
      scope.subscriptionId,
    ],
    queryFn: ({ signal }) => request<SubscriptionResponse>(path, { signal }),
    retry: false,
  });
  const options = useQuery({
    queryKey: ["subscription-options", scope.userId, scope.customerId],
    enabled: scope.billingStaff,
    queryFn: ({ signal }) =>
      request<SubscriptionOptionsResponse>(
        `${customerPath(scope.customerId)}/subscription-options`,
        { signal },
      ),
    retry: false,
  });
  const reload = async () => {
    const results = await Promise.all([
      detail.refetch(),
      ...(scope.billingStaff ? [options.refetch()] : []),
    ]);
    if (results.every((result) => !result.isError))
      setGeneration((value) => value + 1);
  };
  const subscription = detail.isError ? undefined : detail.data?.subscription;
  return (
    <>
      <Header
        back={
          <Link
            className="account-back"
            to="/customers/$customerId/subscriptions"
            params={{ customerId: scope.customerId }}
          >
            Subscriptions
          </Link>
        }
        title={subscription?.label ?? "Subscription"}
      />
      {detail.isPending && <p role="status">Loading subscription…</p>}
      {detail.isError && (
        <p className="panel state-panel" role="alert">
          {detail.error instanceof AccountError && detail.error.status === 404
            ? "This subscription is unavailable."
            : detail.error.message}
        </p>
      )}
      {subscription && (
        <Changes
          key={`${generation}:${subscription.version}`}
          {...scope}
          subscription={subscription}
          options={options.isError ? undefined : options.data}
          optionsError={
            scope.billingStaff && options.isError ? options.error : null
          }
          saved={saved}
          reload={() => void reload()}
          accept={(result) => {
            client.setQueryData(
              [
                "subscription",
                scope.userId,
                scope.customerId,
                scope.subscriptionId,
              ],
              { subscription: result.subscription },
            );
            void client.invalidateQueries({
              queryKey: ["billing-forecast", scope.userId, scope.customerId],
            });
            setSaved(true);
            setGeneration((value) => value + 1);
          }}
        />
      )}
      <Forecast {...scope} />
    </>
  );
}
const changeKinds = {
  terms: "Change price or payment",
  pause_billing: "Pause billing",
  resume_billing: "Resume billing",
  request_cancellation: "Request cancellation",
  decide_cancellation: "Decide cancellation",
} as const;
type ChangeKind = keyof typeof changeKinds;
const cancellationStatus = {
  none: "Not requested",
  requested: "Requested",
  declined: "Declined",
  approved: "Approved",
} as const;

function Facts({
  subscription,
  customerId,
  userId,
}: {
  subscription: SubscriptionResponse["subscription"];
  customerId: string;
  userId: string;
}) {
  return (
    <dl className="subscription-facts">
      <div>
        <dt>Price</dt>
        <dd>{price(subscription.amountMinor, subscription.intervalMonths)}</dd>
      </div>
      <div>
        <dt>Payment arrangement</dt>
        <dd>{arrangement(subscription.paymentArrangement)}</dd>
      </div>
      <div>
        <dt>Billing</dt>
        <dd>{states[subscription.billingState]}</dd>
      </div>
      <div>
        <dt>Next renewal</dt>
        <dd>
          {subscription.nextRenewal
            ? date(subscription.nextRenewal)
            : "None scheduled"}
        </dd>
      </div>
      <div>
        <dt>Service</dt>
        <dd>
          <ServiceRelationship
            customerId={customerId}
            serviceId={subscription.serviceId}
            userId={userId}
          />
        </dd>
      </div>
      <div>
        <dt>Cancellation</dt>
        <dd>
          {cancellationStatus[subscription.cancellation.status]}
          {subscription.cancellation.reason && (
            <span className="subscription-support">
              {subscription.cancellation.reason}
            </span>
          )}
        </dd>
      </div>
      <div>
        <dt>First unbilled period</dt>
        <dd>
          {range(
            subscription.firstUnbilled.periodStart,
            subscription.firstUnbilled.periodEnd,
          )}
          <span className="subscription-support">
            Due {date(subscription.firstUnbilled.dueDate)}
          </span>
        </dd>
      </div>
      <div>
        <dt>Service periods repeat from</dt>
        <dd>{date(subscription.periodAnchorDate)}</dd>
      </div>
      <div>
        <dt>Due dates repeat from</dt>
        <dd>{date(subscription.dueAnchorDate)}</dd>
      </div>
      <div>
        <dt>Timezone</dt>
        <dd>
          {subscription.calendar.timeZone}
          <span className="subscription-support">
            Issue at {hour(subscription.calendar.issueHour)}, charge at{" "}
            {hour(subscription.calendar.chargeHour)}
          </span>
        </dd>
      </div>
    </dl>
  );
}
function Changes({
  subscription,
  options,
  optionsError,
  saved,
  reload,
  accept,
  ...scope
}: Scope & {
  subscription: SubscriptionResponse["subscription"];
  options?: SubscriptionOptionsResponse;
  optionsError: Error | null;
  saved: boolean;
  reload: () => void;
  accept: (result: ChangeSubscriptionResponse) => void;
}) {
  const from = today(subscription.calendar.timeZone);
  const boundaries = useBoundaries(scope, {
    periodAnchorDate: subscription.periodAnchorDate,
    dueAnchorDate: subscription.dueAnchorDate,
    intervalMonths: subscription.intervalMonths,
    fromDueDate: from,
    throughDueDate: monthsAfter(from, 36),
  });
  const choices =
    options?.choices.filter(
      (choice) =>
        choice.serviceId === subscription.serviceId &&
        choice.intervalMonths === subscription.intervalMonths,
    ) ?? [];
  const [kind, setKind] = useState<ChangeKind>("terms");
  const [effective, setEffective] = useState("");
  const [chosen, setSelected] = useState<Choice>();
  const selected =
    chosen ??
    choices.find(
      (choice) =>
        choice.label === subscription.label &&
        choice.amountMinor === subscription.amountMinor &&
        choice.paymentArrangement === subscription.paymentArrangement,
    ) ??
    choices[0];
  const [reason, setReason] = useState("");
  const [decision, setDecision] = useState("decline");
  const requestId = useRequestId();
  const update = useMutation({
    mutationFn: (input: ChangeSubscriptionRequest) =>
      command<ChangeSubscriptionResponse>(
        `${customerPath(scope.customerId)}/subscriptions/${encodeURIComponent(subscription.id)}`,
        input,
        "PATCH",
      ),
    retry: false,
    onSuccess: accept,
  });
  const edit = (action: () => void) => {
    requestId.reset();
    update.reset();
    action();
  };
  const loaded = boundaries.isError ? [] : (boundaries.data?.boundaries ?? []);
  const describeBoundary = (index: number) => {
    const boundary = loaded.find((value) => value.periodIndex === index);
    if (boundary) return boundaryLabel(boundary);
    return loaded[0] && index < loaded[0].periodIndex
      ? "An earlier service period"
      : "Outside the available date window";
  };
  const barrier = subscription.cancellation.effectivePeriodIndex;
  const future = loaded.filter(
    (boundary) =>
      boundary.periodStart > from &&
      boundary.periodIndex >= subscription.firstUnbilledPeriodIndex &&
      (barrier === null || boundary.periodIndex < barrier),
  );
  const selectedBoundary = future.find(
    (boundary) => String(boundary.periodIndex) === effective,
  );
  const requiresBoundary =
    kind !== "request_cancellation" &&
    !(kind === "decide_cancellation" && decision === "decline");
  const locked = update.isPending || conflictError(update.error);
  const terminal = subscription.cancellation.status === "approved";
  /** Terms already in force at a period: current terms, then scheduled revisions. */
  const termsAt = (index: number) =>
    subscription.upcomingChanges.reduce<{
      label: string;
      amountMinor: number;
      paymentArrangement: string;
    }>(
      (terms, value) =>
        value.kind === "commercial" && value.effectivePeriodIndex <= index
          ? value
          : terms,
      subscription,
    );
  const inForce = selectedBoundary && termsAt(selectedBoundary.periodIndex);
  const unchangedTerms =
    kind === "terms" &&
    selected !== undefined &&
    inForce?.label === selected.label &&
    inForce.amountMinor === selected.amountMinor &&
    inForce.paymentArrangement === selected.paymentArrangement;
  const laterStates = subscription.upcomingChanges.flatMap((value) =>
    value.kind === "state" &&
    selectedBoundary &&
    value.effectivePeriodIndex > selectedBoundary.periodIndex
      ? [value]
      : [],
  );
  let change: ChangeSubscriptionRequest["change"] | undefined;
  if (kind === "terms" && selected && selectedBoundary && !unchangedTerms)
    change = {
      kind: "terms",
      effectivePeriodIndex: selectedBoundary.periodIndex,
      label: selected.label,
      amountMinor: selected.amountMinor,
      paymentArrangement: selected.paymentArrangement,
    };
  if (
    (kind === "pause_billing" || kind === "resume_billing") &&
    selectedBoundary
  )
    change = { kind, effectivePeriodIndex: selectedBoundary.periodIndex };
  if (kind === "request_cancellation" && reason.trim())
    change = { kind, reason };
  if (kind === "decide_cancellation" && reason.trim()) {
    if (decision === "decline") change = { kind, decision: "decline", reason };
    else if (selectedBoundary)
      change = {
        kind,
        decision: "approve",
        reason,
        effectivePeriodIndex: selectedBoundary.periodIndex,
      };
  }
  const grouped = new Map<number, typeof subscription.upcomingChanges>();
  for (const value of subscription.upcomingChanges)
    grouped.set(value.effectivePeriodIndex, [
      ...(grouped.get(value.effectivePeriodIndex) ?? []),
      value,
    ]);
  const stateChange = (value: BillingState, index: number) =>
    value === "billable"
      ? index === subscription.firstUnbilledPeriodIndex
        ? "Billing starts"
        : "Billing resumes"
      : value === "paused"
        ? "Billing paused"
        : "Billing cancelled";
  const startOf = (index: number) => {
    const boundary = loaded.find((value) => value.periodIndex === index);
    return boundary ? date(boundary.periodStart) : describeBoundary(index);
  };
  return (
    <>
      <section className="panel account-section" aria-label="Terms">
        <Facts {...scope} subscription={subscription} />
        {terminal && (
          <p className="subscription-review">
            Cancellation approved. Billing stops from{" "}
            {barrier === null ? "the approved period" : startOf(barrier)}. Later
            price changes or scheduled resumes cannot restart it.
          </p>
        )}
        <div className="subscription-upcoming">
          <h2>Upcoming changes</h2>
          {grouped.size === 0 ? (
            <p className="account-note">No future changes scheduled.</p>
          ) : (
            <ul className="subscription-schedule">
              {[...grouped].map(([index, values]) => (
                <li key={index}>
                  <BoundaryDates
                    boundary={loaded.find(
                      (value) => value.periodIndex === index,
                    )}
                    fallback={describeBoundary(index)}
                  />
                  <ul className="subscription-what">
                    {values.map((value) => (
                      <li key={value.revision}>
                        {value.kind === "commercial"
                          ? `${value.label}, ${price(value.amountMinor, subscription.intervalMonths)}, ${arrangement(value.paymentArrangement).toLowerCase()} payment`
                          : stateChange(value.billingState, index)}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
          {subscription.changesTruncated && (
            <p className="subscription-warning" role="alert">
              More upcoming changes exist than are shown. Review the full
              subscription history before changing it.
            </p>
          )}
          {boundaries.isError && (
            <p className="subscription-warning" role="alert">
              Dates for upcoming changes are unavailable:{" "}
              {boundaries.error.message}
            </p>
          )}
        </div>
        {saved && <p role="status">Changes saved.</p>}
      </section>
      {scope.billingStaff && subscription.canManage && !terminal && (
        <section className="panel account-section">
          <h2>Change subscription</h2>
          {optionsError && <p role="alert">{optionsError.message}</p>}
          <form
            className="account-form subscription-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (!change) return;
              const input = { expectedVersion: subscription.version, change };
              update.mutate({ ...input, requestId: requestId.get(input) });
            }}
          >
            <fieldset disabled={locked}>
              <label>
                Change type
                <select
                  value={kind}
                  onChange={(event) =>
                    edit(() => {
                      setKind(event.target.value as ChangeKind);
                      setEffective("");
                    })
                  }
                >
                  {Object.entries(changeKinds)
                    .filter(
                      ([value]) =>
                        value !== "decide_cancellation" ||
                        subscription.cancellation.status === "requested",
                    )
                    .map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                </select>
              </label>
              {kind === "terms" && selected && (
                <>
                  <ChoiceFields
                    choices={choices}
                    value={selected}
                    onChange={(value) => edit(() => setSelected(value))}
                    fields={dimensions.filter(
                      (dimension) =>
                        dimension === "amount" ||
                        dimension === "arrangement" ||
                        available(choices, selected, dimension).length > 1,
                    )}
                  />
                  {selected.paymentArrangement === "automatic" && automaticNote}
                </>
              )}
              {kind === "decide_cancellation" && (
                <label>
                  Decision
                  <select
                    value={decision}
                    onChange={(event) =>
                      edit(() => setDecision(event.target.value))
                    }
                  >
                    <option value="decline">Decline</option>
                    <option value="approve">Approve</option>
                  </select>
                </label>
              )}
              {(kind === "request_cancellation" ||
                kind === "decide_cancellation") && (
                <label>
                  Reason
                  <select
                    required
                    value={reason}
                    onChange={(event) =>
                      edit(() => setReason(event.target.value))
                    }
                  >
                    <option value="">Choose a reason</option>
                    {options?.cancellationReasons.map((value) => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {requiresBoundary && (
                <div className="subscription-field">
                  <BoundarySelect
                    label="Effective service period"
                    boundaries={future}
                    value={effective}
                    onChange={(value) => edit(() => setEffective(value))}
                    disabled={locked || boundaries.isFetching}
                  />
                  {kind === "terms" && (
                    <p
                      className={
                        unchangedTerms ? "subscription-warning" : "account-note"
                      }
                    >
                      {unchangedTerms
                        ? "These terms already apply from this period."
                        : "Earlier periods keep their terms. There is no proration."}
                    </p>
                  )}
                  {kind === "pause_billing" && (
                    <p className="subscription-warning">
                      Paused periods are not billed later.{" "}
                      {laterStates.length > 0
                        ? `Already scheduled: ${laterStates
                            .map(
                              (value) =>
                                `${stateChange(value.billingState, value.effectivePeriodIndex).toLowerCase()} from ${startOf(value.effectivePeriodIndex)}`,
                            )
                            .join("; ")}.`
                        : selectedBoundary &&
                          "Billing stays paused until a resume is scheduled."}
                    </p>
                  )}
                  {kind === "resume_billing" && (
                    <p className="account-note">
                      Billing resumes from this period. Paused periods are not
                      billed later.
                    </p>
                  )}
                  {kind === "decide_cancellation" && decision === "approve" && (
                    <p className="subscription-warning">
                      Approval stops billing from this period permanently,
                      including any scheduled resume.
                    </p>
                  )}
                </div>
              )}
              {kind === "request_cancellation" && (
                <p className="account-note">
                  A request alone does not stop billing. Billing staff record a
                  decision separately.
                </p>
              )}
            </fieldset>
            <div className="account-actions">
              <button
                className="account-primary-button"
                disabled={
                  locked ||
                  !change ||
                  (requiresBoundary && boundaries.isFetching) ||
                  subscription.changesTruncated
                }
              >
                Save changes
              </button>
            </div>
            <MutationFeedback error={update.error} reload={reload} />
          </form>
        </section>
      )}
    </>
  );
}
const reviewReasons: Record<
  ForecastResponse["groups"][number]["reviewReasons"][number],
  string
> = {
  not_materialized: "Some periods for this due date are not recorded yet.",
  negative_amount:
    "Includes a negative amount. No credit is applied; staff review is required.",
  unsupported_total: "The total is outside supported invoice amounts.",
  too_many_lines: "There are more lines than one invoice supports.",
  past_due: "The due date has passed.",
  invalid_local_time:
    "A recorded time is missing or ambiguous in this timezone.",
  calendar_mismatch: "Subscriptions in this group use different calendars.",
  overlapping_agreement:
    "Another billable subscription covers the same service for overlapping dates.",
};
const outcomes: Record<ForecastResponse["groups"][number]["outcome"], string> =
  {
    billable: "Billable",
    no_charge: "No charge",
    needs_review: "Needs review",
    inactive: "Inactive",
  };
function Forecast(scope: Scope) {
  const client = useQueryClient();
  const search = useSearch({ strict: false });
  const navigate = useNavigate();
  const [initialWindow] = useState(() => {
    const fromDueDate = today();
    return { fromDueDate, throughDueDate: monthsAfter(fromDueDate, 4) };
  });
  const fromDueDate = search.fromDueDate ?? initialWindow.fromDueDate;
  const throughDueDate = search.throughDueDate ?? initialWindow.throughDueDate;
  const window = { fromDueDate, throughDueDate };
  const offset = search.forecastOffset ?? 0;
  const [from, setFrom] = useState(fromDueDate);
  const [through, setThrough] = useState(throughDueDate);
  useEffect(() => {
    setFrom(fromDueDate);
    setThrough(throughDueDate);
  }, [fromDueDate, throughDueDate, offset]);
  const show = (dates: typeof window, forecastOffset: number) =>
    void navigate({
      to: ".",
      search: { ...dates, forecastOffset },
      resetScroll: false,
    });
  const requestId = useRequestId();
  const path = `${customerPath(scope.customerId)}/billing-forecast`;
  const key = ["billing-forecast", scope.userId, scope.customerId];
  const forecast = useQuery({
    queryKey: [...key, window, offset],
    queryFn: ({ signal }) =>
      request<ForecastResponse>(
        `${path}?${parameters({ ...window, limit: pageSize, offset })}`,
        { signal },
      ),
    retry: false,
  });
  const generate = useMutation({
    mutationFn: (body: MaterializeForecastRequest) =>
      command<MaterializeForecastResponse>(path, body),
    retry: false,
    onSuccess: () => {
      requestId.reset();
      void client.invalidateQueries({ queryKey: key });
    },
  });
  const reload = async () => {
    const result = await forecast.refetch();
    if (!result.isError) {
      requestId.reset();
      generate.reset();
    }
  };
  const edit = (action: () => void) => {
    requestId.reset();
    generate.reset();
    action();
  };
  const locked = generate.isPending || conflictError(generate.error);
  const validWindow = validDate(from) && validDate(through) && from <= through;
  const pendingInputs =
    from !== window.fromDueDate || through !== window.throughDueDate;
  const data = forecast.isError ? undefined : forecast.data;
  const zones = new Set(
    data?.groups.flatMap((group) =>
      group.periods.map((period) => period.calendar.timeZone),
    ),
  );
  return (
    <section className="panel account-section subscription-forecast">
      <h2>Billing forecast</h2>
      <p className="account-note">
        A forecast does not issue invoices, set an account balance or authorize
        automatic payment.
        {zones.size === 1 && ` Dates use ${[...zones][0]}.`}
      </p>
      <form
        className="account-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!validWindow) return;
          edit(() => {
            show({ fromDueDate: from, throughDueDate: through }, 0);
          });
        }}
      >
        <fieldset disabled={locked} className="subscription-window">
          <label>
            Due from
            <input
              required
              type="date"
              value={from}
              onChange={(event) => edit(() => setFrom(event.target.value))}
            />
          </label>
          <label>
            Due through
            <input
              required
              type="date"
              min={from}
              value={through}
              onChange={(event) => edit(() => setThrough(event.target.value))}
            />
          </label>
          <button className="secondary-button" disabled={!validWindow}>
            Show forecast
          </button>
          {scope.billingStaff && (
            <button
              type="button"
              className="account-primary-button"
              disabled={pendingInputs || forecast.isError || forecast.isPending}
              onClick={() =>
                generate.mutate({ ...window, requestId: requestId.get(window) })
              }
            >
              {generate.isPending ? "Updating forecast…" : "Update forecast"}
            </button>
          )}
        </fieldset>
        {pendingInputs && (
          <p className="account-note">
            Showing due dates {date(window.fromDueDate)} to{" "}
            {date(window.throughDueDate)}.
            {scope.billingStaff &&
              " Show the forecast for the new dates before updating it."}
          </p>
        )}
      </form>
      <MutationFeedback
        error={generate.error}
        reload={() => void reload()}
        success={
          generate.isSuccess
            ? generate.data.outcome === "changed"
              ? "Forecast updated."
              : "Forecast already up to date."
            : undefined
        }
      />
      {forecast.isPending && <p role="status">Loading forecast…</p>}
      {forecast.isError && <p role="alert">{forecast.error.message}</p>}
      {data && (
        <>
          {!data.complete && (
            <p className="subscription-review" role="alert">
              Incomplete forecast: some expected service periods are not
              recorded yet. Missing periods do not mean nothing is owed.{" "}
              {scope.billingStaff
                ? "Update forecast to record them."
                : "Billing staff can update it."}
            </p>
          )}
          {data.groups.length === 0 && (
            <p className="account-note">
              {data.total === 0
                ? "No forecast groups in this date window."
                : "No forecast groups on this page."}
            </p>
          )}
          <ol className="subscription-groups">
            {data.groups.map((group) => (
              <li
                className="subscription-group"
                key={`${group.dueDate}:${group.paymentArrangement}`}
              >
                <div className="subscription-group-head">
                  <h3>Due {date(group.dueDate)}</h3>
                  <span className="account-note">
                    {arrangement(group.paymentArrangement)} payment
                  </span>
                  <span className="subscription-amount">
                    {money(group.totalMinor, group.currency)}
                  </span>
                  <span
                    className={`status-tag subscription-outcome-${group.outcome}`}
                  >
                    {outcomes[group.outcome]}
                  </span>
                </div>
                {group.outcome === "no_charge" && (
                  <p className="account-note">
                    Provisional. Future terms can change it.
                  </p>
                )}
                {group.reviewReasons.length > 0 && (
                  <ul className="subscription-review">
                    {group.reviewReasons.map((reason) => (
                      <li key={reason}>{reviewReasons[reason]}</li>
                    ))}
                  </ul>
                )}
                <ul className="subscription-lines">
                  {group.periods.map((period) => (
                    <li key={`${period.subscriptionId}:${period.periodIndex}`}>
                      <span>
                        {period.label}
                        {period.serviceId && (
                          <span className="subscription-support">
                            <ServiceRelationship
                              {...scope}
                              serviceId={period.serviceId}
                            />
                          </span>
                        )}
                      </span>
                      <span className="subscription-support">
                        Service {range(period.periodStart, period.periodEnd)}
                        {zones.size > 1 && `, ${period.calendar.timeZone}`}
                        {period.id === null && (
                          <span className="subscription-flag">
                            Not recorded yet
                          </span>
                        )}
                      </span>
                      <span className="subscription-amount">
                        {period.billingState === "billable"
                          ? period.amountMinor === 0
                            ? "Free"
                            : money(period.amountMinor, "USD")
                          : `${states[period.billingState]}, not billed`}
                      </span>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ol>
          <Pages
            offset={offset}
            total={data.total}
            onChange={(offset) => show(window, offset)}
          />
        </>
      )}
    </section>
  );
}
