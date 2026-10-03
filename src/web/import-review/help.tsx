import type { RefObject } from "react";
import { recordTypes } from "./labels";

export function HelpPanel({
  panelRef,
  recordTypesRef,
}: {
  panelRef: RefObject<HTMLDetailsElement | null>;
  recordTypesRef: RefObject<HTMLHeadingElement | null>;
}) {
  return (
    <details className="help-panel panel" ref={panelRef}>
      <summary>Help</summary>
      <div className="help-content">
        <section aria-labelledby="help-page-title">
          <h2 id="help-page-title">About this page</h2>
          <p>
            Review imported customer and service records before a migration. The
            sample records are fictional.
          </p>
          <p>
            For services and add-ons, no cancellation note means the source
            reported no cancellation request.
          </p>
        </section>
        <section aria-labelledby="record-types-title">
          <h2 id="record-types-title" ref={recordTypesRef} tabIndex={-1}>
            Record types
          </h2>
          <dl className="record-definitions">
            {Object.entries(recordTypes).map(([recordType, type]) => (
              <div key={recordType}>
                <dt>{type.label}</dt>
                <dd>{type.description}</dd>
              </div>
            ))}
          </dl>
        </section>
        <section aria-labelledby="help-date-title">
          <h2 id="help-date-title">Data as of</h2>
          <p>
            When the source records were captured. This can be earlier than when
            they were imported.
          </p>
          <p>
            An import is a saved copy of records from one source at a stated
            time. It may exclude some source records. Later imports leave
            earlier copies unchanged. Imports appear newest first by capture
            time; your choice stays fixed.
          </p>
        </section>
        <section aria-labelledby="help-counts-title">
          <h2 id="help-counts-title">Record counts</h2>
          <p>
            Selected means records chosen for the import. Linked records are
            included because those records refer to them, such as a service's
            customer. Lists include linked records.
          </p>
          <p>
            Selected and linked counts are checked against the import file.
            Excluded records and reported source totals have not been checked
            against the original system.
          </p>
          <p>
            Open Technical identifiers to see the file's original codes. A
            selection code names the records counted in a row. Reason codes
            identify why records were excluded; their meaning is defined by the
            exporter that created the file.
          </p>
        </section>
        <section aria-labelledby="help-issues-title">
          <h2 id="help-issues-title">Data issues</h2>
          <p>
            Imported records that need review, such as a missing related record,
            different customers on an add-on and its service, an unrecognized
            status or an invalid date. These do not tell you whether a service
            works or a migration is ready.
          </p>
        </section>
      </div>
    </details>
  );
}
