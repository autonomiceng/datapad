import { useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ExternalPaymentRequest,
  ReceiptCorrectionRequest,
  ReconcileResolutionRequest,
  ResolutionActionResponse,
  ResolutionDetail,
  ResolutionReviewResponse,
  ResolutionSummary,
  VoidInvoiceRequest,
} from "../../billing/resolutions-contract";
import {
  AccountError,
  command,
  request,
  useRequestId,
  useSession,
} from "../accounts/api";
import { date, money, instant as formatInstant } from "./format";
import "./resolutions.css";

type Action = ResolutionReviewResponse["actions"][number];
type Blocker = ResolutionReviewResponse["blockers"][number];
const labels: Record<Action, string> = {
  record_external_payment: "Record received payment",
  void: "Void invoice",
  correct_receipt: "Correct receipt",
  reconcile: "Resume request",
};
const warnings: Record<Blocker, string> = {
  provider_unavailable:
    "Stripe is unavailable. Received funds can still be recorded when permitted; confirmation will wait.",
  collection_conflict:
    "Electronic collection is active or has changed. Staff review is required before settlement.",
  possible_overpayment:
    "There may be an overpayment. Review the received funds and electronic payments.",
  amount_mismatch:
    "The received amount differs from the remaining balance. Review the receipt before reconciliation.",
  uncertain_outcome:
    "The provider outcome could not be attributed to this request. Staff review is required.",
  retry_exhausted:
    "Provider reconciliation stopped after repeated failures. Staff review is required.",
  receipt_correction:
    "A receipt correction needs review. The original received facts are preserved.",
  provider_mismatch:
    "The provider invoice differs from the stored invoice. Staff review is required.",
  not_finalized: "The invoice must be issued before it can be resolved.",
  terminal: "The invoice is already paid or void.",
  existing_resolution:
    "An existing resolution must be reviewed before another can be recorded.",
};
/** Expected states rather than problems; shown as notes instead of review warnings. */
const informational: Blocker[] = ["not_finalized", "terminal"];
const states: Record<ResolutionSummary["state"], string> = {
  pending: "Pending provider confirmation",
  confirmed: "Provider confirmed",
  needs_review: "Needs staff review",
  withdrawn: "Withdrawn before a provider attempt",
};
const collection: Record<ResolutionReviewResponse["collectionState"], string> =
  {
    idle: "None in progress",
    active: "In progress",
    unknown: "Unknown",
  };
const methods = { zelle: "Zelle", check: "Check" } as const;
/** The synthetic runtime accepts only these exact values. */
const samples = {
  record_external_payment: "Sample external payment",
  void: "Sample invoice void",
  correct_receipt: "Sample receipt correction",
} as const;
type Submission =
  | { action: "record_external_payment"; input: ExternalPaymentRequest }
  | { action: "void"; input: VoidInvoiceRequest }
  | { action: "correct_receipt"; input: ReceiptCorrectionRequest }
  | { action: "reconcile"; input: ReconcileResolutionRequest };
const suffix: Record<Action, string> = {
  record_external_payment: "external-payment",
  void: "void",
  correct_receipt: "receipt-correction",
  reconcile: "reconcile",
};
const instant = (value: string) => (
  <time dateTime={value}>{formatInstant(value)}</time>
);

/** Recorded facts beside Stripe confirmation. Only staff callers pass `detail`. */
function ResolutionRecord({
  resolution,
  detail,
  currency,
  children,
}: {
  resolution: ResolutionSummary;
  detail?: ResolutionDetail;
  currency: string;
  children?: ReactNode;
}) {
  const external = resolution.kind === "external_payment";
  const received = [
    resolution.method && methods[resolution.method],
    resolution.receivedDate && `Received ${date(resolution.receivedDate)}`,
  ].filter(Boolean);
  const progress = resolution.confirmedAt ? (
    instant(resolution.confirmedAt)
  ) : detail?.attemptedAt ? (
    <>Sent {instant(detail.attemptedAt)}</>
  ) : detail && resolution.state !== "withdrawn" ? (
    "Not sent yet"
  ) : null;
  return (
    <div className="resolution-record">
      <h3>{external ? "Received payment" : "Void request"}</h3>
      <dl className="invoice-facts">
        {external && (
          <div>
            <dt>Amount received</dt>
            <dd className="resolution-amount">
              {resolution.amountMinor === null
                ? "Unknown"
                : money(resolution.amountMinor, currency)}
            </dd>
            {received.length > 0 && (
              <dd className="resolution-support">{received.join(" · ")}</dd>
            )}
          </div>
        )}
        {detail?.reference && (
          <div>
            <dt>Reference</dt>
            <dd>{detail.reference}</dd>
          </div>
        )}
        {detail?.reason && (
          <div>
            <dt>{external ? "Correction reason" : "Void reason"}</dt>
            <dd>{detail.reason}</dd>
          </div>
        )}
        <div>
          <dt>Stripe</dt>
          <dd>{states[resolution.state]}</dd>
          {progress && <dd className="resolution-support">{progress}</dd>}
        </div>
      </dl>
      {children}
    </div>
  );
}

export function InvoiceResolutions({
  userId,
  customerId,
  invoiceId,
  currency,
}: {
  userId: string;
  customerId: string;
  invoiceId: string;
  currency: string;
}) {
  const client = useQueryClient();
  const path = `/api/customers/${encodeURIComponent(customerId)}/invoices/${encodeURIComponent(invoiceId)}`;
  const review = useQuery({
    queryKey: ["invoice-resolution", userId, customerId, invoiceId],
    queryFn: ({ signal }) =>
      request<ResolutionReviewResponse>(`${path}/resolution-review`, {
        signal,
      }),
    retry: false,
    refetchInterval: 5000,
  });
  const refresh = async () => {
    const [result] = await Promise.all([
      review.refetch(),
      client.invalidateQueries({
        queryKey: ["invoice-preparation", userId, customerId, invoiceId],
      }),
      client.invalidateQueries({ queryKey: ["invoices", userId] }),
      client.invalidateQueries({ queryKey: ["invoice", userId, invoiceId] }),
    ]);
    return !result.isError;
  };
  const data = review.data;
  const current = data?.resolution;
  const earlier = data?.history.filter((item) => item.id !== current?.id);
  return (
    <section
      className="invoice-workflow invoice-resolutions"
      aria-label="Resolve invoice"
    >
      <h2>Resolve invoice</h2>
      {review.isPending && <p role="status">Loading resolution choices…</p>}
      {review.isError && (
        <p role="alert">
          {review.error.message} Resolution actions are unavailable until this
          review reloads.
        </p>
      )}
      {data && (
        <>
          <dl className="invoice-facts">
            <div>
              <dt>Remaining balance</dt>
              <dd className="resolution-amount">
                {data.remainingMinor === null
                  ? "Unknown"
                  : money(data.remainingMinor, currency)}
              </dd>
              <dd className="resolution-support">
                {data.lastCheckedAt ? (
                  <>Checked with Stripe {instant(data.lastCheckedAt)}</>
                ) : (
                  "Not checked with Stripe yet"
                )}
              </dd>
            </div>
            <div>
              <dt>Online payment</dt>
              <dd>{collection[data.collectionState]}</dd>
            </div>
          </dl>
          {current && (
            <ResolutionRecord
              resolution={current}
              detail={current}
              currency={currency}
            >
              {current.reviewReason && (
                <p className="invoice-review">
                  {warnings[current.reviewReason]}
                </p>
              )}
            </ResolutionRecord>
          )}
          {data.blockers
            .filter(
              (blocker) =>
                blocker !== current?.reviewReason &&
                blocker !== "existing_resolution",
            )
            .map((blocker) => (
              <p
                className={
                  informational.includes(blocker)
                    ? "account-note"
                    : "invoice-review"
                }
                key={blocker}
              >
                {warnings[blocker]}
              </p>
            ))}
          <ResolutionForm
            review={data}
            currency={currency}
            path={path}
            disabled={review.isError}
            checking={review.isFetching}
            refresh={refresh}
          />
          {earlier && earlier.length > 0 && (
            <details>
              <summary>Earlier resolutions</summary>
              {earlier.map((item) => (
                <ResolutionRecord
                  key={item.id}
                  resolution={item}
                  detail={item}
                  currency={currency}
                />
              ))}
            </details>
          )}
        </>
      )}
      <button
        type="button"
        className="secondary-button"
        disabled={review.isFetching}
        onClick={() => void refresh()}
      >
        {review.isFetching ? "Reloading…" : "Reload resolution"}
      </button>
    </section>
  );
}

function ResolutionForm({
  review,
  currency,
  path,
  disabled,
  checking,
  refresh,
}: {
  review: ResolutionReviewResponse;
  currency: string;
  path: string;
  disabled: boolean;
  /** A review reload is in flight; inputs stay editable but nothing submits. */
  checking: boolean;
  refresh: () => Promise<boolean>;
}) {
  const synthetic = useSession().data?.synthetic === true;
  const [selected, setSelected] = useState<Action>(
    review.actions[0] ?? "record_external_payment",
  );
  const [enteredAmount, setAmount] = useState<string | null>(null);
  const amount =
    enteredAmount ??
    (review.remainingMinor === null
      ? ""
      : (review.remainingMinor / 100).toFixed(2));
  const [receivedDate, setReceivedDate] = useState(
    new Date().toISOString().slice(0, 10),
  );
  const [method, setMethod] =
    useState<ExternalPaymentRequest["method"]>("zelle");
  const [reference, setReference] = useState<string>(
    synthetic ? samples.record_external_payment : "",
  );
  const [reasons, setReasons] = useState<
    Record<"void" | "correct_receipt", string>
  >({
    void: synthetic ? samples.void : "",
    correct_receipt: synthetic ? samples.correct_receipt : "",
  });
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const requestId = useRequestId();
  const mutation = useMutation({
    mutationFn: ({ action, input }: Submission) =>
      command<ResolutionActionResponse>(`${path}/${suffix[action]}`, input),
    retry: false,
    onSuccess: () => {
      requestId.reset();
      void refresh();
    },
    onError: (error) => {
      if (error instanceof AccountError && error.status === 403) void refresh();
    },
  });
  const conflict =
    mutation.error instanceof AccountError && mutation.error.status === 409;
  const uncertain =
    mutation.isError &&
    (!(mutation.error instanceof AccountError) ||
      mutation.error.status === 0 ||
      mutation.error.status >= 500 ||
      conflict);
  const busy = mutation.isPending || uncertain;
  // Follow the server's current choices unless a request is still unresolved.
  const action: Action =
    busy && mutation.variables
      ? mutation.variables.action
      : review.actions.includes(selected)
        ? selected
        : (review.actions[0] ?? selected);
  const permitted = review.actions.includes(action);
  const recorded = mutation.data?.resolution;
  const latest =
    (review.resolution?.id === recorded?.id ? review.resolution : null) ??
    review.history.find((item) => item.id === recorded?.id) ??
    recorded;
  // Stay frozen after success until the reloaded review shows the new resolution.
  const awaiting =
    mutation.isSuccess &&
    review.resolution?.id !== recorded?.id &&
    !review.history.some((item) => item.id === recorded?.id);
  const frozen = busy || awaiting;
  const amountMinor = /^\d+(?:\.\d{1,2})?$/.test(amount)
    ? Math.round(Number(amount) * 100)
    : NaN;
  const amountValid =
    Number.isSafeInteger(amountMinor) &&
    amountMinor > 0 &&
    amountMinor <= 99999999;
  const matches =
    review.remainingMinor === null || amountMinor === review.remainingMinor;
  const external = action === "record_external_payment";
  const correction = action === "correct_receipt";
  const withdraw = correction && review.resolution?.attemptedAt === null;
  const reason =
    action === "void" || action === "correct_receipt" ? reasons[action] : "";
  const text = external ? reference : reason;
  const sample =
    synthetic && action !== "reconcile" ? samples[action] : undefined;
  const sampleMismatch = sample !== undefined && text.trim() !== sample;
  const today = new Date().toISOString().slice(0, 10);
  const confirmationScope = JSON.stringify([
    action,
    review.remainingMinor,
    review.resolution?.id,
    review.resolution?.attemptedAt,
  ]);
  const confirmed = confirmation === confirmationScope;
  const valid =
    action === "reconcile" ||
    (confirmed &&
      !sampleMismatch &&
      (external
        ? amountValid &&
          matches &&
          receivedDate !== "" &&
          receivedDate <= today &&
          reference.trim() !== ""
        : reason.trim() !== ""));
  const edit = () => {
    setConfirmation(null);
    mutation.reset();
  };
  const amountWarning =
    amount !== "" && (!amountValid || !matches)
      ? review.remainingMinor === null
        ? "Enter a positive amount."
        : `Enter the full remaining balance, ${money(review.remainingMinor, currency)}.`
      : null;
  const sampleHint = sampleMismatch && (
    <p id="resolution-sample-note" className="account-note">
      Sample data accepts only “{sample}”.
    </p>
  );
  return (
    <>
      {(review.actions.length > 0 ||
        mutation.isPending ||
        mutation.isError) && (
        <form
          className="account-form resolution-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (
              disabled ||
              checking ||
              !permitted ||
              mutation.isPending ||
              awaiting ||
              !valid
            )
              return;
            if (uncertain && mutation.variables) {
              mutation.mutate(mutation.variables);
              return;
            }
            if (external) {
              const input = {
                amountMinor,
                receivedDate,
                method,
                reference: reference.trim(),
              };
              mutation.mutate({
                action,
                input: {
                  ...input,
                  requestId: requestId.get({ action, ...input }),
                },
              });
            } else if (action === "reconcile") {
              mutation.mutate({
                action,
                input: { requestId: requestId.get({ action }) },
              });
            } else {
              const input = { reason: reason.trim() };
              mutation.mutate({
                action,
                input: {
                  ...input,
                  requestId: requestId.get({ action, ...input }),
                },
              });
            }
          }}
        >
          <label>
            Action
            <select
              value={action}
              disabled={disabled || busy}
              onChange={(event) => {
                const value = review.actions.find(
                  (available) => available === event.target.value,
                );
                if (value) {
                  setSelected(value);
                  edit();
                }
              }}
            >
              {review.actions.map((value) => (
                <option key={value} value={value}>
                  {labels[value]}
                </option>
              ))}
              {!permitted && <option value={action}>{labels[action]}</option>}
            </select>
          </label>
          <fieldset disabled={disabled || !permitted || frozen}>
            {external ? (
              <>
                <p className="account-note">
                  Record funds already received. The invoice is marked paid only
                  after Stripe confirms.
                </p>
                <div className="resolution-fields">
                  <label>
                    Amount ({currency})
                    <input
                      type="text"
                      inputMode="decimal"
                      required
                      value={amount}
                      aria-describedby="resolution-amount-note"
                      onChange={(event) => {
                        setAmount(event.target.value);
                        edit();
                      }}
                    />
                  </label>
                  <label>
                    Received date (UTC)
                    <input
                      type="date"
                      required
                      value={receivedDate}
                      max={today}
                      onChange={(event) => {
                        setReceivedDate(event.target.value);
                        edit();
                      }}
                    />
                  </label>
                  <label>
                    Method
                    <select
                      value={method}
                      onChange={(event) => {
                        if (
                          event.target.value === "zelle" ||
                          event.target.value === "check"
                        )
                          setMethod(event.target.value);
                        edit();
                      }}
                    >
                      <option value="zelle">Zelle</option>
                      <option value="check">Check</option>
                    </select>
                  </label>
                </div>
                <p
                  id="resolution-amount-note"
                  className={amountWarning ? "invoice-review" : "account-note"}
                >
                  {amountWarning ??
                    (review.remainingMinor === null
                      ? "The remaining balance is unknown. Enter the full amount received; Stripe verifies it before settlement."
                      : "The amount must equal the full remaining balance.")}
                </p>
                <label>
                  Reference
                  <input
                    required
                    maxLength={256}
                    value={reference}
                    aria-describedby={
                      sampleMismatch ? "resolution-sample-note" : undefined
                    }
                    onChange={(event) => {
                      setReference(event.target.value);
                      edit();
                    }}
                  />
                </label>
                {sampleHint}
              </>
            ) : action === "reconcile" ? (
              <p className="account-note">
                Check the current balance and online payments before resuming
                this unsent request. The original payment or void request is
                preserved.
              </p>
            ) : (
              <>
                <p className="account-note">
                  {correction
                    ? withdraw
                      ? "Not sent to Stripe yet. Withdrawing keeps the original facts in the history; a corrected receipt or a void can follow."
                      : "Already sent to Stripe. This flags the receipt for staff review; its original facts and any provider effect remain."
                    : "Voiding is irreversible once Stripe confirms it. Subscriptions and services stay unchanged."}
                </p>
                <label>
                  {correction ? "Correction reason" : "Void reason"}
                  <input
                    required
                    maxLength={500}
                    value={reason}
                    aria-describedby={
                      sampleMismatch ? "resolution-sample-note" : undefined
                    }
                    onChange={(event) => {
                      const value = event.target.value;
                      setReasons((current) => ({
                        ...current,
                        [correction ? "correct_receipt" : "void"]: value,
                      }));
                      edit();
                    }}
                  />
                </label>
                {sampleHint}
              </>
            )}
            {action !== "reconcile" && (
              <label className="resolution-confirm">
                <input
                  type="checkbox"
                  required
                  checked={confirmed}
                  onChange={(event) =>
                    setConfirmation(
                      event.target.checked ? confirmationScope : null,
                    )
                  }
                />
                <span>
                  {external
                    ? "I confirm these funds were received and cover the full remaining balance."
                    : correction
                      ? withdraw
                        ? "I confirm this receipt is mistaken and should be withdrawn."
                        : "I confirm this receipt needs correction and staff review."
                      : "I confirm this invoice should be voided for the reason given."}
                </span>
              </label>
            )}
          </fieldset>
          <div className="account-actions">
            <button
              type="submit"
              className="account-primary-button"
              disabled={
                disabled ||
                checking ||
                !permitted ||
                mutation.isPending ||
                awaiting ||
                !valid ||
                conflict
              }
            >
              {mutation.isPending
                ? "Submitting…"
                : uncertain
                  ? "Retry same request"
                  : withdraw
                    ? "Withdraw receipt"
                    : labels[action]}
            </button>
            {uncertain && (
              <button
                type="button"
                className="secondary-button"
                disabled={disabled}
                onClick={async () => {
                  if (await refresh()) mutation.reset();
                }}
              >
                Reload and review
              </button>
            )}
          </div>
        </form>
      )}
      {mutation.isSuccess && latest && (
        <p role="status">
          {states[latest.state]}.{" "}
          {latest.state === "pending" &&
            "The request is recorded; provider settlement is not yet confirmed."}
        </p>
      )}
      {mutation.isError && (
        <p role="alert">
          {conflict
            ? "This request was already recorded or conflicts with another resolution. Reload and review before acting again; the original request ID is kept."
            : mutation.error.message}
        </p>
      )}
    </>
  );
}

/** Customer-safe receipt facts; references and staff correction reasons stay private. */
export function RecordedResolution({
  resolution,
  currency,
}: {
  resolution: ResolutionSummary;
  currency: string;
}) {
  return (
    <ResolutionRecord resolution={resolution} currency={currency}>
      {resolution.state === "pending" && (
        <p className="account-note">
          Paying through this portal is paused until Stripe confirms. A Stripe
          payment page opened earlier can still accept payment, so do not pay
          there.
        </p>
      )}
      {resolution.state === "needs_review" && (
        <p className="invoice-review">
          Paying through this portal is paused. Contact support before making
          another payment.
        </p>
      )}
    </ResolutionRecord>
  );
}
