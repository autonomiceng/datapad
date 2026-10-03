# ADR 0010: Explicit, versioned automatic-payment consent

Status: Accepted

## Context

A stored payment method says where a charge could be sent. A subscription's payment arrangement describes the agreement. Neither proves permission for a particular invoice. Combined invoices also need a clear outcome when their selected card or authorized services change after issuance.

## Decision

Keep save-card permission separate from recurring-payment consent. Require a current customer administrator to explicitly choose a verified card and subscription scope. Store immutable enrollment versions with the accepted terms, human actor, membership evidence and exact commercial revisions and effective periods.

Invoice sealing captures the current enrollment and method only when every line is covered. A later change creates a new enrollment version and invalidates automatic collection for all invoices sealed under the former version. Those invoices remain payable by the customer. Show this consequence before confirmation. Revocation is immediate for new attempts; a previously committed attempt may finish.

New scope must start at a legal future unbilled service period. An identical retained scope can preserve its original boundary. Saving another card, returning from Stripe, a webhook, staff privileges or a later opt-in cannot add permission to an existing invoice.

## Consequences

The authorization rule is explicit and traceable from the customer confirmation to the invoice. It avoids partially charging combined invoices or silently applying a new card to old invoices. Customers may need to pay some already-issued invoices manually after changing settings. Selective reauthorization of sealed invoices would require a separately reviewed workflow.

Account administrators remain trusted to manage customer memberships. This model does not protect against a malicious administrator provisioning an identity they control. Known invitation provenance is retained without inventing historical role evidence. Financial consent survives removal of its original human administrator until explicitly revoked or superseded.
