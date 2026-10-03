# Payment settings

Customer administrators can save a card through Stripe, authorize automatic payments for selected subscriptions, and stop new automatic attempts. This slice records permission; it does not charge a card. Staff can inspect settings, but a staff role alone cannot authorize payments for a customer.

## Saving and authorizing

The customer first accepts the save-card terms and completes Stripe's hosted setup page. Returning to the portal only requests verification. The server independently retrieves the owned Checkout Session, SetupIntent and attached PaymentMethod before displaying the card's brand, last four digits and expiry. Card numbers, security codes and provider secrets never enter portal storage.

Automatic-payment consent is a separate confirmation. It names the saved card, subscriptions, prices, frequency and effective service periods. New permission starts at a future service period offered by the server. Selecting a manual subscription explicitly changes its payment arrangement from that period; other subscriptions keep their arrangement. A later commercial revision requires renewed consent.

Stopping automatic payments takes effect locally and needs no Stripe connection. It preserves the saved card and invoice schedule. An attempt already started may finish. Changing the method or consent scope creates a new immutable enrollment version; invoices sealed under the previous version require customer payment. The page lists those affected invoices before confirmation. [ADR 0010](adr/0010-explicit-payment-consent.md) explains this rule.

## Authority and persistence

Only a current customer administrator membership grants `manage_payment_settings`. Ordinary members and staff-only users can read permitted billing details. A person with both staff and customer-administrator roles can act through their actual membership. Account administrators are trusted to provision customer memberships. Consent stores the initiating user, session, membership and available invitation provenance; removing that administrator later does not erase customer consent. Staff see whether known consent provenance came from a staff or customer invitation, or is unknown.

Billing owns setup attempts, verified methods, immutable enrollments and their subscription scopes. Each record is bound to the deployment, provider account, operational customer and billing mapping. A setup request UUID binds immutable save permission and provider parameters. A repeated request cannot change those parameters. Enrollment commands bind expected versions and use the same customer subscription lock as term changes and invoice sealing.

The invoice group freezes enrollment and method IDs only when current permission covers every line, including free lines. Manual and No charge groups have no automatic-payment permission. Migration leaves existing groups without permission. A later opt-in cannot authorize a previously sealed invoice.

## Modules and recovery

Browser-safe schemas are in [`payment-settings-contract.ts`](../src/billing/payment-settings-contract.ts). [`payment-settings-types.ts`](../src/billing/payment-settings-types.ts) defines the facade and composition requirements. Billing internals own decisions and persistence; the Stripe adapter implements the narrow provider port. HTTP passes the current actor and scoped local IDs to that facade. The browser never chooses a provider customer or method identifier.

Setup shares existing customer-creation recovery and its stable effect identity. Provider I/O runs outside transactions under the mapping-customer and setup locks. A committed first-attempt timestamp bounds same-key recovery to 23 hours. Complete customer-scoped Session lookup can recover a lost response; ambiguous or expired recovery needs review.

Signed `checkout.session.completed` events persist a retrieval obligation before acknowledgement. The worker also sweeps pending setups, so a missing webhook or closed browser does not lose the work. Events and return URLs never grant recurring consent. Successful verification can finish after logout, while reads and consent changes recheck current authority.

The synthetic portal enables hosted setup only with its isolated sandbox configuration. Credential-free runs keep scoped local settings available and show hosted setup as unavailable. Local opt-out does not call the provider. Actual hosted setup acceptance is separate from credential-free CI. Bank-debit setup, migration of existing payment tokens and production provider configuration remain outside this slice.

## Sandbox acceptance

Run `mise run test:portal:payment-settings -- --config PRIVATE_CONFIG --run-dir PRIVATE_DIRECTORY` for the real hosted journey. Use a distinct owner-only directory outside Git and a Stripe sandbox key. The task creates sample subscriptions and a saved test card, explicitly authorizes one subscription, then stops that authorization. It sends no charge. Hosted challenges remain failures requiring normal customer completion.

For a reverse proxy, supply `--port 4400 --origin https://portal.example.test` to both the acceptance task and `portal:billing`, with the proxy pointing to that loopback port. Keep the origin stable for the retained run directory because setup requests preserve their exact return URLs. `--inbox-origin` can expose the sample mailbox through a separate proxy route. No task binds directly to a public interface.
