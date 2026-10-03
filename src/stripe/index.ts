import Stripe from "stripe";
import type { ProviderInvoiceStatus } from "../billing/contract";
import {
  BillingProviderError,
  type BillingEventVerifier,
  type BillingProvider,
  type CustomerIntent,
  type InvoiceIntent,
  type LineIntent,
  type Lookup,
  type ProviderCustomer,
  type ProviderInvoice,
  type ProviderLine,
  type ProviderOwnership,
} from "../billing/provider";

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
): Promise<BillingProvider> {
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
      for (const item of page.data) {
        if (seen.has(item.id)) return null;
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
  async function invoiceSnapshot(
    intent: InvoiceIntent,
    value: Stripe.Invoice,
  ): Promise<ProviderInvoice> {
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
      lines: lines.sort((a, b) => a.position - b.position),
      hostedInvoiceUrl,
      finalizedAt: finalized ? new Date(finalized * 1000).toISOString() : null,
      collectionMethod: "send_invoice",
      autoAdvance: false,
    };
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
  return {
    ownership,
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
