# Billing architecture and contract

Billing stores explicit synthetic invoice requests, lets billing-authorized staff review and confirm them, issues positive USD invoices for manual payment and displays retrieved Stripe status. [Scheduled billing](scheduled-billing.md) also issues invoices from explicitly activated subscriptions. [Invoice resolutions](invoice-resolutions.md) records received external payments and voids unpaid invoices with provider confirmation. [Payment settings](payment-settings.md) adds hosted card setup and explicit subscription consent. [Invoice collections](invoice-collections.md) makes one due-day automatic payment attempt under the captured consent, with durable recovery and separate payment attribution. [Invoice notices](invoice-notices.md) sends invoice emails and reminders through the local test inbox. Real customer data remains outside this composition. The separate [account composition](accounts.md) supplies authentication and current customer-scoped reads. [The glossary](../CONTEXT.md) defines the terms; [ADR 0007](adr/0007-invoice-ownership-and-recovery.md) records ownership and recovery decisions. [Runtime schemas](../src/billing/contract.ts), [the provider port](../src/billing/provider.ts) [public module types](../src/billing/types.ts) and [the schema](../src/billing/internal/schema.ts) are the concrete contracts.

## Module ownership

| Location                            | Responsibility                                                                                           |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `src/billing/contract.ts`           | Browser-safe runtime request/read schemas and inferred types                                             |
| `src/billing/index.ts`, `internal/` | Request validation, immutable intentions, database rules, issuance, recovery and read projection         |
| `src/billing/provider.ts`           | Provider-neutral inputs, validated receipts and small provider/verifier interfaces                       |
| `src/stripe/`                       | Official Stripe SDK, resource ownership checks, paginated recovery lookup and raw signature verification |
| `src/worker/`                       | pg-boss delivery, bounded retries, pending-work sweep and shutdown                                       |
| `src/server/`                       | Composition, database lifecycle, read HTTP and raw webhook transport                                     |
| `src/web/billing/`                  | Scoped list/detail, staff preparation and confirmation, same-origin polling                              |
| `scripts/`                          | Reviewed synthetic loader, operator commands and sandbox acceptance                                      |

Billing imports no import-review, Stripe SDK, worker, HTTP or browser implementation. Provider adapters import the billing port; workers import billing's public commands. Browser code imports only browser-safe billing contract modules. HTTP receives readers, authenticated workflow commands and event intake, with no database handle. Billing calls public customer authorization/profile ports and the transactional access audit writer. Only migration tooling and billing internals access the internal billing schema. Notifications imports the schema-only facade for foreign-key references and uses public billing observations for payment state. Import review remains independent and immutable.

## Public module interface

`createBilling({ pool, provider, customers, deploymentKey, now? })` constructs the module. `pool` is a PostgreSQL `Pool`; `provider` implements `BillingProvider`; `customers` is the operator-composed customer registry using the caller's transaction; `deploymentKey` is a stable deployment namespace and must equal `provider.ownership.deploymentKey`. Provider account identity is verified at composition time and checked against every stored mapping. The optional `now: () => Date` is a test seam; runtime uses the actual clock. No domain code knows fixture names or permanent demo dates.

`billing_customers` preserves provider mapping IDs, original creation intent and effect receipts. Its required `customer_id` references the stable operational customer. `invoices.billing_customer_id` references that mapping; public `invoice.customer.id` identifies the operational customer. Invoice bill-to name, contact and profile version are copied when the request is first stored. A profile edit preserves the provider mapping and every historical invoice. Forward migration retains old IDs and backfills unavailable historical contact as null.

`createBillingReader({ pool, deploymentKey })` returns the same read methods and `assertSyntheticData` without a provider or credentials. Ordinary demo/CI can serve an empty billing database through that reader; it must not construct a fake provider. The policy check accepts optional expected account identity; a nonempty dataset must supply it from private runtime configuration before serving. Provider IDs and account IDs are never browser configuration.

`src/billing/index.ts` exports `createBilling`, `createBillingReader`, `createBillingWorkflow` and the public types from `types.ts`. Factory signatures are `createBilling(options: BillingOptions): Billing` and `createBillingReader(options: BillingReaderOptions): BillingReader`.

The factory returns these methods. Input and response types come from the runtime contract or provider port. The operator/lifecycle commands remain server-only; the authenticated workflow below supplies the staff browser operations.

```ts
interface BillingReader {
  listInvoices(page?: Partial<BillingPagination>): Promise<InvoicesResponse>;
  getInvoice(invoiceId: string): Promise<InvoiceResponse | null>;
  listInvoicesForCustomers(
    customerIds: string[],
    page?: Partial<BillingPagination>,
  ): Promise<InvoicesResponse>;
  getInvoiceForCustomers(
    customerIds: string[],
    invoiceId: string,
  ): Promise<InvoiceResponse | null>;
  providerProfile(
    customerId: string,
    profile: { legalName: string; billingEmail: string | null },
  ): Promise<"not_linked" | "unchanged" | "pending">;
  assertSyntheticData(
    allowedRequests: InvoiceRequest[],
    accountId?: string,
    allowedBillTo?: Array<{ legalName: string; billingEmail: string | null }>,
  ): Promise<void>;
}

type RequestResult =
  | { kind: "created" | "unchanged"; invoiceId: string }
  | { kind: "conflict" }
  | { kind: "invalid"; fields: string[] };

type IssueResult =
  | { kind: "accepted" | "unchanged" }
  | { kind: "not_found" | "not_ready" | "past_due" | "needs_review" };

type WorkResult = "complete" | "retry" | "needs_review";
type PendingWork =
  { kind: "issue"; invoiceId: string } | { kind: "event"; eventId: string };

interface PendingCursor {
  createdAt: string;
  kind: "issue" | "event" | "resolution" | "payment_setup";
  id: string;
}
interface PendingInput {
  limit?: number;
  after?: PendingCursor | null;
  through?: PendingCursor | null;
}
interface PendingPage<T> {
  work: T[];
  next: PendingCursor | null;
  through: PendingCursor | null;
}

interface BillingCommands {
  requestInvoice(input: unknown): Promise<RequestResult>;
  requestIssue(invoiceId: string): Promise<IssueResult>;
  issueInvoice(invoiceId: string): Promise<WorkResult>;
  refreshInvoice(invoiceId: string): Promise<WorkResult>;
  acceptEvent(
    event: VerifiedInvoiceEvent,
  ): Promise<"accepted" | "duplicate" | "ignored">;
  processEvent(eventId: string): Promise<WorkResult>;
  pendingWork(input?: PendingInput): Promise<PendingPage<PendingWork>>;
}
```

`Billing` combines `BillingReader` and `BillingCommands`. Methods always scope queries to the configured deployment. Unknown refresh/worker IDs are complete no-ops. Operational failures throw safe errors; no SQL, provider response, credentials or private paths enter HTTP errors. `assertSyntheticData` is composition's policy seam: it verifies the full stored request set against the supplied reviewed requests, customer content and configured sandbox ownership. It also refuses orphan customer records or foreign deployment/account records. This control is for accidental import prevention; trusted direct database tampering is outside its threat model.

`requestIssue` commits `issueRequestedAt` before returning accepted. The caller may then enqueue, but durable pending work is sufficient if that enqueue is lost. Repeated calls are unchanged. `issueInvoice` requires an existing authorized issue request and cannot turn an unissued request into one. `refreshInvoice` only retrieves/reconciles the existing provider invoice and never starts a new create. `pendingWork` accepts `PendingInput` and returns `PendingPage<PendingWork>`. Limits default to 100 and must be 1 through 100. It returns authorized unfinished issuance and unprocessed due events, with exhausted/review items excluded. No queue payload carries customer details or billing amounts.

The shared page types live in `src/billing/work-types.ts`. Traversal uses immutable `(createdAt, kind, id)` order and one frozen `through` bound across invoice creation times and event receipt times. `nextAttemptAt` controls eligibility only. Continue with `{limit, after: page.next, through: page.through}` while `next` is non-null; when it is null, restart without cursors for the next pass. An empty initial pass has `through: null`. Work beyond the upper bound or newly eligible behind the cursor returns in a later pass. The worker advances each cursor before enqueueing and isolates individual enqueue and kind-discovery failures, so a persistently failing first page cannot hide later work.

`PaymentSettings.pendingSetups(input?: PendingInput)` returns `PendingPage<{kind: "payment_setup"; setupId: string}>`; `InvoiceResolutions.pendingResolutions(input?: PendingInput)` returns `PendingPage<{kind: "resolution"; resolutionId: string}>`. They use the same completion/reset rules and independent worker cursors, ordered by immutable setup acceptance or resolution creation time, kind and ID.

Paused filtering happens before page limits. Receipt recovery and event retrieval remain eligible, including an attempted customer receipt before the setup itself is stamped. An already recovered customer mapping does not make an otherwise unstamped invoice eligible. These readers do not advance effect stamps or attempt counts; provider-write guards and existing finite windows still govern execution.

## Authenticated preparation and confirmation

`createBillingWorkflow(options: BillingWorkflowOptions): BillingWorkflow` adds `customerAccess` (the public customer authorization and caller-transaction profile reader), `audit` and required `allowRequest: SyntheticInvoicePolicy` to the billing options. Only the explicit staff billing grant permits preparation, review and issuance. Account administration alone grants read access. `checkInvoice` requires current `read_billing` authority for the exact customer invoice, allowing customer members to refresh their own status and use a verified hosted link. This retrieval-only check cannot issue an invoice or dispatch automatic payment.

`prepareInvoice(actor, customerId, input)` accepts a request UUID, expected customer profile version, due date, USD and positive lines. The operational customer UUID comes from the route. The server resolves the current customer profile and existing provider mapping, sets today's UTC issue date and snapshots bill-to, lines and dates. Due date is tomorrow through 21 calendar days ahead; the default is 21 days. No provider call or issue obligation occurs. Preparation, current authority checks and `invoice.prepared` audit commit together. Concurrent first requests converge on one mapping, preserving its original key/name. The result contains the invoice, an `issueBlocker` and `outcome: created|unchanged`.

`getPreparation(actor, customerId, invoiceId)` reads the persisted review. Its blockers are past_due, provider_profile_pending, needs_review or already_issued. `confirmIssue(actor, customerId, invoiceId)` rechecks current authority and scope, locks the invoice, then atomically records the first issue authorization and `invoice.issue_requested` audit. The immutable invoice ID is sufficient confirmation identity; repeats return unchanged without extra audit or provider effects. `checkInvoice` authorizes a retrieval of the existing receipt only. Provider work starts after the authority transaction closes.

A prepare retry uses its original request UUID and stored name/date/profile version, including after UTC midnight or a later profile edit. Changed input under the same identity conflicts. Editing before review is allowed; changing a persisted request requires deliberately preparing a new request. Abandoned requests remain unissued.

Synthetic issuance requires the frozen bill-to name to equal the mapping's provider-create name, even when no provider customer receipt exists yet. A renamed local customer does not silently update Stripe. Local billing contact remains frozen separately and does not block this synthetic name gate. Stripe uses a placeholder provider address. Portal invoice emails use the explicit local billing contact and remain in the local test inbox. Provider recipient synchronization and real-data composition remain outside this slice.

`assertSyntheticPolicy(allowRequest, accountId?)` verifies all persisted intentions, mapping ownership and bill-to snapshots before serving or starting workers. The policy receives `{request, customerId, billTo}`. Runtime composition supplies exact reviewed customer/profile/description/amount choices; opaque request UUIDs do not establish synthetic provenance. `assertSyntheticData` retains the exact-request interface for the separate operator demo and delegates to the same inspection. Ordinary credential-free composition exposes reads and unavailable mutation affordances, without a fake provider.

## Immutable request and database rules

An origin key identifies an immutable request in one deployment. The request includes customer key/name, intended issue date, due date, USD and ordered lines with nullable immutable origin references. Manual requests require positive lines; scheduled requests can include zero-valued lines in a positive invoice. For manual invoices, an origin reference is caller-supplied evidence without a service, subscription or imported-record relationship. Scheduled lines carry period UUIDs; the explicit persisted group and period claims establish ownership. Origin text alone grants no authority. Store the canonical request digest with the invoice. Matching identity and content returns unchanged; changed content conflicts. A new invoice origin may use the same stable customer key after a profile change. The provider mapping keeps its original create intent; `requestCustomerName` retains each invoice request's original name for digest verification; the bill-to fields snapshot the current customer profile. Reusing an existing origin with changed request content still conflicts. Customer, invoice and all lines commit in one transaction, with unique constraints arbitrating concurrent requests.

For manually prepared invoices, dates are actual calendar dates in UTC. Readiness is due date minus 21 calendar days. The intended issue date must be on or after readiness and before due date. A new request requires a future due date. `requestIssue` and the first provider effect refuse before both readiness and intended issue date or on/after due date. Once invoice creation has been attempted, later recovery may finish that same invoice after due date; it must never create a replacement. Customer creation alone does not authorize creating an invoice after its due date. `issuedAt` comes from confirmed provider finalization and can differ from the intended issue date. Demo composition freezes today's UTC date when first creating its stable request and chooses a due date 21 calendar days later; repeat startup reuses that persisted request.

Money is an integer number of USD cents. For manual requests, each line is 1 through 99,999,999 cents, the sum is 50 through 99,999,999 cents and there are 1 through 100 lines. All arithmetic stays within JavaScript's safe integer range and PostgreSQL integer range. All-zero scheduled groups have a final No charge outcome without an invoice. Credits, tax and currency conversion remain unsupported. Runtime validation rejects unknown fields, invalid dates, NUL/unpaired surrogates and blank labels; it never coerces or trims input.

The invoice lifecycle owns four tables; subscriptions and schedules have their own billing-owned tables described in their linked guides:

- `billing_customers` stores customer identity, immutable name, deployment/account ownership, provider ID and first create-attempt time.
- `invoices` stores the immutable request, origin identity, customer foreign key, total and dates, issue authorization, create/finalize attempt times, provider receipt/projection and bounded retry state.
- `invoice_lines` stores the immutable ordered lines, optional origin reference, provider line receipt and first create-attempt time.
- `stripe_events` stores a minimal verified event receipt and its outstanding retrieval obligation, without raw event payloads.

Database uniqueness covers customer keys, invoice origins, provider receipts and line positions; a composite customer foreign key prevents cross-deployment invoice ownership. Checks enforce bounded nonnegative line amounts, positive invoice totals, USD, readiness arithmetic, date ordering and valid states. The module commits header totals and immutable lines atomically, then never updates their commercial fields. Cross-row sums and content immutability are module transaction invariants. No generic operation ledger or custom queue tables are introduced.

## Effects and exact recovery

Use a checked-out `PoolClient` and PostgreSQL session advisory locks for each owned customer/invoice. Acquire customer before invoice when both are needed; never acquire in reverse order. Derive lock keys deterministically from record type and UUID. Hash collisions only serialize unrelated work. Every path uses the same locks, including explicit refresh and event retrieval. Unlock and release in `finally`; discard the connection if unlock or connection health is uncertain.

Each effect's first attempt time commits on that client before its provider call. Provider calls run outside a database transaction while the session lock remains held. Receipts commit afterwards. A rollback never erases a possible provider attempt. A connection failure aborts further work on that invocation; a successor sees the durable attempt and reconciles it. Job delivery and PostgreSQL locks do not guarantee exactly-once provider execution.

Keys are deterministic: `datapad:<deploymentKey>:customer:<id>:create`, `...:invoice:<id>:create`, `...:line:<id>:create` and `...:invoice:<id>:finalize`. Keep deployment keys short enough for Stripe's 255-character limit. Metadata carries deployment and local record IDs. Metadata can only recover an already persisted local intent and must agree with account, mode, customer and all immutable fields.

For each effect:

1. If a receipt exists, retrieve and verify its owned object. Never substitute another provider resource for that receipt.
2. Before a first call, commit the attempt time and use its deterministic key and immutable parameters.
3. After a lost response, inspect owned provider objects first. One exact match supplies the receipt. Multiple matches, mismatched content or incompatible ownership require review.
4. With no match, the identical request may be retried with the same key only less than 23 hours after the first attempted call. Beyond that bound, absence cannot prove non-execution: mark Needs review and do not recreate. First-attempt times never reset. Stripe may prune keys after 24 hours; the conservative margin avoids treating key retention as a permanent guarantee.

The adapter derives the required synthetic customer email as `<billing-customer-mapping-UUID>@billing.test` and checks it during recovery. That provider email is never caller-supplied and no send action exists. InvoiceIntent.recipientName is the mapping creation name; ProviderInvoice.recipientName and recipientEmail are the actual nullable provider observations. Both must match before finalization and when verifying a finalized receipt. The provider fields follow its customer until finalization and then freeze; local bill-to snapshots do not override them.

Customer lookup fully paginates scoped account results and matches deployment/customer metadata and immutable name. Invoice lookup fully paginates the known owned customer's invoices and matches deployment/invoice identity. Search indexing is never proof of absence. A configured pagination bound that prevents complete inspection returns ambiguous. No lookup adopts unrelated test objects, and no operator supplies an existing provider customer ID.

The adapter's `ProviderInvoice` is a complete normalized snapshot, with every provider line paginated and currency, customer, metadata, amount, collection method and advancement checked. `totalMinor` is the actual provider total, including zero on an empty draft. `findInvoice`, `createInvoice` and `retrieveInvoice` accept an owned draft with a valid subset of requested lines and its actual partial total. They validate header ownership/dates independently of completion. Exact equality to the requested line set and expected total is required before finalization and for any finalized invoice. `retrieveInvoice(intent, providerInvoiceId)` receives the persisted expected intent, so the adapter can perform these checks without database access. Provider intents carry an explicit dueEndAt instant. Manually prepared invoices use 23:59:59 UTC on the due date. Scheduled invoices use 23:59:59 in their captured named billing timezone. Stripe may render that instant in its account timezone; the selected composition must verify that rendering. It preserves actual line descriptions, positions and amounts for comparison; it must never fill missing provider data from the expected request to manufacture a match. Unsupported discounts, tax, credits, pending unrelated items or unknown lines fail verification. Invoice creation excludes pending customer invoice items and disables automatic tax/advancement; lines attach explicitly to that invoice.

After interrupted line creation, retrieve the complete invoice and recover each local line by its immutable local line ID in metadata. Persist found provider line IDs before advancing. Only genuinely unattempted lines may get a first create; an attempted missing line follows the same 23-hour rule. A finalized invoice with any missing/extra/duplicate/changed line requires review. Before finalization, compare the exact line set, descriptions, amounts, currency, customer, due date and total. Finalization always targets the recorded invoice ID; after a lost finalization response, retrieval can confirm the same open/paid/void invoice. Never create another invoice to repair finalization.

`BillingProviderError` classifies adapter failures as `retryable` or `review` with a safe `ReviewReason`; errors carry no raw provider response. Other thrown operational failures are treated as retryable, with the already committed attempt still requiring reconciliation. Provider transport failures are retryable within five attempts, with delays of 5 seconds, 30 seconds, 2 minutes and 10 minutes. Attempts and the next due attempt persist on invoices/events. Ownership/content failures and ambiguous effects require immediate review. Queue exhaustion cannot discard the database obligation. Exhaustion sets `retry_exhausted` visibly on outstanding work. Transient failures preserve an already verified finalized receipt and its link; event exhaustion remains recorded on the event. A reviewed operator refresh may still retrieve an existing provider ID; it cannot reset first-attempt history or authorize recreation.

## Events and current provider state

`POST /api/billing/webhooks/stripe` reads the original bounded body and signature before parsing. The adapter verifies the SDK signature with the configured endpoint secret, rejects live mode and connected/foreign account events, and recognizes invoice events. It returns `VerifiedInvoiceEvent` or null for an irrelevant event; invalid signatures or modes are errors. Raw requests and secrets are never logged. The signing secret belongs to the verified configured sandbox account; the ordinary account event may omit an account field.

The verified event's local invoice ID is a recovery hint. Intake accepts only a provider ID already mapped locally or a metadata invoice ID matching an existing intent in the configured deployment/account. It persists the event and retrieval obligation with event-ID uniqueness before HTTP acknowledgement. Duplicate events are successful no-ops. An unrelated object cannot create a customer or invoice. Persistence failure returns 503 so Stripe can retry; invalid signature/mode returns 400. Valid irrelevant events return 200 without creating work.

An event arriving before the local create receipt is stored remains tied to the existing invoice intent. Processing retrieves that provider invoice, verifies ownership and immutable content, then atomically records its provider ID and projection. It may recover already present line receipts. It never finalizes an incomplete invoice from an event. A create worker later sees the recovered receipt. Queue insertion occurs after inbox commit; the sweep recovers an interrupted enqueue. Mark the event processed only with the committed projection, or a definitive unrelated-object rejection. Transient failures retain the obligation. If event retrieval exhausts transient retries before the invoice has a local provider receipt, only the event is marked exhausted; pending issuance can still recover the same provider invoice. Definitive failures require review. Exhausted transient retrieval preserves an already verified finalized receipt; an unverified or unfinished invoice retains its normal retry/review behavior.

Always retrieve current provider state; event payload state and browser redirects are never payment evidence. Serialize retrieval and projection with the invoice lock, covering the network call, so a delayed earlier response cannot overwrite a newer response. `paid` and `void` are terminal and never regress; a conflicting terminal result preserves the confirmed terminal state and reports a safe diagnostic. `uncollectible` can later become paid or void, but cannot regress to draft/open. An older provider snapshot cannot reduce status progress. `lastCheckedAt` records successful verified retrieval time, and `issuedAt` records provider finalization time. Needs review is local; preserve the last provider status alongside it. A terminal invoice keeps its terminal state when later retrieval fails.

Receipt trust is persisted separately as unverified, verified or mismatch and exposed as `providerReceipt` on invoice detail. Migration marks older receipts unverified because the earlier adapter did not verify recipient fields. A complete matching retrieval marks verified. Definitive ownership/content/recipient mismatch, including a conflicting terminal state, persists mismatch plus a safe diagnostic and suppresses the hosted link even for paid/void. Transient failure preserves prior trust, diagnostic and URL. A subsequent exact matching receipt may restore the link; it cannot regress financial state. No replacement invoice or customer is created to repair a mismatch.

## Delivery and public reads

pg-boss owns at-least-once issue and event jobs. A worker invocation processes one durable identity through the module, which arbitrates concurrency. Queue retries are bounded and follow the persisted retry eligibility. A bounded sweep periodically reads `pendingWork` and republishes due outstanding work, including the enqueue gap after request/event commit. Explicit reconciliation retrieves a bounded batch of owned invoice IDs to cover missed provider events; it does not authorize new issuance or adopt provider resources. `reconciliationPage({limit,after,through})` returns receipt-bearing invoice IDs, a next cursor and a captured high-water cursor. Limits are 1 through 100; order is creation timestamp then UUID, preserving PostgreSQL timestamp precision. Paid/void rows remain eligible so migrated unverified receipts can recover their links. An empty initial pass returns through=null. New rows beyond the captured high-water wait for the next pass. An operator page budget reports a resumable partial pass; completion means next=null. Per-invoice failure does not prevent visiting later IDs. This reconciliation cursor introduces no new issuance authority; the separate scheduled-billing sweep owns recurring readiness.

| HTTP operation                                | Operation ID                | Success contract         |
| --------------------------------------------- | --------------------------- | ------------------------ |
| `GET /api/billing/invoices?limit=50&offset=0` | `listInvoices`              | `InvoicesResponseSchema` |
| `GET /api/billing/invoices/:invoiceId`        | `getInvoice`                | `InvoiceResponseSchema`  |
| `POST /api/billing/webhooks/stripe`           | `receiveStripeInvoiceEvent` | `WebhookResponseSchema`  |

Lists order by creation time descending then ID, with default limit 50, maximum 100 and bounded offset. Missing invoice returns 404, invalid query/ID 422 and unavailable storage 503, using `BillingErrorSchema`. Read routes use `Cache-Control: no-store`. Webhook errors have the same safe schema and 400/413/503 statuses; body limit is 1 MiB. The authenticated composition additionally exposes customer-scoped POST `/api/customers/:customerId/invoices` (prepare, 201/200), GET `/api/customers/:customerId/invoices/:invoiceId/preparation`, POST `.../issue` (202/200, strict empty body) and POST `.../check`. Preparation options return only availability, reviewed line choices and UTC date defaults. Preparation and issuance use current staff billing authority; status checks require scoped `read_billing`. All return no-store responses. Browser mutation origin checks belong to their own routes and must not intercept the originless Stripe webhook, which uses its bounded original bytes and signature instead of a human session. OpenAPI derives from these runtime schemas, with the webhook body described as raw JSON bytes and `Stripe-Signature` required.

List/detail display customer, intended issue and due dates, service lines including scheduled zero-valued lines, total, local/provided status and last check. The detail alone supplies a validated HTTPS Stripe hosted link; suppress it for requested/preparing/review/draft states. Paid and void invoices retain a verified valid link with the neutral label View invoice; unverified or mismatched receipts suppress it and display the receipt warning beside status. The browser polls while visible, including after returning from hosted payment. Display Requested, Preparing and Needs review distinctly from provider statuses. An empty billing dataset is a valid page state.

Runtime composition verifies the independent import allowlist and the billing synthetic allowlist before listening or starting workers, and rejects live key prefixes and objects. The loader accepts reviewed synthetic templates only. The guard validates all commercial request content, not merely a `.test` label, metadata prefix or stored digest. Provider/account identity and sandbox mode are checked before effects; credentials and webhook secrets remain outside the browser and Git. Tests use real isolated PostgreSQL and deterministic provider adapters. Actual create/finalize/hosted-payment/webhook acceptance is an explicit separate mise task with private evidence.

## References

[Stripe idempotent requests](https://docs.stripe.com/api/idempotent_requests) explains finite key retention. [Stripe webhooks](https://docs.stripe.com/webhooks) specifies raw-body signature verification and asynchronous delivery. [Invoice creation](https://docs.stripe.com/api/invoices/create) defines manual collection and draft creation. [The invoice object](https://docs.stripe.com/api/invoices/object) specifies recipient fields and finalization snapshots. The [billing proof](billing-proof.md) records the earlier provider experiment; its filesystem state and test clock are not application state.

### Explicit reconciliation passes

`mise run billing:refresh -- --page-budget 10` checks up to ten pages of 100 stored receipts in the configured sandbox. `--portal` selects the authenticated portal's explicit runtime configuration. Supply the same private database and sandbox environment used by that composition; no browser cookie or arbitrary provider resource ID is accepted.

Each pass captures a high-water cursor and visits older and newer receipts, including paid and void invoices awaiting recipient verification. New rows beyond the boundary wait for the next pass. Failures include the local invoice ID and a safe retry/review/unavailable outcome, and do not prevent later invoices from being checked. The JSON result includes `complete`, counts, failures and a resumable `cursor`. Pass that exact JSON cursor value with `--cursor` to continue a partial run. Exit 2 means review/retry or remaining pages; exit 1 means the command could not run. A complete traversal can still report individual failures. Reconciliation never requests issuance.

## Scheduled invoices

[Scheduled billing](scheduled-billing.md) seals explicitly activated subscription periods into immutable invoice groups. It reuses this lifecycle with persisted issueNotBefore, firstAttemptBefore and dueEndAt guards. Scheduled normalization permits zero-valued lines beside positive lines; manually prepared requests remain positive-only. Final No charge groups have no invoice. Schedule holds apply only through the explicit group-to-invoice relation and are checked before each first customer, invoice or finalization attempt. Existing manual request digests and stable provider effect identities are preserved.

## Received payments and voids

[Invoice resolutions](invoice-resolutions.md) preserve received external-payment assertions separately from confirmed settlement, support audited void requests and reconcile conflicts without replacing invoice identities.

[Billing operations](billing-operations.md) defines the global financial-write pause, retrieval-only queue and restore inspection boundary.
