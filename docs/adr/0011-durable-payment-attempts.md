# ADR 0011: One durable automatic-payment attempt per invoice

Status: Accepted

## Context

Datapad preserves service renewal dates and groups invoices by payment arrangement. Stripe hosts payment collection, while the portal owns the agreed billing calendar. Worker retries, customer payments, consent changes and external receipts can race. A missing HTTP response does not prove that a charge failed.

## Decision

Persist one immutable payment intention per invoice before sending the provider request. Bind it to the sealed group, current frozen consent, verified saved method and complete remaining-balance observation. Reuse the same provider idempotency key only for bounded recovery of an uncertain result. A decline or authentication request ends automatic dispatch for that attempt.

Use separate clocks: the business calendar determines when work becomes eligible; real wall time controls provider-effect age, observation freshness and the first-attempt cutoff. Local customer and invoice locks serialize collection with invoice resolutions. The subscription lock serializes payment consent with dispatch reservation. Provider I/O remains outside transactions.

Keep financial invoice status separate from collection attribution. Accept success only when the stored response and exact owned payment allocation support it. Conflicting or incomplete evidence needs review. Customers can still act through a freshly checked hosted flow.

## Consequences

Restarts cannot silently create a replacement automatic attempt. Uncertainty can require staff review, including when an invoice is already paid. Changing payment consent invalidates old sealed permission as described in ADR 0010.

A local lock cannot prevent a concurrent action on Stripe's hosted page. Complete post-call inspection therefore remains necessary. Idempotency recovery stops before Stripe's key-retention boundary, and automatic retries after a definitive decline require a separate future policy.
