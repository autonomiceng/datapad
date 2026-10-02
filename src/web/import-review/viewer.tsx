import { PaginationSchema } from "../../import-review/contract";
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import type { ImportMetadata } from "../../import-review/contract";
import {
  getCustomer,
  listCustomers,
  listDataIssues,
  listImports,
  listSources,
} from "./api";
import { DomainTable, ObservedStatus, ServiceTables } from "./observations";
import { HelpPanel } from "./help";
import { fieldLabels, issueLabels, recordTypes } from "./labels";

interface QueryState {
  isPending: boolean;
  isError: boolean;
  isFetching: boolean;
  error: Error | null;
  refetch: () => unknown;
}

function QueryFeedback({ query, name }: { query: QueryState; name: string }) {
  if (query.isError)
    return (
      <div className="state-panel error-state">
        <p role="alert">{query.error?.message}</p>
        <button
          type="button"
          className="secondary-button"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          {query.isFetching ? "Trying again…" : `Retry ${name}`}
        </button>
      </div>
    );
  if (query.isPending)
    return (
      <p className="state-panel" role="status">
        Loading {name}…
      </p>
    );
  return null;
}

function Pagination({
  name,
  total,
  limit,
  offset,
  count,
  change,
}: {
  name: string;
  total: number;
  limit: number;
  offset: number;
  count: number;
  change: (offset: number) => void;
}) {
  if (offset === 0 && total <= limit) return null;
  return (
    <nav className="pagination" aria-label={`${name} pagination`}>
      <span>
        {total === 0 || count === 0
          ? `0 of ${total}`
          : `${offset + 1}–${offset + count} of ${total}`}
      </span>
      <div>
        <button
          type="button"
          className="secondary-button"
          disabled={offset === 0}
          onClick={() => change(Math.max(0, offset - limit))}
        >
          Previous <span className="sr-only">{name}</span>
        </button>
        <button
          type="button"
          className="secondary-button"
          disabled={
            offset + limit >= total ||
            offset + limit > PaginationSchema.properties.offset.maximum!
          }
          onClick={() => change(offset + limit)}
        >
          Next <span className="sr-only">{name}</span>
        </button>
      </div>
    </nav>
  );
}

// API instants are ISO 8601 UTC strings; show them without local conversion.
function utc(instant: string): string {
  return `${instant.slice(0, 10)} ${instant.slice(11, 19)} UTC`;
}

interface ImportDisclosures {
  details: boolean;
  counts: boolean;
  identifiers: boolean;
}

function ImportContext({
  importMetadata,
  showRecordTypes,
  expanded,
  setExpanded,
}: {
  importMetadata: ImportMetadata;
  showRecordTypes: () => void;
  expanded: ImportDisclosures;
  setExpanded: (section: keyof ImportDisclosures, open: boolean) => void;
}) {
  return (
    <details className="panel import-details" open={expanded.details}>
      <summary
        onClick={(event) => {
          event.preventDefault();
          setExpanded("details", !expanded.details);
        }}
      >
        Import details
      </summary>
      <dl className="import-identifiers">
        <dt>Source reference</dt>
        <dd>{importMetadata.sourceReference}</dd>
        <dt>Import ID</dt>
        <dd>{importMetadata.id}</dd>
      </dl>
      <details open={expanded.counts}>
        <summary
          onClick={(event) => {
            event.preventDefault();
            setExpanded("counts", !expanded.counts);
          }}
        >
          Record counts
        </summary>
        <div
          className="table-scroll"
          role="region"
          aria-label="Record counts"
          tabIndex={0}
        >
          <table>
            <caption>
              Selected + Linked = records shown. Excluded and source totals are
              reported by the file; they have not been checked against the
              original system.
            </caption>
            <thead>
              <tr>
                <th scope="col">
                  <button
                    type="button"
                    className="text-button"
                    onClick={showRecordTypes}
                    aria-label="Record type help"
                  >
                    Record type
                  </button>
                </th>
                <th scope="col">Selected</th>
                <th scope="col">Linked</th>
                <th scope="col">Excluded</th>
                <th scope="col">Reported source total</th>
              </tr>
            </thead>
            <tbody>
              {importMetadata.recordCounts.map((entry) => (
                <tr key={entry.selectionCode}>
                  <th scope="row">{recordTypes[entry.recordType].label}</th>
                  <td>{entry.selectedCount}</td>
                  <td>{entry.linkedCount}</td>
                  <td>{entry.excludedCount}</td>
                  <td>{entry.reportedSourceTotalCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <details className="technical-identifiers" open={expanded.identifiers}>
          <summary
            onClick={(event) => {
              event.preventDefault();
              setExpanded("identifiers", !expanded.identifiers);
            }}
          >
            Technical identifiers
          </summary>
          <p>
            Codes from the import file name each record selection and the
            reasons records were excluded.
          </p>
          <dl>
            {importMetadata.recordCounts.map((entry) => (
              <div key={entry.selectionCode}>
                <dt>{recordTypes[entry.recordType].label}</dt>
                <dd>
                  Selection code: <code>{entry.selectionCode}</code>
                </dd>
                <dd>
                  Exclusion reasons:{" "}
                  {entry.exclusionReasons.length
                    ? entry.exclusionReasons
                        .map(
                          (reason) =>
                            `Reason code: ${reason.reasonCode} (${reason.count} ${reason.count === 1 ? "record" : "records"})`,
                        )
                        .join(", ")
                    : "None"}
                </dd>
              </div>
            ))}
          </dl>
        </details>
      </details>
    </details>
  );
}

export function ImportReview() {
  const search = useSearch({ from: "/" });
  const navigate = useNavigate({ from: "/" });
  const [showSourceIds, setShowSourceIds] = useState(false);
  // Summary activation saves choices before loading can unmount the details.
  // Native toggle events are queued and can arrive after that unmount.
  const [expanded, setDisclosures] = useState<ImportDisclosures>({
    details: false,
    counts: false,
    identifiers: false,
  });
  const setExpanded = (section: keyof ImportDisclosures, open: boolean) =>
    setDisclosures((previous) =>
      previous[section] === open ? previous : { ...previous, [section]: open },
    );
  const helpRef = useRef<HTMLDetailsElement>(null);
  const recordTypesRef = useRef<HTMLHeadingElement>(null);
  const showRecordTypes = () => {
    if (helpRef.current) helpRef.current.open = true;
    recordTypesRef.current?.focus();
  };
  const update = (changes: Partial<typeof search>) =>
    void navigate({
      search: (previous) => ({ ...previous, ...changes }),
      resetScroll: false,
    });
  const sources = useQuery({
    queryKey: ["import-review", "sources", search.sourcesOffset],
    queryFn: ({ signal }) => listSources(search.sourcesOffset, signal),
    staleTime: 30000,
  });
  const importsOffset = search.importId ? search.importsOffset : 0;
  const imports = useQuery({
    queryKey: ["import-review", "imports", search.sourceId, importsOffset],
    queryFn: ({ signal }) =>
      listImports(search.sourceId!, importsOffset, signal),
    enabled: Boolean(search.sourceId),
    staleTime: 30000,
  });
  const customers = useQuery({
    queryKey: [
      "import-review",
      "customers",
      search.importId,
      search.customersOffset,
    ],
    queryFn: ({ signal }) =>
      listCustomers(search.importId!, search.customersOffset, signal),
    enabled: Boolean(search.sourceId && search.importId),
    staleTime: Infinity,
  });
  const sourceMatches =
    customers.data?.importMetadata.sourceId === search.sourceId;
  const detail = useQuery({
    queryKey: [
      "import-review",
      "customer",
      search.importId,
      search.customerId,
      search.detailsOffset,
    ],
    queryFn: ({ signal }) =>
      getCustomer(
        search.importId!,
        search.customerId!,
        search.detailsOffset,
        signal,
      ),
    enabled: Boolean(sourceMatches && search.importId && search.customerId),
    staleTime: Infinity,
  });
  const dataIssues = useQuery({
    queryKey: [
      "import-review",
      "dataIssues",
      search.importId,
      search.dataIssuesOffset,
    ],
    queryFn: ({ signal }) =>
      listDataIssues(search.importId!, search.dataIssuesOffset, signal),
    enabled: Boolean(sourceMatches && search.importId),
    staleTime: Infinity,
  });

  useEffect(() => {
    const source = sources.data?.items[0];
    if (!search.sourceId && sources.data?.total === 1 && source) {
      void navigate({
        search: (previous) => ({
          ...previous,
          sourceId: source.sourceId,
        }),
        replace: true,
      });
    }
  }, [search.sourceId, sources.data, navigate]);
  useEffect(() => {
    const importMetadata = imports.data?.items[0];
    if (search.sourceId && !search.importId && importMetadata) {
      void navigate({
        search: (previous) => ({ ...previous, importId: importMetadata.id }),
        replace: true,
      });
    }
  }, [search.sourceId, search.importId, imports.data, navigate]);

  return (
    <>
      <section className="intro" aria-labelledby="page-title">
        <div className="page-heading">
          <h1 id="page-title">Import review</h1>
          {/* The server only admits reviewed fixtures through its demo policy. */}
          <span className="sample-badge">Sample data</span>
        </div>
        <p className="intro-description">
          Review only. Billing and services stay in the original system.
        </p>
      </section>
      <HelpPanel panelRef={helpRef} recordTypesRef={recordTypesRef} />
      <section className="panel import-selection" aria-label="Import selection">
        <div className="selection-control" aria-busy={sources.isFetching}>
          <span id="source-label">Source</span>
          <QueryFeedback query={sources} name="sources" />
          {sources.data && !sources.isError && (
            <>
              {sources.data.total === 0 ? (
                <p className="empty-state">No sources available.</p>
              ) : sources.data.total === 1 &&
                sources.data.items[0]?.sourceId === search.sourceId ? (
                <p id="source" className="fixed-source">
                  {search.sourceId}
                </p>
              ) : (
                <select
                  id="source"
                  aria-labelledby="source-label"
                  value={search.sourceId ?? ""}
                  onChange={(event) =>
                    update({
                      sourceId: event.target.value,
                      importId: undefined,
                      customerId: undefined,
                      importsOffset: 0,
                      customersOffset: 0,
                      detailsOffset: 0,
                      dataIssuesOffset: 0,
                    })
                  }
                >
                  <option value="" disabled>
                    Choose a source
                  </option>
                  {search.sourceId &&
                    !sources.data.items.some(
                      (source) => source.sourceId === search.sourceId,
                    ) && (
                      <option value={search.sourceId}>{search.sourceId}</option>
                    )}
                  {sources.data.items.map((source) => (
                    <option key={source.sourceId} value={source.sourceId}>
                      {source.sourceId}
                    </option>
                  ))}
                </select>
              )}
              <Pagination
                name="Sources"
                {...sources.data}
                count={sources.data.items.length}
                change={(sourcesOffset) => update({ sourcesOffset })}
              />
            </>
          )}
        </div>
        {search.sourceId && (
          <div className="selection-control" aria-busy={imports.isFetching}>
            <label htmlFor="import-id">Data as of</label>
            <QueryFeedback query={imports} name="data" />
            {imports.data && !imports.isError && (
              <>
                <select
                  id="import-id"
                  value={search.importId ?? ""}
                  onChange={(event) =>
                    update({
                      importId: event.target.value,
                      customerId: undefined,
                      customersOffset: 0,
                      detailsOffset: 0,
                      dataIssuesOffset: 0,
                    })
                  }
                >
                  <option value="" disabled>
                    Choose an import
                  </option>
                  {search.importId &&
                    !imports.data.items.some(
                      (importMetadata) => importMetadata.id === search.importId,
                    ) && (
                      <option value={search.importId}>
                        {sourceMatches && customers.data
                          ? `${utc(customers.data.importMetadata.dataAsOf)} · ${customers.data.importMetadata.sourceReference}`
                          : "Selected import (on another page)"}
                      </option>
                    )}
                  {imports.data.items.map((importMetadata) => (
                    <option key={importMetadata.id} value={importMetadata.id}>
                      {utc(importMetadata.dataAsOf)} ·{" "}
                      {importMetadata.sourceReference}
                    </option>
                  ))}
                </select>
                <Pagination
                  name="Imports"
                  {...imports.data}
                  count={imports.data.items.length}
                  change={(importsOffset) => update({ importsOffset })}
                />
              </>
            )}
          </div>
        )}
      </section>
      <div className="import-review-content">
        {!search.sourceId &&
          !sources.isPending &&
          !sources.isError &&
          sources.data?.total !== 0 && (
            <section className="panel state-panel">
              <h2>Select a source</h2>
              <p>Choose where the imported records came from.</p>
            </section>
          )}
        {search.sourceId && search.importId && (
          <>
            <QueryFeedback query={customers} name="customers" />
            {customers.data && !customers.isError && !sourceMatches && (
              <p className="panel state-panel" role="alert">
                This import belongs to a different source. Choose an import for
                the selected source.
              </p>
            )}
            {customers.data && !customers.isError && sourceMatches && (
              <>
                <ImportContext
                  importMetadata={customers.data.importMetadata}
                  showRecordTypes={showRecordTypes}
                  expanded={expanded}
                  setExpanded={setExpanded}
                />
                <section
                  className="panel collection-panel"
                  aria-labelledby="customers-title"
                  aria-busy={customers.isFetching}
                >
                  <div className="collection-heading">
                    <h2 id="customers-title">Customers</h2>
                    <span className="item-count">{customers.data.total}</span>
                  </div>
                  {customers.data.items.length === 0 ? (
                    <p className="empty-state">No customers on this page.</p>
                  ) : (
                    <ul className="customer-list" aria-label="Customers">
                      {customers.data.items.map((customer) => (
                        <li key={customer.sourceRecordId}>
                          <button
                            type="button"
                            className="customer-button"
                            aria-pressed={
                              search.customerId === customer.sourceRecordId
                            }
                            onClick={() =>
                              update({
                                customerId: customer.sourceRecordId,
                                detailsOffset: 0,
                              })
                            }
                          >
                            <span>{customer.label}</span>
                            <ObservedStatus
                              observation={customer.statusObservation}
                            />
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  <Pagination
                    name="Customers"
                    {...customers.data}
                    count={customers.data.items.length}
                    change={(customersOffset) => update({ customersOffset })}
                  />
                </section>
                {search.customerId && (
                  <section
                    className="panel collection-panel"
                    aria-labelledby="detail-title"
                    aria-busy={detail.isFetching}
                  >
                    <div className="collection-heading">
                      <h2 id="detail-title">
                        {detail.data?.customer.label ??
                          `${recordTypes.customer.label} ${search.customerId}`}
                      </h2>
                      {detail.data && !detail.isError && (
                        <ObservedStatus
                          observation={detail.data.customer.statusObservation}
                        />
                      )}
                      <label className="source-ids-control">
                        <input
                          type="checkbox"
                          checked={showSourceIds}
                          onChange={(event) =>
                            setShowSourceIds(event.target.checked)
                          }
                        />
                        Show source IDs
                      </label>
                    </div>
                    <QueryFeedback query={detail} name="customer detail" />
                    {detail.data && !detail.isError && (
                      <>
                        <h3 id="services-title" className="subheading">
                          Services and add-ons{" "}
                          <span className="item-count">
                            {detail.data.services.total}
                          </span>
                        </h3>
                        {detail.data.services.items.length === 0 ? (
                          <p className="empty-state">
                            No services or add-ons on this page.
                          </p>
                        ) : (
                          <ServiceTables
                            page={detail.data.services}
                            showSourceIds={showSourceIds}
                          />
                        )}
                        <h3 id="domains-title" className="subheading">
                          Domains{" "}
                          <span className="item-count">
                            {detail.data.domains.total}
                          </span>
                        </h3>
                        {detail.data.domains.items.length === 0 ? (
                          <p className="empty-state">
                            No domains on this page.
                          </p>
                        ) : (
                          <DomainTable
                            page={detail.data.domains}
                            showSourceIds={showSourceIds}
                          />
                        )}
                        {(detail.data.services.offset > 0 ||
                          Math.max(
                            detail.data.services.total,
                            detail.data.domains.total,
                          ) > detail.data.services.limit) && (
                          <p className="field-hint">
                            Services, add-ons and domains change pages together.
                          </p>
                        )}
                        <Pagination
                          name="Services and domains"
                          total={Math.max(
                            detail.data.services.total,
                            detail.data.domains.total,
                          )}
                          limit={detail.data.services.limit}
                          offset={detail.data.services.offset}
                          count={Math.max(
                            detail.data.services.items.length,
                            detail.data.domains.items.length,
                          )}
                          change={(detailsOffset) => update({ detailsOffset })}
                        />
                      </>
                    )}
                  </section>
                )}
                <section
                  className="panel collection-panel"
                  aria-labelledby="data-issues-title"
                  aria-busy={dataIssues.isFetching}
                >
                  <div className="collection-heading">
                    <h2 id="data-issues-title">Data issues</h2>
                    {dataIssues.data && (
                      <span className="item-count">
                        {dataIssues.data.total}
                      </span>
                    )}
                  </div>
                  <p className="collection-description">
                    All issues in these imported records, including records
                    without a customer.
                  </p>
                  <QueryFeedback query={dataIssues} name="data issues" />
                  {dataIssues.data && !dataIssues.isError && (
                    <>
                      {dataIssues.data.items.length === 0 ? (
                        <p className="empty-state">
                          No data issues on this page.
                        </p>
                      ) : (
                        <ul
                          className="data-issue-list"
                          aria-label="Data issues"
                        >
                          {dataIssues.data.items.map((dataIssue) => (
                            <li
                              key={`${dataIssue.recordType}:${dataIssue.sourceRecordId}:${dataIssue.code}:${dataIssue.field}`}
                            >
                              <strong>{issueLabels[dataIssue.code]}</strong>
                              <span>
                                {recordTypes[dataIssue.recordType].label}{" "}
                                {dataIssue.sourceRecordId} ·{" "}
                                {fieldLabels[dataIssue.field]}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                      <Pagination
                        name="Data issues"
                        {...dataIssues.data}
                        count={dataIssues.data.items.length}
                        change={(dataIssuesOffset) =>
                          update({ dataIssuesOffset })
                        }
                      />
                    </>
                  )}
                </section>
              </>
            )}
          </>
        )}
      </div>
    </>
  );
}
