# Datapad terminology

Review copies of customer and service records before a migration. The original system continues to manage billing and services.

This glossary defines the canonical language for the interface, API, code and database. Casing, plurals and grammatical forms may follow each layer's conventions; use the same concept names across layers. [The architecture guide](docs/import-review.md#terminology-across-layers) maps these terms to their representations.

## Record types

A **record type** describes what an entry represents. Import review supports these four types:

**Customer**: A person or organization with a customer account, which groups their services and domains. A customer account can have several people who sign in.

**Service**: A service on a customer's account, such as web hosting. A product is the offering they choose; the service is their individual instance of it.

**Add-on**: An extra attached to a service, such as additional storage. It can have its own price and billing cycle.

**Domain**: A domain registration on a customer's account, such as `example.test`. A hostname shown on a hosting service does not by itself mean a domain registration is included.

## Reviewing imported data

**Source**: The system the records came from. Different sources can use the same record identifiers for different customers or services.

**Import**: A saved copy of records from one source at a stated time; it may exclude some source records. Later imports leave earlier copies unchanged.
_Avoid_: Snapshot

**Import review**: Inspecting imported customers, services, add-ons, domains and data issues before planning a migration.
_Avoid_: Inventory, source observations

**Source reference**: The source's identifier for one saved copy. It distinguishes imports from the same source, including imports with the same capture time.

**Source record ID**: The source's identifier for a record. Its meaning is scoped to the import and record type; a service and an add-on can share an ID.

**Data as of**: The time the source records were captured. It can be earlier than the time they were imported.

**Record counts**: Counts for each record type. Selected and linked counts are checked against the import file; excluded records and reported source totals have not been independently checked against the original system.
_Avoid_: Declared population, population manifest

**Selection code**: The import file’s identifier for the record selection counted in one row.
_Avoid_: Population code

**Reason code**: The import file’s identifier for why records were excluded. Its meaning is defined by the exporter that created the file.

**Selected**: Records chosen for the import.
_Avoid_: In scope

**Linked**: Extra records included because selected records refer to them. For example, importing a service may also require its customer's record.

**Excluded**: Source records left out of this import.

**Reported source total**: The source count reported by the import file. It is the sum of selected, linked and excluded records.

**Exclusion reasons**: The reason codes and counts reported by the import file for excluded records.

**Attached service**: The service an add-on attaches to, when the source supplies that relationship. The add-on also names its own customer.
_Avoid_: Parent service

**Data issue**: Something in the imported records that needs review, such as a missing or inconsistent relationship, an unrecognized status or an invalid date. It does not establish whether a service works or a migration is ready.
_Avoid_: Exception, readiness score

**Cancellation requested**: Whether the source recorded a cancellation request: yes, no or unknown. Reviewing this value does not cancel anything.

## Service packages and components

**Package**: An offered combination of services, limits and pricing.

**Subscription**: A customer's recurring agreement for an offering.

**Entitlement**: A capability or allowance included in a customer's purchase or subscription. It can remain available while the customer chooses not to use it.

**Component**: An independently configurable capability within a service package, such as web, email or DNS hosting.

**Requested setting**: What a customer or authorized staff member wants enabled or disabled.

**Provider state**: What the provider is confirmed to be delivering, with when it was last checked. The requested setting can be known while the provider state is unknown.

**Provider**: The organization or system delivering a service.

**Manager**: The person or organization administering a service. The manager can differ from its provider.

**Website**: A distinct site hosted within a web hosting service, with its own content.

**Domain alias**: An additional hostname that serves the same website.

**DNS zone**: DNS records administered together for a domain or delegated subdomain.

**Hosting account**: A provider container for hosted resources. It may supply several components under one or more commercial agreements.

## Invoices and payment

**Invoice request**: An instruction to prepare one invoice for a customer with stated lines, currency, issue date and due date. Repeating the same request does not create another invoice.

**Origin key**: The stable identity of an invoice request. Different billing periods or separate pieces of work have different origin keys.

**Invoice**: A request for payment for stated lines by a due date. Its payment status describes the provider's confirmed state.

**Invoice line**: One described charge on an invoice, with an amount in that invoice's currency.

**Origin reference**: An optional reference explaining what an invoice line was requested for. It does not itself establish a service relationship.

**Issue date**: The intended calendar date for making an invoice available for payment. The actual issue time can differ when preparation is delayed.

**Due date**: The calendar date by which an invoice is payable.

**Readiness date**: The earliest calendar date on which an invoice may be issued. This billing slice uses 21 days before the due date.

**Preparing**: An authorized invoice is being created or finalized and is not yet available for payment.

**Needs review**: Preparation or reconciliation cannot safely continue without resolving an uncertain or conflicting outcome.

**Last checked**: When the invoice's current state was last successfully retrieved from its payment provider.
