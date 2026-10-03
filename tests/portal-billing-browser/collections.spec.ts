import { createHash, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { Pool } from "pg";
import Stripe from "stripe";
import canonicalize from "canonicalize";
import {
  assertCollectionsDirectory,
  assertCollectionsWindow,
  collectionsPhase,
  loadCollectionsPlan,
  readCollectionsPrivateJson,
  writeCollectionsPrivateJson,
} from "../../scripts/collections-acceptance";
import type { AccessSessionResponse } from "../../src/access/contract";
import type { InvoiceResponse } from "../../src/billing/contract";
import {
  ENROLLMENT_TERMS_TEXT,
  SAVE_TERMS_TEXT,
  type ChangeEnrollmentResponse,
  type PaymentSettingsResponse,
  type PaymentSetupResponse,
} from "../../src/billing/payment-settings-contract";
import type {
  ScheduleResponse,
  ScheduledGroupsResponse,
} from "../../src/billing/scheduled-contract";
import type {
  CreateSubscriptionResponse,
  SubscriptionOptionsResponse,
  SubscriptionsResponse,
} from "../../src/billing/subscriptions-contract";
import { signIn } from "../portal-browser/helpers";

type Subscription = CreateSubscriptionResponse["subscription"];
interface OwnedMethod {
  id: string;
  setup_id: string;
  billing_customer_id: string;
  provider_account_id: string;
  provider_customer_id: string;
  provider_session_id: string;
  provider_setup_intent_id: string;
  provider_payment_method_id: string;
  accepted_at: string;
  verified_at: string;
}
interface Attempt {
  id: string;
  invoice_id: string;
  group_id: string;
  enrollment_id: string;
  payment_method_id: string;
  state: string;
  reason: string | null;
  currency: string;
  remaining_minor: number;
  idempotency_key: string;
  request_digest: string;
  request: {
    providerInvoiceId: string;
    providerPaymentMethodId: string;
    offSession: true;
  };
  first_attempted_at: string;
  last_dispatched_at: string;
  response_at: string | null;
  response_kind: string | null;
  dispatch_count: number;
  attributed_invoice_payment_id: string | null;
  attributed_payment_intent_id: string | null;
  baseline_paid_minor: number;
  baseline_paid_off_stripe_minor: number;
  baseline_overpaid_minor: number;
  charge_at: string;
  due_end_at: string;
}
interface CustomerCheckpoint {
  customerId: string;
  email: string;
  subscriptions: Subscription[];
  method: OwnedMethod;
  enrollmentId: string;
  consentAcceptedAt: string;
}
interface Checkpoint extends CustomerCheckpoint {
  runId: string;
  early: CustomerCheckpoint;
  automaticInvoiceId?: string;
  earlyInvoiceId?: string;
  beforeCollection?: ProviderSnapshot;
  earlyPaid?: ProviderSnapshot;
  beforeCharges?: ChargeSnapshot;
  earlyCharges?: ChargeSnapshot;
  earlyPaymentAttemptedAt?: string;
  collected?: {
    processToken: string;
    attempt: Attempt;
    provider: ProviderSnapshot;
    charges: ChargeSnapshot;
  };
}
interface ProviderSnapshot {
  id: string;
  customer: string;
  total: number;
  remaining: number;
  paid: number;
  offStripe: number;
  overpaid: number;
  status: string | null;
  allocations: Array<{
    id: string;
    status: string;
    paid: number | null;
    intentId: string | null;
    intentStatus: string | null;
    received: number;
    methodId: string | null;
  }>;
}
type ChargeSnapshot = Array<{
  id: string;
  amount: number;
  paid: boolean;
  intentId: string | null;
}>;
const objectId = (value: string | { id: string } | null) =>
  typeof value === "string" ? value : (value?.id ?? null);

// One bounded group runs separately before the window, in the real window, and
// after root's owned restart. It never waits for 09:00 or starts/stops a server.
test("due-day saved-card collection survives an owned restart without a second charge", async ({
  page,
}) => {
  const directory = process.env.PORTAL_COLLECTIONS_TEST_ARTIFACTS!;
  const plan = await loadCollectionsPlan(
    process.env.PORTAL_COLLECTIONS_TEST_PLAN!,
  );
  const mode = collectionsPhase(process.env.PORTAL_COLLECTIONS_TEST_PHASE);
  await assertCollectionsDirectory(directory);
  assertCollectionsWindow(plan, mode);
  const clock = process.env.PORTAL_COLLECTIONS_TEST_CLOCK!;
  const deployment = process.env.BILLING_DEPLOYMENT_KEY!;
  const origin = new URL(process.env.TEST_BASE_URL!).origin;
  const statePath = join(directory, "collections-state.json");
  const processInfo = (await readCollectionsPrivateJson(
    join(directory, "collections-process.json"),
  )) as { token: string; phase: string; startedAt: string };
  expect(processInfo.phase).toBe(mode);
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    options: "-c default_transaction_read_only=on",
    connectionTimeoutMillis: 15000,
    statement_timeout: 15000,
  });
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
    apiVersion: "2026-09-30.endive",
    maxNetworkRetries: 0,
    timeout: 15000,
  });
  let stage = "initial private state";
  let checkpoint: Checkpoint | undefined;
  const evidence: Record<string, unknown> = {
    phase: mode,
    runId: plan.runId,
    realStartedAt: new Date().toISOString(),
    calendar: plan,
    processToken: processInfo.token,
  };
  const save = () => writeCollectionsPrivateJson(statePath, checkpoint);
  const get = async <T>(path: string): Promise<T> => {
    const response = await page.request.get(path);
    expect(response.ok()).toBe(true);
    expect(response.headers()["cache-control"]).toContain("no-store");
    return response.json();
  };
  const post = async <T>(path: string, data: unknown): Promise<T> => {
    const response = await page.request.post(path, {
      headers: { origin },
      data,
    });
    expect(response.ok()).toBe(true);
    return response.json();
  };
  const posted = (path: string) => {
    const pending = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === path &&
        response.request().method() === "POST",
    );
    void pending.catch(() => undefined);
    return pending;
  };
  const detail = async (id: string) =>
    (await get<InvoiceResponse>(`/api/billing/invoices/${id}`)).invoice;
  const layouts = async (name: string) => {
    expect(new URL(page.url()).origin).toBe(origin);
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
      // Portal-only captures. Never capture Checkout/card inputs/provider pages.
      await writeFile(
        join(
          directory,
          `${plan.runId}-${mode}-${name}-${width}-${randomUUID()}.png`,
        ),
        await page.screenshot({ fullPage: true }),
        { mode: 0o600, flag: "wx" },
      );
    }
    await page.setViewportSize({ width: 1280, height: 900 });
  };
  const signOut = async () => {
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Sign in", exact: true }),
    ).toBeVisible();
  };
  const challenge = async (hosted: Page) => {
    for (const frame of hosted.frames()) {
      if (
        await frame
          .getByText(
            /verify (?:that )?you(?: are|'re) human|complete the captcha|security challenge|access denied|unusual activity/i,
          )
          .first()
          .isVisible()
          .catch(() => false)
      )
        return true;
      if (
        await frame
          .locator('iframe[title*="challenge" i], iframe[title*="captcha" i]')
          .first()
          .isVisible()
          .catch(() => false)
      )
        return true;
    }
    return false;
  };
  const hostedField = async (selector: string): Promise<Locator> => {
    let field: Locator | undefined;
    await expect
      .poll(
        async () => {
          if (await challenge(page))
            throw new Error(
              "Hosted setup blocked by provider challenge; no bypass attempted.",
            );
          for (const frame of page.frames()) {
            const candidate = frame.locator(selector).first();
            if (await candidate.isVisible().catch(() => false)) {
              field = candidate;
              return true;
            }
          }
          return false;
        },
        { timeout: 20000, intervals: [500, 1000] },
      )
      .toBe(true);
    return field!;
  };
  const methodFor = async (customerId: string, setupId: string) => {
    const { rows } = await pool.query<OwnedMethod>(
      `select m.id, m.setup_id, m.billing_customer_id, m.provider_account_id,
        b.provider_customer_id, s.provider_session_id, s.provider_setup_intent_id,
        m.provider_payment_method_id, s.accepted_at::text, m.verified_at::text
        from billing_payment_methods m join billing_payment_setups s
          on s.id=m.setup_id and s.customer_id=m.customer_id and s.deployment_key=m.deployment_key
          and s.billing_customer_id=m.billing_customer_id and s.provider_account_id=m.provider_account_id
        join billing_customers b on b.id=m.billing_customer_id and b.customer_id=m.customer_id
          and b.deployment_key=m.deployment_key and b.provider_account_id=m.provider_account_id
        where m.customer_id=$1 and m.deployment_key=$2 and s.id=$3 and s.status='verified'
          and s.provider_payment_method_id=m.provider_payment_method_id and s.save_terms_version='save-card-v1'
          and s.save_terms_digest <> ''`,
      [customerId, deployment, setupId],
    );
    expect(rows).toHaveLength(1);
    const method = rows[0]!;
    expect((await stripe.accounts.retrieveCurrent()).id).toBe(
      method.provider_account_id,
    );
    const session = await stripe.checkout.sessions.retrieve(
      method.provider_session_id,
    );
    const intent = await stripe.setupIntents.retrieve(
      method.provider_setup_intent_id,
    );
    const card = await stripe.paymentMethods.retrieve(
      method.provider_payment_method_id,
    );
    expect({
      status: session.status,
      mode: session.mode,
      live: session.livemode,
      customer: objectId(session.customer),
      setup: objectId(session.setup_intent),
      payment: session.payment_intent,
      subscription: session.subscription,
      deployment: session.metadata?.datapad_deployment,
      localSetup: session.metadata?.datapad_setup,
      mapping: session.metadata?.datapad_customer,
    }).toEqual({
      status: "complete",
      mode: "setup",
      live: false,
      customer: method.provider_customer_id,
      setup: intent.id,
      payment: null,
      subscription: null,
      deployment,
      localSetup: setupId,
      mapping: method.billing_customer_id,
    });
    expect({
      status: intent.status,
      usage: intent.usage,
      live: intent.livemode,
      customer: objectId(intent.customer),
      method: objectId(intent.payment_method),
      setup: intent.metadata?.datapad_setup,
      deployment: intent.metadata?.datapad_deployment,
    }).toEqual({
      status: "succeeded",
      usage: "off_session",
      live: false,
      customer: method.provider_customer_id,
      method: card.id,
      setup: setupId,
      deployment,
    });
    expect({
      type: card.type,
      live: card.livemode,
      customer: objectId(card.customer),
      last4: card.card?.last4,
    }).toEqual({
      type: "card",
      live: false,
      customer: method.provider_customer_id,
      last4: "4242",
    });
    expect(Date.parse(method.accepted_at)).toBeLessThanOrEqual(Date.now());
    expect(Date.parse(method.verified_at)).toBeLessThanOrEqual(Date.now());
    return method;
  };
  const customerMethod = (customerId: string) => {
    if (customerId === checkpoint?.customerId) return checkpoint.method;
    if (customerId === checkpoint?.early.customerId)
      return checkpoint.early.method;
    throw new Error(
      "Provider evidence is outside the two fixed customer scenarios.",
    );
  };
  const snapshot = async (
    invoiceId: string,
    customerId: string,
  ): Promise<ProviderSnapshot> => {
    const local = await detail(invoiceId);
    const { rows } = await pool.query<{
      provider_invoice_id: string;
      provider_customer_id: string;
      billing_customer_id: string;
      provider_account_id: string;
    }>(
      `select i.provider_invoice_id, b.provider_customer_id, i.billing_customer_id, b.provider_account_id
      from invoices i join billing_customers b on b.id=i.billing_customer_id and b.deployment_key=i.deployment_key
      where i.id=$1 and i.deployment_key=$2 and b.customer_id=$3`,
      [invoiceId, deployment, customerId],
    );
    expect(rows).toHaveLength(1);
    const owned = rows[0]!;
    expect(owned.provider_account_id).toBe(
      customerMethod(customerId).provider_account_id,
    );
    expect(owned.provider_customer_id).toBe(
      customerMethod(customerId).provider_customer_id,
    );
    const invoice = await stripe.invoices.retrieve(owned.provider_invoice_id, {
      expand: ["amount_paid_off_stripe"],
    });
    expect(invoice).toMatchObject({
      livemode: false,
      customer: owned.provider_customer_id,
      currency: "usd",
      collection_method: "send_invoice",
      auto_advance: false,
      total: local.totalMinor,
      metadata: {
        datapad_invoice: invoiceId,
        datapad_customer: owned.billing_customer_id,
        datapad_deployment: deployment,
      },
    });
    expect(invoice.due_date).toBe(Date.parse(plan.dueEndAt) / 1000);
    expect(Number.isSafeInteger(invoice.amount_paid_off_stripe)).toBe(true);
    const allocations: ProviderSnapshot["allocations"] = [];
    for await (const payment of stripe.invoicePayments.list({
      invoice: invoice.id,
      limit: 100,
    })) {
      expect(allocations.length).toBeLessThan(1000);
      expect(payment.invoice).toBe(invoice.id);
      expect(payment.livemode).toBe(false);
      const piId = objectId(payment.payment.payment_intent ?? null);
      const pi = piId ? await stripe.paymentIntents.retrieve(piId) : null;
      if (pi)
        expect({
          live: pi.livemode,
          customer: objectId(pi.customer),
          currency: pi.currency,
        }).toEqual({
          live: false,
          customer: owned.provider_customer_id,
          currency: "usd",
        });
      allocations.push({
        id: payment.id,
        status: payment.status,
        paid: payment.amount_paid,
        intentId: piId,
        intentStatus: pi?.status ?? null,
        received: pi?.amount_received ?? 0,
        methodId: pi ? objectId(pi.payment_method) : null,
      });
    }
    allocations.sort((a, b) => a.id.localeCompare(b.id));
    const reread = await stripe.invoices.retrieve(invoice.id, {
      expand: ["amount_paid_off_stripe"],
    });
    expect([
      reread.status,
      reread.amount_remaining,
      reread.amount_paid,
      reread.amount_paid_off_stripe,
      reread.amount_overpaid,
    ]).toEqual([
      invoice.status,
      invoice.amount_remaining,
      invoice.amount_paid,
      invoice.amount_paid_off_stripe,
      invoice.amount_overpaid,
    ]);
    const matches: string[] = [];
    for await (const candidate of stripe.invoices.list({
      customer: owned.provider_customer_id,
      limit: 100,
    })) {
      if (
        candidate.metadata?.datapad_invoice === invoiceId &&
        candidate.metadata.datapad_deployment === deployment
      )
        matches.push(candidate.id);
    }
    expect(matches).toEqual([invoice.id]);
    return {
      id: invoice.id,
      customer: owned.provider_customer_id,
      total: invoice.total,
      remaining: invoice.amount_remaining,
      paid: invoice.amount_paid,
      offStripe: invoice.amount_paid_off_stripe!,
      overpaid: invoice.amount_overpaid,
      status: invoice.status,
      allocations,
    };
  };
  const charges = async (
    customerId = checkpoint!.customerId,
  ): Promise<ChargeSnapshot> => {
    const result: ChargeSnapshot = [];
    for await (const charge of stripe.charges.list({
      customer: customerMethod(customerId).provider_customer_id,
      limit: 100,
    })) {
      expect(result.length).toBeLessThan(1000);
      expect(charge.livemode).toBe(false);
      result.push({
        id: charge.id,
        amount: charge.amount,
        paid: charge.paid,
        intentId: objectId(charge.payment_intent),
      });
    }
    return result.sort((a, b) => a.id.localeCompare(b.id));
  };
  const attempts = async (invoiceId: string) =>
    (
      await pool.query<Attempt>(
        `select id, invoice_id, group_id, enrollment_id, payment_method_id, state, reason, currency,
      remaining_minor, idempotency_key, request_digest, request, first_attempted_at::text,
      last_dispatched_at::text, response_at::text, response_kind, dispatch_count,
      attributed_invoice_payment_id, attributed_payment_intent_id, baseline_paid_minor,
      baseline_paid_off_stripe_minor, baseline_overpaid_minor, charge_at::text, due_end_at::text
      from billing_payment_attempts where invoice_id=$1 and deployment_key=$2`,
        [invoiceId, deployment],
      )
    ).rows;
  const collectAgain = async (invoiceId: string) => {
    assertCollectionsWindow(plan, mode);
    const id = randomUUID();
    await writeCollectionsPrivateJson(
      join(directory, "collections-command.json"),
      { id, operation: "collect", invoiceId },
    );
    let reply:
      | { id: string; processToken: string; outcome: string }
      | undefined;
    await expect
      .poll(
        async () => {
          try {
            reply = (await readCollectionsPrivateJson(
              join(directory, "collections-command-result.json"),
            )) as typeof reply;
            return reply?.id === id;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            return false;
          }
        },
        { timeout: 30000, intervals: [200, 500, 1000] },
      )
      .toBe(true);
    expect(reply).toMatchObject({
      id,
      processToken: processInfo.token,
      outcome: "complete",
    });
  };
  const invoiceUI = async (invoiceId: string, name: string) => {
    await page.goto(`/invoices?invoiceId=${invoiceId}&offset=0`);
    await expect(
      page.getByRole("heading", { name: "Invoices", exact: true }),
    ).toBeVisible();
    const invoice = await detail(invoiceId);
    expect(invoice.collection.disposition).toEqual({
      kind: "suppress",
      reason: "paid",
    });
    await expect(page.getByText("Paid", { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: /^Pay invoice/ })).toHaveCount(
      0,
    );
    await expect(
      page.getByRole("button", { name: "Pay invoice", exact: true }),
    ).toHaveCount(0);
    const wire = JSON.stringify(invoice.collection);
    expect(wire).not.toMatch(
      /(?:in|cus|pm|pi|cs|seti)_[A-Za-z0-9]+|idempotency|providerPayment|actorId|sessionId|datapad:/,
    );
    await layouts(name);
  };
  const saveHostedCard = async (customerId: string, email: string) => {
    const api = `/api/customers/${customerId}`;
    const settings = await get<PaymentSettingsResponse>(
      `${api}/payment-settings`,
    );
    expect(settings.methods).toEqual([]);
    expect(settings.setupAvailable).toBe(true);
    stage = "actual Checkout card input and Save";
    let captured: PaymentSetupResponse | undefined;
    let captureFailed = false;
    const setupRoute = `${origin}${api}/payment-setups`;
    await page.route(setupRoute, async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      try {
        const response = await route.fetch({ timeout: 45000 });
        expect(response.status()).toBe(200);
        captured = await response.json();
        await route.fulfill({ response });
      } catch {
        captureFailed = true;
        await route.abort();
      }
    });
    const saveForm = page.locator(".payment-save");
    await expect(
      saveForm.getByRole("button", {
        name: "Save card with Stripe",
        exact: true,
      }),
    ).toBeDisabled();
    await saveForm
      .getByRole("checkbox", { name: SAVE_TERMS_TEXT, exact: true })
      .check();
    await saveForm
      .getByRole("button", { name: "Save card with Stripe", exact: true })
      .click({ noWaitAfter: true });
    await expect
      .poll(
        () => {
          if (captureFailed) throw new Error("Setup request failed.");
          return Boolean(captured);
        },
        { timeout: 45000 },
      )
      .toBe(true);
    await page.unroute(setupRoute);
    const setupId = captured!.setupId;
    await page.waitForURL(
      (url) => url.origin === "https://checkout.stripe.com",
      { timeout: 30000 },
    );
    await (
      await hostedField(
        'input[autocomplete="cc-number"], input[name="cardNumber"]',
      )
    ).fill("4242".repeat(4));
    await (
      await hostedField(
        'input[autocomplete="cc-exp"], input[name="cardExpiry"]',
      )
    ).fill(`12${String(new Date().getUTCFullYear() + 3).slice(-2)}`);
    await (
      await hostedField('input[autocomplete="cc-csc"], input[name="cardCvc"]')
    ).fill("123");
    for (const frame of page.frames()) {
      for (const [selector, value] of [
        ['input[type="email"]', email],
        [
          'input[autocomplete="cc-name"], input[name="billingName"]',
          "Sample Customer Administrator",
        ],
        [
          'input[autocomplete="postal-code"], input[name="billingPostalCode"]',
          "94107",
        ],
      ]) {
        const field = frame.locator(selector!).first();
        if (await field.isVisible()) await field.fill(value!);
      }
      const country = frame
        .locator(
          'select[name="billingCountry"], select[autocomplete="country"]',
        )
        .first();
      if (await country.isVisible()) await country.selectOption("US");
      const link = frame.getByRole("checkbox", {
        name: /Save my information for faster checkout/i,
      });
      if (await link.isVisible()) {
        await link.uncheck();
        await expect(link).not.toBeChecked();
      }
    }
    expect(await challenge(page)).toBe(false);
    await page
      .getByRole("button", {
        name: /^(?:Save(?: card| payment (?:method|details))?|Set up)$/i,
      })
      .click({ noWaitAfter: true });
    await page.waitForURL(
      (url) =>
        url.origin === origin &&
        url.pathname === `/customers/${customerId}/payment-settings` &&
        url.searchParams.get("setupId") === setupId,
      { timeout: 45000 },
    );
    await expect(
      page.getByRole("region", {
        name: "Card setup result",
        exact: true,
      }),
    ).toContainText(
      "Card verified. Choose the agreements below to authorize automatic payments.",
      { timeout: 60000 },
    );
    (evidence.hostedSetups as unknown[]).push({
      customerId,
      setupId,
      cardInputAndSave: true,
      linkUnchecked: true,
      challengeBypass: false,
    });
    return methodFor(customerId, setupId);
  };
  const authorizeCustomer = async (
    customerId: string,
    email: string,
    subscriptions: Subscription[],
    name: string,
  ): Promise<CustomerCheckpoint> => {
    await signOut();
    await signIn(page, email);
    const actor = await get<AccessSessionResponse>("/api/access/session");
    expect(actor.staffRoles).toEqual([]);
    expect(actor.synthetic).toBe(true);
    const api = `/api/customers/${customerId}`;
    const settings = () =>
      get<PaymentSettingsResponse>(`${api}/payment-settings`);
    await page.goto(`/customers/${customerId}/payment-settings`);
    expect((await settings()).canManage).toBe(true);
    const method = await saveHostedCard(customerId, email);
    const saved = await settings();
    expect(saved.methods.find((card) => card.id === method.id)).toMatchObject({
      last4: "4242",
      usable: true,
    });
    stage = "real administrator explicitly authorizes future selected terms";
    const form = page.getByRole("form", {
      name: "Authorize automatic payments",
      exact: true,
    });
    const button = form.getByRole("button", {
      name: "Confirm automatic payments",
      exact: true,
    });
    await expect(button).toBeDisabled();
    await form
      .getByRole("combobox", {
        name: "Card for automatic payments",
        exact: true,
      })
      .selectOption(method.id);
    for (const subscription of subscriptions) {
      const agreement = form.locator(".payment-agreement").filter({
        has: page.locator(
          `a[href^="/customers/${customerId}/subscriptions/${subscription.id}"]`,
        ),
      });
      await agreement
        .getByRole("combobox", {
          name: "Effective service period",
          exact: true,
        })
        .selectOption("0");
    }
    const confirmation = form.locator(".payment-confirmation");
    for (const subscription of subscriptions) {
      await expect(confirmation).toContainText(subscription.label);
      await expect(confirmation).toContainText(
        new Intl.NumberFormat("en-US", {
          style: "currency",
          currency: "USD",
        }).format(subscription.amountMinor / 100),
      );
    }
    await expect(confirmation).toContainText("Monthly");
    await expect(button).toBeDisabled();
    await form
      .getByRole("checkbox", { name: ENROLLMENT_TERMS_TEXT, exact: true })
      .check();
    await layouts(`${name}-consent`);
    const consentStart = Date.now();
    const responsePromise = posted(`${api}/automatic-payment-enrollment`);
    await button.click();
    const response = await responsePromise;
    expect(response.status()).toBe(200);
    const authorized: ChangeEnrollmentResponse = await response.json();
    expect(authorized.enrollment.paymentMethodId).toBe(method.id);
    expect(
      authorized.enrollment.scopes.map((scope) => scope.subscriptionId).sort(),
    ).toEqual(subscriptions.map((sub) => sub.id).sort());
    for (const scope of authorized.enrollment.scopes)
      expect(scope).toMatchObject({
        fromPeriodIndex: 0,
        periodStart: plan.serviceStart,
        dueDate: plan.dueDate,
        calendar: { timeZone: plan.timeZone, issueHour: 9, chargeHour: 9 },
      });
    expect(Date.parse(authorized.enrollment.acceptedAt)).toBeGreaterThanOrEqual(
      consentStart,
    );
    expect(Date.parse(authorized.enrollment.acceptedAt)).toBeLessThanOrEqual(
      Date.now(),
    );
    const { rows: provenance } = await pool.query<{ valid: boolean }>(
      `select (e.actor_user_id=$4 and e.actor_session_id=a.id and e.terms_version=$5 and e.terms_digest<>''
            and m.role in ('admin','owner') and m.user_id=e.actor_user_id and m.organization_id=c.organization_id
            and a.user_id=e.actor_user_id) as valid from billing_enrollments e
            join customers c on c.id=e.customer_id join member m on m.id=e.consenting_membership_id
            join session a on a.id=e.actor_session_id where e.id=$1 and e.customer_id=$2 and e.deployment_key=$3`,
      [
        authorized.enrollment.id,
        customerId,
        deployment,
        actor.user!.id,
        saved.enrollmentTerms.version,
      ],
    );
    expect(provenance).toEqual([{ valid: true }]);

    return {
      customerId,
      email,
      subscriptions,
      method,
      enrollmentId: authorized.enrollment.id,
      consentAcceptedAt: authorized.enrollment.acceptedAt,
    };
  };
  const assertCurrentAuthorization = async (customer: CustomerCheckpoint) => {
    const settings = await get<PaymentSettingsResponse>(
      `/api/customers/${customer.customerId}/payment-settings`,
    );
    expect(settings.enrollment).toMatchObject({
      id: customer.enrollmentId,
      paymentMethodId: customer.method.id,
    });
    expect(Date.parse(settings.enrollment!.acceptedAt)).toBe(
      Date.parse(customer.consentAcceptedAt),
    );
    expect(
      settings.enrollment!.scopes.map((scope) => scope.subscriptionId).sort(),
    ).toEqual(customer.subscriptions.map((sub) => sub.id).sort());
    expect(
      settings.methods.find((method) => method.id === customer.method.id),
    ).toMatchObject({ last4: "4242", usable: true });
  };
  const createAgreements = async (
    customerId: string,
    fixtures: Array<{ requestId: string; label: string; amountMinor: number }>,
  ) => {
    const api = `/api/customers/${customerId}`;
    const settings = await get<PaymentSettingsResponse>(
      `${api}/payment-settings`,
    );
    expect(settings.enrollment?.scopes ?? []).toEqual([]);
    const options = await get<SubscriptionOptionsResponse>(
      `${api}/subscription-options`,
    );
    expect(options.calendar).toEqual({
      timeZone: plan.timeZone,
      issueHour: 9,
      chargeHour: 9,
    });
    const existing = await get<SubscriptionsResponse>(
      `${api}/subscriptions?limit=100&offset=0`,
    );
    expect(existing.total).toBe(existing.subscriptions.length);
    expect(existing.total).toBeLessThanOrEqual(100 - fixtures.length);
    const subscriptions: Subscription[] = [];
    for (const { requestId, label, amountMinor } of fixtures) {
      const choices = options.choices.filter(
        (choice) =>
          choice.label === label &&
          choice.amountMinor === amountMinor &&
          choice.intervalMonths === 1 &&
          choice.paymentArrangement === "automatic",
      );
      expect(choices).toHaveLength(1);
      const created = await post<CreateSubscriptionResponse>(
        `${api}/subscriptions`,
        {
          ...choices[0]!,
          requestId,
          periodAnchorDate: plan.serviceStart,
          dueAnchorDate: plan.dueDate,
          firstUnbilledPeriodIndex: 0,
        },
      );
      expect(created.subscription).toMatchObject({
        label,
        amountMinor,
        periodAnchorDate: plan.serviceStart,
        dueAnchorDate: plan.dueDate,
        paymentArrangement: "automatic",
      });
      subscriptions.push(created.subscription);
    }
    const schedule = await get<ScheduleResponse>(`${api}/billing-schedule`);
    expect(schedule.schedule.issuancePaused).toBe(false);
    const absent = subscriptions.filter(
      (sub) =>
        !schedule.schedule.activations.some((a) => a.subscriptionId === sub.id),
    );
    if (absent.length)
      await post(`${api}/billing-schedule`, {
        requestId: randomUUID(),
        expectedVersion: schedule.schedule.version,
        change: {
          kind: "activate",
          subscriptions: absent.map((sub) => ({
            subscriptionId: sub.id,
            expectedVersion: sub.version,
            activationFromPeriodIndex: 0,
          })),
        },
      });
    return subscriptions;
  };
  const issuedAutomatic = async (
    customer: CustomerCheckpoint,
    totalMinor: number,
    allowPaid = false,
  ) => {
    const groups = () =>
      get<ScheduledGroupsResponse>(
        `/api/customers/${customer.customerId}/scheduled-groups?fromDueDate=${plan.dueDate}&throughDueDate=${plan.dueDate}&limit=100&offset=0`,
      );
    await expect
      .poll(
        async () =>
          (await groups()).groups.filter(
            (group) =>
              group.kind === "sealed" &&
              (group.invoice?.state === "open" ||
                (allowPaid && group.invoice?.state === "paid")),
          ).length,
        { timeout: 60000, intervals: [500, 1000, 2000] },
      )
      .toBe(1);
    const response = await groups();
    expect(response.groups).toHaveLength(1);
    const group = response.groups[0]!;
    expect(group).toMatchObject({
      paymentArrangement: "automatic",
      totalMinor,
      outcome: "invoice_requested",
      dueDate: plan.dueDate,
    });
    expect(group.periods.map((period) => period.subscriptionId).sort()).toEqual(
      customer.subscriptions.map((sub) => sub.id).sort(),
    );
    for (const period of group.periods)
      expect(period).toMatchObject({
        periodStart: plan.serviceStart,
        dueDate: plan.dueDate,
      });
    expect(Date.parse(group.sealedAt!)).toBeGreaterThanOrEqual(
      Date.parse(customer.consentAcceptedAt),
    );
    const { rows: frozen } = await pool.query<{
      enrollment_id: string;
      payment_method_id: string;
    }>(
      "select enrollment_id, payment_method_id from billing_invoice_groups where id=$1 and deployment_key=$2",
      [group.id, deployment],
    );
    expect(frozen).toEqual([
      {
        enrollment_id: customer.enrollmentId,
        payment_method_id: customer.method.id,
      },
    ]);
    const invoiceId = group.invoice!.id;
    // Issuance verifies invoice ownership; the explicit staff check retrieves
    // complete payment evidence before asserting collection availability.
    const invoice = (
      await post<InvoiceResponse>(
        `/api/customers/${customer.customerId}/invoices/${invoiceId}/check`,
        {},
      )
    ).invoice;
    expect(invoice.dueDate).toBe(plan.dueDate);
    expect(invoice.calendar).toEqual({
      timeZone: plan.timeZone,
      issueHour: 9,
      chargeHour: 9,
    });
    expect(invoice.collection).toMatchObject({
      attempt: null,
    });
    expect(Date.parse(invoice.collection.chargeAt!)).toBe(
      Date.parse(plan.chargeAt),
    );
    expect([
      "before_charge",
      "stale",
      ...(allowPaid ? ["paid"] : []),
    ]).toContain(invoice.collection.disposition.reason);
    const { rows: effects } = await pool.query<{
      create_at: string;
      finalize_at: string;
    }>(
      "select create_attempted_at::text as create_at, finalize_attempted_at::text as finalize_at from invoices where id=$1 and deployment_key=$2",
      [invoiceId, deployment],
    );
    expect(effects).toHaveLength(1);
    for (const at of [effects[0]!.create_at, effects[0]!.finalize_at]) {
      expect(Date.parse(at)).toBeGreaterThanOrEqual(
        Date.parse(customer.consentAcceptedAt),
      );
      expect(Date.parse(at)).toBeLessThanOrEqual(Date.now());
    }
    (evidence.issuanceEffects as unknown[]).push({
      customerId: customer.customerId,
      ...effects[0],
    });
    expect(await attempts(invoiceId)).toEqual([]);
    return invoiceId;
  };
  try {
    try {
      checkpoint = (await readCollectionsPrivateJson(statePath)) as Checkpoint;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (checkpoint) expect(checkpoint.runId).toBe(plan.runId);
    if (mode === "prepare") {
      stage = "historical activation and fixed synthetic agreements";
      evidence.issuanceEffects = [];
      if (checkpoint) {
        stage = "resume the same verified hosted setups and real consents";
        const prior = (await readCollectionsPrivateJson(
          join(directory, "collections-prepare-result.json"),
        )) as {
          runId: string;
          realStartedAt: string;
          hostedSetups?: Array<{
            customerId: string;
            setupId: string;
            cardInputAndSave: boolean;
            linkUnchecked: boolean;
            challengeBypass: boolean;
          }>;
          resumedHostedProof?: {
            hostedSetups: Array<{
              customerId: string;
              setupId: string;
              cardInputAndSave: boolean;
              linkUnchecked: boolean;
              challengeBypass: boolean;
            }>;
            originalStartedAt: string;
          };
        };
        expect(prior.runId).toBe(plan.runId);
        const hostedProof =
          prior.hostedSetups ?? prior.resumedHostedProof?.hostedSetups;
        expect(hostedProof).toHaveLength(2);
        evidence.resumedHostedProof = {
          hostedSetups: hostedProof,
          originalStartedAt:
            prior.resumedHostedProof?.originalStartedAt ?? prior.realStartedAt,
        };
        await signIn(page, "staff@example.test");
        for (const customer of [checkpoint, checkpoint.early]) {
          expect(hostedProof).toContainEqual({
            customerId: customer.customerId,
            setupId: customer.method.setup_id,
            cardInputAndSave: true,
            linkUnchecked: true,
            challengeBypass: false,
          });
          const method = await methodFor(
            customer.customerId,
            customer.method.setup_id,
          );
          expect(method).toMatchObject({
            id: customer.method.id,
            provider_payment_method_id:
              customer.method.provider_payment_method_id,
            provider_customer_id: customer.method.provider_customer_id,
            provider_account_id: customer.method.provider_account_id,
          });
          await assertCurrentAuthorization(customer);
        }
        evidence.resume = {
          sameRunId: true,
          existingVerifiedCards: 2,
          existingConsents: 2,
          hostedSetupRepeated: false,
          consentRepeated: false,
          invoiceIssuanceRepeated: false,
        };
      } else {
        await signIn(page, "staff@example.test");
        expect(await readCollectionsPrivateJson(clock)).toBe(
          plan.historicalClock,
        );
        await page.getByRole("link", { name: /^Elm Studio/ }).click();
        const elmId = new URL(page.url()).pathname.split("/").at(-1)!;
        await page.goto("/customers");
        await page.getByRole("link", { name: /^Birch Works/ }).click();
        const birchId = new URL(page.url()).pathname.split("/").at(-1)!;
        expect(birchId).not.toBe(elmId);
        const elmSubscriptions = await createAgreements(elmId, [
          {
            requestId: plan.requests.hosting,
            label: "Web hosting",
            amountMinor: 2300,
          },
          {
            requestId: plan.requests.storage,
            label: "Storage add-on",
            amountMinor: 500,
          },
        ]);
        const birchSubscriptions = await createAgreements(birchId, [
          {
            requestId: plan.requests.early,
            label: "Consulting",
            amountMinor: 10000,
          },
        ]);
        evidence.hostedSetups = [];
        evidence.issuanceEffects = [];
        const elm = await authorizeCustomer(
          elmId,
          "elm-admin@example.test",
          elmSubscriptions,
          "elm",
        );
        const birch = await authorizeCustomer(
          birchId,
          "birch-admin@example.test",
          birchSubscriptions,
          "birch",
        );
        expect(elm.method.provider_customer_id).not.toBe(
          birch.method.provider_customer_id,
        );
        expect(elm.method.provider_payment_method_id).not.toBe(
          birch.method.provider_payment_method_id,
        );
        expect(elm.method.provider_account_id).toBe(
          birch.method.provider_account_id,
        );
        checkpoint = { runId: plan.runId, ...elm, early: birch };
        await save();
        stage =
          "calendar advances after both real consents, real automatic issuance";
        assertCollectionsWindow(plan, "prepare");
        const sealClock = new Date().toISOString();
        for (const customer of [elm, birch])
          expect(Date.parse(sealClock)).toBeGreaterThanOrEqual(
            Date.parse(customer.consentAcceptedAt),
          );
        await writeCollectionsPrivateJson(clock, sealClock);
        // Customer reads stay scoped; staff inspects both owned automatic groups.
        await signOut();
        await signIn(page, "staff@example.test");
      }
      if (!checkpoint)
        throw new Error("Missing durable customer consent checkpoint.");
      stage = "read-only recovery of the exact sealed automatic invoices";
      const automaticId = await issuedAutomatic(checkpoint, 2800);
      const earlyId = await issuedAutomatic(checkpoint.early, 10000, true);
      if (checkpoint.automaticInvoiceId)
        expect(automaticId).toBe(checkpoint.automaticInvoiceId);
      if (checkpoint.earlyInvoiceId)
        expect(earlyId).toBe(checkpoint.earlyInvoiceId);
      checkpoint.automaticInvoiceId = automaticId;
      checkpoint.earlyInvoiceId = earlyId;
      await save();
      const before = await snapshot(automaticId, checkpoint.customerId);
      expect(before).toMatchObject({
        status: "open",
        remaining: 2800,
        paid: 0,
        offStripe: 0,
        overpaid: 0,
      });
      if (checkpoint.beforeCollection)
        expect(before).toEqual(checkpoint.beforeCollection);
      checkpoint.beforeCollection = before;
      expect(await charges()).toEqual([]);
      const earlyBefore = await snapshot(earlyId, checkpoint.early.customerId);
      expect(await attempts(earlyId)).toEqual([]);
      if (earlyBefore.status === "open") {
        stage = "unfinished direct SDK early payment of the same Birch invoice";
        expect(earlyBefore).toMatchObject({
          remaining: 10000,
          paid: 0,
          offStripe: 0,
          overpaid: 0,
        });
        expect(await charges(checkpoint.early.customerId)).toEqual([]);
        if (checkpoint.earlyPaymentAttemptedAt)
          throw new Error(
            "An earlier early-payment call has an uncertain open outcome; retrieval/operator review is required, never another charge.",
          );
        assertCollectionsWindow(plan, "prepare");
        checkpoint.earlyPaymentAttemptedAt = new Date().toISOString();
        await save();
        // One explicit unfinished early payment. Recover a paid receipt by
        // retrieval; never replay an uncertain call or change its fixed key.
        await stripe.invoices.pay(
          earlyBefore.id,
          {
            payment_method: checkpoint.early.method.provider_payment_method_id,
          },
          {
            idempotencyKey: `datapad:${deployment}:acceptance:${plan.runId}:early`,
          },
        );
        await expect
          .poll(async () => (await detail(earlyId)).state, {
            timeout: 60000,
            intervals: [500, 1000, 2000],
          })
          .toBe("paid");
      } else {
        expect(earlyBefore.status).toBe("paid");
        expect(checkpoint.earlyPaymentAttemptedAt).toBeTruthy();
        evidence.earlyPaymentRecoveredByRetrieval = true;
      }
      checkpoint.earlyPaid = await snapshot(
        earlyId,
        checkpoint.early.customerId,
      );
      expect(checkpoint.earlyPaid).toMatchObject({
        id: earlyBefore.id,
        status: "paid",
        remaining: 0,
        paid: 10000,
        offStripe: 0,
        overpaid: 0,
      });
      expect(
        checkpoint.earlyPaid.allocations.filter(
          (payment) => payment.status === "paid",
        ),
      ).toEqual([
        expect.objectContaining({
          paid: 10000,
          intentStatus: "succeeded",
          methodId: checkpoint.early.method.provider_payment_method_id,
        }),
      ]);
      expect(await attempts(earlyId)).toEqual([]);
      checkpoint.beforeCharges = await charges();
      expect(checkpoint.beforeCharges).toEqual([]);
      const earlyCharges = await charges(checkpoint.early.customerId);
      expect(earlyCharges).toEqual([
        {
          id: expect.any(String),
          amount: 10000,
          paid: true,
          intentId: checkpoint.earlyPaid.allocations.find(
            (payment) => payment.status === "paid",
          )!.intentId,
        },
      ]);
      if (checkpoint.earlyCharges)
        expect(earlyCharges).toEqual(checkpoint.earlyCharges);
      checkpoint.earlyCharges = earlyCharges;
      await save();
      evidence.prepared = {
        verifiedHostedSetups: 2,
        realConsents: 2,
        automaticGroups: 2,
        elmSelectedScopes: 2,
        birchSelectedScopes: 1,
        frozenPermissions: true,
        dueToday: true,
        serviceStartsTomorrow: true,
        noScheduledAttemptBeforeRealWindow: true,
        earlyPaymentProof:
          "direct SDK on the same Birch automatic invoice using its owned saved card",
      };
      stage = "prepared staff/customer desktop and narrow screens";
      if (
        !checkpoint?.automaticInvoiceId ||
        !checkpoint.earlyInvoiceId ||
        !checkpoint.beforeCharges
      )
        throw new Error(
          "Prepared evidence is incomplete; recover the recorded scenario before continuing.",
        );
      const session = await get<AccessSessionResponse>("/api/access/session");
      if (!session.staffRoles.includes("billing")) {
        await signOut();
        await signIn(page, "staff@example.test");
      }
      await invoiceUI(checkpoint.earlyInvoiceId, "staff-early-paid");
      await page.goto(
        `/invoices?invoiceId=${checkpoint.automaticInvoiceId}&offset=0`,
      );
      await expect(
        page.getByRole("button", { name: "Pay invoice", exact: true }),
      ).toBeVisible();
      await layouts("staff-before-charge");
      await signOut();
      await signIn(page, "elm-admin@example.test");
      await page.goto(
        `/invoices?invoiceId=${checkpoint.automaticInvoiceId}&offset=0`,
      );
      await expect(
        page.getByRole("button", { name: "Pay invoice", exact: true }),
      ).toBeVisible();
      await layouts("customer-before-charge");
      await signOut();
      await signIn(page, checkpoint.early.email);
      await invoiceUI(checkpoint.earlyInvoiceId, "birch-early-paid");
      evidence.preparedLayouts = { staff: [1280, 390], customer: [1280, 390] };
    } else {
      await signIn(page, "staff@example.test");
      stage = "real-wall collection guard and durable prepared state";
      if (
        !checkpoint?.automaticInvoiceId ||
        !checkpoint.earlyInvoiceId ||
        !checkpoint.beforeCollection ||
        !checkpoint.earlyPaid ||
        !checkpoint.beforeCharges ||
        !checkpoint.earlyCharges ||
        !checkpoint.enrollmentId ||
        !checkpoint.consentAcceptedAt
      )
        throw new Error("Complete prepare before collection.");
      await methodFor(checkpoint.customerId, checkpoint.method.setup_id);
      await methodFor(
        checkpoint.early.customerId,
        checkpoint.early.method.setup_id,
      );
      await assertCurrentAuthorization(checkpoint);
      await assertCurrentAuthorization(checkpoint.early);
      assertCollectionsWindow(plan, mode);
      if (mode === "collect") {
        if (checkpoint.collected)
          throw new Error(
            "Collection already recorded; use verify-restart after root's owned restart.",
          );
        const chargeBaseline = checkpoint.beforeCharges;
        const existingAttempt = await attempts(checkpoint.automaticInvoiceId);
        expect(existingAttempt.length).toBeLessThanOrEqual(1);
        if (!existingAttempt.length) {
          expect(
            await snapshot(
              checkpoint.automaticInvoiceId,
              checkpoint.customerId,
            ),
          ).toEqual(checkpoint.beforeCollection);
          expect(await charges()).toEqual(chargeBaseline);
        }
        await writeCollectionsPrivateJson(clock, "real");
        stage = "actual full-amount off-session collection via existing worker";
        await expect
          .poll(
            async () =>
              (await attempts(checkpoint!.automaticInvoiceId!))[0]?.state,
            { timeout: 60000, intervals: [500, 1000, 2000] },
          )
          .toBe("succeeded");
        const rows = await attempts(checkpoint.automaticInvoiceId);
        expect(rows).toHaveLength(1);
        const attempt = rows[0]!;
        expect(attempt).toMatchObject({
          invoice_id: checkpoint.automaticInvoiceId,
          enrollment_id: checkpoint.enrollmentId,
          payment_method_id: checkpoint.method.id,
          currency: "USD",
          state: "succeeded",
          reason: null,
          remaining_minor: 2800,
          dispatch_count: 1,
          response_kind: "response",
          baseline_paid_minor: 0,
          baseline_paid_off_stripe_minor: 0,
          baseline_overpaid_minor: 0,
        });
        expect(Date.parse(attempt.first_attempted_at)).toBeGreaterThanOrEqual(
          Date.parse(plan.chargeAt),
        );
        expect(Date.parse(attempt.first_attempted_at)).toBeGreaterThanOrEqual(
          Date.parse(checkpoint.consentAcceptedAt),
        );
        expect(Date.parse(attempt.first_attempted_at)).toBeLessThan(
          Date.parse(plan.dueEndAt),
        );
        expect(Date.parse(attempt.response_at!)).toBeGreaterThanOrEqual(
          Date.parse(attempt.first_attempted_at),
        );
        expect(Date.parse(attempt.charge_at)).toBe(Date.parse(plan.chargeAt));
        expect(Date.parse(attempt.due_end_at)).toBe(Date.parse(plan.dueEndAt));
        expect(attempt.idempotency_key).toBe(
          `datapad:${deployment}:payment:${attempt.id}:pay`,
        );
        expect(attempt.request).toEqual({
          providerInvoiceId: checkpoint.beforeCollection.id,
          providerPaymentMethodId: checkpoint.method.provider_payment_method_id,
          offSession: true,
        });
        const digest = createHash("sha256")
          .update(canonicalize(attempt.request)!)
          .digest("hex");
        expect(attempt.request_digest).toBe(digest);
        const after = await snapshot(
          checkpoint.automaticInvoiceId,
          checkpoint.customerId,
        );
        expect(after).toMatchObject({
          id: checkpoint.beforeCollection.id,
          status: "paid",
          remaining: 0,
          paid: 2800,
          offStripe: 0,
          overpaid: 0,
        });
        const attribution = after.allocations.filter(
          (payment) => payment.id === attempt.attributed_invoice_payment_id,
        );
        expect(attribution).toHaveLength(1);
        expect(attribution[0]).toMatchObject({
          status: "paid",
          paid: 2800,
          intentId: attempt.attributed_payment_intent_id,
          intentStatus: "succeeded",
          received: 2800,
          methodId: checkpoint.method.provider_payment_method_id,
        });
        const allCharges = await charges();
        expect(
          allCharges.filter(
            (charge) =>
              !chargeBaseline.some((before) => before.id === charge.id),
          ),
        ).toEqual([
          {
            id: expect.any(String),
            amount: 2800,
            paid: true,
            intentId: attempt.attributed_payment_intent_id,
          },
        ]);
        const { rows: audit } = await pool.query<{
          action: string;
          details: {
            attemptId: string;
            invoiceId: string;
            dispatchCount?: number;
            enrollmentId?: string;
          };
          actor_id: string;
        }>(
          "select action, details, actor_id from access_audit where customer_id=$1 and target_id=$2 order by created_at",
          [checkpoint.customerId, attempt.id],
        );
        expect(audit.map((entry) => entry.action)).toEqual([
          "invoice.collection_attempted",
          "invoice.collection_succeeded",
        ]);
        for (const entry of audit)
          expect(entry.details).toMatchObject({
            operator: true,
            attemptId: attempt.id,
            invoiceId: checkpoint.automaticInvoiceId,
          });
        expect(audit[0]!.details).toMatchObject({
          dispatchCount: 1,
          enrollmentId: checkpoint.enrollmentId,
        });
        evidence.audit = audit;
        checkpoint.collected = {
          processToken: processInfo.token,
          attempt,
          provider: after,
          charges: allCharges,
        };
        await save();
      } else {
        stage = "owned restart identity and same durable attempt/key";
        if (!checkpoint.collected)
          throw new Error(
            "Successful collect evidence is required before restart verification.",
          );
        expect(processInfo.token).not.toBe(checkpoint.collected.processToken);
        expect(await readCollectionsPrivateJson(clock)).toBe("real");
        await collectAgain(checkpoint.automaticInvoiceId);
        expect(await attempts(checkpoint.automaticInvoiceId)).toEqual([
          checkpoint.collected.attempt,
        ]);
        expect(
          await snapshot(checkpoint.automaticInvoiceId, checkpoint.customerId),
        ).toEqual(checkpoint.collected.provider);
        expect(await charges()).toEqual(checkpoint.collected.charges);
        evidence.restart = {
          differentOwnedProcess: true,
          sameAttempt: true,
          sameKey: true,
          identicalAllocations: true,
          noDuplicateCharge: true,
        };
      }
      stage = "paid skip and staff/customer desktop and narrow screens";
      await collectAgain(checkpoint.earlyInvoiceId);
      expect(await charges(checkpoint.early.customerId)).toEqual(
        checkpoint.earlyCharges,
      );
      expect(await attempts(checkpoint.earlyInvoiceId)).toEqual([]);
      expect(
        await snapshot(checkpoint.earlyInvoiceId, checkpoint.early.customerId),
      ).toEqual(checkpoint.earlyPaid);
      await invoiceUI(checkpoint.automaticInvoiceId, "staff-collected");
      await invoiceUI(checkpoint.earlyInvoiceId, "staff-early-paid");
      await signOut();
      await signIn(page, "elm-admin@example.test");
      await invoiceUI(checkpoint.automaticInvoiceId, "customer-collected");
      await expect(
        page.getByRole("button", {
          name: /Issue invoice|Record received payment|Void invoice|Check Stripe status/,
        }),
      ).toHaveCount(0);
      await signOut();
      await signIn(page, checkpoint.early.email);
      await invoiceUI(checkpoint.earlyInvoiceId, "birch-early-paid");
      expect(await attempts(checkpoint.automaticInvoiceId)).toEqual([
        checkpoint.collected!.attempt,
      ]);
      expect(await charges()).toEqual(checkpoint.collected!.charges);
      expect(await charges(checkpoint.early.customerId)).toEqual(
        checkpoint.earlyCharges,
      );
      expect(await attempts(checkpoint.earlyInvoiceId)).toEqual([]);
      evidence.collection = checkpoint.collected;
      evidence.earlyPaidSkip = {
        invoiceId: checkpoint.earlyInvoiceId,
        paymentArrangement: "automatic",
        customerId: checkpoint.early.customerId,
        noAttempt: true,
        unchangedProviderAllocations: true,
      };
      evidence.layouts = {
        staff: [1280, 390],
        customer: [1280, 390],
        noOverflow: true,
        safeReadShape: true,
      };
    }
    await writeCollectionsPrivateJson(
      join(directory, `collections-${mode}-result.json`),
      {
        outcome: "passed",
        ...evidence,
        realCompletedAt: new Date().toISOString(),
      },
    );
  } catch (error) {
    // Assertions and SDK errors can contain provider payloads and hosted URLs.
    // Do not let Playwright's reporter print them or capture card input.
    await writeCollectionsPrivateJson(
      join(directory, `collections-${mode}-result.json`),
      {
        outcome: "failed",
        stage,
        errorClass: error instanceof Error ? error.name : "UnknownError",
        failure: (error instanceof Error ? error.message : "Non-Error failure")
          .replace(/https?:\/\/[^\s]+/g, "[URL omitted]")
          .replace(
            /\b(?:sk|rk|pk)_(?:test|live)_[\w]+/g,
            "[credential omitted]",
          )
          .replace(/\b[\w]+_secret_[\w]+/g, "[client secret omitted]")
          .replace(/\b(?:\d[ -]?){12,19}\b/g, "[card-like digits omitted]")
          .slice(0, 6000),
        ...evidence,
      },
    ).catch(() => undefined);
    throw new Error(
      `Collections acceptance failed during ${stage}. Inspect the private phase evidence; no fallback proof is claimed.`,
    );
  } finally {
    await pool.end();
  }
});
