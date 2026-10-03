# Stripe billing proof

This operator-run experiment checks whether standalone Stripe invoices can support advance invoicing and payment on the due date. It uses two synthetic customers in a dedicated Stripe sandbox. It adds no production billing, recurring scheduler, emails, webhooks or portal routes.

The read-only report shows invoice dates, service lines, payment status and a timeline. Its hosted invoice links open Stripe's actual test payment page. Provider results remain unverified until the sandbox steps pass; local tests alone establish no Stripe behavior.

## Ownership and boundaries

The probe lives in `scripts/billing-proof/`. It has no dependency on the import-review module, database or browser application. The official MIT-licensed Stripe SDK owns provider communication. The ISC-licensed Temporal polyfill supplies calendar and timezone arithmetic. Both are pinned development dependencies because this is operator tooling.

Dates are calendar dates in an explicit timezone. Readiness is 21 calendar days before the due date. The proof uses UTC for examples and checks daylight-saving behavior separately. Its UTC charge time chooses no production schedule.

Invoices use `collection_method=send_invoice`, an explicit `due_date` and `auto_advance=false`. The operator explicitly finalizes them when ready and attempts authorized automatic payment when due. Disabling automatic advancement also disables Stripe's automatic emails, reminders and retries. A future portal must implement those responsibilities before cutover.

Same-customer, same-date service lines share an invoice. Different dates remain separate. A group containing only free services remains visible as **No charge** and creates no Stripe invoice. Positive amounts below Stripe's minimum are outside this experiment.

Stripe's test clock is the time source. The initial provider check must establish that standalone invoices and the hosted payment page work with that clock. An incompatible flow stops the experiment. Do not silently substitute a local clock or report an operator action as a scheduled background job.

## Private configuration and evidence

Supply a Stripe sandbox secret key in an owner-only file outside the checkout. Never paste it into a command argument or commit it. The probe rejects live credentials and requires test-mode objects. Use a dedicated sandbox so all newly created objects are disposable and easy to identify.

The run directory also belongs outside Git. It holds the manifest, generated report and captured results. Only tagged objects created by that run are used. The probe never takes an existing customer's ID as input. No emails are sent and no real customers or payment methods are used.

Each operation records its immutable intent before calling Stripe. Idempotency keys and metadata support recovery. One invocation owns a run exclusively; completed and uncertain operations survive restarts. A missing local response is reconciled against owned provider objects. An unresolved outcome stops for review, including after an idempotency key may have expired. This is a single-operator proof, with no claim of distributed scheduling or universal exactly-once execution.

The report is an explicit projection of selected fields. The server serves only `report.html`; it supplies no API, directory listing, manifest access or payment controls. Its default address is loopback. For a private-network review, bind to the host's private-network IP and use the printed port. Hosted test invoice links grant access to those synthetic invoices, so share the report only with intended reviewers.

## Operator commands

First create a private parent directory and an owner-only environment file containing `STRIPE_SECRET_KEY=sk_test_...`. Use the real sandbox key in that private file. All commands below take the same explicit configuration and run directory:

```sh
mise run billing:proof -- init --config /private/stripe-sandbox.env --run-dir /private/proof-run --start-date 2030-01-01
mise run billing:proof -- prepare --config /private/stripe-sandbox.env --run-dir /private/proof-run
mise run billing:serve -- --run-dir /private/proof-run
```

The paths are placeholders outside Git. `init` creates a Stripe test clock and two synthetic customers. `prepare` creates and finalizes ready invoices. Stop after the first preparation to inspect the real Hosted Invoice Page and verify its dates and payment explanation before advancing further.

Use `advance --to 2030-01-02T00:00:00Z` with the same configuration/run arguments to request a Stripe clock advance. Run `refresh` until Stripe reports the clock ready. Then run `prepare`. Repeat on January 3, 4 and 5 so each example is prepared on its readiness date. Inspect the report after each step.

- Pay the manual and early-payment examples using Stripe's hosted test payment page. Retrieve their state with `refresh`.
- Run `void` before the void example's due time.
- Advance to the day before the first due date. Run `collect` and confirm no payment attempt occurred.
- Advance to January 22 at 09:00 UTC, refresh, and run `collect` twice. Confirm the combined invoice is paid once.
- Advance through the remaining due times shown in the report. Repeat `collect`; inspect the early-payment skip, declined payment, authentication requirement and void skip. Complete the authentication example on its hosted page, then refresh.
- For interruption recovery, add `--interrupt-after-invoice` to a `prepare` command before it creates a new invoice. That command intentionally exits unsuccessfully after Stripe creates the invoice. Repeat without the flag and verify the same invoice is recovered. Completed groups remain unchanged.

`prepare` rejects a new invoice once its due time has arrived. Start a fresh run if an example was missed; existing operation intents still reconcile without creating a replacement.

`refresh` only retrieves state. `collect` sends at most one explicit attempt per eligible example; it has no retry campaign. An uncertain result stops for operator review. A leftover `run.lock` after process termination must be removed only after verifying its recorded process is no longer running. Keep the manifest and operation intents intact.

## Acceptance

Run local checks through `mise run test:billing-proof`. They require no credentials and are part of `mise run pr:check`. Run provider commands through `mise run billing:proof -- ...`. Actual sandbox validation is a separate acceptance step and is never silently skipped by CI.

Verify these seven cases using the provider state and report:

1. Two same-date lines combine, a different date stays separate, and free-only groups create no invoice.
2. An invoice becomes ready 21 days before due. It stays open with no payment attempt through the preceding day. Inspect the hosted invoice's dates and automatic-payment explanation.
3. Automatic payment happens once at or after the configured due time. Repeating collection creates no additional charge.
4. Pay a manual invoice on Stripe's hosted page. Also pay an automatic example early; later collection skips it. Confirm both by retrieving Stripe state.
5. A declined payment and an authentication-required payment stay unpaid with clear next steps. Complete authentication through the hosted page and retrieve the result.
6. Void an example before due; collection makes no payment attempt on it.
7. Interrupt after creating an invoice but before recording the response. Recovery finds the same invoice, lines and payment state without duplicating them.

Stripe's `attempt_count` is its own invoice attempt counter, not the number of operator payment requests. The authentication-required example can show zero until authentication is completed.

A successful browser redirect is never payment evidence. Preserve the retrieved Stripe status and observed attempt counts. The report must distinguish incomplete cases from successful ones.

## Agent guidance

Run `mise run agents:stripe-skills` to install Stripe's maintained `stripe-best-practices` and `upgrade-stripe` skills locally for Codex and Claude. The installer version is pinned; the official catalog supplies current guidance. Installed skill directories and their local lockfile are ignored by Git. This opt-in task is separate from dependency installation, CI and runtime code. New skills are available on the next agent turn.

Use the skills alongside [Stripe's agent documentation](https://docs.stripe.com/agents). Verify version-sensitive advice against current API references: skill version tables can lag SDK releases. The approved experiment scope still applies; generic subscription guidance does not turn this proof into a subscription implementation or authorize production changes.

## References

- [Create an invoice](https://docs.stripe.com/api/invoices/create)
- [Pay an invoice](https://docs.stripe.com/api/invoices/pay)
- [Automatic advancement and collection](https://docs.stripe.com/invoicing/integration/automatic-advancement-collection)
- [Test clocks and API limitations](https://docs.stripe.com/billing/testing/test-clocks/api-advanced-usage)
- [Idempotent requests](https://docs.stripe.com/api/idempotent_requests)
- [Uncertain outcomes and low-level errors](https://docs.stripe.com/error-low-level)
- [Stripe SDK](https://github.com/stripe/stripe-node)
- [Temporal polyfill](https://github.com/js-temporal/temporal-polyfill)
