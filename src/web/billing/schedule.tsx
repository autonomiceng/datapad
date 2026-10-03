import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import type {
  ConfigureScheduleRequest,
  ConfigureScheduleResponse,
  ScheduleResponse,
  ScheduledGroup,
  ScheduledGroupsResponse,
  ScheduleReviewReason,
} from "../../billing/scheduled-contract";
import type {
  SubscriptionBoundariesResponse,
  SubscriptionResponse,
  SubscriptionsResponse,
} from "../../billing/subscriptions-contract";
import {
  AccountError,
  command,
  request,
  useRequestId,
  useSession,
} from "../accounts/api";
import { date, dateRange, invoiceStateLabels, money } from "./format";
import "./invoices.css";
import "./schedule.css";

const pageSize = 50;
type Scope = { customerId: string; userId: string; billingStaff: boolean };
const dateTime = (value: string, timeZone: string) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
const parameters = (values: object) =>
  new URLSearchParams(
    Object.entries(values).map(([key, value]) => [key, String(value)]),
  ).toString();
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
function daysAfter(value: string, days: number) {
  const result = new Date(`${value}T00:00:00Z`);
  result.setUTCDate(result.getUTCDate() + days);
  return result.toISOString().slice(0, 10);
}
function monthsAfter(value: string, months: number) {
  const result = new Date(`${value}T00:00:00Z`);
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const last = new Date(result);
  last.setUTCMonth(last.getUTCMonth() + 1);
  last.setUTCDate(0);
  result.setUTCDate(Math.min(day, last.getUTCDate()));
  return result.toISOString().slice(0, 10);
}
function windowError(from: string, through: string) {
  const valid = (value: string) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    return (
      /^\d{4}-\d{2}-\d{2}$/.test(value) &&
      Number.isFinite(parsed.getTime()) &&
      parsed.toISOString().startsWith(value)
    );
  };
  if (!valid(from) || !valid(through)) return "Enter a complete date.";
  if (through < from) return "The end date must be on or after the start date.";
  if (through > monthsAfter(from, 36))
    return "Search up to 36 months at a time.";
  return null;
}
const conflictError = (error: Error | null) =>
  error instanceof AccountError && error.status === 409;
const errorMessage = (error: Error) =>
  error instanceof AccountError && error.status === 503
    ? "Scheduling unavailable. Try again when billing is configured and available."
    : error instanceof AccountError && error.status === 422
      ? "These choices cannot be accepted. Review the subscription details, first unbilled period and future invoice timing."
      : error.message;
const reasons: Record<ScheduleReviewReason, string> = {
  negative_amount: "Amount: a negative line needs review.",
  unsupported_total: "Total: outside the supported invoice range.",
  too_many_lines: "Lines: too many for one invoice.",
  past_due:
    "Due date: passed before an invoice could be requested. The schedule does not catch up missed dates.",
  invalid_local_time:
    "Invoice time: ambiguous or unavailable in this timezone.",
  calendar_mismatch:
    "Calendar: agreements have incompatible timezones or hours.",
  overlapping_agreement:
    "Service period: overlaps another positive agreement for the same service.",
  provider_profile_pending:
    "Bill to: payment account details need review before invoicing.",
  ownership_mismatch:
    "Bill to: payment account ownership could not be verified.",
  issuance_paused: "Issue date: scheduled invoices are paused.",
  late_period:
    "Service period: arrived after this due date's group was fixed. It cannot join that group.",
  multiple_candidates:
    "Due date: several periods are ready for the same agreement. Review required.",
};
const kinds: Record<
  Exclude<ScheduledGroup["kind"], "sealed" | "upcoming">,
  string
> = {
  excluded: "Excluded",
  review: "Needs review",
  missed: "Missed",
  late: "Late period",
};
const cadence = (months: number) =>
  months === 1
    ? "monthly"
    : months === 12
      ? "yearly"
      : `every ${months} months`;

export function BillingSchedulePage({ customerId }: { customerId: string }) {
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
  return (
    <div className="account-page schedule-page">
      <header className="account-page-header">
        <Link
          className="account-back"
          to="/customers/$customerId"
          params={{ customerId }}
        >
          Customer account
        </Link>
        <h1>Invoice schedule</h1>
      </header>
      <Schedule
        key={`${session.data.user.id}:${customerId}`}
        customerId={customerId}
        userId={session.data.user.id}
        billingStaff={session.data.staffRoles.includes("billing")}
      />
    </div>
  );
}

function Schedule(scope: Scope) {
  const path = `/api/customers/${encodeURIComponent(scope.customerId)}`;
  const queryClient = useQueryClient();
  const key = ["billing-schedule", scope.userId, scope.customerId];
  const [generation, setGeneration] = useState(0);
  const schedule = useQuery({
    queryKey: key,
    queryFn: ({ signal }) =>
      request<ScheduleResponse>(`${path}/billing-schedule`, { signal }),
    retry: false,
  });
  const subscriptions = useQuery({
    queryKey: ["schedule-subscriptions", scope.userId, scope.customerId],
    enabled: Boolean(schedule.data) && !schedule.isError,
    queryFn: ({ signal }) =>
      request<SubscriptionsResponse>(
        `${path}/subscriptions?limit=100&offset=0`,
        { signal },
      ),
    retry: false,
  });
  const reload = async () => {
    await queryClient.invalidateQueries({ queryKey: ["access-session"] });
    const results = await Promise.all([
      schedule.refetch(),
      subscriptions.refetch(),
    ]);
    if (results.every((result) => !result.isError))
      setGeneration((value) => value + 1);
  };
  if (schedule.isPending)
    return (
      <p className="panel state-panel" role="status">
        Loading invoice schedule…
      </p>
    );
  if (schedule.isError)
    return (
      <section className="panel account-section">
        <p role="alert">{errorMessage(schedule.error)}</p>
        <div className="account-actions">
          <button
            className="secondary-button"
            onClick={() => void schedule.refetch()}
          >
            Reload schedule
          </button>
        </div>
      </section>
    );
  return (
    <>
      <History {...scope} path={path} />
      <Configuration
        key={generation}
        {...scope}
        path={path}
        schedule={schedule.data.schedule}
        subscriptions={subscriptions.data?.subscriptions ?? []}
        subscriptionsReady={subscriptions.isSuccess}
        subscriptionsError={subscriptions.error}
        reload={reload}
        onConfigured={async (result) => {
          queryClient.setQueryData(key, { schedule: result.schedule });
          await Promise.all([
            queryClient.invalidateQueries({
              queryKey: [
                "schedule-subscriptions",
                scope.userId,
                scope.customerId,
              ],
            }),
            queryClient.invalidateQueries({
              queryKey: ["scheduled-groups", scope.userId, scope.customerId],
            }),
            queryClient.invalidateQueries({
              queryKey: ["subscriptions", scope.userId, scope.customerId],
            }),
          ]);
        }}
      />
    </>
  );
}

function Configuration({
  schedule,
  subscriptions,
  subscriptionsReady,
  subscriptionsError,
  path,
  reload,
  onConfigured,
  ...scope
}: Scope & {
  schedule: ScheduleResponse["schedule"];
  subscriptions: SubscriptionsResponse["subscriptions"];
  subscriptionsReady: boolean;
  subscriptionsError: Error | null;
  path: string;
  reload: () => Promise<void>;
  onConfigured: (result: ConfigureScheduleResponse) => Promise<void>;
}) {
  const requestId = useRequestId();
  const [selectedId, setSelectedId] = useState("");
  const [success, setSuccess] = useState("");
  const canManage = scope.billingStaff && schedule.canManage;
  const configure = useMutation({
    mutationFn: (change: ConfigureScheduleRequest["change"]) => {
      const input = { expectedVersion: schedule.version, change };
      return command<ConfigureScheduleResponse>(`${path}/billing-schedule`, {
        ...input,
        requestId: requestId.get(input),
      });
    },
    retry: false,
    onSuccess: async (result, change) => {
      setSuccess(
        change.kind === "activate"
          ? "Subscription added to schedule."
          : result.schedule.issuancePaused
            ? "Scheduled invoices paused."
            : "Scheduled invoices resumed.",
      );
      setSelectedId("");
      await onConfigured(result);
    },
  });
  const locked = configure.isPending || conflictError(configure.error);
  const available = subscriptions.filter(
    (subscription) =>
      !schedule.activations.some(
        (activation) => activation.subscriptionId === subscription.id,
      ),
  );
  const changed = configure.variables?.kind;
  const feedback = (
    <>
      {success && <p role="status">{success}</p>}
      {configure.error && (
        <p role="alert">
          {conflictError(configure.error)
            ? "This schedule or subscription changed. Reload and review before trying again."
            : errorMessage(configure.error)}
        </p>
      )}
      {conflictError(configure.error) && (
        <div className="account-actions">
          <button className="secondary-button" onClick={() => void reload()}>
            Reload and review
          </button>
        </div>
      )}
    </>
  );
  return (
    <>
      <section className="panel account-section">
        <h2>Subscriptions on this schedule</h2>
        {schedule.activations.length === 0 ? (
          <p className="account-note">No subscriptions on this schedule yet.</p>
        ) : (
          <ul className="schedule-list">
            {schedule.activations.map((activation) => (
              <li key={activation.subscriptionId}>
                <span>
                  <Link
                    to="/customers/$customerId/subscriptions/$subscriptionId"
                    params={{
                      customerId: scope.customerId,
                      subscriptionId: activation.subscriptionId,
                    }}
                  >
                    {subscriptions.find(
                      (subscription) =>
                        subscription.id === activation.subscriptionId,
                    )?.label ?? "Subscription"}
                  </Link>
                  {canManage && (
                    <span className="schedule-support">
                      Added {dateTime(activation.activatedAt, "UTC")} UTC
                    </span>
                  )}
                </span>
                <dl className="schedule-facts">
                  <div>
                    <dt>First activated service period</dt>
                    <dd>
                      {dateRange(
                        activation.firstPeriod.periodStart,
                        activation.firstPeriod.periodEnd,
                      )}
                      <span className="schedule-support">
                        Due {date(activation.firstPeriod.dueDate)}
                      </span>
                    </dd>
                  </div>
                  {activation.beforeActivation && (
                    <div>
                      <dt>Before activation</dt>
                      <dd>
                        {dateRange(
                          activation.beforeActivation.periodStart,
                          activation.beforeActivation.periodEnd,
                        )}
                        <span className="schedule-support">
                          Outside this schedule
                        </span>
                      </dd>
                    </div>
                  )}
                </dl>
              </li>
            ))}
          </ul>
        )}
        {canManage && (
          <div className="schedule-add">
            {subscriptionsError && (
              <p role="alert">{subscriptionsError.message}</p>
            )}
            {!subscriptionsReady && !subscriptionsError && (
              <p role="status">Loading subscriptions…</p>
            )}
            {subscriptionsReady && available.length > 0 && (
              <div className="account-form">
                <fieldset disabled={locked}>
                  <label>
                    Subscription
                    <select
                      value={selectedId}
                      onChange={(event) => setSelectedId(event.target.value)}
                    >
                      <option value="">Choose a subscription to add</option>
                      {available.map((subscription) => (
                        <option key={subscription.id} value={subscription.id}>
                          {subscription.label},{" "}
                          {money(subscription.amountMinor, "USD")}{" "}
                          {cadence(subscription.intervalMonths)},{" "}
                          {subscription.paymentArrangement} payment,{" "}
                          {subscription.nextRenewal
                            ? `next due ${date(subscription.nextRenewal)}`
                            : "no upcoming due date"}
                        </option>
                      ))}
                    </select>
                  </label>
                </fieldset>
                {selectedId && (
                  <Activation
                    key={selectedId}
                    {...scope}
                    path={path}
                    subscriptionId={selectedId}
                    expectedVersion={
                      available.find(
                        (subscription) => subscription.id === selectedId,
                      )?.version
                    }
                    locked={locked}
                    activate={(change) => configure.mutate(change)}
                  />
                )}
              </div>
            )}
            {subscriptionsReady && available.length === 0 && (
              <p className="account-note">
                No additional subscriptions to add.
              </p>
            )}
            {changed === "activate" && feedback}
          </div>
        )}
      </section>
      {canManage && (
        <section className="panel account-section">
          <h2>Issuance hold</h2>
          <div className="account-actions">
            <button
              className="secondary-button"
              disabled={locked || schedule.version === 0}
              onClick={() =>
                configure.mutate({
                  kind: schedule.issuancePaused
                    ? "resume_issuance"
                    : "pause_issuance",
                })
              }
            >
              {configure.isPending && changed !== "activate"
                ? "Saving…"
                : schedule.issuancePaused
                  ? "Resume scheduled invoices"
                  : "Pause scheduled invoices"}
            </button>
          </div>
          <p className="account-note schedule-below">
            {schedule.version === 0
              ? "Available after a subscription is on this schedule."
              : schedule.issuancePaused
                ? "New invoice steps are paused. Previously attempted Stripe actions may recover; remaining steps wait until resumed. Resuming keeps each first activated service period. Missed due dates are not invoiced later."
                : "Pauses new invoice steps. Previously attempted Stripe actions may recover; remaining steps wait until resumed. Services and subscriptions stay unchanged."}
          </p>
          {changed && changed !== "activate" && feedback}
          {schedule.continuingTotal > 0 && (
            <div className="schedule-continuing">
              <p>
                {schedule.continuingTotal}{" "}
                {schedule.continuingTotal === 1
                  ? "invoice has previously attempted Stripe actions."
                  : "invoices have previously attempted Stripe actions."}
              </p>
              <ul className="schedule-list">
                {schedule.continuing.map((invoice) => (
                  <li key={invoice.invoiceId}>
                    <span>
                      <Link
                        to="/invoices"
                        search={{ invoiceId: invoice.invoiceId, offset: 0 }}
                      >
                        View continuing invoice
                      </Link>
                      <span className="schedule-support">
                        Started:{" "}
                        {[
                          invoice.customerCreateAttempted && "payment account",
                          invoice.invoiceCreateAttempted && "invoice creation",
                          invoice.finalizeAttempted && "finalization",
                        ]
                          .filter(Boolean)
                          .join(", ")}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
              {schedule.continuingTotal > schedule.continuing.length && (
                <p className="account-note">
                  Showing {schedule.continuing.length} of{" "}
                  {schedule.continuingTotal} continuing invoices.
                </p>
              )}
            </div>
          )}
        </section>
      )}
    </>
  );
}

function Activation({
  path,
  subscriptionId,
  expectedVersion,
  locked,
  activate,
  ...scope
}: Scope & {
  path: string;
  subscriptionId: string;
  expectedVersion: number | undefined;
  locked: boolean;
  activate: (change: ConfigureScheduleRequest["change"]) => void;
}) {
  const agreement = useQuery({
    queryKey: [
      "schedule-agreement",
      scope.userId,
      scope.customerId,
      subscriptionId,
      expectedVersion,
    ],
    queryFn: ({ signal }) =>
      request<SubscriptionResponse>(
        `${path}/subscriptions/${encodeURIComponent(subscriptionId)}`,
        { signal },
      ),
    retry: false,
  });
  if (agreement.isPending)
    return <p role="status">Loading first unbilled period…</p>;
  if (agreement.isError) return <p role="alert">{agreement.error.message}</p>;
  return (
    <ActivationPeriod
      key={`${subscriptionId}:${agreement.data.subscription.version}`}
      {...scope}
      path={path}
      subscription={agreement.data.subscription}
      locked={locked}
      activate={activate}
    />
  );
}

function ActivationPeriod({
  path,
  subscription,
  locked,
  activate,
  ...scope
}: Scope & {
  path: string;
  subscription: SubscriptionResponse["subscription"];
  locked: boolean;
  activate: (change: ConfigureScheduleRequest["change"]) => void;
}) {
  const [localToday] = useState(() => today(subscription.calendar.timeZone));
  const maximum = monthsAfter(localToday, 36);
  const [fromDueDate, setFrom] = useState(() => daysAfter(localToday, 22));
  const [throughDueDate, setThrough] = useState(maximum);
  const [selected, setSelected] = useState("");
  const problem =
    windowError(fromDueDate, throughDueDate) ??
    (throughDueDate > maximum
      ? "Choose due dates within 36 months of today."
      : null);
  const boundaries = useQuery({
    queryKey: [
      "schedule-boundaries",
      scope.userId,
      scope.customerId,
      subscription.id,
      subscription.version,
      fromDueDate,
      throughDueDate,
    ],
    enabled: !problem,
    queryFn: ({ signal }) =>
      request<SubscriptionBoundariesResponse>(
        `${path}/subscription-boundaries?${parameters({ periodAnchorDate: subscription.periodAnchorDate, dueAnchorDate: subscription.dueAnchorDate, intervalMonths: subscription.intervalMonths, fromDueDate, throughDueDate })}`,
        { signal },
      ),
    retry: false,
  });
  const choices =
    boundaries.data?.boundaries.filter(
      (boundary) =>
        boundary.periodIndex >= subscription.firstUnbilledPeriodIndex,
    ) ?? [];
  const boundary = choices.find(
    (candidate) => String(candidate.periodIndex) === selected,
  );
  const pickWindow = (set: (value: string) => void, value: string) => {
    set(value);
    setSelected("");
  };
  return (
    <form
      className="account-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (!locked && !problem && boundary && subscription.canManage)
          activate({
            kind: "activate",
            subscriptions: [
              {
                subscriptionId: subscription.id,
                expectedVersion: subscription.version,
                activationFromPeriodIndex: boundary.periodIndex,
              },
            ],
          });
      }}
    >
      <fieldset disabled={locked}>
        <dl className="schedule-facts">
          <div>
            <dt>First unbilled period</dt>
            <dd>
              {dateRange(
                subscription.firstUnbilled.periodStart,
                subscription.firstUnbilled.periodEnd,
              )}
              <span className="schedule-support">
                Due {date(subscription.firstUnbilled.dueDate)},{" "}
                {subscription.calendar.timeZone}
              </span>
            </dd>
          </div>
        </dl>
        <div className="schedule-window">
          <label>
            Activation due from
            <input
              type="date"
              value={fromDueDate}
              max={maximum}
              onChange={(event) => pickWindow(setFrom, event.target.value)}
            />
          </label>
          <label>
            Activation due through
            <input
              type="date"
              value={throughDueDate}
              max={maximum}
              onChange={(event) => pickWindow(setThrough, event.target.value)}
            />
          </label>
        </div>
        {problem && (
          <p className="schedule-warning" role="alert">
            {problem}
          </p>
        )}
        {boundaries.isError && !problem && (
          <p role="alert">{boundaries.error.message}</p>
        )}
        <label>
          First activated service period
          <select
            value={selected}
            disabled={
              Boolean(problem) || boundaries.isFetching || boundaries.isError
            }
            onChange={(event) => setSelected(event.target.value)}
          >
            <option value="">Choose a service period</option>
            {choices.map((candidate) => (
              <option key={candidate.periodIndex} value={candidate.periodIndex}>
                {dateRange(candidate.periodStart, candidate.periodEnd)}, due{" "}
                {date(candidate.dueDate)}
              </option>
            ))}
          </select>
        </label>
        <p className="account-note schedule-below">
          {boundary &&
            (boundary.periodIndex === subscription.firstUnbilledPeriodIndex
              ? "Starts at the first unbilled period. "
              : `Before activation: ${dateRange(subscription.firstUnbilled.periodStart, boundary.periodStart)} stays outside this schedule. `)}
          This period cannot be changed after invoicing starts.
        </p>
        {boundaries.isFetching && !problem && (
          <p role="status">Finding service periods…</p>
        )}
        {!problem && boundaries.isSuccess && choices.length === 0 && (
          <p className="account-note">
            No first unbilled or later periods are due in these dates.
          </p>
        )}
        <div className="account-actions">
          <button
            className="account-primary-button"
            disabled={
              locked ||
              Boolean(problem) ||
              !boundary ||
              boundaries.isFetching ||
              boundaries.isError ||
              !subscription.canManage
            }
          >
            Start invoicing
          </button>
        </div>
      </fieldset>
    </form>
  );
}

function HistoryWindow({
  window,
  busy,
  apply,
}: {
  window: { fromDueDate: string; throughDueDate: string };
  busy: boolean;
  apply: (window: { fromDueDate: string; throughDueDate: string }) => void;
}) {
  const [from, setFrom] = useState(window.fromDueDate);
  const [through, setThrough] = useState(window.throughDueDate);
  const problem = windowError(from, through);
  return (
    <form
      className="account-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (!problem) apply({ fromDueDate: from, throughDueDate: through });
      }}
    >
      <fieldset className="schedule-window schedule-range" disabled={busy}>
        <label>
          Due from
          <input
            type="date"
            value={from}
            onChange={(event) => setFrom(event.target.value)}
          />
        </label>
        <label>
          Due through
          <input
            type="date"
            value={through}
            onChange={(event) => setThrough(event.target.value)}
          />
        </label>
        <button
          className="secondary-button"
          disabled={Boolean(problem) || busy}
        >
          Show groups
        </button>
      </fieldset>
      {problem && (
        <p className="schedule-warning" role="alert">
          {problem}
        </p>
      )}
    </form>
  );
}

function History({ path, ...scope }: Scope & { path: string }) {
  const search = useSearch({ from: "/customers/$customerId/billing-schedule" });
  const navigate = useNavigate({
    from: "/customers/$customerId/billing-schedule",
  });
  const [initial] = useState(() => today());
  const window = {
    fromDueDate: search.fromDueDate ?? initial,
    throughDueDate: search.throughDueDate ?? monthsAfter(initial, 1),
  };
  const offset = search.offset ?? 0;
  useEffect(() => {
    if (
      search.fromDueDate === undefined ||
      search.throughDueDate === undefined
    ) {
      void navigate({
        search: { ...window, offset },
        replace: true,
        resetScroll: false,
      });
    }
  }, [
    search.fromDueDate,
    search.throughDueDate,
    window.fromDueDate,
    window.throughDueDate,
    offset,
    navigate,
  ]);
  const groups = useQuery({
    queryKey: [
      "scheduled-groups",
      scope.userId,
      scope.customerId,
      window,
      offset,
    ],
    enabled: !windowError(window.fromDueDate, window.throughDueDate),
    queryFn: ({ signal }) =>
      request<ScheduledGroupsResponse>(
        `${path}/scheduled-groups?${parameters({ ...window, limit: pageSize, offset })}`,
        { signal },
      ),
    retry: false,
  });
  return (
    <section className="panel account-section schedule-history">
      <h2>Invoice groups</h2>
      <HistoryWindow
        key={`${window.fromDueDate}:${window.throughDueDate}:${offset}`}
        window={window}
        busy={groups.isFetching}
        apply={(next) => {
          if (
            offset === 0 &&
            window.fromDueDate === next.fromDueDate &&
            window.throughDueDate === next.throughDueDate
          ) {
            void groups.refetch();
          } else {
            void navigate({
              search: { ...next, offset: 0 },
              resetScroll: false,
            });
          }
        }}
      />
      <p className="account-note">
        Invoices issue 21 days before their due date. Forecast totals can still
        change. Totals are not an account balance.
      </p>
      {groups.isFetching && <p role="status">Loading groups…</p>}
      {groups.isError && <p role="alert">{errorMessage(groups.error)}</p>}
      {groups.data && !groups.isError && (
        <>
          {groups.data.groups.length === 0 ? (
            <p className="account-note">No groups due in these dates.</p>
          ) : (
            <ol className="schedule-groups">
              {groups.data.groups.map((group) => (
                <Group
                  key={`${group.id ?? group.kind}:${group.dueDate}:${group.paymentArrangement}`}
                  customerId={scope.customerId}
                  group={group}
                />
              ))}
            </ol>
          )}
          {(groups.data.total > pageSize || offset > 0) && (
            <nav className="pagination" aria-label="Group pages">
              <span>
                {groups.data.total === 0
                  ? "0"
                  : `${offset + 1}–${Math.min(offset + pageSize, groups.data.total)}`}{" "}
                of {groups.data.total}
              </span>
              <div>
                <button
                  className="secondary-button"
                  disabled={offset === 0 || groups.isFetching}
                  onClick={() =>
                    void navigate({
                      search: {
                        ...window,
                        offset: Math.max(0, offset - pageSize),
                      },
                      resetScroll: false,
                    })
                  }
                >
                  Previous
                </button>
                <button
                  className="secondary-button"
                  disabled={
                    offset + pageSize >= groups.data.total || groups.isFetching
                  }
                  onClick={() =>
                    void navigate({
                      search: { ...window, offset: offset + pageSize },
                      resetScroll: false,
                    })
                  }
                >
                  Next
                </button>
              </div>
            </nav>
          )}
        </>
      )}
    </section>
  );
}

function GroupStatus({ group }: { group: ScheduledGroup }) {
  if (group.kind === "upcoming") return null;
  if (group.kind !== "sealed")
    return (
      <span className={`status-tag schedule-kind-${group.kind}`}>
        {kinds[group.kind]}
      </span>
    );
  if (group.outcome === "no_charge")
    return <span className="status-tag">No charge</span>;
  return group.invoice ? (
    <span
      className={`status-tag invoice-status invoice-status-${group.invoice.state}`}
    >
      {invoiceStateLabels[group.invoice.state]}
    </span>
  ) : (
    <span className="status-tag invoice-status invoice-status-requested">
      Invoice requested
    </span>
  );
}

function Group({
  customerId,
  group,
}: {
  customerId: string;
  group: ScheduledGroup;
}) {
  const issues =
    group.outcome === "invoice_requested" ||
    group.kind === "upcoming" ||
    group.kind === "review";
  return (
    <li className="schedule-group">
      <div className="schedule-group-head">
        <h3>Due {date(group.dueDate)}</h3>
        <span className="account-note">
          {group.paymentArrangement === "automatic"
            ? "Automatic payment, paid manually for now"
            : "Manual payment"}
        </span>
        <span className="schedule-amount">
          {money(group.totalMinor, group.currency)}
          {group.kind !== "sealed" && (
            <span className="schedule-support">Forecast</span>
          )}
        </span>
        <GroupStatus group={group} />
      </div>
      {(issues || group.billTo || group.invoice) && (
        <dl className="schedule-facts">
          {issues && (
            <div>
              <dt>Scheduled issue date</dt>
              <dd>
                {group.issueAt
                  ? dateTime(group.issueAt, group.calendar.timeZone)
                  : "Needs calendar review"}
                <span className="schedule-support">
                  {group.calendar.timeZone}
                </span>
              </dd>
            </div>
          )}
          {group.billTo && (
            <div>
              <dt>Bill to</dt>
              <dd>
                {group.billTo.legalName}
                <span className="schedule-support">
                  {group.billTo.billingEmail}
                </span>
              </dd>
            </div>
          )}
          {group.invoice && (
            <div>
              <dt>Invoice</dt>
              <dd>
                <Link
                  to="/invoices"
                  search={{ invoiceId: group.invoice.id, offset: 0 }}
                >
                  View invoice
                </Link>
                {group.invoice.issuedAt && (
                  <span className="schedule-support">
                    Issued{" "}
                    {dateTime(group.invoice.issuedAt, group.calendar.timeZone)}
                  </span>
                )}
              </dd>
            </div>
          )}
        </dl>
      )}
      {group.outcome === "no_charge" && (
        <p className="account-note">
          This outcome is final. No invoice was created.
        </p>
      )}
      {group.reviewReasons.length > 0 && (
        <ul className="schedule-review">
          {group.reviewReasons.map((reason) => (
            <li key={reason}>{reasons[reason]}</li>
          ))}
        </ul>
      )}
      <ul className="schedule-periods">
        {group.periods.map((period) => (
          <li key={`${period.subscriptionId}:${period.periodIndex}`}>
            <Link
              to="/customers/$customerId/subscriptions/$subscriptionId"
              params={{ customerId, subscriptionId: period.subscriptionId }}
            >
              {period.label}
            </Link>
            <span className="schedule-support">
              Service {dateRange(period.periodStart, period.periodEnd)}
            </span>
            <span className="schedule-amount">
              {period.billingState !== "billable"
                ? `${period.billingState === "paused" ? "Paused" : "Cancelled"}, not billed`
                : period.amountMinor === 0
                  ? "Free"
                  : money(period.amountMinor, "USD")}
            </span>
          </li>
        ))}
      </ul>
    </li>
  );
}
