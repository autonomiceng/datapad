# Billing architecture and contract

The retained billing slice stores explicit synthetic invoice requests, issues positive USD invoices for manual payment and displays retrieved Stripe status. It has no recurring scheduler, automatic collection, invoice email sending, external payment recording or real customer data. The separate [account composition](accounts.md) supplies authentication and current customer-scoped reads. [The glossary](../CONTEXT.md) defines the terms; [ADR 0007](adr/0007-invoice-ownership-and-recovery.md) records ownership and recovery decisions. [Runtime schemas](../src/billing/contract.ts), [the provider port](../src/billing/provider.ts) [public module types](../src/billing/types.ts) and [the schema](../src/billing/internal/schema.ts) are the concrete contracts.

## Module ownership

| Location                            | Responsibility                                                                                           |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `src/billing/contract.ts`           | Browser-safe runtime request/read schemas and inferred types                                             |
| `src/billing/index.ts`, `internal/` | Request validation, immutable intentions, database rules, issuance, recovery and read projection         |
| `src/billing/provider.ts`           | Provider-neutral inputs, validated receipts and small provider/verifier interfaces                       |
| `src/stripe/`                       | Official Stripe SDK, resource ownership checks, paginated recovery lookup and raw signature verification |
| `src/worker/`                       | pg-boss delivery, bounded retries, pending-work sweep and shutdown                                       |
| `src/server/`                       | Composition, database lifecycle, read HTTP and raw webhook transport                                     |
| `src/web/billing/`                  | Read-only list/detail and same-origin polling                                                            |
| `scripts/`                          | Reviewed synthetic loader, operator commands and sandbox acceptance                                      |

Billing imports no import-review, Stripe SDK, worker, HTTP or browser implementation. Provider adapters import the billing port; workers import billing's public commands. Browser code imports only `billing/contract.ts`. HTTP receives readers and event intake, with no database handle. Only migration tooling and billing internals access the billing schema. Import review remains independent and immutable.

## Public module interface

`createBilling({ pool, provider, customers, deploymentKey, now? })` constructs the module. `pool` is a PostgreSQL `Pool`; `provider` implements `BillingProvider`; `customers` is the operator-composed customer registry using the caller's transaction; `deploymentKey` is a stable deployment namespace and must equal `provider.ownership.deploymentKey`. Provider account identity is verified at composition time and checked against every stored mapping. The optional `now: () => Date` is a test seam; runtime uses the actual clock. No domain code knows fixture names or permanent demo dates.

`billing_customers` preserves provider mapping IDs, original creation intent and effect receipts. Its required `customer_id` references the stable operational customer. `invoices.billing_customer_id` references that mapping; public `invoice.customer.id` identifies the operational customer. Invoice bill-to name, contact and profile version are copied when the request is first stored. A profile edit preserves the provider mapping and every historical invoice. Forward migration retains old IDs and backfills unavailable historical contact as null.

`createBillingReader({ pool, deploymentKey })` returns the same read methods and `assertSyntheticData` without a provider or credentials. Ordinary demo/CI can serve an empty billing database through that reader; it must not construct a fake provider. The policy check accepts optional expected account identity; a nonempty dataset must supply it from private runtime configuration before serving. Provider IDs and account IDs are never browser configuration.

`src/billing/index.ts` exports `createBilling`, `createBillingReader` and the public types from `types.ts`. Factory signatures are `createBilling(options: BillingOptions): Billing` and `createBillingReader(options: BillingReaderOptions): BillingReader`.

The factory returns these methods. Input and response types come from the runtime contract or provider port. Commands have no public browser routes.

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

interface BillingCommands {
  requestInvoice(input: unknown): Promise<RequestResult>;
  requestIssue(invoiceId: string): Promise<IssueResult>;
  issueInvoice(invoiceId: string): Promise<WorkResult>;
  refreshInvoice(invoiceId: string): Promise<WorkResult>;
  acceptEvent(
    event: VerifiedInvoiceEvent,
  ): Promise<"accepted" | "duplicate" | "ignored">;
  processEvent(eventId: string): Promise<WorkResult>;
  pendingWork(limit?: number): Promise<PendingWork[]>;
}
```

`Billing` combines `BillingReader` and `BillingCommands`. Methods always scope queries to the configured deployment. Unknown refresh/worker IDs are complete no-ops. Operational failures throw safe errors; no SQL, provider response, credentials or private paths enter HTTP errors. `assertSyntheticData` is composition's policy seam: it verifies the full stored request set against the supplied reviewed requests, customer content and configured sandbox ownership. It also refuses orphan customer records or foreign deployment/account records. This control is for accidental import prevention; trusted direct database tampering is outside its threat model.

`requestIssue` commits `issueRequestedAt` before returning accepted. The caller may then enqueue, but durable pending work is sufficient if that enqueue is lost. Repeated calls are unchanged. `issueInvoice` requires an existing authorized issue request and cannot turn an unissued request into one. `refreshInvoice` only retrieves/reconciles the existing provider invoice and never starts a new create. `pendingWork` defaults to 100, caps at 100, orders by next-attempt/creation time and stable ID, and returns only authorized unfinished issuance and unprocessed due events. Exhausted/review items are excluded; no queue payload carries customer details or billing amounts.

## Immutable request and database rules

An origin key identifies an immutable request in one deployment. The request includes customer key/name, intended issue date, due date, USD and ordered positive lines with nullable immutable origin references. An origin reference is evidence supplied by the caller, with no service, subscription or imported-record relationship. Store the canonical request digest with the invoice. Matching identity and content returns unchanged; changed content conflicts. A new invoice origin may use the same stable customer key after a profile change. The provider mapping keeps its original create intent; `requestCustomerName` retains each invoice request's original name for digest verification; the bill-to fields snapshot the current customer profile. Reusing an existing origin with changed request content still conflicts. Customer, invoice and all lines commit in one transaction, with unique constraints arbitrating concurrent requests.

Dates are actual calendar dates in UTC. Readiness is due date minus 21 calendar days. The intended issue date must be on or after readiness and before due date. A new request requires a future due date. `requestIssue` and the first provider effect refuse before both readiness and intended issue date or on/after due date. Once invoice creation has been attempted, later recovery may finish that same invoice after due date; it must never create a replacement. Customer creation alone does not authorize creating an invoice after its due date. `issuedAt` comes from confirmed provider finalization and can differ from the intended issue date. Demo composition freezes today's UTC date when first creating its stable request and chooses a due date 21 calendar days later; repeat startup reuses that persisted request.

Money is an integer number of USD cents. Each line is 1 through 99,999,999 cents, the sum is 50 through 99,999,999 cents and there are 1 through 100 lines. All arithmetic stays within JavaScript's safe integer range and PostgreSQL integer range. Zero invoices, credits, tax and currency conversion are outside this slice. Runtime validation rejects unknown fields, invalid dates, NUL/unpaired surrogates and blank labels; it never coerces or trims input.

Four owned tables suffice:

- `billing_customers` stores customer identity, immutable name, deployment/account ownership, provider ID and first create-attempt time.
- `invoices` stores the immutable request, origin identity, customer foreign key, total and dates, issue authorization, create/finalize attempt times, provider receipt/projection and bounded retry state.
- `invoice_lines` stores the immutable ordered lines, optional origin reference, provider line receipt and first create-attempt time.
- `stripe_events` stores a minimal verified event receipt and its outstanding retrieval obligation, without raw event payloads.

Database uniqueness covers customer keys, invoice origins, provider receipts and line positions; a composite customer foreign key prevents cross-deployment invoice ownership. Checks enforce positive bounded amounts, USD, readiness arithmetic, date ordering and valid states. The module commits header totals and immutable lines atomically, then never updates their commercial fields. Cross-row sums and content immutability are module transaction invariants. No generic operation ledger or custom queue tables are introduced.

## Effects and exact recovery

Use a checked-out `PoolClient` and PostgreSQL session advisory locks for each owned customer/invoice. Acquire customer before invoice when both are needed; never acquire in reverse order. Derive lock keys deterministically from record type and UUID. Hash collisions only serialize unrelated work. Every path uses the same locks, including explicit refresh and event retrieval. Unlock and release in `finally`; discard the connection if unlock or connection health is uncertain.

Each effect's first attempt time commits on that client before its provider call. Provider calls run outside a database transaction while the session lock remains held. Receipts commit afterwards. A rollback never erases a possible provider attempt. A connection failure aborts further work on that invocation; a successor sees the durable attempt and reconciles it. Job delivery and PostgreSQL locks do not guarantee exactly-once provider execution.

Keys are deterministic: `datapad:<deploymentKey>:customer:<id>:create`, `...:invoice:<id>:create`, `...:line:<id>:create` and `...:invoice:<id>:finalize`. Keep deployment keys short enough for Stripe's 255-character limit. Metadata carries deployment and local record IDs. Metadata can only recover an already persisted local intent and must agree with account, mode, customer and all immutable fields.

For each effect:

1. If a receipt exists, retrieve and verify its owned object. Never substitute another provider resource for that receipt.
2. Before a first call, commit the attempt time and use its deterministic key and immutable parameters.
3. After a lost response, inspect owned provider objects first. One exact match supplies the receipt. Multiple matches, mismatched content or incompatible ownership require review.
4. With no match, the identical request may be retried with the same key only less than 23 hours after the first attempted call. Beyond that bound, absence cannot prove non-execution: mark Needs review and do not recreate. First-attempt times never reset. Stripe may prune keys after 24 hours; the conservative margin avoids treating key retention as a permanent guarantee.

The adapter derives the required synthetic customer email as `<local-customer-UUID>@billing.test` and checks it during recovery. Email is never a caller-supplied field and no send action exists.

Customer lookup fully paginates scoped account results and matches deployment/customer metadata and immutable name. Invoice lookup fully paginates the known owned customer's invoices and matches deployment/invoice identity. Search indexing is never proof of absence. A configured pagination bound that prevents complete inspection returns ambiguous. No lookup adopts unrelated test objects, and no operator supplies an existing provider customer ID.

The adapter's `ProviderInvoice` is a complete normalized snapshot, with every provider line paginated and currency, customer, metadata, amount, collection method and advancement checked. `totalMinor` is the actual provider total, including zero on an empty draft. `findInvoice`, `createInvoice` and `retrieveInvoice` accept an owned draft with a valid subset of requested lines and its actual partial total. They validate header ownership/dates independently of completion. Exact equality to the requested line set and expected total is required before finalization and for any finalized invoice. `retrieveInvoice(intent, providerInvoiceId)` receives the persisted expected intent, so the adapter can perform these checks without database access. All dates in provider intents and metadata use UTC. The provider due instant is 23:59:59 UTC on the due date, so the full UTC calendar day remains available for payment. Stripe may render that instant in its account timezone; production calendar rules need a named billing timezone. It preserves actual line descriptions, positions and amounts for comparison; it must never fill missing provider data from the expected request to manufacture a match. Unsupported discounts, tax, credits, pending unrelated items or unknown lines fail verification. Invoice creation excludes pending customer invoice items and disables automatic tax/advancement; lines attach explicitly to that invoice.

After interrupted line creation, retrieve the complete invoice and recover each local line by its immutable local line ID in metadata. Persist found provider line IDs before advancing. Only genuinely unattempted lines may get a first create; an attempted missing line follows the same 23-hour rule. A finalized invoice with any missing/extra/duplicate/changed line requires review. Before finalization, compare the exact line set, descriptions, amounts, currency, customer, due date and total. Finalization always targets the recorded invoice ID; after a lost finalization response, retrieval can confirm the same open/paid/void invoice. Never create another invoice to repair finalization.

`BillingProviderError` classifies adapter failures as `retryable` or `review` with a safe `ReviewReason`; errors carry no raw provider response. Other thrown operational failures are treated as retryable, with the already committed attempt still requiring reconciliation. Provider transport failures are retryable within five attempts, with delays of 5 seconds, 30 seconds, 2 minutes and 10 minutes. Attempts and the next due attempt persist on invoices/events. Ownership/content failures and ambiguous effects require immediate review. Queue exhaustion cannot discard the database obligation. Exhaustion sets `retry_exhausted` visibly. A reviewed operator refresh may still retrieve an existing provider ID; it cannot reset first-attempt history or authorize recreation.

## Events and current provider state

`POST /api/billing/webhooks/stripe` reads the original bounded body and signature before parsing. The adapter verifies the SDK signature with the configured endpoint secret, rejects live mode and connected/foreign account events, and recognizes invoice events. It returns `VerifiedInvoiceEvent` or null for an irrelevant event; invalid signatures or modes are errors. Raw requests and secrets are never logged. The signing secret belongs to the verified configured sandbox account; the ordinary account event may omit an account field.

The verified event's local invoice ID is a recovery hint. Intake accepts only a provider ID already mapped locally or a metadata invoice ID matching an existing intent in the configured deployment/account. It persists the event and retrieval obligation with event-ID uniqueness before HTTP acknowledgement. Duplicate events are successful no-ops. An unrelated object cannot create a customer or invoice. Persistence failure returns 503 so Stripe can retry; invalid signature/mode returns 400. Valid irrelevant events return 200 without creating work.

An event arriving before the local create receipt is stored remains tied to the existing invoice intent. Processing retrieves that provider invoice, verifies ownership and immutable content, then atomically records its provider ID and projection. It may recover already present line receipts. It never finalizes an incomplete invoice from an event. A create worker later sees the recovered receipt. Queue insertion occurs after inbox commit; the sweep recovers an interrupted enqueue. Mark the event processed only with the committed projection, or a definitive unrelated-object rejection. Transient failures retain the obligation. If event retrieval exhausts transient retries before the invoice has a local provider receipt, only the event is marked exhausted; pending issuance can still recover the same provider invoice. Definitive failures and exhaustion for an already mapped invoice keep their normal review behavior.

Always retrieve current provider state; event payload state and browser redirects are never payment evidence. Serialize retrieval and projection with the invoice lock, covering the network call, so a delayed earlier response cannot overwrite a newer response. `paid` and `void` are terminal and never regress; a conflicting terminal result preserves the confirmed terminal state and reports a safe diagnostic. `uncollectible` can later become paid or void, but cannot regress to draft/open. An older provider snapshot cannot reduce status progress. `lastCheckedAt` records successful verified retrieval time, and `issuedAt` records provider finalization time. Needs review is local; preserve the last provider status alongside it. A terminal invoice keeps its terminal state when later retrieval fails.

## Delivery and public reads

pg-boss owns at-least-once issue and event jobs. A worker invocation processes one durable identity through the module, which arbitrates concurrency. Queue retries are bounded and follow the persisted retry eligibility. A bounded sweep periodically reads `pendingWork` and republishes due outstanding work, including the enqueue gap after request/event commit. Explicit reconciliation retrieves a bounded batch of owned invoice IDs to cover missed provider events; it does not authorize new issuance or adopt provider resources. Repeated scans eventually cover all eligible rows using stable pagination, without starving old open invoices.

| HTTP operation                                | Operation ID                | Success contract         |
| --------------------------------------------- | --------------------------- | ------------------------ |
| `GET /api/billing/invoices?limit=50&offset=0` | `listInvoices`              | `InvoicesResponseSchema` |
| `GET /api/billing/invoices/:invoiceId`        | `getInvoice`                | `InvoiceResponseSchema`  |
| `POST /api/billing/webhooks/stripe`           | `receiveStripeInvoiceEvent` | `WebhookResponseSchema`  |

Lists order by creation time descending then ID, with default limit 50, maximum 100 and bounded offset. Missing invoice returns 404, invalid query/ID 422 and unavailable storage 503, using `BillingErrorSchema`. Read routes use `Cache-Control: no-store`. Webhook errors have the same safe schema and 400/413/503 statuses; body limit is 1 MiB. There is no browser refresh, issue or request mutation route. OpenAPI derives from these runtime schemas, with the webhook body described as raw JSON bytes and `Stripe-Signature` required.

List/detail display customer, intended issue and due dates, positive service lines, total, local/provided status and last check. The detail alone supplies a validated HTTPS Stripe hosted link; suppress it for requested/preparing/review/draft states. Paid and void invoices retain their valid link with the neutral label View invoice. The browser polls while visible, including after returning from hosted payment. Display Requested, Preparing and Needs review distinctly from provider statuses. An empty billing dataset is a valid page state.

Runtime composition verifies the independent import allowlist and the billing synthetic allowlist before listening or starting workers, and rejects live key prefixes and objects. The loader accepts reviewed synthetic templates only. The guard validates all commercial request content, not merely a `.test` label, metadata prefix or stored digest. Provider/account identity and sandbox mode are checked before effects; credentials and webhook secrets remain outside the browser and Git. Tests use real isolated PostgreSQL and deterministic provider adapters. Actual create/finalize/hosted-payment/webhook acceptance is an explicit separate mise task with private evidence.

## References

[Stripe idempotent requests](https://docs.stripe.com/api/idempotent_requests) explains finite key retention. [Stripe webhooks](https://docs.stripe.com/webhooks) specifies raw-body signature verification and asynchronous delivery. [Invoice creation](https://docs.stripe.com/api/invoices/create) defines manual collection and draft creation. The [billing proof](billing-proof.md) records the earlier provider experiment; its filesystem state and test clock are not application state.
