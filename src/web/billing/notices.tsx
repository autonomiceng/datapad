import { useQuery } from "@tanstack/react-query";
import type {
  InvoiceNoticesResponse,
  NoticeReason,
  NoticeStage,
  NoticeState,
} from "../../notifications/contract";
import { AccountError, request, useSession } from "../accounts/api";
import "./notices.css";

const stages: Record<NoticeStage, string> = {
  invoice: "Invoice",
  before_due: "Before due",
  due: "Due date",
  overdue: "Overdue",
};
function stateLabel(notice: Notice) {
  if (notice.state === "pending")
    return notice.attempts > 0 ? "Retry scheduled" : "Not sent yet";
  const labels: Record<Exclude<NoticeState, "pending">, string> = {
    sending: "Sending",
    accepted: "Accepted by mail server",
    suppressed: "Not sent",
    needs_review: "Staff review",
  };
  return labels[notice.state];
}
const reasons: Record<NoticeReason, string> = {
  paid: "Invoice paid.",
  void: "Invoice void.",
  awaiting_collection: "Waiting for the automatic payment.",
  pending: "Waiting for the payment to finish.",
  processing: "Waiting for the payment to finish.",
  unknown: "Waiting for a current payment status.",
  stale: "Waiting for a current payment status.",
  provider_unavailable: "Payment status could not be confirmed.",
  resolution_pending: "Waiting for the invoice resolution.",
  resolution_conflict: "Waiting for staff to resolve the invoice.",
  collection_review: "Waiting for staff to review the payment.",
  not_payable: "Invoice is not payable.",
  manual: "Manual payment.",
  before_charge: "Before the scheduled automatic payment.",
  not_authorized: "Automatic payment is not authorized.",
  declined: "Automatic payment was declined.",
  requires_action: "Customer payment verification is required.",
  missed: "Automatic payment was not attempted.",
  calendar_invalid: "The notice date could not be calculated.",
  billing_contact_missing: "No billing contact is recorded.",
  billing_contact_changed:
    "The billing contact changed after the first attempt. Confirm the recipient before contacting the customer.",
  recipient_not_allowed:
    "The billing contact is outside the sample recipient policy.",
  initial_notice_pending: "Waits until the invoice notice is accepted.",
  initial_notice_needs_review: "Waits until staff review the invoice notice.",
  obsolete_after_delay:
    "Skipped because its date passed before the invoice notice was sent.",
  obsolete: "Skipped because its sending window passed.",
  uncertain_delivery:
    "Delivery could not be confirmed. It will not be sent again automatically. Check the inbox before contacting the customer.",
  evidence_expired_before_send:
    "Payment status expired before the message was sent. It will not be sent automatically. Review the invoice before contacting the customer.",
  smtp_transient:
    "The mail server did not accept the message. Another attempt is scheduled.",
  smtp_rejected: "The mail server rejected the message.",
  retry_exhausted:
    "The mail server did not accept the message after 3 attempts.",
  content_changed:
    "The invoice changed after the first attempt. Review the saved message before contacting the customer.",
};
type Notice = InvoiceNoticesResponse["notices"][number];

function NoticeTime({ value, timeZone }: { value: string; timeZone: string }) {
  return (
    <time dateTime={value}>
      {new Intl.DateTimeFormat("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZone,
        timeZoneName: "short",
      }).format(new Date(value))}
    </time>
  );
}

function NoticeRecord({ notice }: { notice: Notice }) {
  const time = (value: string) => (
    <NoticeTime value={value} timeZone={notice.calendar.timeZone} />
  );
  const review = notice.state === "needs_review";
  return (
    <li className={`notice-record${review ? " notice-record-review" : ""}`}>
      <div className="notice-head">
        <div>
          <strong>{stages[notice.stage]}</strong>
          <span className="notice-support">
            {notice.scheduledAt ? (
              <>Scheduled {time(notice.scheduledAt)}</>
            ) : (
              "Date unavailable"
            )}
          </span>
        </div>
        <span className={`status-tag notice-state-${notice.state}`}>
          {stateLabel(notice)}
        </span>
      </div>
      {notice.reason && (
        <p className={review ? "notice-review" : "notice-support"}>
          {reasons[notice.reason]}
        </p>
      )}
      {(notice.recipient || notice.attemptedAt || notice.nextAttemptAt) && (
        <dl className="notice-facts">
          {notice.recipient && (
            <div>
              <dt>Recipient</dt>
              <dd>{notice.recipient}</dd>
            </div>
          )}
          {notice.attemptedAt && (
            <div>
              <dt>Last attempt</dt>
              <dd>
                {time(notice.attemptedAt)}
                <span className="notice-support">
                  Attempt {notice.attempts} of 3
                </span>
              </dd>
            </div>
          )}
          {notice.acceptedAt && (
            <div>
              <dt>Accepted</dt>
              <dd>{time(notice.acceptedAt)}</dd>
            </div>
          )}
          {notice.nextAttemptAt && (
            <div>
              <dt>Next attempt</dt>
              <dd>{time(notice.nextAttemptAt)}</dd>
            </div>
          )}
        </dl>
      )}
      {notice.preview && notice.previewKind && (
        <details className="notice-preview">
          <summary>Message</summary>
          <p className="notice-support">Saved at the first attempt.</p>
          <p className="notice-subject">{notice.preview.subject}</p>
          <pre className="notice-text">{notice.preview.text}</pre>
          <details>
            <summary>HTML preview</summary>
            <iframe
              title={`${stages[notice.stage]} notice HTML preview`}
              sandbox=""
              tabIndex={-1}
              referrerPolicy="no-referrer"
              className="notice-html"
              srcDoc={`<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><style>body{font-family:system-ui,sans-serif;font-size:14px;line-height:1.5;overflow-wrap:anywhere;margin:12px}a{pointer-events:none}</style></head><body>${notice.preview.html}</body></html>`}
            />
          </details>
          {notice.messageId && (
            <p className="notice-support">
              Message-ID: <span>{notice.messageId}</span>
            </p>
          )}
        </details>
      )}
    </li>
  );
}

/** Displays authorized staff notice history and saved content; reads never send or authorize delivery. */
export function InvoiceNotices({
  customerId,
  invoiceId,
}: {
  customerId: string;
  invoiceId: string;
}) {
  const session = useSession();
  const authorized =
    !session.isError &&
    !!session.data?.user &&
    session.data.staffRoles.includes("billing");
  const notices = useQuery({
    queryKey: [
      "invoice-notices",
      session.data?.user?.id,
      customerId,
      invoiceId,
    ],
    enabled: authorized,
    queryFn: ({ signal }) =>
      request<InvoiceNoticesResponse>(
        `/api/customers/${encodeURIComponent(customerId)}/invoices/${encodeURIComponent(invoiceId)}/notices`,
        { signal },
      ),
    retry: false,
    refetchInterval: 5000,
  });
  if (!authorized) return null;
  return (
    <section className="invoice-workflow invoice-notices" aria-label="Notices">
      <div className="notice-section-heading">
        <h2>Notices</h2>
        <a href="/sample-inbox">Sample inbox</a>
      </div>
      {notices.isPending && <p role="status">Loading notices…</p>}
      {notices.isError && (
        <p role="alert">
          {notices.error instanceof AccountError && notices.error.status === 403
            ? "You do not have permission to view these notices."
            : "Notices could not be loaded. Reload to check their current status."}
        </p>
      )}
      {!notices.isError &&
        notices.data &&
        (notices.data.notices.length === 0 ? (
          <p className="notice-support">No notices recorded.</p>
        ) : (
          <ol className="notice-list">
            {notices.data.notices.map((notice) => (
              <NoticeRecord key={notice.id} notice={notice} />
            ))}
          </ol>
        ))}
      {notices.isError && (
        <button
          className="secondary-button"
          onClick={() => void notices.refetch()}
        >
          Reload notices
        </button>
      )}
    </section>
  );
}
