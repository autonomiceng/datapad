import { chmod, lstat, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { expect, test } from "@playwright/test";
import { Pool } from "pg";
import Stripe from "stripe";
import type {
  InvoiceResponse,
  PrepareInvoiceResponse,
} from "../../src/billing/contract";
import type {
  ResolutionActionResponse,
  ResolutionReviewResponse,
} from "../../src/billing/resolutions-contract";
import { signIn } from "../portal-browser/helpers";

test("staff resolves two new sandbox invoices and members see safe confirmed outcomes", async ({
  page,
}) => {
  test.setTimeout(240000);
  const artifacts = process.env.PORTAL_RESOLUTION_TEST_ARTIFACTS;
  const deployment = process.env.BILLING_DEPLOYMENT_KEY;
  if (
    !artifacts ||
    !isAbsolute(artifacts) ||
    !deployment ||
    !process.env.DATABASE_URL
  )
    throw new Error("Explicit resolution sandbox configuration is required.");
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

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
    maxNetworkRetries: 0,
    timeout: 15000,
  });
  let phase = "staff sign-in";
  const evidence: Record<string, unknown> = {};
  const save = async (name: string, content: string | Buffer) => {
    const path = join(artifacts, name);
    await writeFile(path, content, { mode: 0o600 });
    await chmod(path, 0o600);
  };
  const screenshot = async (name: string, target = page) =>
    save(name, await target.screenshot({ fullPage: true }));
  const layouts = async (name: string) => {
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
      await screenshot(`${name}-${width}.png`);
    }
    await page.setViewportSize({ width: 1280, height: 900 });
  };
  const get = async <T>(path: string): Promise<T> => {
    const response = await page.request.get(path);
    expect(response.ok()).toBe(true);
    return response.json();
  };
  const detail = (invoiceId: string) =>
    get<InvoiceResponse>(`/api/billing/invoices/${invoiceId}`);
  const posted = (suffix: string) =>
    page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname.endsWith(suffix) &&
        response.request().method() === "POST",
    );
  const prepareAndIssue = async () => {
    await page.goto("/customers");
    await page.getByRole("link", { name: /^Elm Studio/ }).click();
    await page
      .getByRole("link", { name: "Prepare invoice", exact: true })
      .click();
    // Read the real response before the app follows its full-page review navigation.
    let prepared: PrepareInvoiceResponse | undefined;
    const prepareRoute = "**/api/customers/*/invoices";
    await page.route(prepareRoute, async (route) => {
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      prepared = await response.json();
      await route.fulfill({ response });
    });
    await page
      .getByRole("button", { name: "Review invoice", exact: true })
      .click();
    await expect.poll(() => prepared !== undefined).toBe(true);
    await page.unroute(prepareRoute);
    if (!prepared) throw new Error("Missing prepared invoice response.");
    // Only a newly created manual request authorizes this case's effects.
    expect(prepared.outcome).toBe("created");
    expect(prepared.invoice.state).toBe("requested");
    expect(prepared.invoice.calendar).toBeNull();
    expect(prepared.invoice.totalMinor).toBe(2300);
    const invoiceId = prepared.invoice.id;
    await expect(page).toHaveURL(new RegExp(`/invoices/${invoiceId}/review$`));
    const issuedResponse = posted(`/invoices/${invoiceId}/issue`);
    await page
      .getByRole("button", { name: "Issue invoice", exact: true })
      .click();
    expect((await issuedResponse).ok()).toBe(true);
    await expect(page.getByRole("link", { name: /^Pay invoice/ })).toBeVisible({
      timeout: 45000,
    });
    return prepared.invoice;
  };
  const ownedProviderInvoice = async (
    invoiceId: string,
    customerId: string,
  ) => {
    const { rows } = await pool.query<{
      provider_invoice_id: string;
      provider_customer_id: string;
      provider_account_id: string;
      billing_customer_id: string;
      customer_id: string;
      deployment_key: string;
    }>(
      `select i.provider_invoice_id, i.deployment_key, i.billing_customer_id,
        b.provider_customer_id, b.provider_account_id, b.customer_id
        from invoices i join billing_customers b
          on b.id=i.billing_customer_id and b.deployment_key=i.deployment_key
        where i.id=$1 and i.deployment_key=$2 and b.customer_id=$3`,
      [invoiceId, deployment, customerId],
    );
    expect(rows).toHaveLength(1);
    const owned = rows[0]!;
    expect(owned.deployment_key).toBe(deployment);
    expect(owned.customer_id).toBe(customerId);
    expect(owned.provider_invoice_id).toMatch(/^in_/);
    expect((await stripe.accounts.retrieveCurrent()).id).toBe(
      owned.provider_account_id,
    );
    const invoice = await stripe.invoices.retrieve(owned.provider_invoice_id, {
      expand: ["amount_paid_off_stripe"],
    });
    expect(invoice).toMatchObject({
      id: owned.provider_invoice_id,
      livemode: false,
      customer: owned.provider_customer_id,
      currency: "usd",
      collection_method: "send_invoice",
      auto_advance: false,
      metadata: {
        datapad_invoice: invoiceId,
        datapad_customer: owned.billing_customer_id,
        datapad_deployment: deployment,
      },
    });
    expect(Number.isSafeInteger(invoice.amount_paid_off_stripe)).toBe(true);
    return invoice;
  };
  const confirmed = async (
    invoiceId: string,
    resolutionId: string,
    state: "paid" | "void",
  ) => {
    await expect
      .poll(
        async () => {
          const { invoice } = await detail(invoiceId);
          return {
            id: invoice.id,
            state: invoice.state,
            receipt: invoice.providerReceipt.state,
            resolutionId: invoice.resolution?.id,
            resolutionState: invoice.resolution?.state,
            reviewReason: invoice.resolution?.reviewReason,
          };
        },
        { timeout: 45000, intervals: [500, 1000, 2000] },
      )
      .toEqual({
        id: invoiceId,
        state,
        receipt: "verified",
        resolutionId,
        resolutionState: "confirmed",
        reviewReason: null,
      });
    await page.reload();
    const review = page.getByRole("region", {
      name: "Resolve invoice",
      exact: true,
    });
    const heading = state === "paid" ? "Received payment" : "Void request";
    const record = review.locator(".resolution-record").filter({
      has: page.getByRole("heading", { name: heading, level: 3, exact: true }),
    });
    await expect(
      record.getByRole("heading", { name: heading, level: 3, exact: true }),
    ).toBeVisible();
    const stripeFact = record
      .locator("dt")
      .filter({ hasText: /^Stripe$/ })
      .locator("..");
    await expect(
      stripeFact.getByText("Provider confirmed", { exact: true }),
    ).toBeVisible();
    const invoice = (await detail(invoiceId)).invoice;
    const confirmedAt = invoice.resolution?.confirmedAt;
    if (!confirmedAt)
      throw new Error(
        "A confirmed resolution must include its confirmation time.",
      );
    await expect(stripeFact.locator("time")).toBeVisible();
    await expect(stripeFact.locator("time")).toHaveAttribute(
      "datetime",
      confirmedAt,
    );
    await expect(page.getByRole("link", { name: /^Pay invoice/ })).toHaveCount(
      0,
    );
    await expect(
      page.getByRole("link", { name: /^View invoice/ }),
    ).toBeVisible();
    return get<ResolutionReviewResponse>(
      `/api/customers/${invoice.customer.id}/invoices/${invoiceId}/resolution-review`,
    );
  };
  const audit = async (
    customerId: string,
    resolutionId: string,
    recorded: string,
  ) => {
    const { rows } = await pool.query<{ action: string }>(
      "select action from access_audit where customer_id=$1 and target_id=$2",
      [customerId, resolutionId],
    );
    expect(rows.map((row) => row.action)).toEqual(
      expect.arrayContaining([
        recorded,
        "invoice.resolution_attempted",
        "invoice.resolution_confirmed",
      ]),
    );
  };
  try {
    await signIn(page, "staff@example.test");
    phase = "new external-payment invoice";
    const paid = await prepareAndIssue();
    const before = await ownedProviderInvoice(paid.id, paid.customer.id);
    expect(before).toMatchObject({
      status: "open",
      total: paid.totalMinor,
      amount_due: paid.totalMinor,
      amount_remaining: paid.totalMinor,
      amount_paid: 0,
      amount_paid_off_stripe: 0,
    });
    const receivedDate = new Date().toISOString().slice(0, 10);
    const resolutionUI = page.getByRole("region", {
      name: "Resolve invoice",
      exact: true,
    });
    await resolutionUI
      .getByRole("combobox", { name: "Action", exact: true })
      .selectOption("record_external_payment");
    await expect(
      resolutionUI.getByLabel("Amount (USD)", { exact: true }),
    ).toHaveValue((before.amount_remaining / 100).toFixed(2));
    await resolutionUI
      .getByLabel("Received date (UTC)", { exact: true })
      .fill(receivedDate);
    await resolutionUI
      .getByRole("combobox", { name: "Method", exact: true })
      .selectOption("check");
    await resolutionUI
      .getByLabel("Reference", { exact: true })
      .fill("Sample external payment");
    await resolutionUI
      .getByRole("checkbox", {
        name: "I confirm these funds were received and cover the full remaining balance.",
        exact: true,
      })
      .check();
    const receiptResponse = posted(`/invoices/${paid.id}/external-payment`);
    await resolutionUI
      .getByRole("button", { name: "Record received payment", exact: true })
      .click();
    const receiptHttp = await receiptResponse;
    expect(receiptHttp.status()).toBe(200);
    const receipt: ResolutionActionResponse = await receiptHttp.json();
    expect(receipt.resolution).toMatchObject({
      kind: "external_payment",
      state: "pending",
      amountMinor: before.amount_remaining,
      receivedDate,
      method: "check",
      confirmedAt: null,
    });
    await expect(resolutionUI.getByRole("status")).toContainText(
      "Pending provider confirmation",
    );
    await screenshot("staff-receipt-pending.png");
    // The worker may already have advanced the committed pending row by this read.
    const durable = await pool.query<{
      invoice_id: string;
      amount_minor: number;
      method: string;
      reference: string;
      received_date: string;
    }>(
      "select invoice_id, amount_minor, method, reference, received_date::text from billing_invoice_resolutions where id=$1 and deployment_key=$2",
      [receipt.resolution.id, deployment],
    );
    expect(durable.rows).toEqual([
      {
        invoice_id: paid.id,
        amount_minor: before.amount_remaining,
        method: "check",
        reference: "Sample external payment",
        received_date: receivedDate,
      },
    ]);
    evidence.externalPayment = {
      invoiceId: paid.id,
      resolutionId: receipt.resolution.id,
      pendingRecorded: true,
    };

    phase = "worker settlement and exact same-key replay";
    const paidReview = await confirmed(paid.id, receipt.resolution.id, "paid");
    expect(paidReview.resolution).toMatchObject({
      reference: "Sample external payment",
      state: "confirmed",
    });
    const staffReference = resolutionUI
      .locator("dt")
      .filter({ hasText: /^Reference$/ })
      .locator("..")
      .locator("dd");
    await expect(staffReference).toBeVisible();
    await expect(staffReference).toHaveText("Sample external payment");
    await audit(
      paid.customer.id,
      receipt.resolution.id,
      "invoice.external_payment_recorded",
    );
    await layouts("staff-paid");
    const after = await ownedProviderInvoice(paid.id, paid.customer.id);
    expect(after).toMatchObject({
      id: before.id,
      status: "paid",
      total: before.total,
      amount_due: before.amount_due,
      amount_remaining: 0,
      amount_paid: before.amount_remaining,
      amount_overpaid: 0,
      amount_paid_off_stripe:
        before.amount_paid_off_stripe! + before.amount_remaining,
    });
    const { rows: stamps } = await pool.query<{
      attempted_at: Date;
      response_at: Date;
      baseline_paid_off_stripe_minor: number;
      response_paid_off_stripe_minor: number;
    }>(
      `select attempted_at, response_at, baseline_paid_off_stripe_minor, response_paid_off_stripe_minor
        from billing_invoice_resolutions where id=$1 and invoice_id=$2 and deployment_key=$3 and state='confirmed'`,
      [receipt.resolution.id, paid.id, deployment],
    );
    expect(stamps).toHaveLength(1);
    expect(stamps[0]).toMatchObject({
      baseline_paid_off_stripe_minor: before.amount_paid_off_stripe,
      response_paid_off_stripe_minor: after.amount_paid_off_stripe,
    });
    expect(stamps[0]!.attempted_at).not.toBeNull();
    expect(stamps[0]!.response_at).not.toBeNull();
    expect(
      Date.now() - new Date(stamps[0]!.attempted_at).getTime(),
    ).toBeLessThan(23 * 60 * 60 * 1000);
    const effectKey = `datapad:${deployment}:resolution:${receipt.resolution.id}:settle`;
    // This is the already attempted worker effect, with its exact stamped parameters.
    // Never fall back to another key or to a card payment.
    const replay = await stripe.invoices.pay(
      before.id,
      { paid_out_of_band: true, expand: ["amount_paid_off_stripe"] },
      { idempotencyKey: effectKey },
    );
    expect(replay.lastResponse.statusCode).toBe(200);
    expect(replay.lastResponse.idempotencyKey).toBe(effectKey);
    expect(replay.lastResponse.headers["idempotent-replayed"]).toBe("true");
    expect(replay).toMatchObject({
      id: before.id,
      livemode: false,
      status: "paid",
      amount_remaining: 0,
      amount_paid: after.amount_paid,
      amount_paid_off_stripe: after.amount_paid_off_stripe,
    });
    const reread = await ownedProviderInvoice(paid.id, paid.customer.id);
    expect(reread.amount_paid_off_stripe).toBe(after.amount_paid_off_stripe);
    evidence.externalPayment = {
      ...(evidence.externalPayment as object),
      totalMinor: after.total,
      receivedMinor: before.amount_remaining,
      receivedDate,
      method: "check",
      beforeOffStripeMinor: before.amount_paid_off_stripe,
      afterOffStripeMinor: after.amount_paid_off_stripe,
      remainingMinor: after.amount_remaining,
      providerStatus: after.status,
      sameOwnedProviderInvoice: true,
      sameKeyReplay: true,
      auditConfirmed: true,
    };

    phase = "new void invoice";
    const voided = await prepareAndIssue();
    expect(voided.id).not.toBe(paid.id);
    const beforeVoid = await ownedProviderInvoice(
      voided.id,
      voided.customer.id,
    );
    expect(beforeVoid).toMatchObject({
      status: "open",
      total: voided.totalMinor,
      amount_remaining: voided.totalMinor,
      amount_paid: 0,
      amount_paid_off_stripe: 0,
    });
    expect(beforeVoid.id).not.toBe(before.id);
    expect(beforeVoid.hosted_invoice_url).toMatch(
      /^https:\/\/invoice\.stripe\.com\//,
    );
    await resolutionUI
      .getByRole("combobox", { name: "Action", exact: true })
      .selectOption("void");
    await resolutionUI
      .getByLabel("Void reason", { exact: true })
      .fill("Sample invoice void");
    await resolutionUI
      .getByRole("checkbox", {
        name: "I confirm this invoice should be voided for the reason given.",
        exact: true,
      })
      .check();
    const voidResponse = posted(`/invoices/${voided.id}/void`);
    await resolutionUI
      .getByRole("button", { name: "Void invoice", exact: true })
      .click();
    const voidHttp = await voidResponse;
    expect(voidHttp.status()).toBe(200);
    const voidRequest: ResolutionActionResponse = await voidHttp.json();
    expect(voidRequest.resolution).toMatchObject({
      kind: "void",
      state: "pending",
      confirmedAt: null,
    });
    const voidReview = await confirmed(
      voided.id,
      voidRequest.resolution.id,
      "void",
    );
    expect(voidReview.resolution).toMatchObject({
      reason: "Sample invoice void",
      state: "confirmed",
    });
    const staffVoidReason = resolutionUI
      .locator("dt")
      .filter({ hasText: /^Void reason$/ })
      .locator("..")
      .locator("dd");
    await expect(staffVoidReason).toBeVisible();
    await expect(staffVoidReason).toHaveText("Sample invoice void");
    await audit(
      voided.customer.id,
      voidRequest.resolution.id,
      "invoice.void_requested",
    );
    await layouts("staff-void");
    const afterVoid = await ownedProviderInvoice(voided.id, voided.customer.id);
    expect(afterVoid).toMatchObject({
      id: beforeVoid.id,
      status: "void",
      total: beforeVoid.total,
      amount_paid: 0,
      amount_paid_off_stripe: 0,
    });

    phase = "real hosted void outcome";
    const hosted = await page.context().newPage();
    try {
      await hosted.goto(beforeVoid.hosted_invoice_url!, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
      expect(new URL(hosted.url()).origin).toBe("https://invoice.stripe.com");
      // A challenge or unknown provider page must fail visibly, never be bypassed.
      await expect(
        hosted
          .getByText(
            /(?:invoice.*(?:void|cancel)|(?:void|cancel).*invoice|no longer payable)/i,
          )
          .first(),
      ).toBeVisible({ timeout: 15000 });
      await expect(
        hosted.getByRole("button", { name: /^Pay(?:\s|$)/i }),
      ).toHaveCount(0);
      await expect(
        hosted.locator('input[autocomplete="cc-number"]'),
      ).toHaveCount(0);
      await screenshot("hosted-void.png", hosted);
    } finally {
      await hosted.close();
    }
    evidence.void = {
      invoiceId: voided.id,
      resolutionId: voidRequest.resolution.id,
      totalMinor: afterVoid.total,
      providerStatus: afterVoid.status,
      sameOwnedProviderInvoice: true,
      hostedNonpayable: true,
      auditConfirmed: true,
    };

    phase = "member visibility";
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Sign in", exact: true }),
    ).toBeVisible();
    await signIn(page, "elm-admin@example.test");
    for (const [invoiceId, resolutionId, state] of [
      [paid.id, receipt.resolution.id, "paid"],
      [voided.id, voidRequest.resolution.id, "void"],
    ] as const) {
      await page.goto(`/invoices?invoiceId=${invoiceId}&offset=0`);
      const member = await detail(invoiceId);
      expect(member.invoice).toMatchObject({
        id: invoiceId,
        state,
        resolution: {
          id: resolutionId,
          state: "confirmed",
          confirmedAt: expect.any(String),
        },
      });
      expect(member.invoice.resolution).not.toHaveProperty("reference");
      expect(member.invoice.resolution).not.toHaveProperty("reason");
      expect(JSON.stringify(member)).not.toMatch(
        /Sample external payment|Sample invoice void|actorId|sessionId/,
      );
      await expect(
        page
          .getByText(state === "paid" ? "Paid" : "Void", { exact: true })
          .first(),
      ).toBeVisible();
      const memberSummary = page.locator(".resolution-record").filter({
        has: page.getByRole("heading", {
          name: state === "paid" ? "Received payment" : "Void request",
          level: 3,
          exact: true,
        }),
      });
      await expect(
        memberSummary.getByText("Provider confirmed", { exact: true }),
      ).toBeVisible();
      if (state === "paid") {
        expect(member.invoice.resolution).toMatchObject({
          amountMinor: before.amount_remaining,
          method: "check",
          receivedDate,
        });
        await expect(
          memberSummary.getByText("$23.00", { exact: true }),
        ).toBeVisible();
        const dateLabel = new Intl.DateTimeFormat("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
          timeZone: "UTC",
        }).format(new Date(`${receivedDate}T00:00:00Z`));
        await expect(
          memberSummary.getByText(`Check · Received ${dateLabel}`, {
            exact: true,
          }),
        ).toBeVisible();
      }
      await expect(
        page.getByText(/Sample external payment|Sample invoice void/),
      ).toHaveCount(0);
      await expect(
        page.getByRole("region", { name: "Resolve invoice", exact: true }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("button", {
          name: /Record received payment|Void invoice|Correct receipt|Issue invoice/,
        }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("link", { name: /^Pay invoice/ }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("link", { name: /^View invoice/ }),
      ).toBeVisible();
      await layouts(`member-${state}`);
    }
    evidence.member = {
      safeSummary: true,
      staffFactsHidden: true,
      noResolutionActions: true,
      desktopAnd390NoOverflow: true,
    };
    await save(
      "resolutions-result.json",
      JSON.stringify({ outcome: "passed", ...evidence }, null, 2) + "\n",
    );
  } catch (error) {
    await save(
      "resolutions-result.json",
      JSON.stringify({ outcome: "failed", phase, ...evidence }, null, 2) + "\n",
    );
    throw error;
  } finally {
    await pool.end();
  }
});
