import type { ReactNode } from "react";
import type { CustomerResponse } from "../../import-review/contract";
import { fieldLabels, recordTypes } from "./labels";

type Service = CustomerResponse["services"]["items"][number];
type DateObservation = Service["dueDateObservation"];

function observedMoney(money: Service["money"]): string {
  const { amountMinor, currency, cadence } = money;
  let amount = "Amount unavailable";
  if (amountMinor !== null) {
    if (currency === null)
      amount = `${amountMinor} minor units (currency unavailable)`;
    else {
      const places =
        new Intl.NumberFormat("en", {
          style: "currency",
          currency,
        }).resolvedOptions().maximumFractionDigits ?? 2;
      const negative = amountMinor.startsWith("-");
      const digits = (negative ? amountMinor.slice(1) : amountMinor).padStart(
        places + 1,
        "0",
      );
      const value =
        places === 0
          ? digits
          : `${digits.slice(0, -places)}.${digits.slice(-places)}`;
      amount = `${currency} ${negative ? "-" : ""}${value}`;
    }
  } else if (currency !== null) amount += ` (${currency})`;
  return `${amount} · ${cadence ?? "Billing cycle unavailable"}`;
}

function CalendarDate({ observation }: { observation: DateObservation }) {
  if (observation.state === "valid")
    return (
      <time dateTime={observation.value ?? undefined}>{observation.value}</time>
    );
  if (observation.state === "invalid")
    return (
      <>
        <span>{observation.raw}</span>
        <span className="data-issue-text record-note">Invalid date</span>
      </>
    );
  return <span className="muted">Unavailable</span>;
}

export function ObservedStatus({
  observation,
}: {
  observation: Service["statusObservation"];
}) {
  return (
    <span
      className={observation.known ? "status-tag" : "status-tag unknown-status"}
    >
      {observation.raw ?? "Unavailable"}
      {!observation.known && observation.raw !== null
        ? " (unrecognized status)"
        : ""}
    </span>
  );
}

function serviceTitle(service: Service): string {
  return (
    service.hostname ||
    service.productName ||
    `${recordTypes[service.recordType].label} ${service.sourceRecordId}`
  );
}

function ComparisonTable({
  labelledBy,
  recordType,
  children,
}: {
  labelledBy: string;
  recordType: "service" | "addon" | "domain";
  children: ReactNode;
}) {
  return (
    <div
      className="table-scroll comparison-scroll"
      role="region"
      aria-labelledby={labelledBy}
      tabIndex={0}
    >
      <table
        className="comparison-table"
        role="table"
        aria-labelledby={labelledBy}
      >
        <thead role="rowgroup">
          <tr role="row">
            <th role="columnheader" scope="col">
              {recordTypes[recordType].label}
            </th>
            <th role="columnheader" scope="col">
              Price
            </th>
            <th role="columnheader" scope="col">
              Status
            </th>
            <th role="columnheader" scope="col">
              {fieldLabels.dueDate}
            </th>
            <th role="columnheader" scope="col">
              {fieldLabels.nextInvoiceDate}
            </th>
            {recordType === "domain" && (
              <th role="columnheader" scope="col">
                {fieldLabels.expiryDate}
              </th>
            )}
          </tr>
        </thead>
        {children}
      </table>
    </div>
  );
}

export function ServiceTables({
  page,
  showSourceIds,
}: {
  page: CustomerResponse["services"];
  showSourceIds: boolean;
}) {
  const services = page.items.filter((item) => item.recordType === "service");
  const parents = new Map(
    services.map((service) => [`service:${service.sourceRecordId}`, service]),
  );
  const grouped = new Map<Service, Service[]>();
  const otherAddons: { service: Service; attachedServiceHint?: string }[] = [];
  for (const addon of page.items.filter(
    (item) => item.recordType === "addon",
  )) {
    const reference = addon.attachedService;
    const parent = reference
      ? parents.get(`${reference.recordType}:${reference.sourceRecordId}`)
      : undefined;
    if (
      parent &&
      parent.customer.sourceRecordId === addon.customer.sourceRecordId
    ) {
      const addons = grouped.get(parent) ?? [];
      addons.push(addon);
      grouped.set(parent, addons);
    } else {
      const attachedServiceHint = !reference
        ? undefined
        : parent
          ? "Attached service cannot be confirmed: the service belongs to a different customer. Check Data issues."
          : `Attached service is not shown here. Check Data issues${page.offset > 0 || page.total > page.limit ? " or other pages" : ""}.`;
      otherAddons.push({ service: addon, attachedServiceHint });
    }
  }
  return (
    <>
      {services.length > 0 && (
        <ComparisonTable labelledBy="services-title" recordType="service">
          {services.map((service) => (
            <tbody
              className="service-group"
              role="rowgroup"
              key={`service:${service.sourceRecordId}`}
            >
              <ServiceRow service={service} showSourceIds={showSourceIds} />
              {(grouped.get(service) ?? []).map((addon) => (
                <ServiceRow
                  key={`addon:${addon.sourceRecordId}`}
                  service={addon}
                  showSourceIds={showSourceIds}
                  attachedServiceName={serviceTitle(service)}
                />
              ))}
            </tbody>
          ))}
        </ComparisonTable>
      )}
      {otherAddons.length > 0 && (
        <>
          <h3 id="other-addons-title" className="subheading">
            Other add-ons
          </h3>
          <ComparisonTable labelledBy="other-addons-title" recordType="addon">
            <tbody role="rowgroup">
              {otherAddons.map(({ service, attachedServiceHint }) => (
                <ServiceRow
                  key={`addon:${service.sourceRecordId}`}
                  service={service}
                  showSourceIds={showSourceIds}
                  attachedServiceHint={attachedServiceHint}
                />
              ))}
            </tbody>
          </ComparisonTable>
        </>
      )}
    </>
  );
}

function ServiceRow({
  service,
  showSourceIds,
  attachedServiceName,
  attachedServiceHint,
}: {
  service: Service;
  showSourceIds: boolean;
  attachedServiceName?: string;
  attachedServiceHint?: string;
}) {
  return (
    <tr role="row">
      <th role="rowheader" scope="row">
        <div
          className={
            attachedServiceName ? "record-name addon-name" : "record-name"
          }
        >
          {attachedServiceName && (
            <span className="sr-only">Add-on of {attachedServiceName}. </span>
          )}
          <h4>{serviceTitle(service)}</h4>
          {service.hostname !== null && (
            <p className="record-note">
              Product: {service.productName ?? "Unknown"}
            </p>
          )}
          {showSourceIds && (service.hostname || service.productName) && (
            <p className="record-note">
              {recordTypes[service.recordType].label} {service.sourceRecordId}
            </p>
          )}
          {service.recordType === "addon" &&
            (service.attachedService ? (
              (showSourceIds || attachedServiceHint) && (
                <p className="record-note">
                  {fieldLabels.attachedService}:{" "}
                  {service.attachedService.sourceRecordId}
                </p>
              )
            ) : (
              <p className="record-note">Attached service unknown</p>
            ))}
          {attachedServiceHint && (
            <p className="field-hint">{attachedServiceHint}</p>
          )}
        </div>
      </th>
      <td role="cell" className="record-money">
        <span className="cell-label" aria-hidden="true">
          Price
        </span>
        <div>{observedMoney(service.money)}</div>
      </td>
      <td role="cell">
        <span className="cell-label" aria-hidden="true">
          Status
        </span>
        <div>
          <ObservedStatus observation={service.statusObservation} />
          {service.cancellationRequested === true && (
            <p className="record-note">Cancellation requested</p>
          )}
          {service.cancellationRequested === null && (
            <p className="record-note">Cancellation requested: Unknown</p>
          )}
        </div>
      </td>
      <td role="cell">
        <span className="cell-label" aria-hidden="true">
          {fieldLabels.dueDate}
        </span>
        <div>
          <CalendarDate observation={service.dueDateObservation} />
        </div>
      </td>
      <td role="cell">
        <span className="cell-label" aria-hidden="true">
          {fieldLabels.nextInvoiceDate}
        </span>
        <div>
          <CalendarDate observation={service.nextInvoiceDateObservation} />
        </div>
      </td>
    </tr>
  );
}

export function DomainTable({
  page,
  showSourceIds,
}: {
  page: CustomerResponse["domains"];
  showSourceIds: boolean;
}) {
  return (
    <ComparisonTable labelledBy="domains-title" recordType="domain">
      <tbody role="rowgroup">
        {page.items.map((domain) => (
          <tr role="row" key={domain.sourceRecordId}>
            <th role="rowheader" scope="row">
              <div className="record-name">
                <h4>
                  {domain.domainName || `Domain ${domain.sourceRecordId}`}
                </h4>
                <p className="record-note">
                  Term:{" "}
                  {domain.termYears === null
                    ? "Unavailable"
                    : `${domain.termYears} ${domain.termYears === 1 ? "year" : "years"}`}
                </p>
                {showSourceIds && domain.domainName && (
                  <p className="record-note">Domain {domain.sourceRecordId}</p>
                )}
              </div>
            </th>
            <td role="cell" className="record-money">
              <span className="cell-label" aria-hidden="true">
                Price
              </span>
              <div>{observedMoney(domain.money)}</div>
            </td>
            <td role="cell">
              <span className="cell-label" aria-hidden="true">
                Status
              </span>
              <div>
                <ObservedStatus observation={domain.statusObservation} />
              </div>
            </td>
            <td role="cell">
              <span className="cell-label" aria-hidden="true">
                {fieldLabels.dueDate}
              </span>
              <div>
                <CalendarDate observation={domain.dueDateObservation} />
              </div>
            </td>
            <td role="cell">
              <span className="cell-label" aria-hidden="true">
                {fieldLabels.nextInvoiceDate}
              </span>
              <div>
                <CalendarDate observation={domain.nextInvoiceDateObservation} />
              </div>
            </td>
            <td role="cell">
              <span className="cell-label" aria-hidden="true">
                {fieldLabels.expiryDate}
              </span>
              <div>
                <CalendarDate observation={domain.expiryDateObservation} />
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </ComparisonTable>
  );
}
