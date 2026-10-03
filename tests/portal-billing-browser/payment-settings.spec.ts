import { randomUUID } from "node:crypto";
import { chmod, lstat, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { Temporal } from "@js-temporal/polyfill";
import { expect, test, type Locator } from "@playwright/test";
import { Pool } from "pg";
import Stripe from "stripe";
import type { AccessSessionResponse } from "../../src/access/contract";
import {
  ENROLLMENT_TERMS_TEXT,
  SAVE_TERMS_TEXT,
  type ChangeEnrollmentResponse,
  type PaymentSettingsResponse,
  type PaymentSetupResponse,
  type ReplaceEnrollmentRequest,
  type ReduceEnrollmentRequest,
  type StartPaymentSetupRequest,
} from "../../src/billing/payment-settings-contract";
import type {
  CreateSubscriptionResponse,
  SubscriptionOptionsResponse,
  SubscriptionResponse,
  SubscriptionsResponse,
} from "../../src/billing/subscriptions-contract";
import { signIn } from "../portal-browser/helpers";

test("customer administrator saves a hosted sandbox card, consents to one agreement, and stops new attempts", async ({
  page,
}) => {
  const artifacts = process.env.PORTAL_PAYMENT_SETTINGS_TEST_ARTIFACTS;
  const deployment = process.env.BILLING_DEPLOYMENT_KEY;
  if (
    !artifacts ||
    !isAbsolute(artifacts) ||
    !deployment ||
    !process.env.DATABASE_URL
  )
    throw new Error(
      "Explicit payment settings sandbox configuration is required.",
    );
  const directory = await lstat(artifacts);
  expect(directory.isDirectory() && !directory.isSymbolicLink()).toBe(true);
  expect(directory.mode & 0o777).toBe(0o700);
  expect(directory.uid).toBe(process.getuid?.());
  const fromCheckout = relative(
    await realpath(process.cwd()),
    await realpath(artifacts),
  );
  expect(
    fromCheckout === ".." ||
      fromCheckout.startsWith(`..${sep}`) ||
      isAbsolute(fromCheckout),
  ).toBe(true);

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
  const origin = new URL(process.env.TEST_BASE_URL!).origin;
  const runId = randomUUID();
  let phase = "staff sign-in and isolated prerequisites";
  let challengeObserved = false;
  let hostedProved = false;
  const evidence: Record<string, unknown> = {
    runId,
    proof: "hosted-browser",
    clock: "real",
  };
  const safeError = (error: unknown) => ({
    errorClass: error instanceof Error ? error.name : "UnknownError",
    message: stripVTControlCharacters(
      error instanceof Error ? error.message : "Non-Error failure",
    )
      .replace(/https?:\/\/[^\s]+/g, "[URL omitted]")
      .replace(/\b(?:sk|rk|pk)_(?:test|live)_[\w]+/g, "[credential omitted]")
      .replace(/\b(?:seti|pi|cs|pm|cus)_[\w]+/g, "[provider value omitted]")
      .replace(/\b(?:\d[ -]?){12,19}\b/g, "[card-like digits omitted]")
      .slice(0, 3000),
  });
  const save = async (name: string, content: string | Buffer) => {
    const path = join(artifacts, `${runId}-${name}`);
    await writeFile(path, content, { mode: 0o600, flag: "wx" });
    await chmod(path, 0o600);
  };
  const get = async <T>(path: string): Promise<T> => {
    const response = await page.request.get(path);
    expect(response.ok()).toBe(true);
    expect(response.headers()["cache-control"]).toContain("no-store");
    return response.json();
  };
  const posted = (path: string) => {
    const pending = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === path &&
        response.request().method() === "POST",
    );
    // A failed click must not leave an unhandled waiter rejection during teardown.
    void pending.catch(() => undefined);
    return pending;
  };
  const layouts = async (name: string) => {
    expect(new URL(page.url()).origin).toBe(origin);
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
      await save(
        `${name}-${width}.png`,
        await page.screenshot({ fullPage: true }),
      );
    }
    await page.setViewportSize({ width: 1280, height: 900 });
  };
  const hostedChallenge = async () => {
    for (const frame of page.frames()) {
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
    }
    return page
      .locator('iframe[title*="challenge" i], iframe[title*="captcha" i]')
      .first()
      .isVisible()
      .catch(() => false);
  };
  const hostedField = async (selector: string): Promise<Locator> => {
    let field: Locator | undefined;
    await expect
      .poll(
        async () => {
          if (await hostedChallenge()) {
            challengeObserved = true;
            throw new Error(
              "Hosted setup blocked by provider challenge; no bypass attempted.",
            );
          }
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
  const providerId = (value: string | { id: string } | null) =>
    typeof value === "string" ? value : value?.id;
  const noChargeSnapshot = async (customer: string) => {
    const charges = await stripe.charges.list({ customer, limit: 100 });
    const payments = await stripe.paymentIntents.list({ customer, limit: 100 });
    expect(charges.has_more || payments.has_more).toBe(false);
    // Keep only comparison facts. Never serialize raw SDK objects or client secrets.
    return {
      charges: charges.data
        .map((charge) => ({
          id: charge.id,
          amount: charge.amount,
          paid: charge.paid,
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),
      payments: payments.data
        .map((payment) => ({
          id: payment.id,
          amount: payment.amount,
          status: payment.status,
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    };
  };
  try {
    await signIn(page, "staff@example.test");
    const staff = await get<AccessSessionResponse>("/api/access/session");
    expect(staff.synthetic).toBe(true);
    await page.getByRole("link", { name: /^Elm Studio/ }).click();
    const customerPath = new URL(page.url()).pathname;
    const customerId = customerPath.split("/").at(-1)!;
    const api = `/api${customerPath}`;
    const settings = () =>
      get<PaymentSettingsResponse>(`${api}/payment-settings`);
    const before = await settings();
    expect(before.canManage).toBe(false);
    // A rerun may use a stopped snapshot; never replace anyone's active scope.
    expect(before.enrollment?.scopes ?? []).toEqual([]);
    const existing = await get<SubscriptionsResponse>(
      `${api}/subscriptions?limit=100&offset=0`,
    );
    expect(existing.total).toBe(existing.subscriptions.length);
    expect(existing.total).toBeLessThanOrEqual(98);
    const options = await get<SubscriptionOptionsResponse>(
      `${api}/subscription-options`,
    );
    const today = Temporal.Now.plainDateISO(options.calendar.timeZone);
    const tomorrow = today.add({ days: 1 }).toString();
    const dueDate = today.toString();
    const newAgreements: CreateSubscriptionResponse["subscription"][] = [];
    for (const [label, amountMinor] of [
      ["Web hosting", 2300],
      ["Storage add-on", 500],
    ] as const) {
      const choices = options.choices.filter(
        (choice) =>
          choice.label === label &&
          choice.amountMinor === amountMinor &&
          choice.intervalMonths === 1 &&
          choice.paymentArrangement === "manual",
      );
      expect(choices).toHaveLength(1);
      const response = await page.request.post(`${api}/subscriptions`, {
        headers: { origin },
        data: {
          ...choices[0]!,
          requestId: randomUUID(),
          periodAnchorDate: tomorrow,
          dueAnchorDate: dueDate,
          firstUnbilledPeriodIndex: 0,
        },
      });
      expect(response.ok()).toBe(true);
      const created: CreateSubscriptionResponse = await response.json();
      expect(created.outcome).toBe("created");
      expect(created.subscription).toMatchObject({
        periodAnchorDate: tomorrow,
        dueAnchorDate: dueDate,
        paymentArrangement: "manual",
        version: 1,
      });
      newAgreements.push(created.subscription);
    }
    const [selected, untouched] = newAgreements;
    if (!selected || !untouched)
      throw new Error("Expected two new synthetic agreements.");
    evidence.agreements = {
      selectedId: selected.id,
      untouchedId: untouched.id,
      serviceStart: tomorrow,
      dueDate,
      advancePayment: true,
    };

    phase = "genuine customer administrator sign-in";
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await signIn(page, "elm-admin@example.test");
    const customerSession = await get<AccessSessionResponse>(
      "/api/access/session",
    );
    expect(customerSession.synthetic).toBe(true);
    expect(customerSession.user?.id).not.toBe(staff.user?.id);
    expect(customerSession.staffRoles).toEqual([]);
    await page.goto(`${customerPath}/payment-settings`);
    // Observe platform capabilities without substituting browser APIs or request IDs.
    evidence.browserCapabilities = await page.evaluate(() => ({
      secureContext: window.isSecureContext,
      randomUUID: typeof globalThis.crypto?.randomUUID === "function",
      getRandomValues: typeof globalThis.crypto?.getRandomValues === "function",
    }));
    await expect(
      page.getByRole("heading", { name: "Payment settings", exact: true }),
    ).toBeVisible();
    const initial = await settings();
    expect(initial).toMatchObject({ canManage: true, setupAvailable: true });
    expect(initial.enrollment).toEqual(before.enrollment);
    const agreement = initial.subscriptions.find(
      (item) => item.id === selected.id,
    )!;
    const boundary = agreement.boundaries.find(
      (item) => item.fromPeriodIndex === 0,
    )!;
    expect(boundary).toMatchObject({
      periodStart: tomorrow,
      dueDate,
      amountMinor: 2300,
      paymentArrangement: "manual",
      untilPeriodIndex: null,
      untilPeriodStart: null,
    });
    const saveForm = page.locator(".payment-save");
    const saveButton = saveForm.getByRole("button", {
      name: "Save card with Stripe",
      exact: true,
    });
    await expect(saveButton).toBeDisabled();
    await saveForm
      .getByRole("checkbox", { name: SAVE_TERMS_TEXT, exact: true })
      .check();
    await expect(saveButton).toBeEnabled();
    const setupStartedAt = Date.now();
    // Capture the real server body before fulfillment allows full-page navigation.
    // This preserves the actual request, response status and payload without fabrication.
    const setupRoute = `${origin}${api}/payment-setups`;
    let capturedSetup:
      | { body: PaymentSetupResponse; input: StartPaymentSetupRequest }
      | undefined;
    let setupCaptureError: unknown;
    await page.route(setupRoute, async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      evidence.setupRequestObserved = true;
      try {
        const response = await route.fetch({ timeout: 45000 });
        evidence.setupHttpStatus = response.status();
        capturedSetup = {
          body: await response.json(),
          input: route.request().postDataJSON(),
        };
        await route.fulfill({ response });
        evidence.setupResponseFulfilled = true;
      } catch (error) {
        setupCaptureError = error;
        evidence.setupCaptureFailure = safeError(error);
        await route.abort().catch(() => undefined);
      }
    });
    phase = "UI Save card click";
    evidence.setupClickStarted = true;
    await saveButton.click({ noWaitAfter: true });
    evidence.setupClickCompleted = true;
    phase = "capture actual setup response";
    await expect
      .poll(
        async () => {
          if (setupCaptureError) throw setupCaptureError;
          const alert = saveForm.getByRole("alert");
          if (await alert.isVisible())
            throw new Error(
              `Save card UI failed: ${safeError(new Error(await alert.innerText())).message}`,
            );
          return capturedSetup !== undefined;
        },
        { timeout: 45000 },
      )
      .toBe(true);
    await page.unroute(setupRoute);
    if (!capturedSetup) throw new Error("Missing actual setup response.");
    expect(evidence.setupHttpStatus).toBe(200);
    const setup = capturedSetup.body;
    const setupRequest = capturedSetup.input;
    evidence.localSetupId = setup.setupId;
    expect(setupRequest).toMatchObject({
      saveTermsVersion: initial.saveTerms.version,
      acceptSaveTerms: true,
    });
    expect(setup).toMatchObject({ status: "pending", paymentMethodId: null });
    phase = "hosted setup-mode navigation";
    await expect(page).toHaveURL(/^https:\/\/checkout\.stripe\.com\//);
    evidence.hostedNavigationObserved = true;
    phase = "persisted setup save-permission and customer authority";
    const { rows: setups } = await pool.query<{
      provider_session_id: string;
      provider_customer_id: string;
      provider_account_id: string;
      billing_customer_id: string;
      success_url: string;
      save_permission: boolean;
      real_administrator: boolean;
    }>(
      `select s.provider_session_id, b.provider_customer_id, s.provider_account_id,
        s.billing_customer_id, s.success_url,
        (s.request_id=$4 and s.save_terms_version=$5 and s.accepted_at >= $6::timestamptz) as save_permission,
        (s.actor_user_id=$7 and m.role in ('admin','owner') and m.user_id=s.actor_user_id
          and m.organization_id=c.organization_id and a.user_id=s.actor_user_id) as real_administrator
        from billing_payment_setups s join billing_customers b on b.id=s.billing_customer_id
          and b.customer_id=s.customer_id and b.deployment_key=s.deployment_key
        join customers c on c.id=s.customer_id
        join member m on m.id=s.consenting_membership_id
        join session a on a.id=s.actor_session_id
        where s.id=$1 and s.deployment_key=$2 and s.customer_id=$3`,
      [
        setup.setupId,
        deployment,
        customerId,
        setupRequest.requestId,
        initial.saveTerms.version,
        new Date(setupStartedAt).toISOString(),
        customerSession.user!.id,
      ],
    );
    expect(setups).toHaveLength(1);
    const owned = setups[0]!;
    evidence.setupPermission = {
      savePermission: owned.save_permission,
      customerAdministrator: owned.real_administrator,
    };
    expect(owned.save_permission).toBe(true);
    expect(owned.real_administrator).toBe(true);
    expect((await stripe.accounts.retrieveCurrent()).id).toBe(
      owned.provider_account_id,
    );
    const checkout = await stripe.checkout.sessions.retrieve(
      owned.provider_session_id,
    );
    expect({
      mode: checkout.mode,
      live: checkout.livemode,
      customer: providerId(checkout.customer),
      payment: checkout.payment_intent,
      subscription: checkout.subscription,
      deployment: checkout.metadata?.datapad_deployment,
      setup: checkout.metadata?.datapad_setup,
      mapping: checkout.metadata?.datapad_customer,
    }).toEqual({
      mode: "setup",
      live: false,
      customer: owned.provider_customer_id,
      payment: null,
      subscription: null,
      deployment,
      setup: setup.setupId,
      mapping: owned.billing_customer_id,
    });
    const chargesBefore = await noChargeSnapshot(owned.provider_customer_id);
    evidence.savePermissionRecorded = true;

    phase = "actual hosted Stripe test-card submission";
    // Standard UI input only. A CAPTCHA or bot challenge terminates this proof.
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
      const email = frame.locator('input[type="email"]').first();
      if (await email.isVisible()) await email.fill("elm-admin@example.test");
      const name = frame
        .locator('input[autocomplete="cc-name"], input[name="billingName"]')
        .first();
      if (await name.isVisible())
        await name.fill("Sample Customer Administrator");
      const country = frame
        .locator(
          'select[name="billingCountry"], select[autocomplete="country"]',
        )
        .first();
      if (await country.isVisible()) await country.selectOption("US");
      const postal = frame
        .locator(
          'input[autocomplete="postal-code"], input[name="billingPostalCode"]',
        )
        .first();
      if (await postal.isVisible()) await postal.fill("94107");
    }
    // Link enrollment is separate from saving this card for the owned customer.
    const linkOptIn = page.getByRole("checkbox", {
      name: /Save my information for faster checkout/i,
    });
    if (await linkOptIn.isVisible()) await linkOptIn.uncheck();
    evidence.hostedCardFieldsFilled = true;
    challengeObserved = await hostedChallenge();
    expect(challengeObserved).toBe(false);
    const returnRefresh = posted(
      `${api}/payment-setups/${setup.setupId}/refresh`,
    );
    await page
      .getByRole("button", {
        name: /^(?:Save(?: card| payment (?:method|details))?|Set up)$/i,
      })
      .click({ noWaitAfter: true });
    // The fixed return route immediately redirects to the customer's settings.
    const returnUrl = new URL(owned.success_url);
    expect(returnUrl.origin).toBe(origin);
    expect(returnUrl.searchParams.get("customerId")).toBe(customerId);
    expect(returnUrl.searchParams.get("setupId")).toBe(setup.setupId);
    await page.waitForURL(
      (url) =>
        url.origin === origin &&
        url.pathname === `${customerPath}/payment-settings` &&
        url.searchParams.get("setupId") === setup.setupId,
      { timeout: 45000 },
    );
    expect((await returnRefresh).status()).toBe(200);
    phase = "verified return and independent provider retrieval";
    await expect(
      page.getByRole("region", { name: "Card setup result", exact: true }),
    ).toContainText(
      "Card verified. Choose the agreements below to authorize automatic payments.",
      { timeout: 65000 },
    );
    const verified = await settings();
    expect(verified.enrollment).toEqual(initial.enrollment);
    const { rows: methods } = await pool.query<{
      id: string;
      provider_payment_method_id: string;
      provider_setup_intent_id: string;
    }>(
      `select m.id, m.provider_payment_method_id, s.provider_setup_intent_id
        from billing_payment_methods m join billing_payment_setups s on s.id=m.setup_id
        where s.id=$1 and s.customer_id=$2 and s.deployment_key=$3 and s.status='verified'
          and m.customer_id=s.customer_id and m.deployment_key=s.deployment_key
          and m.provider_account_id=s.provider_account_id`,
      [setup.setupId, customerId, deployment],
    );
    expect(methods).toHaveLength(1);
    const method = methods[0]!;
    const completed = await stripe.checkout.sessions.retrieve(
      owned.provider_session_id,
    );
    const intent = await stripe.setupIntents.retrieve(
      method.provider_setup_intent_id,
    );
    const card = await stripe.paymentMethods.retrieve(
      method.provider_payment_method_id,
    );
    expect({
      status: completed.status,
      mode: completed.mode,
      live: completed.livemode,
      customer: providerId(completed.customer),
      intent: providerId(completed.setup_intent),
    }).toEqual({
      status: "complete",
      mode: "setup",
      live: false,
      customer: owned.provider_customer_id,
      intent: intent.id,
    });
    expect({
      status: intent.status,
      usage: intent.usage,
      live: intent.livemode,
      customer: providerId(intent.customer),
      method: providerId(intent.payment_method),
      setup: intent.metadata?.datapad_setup,
      deployment: intent.metadata?.datapad_deployment,
    }).toEqual({
      status: "succeeded",
      usage: "off_session",
      live: false,
      customer: owned.provider_customer_id,
      method: card.id,
      setup: setup.setupId,
      deployment,
    });
    expect({
      type: card.type,
      live: card.livemode,
      customer: providerId(card.customer),
      brand: card.card?.brand,
      last4: card.card?.last4,
    }).toEqual({
      type: "card",
      live: false,
      customer: owned.provider_customer_id,
      brand: "visa",
      last4: "4242",
    });
    const safeCard = verified.methods.find((item) => item.id === method.id)!;
    expect(safeCard).toMatchObject({
      brand: "visa",
      last4: "4242",
      expiryMonth: card.card!.exp_month,
      expiryYear: card.card!.exp_year,
      usable: true,
    });
    expect(Object.keys(safeCard).sort()).toEqual([
      "brand",
      "expiryMonth",
      "expiryYear",
      "id",
      "last4",
      "usable",
      "verifiedAt",
    ]);
    await expect(
      page.getByText(/visa ending 4242, expires/).first(),
    ).toBeVisible();
    hostedProved = true;
    evidence.hostedSetup = {
      verifiedReturn: true,
      sessionComplete: true,
      setupSucceededOffSession: true,
      attachedSafeCard: true,
      savingGrantedNoConsent: true,
    };
    await layouts("saved-without-consent");

    phase = "explicit selected subscription consent";
    const editor = page.getByRole("form", {
      name: "Authorize automatic payments",
      exact: true,
    });
    const confirm = editor.getByRole("button", {
      name: "Confirm automatic payments",
      exact: true,
    });
    await expect(confirm).toBeDisabled();
    await editor
      .getByRole("combobox", {
        name: "Card for automatic payments",
        exact: true,
      })
      .selectOption(method.id);
    const selectedUI = editor.locator(".payment-agreement").filter({
      has: page.locator(
        `a[href^="${customerPath}/subscriptions/${selected.id}"]`,
      ),
    });
    const untouchedUI = editor.locator(".payment-agreement").filter({
      has: page.locator(
        `a[href^="${customerPath}/subscriptions/${untouched.id}"]`,
      ),
    });
    await selectedUI
      .getByRole("combobox", { name: "Effective service period", exact: true })
      .selectOption("0");
    await expect(
      untouchedUI.getByRole("combobox", {
        name: "Effective service period",
        exact: true,
      }),
    ).toHaveValue("");
    const confirmation = editor.locator(".payment-confirmation");
    await expect(confirmation).toContainText("Web hosting");
    await expect(confirmation).toContainText("$23.00 · Monthly");
    await expect(confirmation).toContainText(
      "Until commercial terms change or you stop.",
    );
    await expect(confirmation).not.toContainText("Storage add-on");
    await expect(page.locator(".payment-consequence")).toContainText(
      "every unpaid invoice already sealed under the previous consent",
    );
    await expect(confirm).toBeDisabled();
    await editor
      .getByRole("checkbox", { name: ENROLLMENT_TERMS_TEXT, exact: true })
      .check();
    await expect(confirm).toBeEnabled();
    await layouts("consent-confirmation");
    const consentStartedAt = Date.now();
    const consentResponse = posted(`${api}/automatic-payment-enrollment`);
    await confirm.click();
    const consentHttp = await consentResponse;
    evidence.consentHttpStatus = consentHttp.status();
    expect(consentHttp.status()).toBe(200);
    const consentRequest: ReplaceEnrollmentRequest = consentHttp
      .request()
      .postDataJSON();
    expect(consentRequest).toMatchObject({
      expectedVersion: initial.enrollment?.version ?? 0,
      paymentMethodId: method.id,
      termsVersion: initial.enrollmentTerms.version,
      acceptTerms: true,
      selections: [
        {
          subscriptionId: selected.id,
          expectedSubscriptionVersion: selected.version,
          fromPeriodIndex: 0,
        },
      ],
    });
    expect(consentRequest.requestId).not.toBe(setupRequest.requestId);
    const authorized: ChangeEnrollmentResponse = await consentHttp.json();
    evidence.createdConsent = {
      enrollmentId: authorized.enrollment.id,
      version: authorized.enrollment.version,
    };
    expect(authorized.outcome).toBe("changed");
    expect(authorized.enrollment.scopes).toHaveLength(1);
    expect(authorized.enrollment.scopes[0]).toMatchObject({
      subscriptionId: selected.id,
      fromPeriodIndex: 0,
      untilPeriodIndex: null,
      periodStart: tomorrow,
      dueDate,
      calendar: options.calendar,
    });
    expect(Date.parse(authorized.enrollment.acceptedAt)).toBeGreaterThanOrEqual(
      consentStartedAt,
    );
    expect(Date.parse(authorized.enrollment.acceptedAt)).toBeLessThanOrEqual(
      Date.now(),
    );
    await expect(
      page
        .getByRole("status")
        .filter({ hasText: "Automatic payment settings updated." }),
    ).toBeVisible();
    const current = await settings();
    expect(current.enrollment).toEqual(authorized.enrollment);
    expect(
      current.subscriptions.find((item) => item.id === selected.id)
        ?.retainedScope,
    ).toMatchObject({
      ...authorized.enrollment.scopes[0],
      label: "Web hosting",
      amountMinor: 2300,
      currency: "USD",
      intervalMonths: 1,
      untilPeriodStart: null,
    });
    expect(
      current.subscriptions.find((item) => item.id === untouched.id)
        ?.retainedScope,
    ).toBeNull();
    await expect(page.locator(".payment-current")).toContainText(
      "$23.00 · Monthly",
    );
    await expect(page.locator(".payment-current")).not.toContainText(
      "recorded price and frequency are unavailable",
    );
    await layouts("consent-active");

    phase = "visible immediate stop and immutable persistence proof";
    const stopResponse = posted(`${api}/automatic-payment-enrollment/reduce`);
    await page
      .getByRole("button", { name: "Stop automatic payments", exact: true })
      .click();
    const stopHttp = await stopResponse;
    evidence.stopHttpStatus = stopHttp.status();
    expect(stopHttp.status()).toBe(200);
    const stopRequest: ReduceEnrollmentRequest = stopHttp
      .request()
      .postDataJSON();
    expect(stopRequest).toMatchObject({
      expectedVersion: authorized.enrollment.version,
      retainSubscriptionIds: [],
    });
    expect([setupRequest.requestId, consentRequest.requestId]).not.toContain(
      stopRequest.requestId,
    );
    const stopped: ChangeEnrollmentResponse = await stopHttp.json();
    evidence.stoppedConsent = {
      enrollmentId: stopped.enrollment.id,
      predecessorId: stopped.enrollment.predecessorId,
      scopesEmpty: stopped.enrollment.scopes.length === 0,
    };
    expect(stopped).toMatchObject({
      outcome: "changed",
      enrollment: {
        version: authorized.enrollment.version + 1,
        predecessorId: authorized.enrollment.id,
        decision: "reduce",
        scopes: [],
      },
    });
    await expect(
      page.getByText("Automatic payments are stopped.", { exact: true }),
    ).toBeVisible();
    await page.reload();
    await expect(
      page.getByText("Automatic payments are stopped.", { exact: true }),
    ).toBeVisible();
    const final = await settings();
    expect(final.enrollment).toEqual(stopped.enrollment);
    expect(final.methods).toEqual(verified.methods);
    await layouts("consent-stopped");
    const { rows: provenance } = await pool.query<{
      valid: boolean;
      scopes: number;
    }>(
      `select (e.actor_user_id=$4 and e.request_id=$5 and e.payment_method_id=$6
          and e.terms_version=$7 and e.terms_digest <> '' and m.role in ('admin','owner')
          and m.user_id=e.actor_user_id and m.organization_id=c.organization_id
          and a.user_id=e.actor_user_id) as valid,
        (select count(*)::int from billing_enrollment_scopes s where s.enrollment_id=e.id) as scopes
        from billing_enrollments e join customers c on c.id=e.customer_id
        join member m on m.id=e.consenting_membership_id join session a on a.id=e.actor_session_id
        where e.id=$1 and e.customer_id=$2 and e.deployment_key=$3`,
      [
        authorized.enrollment.id,
        customerId,
        deployment,
        customerSession.user!.id,
        consentRequest.requestId,
        method.id,
        initial.enrollmentTerms.version,
      ],
    );
    expect(provenance).toEqual([{ valid: true, scopes: 1 }]);
    const { rows: snapshots } = await pool.query<{
      id: string;
      decision: string;
      scopes: number;
    }>(
      `select e.id, e.decision, (select count(*)::int from billing_enrollment_scopes s where s.enrollment_id=e.id) as scopes
        from billing_enrollments e where e.id=any($1::uuid[]) and e.customer_id=$2 and e.deployment_key=$3 order by e.version`,
      [
        [authorized.enrollment.id, stopped.enrollment.id],
        customerId,
        deployment,
      ],
    );
    expect(snapshots).toEqual([
      { id: authorized.enrollment.id, decision: "authorize", scopes: 1 },
      { id: stopped.enrollment.id, decision: "reduce", scopes: 0 },
    ]);
    const { rows: audits } = await pool.query<{
      target_id: string;
      action: string;
      membership: boolean;
    }>(
      `select target_id, action, (details->>'consentingMembershipId' is not null) as membership
        from access_audit where customer_id=$1 and target_id=any($2::text[]) order by created_at`,
      [
        customerId,
        [setup.setupId, authorized.enrollment.id, stopped.enrollment.id],
      ],
    );
    expect(audits).toEqual([
      {
        target_id: setup.setupId,
        action: "payment_setup.started",
        membership: true,
      },
      {
        target_id: authorized.enrollment.id,
        action: "payment_enrollment.changed",
        membership: true,
      },
      {
        target_id: stopped.enrollment.id,
        action: "payment_enrollment.changed",
        membership: true,
      },
    ]);
    const untouchedFinal = await get<SubscriptionResponse>(
      `${api}/subscriptions/${untouched.id}`,
    );
    expect(untouchedFinal.subscription).toEqual({
      ...untouched,
      canManage: false,
    });
    const selectedFinal = await get<SubscriptionResponse>(
      `${api}/subscriptions/${selected.id}`,
    );
    expect(selectedFinal.subscription).toMatchObject({
      version: selected.version + 1,
      paymentArrangement: "automatic",
    });
    const after = await get<SubscriptionsResponse>(
      `${api}/subscriptions?limit=100&offset=0`,
    );
    expect(after.total).toBe(existing.total + 2);
    expect(
      after.subscriptions
        .filter((item) =>
          existing.subscriptions.some((prior) => prior.id === item.id),
        )
        .sort((a, b) => a.id.localeCompare(b.id)),
    ).toEqual(
      [...existing.subscriptions].sort((a, b) => a.id.localeCompare(b.id)),
    );
    expect(await noChargeSnapshot(owned.provider_customer_id)).toEqual(
      chargesBefore,
    );
    evidence.consent = {
      explicitSelectedScope: true,
      termsVersion: initial.enrollmentTerms.version,
      acceptedAt: authorized.enrollment.acceptedAt,
      immutablePriceAndCadence: true,
      realMembershipAndAudit: true,
      stoppedImmediately: true,
      predecessorPreserved: true,
      savedCardRetained: true,
      unrelatedAgreementsUnchanged: true,
      noNewChargesOrPaymentIntents: true,
      desktopAnd390NoOverflow: true,
    };
    await save(
      "result.json",
      JSON.stringify(
        { outcome: "passed", hostedProved, ...evidence },
        null,
        2,
      ) + "\n",
    );
  } catch (error) {
    // Safe evidence only. Provider/browser errors can contain URLs, card input or secrets.
    if (new URL(page.url()).origin === "https://checkout.stripe.com") {
      challengeObserved ||= await hostedChallenge();
    }
    const alerts = await page
      .getByRole("alert")
      .allTextContents()
      .catch(() => []);
    evidence.renderedAlerts = alerts
      .slice(0, 3)
      .map((value) => safeError(new Error(value)).message);
    await save(
      "failure-masked.png",
      await page.screenshot({
        fullPage: true,
        mask: [page.locator("input, textarea, iframe")],
      }),
    ).catch(() => undefined);
    await save(
      "result.json",
      JSON.stringify(
        {
          outcome: "failed",
          phase,
          hostedProved,
          challengeObserved,
          bypassAttempted: false,
          failure: safeError(error),
          ...evidence,
        },
        null,
        2,
      ) + "\n",
    );
    throw new Error(
      `Hosted setup acceptance failed during ${phase}${challengeObserved ? ": provider challenge observed" : ""}. Inspect the private sanitized evidence; no fallback proof is claimed.`,
    );
  } finally {
    await pool.end();
  }
});
