import {
  BillingProviderError,
  type BillingProvider,
  type InvoiceResolutionProvider,
  type CollectionInspection,
  type ProviderEffect,
  type CustomerIntent,
  type InvoiceIntent,
  type LineIntent,
  type Lookup,
  type ProviderCustomer,
  type ProviderInvoice,
  type ProviderLine,
} from "../../src/billing/provider";

export class SyntheticBillingProvider
  implements BillingProvider, InvoiceResolutionProvider
{
  readonly ownership = {
    deploymentKey: "billing-test",
    accountId: "acct_synthetic",
  };
  customers = new Map<string, ProviderCustomer>();
  invoices = new Map<string, ProviderInvoice>();
  calls = {
    customer: 0,
    invoice: 0,
    line: 0,
    finalize: 0,
    retrieve: 0,
    inspect: 0,
    settle: 0,
    void: 0,
  };
  interrupt = new Set<
    "customer" | "invoice" | "line" | "finalize" | "settle" | "void"
  >();
  onCreate:
    | ((invoice: ProviderInvoice, intent: InvoiceIntent) => Promise<void>)
    | null = null;
  unavailable = false;
  collectionError: BillingProviderError | null = null;
  stale: ProviderInvoice | null = null;
  private fail(
    effect: "customer" | "invoice" | "line" | "finalize" | "settle" | "void",
  ) {
    if (this.interrupt.delete(effect))
      throw new Error("Synthetic lost response");
  }
  async findCustomer(
    intent: CustomerIntent,
  ): Promise<Lookup<ProviderCustomer>> {
    const customer = this.customers.get(intent.customerId);
    return customer
      ? { kind: "found", value: structuredClone(customer) }
      : { kind: "absent" };
  }
  async createCustomer(intent: CustomerIntent): Promise<ProviderCustomer> {
    this.calls.customer++;
    const customer: ProviderCustomer = {
      ...intent,
      livemode: false,
      providerCustomerId: `cus_${intent.customerId}`,
    };
    this.customers.set(intent.customerId, customer);
    this.fail("customer");
    return structuredClone(customer);
  }
  async findInvoice(intent: InvoiceIntent): Promise<Lookup<ProviderInvoice>> {
    const invoice = [...this.invoices.values()].find(
      (row) => row.invoiceId === intent.invoiceId,
    );
    return invoice
      ? { kind: "found", value: structuredClone(invoice) }
      : { kind: "absent" };
  }
  async createInvoice(intent: InvoiceIntent): Promise<ProviderInvoice> {
    this.calls.invoice++;
    const invoice: ProviderInvoice = {
      ...intent,
      providerInvoiceId: `in_${intent.invoiceId}`,
      recipientEmail: `${intent.customerId}@billing.test`,
      livemode: false,
      status: "draft",
      lines: [],
      totalMinor: 0,
      hostedInvoiceUrl: null,
      finalizedAt: null,
      collectionMethod: "send_invoice",
      autoAdvance: false,
    };
    this.invoices.set(invoice.providerInvoiceId, invoice);
    await this.onCreate?.(invoice, intent);
    this.fail("invoice");
    return structuredClone(invoice);
  }
  async retrieveInvoice(
    _intent: InvoiceIntent,
    id: string,
  ): Promise<ProviderInvoice> {
    this.calls.retrieve++;
    if (this.unavailable)
      throw new BillingProviderError("retryable", "retry_exhausted");
    const invoice = structuredClone(this.stale ?? this.invoices.get(id)!);
    return invoice;
  }
  async addLine(
    _intent: InvoiceIntent,
    id: string,
    line: LineIntent,
  ): Promise<ProviderLine> {
    this.calls.line++;
    const receipt: ProviderLine = {
      ...line,
      providerLineId: `il_${line.lineId}`,
      currency: "USD",
    };
    const invoice = this.invoices.get(id)!;
    invoice.lines.push(receipt);
    invoice.totalMinor += line.amountMinor;
    this.fail("line");
    return structuredClone(receipt);
  }
  async finalizeInvoice(
    _intent: InvoiceIntent,
    id: string,
  ): Promise<ProviderInvoice> {
    this.calls.finalize++;
    const invoice = this.invoices.get(id)!;
    invoice.status = "open";
    invoice.hostedInvoiceUrl = `https://invoice.stripe.com/i/${id}`;
    invoice.finalizedAt = "2030-01-01T12:00:00.000Z";
    this.fail("finalize");
    return structuredClone(invoice);
  }
  collection = new Map<string, Omit<CollectionInspection, "invoice">>();
  resolutionKeys: string[] = [];
  resolutionReceipts = new Map<
    string,
    { invoice: ProviderInvoice; paidOffStripeMinor: number }
  >();
  afterResolution: (() => void) | null = null;
  evidence(id: string): Omit<CollectionInspection, "invoice"> {
    let value = this.collection.get(id);
    if (!value) {
      value = {
        remainingMinor: this.invoices.get(id)!.totalMinor,
        paidMinor: 0,
        paidOffStripeMinor: 0,
        overpaidMinor: 0,
        collectionState: "idle",
        payments: [],
      };
      this.collection.set(id, value);
    }
    return value;
  }
  async inspectCollection(
    intent: InvoiceIntent,
    id: string,
  ): Promise<CollectionInspection> {
    this.calls.inspect++;
    if (this.collectionError) throw this.collectionError;
    return {
      invoice: await this.retrieveInvoice(intent, id),
      ...structuredClone(this.evidence(id)),
    };
  }
  async settleExternally(
    _intent: InvoiceIntent,
    id: string,
    effect: ProviderEffect,
  ): Promise<{ invoice: ProviderInvoice; paidOffStripeMinor: number }> {
    this.calls.settle++;
    this.resolutionKeys.push(effect.idempotencyKey);
    if (this.unavailable)
      throw new BillingProviderError("retryable", "retry_exhausted");
    let receipt = this.resolutionReceipts.get(effect.idempotencyKey);
    if (!receipt) {
      const invoice = this.invoices.get(id)!;
      const evidence = this.evidence(id);
      evidence.paidOffStripeMinor += evidence.remainingMinor;
      evidence.paidMinor += evidence.remainingMinor;
      evidence.remainingMinor = 0;
      invoice.status = "paid";
      receipt = {
        invoice: structuredClone(invoice),
        paidOffStripeMinor: evidence.paidOffStripeMinor,
      };
      this.resolutionReceipts.set(effect.idempotencyKey, receipt);
      this.afterResolution?.();
    }
    this.fail("settle");
    return structuredClone(receipt);
  }
  async voidInvoice(
    _intent: InvoiceIntent,
    id: string,
    effect: ProviderEffect,
  ): Promise<ProviderInvoice> {
    this.calls.void++;
    this.resolutionKeys.push(effect.idempotencyKey);
    if (this.unavailable)
      throw new BillingProviderError("retryable", "retry_exhausted");
    let receipt = this.resolutionReceipts.get(effect.idempotencyKey);
    if (!receipt) {
      const invoice = this.invoices.get(id)!;
      invoice.status = "void";
      this.evidence(id).remainingMinor = 0;
      receipt = { invoice: structuredClone(invoice), paidOffStripeMinor: 0 };
      this.resolutionReceipts.set(effect.idempotencyKey, receipt);
      this.afterResolution?.();
    }
    this.fail("void");
    return structuredClone(receipt.invoice);
  }
}
