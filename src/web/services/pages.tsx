import { useId, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AccountPaginationSchema } from "../../access/contract";
import type {
  AttachAddonRequest,
  ComponentKind,
  RequestedSetting,
  ServiceKind,
  ServiceResponse,
  ServiceSummary,
  ServicesResponse,
  SetComponentPreferenceRequest,
} from "../../services/contract";
import {
  AccountError,
  command,
  request,
  useRequestId,
  useSession,
} from "../accounts/api";
import "./services.css";

const pageSize = 50;
const kindLabels: Record<ServiceKind, string> = {
  hosting: "Hosting",
  addon: "Add-on",
  domain_registration: "Domain registration",
};
const componentLabels: Record<ComponentKind, string> = {
  web: "Web hosting",
  email: "Email hosting",
  dns: "DNS hosting",
};
const componentOrder: ComponentKind[] = ["web", "email", "dns"];
const includedLabels = { web: "web", email: "email", dns: "DNS" };
const settingLabels = { enabled: "Enabled", disabled: "Disabled" };
const managerLabels = { staff: "Staff", customer: "Customer" };
const checkedFormat: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZoneName: "short",
};
type Service = ServiceResponse["service"];
type Component = Service["components"][number];

function servicesPath(customerId: string) {
  return `/api/customers/${encodeURIComponent(customerId)}/services`;
}

function describe(service: ServiceSummary) {
  const kind =
    service.kind === "addon" && !service.attachedService
      ? "Unattached add-on"
      : kindLabels[service.kind];
  return service.packageName
    ? `${kind} on the ${service.packageName} package`
    : kind;
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
      <h1>
        {session.isError || session.data === null
          ? "Services unavailable"
          : "Sign in to continue"}
      </h1>
      {session.isError ? (
        <p role="alert">{session.error.message}</p>
      ) : session.data === null ? (
        <p>Customer services are not part of this viewer.</p>
      ) : (
        <a href={`/sign-in?returnTo=${encodeURIComponent(location.href)}`}>
          Sign in
        </a>
      )}
    </section>
  );
}

function Pages({
  page,
  shown,
  onChange,
  label,
}: {
  page: Pick<ServicesResponse, "limit" | "offset" | "total">;
  shown: number;
  onChange: (offset: number) => void;
  label: string;
}) {
  const next = page.offset + page.limit;
  const maximum = AccountPaginationSchema.properties.offset.maximum!;
  return (
    <nav className="pagination" aria-label={label}>
      <span>
        {shown
          ? `${page.offset + 1}–${page.offset + shown} of ${page.total}`
          : `0 of ${page.total}`}{" "}
        services
      </span>
      {(page.offset > 0 || next < page.total) && (
        <div>
          <button
            className="secondary-button"
            type="button"
            disabled={page.offset === 0}
            onClick={() => onChange(Math.max(0, page.offset - page.limit))}
          >
            Previous
          </button>
          <button
            className="secondary-button"
            type="button"
            disabled={next >= page.total || next > maximum}
            onClick={() => onChange(next)}
          >
            Next
          </button>
        </div>
      )}
      {next < page.total && next > maximum && (
        <p>More records exist beyond the available page range.</p>
      )}
    </nav>
  );
}

function ServiceLink({
  customerId,
  service,
}: {
  customerId: string;
  service: Pick<ServiceSummary, "id" | "name">;
}) {
  return (
    <Link
      to="/customers/$customerId/services/$serviceId"
      params={{ customerId, serviceId: service.id }}
    >
      {service.name}
    </Link>
  );
}

function ServiceRow({
  customerId,
  service,
  children,
}: {
  customerId: string;
  service: ServiceSummary;
  children?: ReactNode;
}) {
  return (
    <li>
      <div className="service-row">
        <ServiceLink customerId={customerId} service={service} />
        <span className="account-note">{describe(service)}</span>
      </div>
      {children}
    </li>
  );
}

function ServiceList({
  customerId,
  services,
}: {
  customerId: string;
  services: ServiceSummary[];
}) {
  const nested = services.filter(
    (service) => service.kind === "addon" && service.attachedService !== null,
  );
  const roots = services.filter((service) => !nested.includes(service));
  const outside = nested.filter(
    (addon) => !roots.some((parent) => parent.id === addon.attachedService?.id),
  );
  const outsideParents = new Map(
    outside.map((addon) => [addon.attachedService!.id, addon.attachedService!]),
  );
  return (
    <ul className="service-list">
      {roots.map((service) => {
        const addons = nested.filter(
          (addon) => addon.attachedService?.id === service.id,
        );
        return (
          <ServiceRow
            key={service.id}
            customerId={customerId}
            service={service}
          >
            {addons.length > 0 && (
              <ul
                className="service-addons"
                aria-label={`Add-ons attached to ${service.name}`}
              >
                {addons.map((addon) => (
                  <ServiceRow
                    key={addon.id}
                    customerId={customerId}
                    service={addon}
                  />
                ))}
              </ul>
            )}
          </ServiceRow>
        );
      })}
      {[...outsideParents.values()].map((parent) => (
        <li key={parent.id}>
          <p className="service-row">
            <span>
              Attached to{" "}
              <ServiceLink customerId={customerId} service={parent} />
            </span>
            <span className="account-note">(parent on another page)</span>
          </p>
          <ul
            className="service-addons"
            aria-label={`Add-ons attached to ${parent.name}`}
          >
            {outside
              .filter((addon) => addon.attachedService?.id === parent.id)
              .map((addon) => (
                <ServiceRow
                  key={addon.id}
                  customerId={customerId}
                  service={addon}
                />
              ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}

export function ServicesPage({ customerId }: { customerId: string }) {
  const session = useSession();
  const user = !session.isError && session.data?.user;
  if (!user) return <SessionNotice session={session} />;
  return (
    <ServicesList key={user.id} customerId={customerId} userId={user.id} />
  );
}

function ServicesList({
  customerId,
  userId,
}: {
  customerId: string;
  userId: string;
}) {
  const [offset, setOffset] = useState(0);
  const list = useQuery({
    queryKey: ["services", userId, customerId, "list", offset],
    queryFn: ({ signal }) =>
      request<ServicesResponse>(
        `${servicesPath(customerId)}?limit=${pageSize}&offset=${offset}`,
        { signal },
      ),
    retry: false,
  });
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
        <h1>Services</h1>
      </header>
      <section className="panel account-section" aria-label="Customer services">
        {list.isPending && <p role="status">Loading services…</p>}
        {list.isError && (
          <p role="alert">
            {list.error instanceof AccountError && list.error.status === 404
              ? "This customer or its services are unavailable."
              : list.error.message}
          </p>
        )}
        {!list.isError && list.data && (
          <>
            {list.data.total === 0 && <p>No services yet.</p>}
            <ServiceList
              customerId={customerId}
              services={list.data.services}
            />
            <Pages
              page={list.data}
              shown={list.data.services.length}
              onChange={setOffset}
              label="Service pages"
            />
          </>
        )}
      </section>
    </div>
  );
}

export function ServicePage({
  customerId,
  serviceId,
}: {
  customerId: string;
  serviceId: string;
}) {
  const session = useSession();
  const user = !session.isError && session.data?.user;
  if (!user) return <SessionNotice session={session} />;
  return (
    <ServiceDetail
      key={user.id}
      customerId={customerId}
      serviceId={serviceId}
      userId={user.id}
    />
  );
}

function ServiceDetail({
  customerId,
  serviceId,
  userId,
}: {
  customerId: string;
  serviceId: string;
  userId: string;
}) {
  const client = useQueryClient();
  const [generation, setGeneration] = useState(0);
  const path = `${servicesPath(customerId)}/${encodeURIComponent(serviceId)}`;
  const queryKey = ["services", userId, customerId, "detail", serviceId];
  const detail = useQuery({
    queryKey,
    queryFn: ({ signal }) => request<ServiceResponse>(path, { signal }),
    retry: false,
  });
  const accept = (result: ServiceResponse) => {
    client.setQueryData(queryKey, result);
    void client.invalidateQueries({
      queryKey: ["services", userId, customerId, "list"],
    });
    void client.invalidateQueries({
      queryKey: ["services", userId, customerId, "detail"],
    });
  };
  const reload = useMutation({
    mutationFn: () => request<ServiceResponse>(path),
    retry: false,
    onSuccess: (result) => {
      accept(result);
      setGeneration((current) => current + 1);
    },
  });
  const service = !detail.isError && detail.data?.service;
  const reloadControl = (
    <>
      <button
        className="secondary-button"
        type="button"
        disabled={reload.isPending}
        onClick={() => reload.mutate()}
      >
        {reload.isPending ? "Reloading…" : "Reload latest service"}
      </button>
      {reload.isError && <p role="alert">{reload.error.message}</p>}
    </>
  );
  const components = service
    ? [...service.components].sort(
        (a, b) =>
          componentOrder.indexOf(a.kind) - componentOrder.indexOf(b.kind) ||
          a.delivery.localeCompare(b.delivery),
      )
    : [];
  const missingKinds = service
    ? service.includedComponents.filter(
        (kind) => !components.some((value) => value.kind === kind),
      )
    : [];
  return (
    <div className="account-page service-page">
      <header className="account-page-header">
        <Link
          className="account-back"
          to="/customers/$customerId/services"
          params={{ customerId }}
        >
          Services
        </Link>
        <h1>{service ? service.name : "Service"}</h1>
        {service && (
          <p className="account-note">
            {service.kind === "addon" && service.attachedService ? (
              <>
                Add-on attached to{" "}
                <ServiceLink
                  customerId={customerId}
                  service={service.attachedService}
                />
                {service.packageName &&
                  ` on the ${service.packageName} package`}
              </>
            ) : (
              describe(service)
            )}
            {service.kind === "hosting" &&
              (service.includedComponents.length
                ? `. Includes ${new Intl.ListFormat("en").format(
                    componentOrder
                      .filter((kind) =>
                        service.includedComponents.includes(kind),
                      )
                      .map((kind) => includedLabels[kind]),
                  )} hosting.`
                : ". No included components recorded.")}
          </p>
        )}
        {service && (
          <Link
            to="/customers/$customerId/tickets/new"
            params={{ customerId }}
            search={{ serviceId }}
          >
            Request support
          </Link>
        )}
        {reload.isSuccess && (
          <p role="status">
            Latest service loaded. Review the fields before saving again.
          </p>
        )}
      </header>
      {detail.isPending && (
        <p className="panel state-panel" role="status">
          Loading service…
        </p>
      )}
      {detail.isError && (
        <p className="panel state-panel" role="alert">
          {detail.error instanceof AccountError && detail.error.status === 404
            ? "This service is unavailable."
            : detail.error.message}
        </p>
      )}
      {service && (
        <>
          {(components.length > 0 || missingKinds.length > 0) && (
            <section
              className="panel service-components"
              aria-label="Components"
            >
              {components.map((component) => (
                <article className="service-component" key={component.id}>
                  <ComponentHeading kind={component.kind}>
                    {component.delivery === "hosted"
                      ? "Hosted with us"
                      : "External provider"}
                    {service.kind === "hosting" &&
                      !service.includedComponents.includes(component.kind) &&
                      ", not included in package"}
                  </ComponentHeading>
                  {service.canManage && component.requestedSetting !== null ? (
                    <PreferenceEditor
                      key={`${component.id}:${generation}`}
                      component={component}
                      path={path}
                      accept={accept}
                      reloadControl={reloadControl}
                    />
                  ) : (
                    <ComponentFacts
                      component={component}
                      requested={requestedLabel(component)}
                    />
                  )}
                  <ComponentResources component={component} service={service} />
                </article>
              ))}
              {missingKinds.map((kind) => (
                <article className="service-component" key={kind}>
                  <ComponentHeading kind={kind}>
                    Included in package, no component recorded
                  </ComponentHeading>
                </article>
              ))}
            </section>
          )}
          {service.hostingAccounts.length > 0 && (
            <section className="panel account-section">
              <h2>Hosting accounts</h2>
              <ul className="service-list">
                {service.hostingAccounts.map((account) => (
                  <li className="service-row" key={account.id}>
                    <span>
                      {account.label}
                      <span className="account-note service-support">
                        {account.providerLabel}
                      </span>
                    </span>
                    {account.loginUrl &&
                      /^https:\/\//i.test(account.loginUrl) && (
                        <a
                          href={account.loginUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          Open Plesk
                          <span className="sr-only">
                            {" "}
                            for {account.label} (opens in a new tab)
                          </span>
                        </a>
                      )}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {service.registration && (
            <section className="panel account-section">
              <h2>Registration</h2>
              <dl className="account-facts">
                {service.registration.registeredName !== service.name && (
                  <div>
                    <dt>Registered name</dt>
                    <dd>{service.registration.registeredName}</dd>
                  </div>
                )}
                <div>
                  <dt>Registrar</dt>
                  <dd>{service.registration.registrarLabel}</dd>
                </div>
                <div>
                  <dt>Manager</dt>
                  <dd>{managerLabels[service.registration.manager]}</dd>
                </div>
                <div>
                  <dt>Expiry</dt>
                  <dd>
                    {service.registration.expiresOn ? (
                      <time dateTime={service.registration.expiresOn}>
                        {service.registration.expiresOn}
                      </time>
                    ) : (
                      "Not recorded"
                    )}
                  </dd>
                </div>
                <div>
                  <dt>Renewed by</dt>
                  <dd>
                    {service.registration.renewalResponsibility === "unknown"
                      ? "Not recorded"
                      : managerLabels[
                          service.registration.renewalResponsibility
                        ]}
                  </dd>
                </div>
              </dl>
            </section>
          )}
          {service.addons.length > 0 && (
            <section className="panel account-section">
              <h2>Add-ons</h2>
              <ul className="service-list">
                {service.addons.map((addon) => (
                  <li className="service-row" key={addon.id}>
                    <ServiceLink customerId={customerId} service={addon} />
                    {addon.packageName && (
                      <span className="account-note">
                        {addon.packageName} package
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {service.kind === "addon" && service.canManage && (
            <section className="panel account-section">
              <h2>Attachment</h2>
              <AttachmentEditor
                key={`attachment:${generation}`}
                customerId={customerId}
                userId={userId}
                service={service}
                accept={accept}
                reloadControl={reloadControl}
              />
            </section>
          )}
        </>
      )}
    </div>
  );
}

function ComponentHeading({
  kind,
  children,
}: {
  kind: ComponentKind;
  children: ReactNode;
}) {
  return (
    <div className="service-component-heading">
      <h2>{componentLabels[kind]}</h2>
      <span className="account-note">{children}</span>
    </div>
  );
}

function requestedLabel(component: Component) {
  if (component.requestedSetting !== null)
    return settingLabels[component.requestedSetting];
  return component.manager === "customer" ? "Managed by customer" : "Not set";
}

function ComponentFacts({
  component,
  requested,
  requestedFor,
}: {
  component: Component;
  requested: ReactNode;
  requestedFor?: string;
}) {
  return (
    <>
      <dl className="service-compare">
        <div>
          <dt>
            {requestedFor ? (
              <label htmlFor={requestedFor}>
                Requested setting
                <span className="sr-only">
                  {" "}
                  for {componentLabels[component.kind]}
                </span>
              </label>
            ) : (
              "Requested setting"
            )}
          </dt>
          <dd>{requested}</dd>
        </div>
        <div>
          <dt>Provider state</dt>
          <dd>
            {component.providerState === "unknown" ? (
              "Not checked"
            ) : (
              <>
                {settingLabels[component.providerState]}
                <span className="account-note service-support">
                  {component.checkedAt ? (
                    <>
                      Checked{" "}
                      <time dateTime={component.checkedAt}>
                        {new Date(component.checkedAt).toLocaleString(
                          undefined,
                          checkedFormat,
                        )}
                      </time>
                    </>
                  ) : (
                    "Check time not recorded"
                  )}
                </span>
              </>
            )}
          </dd>
        </div>
        <div>
          <dt>Provider</dt>
          <dd>{component.providerLabel}</dd>
        </div>
        <div>
          <dt>Manager</dt>
          <dd>{managerLabels[component.manager]}</dd>
        </div>
      </dl>
      {component.reviewReason && (
        <p className="service-warning" role="alert">
          {component.reviewReason === "requested_state_differs"
            ? "The provider state differs from the requested setting. Staff review is required."
            : "The provider is running this component without an included entitlement. Staff review is required."}
        </p>
      )}
    </>
  );
}

function NameList({ names, empty }: { names: string[]; empty: string }) {
  if (!names.length) return <span className="account-note">{empty}</span>;
  return (
    <ul className="service-names">
      {names.map((name) => (
        <li key={name}>{name}</li>
      ))}
    </ul>
  );
}

function ComponentResources({
  component,
  service,
}: {
  component: Component;
  service: Service;
}) {
  if (component.kind !== "web")
    return (
      <dl className="account-facts">
        <div>
          <dt>{component.kind === "email" ? "Email domains" : "DNS zones"}</dt>
          <dd>
            <NameList
              names={component.domains}
              empty={
                component.kind === "email"
                  ? "No domains recorded."
                  : "No zones recorded."
              }
            />
          </dd>
        </div>
      </dl>
    );
  const websites = service.websites.filter(
    (website) => website.componentId === component.id,
  );
  return (
    <dl className="account-facts">
      <div>
        <dt>Websites</dt>
        <dd>
          {websites.length === 0 ? (
            <span className="account-note">No websites recorded.</span>
          ) : (
            <ul className="service-names service-websites">
              {websites.map((website) => (
                <li key={website.id}>
                  {website.primaryHostname}
                  {website.aliases.length > 0 && (
                    <span className="account-note service-support">
                      Aliases: {website.aliases.join(", ")}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </dd>
      </div>
    </dl>
  );
}

function PreferenceEditor({
  component,
  path,
  accept,
  reloadControl,
}: {
  component: Component;
  path: string;
  accept: (result: ServiceResponse) => void;
  reloadControl: ReactNode;
}) {
  const selectId = useId();
  const [setting, setSetting] = useState<RequestedSetting>(
    component.requestedSetting ?? "disabled",
  );
  const [version, setVersion] = useState(component.version);
  const requestId = useRequestId();
  const update = useMutation({
    mutationFn: (input: SetComponentPreferenceRequest) =>
      command<ServiceResponse>(
        `${path}/components/${encodeURIComponent(component.id)}/preference`,
        input,
        "PATCH",
      ),
    retry: false,
    onSuccess: (result) => {
      accept(result);
      const saved = result.service.components.find(
        (value) => value.id === component.id,
      );
      if (saved) {
        setVersion(saved.version);
        if (saved.requestedSetting !== null) setSetting(saved.requestedSetting);
      }
    },
  });
  const conflict =
    update.error instanceof AccountError && update.error.status === 409;
  return (
    <form
      className="service-form"
      onSubmit={(event) => {
        event.preventDefault();
        const input = { expectedVersion: version, requestedSetting: setting };
        update.mutate({ ...input, requestId: requestId.get(input) });
      }}
    >
      <ComponentFacts
        component={component}
        requestedFor={selectId}
        requested={
          <select
            id={selectId}
            disabled={update.isPending || conflict}
            value={setting}
            onChange={(event) => {
              const next =
                event.target.value === "enabled" ? "enabled" : "disabled";
              if (setting !== next) requestId.reset();
              setSetting(next);
              update.reset();
            }}
          >
            <option value="enabled">Enabled</option>
            <option value="disabled">Disabled</option>
          </select>
        }
      />
      <div className="account-actions">
        <button
          className="secondary-button"
          disabled={update.isPending || conflict}
          type="submit"
        >
          {update.isPending ? "Saving…" : "Save preference"}
        </button>
        {update.isSuccess && (
          <p className="account-note" role="status">
            Saved. The provider has not been changed.
          </p>
        )}
      </div>
      {update.isError && (
        <p className="service-warning" role="alert">
          {conflict
            ? "This service changed. Reload and review before saving again."
            : update.error.message}
        </p>
      )}
      {conflict && <div className="account-actions">{reloadControl}</div>}
    </form>
  );
}

function AttachmentEditor({
  customerId,
  userId,
  service,
  accept,
  reloadControl,
}: {
  customerId: string;
  userId: string;
  service: Service;
  accept: (result: ServiceResponse) => void;
  reloadControl: ReactNode;
}) {
  const [offset, setOffset] = useState(0);
  const [target, setTarget] = useState(service.attachedService);
  const [version, setVersion] = useState(service.version);
  const requestId = useRequestId();
  const options = useQuery({
    queryKey: ["services", userId, customerId, "list", offset],
    queryFn: ({ signal }) =>
      request<ServicesResponse>(
        `${servicesPath(customerId)}?limit=${pageSize}&offset=${offset}`,
        { signal },
      ),
    retry: false,
  });
  const eligible =
    !options.isError && options.data
      ? options.data.services.filter(
          (value) =>
            value.kind === "hosting" || value.kind === "domain_registration",
        )
      : [];
  const update = useMutation({
    mutationFn: (input: AttachAddonRequest) =>
      command<ServiceResponse>(
        `/api/customers/${encodeURIComponent(customerId)}/addons/${encodeURIComponent(service.id)}/attach`,
        input,
      ),
    retry: false,
    onSuccess: (result) => {
      accept(result);
      setVersion(result.service.version);
      setTarget(result.service.attachedService);
    },
  });
  const conflict =
    update.error instanceof AccountError && update.error.status === 409;
  const change = (next: Service["attachedService"]) => {
    if (target?.id !== next?.id) requestId.reset();
    setTarget(next);
    update.reset();
  };
  const save = (attachedServiceId: string | null) => {
    const input = { expectedVersion: version, attachedServiceId };
    update.mutate({ ...input, requestId: requestId.get(input) });
  };
  const locked = update.isPending || conflict;
  return (
    <form
      className="account-form"
      onSubmit={(event) => {
        event.preventDefault();
        save(target?.id ?? null);
      }}
    >
      <label>
        Attach to existing service
        <select
          value={target?.id ?? ""}
          disabled={locked}
          onChange={(event) =>
            change(
              eligible.find((value) => value.id === event.target.value) ?? null,
            )
          }
        >
          <option value="">Unattached</option>
          {target && !eligible.some((value) => value.id === target.id) && (
            <option value={target.id}>{target.name} (another page)</option>
          )}
          {eligible.map((value) => (
            <option value={value.id} key={value.id}>
              {value.name} ({kindLabels[value.kind]})
            </option>
          ))}
        </select>
      </label>
      {options.isPending && <p role="status">Loading services to attach…</p>}
      {options.isError && <p role="alert">{options.error.message}</p>}
      {!options.isError &&
        options.data &&
        options.data.total > options.data.limit && (
          <>
            <p className="account-note">
              {eligible.length} eligible options on this page.
            </p>
            <Pages
              page={options.data}
              shown={options.data.services.length}
              onChange={setOffset}
              label="Attachment option pages"
            />
          </>
        )}
      <p className="account-note">
        Only this customer’s hosting and domain registration services can be
        selected. Changing the attachment does not change billing.
      </p>
      <div className="account-actions">
        <button
          className="account-primary-button"
          disabled={locked || !target}
          type="submit"
        >
          {update.isPending ? "Saving…" : "Save attachment"}
        </button>
        {service.attachedService && (
          <button
            className="secondary-button"
            disabled={locked}
            type="button"
            onClick={() => {
              change(null);
              save(null);
            }}
          >
            Detach add-on
          </button>
        )}
      </div>
      {update.isSuccess && (
        <p className="account-note" role="status">
          Saved. Billing has not been changed.
        </p>
      )}
      {update.isError && (
        <p role="alert">
          {conflict
            ? "This service changed. Reload and review before saving again."
            : update.error.message}
        </p>
      )}
      {conflict && reloadControl}
    </form>
  );
}
