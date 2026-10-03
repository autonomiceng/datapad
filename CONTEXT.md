# Datapad terminology

Review copies of customer and service records before a migration. The original system continues to manage billing and services.

This glossary defines the canonical language for the interface, API, code and database. Casing, plurals and grammatical forms may follow each layer's conventions; use the same concept names across layers. [The architecture guide](docs/import-review.md#terminology-across-layers) maps these terms to their representations.

## Record types

A **record type** describes what an entry represents. Import review supports these four types:

**Customer**: A person or organization with a customer account, which groups their services and domains. A customer account can have several people who sign in.

**Service**: A service on a customer's account, such as web hosting. A product is the offering they choose; the service is their individual instance of it.

**Add-on**: An extra attached to a service, such as additional storage. It can have its own price and billing cycle.

**Domain**: A domain registration on a customer's account, such as `example.test`. A hostname shown on a hosting service does not by itself mean a domain registration is included.

## Customer access

**User**: A person who signs in. One user can belong to several customer accounts.

**Customer profile**: A customer's current display name, legal name and billing contact. Changing the profile leaves previously issued invoices unchanged.

**Billing contact**: The email destination chosen for a customer's billing messages. Being the billing contact does not grant account access.

**Member**: A user with access to a particular customer account.

**Customer administrator**: A member allowed to manage that customer's membership and invitations.

**Staff role**: An explicit permission to administer accounts, manage billing or provide support across customers.

**Invitation**: A time-limited offer of membership for a particular email address and customer. Access starts only after verified acceptance creates membership.

**Bill-to details**: The customer identity recorded on an invoice when it is prepared. Later profile changes leave those historical details unchanged.

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

**Subscription**: A customer's recurring billing agreement. It can cover a service, an add-on or work such as consulting without a hosted service.

**Entitlement**: A capability or allowance included in a customer's purchase or subscription. It can remain available while the customer chooses not to use it.

**Component**: An independently configurable capability within a service package, such as web, email or DNS hosting.

**Delivery**: Whether a component is hosted with the service provider or uses an external provider. This does not determine its manager or whether the package includes it.

**Domain registration**: An operational service that records a registered domain, registrar, expiry and renewal responsibility. It exists independently of web, email and DNS hosting. The import-review record type remains Domain.

**Requested setting**: What a customer or authorized staff member wants enabled or disabled.

**Provider state**: What the provider is confirmed to be delivering, with when it was last checked. The requested setting can be known while the provider state is unknown.

**Provider**: The organization or system delivering a service.

**Manager**: The person or organization administering a service. The manager can differ from its provider.

**Website**: A distinct site hosted within a web hosting service, with its own content.

**Domain alias**: An additional hostname that serves the same website.

**DNS zone**: DNS records administered together for a domain or delegated subdomain.

**Hosting account**: A provider container for hosted resources. It may supply several components under one or more commercial agreements.

## Invoices and payment

**Service period**: The time covered by a recurring charge. Its end date is exclusive: a period from January 1 to February 1 covers January.

**Billing forecast**: A preview of upcoming charges grouped by due date and payment arrangement. It does not create an invoice or establish an account balance.

**First unbilled period**: The first service period this portal may bill. Earlier periods remain the responsibility of the previous billing system.

**Calendar anchor**: The original date used to calculate recurring dates. A January 31 monthly anchor produces February 28 and then March 31. Service periods and payment due dates have separate anchors.

**Payment arrangement**: Whether a charge is intended for manual payment or automatic payment. An automatic arrangement still requires payment consent before a payment can be attempted.

**No charge**: A billing group whose eligible lines total zero. A forecast can change before it is finalized.

**Billing paused**: Selected future service periods are excluded from billing. They are not charged later when billing resumes. This does not suspend the service.

**Effective period**: The selected future service period when an agreement change starts applying. Earlier periods keep their existing terms.

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

- **Invoice schedule**: explicitly activated subscriptions whose ready periods can produce invoices. Activation selects a first period; earlier periods remain outside this schedule. New subscriptions need their own activation.
- **Invoice group**: the fixed set of periods combined for one customer, due date, currency and payment arrangement. Sealing records its membership and invoice request, or a final No charge result.
- **Issuance hold**: pauses new scheduled invoices and provider effects that have not started. Recovery of an already attempted effect can continue. It does not pause billing terms or service delivery.
- **Before activation**: first-unbilled periods skipped when choosing a later schedule start. This does not declare their old-system debt paid.

## Invoice resolutions

- **External payment**: money received outside Stripe, such as a check or Zelle transfer.
- **Receipt**: the recorded facts of an external payment. A receipt alone does not prove Stripe settlement.
- **Invoice resolution**: a durable request to settle an invoice from a received payment or void it, with its confirmation and review history.
- **Withdrawn receipt**: a mistaken receipt corrected before any provider attempt. Its original facts remain in the audit history.
- **Void invoice**: a finalized unpaid invoice canceled with the payment provider. Its service and subscription stay unchanged.

**Payment setup**: A request to save a card with the payment provider. Completion must be verified by the server and grants no recurring-payment permission.

**Saved payment method**: A provider-verified card associated with a customer, shown using its brand, last four digits and expiry.

**Automatic-payment enrollment**: An immutable version of a customer's permission to charge one saved method for selected subscriptions and effective periods.

**Enrollment scope**: The subscription, commercial revision and service periods covered by an automatic-payment enrollment.

**Payment collection**: Obtaining payment for an issued invoice, separately from preparing or issuing it.

**Payment attempt**: One recorded intention to collect an invoice automatically, including its outcome and recovery evidence. Repeating an uncertain request with the same key recovers this attempt.

**Missed automatic payment**: The due-day collection window ended before an automatic attempt was made. The customer still needs to pay an unpaid invoice.

## Invoice notices

- **Invoice notice**: an invoice email or payment reminder with a recorded recipient, delivery state and message content.
- **Reminder**: an invoice notice scheduled before, on or after the payment due date.
- **Accepted**: the mail server accepted the message. This does not prove that a person received or read it.
- **Uncertain delivery**: the portal cannot establish whether the mail server accepted an attempted message. Staff review is required before any further delivery decision.

## Support

- **Ticket:** a customer request about a service and, optionally, one hosting component.
- **Internal note:** an append-only staff message hidden from customers and their activity counts.
- **Proposal:** a versioned description of intended work, cost and effects on data.
- **Approval:** a customer administrator's recorded acceptance of one exact proposal and target version.
- **Result:** staff's verified account of completed work or resolution without changes. It records what happened; it does not perform the work.
