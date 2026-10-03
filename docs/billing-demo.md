# Invoice sandbox demo

The retained invoice screen shows a synthetic customer, two service lines and payment status stored in PostgreSQL. Stripe collects a manual test payment through its hosted invoice page. No real customers, automatic charges, emails or recurring schedules are involved.

## Local checks

`mise run demo` opens import review and an empty **Invoices** page without credentials. `mise run pr:check` includes database recovery tests, raw webhook transport, adapter checks and browser navigation. These checks never contact Stripe.

## Real Stripe sandbox

Create an owner-only file outside every Git checkout containing exactly `STRIPE_SECRET_KEY=sk_test_...`. Give it mode `600`. Create a private parent directory for the run state, then run:

```sh
mise run billing:demo -- --config /absolute/private/sandbox.env --run-dir /absolute/private/invoice-demo
```

The task starts a separate persistent Compose database, loads reviewed sample imports, requests one $28 invoice and starts the application worker. The pinned Stripe CLI forwards signed invoice events to the loopback webhook endpoint. No public tunnel or Stripe CLI login is needed. Credentials stay in private files and child process environments; listener output containing its signing secret is withheld.

Open the printed URL and choose **Invoices**, then **Elm Studio (sample)**. The invoice becomes Unpaid when Stripe confirms finalization. Use **Pay invoice** to open Stripe's test payment page. Use a Stripe test card, such as `4242 4242 4242 4242`, a future expiry and any three-digit CVC. Return to Datapad: verified webhook processing should change the invoice to Paid. The last check timestamp shows when Stripe was last retrieved.

The issue date is frozen on the first run and the due date is 21 calendar days later in UTC. Restart the same command with the same run directory to retain the invoice, payment status and effect history. Never delete the run state while retaining its database or create a new deployment identity to retry uncertain work. Needs review means processing stopped for inspection.

Ctrl+C stops only this task's server, listener, worker and database. Database volumes and private run state remain. A lock records ownership; inspect the recorded process before removing a lock left by a hard interruption. `demo:destroy` affects the ordinary demo database, not this separate sandbox database.

The server binds to loopback. For remote review, use a tailnet-only proxy to that URL. A Stripe CLI listener handles webhook forwarding independently of the preview proxy. Keep the anonymous demo limited to the shipped synthetic content.

## Scope and recovery

The browser provides read-only list/detail endpoints. Invoice issue is an explicit operator command. PostgreSQL stores requests and outstanding work before provider effects; the worker recovers missed enqueue operations and duplicate events. Stripe status is retrieved before projection, so returning from the payment page alone never marks an invoice paid.

The operator `billing:refresh` task retrieves the stored synthetic invoice using explicit sandbox runtime environment configuration (`DATABASE_URL`, `BILLING_DEPLOYMENT_KEY`, `BILLING_ISSUE_DATE`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`). Keep these values private. It cannot create replacement invoices or reset an uncertain effect's history.

See [the billing contract](billing.md) for module boundaries, HTTP operations and retry rules. [The earlier provider proof](billing-proof.md) remains a separate timing experiment.
