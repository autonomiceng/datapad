# Billing operations

Billing staff can review outstanding provider and invoice-email work, pause billing actions and retrieve an existing outcome. Support, account administration and customer membership do not grant these controls.

## Pause and resume

Pause covers payment-account creation, invoices and their items, invoice finalization, payment-method setup, invoice settlement or voiding, automatic collection and invoice email. It also blocks another dispatch of an earlier request, even when the same provider idempotency key would be reused. An invocation admitted before pause committed may still complete.

Status retrieval and local reconciliation continue while paused. Existing retry windows, consent and per-customer issuance holds retain their meaning. Resume restores eligibility; it does not reset attempts, revive expired work or authorize another charge. Sign-in and invitation email use their separate existing access policy.

The absence of a control row means paused. A control change requires current billing authority, a reason, the expected version and a request ID. Its audit record commits with the change. Replaying the same request cannot undo a later pause.

## Review work

The queue reads existing durable records, including invoice emails through a narrow notification reader. It shows at most the oldest 100 pending, stalled or review items. The customer and invoice links lead to the existing workflows.

Check status retrieves and verifies the recorded effect. It never creates an invoice, starts setup, charges, settles, voids or sends email, including while writes are enabled. It cannot reset retry limits or resolve an uncertain mail delivery by sending again. A failed or still-pending check remains visible for staff review.

## Architecture

Billing owns the control table, queue projection and callable contracts in `operations-types.ts`; `operations-contract.ts` owns strict browser-safe schemas. Notifications exposes persisted delivery evidence without constructing a sender. HTTP enforces current sessions, same-origin JSON mutations and no-store responses.

Every write takes the financial guard's shared row lock last in the short transaction that records its dispatch. Pause takes current authority and then the exclusive guard lock, without acquiring domain locks. Provider and SMTP calls happen after commit. This ordering determines whether an invocation may complete across a pause without holding database transactions during network calls.

The worker keeps receipt recovery active and filters unstamped work while paused. Its queue messages convey identity, never permission. The [restore rehearsal](restore.md) uses a separate inspection process with no worker, provider or mail composition.

`mise run pr:check` covers current authority, audit rollback, missing controls, pause/dispatch serialization and retrieval-only checks. The restore checks use owned disposable PostgreSQL instances and the same exported snapshot for backup and comparison.

The synthetic portal starts paused, signs its sample staff account in through the local inbox, and submits one fixed resume request through the ordinary authenticated API. It signs that session out afterwards. An existing control decision or a later staff pause survives restart. This orchestration is limited to the synthetic local portal; production and restored databases receive no implicit resume.
