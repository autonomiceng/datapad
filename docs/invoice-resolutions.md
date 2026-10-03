# External payments and void invoices

Billing staff can record a Zelle or check payment already received for one invoice's full remaining balance. Recording the receipt preserves the received amount, date, method and reference. Stripe confirmation is a separate result. Staff can also request that an unpaid finalized invoice be voided, with a reason. Neither action changes a subscription or service.

The invoice shows Pending provider confirmation, Provider confirmed or Needs staff review. Customer views show the received amount, method and date. References and correction reasons remain staff-only. Pending and conflicting requests hide the portal payment link. A Stripe page already opened elsewhere can still accept payment, so conflicting electronic payment evidence requires review.

## Staff workflow

Open **Review invoice**, then **Resolve invoice**. Check the remaining amount and collection status, choose an action and confirm it. A received-funds assertion can be recorded during a provider outage; the worker waits for verified evidence before settling it. Unknown remaining balance stays unknown until checked. A mismatched amount never authorizes settlement.

Before any settlement attempt, a mistaken receipt can be withdrawn with a correction reason. Its facts remain in history and audit, and a corrected receipt can be recorded. An unattempted receipt or void request held by a temporary collection conflict can be explicitly resumed once fresh collection evidence confirms that the original request is safe. This preserves its identity and original intention. Requests already sent to Stripe cannot use this action to reset their retry limits. After an attempt, corrections require staff review and cannot reverse the provider effect. There is no refund, partial allocation or automatic replacement payment in this workflow.

Voiding requires a finalized unpaid invoice with no received-funds assertion, credited amount or active electronic collection. The resulting void leaves scheduled group membership and billed period claims intact. It does not authorize a replacement invoice.

## Module and recovery

Billing owns the strict browser contract in `src/billing/resolutions-contract.ts`, the `createInvoiceResolutions` facade and its internal table/lifecycle. HTTP receives that facade, and the worker invokes explicit resolution jobs. The existing Stripe adapter implements a narrow `InvoiceResolutionProvider` capability alongside invoice issuance. Shared invoice context keeps ownership, receipt verification and financial projection in one implementation.

Human commands recheck current customer scope and billing permission. Receipt facts and audit commit together. One active resolution per invoice is enforced by a partial unique index; withdrawn receipts remain immutable history. Customer then invoice session locks serialize portal effects. Short database transactions record intent and attempts; provider calls happen outside transactions.

Inspection verifies the invoice, all payment allocations and associated PaymentIntents, then rereads the invoice. Missing or ambiguous evidence blocks effects. External settlement uses `paid_out_of_band` with a stable resolution key and expanded off-Stripe amount. Confirmation requires an attributable response and matching financial evidence. Lost responses reconcile first and may replay only the identical request within 23 hours, with a bounded retry count. Unknown attribution becomes review. Later provider events recheck confirmed receipts for competing electronic payments and possible overpayment.

## Verification

`mise run pr:check` includes real PostgreSQL recovery/authorization cases and credential-free Stripe boundary checks. Run `mise run test:portal:resolutions -- --config <owner-only-config> --run-dir <private-directory>` for the separate actual sandbox settlement and void journey. Its artifacts stay in that private directory. Use synthetic invoices only; this task authorizes no production payment or customer communication.
