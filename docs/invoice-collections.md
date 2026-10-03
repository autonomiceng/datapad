# Due-day automatic payment

A scheduled automatic invoice can make one payment attempt using the card and subscription consent captured when its invoice group was sealed. Every line, including a free line in a paid group, must still be covered by the current enrollment. Saving a card alone grants no payment permission.

The customer sees the invoice's financial status and its payment attempt separately. A paid invoice can still need staff review when the payment cannot be attributed safely to the scheduled attempt.

## Eligibility and recovery

The captured billing calendar supplies the charge time and due-day cutoff. New attempts require both calendar eligibility and a real wall time before cutoff. An eligible invoice left unattempted after cutoff is marked missed. Moving a test calendar backwards cannot reopen it.

Before reserving an attempt, Datapad retrieves the current invoice, its complete payment allocations and the saved method. Unknown, active or competing payments hold collection. Paid and void invoices cannot be charged. An external-payment receipt or invoice-resolution request also holds collection.

The database stores one immutable payment intention, remaining-balance baseline and idempotency key per invoice. Audit and dispatch reservation commit together. A process restart recovers that intention. Uncertain transport outcomes can use the identical request and key at most five times within 23 wall-clock hours. Processing payments are retrieved without another pay call. A definitive decline or authentication request consumes the automatic attempt.

A later enrollment change blocks recovery dispatch. When revocation and the first attempt race, the transaction that commits first determines whether that already-reserved invocation may finish. A successful provider response and matching payment allocation are required to attribute collection success; an invoice becoming paid by itself is insufficient.

## Customer payment and staff resolution

Ordinary invoice reads use stored observations. The Pay invoice action checks current provider evidence before navigating to Stripe. Customer members can request this retrieval-only check for their own invoice. They cannot dispatch automatic collection, choose a different amount, or change another customer's settings.

Pending and processing attempts hold staff settlement and void effects. Staff can still record the fact that an external payment was received; that evidence waits for reconciliation. Hosted authentication is offered only for the specifically owned payment requiring action, with no competing activity.

An issuance hold pauses invoice creation. It does not revoke payment consent or pause collection for an already-issued invoice.

## Module and storage

The billing module owns collections through `createInvoiceCollections`, its server-only types and the browser-safe `collection-contract.ts`. The Stripe adapter implements the narrow inspection, saved-method retrieval and invoice-pay ports. The worker schedules bounded, recoverable scans. HTTP has no charge endpoint.

`billing_payment_attempts` links the exact invoice, invoice group, customer mapping, frozen enrollment and saved method through ownership constraints. The invoice stores the latest collection observation and the group stores a missed cutoff. Provider identifiers and recovery evidence stay out of member responses.

Provider work happens outside database transactions while the existing customer and invoice session locks serialize conflicting local work. Short transactions then take the existing subscription lock when consent must be checked. Shared observation code reconciles worker, webhook and staff/customer checks without dispatching payment.

See [payment consent](payment-settings.md), [invoice resolutions](invoice-resolutions.md), [scheduled invoices](scheduled-billing.md), [the glossary](../CONTEXT.md) and [ADR 0011](adr/0011-durable-payment-attempts.md).

## Verification

Credential-free PostgreSQL groups cover eligibility, one-attempt concurrency, uncertain recovery, declines/authentication, and consent/payment-resolution races. Provider boundary tests verify the exact Stripe invoice-pay request. The portal browser check covers payment visibility and navigation at desktop and narrow widths. These checks run through `mise run pr:check`.

Actual sandbox acceptance is separate and requires owner-only configuration and evidence outside Git:

```sh
mise run test:portal:collections -- --config /private/stripe-sandbox.env --run-dir /private/collection-proof --phase prepare
mise run test:portal:collections -- --config /private/stripe-sandbox.env --run-dir /private/collection-proof --phase collect
mise run test:portal:collections -- --config /private/stripe-sandbox.env --run-dir /private/collection-proof --phase verify-restart
```

Preparation uses real hosted card setup and customer consent. Collection refuses to run before the actual captured due-day charge time or after cutoff. The final phase restarts the owned runtime and checks the same attempt and payment evidence. No production credentials, real customer records or live charges belong in this workflow.
