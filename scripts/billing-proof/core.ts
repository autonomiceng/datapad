import Stripe from "stripe";
import { Temporal } from "@js-temporal/polyfill";

export type Scenario =
  | "manual"
  | "automatic"
  | "early"
  | "decline"
  | "authentication"
  | "void"
  | "zero";
export interface Group {
  id: string;
  customer: "manual" | "automatic";
  scenario: Scenario;
  dueDate: string;
  readyDate: string;
  chargeAt: number;
  lines: { id: string; description: string; amount: number }[];
  invoice?: {
    id: string;
    status: Stripe.Invoice.Status | null;
    amountDue: number;
    amountPaid: number;
    attemptCount: number;
    hostedInvoiceUrl: string | null;
    invoicePdf: string | null;
    dueDate: number | null;
    created: number;
    finalizedAt: number | null;
    lineCount: number;
    paymentCount: number;
    observedAt: number;
  };
  action?: string;
}
export interface Operation {
  id: string;
  kind: string;
  intent: unknown;
  state: "pending" | "done" | "uncertain";
  objectId?: string;
  errorCode?: string;
  error?: {
    type: string;
    statusCode?: number;
    param?: string;
    message: string;
    requestId?: string;
  };
}
export interface Manifest {
  schemaVersion: 1;
  runId: string;
  createdAt: string;
  timezone: "UTC";
  clock: { id?: string; frozenTime: number; status?: string };
  customers: { manual?: string; automatic?: string };
  groups: Group[];
  operations: Record<string, Operation>;
  events: {
    at: string;
    clockTime: number;
    kind: string;
    groupId?: string;
    message: string;
  }[];
}
export class ProofError extends Error {}
export function calendar(dueDate: string, timezone = "UTC") {
  const due = Temporal.PlainDate.from(dueDate);
  const ready = due.subtract({ days: 21 });
  const seconds = (date: Temporal.PlainDate, hour: number) =>
    Number(
      date.toZonedDateTime({ timeZone: timezone, plainTime: { hour } })
        .epochNanoseconds / 1_000_000_000n,
    );
  return {
    dueDate: due.toString(),
    readyDate: ready.toString(),
    chargeAt: seconds(due, 9),
    readyAt: seconds(ready, 0),
  };
}
export function createManifest(startDate: string): Manifest {
  const start = Temporal.PlainDate.from(startDate);
  const groups: Group[] = (
    [
      "manual",
      "automatic",
      "early",
      "decline",
      "authentication",
      "void",
      "zero",
    ] as const
  ).map((scenario, index) => {
    const dates = calendar(
      start.add({ days: 21 + Math.max(0, index - 1) }).toString(),
    );
    return {
      id: scenario,
      customer:
        scenario === "manual" || scenario === "zero" ? "manual" : "automatic",
      scenario,
      dueDate: dates.dueDate,
      readyDate: dates.readyDate,
      chargeAt: dates.chargeAt,
      lines:
        scenario === "automatic"
          ? [
              { id: "hosting", description: "Synthetic hosting", amount: 1200 },
              { id: "storage", description: "Synthetic storage", amount: 300 },
              {
                id: "included",
                description: "Synthetic included service",
                amount: 0,
              },
            ]
          : [
              {
                id: scenario,
                description: `Synthetic ${scenario} service`,
                amount: scenario === "zero" ? 0 : 1000,
              },
            ],
      ...(scenario === "zero" ? { action: "No charge" } : {}),
    };
  });
  return {
    schemaVersion: 1,
    runId: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    timezone: "UTC",
    clock: { frozenTime: calendar(start.add({ days: 21 }).toString()).readyAt },
    customers: {},
    groups,
    operations: {},
    events: [],
  };
}
export function safeError(error: unknown): string {
  if (error instanceof ProofError) return error.message;
  if (error instanceof Stripe.errors.StripeError)
    return `Stripe request failed (${error.type}; ${error.code && /^[a-z_]+$/.test(error.code) ? error.code : "no_code"}). Review private evidence before retrying.`;
  return "Operation failed. Review private configuration and run state; raw errors are withheld.";
}
export function testObject<T extends { livemode: boolean }>(object: T): T {
  if (object.livemode !== false)
    throw new ProofError("Provider returned a non-test object; stopped.");
  return object;
}
function objectId(
  value: string | { id: string } | null | undefined,
): string | null {
  return typeof value === "string" ? value : (value?.id ?? null);
}

/** One exclusive local owner. Existing ambiguous intents are reconciled, never recreated. */
export class Probe {
  constructor(
    readonly stripe: Stripe,
    readonly manifest: Manifest,
    readonly save: () => Promise<void>,
    readonly interruptAfterInvoice = false,
  ) {}
  event(kind: string, message: string, groupId?: string) {
    this.manifest.events.push({
      at: new Date().toISOString(),
      clockTime: this.manifest.clock.frozenTime,
      kind,
      message,
      ...(groupId ? { groupId } : {}),
    });
  }
  metadata(id: string) {
    return { proof_run: this.manifest.runId, proof_operation: id };
  }
  owned(
    object: { livemode: boolean; metadata: Stripe.Metadata | null },
    id: string,
  ) {
    testObject(object);
    if (
      object.metadata?.proof_run !== this.manifest.runId ||
      object.metadata.proof_operation !== id
    )
      throw new ProofError(
        "Provider object ownership does not match the durable intent.",
      );
  }
  async operation<T extends { id: string }>(
    id: string,
    kind: string,
    intent: unknown,
    create: (key: string) => Promise<T>,
    reconcile: (knownId?: string) => Promise<T | undefined>,
    verify: (object: T) => void,
  ): Promise<T> {
    let operation = this.manifest.operations[id];
    let result: T | undefined;
    if (operation) {
      if (JSON.stringify(operation.intent) !== JSON.stringify(intent))
        throw new ProofError(
          "Immutable operation intent changed; stopped for review.",
        );
      result = await reconcile(operation.objectId);
      if (!result) {
        operation.state = "uncertain";
        await this.save();
        throw new ProofError(
          "Uncertain provider outcome could not be reconciled. No new request was sent; operator review is required.",
        );
      }
    } else {
      operation = { id, kind, intent, state: "pending" };
      this.manifest.operations[id] = operation;
      await this.save();
      try {
        result = await create(`datapad-proof:${this.manifest.runId}:${id}`);
        if (kind === "invoice" && this.interruptAfterInvoice)
          throw new ProofError(
            "Injected interruption after invoice creation and before local receipt. Rerun prepare without the interruption flag to reconcile.",
          );
      } catch (error) {
        operation.state = "uncertain";
        if (error instanceof Stripe.errors.StripeError)
          operation.error = {
            type: error.type,
            statusCode: error.statusCode,
            param: error.param,
            message: error.message.replace(
              /(?:sk|rk)_(?:test|live)_[A-Za-z0-9]+/g,
              "[redacted]",
            ),
            requestId: error.requestId,
          };
        operation.errorCode =
          error instanceof Stripe.errors.StripeError &&
          error.code &&
          /^[a-z_]+$/.test(error.code)
            ? error.code
            : "uncertain";
        await this.save();
        throw error;
      }
    }
    verify(result);
    operation.state = "done";
    operation.objectId = result.id;
    await this.save();
    return result;
  }
  async unique<T>(
    items: AsyncIterable<T>,
    matches: (item: T) => boolean,
  ): Promise<T | undefined> {
    let found: T | undefined;
    for await (const item of items) {
      if (!matches(item)) continue;
      if (found)
        throw new ProofError(
          "Multiple provider objects match one intent; stopped for review.",
        );
      found = item;
    }
    return found;
  }
  async setup() {
    const name = `datapad-proof:${this.manifest.runId}`;
    const initialTime = calendar(this.manifest.groups[0].dueDate).readyAt;
    const clock = await this.operation(
      "clock",
      "clock",
      { name, frozen_time: initialTime },
      (key) =>
        this.stripe.testHelpers.testClocks.create(
          { name, frozen_time: initialTime },
          { idempotencyKey: key },
        ),
      (id) =>
        id
          ? this.stripe.testHelpers.testClocks.retrieve(id)
          : this.unique(
              this.stripe.testHelpers.testClocks.list({ limit: 100 }),
              (item) => item.name === name,
            ),
      (value) => {
        testObject(value);
        if (value.name !== name)
          throw new ProofError("Clock ownership mismatch.");
      },
    );
    this.manifest.clock = {
      id: clock.id,
      frozenTime: clock.frozen_time,
      status: clock.status,
    };
    await this.save();
    if (clock.status !== "ready")
      throw new ProofError(
        "Stripe test clock is not ready; refresh after advancement completes.",
      );
    for (const role of ["manual", "automatic"] as const) {
      const id = `customer:${role}`;
      const request: Stripe.CustomerCreateParams = {
        name: `Synthetic ${role} customer`,
        email: `${role}@billing-proof.test`,
        test_clock: clock.id,
        metadata: this.metadata(id),
      };
      const customer = await this.operation(
        id,
        "customer",
        request,
        (key) => this.stripe.customers.create(request, { idempotencyKey: key }),
        async (known) => {
          if (known) {
            const value = await this.stripe.customers.retrieve(known);
            if (value.deleted)
              throw new ProofError("Owned customer was deleted.");
            return value;
          }
          return this.unique(
            this.stripe.customers.list({ test_clock: clock.id, limit: 100 }),
            (value) =>
              value.metadata.proof_operation === id &&
              value.metadata.proof_run === this.manifest.runId,
          );
        },
        (value) => {
          this.owned(value, id);
          if (objectId(value.test_clock) !== clock.id)
            throw new ProofError("Customer test clock mismatch.");
        },
      );
      this.manifest.customers[role] = customer.id;
      await this.save();
    }
  }
  async clock() {
    const id = this.manifest.clock.id;
    if (!id) throw new ProofError("Initialize the run first.");
    const clock = testObject(
      await this.stripe.testHelpers.testClocks.retrieve(id),
    );
    if (clock.name !== `datapad-proof:${this.manifest.runId}`)
      throw new ProofError("Clock ownership mismatch.");
    this.manifest.clock = {
      id,
      frozenTime: clock.frozen_time,
      status: clock.status,
    };
    await this.save();
    if (clock.status !== "ready")
      throw new ProofError(
        "Stripe test clock is not ready; refresh after advancement completes.",
      );
    return clock;
  }
  async advance(to: number) {
    const clock = await this.clock();
    if (!Number.isSafeInteger(to) || to <= clock.frozen_time)
      throw new ProofError(
        "Advance requires an instant after Stripe's current frozen time.",
      );
    const id = `advance:${to}`;
    await this.operation(
      id,
      "advance",
      { frozen_time: to },
      (key) =>
        this.stripe.testHelpers.testClocks.advance(
          clock.id,
          { frozen_time: to },
          { idempotencyKey: key },
        ),
      async () => {
        const value = testObject(
          await this.stripe.testHelpers.testClocks.retrieve(clock.id),
        );
        return value.frozen_time === to ? value : undefined;
      },
      testObject,
    );
    this.event(
      "advance",
      "Stripe test clock advancement requested. Refresh until Stripe reports ready.",
    );
  }
  async customer(role: Group["customer"]) {
    const id = this.manifest.customers[role];
    if (!id) throw new ProofError("Initialize both synthetic customers first.");
    const customer = await this.stripe.customers.retrieve(id);
    if (customer.deleted) throw new ProofError("Owned customer was deleted.");
    this.owned(customer, `customer:${role}`);
    if (objectId(customer.test_clock) !== this.manifest.clock.id)
      throw new ProofError("Customer test clock mismatch.");
    return customer;
  }
  verifyInvoice(invoice: Stripe.Invoice, group: Group) {
    this.owned(invoice, `invoice:${group.id}`);
    if (
      objectId(invoice.customer) !== this.manifest.customers[group.customer] ||
      objectId(invoice.test_clock) !== this.manifest.clock.id ||
      invoice.collection_method !== "send_invoice" ||
      invoice.auto_advance !== false ||
      invoice.due_date !== group.chargeAt ||
      invoice.currency !== "usd"
    )
      throw new ProofError(
        "Invoice does not match its test-clock request intent; stop and inspect provider compatibility.",
      );
  }
  async observe(group: Group, invoice: Stripe.Invoice) {
    this.verifyInvoice(invoice, group);
    const payments = await this.stripe.invoicePayments.list({
      invoice: invoice.id,
      limit: 100,
    });
    for (const payment of payments.data) testObject(payment);
    if (payments.has_more)
      throw new ProofError("Unexpected payment count; inspect privately.");
    group.invoice = {
      id: invoice.id,
      status: invoice.status,
      amountDue: invoice.amount_due,
      amountPaid: invoice.amount_paid,
      attemptCount: invoice.attempt_count,
      hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
      invoicePdf: invoice.invoice_pdf ?? null,
      dueDate: invoice.due_date,
      created: invoice.created,
      finalizedAt: invoice.status_transitions.finalized_at,
      lineCount: invoice.lines.data.length,
      paymentCount: payments.data.length,
      observedAt: Math.floor(Date.now() / 1000),
    };
    if (invoice.status === "paid")
      group.action = "Paid confirmed by Stripe retrieval";
    else if (invoice.status === "void") group.action = "Voided; no collection";
    await this.save();
  }
  async prepare() {
    await this.clock();
    for (const group of this.manifest.groups) {
      if (group.lines.every((line) => line.amount === 0)) continue;
      if (this.manifest.clock.frozenTime < calendar(group.dueDate).readyAt)
        continue;
      const id = `invoice:${group.id}`;
      if (
        !this.manifest.operations[id] &&
        this.manifest.clock.frozenTime >= group.chargeAt
      )
        throw new ProofError(
          "Readiness window has passed for this group; no invoice request was sent. Start a new run.",
        );
      await this.customer(group.customer);
      const customer = this.manifest.customers[group.customer]!;
      const description =
        group.customer === "manual"
          ? "Synthetic sandbox invoice. Pay manually using test details."
          : `Synthetic sandbox invoice. Automatic payment will be attempted at ${new Date(group.chargeAt * 1000).toISOString()} if still unpaid. You may pay early using this page.`;
      const request: Stripe.InvoiceCreateParams = {
        customer,
        currency: "usd",
        collection_method: "send_invoice",
        auto_advance: false,
        due_date: group.chargeAt,
        pending_invoice_items_behavior: "exclude",
        description,
        metadata: this.metadata(id),
        payment_settings: { payment_method_types: ["card"] },
      };
      let invoice = await this.operation(
        id,
        "invoice",
        request,
        (key) => this.stripe.invoices.create(request, { idempotencyKey: key }),
        (known) =>
          known
            ? this.stripe.invoices.retrieve(known)
            : this.unique(
                this.stripe.invoices.list({ customer, limit: 100 }),
                (value) =>
                  value.metadata?.proof_run === this.manifest.runId &&
                  value.metadata.proof_operation === id,
              ),
        (value) => this.verifyInvoice(value, group),
      );
      if (invoice.status === "draft") {
        for (const line of group.lines) {
          const lineId = `line:${group.id}:${line.id}`;
          const lineRequest: Stripe.InvoiceItemCreateParams = {
            customer,
            invoice: invoice.id,
            currency: "usd",
            amount: line.amount,
            description: line.description,
            metadata: this.metadata(lineId),
          };
          await this.operation(
            lineId,
            "line",
            lineRequest,
            (key) =>
              this.stripe.invoiceItems.create(lineRequest, {
                idempotencyKey: key,
              }),
            (known) =>
              known
                ? this.stripe.invoiceItems.retrieve(known)
                : this.unique(
                    this.stripe.invoiceItems.list({
                      customer,
                      invoice: invoice.id,
                      limit: 100,
                    }),
                    (value) =>
                      value.metadata?.proof_run === this.manifest.runId &&
                      value.metadata.proof_operation === lineId,
                  ),
            (value) => {
              this.owned(value, lineId);
              if (
                objectId(value.invoice) !== invoice.id ||
                value.amount !== line.amount
              )
                throw new ProofError("Invoice line intent mismatch.");
            },
          );
        }
        const draft = await this.stripe.invoices.retrieve(invoice.id);
        this.verifyInvoice(draft, group);
        if (
          draft.lines.has_more ||
          draft.lines.data.length !== group.lines.length ||
          draft.total !==
            group.lines.reduce((sum, line) => sum + line.amount, 0)
        )
          throw new ProofError(
            "Draft lines or total do not match the synthetic group.",
          );
        invoice = await this.operation(
          `finalize:${group.id}`,
          "finalize",
          { invoice: invoice.id, auto_advance: false },
          (key) =>
            this.stripe.invoices.finalizeInvoice(
              invoice.id,
              { auto_advance: false },
              { idempotencyKey: key },
            ),
          async () => {
            const value = await this.stripe.invoices.retrieve(invoice.id);
            return value.status !== "draft" ? value : undefined;
          },
          (value) => this.verifyInvoice(value, group),
        );
        this.event(
          "finalized",
          "Invoice finalized at Stripe test-clock time; email delivery is not claimed.",
          group.id,
        );
      }
      await this.observe(group, invoice);
      if (!invoice.hosted_invoice_url)
        throw new ProofError(
          "No Hosted Invoice Page returned. Stop and review standalone-invoice/test-clock compatibility.",
        );
    }
  }
  async refresh() {
    await this.clock();
    for (const group of this.manifest.groups) {
      const id =
        group.invoice?.id ??
        this.manifest.operations[`invoice:${group.id}`]?.objectId;
      if (id)
        await this.observe(group, await this.stripe.invoices.retrieve(id));
    }
    this.event(
      "refresh",
      "Retrieved current Stripe invoice state. Browser return URLs are not payment evidence.",
    );
    await this.save();
  }
  async paymentMethod(group: Group) {
    const kind =
      group.scenario === "decline"
        ? "decline"
        : group.scenario === "authentication"
          ? "authentication"
          : "success";
    const id = `method:${kind}`;
    const testMethod =
      kind === "decline"
        ? "pm_card_chargeCustomerFail"
        : kind === "authentication"
          ? "pm_card_authenticationRequired"
          : "pm_card_visa";
    const customer = (await this.customer("automatic")).id;
    const request = { payment_method: testMethod, customer };
    const method = await this.operation(
      id,
      "method",
      request,
      (key) =>
        this.stripe.paymentMethods.attach(
          testMethod,
          { customer },
          { idempotencyKey: key },
        ),
      async (known) =>
        known ? this.stripe.paymentMethods.retrieve(known) : undefined,
      (value) => {
        testObject(value);
        if (objectId(value.customer) !== customer)
          throw new ProofError("Synthetic payment method customer mismatch.");
      },
    );
    await this.operation(
      `tag:${kind}`,
      "metadata",
      { method: method.id, metadata: this.metadata(id) },
      (key) =>
        this.stripe.paymentMethods.update(
          method.id,
          { metadata: this.metadata(id) },
          { idempotencyKey: key },
        ),
      async () => {
        const value = await this.stripe.paymentMethods.retrieve(method.id);
        return value.metadata?.proof_run === this.manifest.runId &&
          value.metadata.proof_operation === id
          ? value
          : undefined;
      },
      (value) => this.owned(value, id),
    );
    if (kind === "success") {
      const setupId = "setup:success";
      const setupRequest: Stripe.SetupIntentCreateParams = {
        customer,
        payment_method: method.id,
        confirm: true,
        usage: "off_session",
        allowed_payment_method_types: ["card"],
        metadata: this.metadata(setupId),
      };
      const setup = await this.operation(
        setupId,
        "setup",
        setupRequest,
        (key) =>
          this.stripe.setupIntents.create(setupRequest, {
            idempotencyKey: key,
          }),
        (known) =>
          known
            ? this.stripe.setupIntents.retrieve(known)
            : this.unique(
                this.stripe.setupIntents.list({ customer, limit: 100 }),
                (value) =>
                  value.metadata?.proof_run === this.manifest.runId &&
                  value.metadata.proof_operation === setupId,
              ),
        (value) => this.owned(value, setupId),
      );
      if (setup.status !== "succeeded")
        throw new ProofError(
          "Synthetic off-session payment setup has not succeeded.",
        );
    }
    return method.id;
  }
  async collect() {
    await this.clock();
    for (const group of this.manifest.groups) {
      if (
        group.customer === "manual" ||
        !group.invoice ||
        this.manifest.clock.frozenTime < group.chargeAt
      )
        continue;
      const invoice = await this.stripe.invoices.retrieve(group.invoice.id);
      await this.observe(group, invoice);
      if (invoice.status !== "open" || invoice.amount_remaining <= 0) {
        this.event(
          "skipped",
          "Retrieved invoice is no longer payable; no payment request sent.",
          group.id,
        );
        continue;
      }
      const id = `pay:${group.id}`;
      if (this.manifest.operations[id]) {
        const operation = this.manifest.operations[id];
        if (operation.state !== "done")
          throw new ProofError(
            "Previous payment outcome remains uncertain; retrieve provider evidence and review. No further payment request was sent.",
          );
        this.event(
          "skipped",
          "One explicit attempt already recorded; no retry campaign.",
          group.id,
        );
        continue;
      }
      const method = await this.paymentMethod(group);
      // A browser payment can occur during setup: recheck immediately before attempting collection.
      const current = await this.stripe.invoices.retrieve(invoice.id);
      await this.observe(group, current);
      if (current.status !== "open" || current.amount_remaining <= 0) continue;
      const intent = {
        invoice: invoice.id,
        payment_method: method,
        off_session: true,
      };
      this.manifest.operations[id] = {
        id,
        kind: "payment",
        intent,
        state: "pending",
      };
      await this.save();
      try {
        const paid = await this.stripe.invoices.pay(
          invoice.id,
          { payment_method: method, off_session: true },
          { idempotencyKey: `datapad-proof:${this.manifest.runId}:${id}` },
        );
        this.verifyInvoice(paid, group);
        this.manifest.operations[id].state = "done";
        this.manifest.operations[id].objectId = paid.id;
        this.event(
          "payment",
          "One explicit off-session payment request completed.",
          group.id,
        );
      } catch (error) {
        const expected = error instanceof Stripe.errors.StripeCardError;
        this.manifest.operations[id].state = expected ? "done" : "uncertain";
        this.manifest.operations[id].errorCode =
          error instanceof Stripe.errors.StripeError &&
          error.code &&
          /^[a-z_]+$/.test(error.code)
            ? error.code
            : "uncertain";
        group.action =
          expected &&
          (error.code === "authentication_required" ||
            group.scenario === "authentication")
            ? "Authentication required. Complete the test payment on the Hosted Invoice Page, then refresh."
            : expected
              ? "Payment declined. Invoice remains unpaid; review the test payment method."
              : "Payment outcome uncertain. Stop for operator review.";
        this.event("payment", group.action, group.id);
        await this.save();
        if (!expected) throw error;
      }
      await this.save();
      await this.observe(
        group,
        await this.stripe.invoices.retrieve(invoice.id),
      );
    }
    await this.save();
  }
  async voidExample() {
    await this.clock();
    const group = this.manifest.groups.find(
      (value) => value.scenario === "void",
    )!;
    if (!group.invoice || this.manifest.clock.frozenTime >= group.chargeAt)
      throw new ProofError(
        "Prepare the void example and void it before its due time.",
      );
    const invoice = await this.stripe.invoices.retrieve(group.invoice.id);
    this.verifyInvoice(invoice, group);
    if (invoice.status === "void") {
      await this.observe(group, invoice);
      return;
    }
    if (invoice.status !== "open")
      throw new ProofError("Void example must be open.");
    const result = await this.operation(
      "void",
      "void",
      { invoice: invoice.id },
      (key) =>
        this.stripe.invoices.voidInvoice(
          invoice.id,
          {},
          { idempotencyKey: key },
        ),
      async () => {
        const value = await this.stripe.invoices.retrieve(invoice.id);
        return value.status === "void" ? value : undefined;
      },
      (value) => this.verifyInvoice(value, group),
    );
    await this.observe(group, result);
    this.event(
      "void",
      "Voided before due time. This does not implement service cancellation.",
      group.id,
    );
    await this.save();
  }
}
