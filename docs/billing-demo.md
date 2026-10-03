# Invoice sandbox demo

Use the authenticated [customer portal](accounts-demo.md) for current sandbox billing:

```sh
mise run portal:billing -- --config /absolute/private/sandbox.env --run-dir /absolute/private/portal-demo
```

Staff sign in through the local inbox, prepare an invoice and explicitly issue it. The synthetic portal bootstrap enables billing actions once through the normal staff API. Later staff pauses survive restarts. See [billing operations](billing-operations.md) for the pause boundary and recovery workflow.

The earlier anonymous invoice-issuance launcher has been retired. Preserve its private run directory, database volume, deployment identity and provider references when inspecting existing evidence. Do not reuse that run directory with a different launcher or issue replacement invoices to reproduce an uncertain outcome.

`mise run demo` still provides credential-free synthetic import review and an empty invoice screen. It does not enable provider writes. `mise run pr:check` covers database recovery, webhook transport, provider adapters and browser navigation without contacting Stripe.

## Inspect earlier sandbox evidence

`mise run billing:refresh` retrieves stored synthetic invoices using explicit private runtime configuration (`DATABASE_URL`, `BILLING_DEPLOYMENT_KEY`, `BILLING_ISSUE_DATE`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`). This command can reconcile existing evidence; it cannot issue replacement invoices or reset effect history. Keep those values outside Git.

For portal reconciliation, use the staff invoice check or billing operations page. Returning from a hosted payment page alone never marks an invoice paid. See [the billing contract](billing.md) for module boundaries and retry rules.
