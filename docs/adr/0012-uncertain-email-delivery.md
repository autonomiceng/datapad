# ADR 0012: Preserve uncertain email attempts

Status: Accepted

## Context

SMTP can accept a message before a connection drops or the sender commits its success receipt. Retrying that message can send duplicate invoice reminders. A stable Message-ID helps identify an attempt but does not require a receiving server to deduplicate it.

## Decision

Persist each invoice notice and its immutable recipient/content stamp before delivery. Mail-server acceptance completes the obligation. Retry only a proven temporary nonacceptance, with bounded delays and attempts. An ambiguous response or recovery of an unfinished sending stamp requires staff review; no automatic resend occurs.

The initial invoice email gates reminders. Each reminder has a calendar window, and missed windows are suppressed to avoid a burst after downtime. Billing supplies fresh financial disposition under its existing customer/invoice locks. Notifications owns delivery and has no authority to collect payment or change invoice state.

## Consequences

A crash before SMTP dispatch may leave a message unsent and needing review. That visible uncertainty is preferable to automatically sending duplicate demands for payment. A later reviewed workflow may add explicit operator resolution. This increment exposes status and stored content without a reset or force-send action.
