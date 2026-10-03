import { useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type {
  AccessActionResponse,
  AccessSessionResponse,
  CustomerRole,
  InvitationsResponse,
  MembersResponse,
} from "../../access/contract";
import type {
  CustomerProfile,
  CustomerResponse,
  CustomersResponse,
  ProviderProfileState,
  UpdateCustomerRequest,
  UpdateCustomerResponse,
} from "../../customers/contract";
import {
  AccountError,
  command,
  request,
  useRequestId,
  useSession,
} from "./api";
import { SampleAccounts, SampleProfileNote } from "./sample";
import "./accounts.css";

const pageSize = 50;
const roleLabels: Record<CustomerRole, string> = {
  administrator: "Administrator",
  member: "Member",
};
const invitationStatusLabels = {
  pending: "Awaiting acceptance",
  accepted: "Accepted",
  revoked: "Revoked",
  expired: "Expired",
};
const providerProfileNotes: Record<ProviderProfileState, string> = {
  pending:
    "The legal name or billing email differs from the billing details recorded when the payment account was created. Sending profile changes to the provider is not available yet.",
  unchanged:
    "The legal name and billing email match the billing details recorded when the payment account was created.",
  not_linked: "This customer is not connected to a payment provider.",
};

function returnURL(fallback = "/customers") {
  const value = new URLSearchParams(location.search).get("returnTo");
  if (value) {
    try {
      const url = new URL(value, location.origin);
      if (url.origin === location.origin) return url.href;
    } catch {
      // Malformed return destinations use the default account page.
    }
  }
  return `${location.origin}${fallback}`;
}
function signInURL() {
  return `/sign-in?returnTo=${encodeURIComponent(location.href)}`;
}

function SessionNotice({
  session,
}: {
  session: ReturnType<typeof useSession>;
}) {
  if (session.isPending)
    return (
      <p className="panel state-panel" role="status">
        Checking your session…
      </p>
    );
  return (
    <section className="panel state-panel">
      {session.isError ? (
        <>
          <h1>Account unavailable</h1>
          <p role="alert">{session.error.message}</p>
        </>
      ) : session.data === null ? (
        <>
          <h1>Account unavailable</h1>
          <p>Customer accounts are not part of this viewer.</p>
        </>
      ) : (
        <>
          <h1>Sign in to continue</h1>
          <a className="account-primary-button" href={signInURL()}>
            Sign in
          </a>
        </>
      )}
    </section>
  );
}

function ActionResult({
  result,
}: {
  result: AccessActionResponse | undefined;
}) {
  if (!result) return null;
  return (
    <p role="status" className="account-note">
      {result.state === "completed"
        ? "Completed."
        : result.state === "pending"
          ? "Pending. The result is not confirmed yet. Check the result before trying anything else."
          : "Needs review. An operator must check this action before access is confirmed."}
    </p>
  );
}

function Pages({
  offset,
  total,
  shown,
  onChange,
  label,
}: {
  offset: number;
  total: number;
  shown: number;
  onChange: (offset: number) => void;
  label: string;
}) {
  if (total <= pageSize && offset === 0) return null;
  return (
    <nav className="pagination" aria-label={label}>
      <span>
        {shown
          ? `${offset + 1}–${offset + shown} of ${total}`
          : `0 of ${total}`}
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
          disabled={offset + pageSize >= total || offset + pageSize > 1000000}
          onClick={() => onChange(offset + pageSize)}
        >
          Next
        </button>
      </div>
    </nav>
  );
}

export function SignOutButton() {
  const client = useQueryClient();
  const signOut = useMutation({
    mutationFn: () => command<unknown>("/api/auth/sign-out", {}),
    retry: false,
    onSuccess: async () => {
      await client.cancelQueries();
      client.clear();
      // A full load leaves nothing from the previous session in memory.
      location.assign("/sign-in");
    },
  });
  return (
    <>
      <button
        className="text-button"
        disabled={signOut.isPending}
        onClick={() => signOut.mutate()}
      >
        {signOut.isPending ? "Signing out…" : "Sign out"}
      </button>
      {signOut.isError && <span role="alert">{signOut.error.message}</span>}
    </>
  );
}

export function SignIn() {
  const session = useSession();
  const [email, setEmail] = useState("");
  const emailLink = useMutation({
    mutationFn: () =>
      command<unknown>("/api/auth/sign-in/magic-link", {
        email,
        callbackURL: returnURL(),
      }),
    retry: false,
  });
  const social = useMutation({
    mutationFn: (provider: "google" | "microsoft") =>
      command<{ url: string }>("/api/auth/sign-in/social", {
        provider,
        callbackURL: returnURL(),
      }),
    retry: false,
    onSuccess: (response) => {
      const url = new URL(response.url);
      if (url.protocol !== "https:" && url.protocol !== "http:")
        throw new Error("The sign-in destination is unavailable.");
      location.assign(url.href);
    },
  });
  const enabled = session.data?.signInMethods ?? [];
  const pending = emailLink.isPending || social.isPending;
  const providers = [
    { id: "google", name: "Google" },
    { id: "microsoft", name: "Microsoft" },
  ] as const;
  const unavailable = providers.filter(
    (provider) => !enabled.includes(provider.id),
  );
  const sample = session.data?.synthetic && enabled.includes("email_link");
  return (
    <div className="account-page account-sign-in">
      <h1>Sign in</h1>
      <section className="panel account-section">
        {session.isPending && <p role="status">Loading sign-in methods…</p>}
        {session.isError && <p role="alert">{session.error.message}</p>}
        {session.data === null && <p>Sign-in is not part of this viewer.</p>}
        {session.data?.user ? (
          <>
            <p>You are signed in as {session.data.user.name}.</p>
            <a className="account-primary-button" href={returnURL()}>
              Continue to your account
            </a>
          </>
        ) : (
          session.data && (
            <>
              <form
                className="account-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  emailLink.mutate();
                }}
              >
                <label>
                  Email address (required)
                  <input
                    type="email"
                    name="email"
                    autoComplete="email"
                    required
                    maxLength={254}
                    placeholder={sample ? "staff@example.test" : undefined}
                    aria-describedby="sign-in-hint"
                    value={email}
                    onChange={(event) => {
                      setEmail(event.target.value);
                      emailLink.reset();
                    }}
                    disabled={pending || !enabled.includes("email_link")}
                  />
                  <span id="sign-in-hint" className="account-note">
                    {enabled.includes("email_link")
                      ? "We email you a one-time link that signs you in."
                      : "Email sign-in is unavailable until configured."}
                  </span>
                </label>
                <div className="account-actions">
                  <button
                    className="account-primary-button"
                    type="submit"
                    disabled={pending || !enabled.includes("email_link")}
                  >
                    {emailLink.isPending
                      ? "Sending link…"
                      : "Send sign-in link"}
                  </button>
                </div>
                {emailLink.isSuccess && (
                  <p role="status">Check your inbox for a sign-in link.</p>
                )}
                {emailLink.isError && (
                  <p role="alert">{emailLink.error.message}</p>
                )}
              </form>
              <div className="account-providers">
                <div className="account-actions">
                  {providers.map((provider) => (
                    <button
                      key={provider.id}
                      className="secondary-button"
                      disabled={pending || !enabled.includes(provider.id)}
                      onClick={() => social.mutate(provider.id)}
                    >
                      Sign in with {provider.name}
                    </button>
                  ))}
                </div>
                {unavailable.length > 0 && (
                  <p className="account-note">
                    {unavailable.map((provider) => provider.name).join(" and ")}{" "}
                    sign-in {unavailable.length > 1 ? "are" : "is"} unavailable
                    until configured.
                  </p>
                )}
                {social.isPending && <p role="status">Opening sign-in…</p>}
                {social.isError && <p role="alert">{social.error.message}</p>}
              </div>
            </>
          )
        )}
      </section>
      {sample && !session.data?.user && <SampleAccounts />}
    </div>
  );
}

export function CustomersPage() {
  const session = useSession();
  const [offset, setOffset] = useState(0);
  const user = !session.isError && session.data?.user;
  const list = useQuery({
    queryKey: ["accounts", user && user.id, "customers", offset],
    queryFn: ({ signal }) =>
      request<CustomersResponse>(
        `/api/customers?limit=${pageSize}&offset=${offset}`,
        { signal },
      ),
    enabled: Boolean(user),
    retry: false,
  });
  if (!user) return <SessionNotice session={session} />;
  return (
    <div className="account-page">
      <h1>Customers</h1>
      <section className="panel account-section" aria-label="Customer list">
        {list.isPending && <p role="status">Loading customers…</p>}
        {list.isError && <p role="alert">{list.error.message}</p>}
        {!list.isError && list.data && (
          <>
            {list.data.total === 0 ? (
              <p>
                You do not have access to any customer accounts yet. Ask an
                account administrator to invite you.
              </p>
            ) : (
              <ul className="account-rows">
                {list.data.customers.map((customer) => (
                  <li key={customer.id}>
                    <Link
                      className="account-customer-link"
                      to="/customers/$customerId"
                      params={{ customerId: customer.id }}
                    >
                      <span>{customer.displayName}</span>
                      {customer.role && (
                        <span className="account-note">
                          {roleLabels[customer.role]}
                        </span>
                      )}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            <Pages
              offset={offset}
              total={list.data.total}
              shown={list.data.customers.length}
              onChange={setOffset}
              label="Customer pages"
            />
          </>
        )}
      </section>
    </div>
  );
}

export function CustomerPage({ customerId }: { customerId: string }) {
  const session = useSession();
  const user = !session.isError && session.data?.user;
  const detail = useQuery({
    queryKey: ["accounts", user && user.id, "customer", customerId],
    queryFn: ({ signal }) =>
      request<CustomerResponse>(
        `/api/customers/${encodeURIComponent(customerId)}`,
        { signal },
      ),
    enabled: Boolean(user),
    retry: false,
  });
  if (!user) return <SessionNotice session={session} />;
  const customer = !detail.isError && detail.data?.customer;
  return (
    <div className="account-page">
      <header className="account-page-header">
        <Link className="account-back" to="/customers">
          All customers
        </Link>
        <h1>{customer ? customer.displayName : "Customer"}</h1>
        {customer && customer.role && (
          <p className="account-note">Your role: {roleLabels[customer.role]}</p>
        )}
        {customer && (
          <Link to="/customers/$customerId/services" params={{ customerId }}>
            Services
          </Link>
        )}
      </header>
      {detail.isPending && (
        <p className="panel state-panel" role="status">
          Loading customer…
        </p>
      )}
      {detail.isError && (
        <p className="panel state-panel" role="alert">
          {detail.error.message}
        </p>
      )}
      {customer && (
        <>
          <section className="panel account-section">
            <h2>Profile</h2>
            {customer.canEditProfile ? (
              <ProfileEditor
                key={`${user.id}:${customerId}`}
                userId={user.id}
                customer={customer}
                sample={session.data?.synthetic === true}
              />
            ) : (
              <dl className="account-facts">
                <div>
                  <dt>Display name</dt>
                  <dd>{customer.profile.displayName}</dd>
                </div>
                <div>
                  <dt>Legal name</dt>
                  <dd>{customer.profile.legalName}</dd>
                </div>
                <div>
                  <dt>Billing email</dt>
                  <dd>{customer.profile.billingEmail ?? "Not provided"}</dd>
                </div>
              </dl>
            )}
            <div className="account-section-notes">
              <p className="account-note">
                {providerProfileNotes[customer.providerProfileState]}
              </p>
              <p className="account-note">
                Issued invoices keep the billing details they were issued with.
              </p>
            </div>
          </section>
          {customer.canManageMembers && (
            <Memberships
              key={`${user.id}:${customerId}`}
              userId={user.id}
              customerId={customerId}
            />
          )}
        </>
      )}
    </div>
  );
}

function ProfileEditor({
  userId,
  customer,
  sample,
}: {
  userId: string;
  customer: CustomerResponse["customer"];
  sample: boolean;
}) {
  const [profile, setProfile] = useState<CustomerProfile>(customer.profile);
  const [version, setVersion] = useState(customer.version);
  const [conflict, setConflict] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const client = useQueryClient();
  const requestId = useRequestId();
  const queryKey = ["accounts", userId, "customer", customer.id];
  const update = useMutation({
    mutationFn: (body: UpdateCustomerRequest) =>
      command<UpdateCustomerResponse>(
        `/api/customers/${encodeURIComponent(customer.id)}`,
        body,
        "PATCH",
      ),
    retry: false,
    onSuccess: (result) => {
      client.setQueryData(queryKey, { customer: result.customer });
      setVersion(result.customer.version);
      setProfile(result.customer.profile);
      setReviewed(false);
      void client.invalidateQueries({
        queryKey: ["accounts", userId, "customers"],
      });
    },
    onError: (error) => {
      if (error instanceof AccountError && error.status === 409)
        setConflict(true);
    },
  });
  const reload = useMutation({
    mutationFn: () =>
      request<CustomerResponse>(
        `/api/customers/${encodeURIComponent(customer.id)}`,
      ),
    retry: false,
    onSuccess: (result) => {
      client.setQueryData(queryKey, result);
      setProfile(result.customer.profile);
      setVersion(result.customer.version);
      setConflict(false);
      setReviewed(true);
      requestId.reset();
      update.reset();
    },
  });
  const change = (field: keyof CustomerProfile, value: string) => {
    const nextValue = field === "billingEmail" && value === "" ? null : value;
    if (profile[field] !== nextValue) requestId.reset();
    setProfile((current) => ({
      ...current,
      [field]: nextValue,
    }));
    update.reset();
    setReviewed(false);
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const input = { expectedVersion: version, profile };
    update.mutate({ ...input, requestId: requestId.get(input) });
  };
  const locked = update.isPending || reload.isPending || conflict;
  return (
    <form className="account-form" onSubmit={submit}>
      <fieldset disabled={locked}>
        <label>
          Display name (required)
          <input
            required
            maxLength={256}
            value={profile.displayName}
            onChange={(event) => change("displayName", event.target.value)}
          />
        </label>
        <label>
          Legal name (required)
          <input
            required
            maxLength={256}
            value={profile.legalName}
            onChange={(event) => change("legalName", event.target.value)}
          />
        </label>
        <label>
          Billing email
          <input
            type="email"
            maxLength={254}
            aria-describedby="billing-email-hint"
            value={profile.billingEmail ?? ""}
            onChange={(event) => change("billingEmail", event.target.value)}
          />
          <span id="billing-email-hint" className="account-note">
            Receives billing notifications. It does not give access to this
            account.
          </span>
        </label>
      </fieldset>
      {sample && <SampleProfileNote profile={customer.profile} />}
      <div className="account-actions">
        <button
          className="account-primary-button"
          type="submit"
          disabled={locked}
        >
          {update.isPending ? "Saving…" : "Save profile"}
        </button>
        {update.isSuccess && (
          <p role="status">
            {update.data.outcome === "updated"
              ? "Profile saved."
              : "Profile unchanged."}
          </p>
        )}
      </div>
      {update.isError && <p role="alert">{update.error.message}</p>}
      {conflict && (
        <div className="account-actions">
          <button
            className="secondary-button"
            type="button"
            disabled={reload.isPending}
            onClick={() => reload.mutate()}
          >
            {reload.isPending ? "Reloading…" : "Reload latest profile"}
          </button>
        </div>
      )}
      {reload.isError && <p role="alert">{reload.error.message}</p>}
      {reviewed && (
        <p role="status">
          Latest profile loaded. Review these fields before saving again.
        </p>
      )}
    </form>
  );
}

function Memberships({
  userId,
  customerId,
}: {
  userId: string;
  customerId: string;
}) {
  const [membersOffset, setMembersOffset] = useState(0);
  const [invitationsOffset, setInvitationsOffset] = useState(0);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<CustomerRole>("member");
  const client = useQueryClient();
  const requestId = useRequestId();
  const root = `/api/customers/${encodeURIComponent(customerId)}`;
  const scope = ["accounts", userId, "customer", customerId];
  const members = useQuery({
    queryKey: [...scope, "members", membersOffset],
    queryFn: ({ signal }) =>
      request<MembersResponse>(
        `${root}/members?limit=${pageSize}&offset=${membersOffset}`,
        { signal },
      ),
    retry: false,
  });
  const invitations = useQuery({
    queryKey: [...scope, "invitations", invitationsOffset],
    queryFn: ({ signal }) =>
      request<InvitationsResponse>(
        `${root}/invitations?limit=${pageSize}&offset=${invitationsOffset}`,
        { signal },
      ),
    retry: false,
  });
  const refresh = () => client.invalidateQueries({ queryKey: scope });
  const invite = useMutation({
    mutationFn: () => {
      const input = { email, role };
      return command<AccessActionResponse>(`${root}/invitations`, {
        ...input,
        requestId: requestId.get(input),
      });
    },
    retry: false,
    onSuccess: () => {
      void refresh();
    },
  });
  return (
    <>
      <section className="panel account-section">
        <h2>Members</h2>
        {members.isPending && <p role="status">Loading members…</p>}
        {members.isError && <p role="alert">{members.error.message}</p>}
        {!members.isError && members.data && (
          <>
            {members.data.total === 0 && <p>No members yet.</p>}
            <ul className="account-rows">
              {members.data.members.map((member) => (
                <AccountRow
                  key={member.id}
                  title={member.name}
                  detail={member.email}
                  role={member.role}
                >
                  <RevokeAction
                    path={`${root}/members/${encodeURIComponent(member.id)}/revoke`}
                    label="Remove member"
                    pendingLabel="Removing…"
                    checkLabel="Check removal result"
                    targetName={member.email}
                    refresh={refresh}
                  />
                </AccountRow>
              ))}
            </ul>
            <Pages
              offset={membersOffset}
              total={members.data.total}
              shown={members.data.members.length}
              onChange={setMembersOffset}
              label="Member pages"
            />
          </>
        )}
      </section>
      <section className="panel account-section">
        <h2>Invitations</h2>
        <form
          className="account-form account-invite-form"
          onSubmit={(event) => {
            event.preventDefault();
            invite.mutate();
          }}
        >
          <label>
            Email address (required)
            <input
              type="email"
              required
              maxLength={254}
              value={email}
              disabled={invite.isPending}
              onChange={(event) => {
                if (email !== event.target.value) requestId.reset();
                setEmail(event.target.value);
                invite.reset();
              }}
            />
          </label>
          <label>
            Role
            <select
              value={role}
              disabled={invite.isPending}
              onChange={(event) => {
                if (role !== event.target.value) requestId.reset();
                setRole(
                  event.target.value === "administrator"
                    ? "administrator"
                    : "member",
                );
                invite.reset();
              }}
            >
              <option value="member">Member</option>
              <option value="administrator">Administrator</option>
            </select>
          </label>
          <button
            className="account-primary-button"
            disabled={
              invite.isPending ||
              invite.data?.state === "completed" ||
              invite.data?.state === "needs_review"
            }
            type="submit"
          >
            {invite.isPending
              ? "Inviting…"
              : invite.data?.state === "pending"
                ? "Check invitation result"
                : "Invite member"}
          </button>
        </form>
        {invite.isError && <p role="alert">{invite.error.message}</p>}
        <ActionResult result={invite.data} />
        {invitations.isPending && <p role="status">Loading invitations…</p>}
        {invitations.isError && <p role="alert">{invitations.error.message}</p>}
        {!invitations.isError && invitations.data && (
          <>
            {invitations.data.total === 0 && (
              <p className="account-note">No invitations yet.</p>
            )}
            <ul className="account-rows">
              {invitations.data.invitations.map((invitation) => (
                <AccountRow
                  key={invitation.id}
                  title={invitation.email}
                  detail={
                    invitation.status === "pending" ? (
                      <>
                        {invitationStatusLabels.pending}. Expires{" "}
                        <time dateTime={invitation.expiresAt}>
                          {new Date(invitation.expiresAt).toLocaleString(
                            undefined,
                            {
                              year: "numeric",
                              month: "short",
                              day: "numeric",
                              hour: "numeric",
                              minute: "2-digit",
                              timeZoneName: "short",
                            },
                          )}
                        </time>
                      </>
                    ) : (
                      invitationStatusLabels[invitation.status]
                    )
                  }
                  role={invitation.role}
                >
                  {invitation.status === "pending" && (
                    <RevokeAction
                      path={`${root}/invitations/${encodeURIComponent(invitation.id)}/revoke`}
                      label="Revoke invitation"
                      pendingLabel="Revoking…"
                      checkLabel="Check revoke result"
                      targetName={invitation.email}
                      refresh={refresh}
                    />
                  )}
                </AccountRow>
              ))}
            </ul>
            <Pages
              offset={invitationsOffset}
              total={invitations.data.total}
              shown={invitations.data.invitations.length}
              onChange={setInvitationsOffset}
              label="Invitation pages"
            />
          </>
        )}
      </section>
    </>
  );
}

function AccountRow({
  title,
  detail,
  role,
  children,
}: {
  title: string;
  detail: ReactNode;
  role: CustomerRole;
  children: ReactNode;
}) {
  return (
    <li className="account-member-row">
      <div>
        <strong>{title}</strong>
        <p className="account-note">{detail}</p>
      </div>
      <p>{roleLabels[role]}</p>
      {children}
    </li>
  );
}

function RevokeAction({
  path,
  label,
  pendingLabel,
  checkLabel,
  targetName,
  refresh,
}: {
  path: string;
  label: string;
  pendingLabel: string;
  checkLabel: string;
  targetName: string;
  refresh: () => Promise<void>;
}) {
  const requestId = useRequestId();
  const revoke = useMutation({
    mutationFn: () =>
      command<AccessActionResponse>(path, { requestId: requestId.get(path) }),
    retry: false,
    onSuccess: () => {
      void refresh();
    },
  });
  return (
    <>
      <div className="account-row-action">
        <button
          className="secondary-button"
          aria-label={`${label}: ${targetName}`}
          disabled={
            revoke.isPending ||
            revoke.data?.state === "completed" ||
            revoke.data?.state === "needs_review"
          }
          onClick={() => revoke.mutate()}
        >
          {revoke.isPending
            ? pendingLabel
            : revoke.data?.state === "pending"
              ? checkLabel
              : label}
        </button>
      </div>
      {(revoke.isError || revoke.data) && (
        <div className="account-row-result">
          {revoke.isError && <p role="alert">{revoke.error.message}</p>}
          <ActionResult result={revoke.data} />
        </div>
      )}
    </>
  );
}

export function AcceptInvitation({ invitationId }: { invitationId: string }) {
  const session = useSession();
  const user = !session.isError && session.data?.user;
  if (!user) return <SessionNotice session={session} />;
  return (
    <InvitationAcceptance
      key={`${user.id}:${invitationId}`}
      invitationId={invitationId}
      user={user}
    />
  );
}

function InvitationAcceptance({
  invitationId,
  user,
}: {
  invitationId: string;
  user: NonNullable<AccessSessionResponse["user"]>;
}) {
  const client = useQueryClient();
  const requestId = useRequestId();
  const accept = useMutation({
    mutationFn: () =>
      command<AccessActionResponse>(
        `/api/access/invitations/${encodeURIComponent(invitationId)}/accept`,
        { requestId: requestId.get({ invitationId, userId: user.id }) },
      ),
    retry: false,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["accounts"] });
    },
  });
  return (
    <div className="account-page account-sign-in">
      <h1>Accept invitation</h1>
      <section className="panel account-section">
        <p>
          Accept to join the customer account that invited you. The invitation
          works only for the email address it was sent to.
        </p>
        {!user.emailVerified && (
          <p role="alert">
            Verify your email address before accepting this invitation.
          </p>
        )}
        <div className="account-actions">
          <button
            className="account-primary-button"
            disabled={
              !user.emailVerified ||
              accept.isPending ||
              accept.data?.state === "completed" ||
              accept.data?.state === "needs_review"
            }
            onClick={() => accept.mutate()}
          >
            {accept.isPending
              ? "Accepting…"
              : accept.data?.state === "pending"
                ? "Check acceptance result"
                : "Accept invitation"}
          </button>
        </div>
        {accept.isError && <p role="alert">{accept.error.message}</p>}
        {accept.error instanceof AccountError &&
          accept.error.status === 401 && (
            <a href={signInURL()}>Sign in to continue</a>
          )}
        <ActionResult result={accept.data} />
        {accept.data?.state === "completed" && (
          <Link to="/customers">View customers</Link>
        )}
      </section>
    </div>
  );
}
