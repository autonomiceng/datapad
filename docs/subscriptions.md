# Subscriptions and billing forecasts

A subscription is a customer's recurring billing agreement. Billing staff can record an agreement, choose its first unbilled period, materialize a forecast and schedule future changes. Customers can read their agreements and forecasts. A forecast does not create an invoice, establish a balance, activate automatic payment or change a service.

The browser-safe [contract](../src/billing/subscriptions-contract.ts), server [interfaces](../src/billing/subscriptions-types.ts) and [schema](../src/billing/internal/subscriptions-schema.ts) define this slice. [ADR 0009](adr/0009-independent-subscription-terms.md) explains independent commercial/state revisions and the cancellation barrier. The [invoice contract](billing.md) remains separate.

## Ownership and authority

`createSubscriptions` takes a PostgreSQL pool, deployment namespace, the public customer authorization function, transactional audit writer, calendar policy, required synthetic agreement policy and an optional test clock. It has no provider, worker or legacy customer-registry dependency. Browser code imports only subscriptions-contract.ts; HTTP receives the public facade and composition's reviewed choices.

Reads require current customer-scoped billing access. Only the explicit staff billing role can create agreements, change them or materialize periods. Account administration alone, support and customer membership do not grant mutation authority. Every command checks current authority in its transaction, locks the customer's subscription changes, checks the target version, then commits its business changes and audit together. Provider calls and nested pool borrowing do not occur inside these transactions.

An agreement may reference one service owned by the same customer. Consulting can have no service reference. An add-on can have its own agreement and payment arrangement. Hosting containers, attachment changes and component settings do not combine or modify these agreements.

## Dates and first unbilled period

Service-period and due-date anchors are independent. Supported intervals are 1, 3, 6, 12, 24 and 36 months. Every boundary is calculated directly from its original anchor with Temporal's constrained calendar arithmetic: January 31 yields February 28 and then March 31; a February 29 annual anchor returns to February 29 in a leap year. The end of a service period is exclusive.

The due anchor can be up to one full calendar interval before or after the service anchor, inclusively. This includes ordinary advance billing and full-period arrears. Unsupported source arrangements require review instead of silently moving their dates.

Boundary options show dates beside their indices. The first unbilled index excludes earlier periods owned by the previous billing system; it does not assert that their debt was paid. Materialization never advances it or authorizes catch-up billing.

Each agreement captures an immutable timezone and issue/charge hours. Readiness is 21 calendar days before due date; issue and charge instants use their configured local hours, and due date ends at 23:59:59 local. Nonexistent or ambiguous local times produce a review reason and nullable instants. Changing runtime configuration does not rewrite existing agreements. Changing a captured calendar requires an explicit migration. [Scheduled billing](scheduled-billing.md) consumes these captured instants after activation.

## Revisions and cancellation

Commercial revisions contain label, amount and manual/automatic arrangement. State revisions contain Billable, Paused or Cancelled. Each period independently chooses the greatest applicable effective index, then revision, for each kind. A price revision cannot end a pause.

Changes require a strictly future service boundary and cannot affect any sealed period. They rederive all affected materialized unsealed periods in the same transaction, including periods from earlier forecast windows. UUIDs remain stable. Earlier and sealed facts stay unchanged.

A cancellation request alone changes no charges. Staff must approve or decline it. Approval records an immutable effective-period barrier and its cancelled state revision. That revision wins from the barrier onward, including over a resume already scheduled for a later period. The barrier cannot move or clear in this slice. Prior scheduled revisions remain history.

**Paused periods are not billed later.** An explicitly scheduled resume applies only from its chosen future boundary. A previously scheduled resume remains visible beside future state changes. Billing pause and cancellation do not suspend hosting, disable a component, delete data or change registration renewal.

## Materialization and forecast reads

The three tables store agreements, immutable term revisions and period facts. There is no mutable forecast-group table or stored classification. Periods record both selected revisions, commercial/state facts, dates and calculated instants. Repeated materialization preserves their identities and refreshes unsealed copies only.

One forecast window spans at most 36 calendar months and 3,700 periods. The current slice supports at most 100 agreements per customer. Newly materialized future due dates cannot exceed today plus 36 months, so repeated windows cannot accumulate an unlimited distant backlog. A future change refreshes at most `ceil(36 / intervalMonths) + 2` existing periods per agreement, allowing for independent anchors. Historical rows can remain without being rewritten by future changes.

Reads derive complete groups before pagination, using customer, due date, USD and payment arrangement. Missing materialized periods make the forecast incomplete and show Needs review; absence never means No charge. Group outcomes are Billable, No charge, Needs review or Inactive. Billable describes the forecast's commercial facts, without asserting activation or issue readiness.

Zero-valued eligible periods persist and support provisional No charge. Free lines remain visible within a positive group. Negative lines, unsupported totals, too many lines, past-due first charges, incompatible calendars and unresolved local times require review. Staff forms accept positive or free terms; signed stored amounts permit explicit review of future imported facts. Automatic arrangement does not establish consent.

A narrow overlap warning identifies positive billable periods of different agreements referring to the same service with overlapping service ranges. It also considers neighboring periods whose due dates lie outside the displayed group. Consulting without a service reference, free periods and inactive periods are exempt. There is no general duplicate-contract or override system.

Scheduled invoice sealing takes the same customer lock, rederives current membership and terms, and checks classification again. Positive and final zero groups seal at readiness. Forecast commands do not themselves set sealedAt or create provider effects.

## Commands, retries and synthetic policy

`listSubscriptions`, `getSubscription`, `getBoundaryOptions` and `getForecast` are reads. `createSubscription`, `changeSubscription` and `materializeForecast` are authenticated commands. Customer-scoped HTTP uses strict schemas, no-store responses and route-local Origin/content checks. Composition provides exact commercial choices and cancellation reasons for the synthetic demo; those fixture values do not live in the billing module.

Creation stores an original digest and supports an identical retry after current authorization. Changed creation input under the same identity conflicts. Other recorded mutation request IDs conflict globally. A genuine no-op creates no audit or request reservation; its previously unused identity can later name a real mutation. Version mismatch returns conflict. Persistence or audit failure rolls back all changes.

`assertSyntheticData` inspects every agreement, original creation intent, historical commercial revision, current cancellation reason and persisted period against the configured synthetic policy and derived facts. Sample labels or UUID prefixes alone are insufficient. Ordinary forecasts work without Stripe credentials. Public tooling and tests use isolated synthetic data; this module supplies no real-data or anonymous mutation bypass.

## Activation and sealed periods

[Scheduled billing](scheduled-billing.md) explicitly activates an agreement from a selected service period. Activation preserves original anchors and first-unbilled ownership, increments the subscription version and cannot move afterward. When any due-date group seals, all applicable periods become immutable, including paused or cancelled exclusions. A positive group references its invoice; a final No charge group has no invoice. Forecast remains a read-time classification and does not itself authorize issuance.
