# Scheduled invoices

Scheduled billing turns explicitly activated [subscriptions](subscriptions.md) into durable invoice groups. It belongs to billing and uses the existing [invoice lifecycle](billing.md). Activation and issuance holds require the current staff billing grant. Customers with billing-read access can see their schedule and grouped history. Automatic payment arrangements remain separate groups, but these invoices still use manual payment. No automatic charging, reminder email or provisioning occurs.

## Activation and calendar

A staff member selects the first activated service period using its dates. Activation cannot precede the agreement's first unbilled period and cannot move after it is recorded. The selected period's issue instant must be strictly in the future. Earlier periods remain visibly Before activation. They never enter an automatic catch-up run.

Every activated agreement for one customer uses the same named timezone, issue hour and charge hour. The original anchors, cadence and stable period indices remain unchanged. Readiness is 21 calendar days before the due date at the captured local issue hour. The due cutoff is 23:59:59 in that timezone. Ambiguous or nonexistent local instants require review. Actual invoice finalization time comes from the provider receipt.

Activation increments both the schedule version and each newly activated subscription version. Current authorization, expected versions, globally unused request identity and the audit commit together. Repeating an unchanged configuration creates no audit or request reservation. A stale version or previously recorded request identity conflicts.

## Deriving and sealing groups

The worker visits schedules with a bounded customer cursor and a fixed inclusive high-water mark. A failed customer advances the cursor and can be retried in the next pass. For each customer, it examines the bounded date neighborhood from local today through today plus 21 days. It derives current commercial terms, billing state and cancellation from the original anchors. It does not scan or materialize the customer's entire missed history.

There can be at most one currently ready period per agreement. Stale unsealed materializations are refreshed while preserving their UUIDs. All arrangements on a due date must pass money, line-count, ownership, recipient, calendar and overlap checks before any group on that date seals. A problem in one arrangement blocks every sibling arrangement for that date.

Grouping preserves customer, due date, USD and manual or automatic arrangement. Positive groups become immutable invoice requests with explicit issue intent. Zero-valued lines remain visible beside positive lines. An all-zero eligible group becomes final No charge with no invoice, provider mapping or provider effect. If every period is paused or cancelled, nothing seals.

When at least one group seals, every applicable period receives its seal timestamp. Billable periods also receive their group claim. Paused and cancelled exclusions keep a null claim. Claims, invoice and lines, bill-to snapshot, issue intent and operator audit commit together. An audit failure rolls everything back. The worker's existing pending-work reader recovers a lost queue notification.

Sealed dates cannot accept another billable period or arrangement. A later unsealed eligible period is shown as Late for review. Sealed exclusions cannot be resumed into the historical invoice. Subscription revisions cannot rewrite sealed periods. No charge is a final historical outcome, not an editable forecast.

## Identity and recovery

Before sealing, billing locks the current customer profile and then the same customer advisory lock used by subscription changes. It takes the schedule row lock last. The frozen bill-to uses the current customer legal name, billing contact and profile version. An existing provider mapping whose original create-intent name differs from that legal name blocks the whole date, including when its provider receipt has not arrived. A concurrent first-mapping winner is checked again before persistence.

Each positive request uses unchanged period labels as line descriptions and period UUIDs as line origins, ordered by subscription UUID and period index. Calendar and canonical issue/cutoff instants are included in its digest. Existing manual request digests omit these new fields and remain unchanged. An explicit invoice-group relationship identifies scheduled invoices; an origin string never grants schedule authority.

Provider effects continue through the existing stable idempotency keys, committed attempt stamps and receipt verification. No provider call runs inside a sealing transaction. First customer creation, first invoice creation and first finalization each take a short schedule share lock, check the current hold and calendar cutoff, and commit their own attempt stamp before provider I/O. A hold defers an unstamped effect for 30 seconds without consuming retry attempts. Before limiting a work batch, the reader excludes held invoices whose next needed customer, invoice or finalization effect has no attempt stamp. It retains stamped receipt recovery, unfinished draft lines, finalization recovery and expired work that requires review. Manual invoices and provider events remain eligible independently. The delay only bounds retries when a hold races with an already selected job. A stamped effect can recover through the hold with its existing uncertainty deadline. Missing draft lines can be completed while held; an unstamped finalization still waits.

After the scheduled due cutoff, a first unstamped effect requires review. Previously stamped effects may recover the same resource. Manual invoices retain their existing UTC issue/cutoff policy and may finish finalization after an earlier invoice-create attempt. Retrieval, receipt trust and monotonic terminal financial states continue independently of issuance holds.

The schedule's bounded continuing-effects summary explains which existing attempts may finish after a hold. A hold is not a promise that every in-flight provider request has stopped.

## Public interfaces and runtime

`createScheduledBilling` exposes `configureSchedule`, `getSchedule`, `listScheduledGroups`, `sweepScheduled` and `assertSyntheticData`. The factory receives current customer authority/profile ports, transactional audit, exact synthetic policies and verified provider ownership. It does not receive a provider-effect implementation. Browser contracts are in `scheduled-contract.ts`; server composition types are in `scheduled-types.ts`.

HTTP exposes GET/POST `/api/customers/:customerId/billing-schedule` and GET `/api/customers/:customerId/scheduled-groups`. Browser mutation guards belong to these routes. There is no public sweep or clock-control endpoint. The history reader takes a date window of at most 36 months and paginates groups. It derives missed, late, excluded and review facts without performing writes. Empty history is not a statement about debt or source-owned periods.

The current runnable composition is synthetic and requires a verified Stripe sandbox for activation and scheduling. A credential-free demo reports the operation unavailable. Startup validates every activation, claim, frozen group snapshot and normalized request against the reviewed dataset, including final No charge records. The existing invoice inspection dispatches to the scheduled policy only through the explicit group relationship. Invoice detail reads carry the captured calendar, and date labels show its timezone. Manual invoices retain a null calendar and their existing UTC policy. The Stripe adapter verifies the captured due instant and all lines, including zero-valued lines. Provider account timezone affects hosted rendering and must be verified for the chosen composition.
