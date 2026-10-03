# Support requests

Customers open a ticket from their account or a service. Each ticket belongs to one customer and one service, with an optional web, mail or DNS component. Staff can reply, keep internal notes and propose work. This slice records decisions and results; it performs no hosting, domain or billing actions.

## Permissions and privacy

Current customer members can read and reply to their account's tickets. Staff need the support role. Billing or account administration alone grants no support access. Customer administrators approve proposals; support staff cannot approve on a customer's behalf. A proposal's author and an administrator who invited themselves cannot approve it. Staff can inspect membership provenance, including staff-issued invitations.

Internal notes are excluded before customer pagination and counts. They do not update the public ticket activity time or version. Replies and notes are append-only. Request IDs prevent a repeated mutation from creating another entry; reused requests and stale versions return a conflict. After an uncertain result-recording outcome, reload the ticket to see whether the result was recorded.

## Proposals and results

A proposal states the action, cost in USD and expected effect on data. Unknown cost or data effects block approval. Approval applies to the exact latest proposal revision and the current service/component versions. A change to either target requires a new proposal.

Staff record a completed result against the latest approved proposal, including verification time and the current target versions. The result may reflect the service changes described in the proposal. Staff can also resolve a ticket without changes and explain why. A new public reply reopens it. Recording completion does not execute the proposed work.

For verification time, staff can enter an explicit date and time or choose **Use current time**. The latter sends `verifiedAt: "now"`; the server records the time when the result is submitted, inside the authorized, locked result command. The stored result and response contain the actual ISO timestamp. A repeated request still conflicts and leaves the original result and verification time unchanged. Editing the explicit datetime control switches back to the entered time. The browser checks that an explicit date is parseable; the server rejects future verification times, completed results verified before approval, and unchanged results verified before ticket creation.

## Module contract

[`src/support/contract.ts`](../src/support/contract.ts) owns strict, browser-safe request and response schemas. [`src/support/types.ts`](../src/support/types.ts) is the callable domain contract. The support module owns tickets, thread entries, proposals and approvals. Access owns current roles and audit; Services owns target identity and version lookup. HTTP and React use these interfaces without importing persistence internals.

Mutations lock current authority, the ticket, service, component and audit request in the documented implementation order. Target ownership is enforced through composite database keys and checked again by the Services reader. Audit and the support mutation commit together. Audit stores IDs, versions and changed field names; message bodies stay in the support tables.

The support API uses authenticated customer-scoped routes, same-origin JSON writes and uncached responses. Read pages are bounded to 100 entries. The UI shows current server permissions, while every command independently checks authority again.

## Verification

`mise run pr:check` includes PostgreSQL tests for privacy, revoked authority, approval provenance, stale versions and result recording. The portal browser journey covers opening a request, a private staff note, a proposal, customer approval and the recorded result. Provider execution and machine identities remain separate future work.
