# Import review architecture and contract

This is the reusable architecture for the import-review slice. Read it before adding modules, changing dependency directions or changing import/read behavior. [The data model](data-model.md) diagrams relationships and explains timestamps; [the glossary](../CONTEXT.md) defines domain terms; [stack and import-review ADRs](adr/) record the decisions. The versioned wire schemas in [`src/import-review/contract.ts`](../src/import-review/contract.ts) are authoritative for field names, required properties, bounds and response types. Shipped files in [`fixtures/import-review/`](../fixtures/import-review/) are complete synthetic format examples.

## Module ownership

| Location                                             | Owns                                                                                              |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `src/import-review/contract.ts`                      | Browser-safe strict runtime schemas and inferred wire/read types                                  |
| `src/import-review/index.ts`                         | Import review construction, import outcomes and the public read interface                         |
| `src/import-review/internal/`                        | Staging schema, validation, identity/digest, transactions, observation interpretation and queries |
| `src/server/app.ts`                                  | Read HTTP routes, offline OpenAPI composition and safe error mapping against an injected reader   |
| `src/server/index.ts`, `src/server/db/connection.ts` | Runtime composition, connection lifecycle, startup and shutdown                                   |
| `src/web/`, `src/web/import-review/`                 | React composition, same-origin fetch, navigation and import-scoped query cache                    |
| `scripts/`                                           | CLI, explicit migration/OpenAPI tasks and scoped local process composition                        |
| `drizzle/`                                           | Reviewed, explicit SQL migration history                                                          |
| `fixtures/import-review/`, `tests/`                  | Synthetic examples, real isolated PostgreSQL cases and the browser journey                        |

`createImportReview` constructs the import-review module, which exposes `importRecords`, `listSources`, `listImports`, `listCustomers`, `getCustomer` and `listDataIssues`. HTTP receives only `ImportReviewReader`, with no database handle. Web imports the contract and its own modules. Import review depends on neither transport nor web nor runtime composition. Private import-review modules are reached through its public entry point; exact migration schema tooling may import the private schema. Keep import tables and domain interpretation with import-review, and concrete connection lifecycle with runtime composition.

`mise run check:architecture` checks every application source, including type-only imports, for resolved imports, cycles and boundary violations. The build check also rejects server and import-review implementation code in the browser bundle. Introduce directories when they carry behavior, and raise an undecided interface or structural change before implementing consumers.

## Import semantics

A v1 `ImportFile` declares its schema version, source ID, source reference, Data as of, record counts and customer/service/domain arrays. Every property is required. Unset scalar values use `null`; empty collections use `[]`. Unknown fields, including contact details, notes and secrets, reject the input. Validation performs no coercion, injected defaults or cleanup. Strings must contain valid Unicode scalar values and cannot contain NUL. Pagination offsets support all derived data issues in a maximum-size import.

| Envelope member               | Meaning                                                                                                                                                                     |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion`               | Literal `1`                                                                                                                                                                 |
| `sourceId`, `sourceReference` | Opaque source identifier and that source's saved-copy reference                                                                                                             |
| `dataAsOf`                    | Valid UTC capture instant ending in `Z`, never the import time                                                                                                              |
| `recordCounts`                | Exactly one record-count entry for each of `customer`, `service`, `addon`, `domain`                                                                                         |
| `customers`                   | Customer source record ID and raw status                                                                                                                                    |
| `services`                    | Service/add-on record type and source record ID, typed customer and nullable attached service, product/hostname/status, cancellation flag, money and due/next-invoice dates |
| `domains`                     | Domain source record ID, typed customer, name/status, explicit term in years, money and due/next-invoice/expiry dates                                                       |

Record counts have one entry per supported record type. Selected and linked records are disjoint and deduplicated by typed record identity. Their counts sum to that record type's payload count; adding excluded records yields the reported source total. Exclusion reason counts sum to the excluded count. Selection and reason codes are bounded generic identifiers, with explicit zero counts. They contain no source queries or business filter expressions. Excluded counts and reported source totals remain claims until a separate exporter independently reconciles its consistent source read.

Import identity is the unique pair `(sourceId, sourceReference)`; stored imports also have an internal UUID for scoped reads. Record identity includes import, record type and opaque source record ID. A service and an add-on may share a source record ID. Customer and attached-service references include `recordType` and `sourceRecordId` within the same import. Missing related records remain visible as data issues. Customer labels derive from source record IDs, avoiding personal details.

Accepted observations are immutable. The digest covers the strict validated import file and schema version before persistence-derived values. Record arrays are sorted by typed identity, record-count entries by selection code and exclusion reasons by unique reason code; other arrays preserve meaningful order. RFC 8785 canonical JSON plus SHA-256 makes object-property and unordered-record ordering irrelevant. Identical content under the same identity returns `unchanged`; different content returns `conflict`. A later import preserves every earlier import and absence never implies cancellation.

One transaction inserts the import using its unique source identity and inserts children only after winning that insert. Concurrent imports use the database constraint to arbitrate: a separate statement reads an existing committed digest after a losing insert, without querying an aborted transaction. Invalid input and failed persistence leave no partial import.

Money is a required integer-minor-unit decimal string or `null`, with currency and source cadence retained. Canonical signed integers within PostgreSQL bigint range are accepted; negative zero, noncanonical strings and overflow reject the import. Null, zero and signed values remain distinct; the viewer infers no totals or balance.

Raw calendar dates and statuses remain available beside their interpretations. Calendar dates stay date strings, independent of timezone, with valid/unset/invalid states. A due date differs from a next-invoice date; capture time is a UTC instant. Unknown statuses remain visible. Domain term and cancellation true/false/unknown are observations, authorizing no action.

Data issues are derived from observations rather than stored independently. V1 codes are `missing_related_record`, `different_customer`, `unrecognized_status` and `invalid_date`. **Different customer** (`different_customer`) identifies an add-on whose attached service names a different customer in the same import. It preserves both source claims for review. A missing service and a different-customer issue are mutually exclusive; the maximum remains five issues per record. Each identifies the record type, source record ID and a safe field path. An unset date is unavailable without being invalid. Additional codes require an intentional contract change. Input rejection uses the distinct `ValidationIssue` type, including `invalid_record_counts` and `invalid_attachment`.

## Import and read behavior

`mise run import:file -- <file>` runs `scripts/import-records.ts` with an explicit `DATABASE_URL`, reads one file bounded to 32 MiB and 100,000 total records, validates it and imports synchronously. Exit codes are 0 for imported/unchanged, 2 for input errors/conflicts and 1 for operational failure. Errors expose issue codes and safe field paths, with payload values, SQL, credentials and filesystem paths omitted.

The operator CLI's fixture policy is outside the reusable import-review contract: canonical digests must match the allowlist derived from reviewed shipped fixtures. The server verifies the entire stored import set against that policy before listening. The slice provides no bypass flag. A naming prefix or `.test` domain alone does not establish synthetic provenance; trusted manual database tampering is outside this accidental-import control.

HTTP under `/api/import-review` exposes sources, source-scoped imports, import-scoped customers, customer detail and data issues (`/data-issues`). Customer and data-issue responses carry `importMetadata`; selection uses `importId`. There are no HTTP import or write routes. Lists have deterministic ordering, default page size 50 and maximum 200, including bounded child observations. Scoped missing resources return 404, invalid queries 422 and unavailable persistence 503; empty lists remain successful responses. Runtime schemas generate offline deterministic OpenAPI with stable operation IDs and explicit response/error schemas. API responses use `Cache-Control: no-store`.

The operator page is **Import review**. Its module, API, wire fields and database use the canonical language in [the glossary](../CONTEXT.md). Selection and browser query keys carry the internal import identity as `importId`. Multiple sources require explicit choice. Latest within one source orders by Data as of and then source reference; an explicit selection never silently switches after another import. The source and Data as of appear in the selection controls. One visible sentence explains the limit: “Review only. Billing and services stay in the original system.” Help provides short definitions and examples. Update Help, the glossary and the mappings below together when a concept changes.

## Terminology across layers

The page uses familiar hosting terms: Customer, Service, Add-on and Domain. These are the four supported record types. A customer account differs from a user who signs in; a service is a customer's instance of a product; a domain registration differs from a hostname on a hosting service. Help lists each type with an example. Keep explanations short and describe the business meaning before technical identifiers.

| Interface/domain term             | Code and wire representation                                                 | Database representation                                                                              |
| --------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Import review                     | `createImportReview`, `ImportReviewReader`, `src/import-review/`             | Owns the import tables                                                                               |
| Import                            | `ImportFile`, `ImportMetadata`, response `importMetadata`, scoped `importId` | `imports`, child `import_id`                                                                         |
| Customer, Service, Add-on, Domain | Customer/service/domain observations; add-ons have `recordType: "addon"`     | `import_customers`, `import_services` (services and add-ons), `import_domains`                       |
| Record type                       | `RecordType`, `recordType`                                                   | `record_type` and observation JSON `recordType`                                                      |
| Source                            | `sourceId`                                                                   | `imports.source_id`                                                                                  |
| Source reference                  | `sourceReference`                                                            | `imports.source_reference`                                                                           |
| Source record ID                  | `sourceRecordId`                                                             | `source_record_id`; relationship `customer_id` and `attached_service_id` also hold source record IDs |
| Data as of                        | `dataAsOf`                                                                   | `imports.data_as_of`                                                                                 |
| Record counts                     | `recordCounts`                                                               | `imports.record_counts` JSON                                                                         |
| Selection code                    | `selectionCode`                                                              | Record-count JSON `selectionCode`                                                                    |
| Selected                          | `selectedCount`                                                              | Record-count JSON `selectedCount`                                                                    |
| Linked                            | `linkedCount`                                                                | Record-count JSON `linkedCount`                                                                      |
| Excluded                          | `excludedCount`                                                              | Record-count JSON `excludedCount`                                                                    |
| Reported source total             | `reportedSourceTotalCount`                                                   | Record-count JSON `reportedSourceTotalCount`                                                         |
| Exclusion reasons                 | `exclusionReasons`, entries `reasonCode` and `count`                         | Record-count JSON with the same keys                                                                 |
| Attached service                  | `attachedService`                                                            | `import_services.attached_service_id` and observation JSON `attachedService`                         |
| Data issue                        | `DataIssue`, `listDataIssues`, route `/data-issues`                          | Derived from import records; no independent issue table                                              |

The customer route and page selection use `customerId` for the customer’s `sourceRecordId` within the selected import. The `customer_id` column stores that same value, matching observation JSON `customer.sourceRecordId`. These references do not identify a Datapad user or an operational customer account.

Naming conventions may change casing, hyphens, plurals or grammatical forms without introducing synonyms for a canonical concept. SQL columns use snake case; stored observation and record-count JSON retain contract keys. Drizzle's schema snapshot filenames name a tooling concept rather than an import.

Selected plus Linked equals the records shown in the lists. The importer checks those counts against the file. Excluded and reported source totals have not been independently checked against the original system. Lists include linked records, so a customer list can contain more records than the Selected customer count. Technical identifiers in Import details show the original Selection code (`selectionCode`) and exclusion Reason codes (`reasonCode`) from the file. Reason-code meanings belong to the exporter; the viewer preserves them without inferring explanations.

Help, Import details, Record counts and Technical identifiers retain their disclosure choices across source and import changes while the viewer is mounted, including loading and cached navigation. Reloading the page restores the default collapsed sections. Loading a different import never displays the prior import’s metadata as current.

Service and domain tables keep names, source prices, statuses and calendar dates visible for comparison. Product names sit beneath service names; add-ons follow their service when the typed relationship belongs to the same customer and the service is on the current page. Cancellation observations appear with status, invalid dates in their date cell, and unresolved attachments with the add-on. One customer-level Show source IDs control reveals record and attachment identifiers. Rows stack with field labels on narrow screens. See the [interface rules](../AGENTS.md#interface) for hierarchy and typography.

Help uses a native disclosure, usable with keyboard and touch. Record type lookup leads to its definitions without changing the selected source, import or customer. Essential context stays visible; do not require tooltips to understand the task. The Sample data badge is accurate because the fixture-only import and startup policy is enforced. Revisit that badge before changing the policy to accept other data.

## Synthetic demo and database changes

`mise run demo` builds, starts scoped loopback PostgreSQL, applies migrations, imports both shipped fixtures through the actual CLI and serves the built viewer. `mise run dev` uses the same lifecycle with Vite's same-origin API proxy. Repeat startup preserves imports. Database tests own separate disposable Compose projects and allocated loopback ports. Lifecycle scripts verify resource ownership before stopping or destroying resources.

A changed fixture needs a new import identity, or `mise run demo:destroy` may reset disposable local data while demo/dev are stopped. Reset removes that checkout's demo volume; it is separate from migration evolution. Preserve migrations once released or depended on by real installations. A reviewed change may replace an unmerged baseline used only by disposable synthetic demos, with an explicit demo reset. Generate reviewed migrations with `mise run db:generate` and apply checked-in migrations explicitly with `mise run db:migrate` before serving. Application startup does not push schema.

For demo databases created before the terminology alignment, stop demo/dev and run `mise run demo:destroy`, then `mise run demo` once. This unshipped slice uses one regenerated initial migration baseline. The unmerged contract remains `schemaVersion: 1`, with no legacy aliases; fixture values are unchanged, but renamed JSON keys change their canonical digests. Existing demo data is recreated explicitly rather than upgraded or rehashed. Reset applies only to the checkout's owned disposable synthetic demo database. Normal startup continues to preserve imports.

Use synthetic IDs, invented observations and `.test` domains in code, tests and review artifacts. The slice includes no source exporter/connectivity, financial reconciliation, billing writes, provisioning, authentication or production deployment. Access to real records requires separately reviewed data handling and staff authentication/authorization. Public tasks and CI remain independent of private configuration.
