import Stripe from "stripe";
import type { ProviderInvoiceStatus } from "../billing/contract";
import {
  BillingProviderError,
  type BillingEventVerifier,
  type BillingProvider,
  type PaymentSettingsProvider,
  type CollectionInspection,
  type CollectionPayOutcome,
  type CollectionPayReceipt,
  type CollectionPayRequest,
  type CustomerIntent,
  type InvoiceIntent,
  type InvoiceCollectionProvider,
  type InvoiceResolutionProvider,
  type LineIntent,
  type Lookup,
  type ProviderCustomer,
  type ProviderInvoice,
  type ProviderLine,
  type ProviderOwnership,
} from "../billing/provider";

import {
  createStripePaymentSettingsProvider,
  normalizeStripePaymentSetupEvent,
} from "./payment-settings";

interface StripeBillingOptions {
  apiKey: string;
  deploymentKey: string;
  accountId?: string;
  maxPages?: number;
  httpClient?: Stripe.HttpClient;
}

const metadataKeys = {
  deployment: "datapad_deployment",
  customer: "datapad_customer",
  invoice: "datapad_invoice",
  line: "datapad_line",
  position: "datapad_position",
  issueDate: "datapad_issue_date",
  dueDate: "datapad_due_date",
};
const invoiceEvents = new Set([
  "invoice.created",
  "invoice.updated",
  "invoice.finalized",
  "invoice.finalization_failed",
  "invoice.paid",
  "invoice.payment_failed",
  "invoice.payment_action_required",
  "invoice.voided",
  "invoice.marked_uncollectible",
]);
const review = (
  reason: "ownership_mismatch" | "invoice_mismatch" | "provider_conflict",
  receiptMismatch = false,
) => new BillingProviderError("review", reason, receiptMismatch);
const objectId = (value: string | { id: string } | null) =>
  typeof value === "string" ? value : value?.id;
const dueSeconds = (intent: InvoiceIntent) =>
  Date.parse(intent.dueEndAt) / 1000;

function metadata(
  intent: CustomerIntent | InvoiceIntent,
  line?: LineIntent,
): Stripe.MetadataParam {
  const result: Stripe.MetadataParam = {
    [metadataKeys.deployment]: intent.deploymentKey,
    [metadataKeys.customer]: intent.customerId,
  };
  if ("invoiceId" in intent) {
    result[metadataKeys.invoice] = intent.invoiceId;
    result[metadataKeys.issueDate] = intent.issueDate;
    result[metadataKeys.dueDate] = intent.dueDate;
  }
  if (line) {
    result[metadataKeys.line] = line.lineId;
    result[metadataKeys.position] = String(line.position);
  }
  return result;
}

async function safe<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof BillingProviderError) throw error;
    if (error instanceof Stripe.errors.StripeError) {
      if (
        error.type === "StripeConnectionError" ||
        error.type === "StripeAPIError" ||
        error.type === "StripeRateLimitError" ||
        (error.statusCode ?? 0) >= 500
      ) {
        throw new BillingProviderError("retryable", "provider_conflict");
      }
      throw review("provider_conflict");
    }
    throw new BillingProviderError("retryable", "provider_conflict");
  }
}

/** Uses only sandbox keys and verifies the account before exposing effects. */
export async function createStripeBillingProvider(
  options: StripeBillingOptions,
): Promise<
  BillingProvider &
    InvoiceResolutionProvider &
    PaymentSettingsProvider &
    InvoiceCollectionProvider
> {
  if (
    !/^(sk|rk)_test_/.test(options.apiKey) ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(options.deploymentKey)
  ) {
    throw review("ownership_mismatch");
  }
  const maxPages = options.maxPages ?? 100;
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 1000)
    throw review("provider_conflict");
  const stripe = new Stripe(options.apiKey, {
    apiVersion: "2026-09-30.endive",
    maxNetworkRetries: 0,
    timeout: 30_000,
    ...(options.httpClient ? { httpClient: options.httpClient } : {}),
  });
  const account = await safe(() => stripe.accounts.retrieveCurrent());
  if (
    !account.id.startsWith("acct_") ||
    (options.accountId && account.id !== options.accountId)
  ) {
    throw review("ownership_mismatch");
  }
  const ownership = Object.freeze({
    deploymentKey: options.deploymentKey,
    accountId: account.id,
  });
  function checkIntent(intent: ProviderOwnership) {
    if (
      intent.accountId !== ownership.accountId ||
      intent.deploymentKey !== ownership.deploymentKey
    ) {
      throw review("ownership_mismatch");
    }
  }
  function checkMetadata(
    actual: Stripe.Metadata | null,
    expected: Stripe.MetadataParam,
    receiptMismatch = false,
  ) {
    if (
      !actual ||
      Object.entries(expected).some(([key, value]) => actual[key] !== value)
    ) {
      throw review("ownership_mismatch", receiptMismatch);
    }
  }
  function customerSnapshot(
    intent: CustomerIntent,
    customer: Stripe.Customer,
  ): ProviderCustomer {
    checkMetadata(customer.metadata, metadata(intent));
    if (
      customer.livemode ||
      customer.name !== intent.name ||
      customer.email !== `${intent.customerId}@billing.test`
    )
      throw review("ownership_mismatch");
    return { ...intent, providerCustomerId: customer.id, livemode: false };
  }
  async function pages<T extends { id: string }>(
    list: (startingAfter?: string) => Promise<Stripe.ApiList<T>>,
  ): Promise<T[] | null> {
    const result: T[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    for (let pageIndex = 0; pageIndex < maxPages; pageIndex++) {
      const page = await list(cursor);
      if (
        page.object !== "list" ||
        !Array.isArray(page.data) ||
        typeof page.has_more !== "boolean"
      )
        return null;
      for (const item of page.data) {
        if (typeof item.id !== "string" || !item.id || seen.has(item.id))
          return null;
        seen.add(item.id);
        result.push(item);
      }
      if (!page.has_more) return result;
      const next = page.data.at(-1)?.id;
      if (!next || next === cursor) return null;
      cursor = next;
    }
    return null;
  }
  function matches(
    actual: Stripe.Metadata | null,
    expected: Stripe.MetadataParam,
  ): boolean {
    return Boolean(
      actual &&
      Object.entries(expected).every(([key, value]) => actual[key] === value),
    );
  }
  function lineSnapshot(
    intent: InvoiceIntent,
    invoiceId: string,
    value: Stripe.InvoiceLineItem,
  ): ProviderLine {
    const expected = intent.lines.find(
      (line) => line.lineId === value.metadata[metadataKeys.line],
    );
    if (
      !expected ||
      value.livemode ||
      value.invoice !== invoiceId ||
      value.currency !== "usd" ||
      value.description !== expected.description ||
      value.amount !== expected.amountMinor ||
      value.subtotal !== value.amount ||
      value.discounts.length ||
      value.discount_amounts?.length ||
      value.pretax_credit_amounts?.length ||
      value.taxes?.length ||
      value.parent?.type !== "invoice_item_details" ||
      value.parent.invoice_item_details?.proration ||
      value.parent.invoice_item_details?.subscription ||
      !value.parent.invoice_item_details?.invoice_item
    ) {
      throw review("invoice_mismatch", true);
    }
    checkMetadata(value.metadata, metadata(intent, expected), true);
    return {
      lineId: value.metadata[metadataKeys.line],
      position: Number(value.metadata[metadataKeys.position]),
      description: value.description,
      amountMinor: value.amount,
      currency: "USD",
      providerLineId: value.parent.invoice_item_details.invoice_item,
    };
  }
  function invoiceHeader(
    intent: InvoiceIntent,
    value: Stripe.Invoice,
  ): Omit<ProviderInvoice, "lines"> {
    checkMetadata(value.metadata, metadata(intent), true);
    if (
      value.livemode ||
      objectId(value.customer) !== intent.providerCustomerId ||
      value.currency !== "usd" ||
      value.collection_method !== "send_invoice" ||
      value.auto_advance !== false ||
      value.due_date !== dueSeconds(intent) ||
      value.automatic_tax.enabled ||
      value.discounts.length ||
      value.total_discount_amounts?.length ||
      value.total_taxes?.length ||
      value.starting_balance !== 0 ||
      value.pre_payment_credit_notes_amount !== 0 ||
      value.post_payment_credit_notes_amount !== 0 ||
      value.parent ||
      !value.status ||
      !["draft", "open", "paid", "void", "uncollectible"].includes(value.status)
    )
      throw review("invoice_mismatch", true);
    let hostedInvoiceUrl = value.hosted_invoice_url;
    if (hostedInvoiceUrl) {
      let url: URL;
      try {
        url = new URL(hostedInvoiceUrl);
      } catch {
        throw review("invoice_mismatch", true);
      }
      if (
        url.protocol !== "https:" ||
        url.hostname !== "invoice.stripe.com" ||
        url.username ||
        url.password ||
        url.port ||
        hostedInvoiceUrl.length > 2048
      )
        throw review("invoice_mismatch", true);
    } else hostedInvoiceUrl = null;
    function invoiceStatus(raw: string): ProviderInvoiceStatus {
      switch (raw) {
        case "draft":
          return "draft";
        case "open":
          return "open";
        case "paid":
          return "paid";
        case "void":
          return "void";
        case "uncollectible":
          return "uncollectible";
        default:
          throw review("invoice_mismatch", true);
      }
    }
    const status = invoiceStatus(value.status);
    const finalized = value.status_transitions.finalized_at;
    if (value.status !== "draft" && !finalized)
      throw review("invoice_mismatch", true);
    return {
      deploymentKey: intent.deploymentKey,
      accountId: intent.accountId,
      invoiceId: value.metadata![metadataKeys.invoice],
      customerId: value.metadata![metadataKeys.customer],
      providerCustomerId: objectId(value.customer)!,
      recipientName: value.customer_name,
      recipientEmail: value.customer_email,
      issueDate: value.metadata![metadataKeys.issueDate],
      dueDate: value.metadata![metadataKeys.dueDate],
      dueEndAt: new Date(value.due_date! * 1000).toISOString(),
      currency: "USD",
      totalMinor: value.total,
      providerInvoiceId: value.id,
      livemode: false,
      status,
      hostedInvoiceUrl,
      finalizedAt: finalized ? new Date(finalized * 1000).toISOString() : null,
      collectionMethod: "send_invoice",
      autoAdvance: false,
    };
  }
  async function invoiceSnapshot(
    intent: InvoiceIntent,
    value: Stripe.Invoice,
  ): Promise<ProviderInvoice> {
    const header = invoiceHeader(intent, value);
    const actualLines = await pages((cursor) =>
      stripe.invoices.listLineItems(value.id, {
        limit: 100,
        ...(cursor ? { starting_after: cursor } : {}),
      }),
    );
    if (!actualLines) throw review("invoice_mismatch");
    const lines = actualLines.map((line) =>
      lineSnapshot(intent, value.id, line),
    );
    if (
      new Set(lines.map((line) => line.lineId)).size !== lines.length ||
      new Set(lines.map((line) => line.providerLineId)).size !== lines.length ||
      value.total !==
        lines.reduce((total, line) => total + line.amountMinor, 0) ||
      value.subtotal !== value.total ||
      (value.status !== "draft" &&
        (lines.length !== intent.lines.length ||
          value.total !== intent.totalMinor))
    ) {
      throw review("invoice_mismatch", true);
    }
    return { ...header, lines: lines.sort((a, b) => a.position - b.position) };
  }
  /** Normalize only the pay response. No read may occur before the caller persists this receipt. */
  function collectionPayReceipt(
    intent: InvoiceIntent,
    request: CollectionPayRequest,
    value: Stripe.Invoice,
  ): CollectionPayReceipt {
    if (
      value.id !== request.providerInvoiceId ||
      value.object !== "invoice" ||
      value.livemode !== false
    )
      throw review("ownership_mismatch", true);
    const header = invoiceHeader(intent, value);
    if (
      header.recipientName !== intent.recipientName ||
      header.recipientEmail !== `${intent.customerId}@billing.test` ||
      header.totalMinor !== intent.totalMinor ||
      value.subtotal !== value.total
    )
      throw review("invoice_mismatch", true);
    const receipt: CollectionPayReceipt = {
      ...ownership,
      invoiceId: header.invoiceId,
      providerInvoiceId: header.providerInvoiceId,
      providerCustomerId: header.providerCustomerId,
      status: header.status,
      payment: null,
    };
    // The default allocation identifies invoice pay's PI. A truncated/unexpanded response cannot supply correlation.
    const payments = value.payments;
    if (!payments || payments.object !== "list" || payments.has_more !== false)
      return receipt;
    const candidates = payments.data.filter(
      (payment) => payment.is_default === true,
    );
    if (candidates.length !== 1) return receipt;
    const allocation = candidates[0];
    const payment =
      allocation.payment?.type === "payment_intent"
        ? allocation.payment.payment_intent
        : null;
    if (!payment || typeof payment === "string") return receipt;
    if (
      allocation.object !== "invoice_payment" ||
      !allocation.id.startsWith("inpay_") ||
      allocation.livemode !== false ||
      objectId(allocation.invoice) !== value.id ||
      allocation.currency !== "usd" ||
      payment.object !== "payment_intent" ||
      !payment.id.startsWith("pi_") ||
      payment.livemode !== false ||
      objectId(payment.customer) !== intent.providerCustomerId ||
      payment.currency !== "usd"
    )
      throw review("ownership_mismatch", true);
    if (
      objectId(payment.payment_method) !== request.providerPaymentMethodId ||
      !["open", "paid"].includes(allocation.status) ||
      !["processing", "succeeded", "requires_action"].includes(payment.status)
    )
      return receipt;
    receipt.payment = {
      invoicePaymentId: allocation.id,
      paymentIntentId: payment.id,
      providerPaymentMethodId: request.providerPaymentMethodId,
    };
    return receipt;
  }
  async function find<
    T extends { metadata: Stripe.Metadata | null; id: string },
    R,
  >(
    values: T[] | null,
    expected: Stripe.MetadataParam,
    verify: (value: T) => Promise<R> | R,
  ): Promise<Lookup<R>> {
    if (!values) return { kind: "ambiguous" };
    const candidates = values.filter((value) =>
      matches(value.metadata, expected),
    );
    if (candidates.length > 1) return { kind: "ambiguous" };
    if (!candidates.length) return { kind: "absent" };
    return { kind: "found", value: await verify(candidates[0]) };
  }
  async function resolutionSnapshot(
    intent: InvoiceIntent,
    id: string,
    value: Stripe.Invoice,
  ) {
    if (
      value.id !== id ||
      value.object !== "invoice" ||
      value.livemode !== false
    )
      throw review("ownership_mismatch", true);
    const snapshot = await invoiceSnapshot(intent, value);
    if (
      snapshot.recipientName !== intent.recipientName ||
      snapshot.recipientEmail !== `${intent.customerId}@billing.test` ||
      snapshot.lines.length !== intent.lines.length ||
      snapshot.totalMinor !== intent.totalMinor
    )
      throw review("invoice_mismatch", true);
    return snapshot;
  }
  function minor(value: number | undefined): number {
    if (value === undefined || !Number.isSafeInteger(value) || value < 0)
      throw review("provider_conflict");
    return value;
  }
  function amounts(value: Stripe.Invoice) {
    minor(value.amount_due);
    const result = {
      remainingMinor: minor(value.amount_remaining),
      paidMinor: minor(value.amount_paid),
      paidOffStripeMinor: minor(value.amount_paid_off_stripe),
      overpaidMinor: minor(value.amount_overpaid),
    };
    if (result.paidOffStripeMinor > result.paidMinor)
      throw review("provider_conflict");
    return result;
  }
  function paymentStatus(
    value: string,
  ): CollectionInspection["payments"][number]["status"] {
    switch (value) {
      case "open":
      case "paid":
      case "canceled":
        return value;
      default:
        throw review("provider_conflict");
    }
  }
  function intentState(
    value: string,
  ): CollectionInspection["payments"][number]["intentState"] {
    switch (value) {
      case "requires_payment_method":
      case "requires_confirmation":
      case "requires_action":
      case "processing":
      case "requires_capture":
      case "canceled":
      case "succeeded":
        return value;
      default:
        throw review("provider_conflict");
    }
  }
  return {
    ...createStripePaymentSettingsProvider({ stripe, ownership, maxPages }),
    ownership,
    inspectCollection: (intent, invoiceId) =>
      safe(async () => {
        checkIntent(intent);
        const initial = await stripe.invoices.retrieve(invoiceId, {
          expand: ["amount_paid_off_stripe"],
        });
        await resolutionSnapshot(intent, invoiceId, initial);
        const initialAmounts = amounts(initial);
        const values = await pages((cursor) =>
          stripe.invoicePayments.list({
            invoice: invoiceId,
            limit: 100,
            ...(cursor ? { starting_after: cursor } : {}),
          }),
        );
        if (!values) throw review("provider_conflict");
        const payments: CollectionInspection["payments"] = [];
        const seenIntents = new Set<string>();
        const seenRecords = new Set<string>();
        let externalPaid = 0;
        let active = false;
        let unknown = false;
        for (const value of values) {
          if (
            value.object !== "invoice_payment" ||
            !value.id.startsWith("inpay_") ||
            value.livemode !== false ||
            objectId(value.invoice) !== invoiceId ||
            value.currency !== "usd"
          )
            throw review("ownership_mismatch");
          if (value.payment?.type === "payment_record") {
            const id = objectId(value.payment.payment_record ?? null);
            if (!id || !id.startsWith("pr_") || seenRecords.has(id))
              throw review("provider_conflict");
            seenRecords.add(id);
            const record = await stripe.paymentRecords.retrieve(id);
            if (
              record.object !== "payment_record" ||
              record.id !== id ||
              record.livemode !== false ||
              record.customer_details?.customer !== intent.providerCustomerId
            )
              throw review("ownership_mismatch");
            const paid = minor(value.amount_paid ?? undefined);
            if (
              value.status !== "paid" ||
              paid === 0 ||
              minor(value.amount_requested) !== paid ||
              record.reported_by !== "self" ||
              record.payment_method_details?.type !== "custom" ||
              !record.payment_method_details.custom ||
              record.processor_details?.type !== "custom"
            )
              throw review("provider_conflict");
            // Support fully guaranteed external records; partial/refunded/unknown evidence stays closed.
            for (const amount of [
              record.amount,
              record.amount_requested,
              record.amount_authorized,
              record.amount_guaranteed,
            ]) {
              if (amount?.currency !== "usd" || minor(amount.value) !== paid)
                throw review("provider_conflict");
            }
            for (const amount of [
              record.amount_canceled,
              record.amount_failed,
              record.amount_refunded,
            ]) {
              if (amount?.currency !== "usd" || minor(amount.value) !== 0)
                throw review("provider_conflict");
            }
            externalPaid += paid;
            // External records have no PaymentIntent and must not enter the electronic baseline.
            continue;
          }
          if (value.payment?.type !== "payment_intent")
            throw review("provider_conflict");
          const id = objectId(value.payment.payment_intent ?? null);
          if (!id || !id.startsWith("pi_") || seenIntents.has(id))
            throw review("provider_conflict");
          seenIntents.add(id);
          const current = await stripe.paymentIntents.retrieve(id);
          if (
            current.object !== "payment_intent" ||
            current.id !== id ||
            current.livemode !== false ||
            objectId(current.customer) !== intent.providerCustomerId ||
            current.currency !== "usd"
          )
            throw review("ownership_mismatch");
          const status = paymentStatus(value.status);
          const state = intentState(current.status);
          const requested = minor(value.amount_requested);
          const paid =
            value.amount_paid === null ? null : minor(value.amount_paid);
          const received = minor(current.amount_received);
          const capturable = minor(current.amount_capturable);
          const amount = minor(current.amount);
          if (
            received > amount ||
            capturable > amount ||
            (paid !== null && (paid > requested || paid > received))
          )
            throw review("provider_conflict");
          if (
            [
              "requires_confirmation",
              "requires_action",
              "processing",
              "requires_capture",
            ].includes(state)
          )
            active = true;
          // A success without its invoice allocation, or unexplained received funds, is not idle.
          if (status === "paid") {
            if (state !== "succeeded" || paid === null || capturable !== 0)
              unknown = true;
          } else if (
            paid !== null ||
            received !== 0 ||
            capturable !== 0 ||
            state === "succeeded"
          )
            unknown = true;
          payments.push({
            invoicePaymentId: value.id,
            paymentIntentId: id,
            providerPaymentMethodId:
              objectId(current.payment_method ?? null) ?? null,
            status,
            paidMinor: paid,
            intentState: state,
            receivedMinor: received,
            capturableMinor: capturable,
          });
        }
        const final = await stripe.invoices.retrieve(invoiceId, {
          expand: ["amount_paid_off_stripe"],
        });
        const snapshot = await resolutionSnapshot(intent, invoiceId, final);
        const finalAmounts = amounts(final);
        if (
          initial.status !== final.status ||
          initial.amount_due !== final.amount_due ||
          initialAmounts.remainingMinor !== finalAmounts.remainingMinor ||
          initialAmounts.paidMinor !== finalAmounts.paidMinor ||
          initialAmounts.paidOffStripeMinor !==
            finalAmounts.paidOffStripeMinor ||
          initialAmounts.overpaidMinor !== finalAmounts.overpaidMinor
        )
          throw review("provider_conflict");
        const electronicPaid = payments.reduce(
          (sum, payment) =>
            sum + (payment.status === "paid" ? (payment.paidMinor ?? 0) : 0),
          0,
        );
        if (
          !Number.isSafeInteger(externalPaid) ||
          externalPaid !== finalAmounts.paidOffStripeMinor ||
          !Number.isSafeInteger(electronicPaid) ||
          electronicPaid !==
            finalAmounts.paidMinor - finalAmounts.paidOffStripeMinor
        )
          unknown = true;
        return {
          invoice: snapshot,
          ...finalAmounts,
          collectionState: unknown ? "unknown" : active ? "active" : "idle",
          payments,
        };
      }),
    payInvoice: (intent, request, effect) =>
      safe<CollectionPayOutcome>(async () => {
        checkIntent(intent);
        if (
          !request.providerInvoiceId.startsWith("in_") ||
          !request.providerPaymentMethodId.startsWith("pm_") ||
          request.offSession !== true
        )
          throw review("provider_conflict");
        let value: Stripe.Invoice;
        try {
          value = await stripe.invoices.pay(
            request.providerInvoiceId,
            {
              payment_method: request.providerPaymentMethodId,
              off_session: true,
              expand: ["payments.data.payment.payment_intent"],
            },
            { idempotencyKey: effect.idempotencyKey },
          );
        } catch (error) {
          // SDK 23 constructs StripeCardError from HTTP 402 even for a non-card error.
          if (
            !(error instanceof Stripe.errors.StripeCardError) ||
            error.rawType !== "card_error"
          ) {
            if (
              error instanceof Stripe.errors.StripeError &&
              (error.statusCode ?? 0) >= 400 &&
              (error.statusCode ?? 0) < 500 &&
              !(error instanceof Stripe.errors.StripeRateLimitError)
            )
              throw review("provider_conflict");
            throw error;
          }
          const actionCodes = [
            "authentication_required",
            "invoice_payment_intent_requires_action",
            "payment_intent_action_required",
          ];
          const requiresAction =
            actionCodes.includes(error.code ?? "") ||
            actionCodes.includes(error.decline_code ?? "") ||
            error.payment_intent?.status === "requires_action";
          // Error PaymentIntents are correlation hints, never owned payment evidence.
          const id = objectId(error.payment_intent ?? null);
          return {
            kind: requiresAction ? "requires_action" : "declined",
            paymentIntentId:
              typeof id === "string" && id.startsWith("pi_") ? id : null,
          };
        }
        return {
          kind: "response",
          receipt: collectionPayReceipt(intent, request, value),
        };
      }),
    settleExternally: (intent, invoiceId, effect) =>
      safe(async () => {
        checkIntent(intent);
        const value = await stripe.invoices.pay(
          invoiceId,
          { paid_out_of_band: true, expand: ["amount_paid_off_stripe"] },
          { idempotencyKey: effect.idempotencyKey },
        );
        const snapshot = await resolutionSnapshot(intent, invoiceId, value);
        return {
          invoice: snapshot,
          paidOffStripeMinor: amounts(value).paidOffStripeMinor,
        };
      }),
    voidInvoice: (intent, invoiceId, effect) =>
      safe(async () => {
        checkIntent(intent);
        await resolutionSnapshot(
          intent,
          invoiceId,
          await stripe.invoices.retrieve(invoiceId),
        );
        return resolutionSnapshot(
          intent,
          invoiceId,
          await stripe.invoices.voidInvoice(
            invoiceId,
            {},
            { idempotencyKey: effect.idempotencyKey },
          ),
        );
      }),
    findCustomer: (intent) =>
      safe(async () => {
        checkIntent(intent);
        const values = await pages((cursor) =>
          stripe.customers.list({
            limit: 100,
            ...(cursor ? { starting_after: cursor } : {}),
          }),
        );
        return find(
          values,
          {
            [metadataKeys.deployment]: intent.deploymentKey,
            [metadataKeys.customer]: intent.customerId,
          },
          (value) => customerSnapshot(intent, value),
        );
      }),
    createCustomer: (intent, effect) =>
      safe(async () => {
        checkIntent(intent);
        return customerSnapshot(
          intent,
          await stripe.customers.create(
            {
              name: intent.name,
              email: `${intent.customerId}@billing.test`,
              metadata: metadata(intent),
            },
            { idempotencyKey: effect.idempotencyKey },
          ),
        );
      }),
    findInvoice: (intent) =>
      safe(async () => {
        checkIntent(intent);
        const values = await pages((cursor) =>
          stripe.invoices.list({
            customer: intent.providerCustomerId,
            limit: 100,
            ...(cursor ? { starting_after: cursor } : {}),
          }),
        );
        return find(
          values,
          {
            [metadataKeys.deployment]: intent.deploymentKey,
            [metadataKeys.invoice]: intent.invoiceId,
          },
          (value) => invoiceSnapshot(intent, value),
        );
      }),
    createInvoice: (intent, effect) =>
      safe(async () => {
        checkIntent(intent);
        return invoiceSnapshot(
          intent,
          await stripe.invoices.create(
            {
              customer: intent.providerCustomerId,
              currency: "usd",
              collection_method: "send_invoice",
              auto_advance: false,
              automatic_tax: { enabled: false },
              due_date: dueSeconds(intent),
              pending_invoice_items_behavior: "exclude",
              metadata: metadata(intent),
            },
            { idempotencyKey: effect.idempotencyKey },
          ),
        );
      }),
    retrieveInvoice: (intent, invoiceId) =>
      safe(async () => {
        checkIntent(intent);
        const value = await stripe.invoices.retrieve(invoiceId);
        if (value.id !== invoiceId) throw review("ownership_mismatch", true);
        return invoiceSnapshot(intent, value);
      }),
    addLine: (intent, invoiceId, line, effect) =>
      safe(async () => {
        checkIntent(intent);
        if (
          !intent.lines.some(
            (expected) =>
              expected.lineId === line.lineId &&
              expected.position === line.position &&
              expected.amountMinor === line.amountMinor &&
              expected.description === line.description,
          )
        )
          throw review("invoice_mismatch");
        const current = await invoiceSnapshot(
          intent,
          await stripe.invoices.retrieve(invoiceId),
        );
        if (
          current.status !== "draft" ||
          current.lines.some((existing) => existing.lineId === line.lineId)
        )
          throw review("provider_conflict");
        const value = await stripe.invoiceItems.create(
          {
            customer: intent.providerCustomerId,
            invoice: invoiceId,
            currency: "usd",
            amount: line.amountMinor,
            description: line.description,
            discountable: false,
            metadata: metadata(intent, line),
          },
          { idempotencyKey: effect.idempotencyKey },
        );
        checkMetadata(value.metadata, metadata(intent, line), true);
        if (
          value.livemode ||
          objectId(value.invoice) !== invoiceId ||
          objectId(value.customer) !== intent.providerCustomerId ||
          value.currency !== "usd" ||
          value.amount !== line.amountMinor ||
          value.description !== line.description ||
          value.discounts?.length ||
          value.proration
        )
          throw review("invoice_mismatch", true);
        return {
          lineId: value.metadata![metadataKeys.line],
          position: Number(value.metadata![metadataKeys.position]),
          description: value.description,
          amountMinor: value.amount,
          providerLineId: value.id,
          currency: "USD",
        };
      }),
    finalizeInvoice: (intent, invoiceId, effect) =>
      safe(async () => {
        checkIntent(intent);
        const current = await invoiceSnapshot(
          intent,
          await stripe.invoices.retrieve(invoiceId),
        );
        if (
          current.lines.length !== intent.lines.length ||
          current.totalMinor !== intent.totalMinor ||
          current.recipientName !== intent.recipientName ||
          current.recipientEmail !== `${intent.customerId}@billing.test`
        )
          throw review("invoice_mismatch", true);
        if (current.status !== "draft") return current;
        return invoiceSnapshot(
          intent,
          await stripe.invoices.finalizeInvoice(
            invoiceId,
            { auto_advance: false },
            { idempotencyKey: effect.idempotencyKey },
          ),
        );
      }),
  };
}

export function createStripeEventVerifier(options: {
  signingSecret: string;
  ownership: ProviderOwnership;
}): BillingEventVerifier {
  if (!options.signingSecret.startsWith("whsec_"))
    throw review("ownership_mismatch");
  // No API key is needed for local signature verification.
  const stripe = new Stripe("unused", { apiVersion: "2026-09-30.endive" });
  return {
    async verifyEvent(rawBody, signature) {
      let event: Stripe.Event;
      try {
        event = await stripe.webhooks.constructEventAsync(
          rawBody,
          signature,
          options.signingSecret,
          undefined,
          Stripe.createSubtleCryptoProvider(),
        );
      } catch {
        throw review("ownership_mismatch");
      }
      if (
        event.livemode ||
        (event.account && event.account !== options.ownership.accountId) ||
        event.context
      )
        throw review("ownership_mismatch");
      if (event.type === "checkout.session.completed")
        return normalizeStripePaymentSetupEvent(event, options.ownership);
      if (!invoiceEvents.has(event.type)) return null;
      const value = event.data.object;
      if (
        value.object !== "invoice" ||
        value.livemode ||
        !value.id.startsWith("in_") ||
        !event.id.startsWith("evt_") ||
        !Number.isSafeInteger(event.created)
      )
        throw review("ownership_mismatch");
      const ownedMetadata =
        value.metadata?.[metadataKeys.deployment] ===
        options.ownership.deploymentKey;
      return {
        ...options.ownership,
        eventId: event.id,
        eventType: event.type,
        providerInvoiceId: value.id,
        invoiceId: ownedMetadata
          ? (value.metadata?.[metadataKeys.invoice] ?? null)
          : null,
        createdAt: new Date(event.created * 1000).toISOString(),
      };
    },
  };
}
