# Customer account demo

Run `mise run portal:demo` with Docker available. It builds the portal, starts an isolated PostgreSQL database and Mailpit inbox, applies migrations and prepares sample accounts. Open the printed portal URL at `/sign-in`. This composition requires no Stripe, Google or Microsoft credentials.

Use `staff@example.test` and choose **Send sign-in link**. Open **Sample inbox**, open the message and follow its link. These are real, short-lived mailbox verification links delivered locally. Mailpit has no external relay. Anyone with access to this synthetic inbox can sign in as its sample users; keep the demo on loopback or a trusted private network.

| Email                       | Sample access                                      |
| --------------------------- | -------------------------------------------------- |
| `staff@example.test`        | Account administration, billing and support        |
| `elm-admin@example.test`    | Elm Studio administrator                           |
| `birch-admin@example.test`  | Birch Works administrator                          |
| `collaborator@example.test` | Member of both customers                           |
| `outsider@example.test`     | Signed in, with no customer membership             |
| `invitee@example.test`      | Available for an invitation; no initial membership |

Staff can edit customer profiles and manage members. Customer administrators manage their own members. Ordinary members can read their accounts and scoped invoices. Inviting an email address grants no access until its verified user accepts the invitation. Removing a member takes effect on subsequent requests, and the final administrator cannot be removed.

Profile edits are limited to reviewed sample values. Elm accepts `Elm Studio (sample)` or `Elm Studio Updated (sample)` for display/legal names, and an empty billing email or `billing-elm@example.test`. Birch uses the corresponding `Birch Works (sample)`, `Birch Works Updated (sample)` and `billing-birch@example.test`. Changing a billing contact does not invite a member. Provider-profile changes remain pending when a linked provider still has different details; this account slice sends no provider updates. Historical invoice bill-to details remain unchanged.

Open **Services** from a customer account. Elm has two websites, an alias, separate mail delivery, a registration without hosting, and storage add-ons. Staff can save a requested component setting and attach or detach an add-on; provider state and billing stay unchanged. The sample provider states are fixture observations, never live checks. The demo omits external control-panel links; deployments can supply reviewed HTTPS links without credentials.

Sign out before trying another identity. Google and Microsoft are prepared in the authentication adapter; the synthetic demo leaves them unavailable. Their actual sign-in flows remain unverified until credentials and callback URLs are configured in a separately reviewed composition.

Ctrl+C stops the owned server and containers while retaining customer data. Restart preserves profile changes and membership removals. Run `mise run portal:destroy` while the demo is stopped to remove its disposable database. The anonymous import viewer and invoice sandbox use separate databases and entry points.

For a private-network reverse proxy, pass an exact external origin and optional inbox origin:

```sh
mise run portal:demo -- --origin https://portal.example.test --inbox-origin https://inbox.example.test
```

Configure the proxy to reach the printed loopback ports and preserve the original host. The application continues to listen on loopback. Authentication trusts only the configured origin. This task does not configure a proxy, publish a server or enable production records.

`mise run test:portal` runs the genuine mailbox sign-in, profile, invitation, scope and sign-out journey against a disposable database and inbox. `mise run test:app` covers domain authorization, transactional persistence, forward migration and the existing viewer. Both belong to `mise run pr:check`. The [account architecture](accounts.md) defines the access contract; [portal OpenAPI](../contracts/portal-openapi.json) documents its routes.

## Staff invoice sandbox

`mise run portal:billing -- --config "$STRIPE_SANDBOX_CONFIG" --run-dir "$STRIPE_SANDBOX_RUN_DIR"` adds the staff invoice workflow to the authenticated portal. The config and run directory must be owner-only and outside Git, using the same key-file format as the [invoice sandbox](billing-demo.md). Only test keys are accepted. The run directory preserves the deployment identity and owns a separate database; restarting it preserves prepared invoices and provider receipts. Stripe CLI forwards signed events to the local app. All sign-in and invitation mail stays in Mailpit.

Sign in as sample staff, open a customer and choose **Prepare invoice**. Select sample lines and a due date, then **Review invoice**. Preparation stores the invoice without contacting Stripe. **Issue invoice** authorizes the existing worker to issue that saved content. Only the explicit staff billing grant permits those commands. Customer members can view their own invoices and follow a verified payment link.

This manual sandbox uses the current UTC issue date and a due date within the following 21 days. Stripe uses a deterministic placeholder email; no invoice email is sent. The local billing contact is still preserved in the invoice snapshot. A changed legal name that differs from the original Stripe customer creation name blocks issuance until provider-profile synchronization is implemented. Editing a customer never rewrites an existing invoice.

Ordinary `portal:demo` keeps invoice creation visibly unavailable without provider configuration. It does not substitute a fake payment provider. Web, email and DNS preferences remain independent of billing.

`mise run test:portal:billing -- --config "$STRIPE_SANDBOX_CONFIG" --run-dir "$STRIPE_ACCEPTANCE_RUN_DIR"` runs the explicit provider acceptance journey in its own run directory. It prepares and issues through the portal, opens the customer's hosted test invoice, pays using Stripe's test payment API, and waits for the real signed webhook to update the customer view. It does not automate hosted card entry, which can require a provider challenge. The normal PR gate needs no Stripe credentials; this task is separate and its result must be reported when provider behavior changes.

The isolated demo allows 30 magic-link requests per minute because its sample accounts share one local client address. Sign-in still uses real, expiring one-use links, an explicit email allowlist and the local inbox. This synthetic composition does not configure production authentication or trusted proxy headers.

Open a customer's **Subscriptions** page to configure a recurring agreement and inspect a forecast. Choose a sample service and price, billing frequency, payment arrangement, original service and due-date anchors, and the first unbilled period. Staff explicitly generates forecast records and can schedule future terms or billing-state changes. Customer sign-in shows scoped read-only agreements and forecasts. This flow needs no Stripe key and has no invoice, payment or provisioning effects. See [subscriptions](subscriptions.md) for the rules and module boundary.
