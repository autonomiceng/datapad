import { useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import type {
  TicketResponse,
  TicketsResponse,
  SupportProposal,
  SupportTarget,
  ProposeRequest,
  OpenTicketRequest,
  ReplyRequest,
  AddNoteRequest,
  ApproveRequest,
  RecordResultRequest,
} from "../../support/contract";
import type {
  ServiceResponse,
  ServicesResponse,
} from "../../services/contract";
import type { CustomerResponse } from "../../customers/contract";
import {
  AccountError,
  command,
  request,
  useRequestId,
  useSession,
} from "../accounts/api";
import "./tickets.css";

const pageSize = 50;
const maximumOffset = 1000000;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const date = (value: string) =>
  new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(value));
const money = (amountMinor: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    amountMinor / 100,
  );
const components = {
  web: "Web hosting",
  email: "Email hosting",
  dns: "DNS hosting",
};
const blockedCopy: Record<
  NonNullable<TicketResponse["permissions"]["approvalBlockedReason"]>,
  string
> = {
  no_customer_organization:
    "No customer administrator can approve this proposal.",
  administrator_required:
    "A customer administrator must approve this proposal.",
  self_invited:
    "You cannot approve through a membership you invited yourself to.",
  no_proposal: "Staff must prepare a proposal before it can be approved.",
  self_prepared: "You cannot approve a proposal you prepared.",
  unknown_effects:
    "Approval is unavailable until staff explain the cost and data consequences.",
  target_changed:
    "The service or component changed. Staff must prepare a new revision before approval.",
  already_approved: "This revision is approved.",
  resolved: "This request is resolved. Send a public reply to reopen it.",
};
function ticketsPath(customerId: string, ticketId?: string) {
  return `/api/customers/${encodeURIComponent(customerId)}/tickets${ticketId ? `/${encodeURIComponent(ticketId)}` : ""}`;
}
function servicePath(customerId: string, serviceId?: string) {
  return `/api/customers/${encodeURIComponent(customerId)}/services${serviceId ? `/${encodeURIComponent(serviceId)}` : ""}`;
}
function privateFailure(error: unknown) {
  return (
    error instanceof AccountError && [401, 403, 404].includes(error.status)
  );
}
function SessionNotice({
  session,
}: {
  session: ReturnType<typeof useSession>;
}) {
  return (
    <section className="panel account-section">
      <h1>Support</h1>
      {session.isPending ? (
        <p role="status">Checking your session…</p>
      ) : session.isError ? (
        <p role="alert">{session.error.message}</p>
      ) : session.data === null ? (
        <p>Support is unavailable in this viewer.</p>
      ) : (
        <Link
          to="/sign-in"
          search={{ returnTo: location.pathname + location.search }}
        >
          Sign in to continue
        </Link>
      )}
    </section>
  );
}
function Pages({
  page,
  shown,
  noun,
  onChange,
  disabled = false,
}: {
  page: { limit: number; offset: number; total: number };
  shown: number;
  noun: string;
  onChange: (offset: number) => void;
  disabled?: boolean;
}) {
  const next = page.offset + page.limit;
  return (
    <nav className="pagination" aria-label={`${noun} pages`}>
      <span>
        {shown
          ? `${page.offset + 1}–${page.offset + shown} of ${page.total}`
          : `0 of ${page.total}`}{" "}
        {noun}
      </span>
      {(page.offset > 0 || next < page.total) && (
        <div>
          <button
            type="button"
            className="secondary-button"
            disabled={disabled || page.offset === 0}
            onClick={() => onChange(Math.max(0, page.offset - page.limit))}
          >
            Previous
          </button>
          <button
            type="button"
            className="secondary-button"
            disabled={disabled || next >= page.total || next > maximumOffset}
            onClick={() => onChange(next)}
          >
            Next
          </button>
        </div>
      )}
      {next < page.total && next > maximumOffset && (
        <p>More records exist beyond the available page range.</p>
      )}
    </nav>
  );
}
function PageHeader({
  customerId,
  title,
  backToTickets = false,
  customerName,
}: {
  customerId: string;
  title: string;
  backToTickets?: boolean;
  customerName?: string;
}) {
  return (
    <header className="account-page-header">
      {backToTickets ? (
        <Link
          className="account-back"
          to="/customers/$customerId/tickets"
          params={{ customerId }}
        >
          Support requests
        </Link>
      ) : (
        <Link
          className="account-back"
          to="/customers/$customerId"
          params={{ customerId }}
        >
          {customerName ?? "Customer account"}
        </Link>
      )}
      <h1>{title}</h1>
    </header>
  );
}
export function SupportTicketsPage({ customerId }: { customerId: string }) {
  const session = useSession();
  const user = !session.isError && session.data?.user;
  if (!user) return <SessionNotice session={session} />;
  return (
    <TicketsList
      key={`${user.id}/${customerId}`}
      customerId={customerId}
      userId={user.id}
    />
  );
}
function TicketsList({
  customerId,
  userId,
}: {
  customerId: string;
  userId: string;
}) {
  const [offset, setOffset] = useState(0);
  const customer = useQuery({
    queryKey: ["support", userId, customerId, "customer"],
    queryFn: ({ signal }) =>
      request<CustomerResponse>(
        `/api/customers/${encodeURIComponent(customerId)}`,
        { signal },
      ),
    retry: false,
  });
  const list = useQuery({
    queryKey: ["support", userId, customerId, "list", offset],
    queryFn: ({ signal }) =>
      request<TicketsResponse>(
        `${ticketsPath(customerId)}?limit=${pageSize}&offset=${offset}`,
        { signal },
      ),
    retry: false,
  });
  return (
    <div className="account-page support-page">
      <PageHeader
        customerId={customerId}
        title="Support requests"
        customerName={
          customer.isError ? undefined : customer.data?.customer.displayName
        }
      />
      <section className="panel account-section" aria-label="Support requests">
        {list.isPending && <p role="status">Loading requests…</p>}
        {list.isError && <p role="alert">{list.error.message}</p>}
        {!list.isError && list.data && (
          <>
            <div className="account-actions">
              <Link
                className="account-primary-button"
                to="/customers/$customerId/tickets/new"
                params={{ customerId }}
                search={{}}
              >
                New request
              </Link>
            </div>
            {list.data.total === 0 && <p>No support requests yet.</p>}
            <ul className="account-rows support-list">
              {list.data.tickets.map((ticket) => (
                <li key={ticket.id}>
                  <Link
                    to="/customers/$customerId/tickets/$ticketId"
                    params={{ customerId, ticketId: ticket.id }}
                  >
                    {ticket.subject}
                  </Link>
                  <span className="status-tag">
                    {ticket.status === "open" ? "Open" : "Resolved"}
                  </span>
                  <span className="account-note">
                    Updated {date(ticket.updatedAt)}
                  </span>
                </li>
              ))}
            </ul>
            <Pages
              page={list.data}
              shown={list.data.tickets.length}
              noun="requests"
              onChange={setOffset}
            />
          </>
        )}
      </section>
    </div>
  );
}
export function SupportNewTicketPage({
  customerId,
  serviceId,
  componentId,
}: {
  customerId: string;
  serviceId?: string;
  componentId?: string;
}) {
  const session = useSession();
  const user = !session.isError && session.data?.user;
  if (!user) return <SessionNotice session={session} />;
  return (
    <NewTicket
      key={`${user.id}/${customerId}`}
      customerId={customerId}
      userId={user.id}
      supportStaff={session.data?.staffRoles.includes("support") ?? false}
      serviceId={serviceId}
      componentId={componentId}
    />
  );
}
function NewTicket({
  customerId,
  userId,
  supportStaff,
  serviceId,
  componentId,
}: {
  customerId: string;
  userId: string;
  supportStaff: boolean;
  serviceId?: string;
  componentId?: string;
}) {
  const navigate = useNavigate();
  const cache = useQueryClient();
  const requestId = useRequestId();
  const [offset, setOffset] = useState(0);
  const [selectedService, setSelectedService] = useState(serviceId ?? "");
  const [selectedComponent, setSelectedComponent] = useState(componentId ?? "");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [needsReview, setNeedsReview] = useState(false);
  const customer = useQuery({
    queryKey: ["support", userId, customerId, "customer"],
    queryFn: ({ signal }) =>
      request<CustomerResponse>(
        `/api/customers/${encodeURIComponent(customerId)}`,
        { signal },
      ),
    retry: false,
  });
  const services = useQuery({
    queryKey: ["support", userId, customerId, "services", offset],
    queryFn: ({ signal }) =>
      request<ServicesResponse>(
        `${servicePath(customerId)}?limit=${pageSize}&offset=${offset}`,
        { signal },
      ),
    retry: false,
  });
  const target = useQuery({
    queryKey: ["support", userId, customerId, "target", selectedService],
    queryFn: ({ signal }) =>
      request<ServiceResponse>(servicePath(customerId, selectedService), {
        signal,
      }),
    enabled: uuid.test(selectedService),
    retry: false,
  });
  const create = useMutation({
    mutationFn: (input: OpenTicketRequest) =>
      command<TicketResponse>(ticketsPath(customerId), input),
    retry: false,
    onSuccess: async (value) => {
      requestId.reset();
      await cache.invalidateQueries({
        queryKey: ["support", userId, customerId, "list"],
      });
      await navigate({
        to: "/customers/$customerId/tickets/$ticketId",
        params: { customerId, ticketId: value.ticket.id },
      });
    },
    onError: (error) => {
      if (error instanceof AccountError && error.status === 409)
        setNeedsReview(true);
    },
  });
  const error =
    customer.error ??
    services.error ??
    target.error ??
    (privateFailure(create.error) ? create.error : null);
  const canOpen = supportStaff || Boolean(customer.data?.customer.role);
  const currentTarget =
    !target.isError && !target.isPending && target.data?.service;
  const validTarget =
    currentTarget &&
    (selectedComponent === "" ||
      currentTarget.components.some((c) => c.id === selectedComponent));
  const locked = needsReview || create.isPending;
  async function reload() {
    const results = await Promise.all([
      customer.refetch(),
      services.refetch(),
      target.refetch(),
    ]);
    if (results.every((result) => !result.isError)) {
      setNeedsReview(false);
      create.reset();
    }
  }
  return (
    <div className="account-page support-page">
      <PageHeader
        customerId={customerId}
        title="New support request"
        backToTickets
      />
      <section className="panel account-section" aria-label="Request details">
        {error ? (
          <p role="alert">{error.message}</p>
        ) : customer.isPending || services.isPending ? (
          <p role="status">Loading services…</p>
        ) : !canOpen ? (
          <p role="alert">
            You do not have permission to open support requests.
          </p>
        ) : (
          <>
            <dl className="support-facts">
              <div>
                <dt>Customer</dt>
                <dd>{customer.data?.customer.displayName}</dd>
              </div>
            </dl>
            <form
              className="account-form support-form"
              onSubmit={(event) => {
                event.preventDefault();
                if (locked || !validTarget || !subject.trim() || !body.trim())
                  return;
                const input = {
                  serviceId: selectedService,
                  componentId: selectedComponent || null,
                  subject,
                  body,
                };
                create.mutate({ ...input, requestId: requestId.get(input) });
              }}
            >
              <fieldset disabled={locked}>
                <label>
                  Service (required)
                  <select
                    required
                    value={selectedService}
                    onChange={(event) => {
                      setSelectedService(event.target.value);
                      setSelectedComponent("");
                    }}
                  >
                    <option value="">Choose a service</option>
                    {selectedService &&
                      !services.data?.services.some(
                        (service) => service.id === selectedService,
                      ) && (
                        <option value={selectedService}>
                          {currentTarget
                            ? currentTarget.name
                            : "Selected service"}
                        </option>
                      )}
                    {services.data?.services.map((service) => (
                      <option key={service.id} value={service.id}>
                        {service.name}
                      </option>
                    ))}
                  </select>
                </label>
                {selectedService && !uuid.test(selectedService) && (
                  <p role="alert">
                    Choose a service from this customer account.
                  </p>
                )}
                {services.data!.total > services.data!.services.length && (
                  <Pages
                    page={services.data!}
                    shown={services.data!.services.length}
                    noun="services"
                    onChange={setOffset}
                  />
                )}
                {target.isFetching && (
                  <p role="status">Loading service components…</p>
                )}
                {currentTarget && (
                  <label>
                    Component (optional)
                    <select
                      value={selectedComponent}
                      onChange={(event) =>
                        setSelectedComponent(event.target.value)
                      }
                    >
                      <option value="">Whole service</option>
                      {selectedComponent &&
                        !currentTarget.components.some(
                          (c) => c.id === selectedComponent,
                        ) && (
                          <option value={selectedComponent}>
                            Unavailable component
                          </option>
                        )}
                      {currentTarget.components.map((c) => (
                        <option key={c.id} value={c.id}>
                          {components[c.kind]} ({c.providerLabel})
                        </option>
                      ))}
                    </select>
                    {!validTarget && (
                      <span className="support-warning">
                        Choose a component of this service.
                      </span>
                    )}
                  </label>
                )}
                <label>
                  Subject (required)
                  <input
                    required
                    maxLength={256}
                    value={subject}
                    onChange={(event) => setSubject(event.target.value)}
                  />
                </label>
                <label>
                  Message (required)
                  <textarea
                    required
                    maxLength={10000}
                    value={body}
                    onChange={(event) => setBody(event.target.value)}
                  />
                </label>
                <button
                  className="account-primary-button"
                  disabled={
                    !validTarget ||
                    !subject.trim() ||
                    !body.trim() ||
                    target.isFetching
                  }
                  type="submit"
                >
                  Open request
                </button>
              </fieldset>
            </form>
            {create.isError && (
              <p role="alert">
                {needsReview
                  ? "This request conflicts with a recent change. Reload and review your entered details before submitting again."
                  : create.error.message}
              </p>
            )}
            {needsReview && (
              <button
                className="secondary-button"
                type="button"
                onClick={() => void reload()}
              >
                Reload and review
              </button>
            )}
          </>
        )}
      </section>
    </div>
  );
}

type CommandBody =
  | ReplyRequest
  | AddNoteRequest
  | ProposeRequest
  | ApproveRequest
  | RecordResultRequest;
type Intent =
  | Omit<ReplyRequest, "requestId" | "expectedVersion">
  | Omit<ProposeRequest, "requestId" | "expectedVersion">
  | Omit<ApproveRequest, "requestId" | "expectedVersion">
  | {
      outcome: "completed";
      proposalId: string;
      proposalVersion: number;
      body: string;
      verifiedAt: string;
    }
  | { outcome: "unchanged"; body: string; verifiedAt: string };
type Submit = (operation: string, input: Intent, done?: () => void) => void;
export function SupportTicketPage({
  customerId,
  ticketId,
}: {
  customerId: string;
  ticketId: string;
}) {
  const session = useSession();
  const user = !session.isError && session.data?.user;
  if (!user) return <SessionNotice session={session} />;
  return (
    <TicketDetail
      key={`${user.id}/${customerId}/${ticketId}`}
      customerId={customerId}
      ticketId={ticketId}
      userId={user.id}
    />
  );
}
function TicketDetail({
  customerId,
  ticketId,
  userId,
}: {
  customerId: string;
  ticketId: string;
  userId: string;
}) {
  const [offset, setOffset] = useState(0);
  const [needsReview, setNeedsReview] = useState(false);
  const [saved, setSaved] = useState("");
  const attempt = useRef<{
    intent: string;
    input: Intent & { expectedVersion: number };
  } | null>(null);
  const cache = useQueryClient();
  const requestId = useRequestId();
  const prefix = ["support", userId, customerId, "ticket", ticketId];
  const detail = useQuery<TicketResponse>({
    queryKey: [...prefix, offset],
    placeholderData: (previous) => previous,
    queryFn: ({ signal }) =>
      request<TicketResponse>(
        `${ticketsPath(customerId, ticketId)}?limit=${pageSize}&offset=${offset}`,
        { signal },
      ),
    retry: false,
  });
  const targetId = detail.data?.ticket.serviceId;
  const target = useQuery({
    queryKey: ["support", userId, customerId, "target", targetId],
    queryFn: ({ signal }) =>
      request<ServiceResponse>(servicePath(customerId, targetId), { signal }),
    enabled: Boolean(targetId) && !detail.isError,
    retry: false,
  });
  const mutation = useMutation({
    mutationFn: ({
      operation,
      input,
    }: {
      operation: string;
      input: CommandBody;
      done?: () => void;
    }) =>
      command<TicketResponse>(
        `${ticketsPath(customerId, ticketId)}/${operation}`,
        input,
      ),
    retry: false,
    onSuccess: async (_, variables) => {
      requestId.reset();
      attempt.current = null;
      // Command responses contain only the first entry page. Refetch the current page and every cached page instead.
      await Promise.all([
        cache.invalidateQueries({ queryKey: prefix }),
        cache.invalidateQueries({
          queryKey: ["support", userId, customerId, "list"],
        }),
      ]);
      variables.done?.();
      setSaved(
        variables.operation === "approvals" ? "Revision approved." : "Saved.",
      );
    },
    onError: (error) => {
      setSaved("");
      if (error instanceof AccountError && error.status === 409)
        setNeedsReview(true);
    },
  });
  const submit: Submit = (operation, input, done) => {
    if (
      !detail.data ||
      needsReview ||
      mutation.isPending ||
      detail.isFetching ||
      detail.isError
    )
      return;
    setSaved("");
    const intent = JSON.stringify({ operation, input });
    // Keep the exact payload after an uncertain outcome, even if a focus refresh advances the version.
    if (attempt.current?.intent !== intent)
      attempt.current = {
        intent,
        input: { ...input, expectedVersion: detail.data.ticket.version },
      };
    const versioned = attempt.current.input;
    mutation.mutate({
      operation,
      input: {
        ...versioned,
        requestId: requestId.get({ operation, ...versioned }),
      },
      done,
    });
  };
  async function reload() {
    const result = await detail.refetch();
    if (!result.isError) {
      attempt.current = null;
      setNeedsReview(false);
      mutation.reset();
      setSaved(
        "Review the current request and proposal before submitting again.",
      );
    }
  }
  const unavailable =
    detail.error ?? (privateFailure(mutation.error) ? mutation.error : null);
  if (unavailable)
    return (
      <div className="account-page">
        <PageHeader
          customerId={customerId}
          title="Support request unavailable"
          backToTickets
        />
        <p className="panel account-section" role="alert">
          {unavailable.message}
        </p>
      </div>
    );
  if (!detail.data)
    return (
      <div className="account-page">
        <PageHeader
          customerId={customerId}
          title="Support request"
          backToTickets
        />
        <p role="status">Loading request…</p>
      </div>
    );
  const data = detail.data;
  const locked = needsReview || mutation.isPending || detail.isFetching;
  const component = !target.isError
    ? target.data?.service.components.find(
        (c) => c.id === data.ticket.componentId,
      )
    : undefined;
  return (
    <div className="account-page support-page">
      <PageHeader
        customerId={customerId}
        title={data.ticket.subject}
        backToTickets
      />
      <div className="support-context">
        <span className="status-tag">
          {data.ticket.status === "open" ? "Open" : "Resolved"}
        </span>
        <Link
          to="/customers/$customerId/services/$serviceId"
          params={{ customerId, serviceId: data.ticket.serviceId }}
        >
          {!target.isError && target.data
            ? target.data.service.name
            : "Related service"}
        </Link>
        {data.ticket.componentId && (
          <span>
            {component
              ? `${components[component.kind]} (${component.providerLabel})`
              : "Selected component"}
          </span>
        )}
      </div>
      <section className="panel account-section" aria-label="Conversation">
        <ol className="support-thread">
          {data.entries.map((entry) => (
            <li
              key={entry.id}
              className={
                entry.kind === "note"
                  ? "support-entry support-internal"
                  : "support-entry"
              }
            >
              <div className="support-entry-meta">
                {entry.kind !== "reply" && (
                  <strong>
                    {entry.kind === "note"
                      ? "Internal note · staff only"
                      : "Verified result"}
                  </strong>
                )}
                <span className="account-note">
                  {entry.authorUserId} · {date(entry.createdAt)}
                </span>
              </div>
              <p className="support-prose">{entry.body}</p>
              {entry.result && (
                <dl className="support-facts">
                  <div>
                    <dt>Outcome</dt>
                    <dd>
                      {entry.result.outcome === "completed"
                        ? `Completed revision ${entry.result.proposalVersion}`
                        : "Closed without changes"}
                    </dd>
                  </div>
                  <div>
                    <dt>Verified</dt>
                    <dd>{date(entry.result.verifiedAt)}</dd>
                  </div>
                  {entry.result.approvedTarget && (
                    <div>
                      <dt>Approved target</dt>
                      <dd>
                        <TargetFacts target={entry.result.approvedTarget} />
                      </dd>
                    </div>
                  )}
                  <div>
                    <dt>Target at verification</dt>
                    <dd>
                      <TargetFacts target={entry.result.observedTarget} />
                    </dd>
                  </div>
                </dl>
              )}
            </li>
          ))}
        </ol>
        <Pages
          page={data}
          shown={data.entries.length}
          noun="entries"
          onChange={setOffset}
          disabled={locked}
        />
      </section>
      {data.latestProposal && (
        <Proposal
          proposal={data.latestProposal}
          data={data}
          locked={locked}
          submit={submit}
        />
      )}
      {(mutation.isError || needsReview || saved) && (
        <section className="panel account-section" aria-label="Action status">
          {mutation.isError && (
            <p role="alert">
              {needsReview
                ? "This request changed. Your entered details are retained. Reload and review before submitting again."
                : mutation.error.message}
            </p>
          )}
          {saved && <p role="status">{saved}</p>}
          {needsReview && (
            <button
              className="secondary-button"
              type="button"
              disabled={detail.isFetching}
              onClick={() => void reload()}
            >
              Reload and review
            </button>
          )}
        </section>
      )}
      {data.permissions.canReply && (
        <MessageForm
          heading="Public reply"
          label="Reply (required)"
          action={
            data.ticket.status === "resolved"
              ? "Reply and reopen"
              : "Send reply"
          }
          locked={locked}
          onSubmit={(body, done) => submit("replies", { body }, done)}
        />
      )}
      {data.permissions.canManage && (
        <>
          <MessageForm
            heading="Internal note"
            label="Internal note (required)"
            action="Add internal note"
            locked={locked}
            onSubmit={(body, done) => submit("notes", { body }, done)}
            note="Only support staff can read this note."
          />
          {data.ticket.status === "open" && (
            <>
              <ProposalForm
                proposal={data.latestProposal}
                locked={locked}
                submit={submit}
              />
              <ResultForm
                proposal={data.latestProposal}
                locked={locked}
                submit={submit}
              />
            </>
          )}
        </>
      )}
    </div>
  );
}
function TargetFacts({ target }: { target: SupportTarget }) {
  return (
    <>
      {target.service.name}
      {target.component && ` · ${components[target.component.kind]}`}
      <span className="account-note">
        Service version {target.service.version}
        {target.component && `, component version ${target.component.version}`}
      </span>
    </>
  );
}
function Proposal({
  proposal,
  data,
  locked,
  submit,
}: {
  proposal: SupportProposal;
  data: TicketResponse;
  locked: boolean;
  submit: Submit;
}) {
  const approval = proposal.approval;
  return (
    <section className="panel account-section">
      <h2>Proposed change · revision {proposal.version}</h2>
      <p className="support-prose">{proposal.action}</p>
      <p className="account-note">
        Prepared by {proposal.preparedByUserId} · {date(proposal.createdAt)}
      </p>
      <dl className="support-facts support-proposal-facts">
        <div>
          <dt>Cost</dt>
          {proposal.cost.kind === "known" ? (
            <dd>
              {money(proposal.cost.amountMinor)} USD
              <span className="account-note support-prose">
                {proposal.cost.description}
              </span>
            </dd>
          ) : (
            <dd>
              <span className="support-warning">
                Unknown · approval unavailable
              </span>
              <span className="account-note support-prose">
                {proposal.cost.reason}
              </span>
            </dd>
          )}
        </div>
        <div>
          <dt>Data consequences</dt>
          {proposal.dataEffect.kind === "known" ? (
            <dd className="support-prose">{proposal.dataEffect.description}</dd>
          ) : (
            <dd>
              <span className="support-warning">
                Unknown · approval unavailable
              </span>
              <span className="account-note support-prose">
                {proposal.dataEffect.reason}
              </span>
            </dd>
          )}
        </div>
        <div>
          <dt>Target</dt>
          <dd>
            <TargetFacts target={proposal.target} />
          </dd>
        </div>
      </dl>
      {approval ? (
        <div className="support-approval">
          <p>
            Approved revision {approval.proposalVersion} by{" "}
            {approval.approvedByUserId} · {date(approval.approvedAt)}
          </p>
          {approval.staffAttribution?.invitedByStaff === true && (
            <p className="support-warning">
              Approved by a staff-invited administrator.
            </p>
          )}
        </div>
      ) : (
        <>
          {data.permissions.approvalBlockedReason && (
            <p className="support-warning">
              {blockedCopy[data.permissions.approvalBlockedReason]}
            </p>
          )}
          {data.permissions.canApprove && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (!locked)
                  submit("approvals", {
                    proposalId: proposal.id,
                    proposalVersion: proposal.version,
                  });
              }}
            >
              <p className="account-note">
                Approval applies to revision {proposal.version}, with the cost,
                data consequences and target shown above.
              </p>
              <button
                type="submit"
                className="account-primary-button"
                disabled={locked}
              >
                Approve revision {proposal.version}
              </button>
            </form>
          )}
        </>
      )}
    </section>
  );
}
function MessageForm({
  heading,
  label,
  action,
  locked,
  onSubmit,
  note,
}: {
  heading: string;
  label: string;
  action: string;
  locked: boolean;
  onSubmit: (body: string, done: () => void) => void;
  note?: string;
}) {
  const [body, setBody] = useState("");
  return (
    <section className="panel account-section" aria-label={heading}>
      <form
        className="account-form support-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!locked && body.trim()) onSubmit(body, () => setBody(""));
        }}
      >
        <fieldset disabled={locked}>
          <label>
            {label}
            <textarea
              required
              maxLength={10000}
              value={body}
              onChange={(event) => setBody(event.target.value)}
            />
            {note && <span className="account-note">{note}</span>}
          </label>
          <button
            type="submit"
            className="account-primary-button"
            disabled={!body.trim()}
          >
            {action}
          </button>
        </fieldset>
      </form>
    </section>
  );
}
function DisclosureField({
  title,
  kind,
  setKind,
  text,
  setText,
  children,
}: {
  title: string;
  kind: "known" | "unknown";
  setKind: (value: "known" | "unknown") => void;
  text: string;
  setText: (value: string) => void;
  children?: ReactNode;
}) {
  return (
    <div className="support-disclosure-field">
      <label>
        {title}
        <select
          value={kind}
          onChange={(event) =>
            setKind(event.target.value === "known" ? "known" : "unknown")
          }
        >
          <option value="known">Known</option>
          <option value="unknown">Unknown</option>
        </select>
      </label>
      {children}
      <label>
        {kind === "known"
          ? `${title} explanation (required)`
          : `${title} unknown reason (required)`}
        <textarea
          required
          maxLength={2000}
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
      </label>
      {kind === "unknown" && (
        <p className="support-warning">
          Unknown {title.toLowerCase()} blocks customer approval.
        </p>
      )}
    </div>
  );
}
function ProposalForm({
  proposal,
  locked,
  submit,
}: {
  proposal: SupportProposal | null;
  locked: boolean;
  submit: Submit;
}) {
  const [action, setAction] = useState("");
  const [costKind, setCostKind] = useState<"known" | "unknown">("known");
  const [amount, setAmount] = useState("");
  const [costText, setCostText] = useState("");
  const [dataKind, setDataKind] = useState<"known" | "unknown">("known");
  const [dataText, setDataText] = useState("");
  const amountValid =
    /^\d{1,6}(\.\d{1,2})?$/.test(amount) &&
    Math.round(Number(amount) * 100) <= 99999999;
  const valid =
    action.trim() &&
    costText.trim() &&
    dataText.trim() &&
    (costKind === "unknown" || amountValid);
  return (
    <section className="panel account-section">
      <h2>{proposal ? "Revise proposed change" : "Prepare proposed change"}</h2>
      {proposal && (
        <p className="account-note">
          A new revision replaces revision {proposal.version} and requires fresh
          customer approval.
        </p>
      )}
      <form
        className="account-form support-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (locked || !valid) return;
          const cost: ProposeRequest["cost"] =
            costKind === "known"
              ? {
                  kind: "known",
                  currency: "USD",
                  amountMinor: Math.round(Number(amount) * 100),
                  description: costText,
                }
              : { kind: "unknown", reason: costText };
          const dataEffect: ProposeRequest["dataEffect"] =
            dataKind === "known"
              ? { kind: "known", description: dataText }
              : { kind: "unknown", reason: dataText };
          submit("proposals", { action, cost, dataEffect }, () => {
            setAction("");
            setAmount("");
            setCostText("");
            setDataText("");
          });
        }}
      >
        <fieldset disabled={locked}>
          <label>
            Requested change (required)
            <textarea
              required
              maxLength={2000}
              value={action}
              onChange={(event) => setAction(event.target.value)}
            />
          </label>
          <div className="support-disclosure-fields">
            <DisclosureField
              title="Cost"
              kind={costKind}
              setKind={setCostKind}
              text={costText}
              setText={setCostText}
            >
              {costKind === "known" && (
                <label>
                  Cost in USD (required)
                  <input
                    required
                    inputMode="decimal"
                    value={amount}
                    onChange={(event) => setAmount(event.target.value)}
                  />
                  <span className="account-note">
                    Enter dollars and cents, including 0 for no charge.
                  </span>
                </label>
              )}
            </DisclosureField>
            <DisclosureField
              title="Data consequences"
              kind={dataKind}
              setKind={setDataKind}
              text={dataText}
              setText={setDataText}
            />
          </div>
          <button
            className="account-primary-button"
            type="submit"
            disabled={!valid}
          >
            {proposal ? "Save new revision" : "Prepare proposal"}
          </button>
        </fieldset>
      </form>
    </section>
  );
}
function ResultForm({
  proposal,
  locked,
  submit,
}: {
  proposal: SupportProposal | null;
  locked: boolean;
  submit: Submit;
}) {
  const [outcome, setOutcome] = useState<"completed" | "unchanged">(
    "unchanged",
  );
  const [body, setBody] = useState("");
  const [verifiedAt, setVerifiedAt] = useState("");
  const [useServerTime, setUseServerTime] = useState(false);
  const approval = proposal?.approval;
  const completedAllowed = Boolean(
    proposal &&
    approval &&
    approval.proposalId === proposal.id &&
    approval.proposalVersion === proposal.version,
  );
  const verified = new Date(verifiedAt);
  const validTime = useServerTime || Number.isFinite(verified.getTime());
  const valid =
    body.trim() && validTime && (outcome === "unchanged" || completedAllowed);
  return (
    <section className="panel account-section">
      <h2>Record verified result</h2>
      <form
        className="account-form support-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (locked || !valid) return;
          const input = {
            body,
            verifiedAt: useServerTime ? "now" : verified.toISOString(),
          };
          submit(
            "result",
            outcome === "completed" && proposal
              ? {
                  ...input,
                  outcome,
                  proposalId: proposal.id,
                  proposalVersion: proposal.version,
                }
              : { ...input, outcome: "unchanged" },
            () => {
              setBody("");
              setVerifiedAt("");
              setUseServerTime(false);
            },
          );
        }}
      >
        <fieldset disabled={locked}>
          <label>
            Result
            <select
              aria-label="Result"
              value={outcome}
              onChange={(event) =>
                setOutcome(
                  event.target.value === "completed"
                    ? "completed"
                    : "unchanged",
                )
              }
            >
              <option value="unchanged">Close without changes</option>
              <option value="completed" disabled={!completedAllowed}>
                Completed approved change
              </option>
            </select>
          </label>
          {!completedAllowed && (
            <p className="account-note">
              Completed work requires approval of the latest proposal revision.
              You can close without changes.
            </p>
          )}
          <label>
            Verification details (required)
            <textarea
              required
              maxLength={10000}
              value={body}
              onChange={(event) => setBody(event.target.value)}
            />
          </label>
          <label>
            Verified at
            <input
              type="datetime-local"
              step="0.001"
              required={!useServerTime}
              value={verifiedAt}
              onChange={(event) => {
                setVerifiedAt(event.target.value);
                setUseServerTime(false);
              }}
              aria-describedby="support-verification-time-help"
            />
          </label>
          <span id="support-verification-time-help" className="account-note">
            {useServerTime
              ? "The server records the time when you submit the result."
              : "Enter when you verified the result in your local time, or use current time."}
          </span>
          <button
            className="secondary-button"
            type="button"
            aria-pressed={useServerTime}
            onClick={() => {
              setVerifiedAt("");
              setUseServerTime(true);
            }}
          >
            Use current time
          </button>
          <p className="account-note">
            Recording a result resolves this request and sends no provider or
            billing command.
          </p>
          <button
            className="account-primary-button"
            type="submit"
            disabled={!valid}
          >
            Record result and resolve
          </button>
        </fieldset>
      </form>
    </section>
  );
}
