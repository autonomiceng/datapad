# Invoice emails and reminders

The portal sends an invoice email after verified issuance, then reminders seven days before the due date, on the due date and seven days overdue. The deployment supplies the send hour and fallback time zone. Scheduled invoices retain their captured billing time zone. The synthetic portal uses its configured time zone at 09:00 and sends only to its local test inbox.

Staff with billing access can inspect notices in Review invoice. Each row shows its scheduled time, delivery state and a short reason when held. The saved recipient and message preview appear after an attempt. A preview records the saved message; mail-server acceptance does not establish delivery to a person's inbox. Customer accounts cannot read staff notice records.

## Recipient and payment checks

Only the customer's explicit current billing contact can receive notices. Membership addresses, sign-in addresses and provider customer addresses are never substitutes. Missing contacts hold delivery. Once attempted, the recipient, profile version, message content and message ID are immutable. A changed recipient or changed content requires staff review before further delivery work.

Local calendar, initial-notice and billing-contact gates run before provider inspection and are checked again under the customer profile lock before sending. Repeated missing-contact and pending-initial-notice holds use growing delays capped at one hour. Reminders blocked by an initial notice needing review have no next attempt and leave the sweep until their sending window expires; expiry suppresses them locally.

Billing owns financial observations. Before sending, the worker retrieves current payment facts, then rechecks local state while holding billing's customer and invoice session locks. It suppresses paid or void invoices and holds mail while payment is processing, automatic collection is awaiting its attempt, or the result needs review. Financial evidence must be no older than five seconds; one additional inspection is allowed before deferring. SMTP runs outside a SQL transaction.

The initial invoice email must be accepted before reminders become eligible. A delayed run selects the currently relevant reminder and suppresses obsolete reminders. Late initial delivery suppresses reminders whose scheduled time has already passed. No accumulated reminder burst is sent after downtime. The overdue reminder window ends eight days after the due date at the configured send hour.

## Delivery and recovery

`src/notifications` owns four durable obligations per invoice, calendar eligibility, content and delivery state. Its public contracts are [runtime schemas](../src/notifications/contract.ts) and [module types](../src/notifications/types.ts). Billing exposes [a narrow observation interface](../src/billing/notice-types.ts); notifications cannot access billing internals or write financial state. The schema-only billing facade supplies foreign-key references.

The worker discovers verified finalized invoices and pending notices with separate bounded cursors. Repeated discovery preserves the unique deployment/invoice/stage identity. It commits the sending stamp and audit before invoking the SMTP port. If financial evidence expires after the stamp but before SMTP is called, the notice requires staff review with an explicit reason that it was not sent. If a process stops after that stamp, recovery marks delivery uncertain and requires review. It never blindly resends a possibly accepted message.

A proven temporary SMTP rejection can retry after one minute, then five minutes, with at most three attempts. Permanent rejection, exhausted attempts and ambiguous outcomes require review. No public send, reset or resend endpoint exists. [ADR 0012](adr/0012-uncertain-email-delivery.md) explains this boundary.

`src/server/notice-smtp.ts` adapts existing Nodemailer to the delivery port. The synthetic composition accepts only an explicit loopback SMTP address and an exact billing-contact allowlist. It disables message file and URL access, fixes the envelope sender, validates the recipient and classifies uncertain transport results conservatively. Authentication mail uses its separate recipient policy.

## Verification

`mise run pr:check` includes PostgreSQL calendar, financial suppression, authorization, delivery recovery and SMTP-boundary checks, plus the staff preview at desktop and narrow widths. `mise run test:portal:notices -- --config <private-config> --run-dir <private-run-directory>` checks real sandbox invoice delivery to the local Mailpit inbox, exact saved preview and the customer payment link. It preserves the prepared invoice request identity across repeats and makes no payment. Public CI requires no Stripe credentials and sends no external email.
