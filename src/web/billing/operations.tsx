import "./operations.css";
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { command, request, useRequestId, useSession } from "../accounts/api";
import type {
  BillingOperation,
  BillingOperationsResponse,
  SetEffectsPausedRequest,
  SetEffectsPausedResponse,
  CheckEffectStatusRequest,
  CheckEffectStatusResponse,
} from "../../billing/operations-contract";

const timestamp = (value: string | null) =>
  value
    ? new Intl.DateTimeFormat("en-US", {
        dateStyle: "medium",
        timeStyle: "long",
      }).format(new Date(value))
    : "Not recorded";
const states = {
  pending: "Pending",
  stalled: "Needs a status check",
  needs_review: "Staff review",
};
// Known review reasons; other recorded reasons are shown in plain words.
const reasons: Record<string, string> = {
  uncertain_customer: "Payment account creation could not be confirmed.",
  uncertain_invoice: "Invoice creation could not be confirmed.",
  uncertain_line: "Invoice item creation could not be confirmed.",
  uncertain_outcome: "The outcome could not be confirmed.",
  uncertain_delivery: "Email delivery could not be confirmed.",
  provider_unavailable: "Stripe could not be reached.",
  provider_conflict: "Stripe returned a conflicting result.",
  provider_mismatch: "Stripe details do not match this record.",
  retry_exhausted: "The retry limit was reached.",
  declined: "The payment was declined.",
  authentication_required: "The customer must verify the payment.",
  consent_changed: "Automatic payment consent changed.",
  method_unavailable: "The saved payment method could not be used.",
  amount_changed: "The amount remaining changed.",
  competing_payment: "Another payment was recorded.",
  resolution_conflict: "Another invoice change conflicts with this one.",
};
const plain = (value: string) => {
  const text = value.replaceAll("_", " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
};
const outcomes = {
  complete: "Status updated.",
  retry: "The outcome is still pending.",
  needs_review: "Staff review is still required.",
  unavailable: "Status is unavailable. Try a new check later.",
  pending: "This status check is still pending.",
};

export function BillingOperationsPage() {
  const session = useSession();
  if (session.isPending) return <p role="status">Checking your session…</p>;
  if (session.isError)
    return <p role="alert">Account access is unavailable.</p>;
  if (!session.data?.user)
    return (
      <section className="panel account-section">
        <h1>Billing operations</h1>
        <Link to="/sign-in" search={{ returnTo: "/billing-operations" }}>
          Sign in to continue
        </Link>
      </section>
    );
  if (!session.data.staffRoles.includes("billing"))
    return (
      <section className="panel account-section">
        <h1>Billing operations</h1>
        <p>Billing staff access is required.</p>
      </section>
    );
  return (
    <Operations key={session.data.user.id} userId={session.data.user.id} />
  );
}

function Operations({ userId }: { userId: string }) {
  const cache = useQueryClient();
  const key = ["billing-operations", userId];
  const detail = useQuery({
    queryKey: key,
    queryFn: ({ signal }) =>
      request<BillingOperationsResponse>("/api/billing/operations", { signal }),
    retry: false,
  });
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState("");
  const [controlMessage, setControlMessage] = useState("");
  const controlId = useRequestId();
  const checkId = useRequestId();
  const control = useMutation({
    mutationFn: (input: SetEffectsPausedRequest) =>
      command<SetEffectsPausedResponse>(
        "/api/billing/operations/control",
        input,
      ),
    onSuccess: async (result) => {
      controlId.reset();
      setReason("");
      setControlMessage(
        result.control.paused ? "Pause saved." : "Resume saved.",
      );
      await cache.invalidateQueries({ queryKey: key });
    },
  });
  const check = useMutation({
    mutationFn: (input: CheckEffectStatusRequest) =>
      command<CheckEffectStatusResponse>(
        "/api/billing/operations/check",
        input,
      ),
    onSuccess: async (result) => {
      checkId.reset();
      setMessage(outcomes[result.outcome]);
      await cache.invalidateQueries({ queryKey: key });
    },
  });
  const busy = control.isPending || check.isPending || detail.isFetching;
  const failed = control.isError || check.isError;
  async function reload() {
    const result = await detail.refetch();
    if (!result.isError) {
      control.reset();
      check.reset();
      controlId.reset();
      checkId.reset();
      setControlMessage("");
      setMessage(
        "Current status loaded. Review it before making another change.",
      );
    }
  }
  const data = detail.isError || failed ? undefined : detail.data;
  return (
    <div className="account-page">
      <header className="account-page-header">
        <h1>Billing operations</h1>
      </header>
      {(detail.isError || failed) && (
        <section className="panel account-section" role="alert">
          <p>
            The current outcome needs checking. Reload before taking another
            action.
          </p>
          <button
            type="button"
            className="secondary-button"
            disabled={busy}
            onClick={() => void reload()}
          >
            Reload status
          </button>
        </section>
      )}
      {detail.isPending && <p role="status">Loading billing work…</p>}
      {message && <p role="status">{message}</p>}
      {data && (
        <>
          <section className="panel account-section">
            <div className="operations-heading">
              <h2>
                {data.control.paused
                  ? "Billing actions paused"
                  : "Billing actions enabled"}
              </h2>
              {data.control.updatedAt && (
                <span className="account-note">
                  Changed {timestamp(data.control.updatedAt)}
                </span>
              )}
            </div>
            <p>
              Pausing stops the portal from sending billing actions to Stripe or
              invoice email: payment accounts, invoices and their items, invoice
              issue, payment method setup, external payments and voids,
              automatic payments and invoice emails. Repeat sends of earlier
              requests also wait.
            </p>
            <p className="account-note">
              Status checks continue. Requests accepted for sending before the
              pause may still be sent and complete. Customers can still pay an
              issued Stripe invoice. Resuming keeps existing consent and retry
              limits and does not authorize another charge.
            </p>
            <form
              className="account-form operations-control"
              onSubmit={(event) => {
                event.preventDefault();
                if (busy || failed || !reason.trim()) return;
                const input = {
                  expectedVersion: data.control.version,
                  paused: !data.control.paused,
                  reason: reason.trim(),
                };
                setMessage("");
                setControlMessage("");
                control.mutate({ ...input, requestId: controlId.get(input) });
              }}
            >
              <label>
                Reason (required)
                <input
                  required
                  maxLength={500}
                  value={reason}
                  disabled={busy}
                  onChange={(event) => setReason(event.target.value)}
                />
              </label>
              <button
                type="submit"
                className="account-primary-button"
                disabled={busy || !reason.trim()}
              >
                {control.isPending
                  ? "Saving…"
                  : data.control.paused
                    ? "Resume billing actions"
                    : "Pause billing actions"}
              </button>
            </form>
            {controlMessage && <p role="status">{controlMessage}</p>}
          </section>
          <section className="panel account-section">
            <div className="operations-heading">
              <h2>Work to review</h2>
              <button
                type="button"
                className="secondary-button"
                disabled={busy}
                onClick={() => void reload()}
              >
                Refresh
              </button>
            </div>
            {!data.operations.length ? (
              <p>
                Nothing is waiting. Billing actions appear here while their
                outcome is pending or needs staff review.
              </p>
            ) : (
              <p className="account-note">
                {data.operations.length === 100
                  ? "Showing the oldest 100 items. Later items appear as these are resolved."
                  : `${data.operations.length} ${data.operations.length === 1 ? "item" : "items"}, oldest first. Up to 100 are shown.`}
              </p>
            )}
            <ul className="operations-list">
              {data.operations.map((item) => (
                <Operation
                  key={`${item.effect.kind}:${item.effect.effectId}`}
                  item={item}
                  disabled={busy}
                  onCheck={() => {
                    setMessage("");
                    const input = { effect: item.effect };
                    check.mutate({ ...input, requestId: checkId.get(input) });
                  }}
                />
              ))}
            </ul>
          </section>
        </>
      )}
    </div>
  );
}
function Operation({
  item,
  disabled,
  onCheck,
}: {
  item: BillingOperation;
  disabled: boolean;
  onCheck: () => void;
}) {
  return (
    <li className="operation-row">
      <div className="operation-head">
        <div>
          <strong>{item.customerLabel}</strong>
          <span>{plain(item.label)}</span>
        </div>
        <span
          className={`status-tag${item.state === "needs_review" ? " operation-review" : ""}`}
        >
          {states[item.state]}
        </span>
      </div>
      {item.reason && (
        <p
          className={
            item.state === "needs_review" ? "operation-reason" : "account-note"
          }
        >
          {reasons[item.reason] ?? `${plain(item.reason)}.`}
        </p>
      )}
      <dl className="operation-times">
        <div>
          <dt>Attempted</dt>
          <dd>{timestamp(item.attemptedAt)}</dd>
        </div>
        <div>
          <dt>Last checked</dt>
          <dd>{timestamp(item.lastCheckedAt)}</dd>
        </div>
        {item.nextEligibleAt && (
          <div>
            <dt>Next attempt allowed</dt>
            <dd>{timestamp(item.nextEligibleAt)}</dd>
          </div>
        )}
      </dl>
      <div className="operation-actions">
        <Link
          to="/customers/$customerId"
          params={{ customerId: item.effect.customerId }}
        >
          Customer account
        </Link>
        {item.invoiceId && (
          <Link
            to="/customers/$customerId/invoices/$invoiceId/review"
            params={{
              customerId: item.effect.customerId,
              invoiceId: item.invoiceId,
            }}
          >
            Review invoice
          </Link>
        )}
        {item.canCheckStatus && (
          <button
            type="button"
            className="secondary-button"
            disabled={disabled}
            onClick={onCheck}
          >
            Check status
          </button>
        )}
      </div>
    </li>
  );
}
