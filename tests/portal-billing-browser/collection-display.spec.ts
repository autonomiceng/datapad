import { expect, test } from "@playwright/test";
import type { InvoiceDetail } from "../../src/billing/contract";
import type { InvoiceCollection } from "../../src/billing/collection-contract";
import type { AccessSessionResponse } from "../../src/access/contract";

// Credential-free presentation fixture. This exercises the real portal components,
// without claiming provider settlement, server authorization or collection policy.
test("synthetic collection display keeps held payments separate from customer action", async ({
  page,
}, testInfo) => {
  const customerId = "10000000-0000-4000-8000-000000000001";
  const invoiceId = "20000000-0000-4000-8000-000000000002";
  const checkedAt = "2026-10-03T16:00:00Z";
  const invoice: InvoiceDetail = {
    id: invoiceId,
    customer: { id: customerId, name: "Elm Studio (sample)" },
    billTo: {
      legalName: "Elm Studio (sample)",
      billingEmail: "billing@example.test",
      profileVersion: 1,
    },
    issueDate: "2026-10-02",
    dueDate: "2026-10-03",
    readinessDate: "2026-09-12",
    currency: "USD",
    totalMinor: 2300,
    state: "open",
    providerStatus: "open",
    providerReceipt: { state: "verified", reason: null },
    reviewReason: null,
    lastCheckedAt: checkedAt,
    issuedAt: "2026-10-02T16:00:00Z",
    calendar: { timeZone: "America/Los_Angeles", issueHour: 9, chargeHour: 9 },
    resolution: null,
    lines: [
      {
        id: "30000000-0000-4000-8000-000000000003",
        position: 0,
        description: "Web hosting (sample)",
        amountMinor: 2300,
        originRef: null,
      },
    ],
    // Deliberately leave the URL present while held to check the UI's own guard.
    hostedInvoiceUrl: "https://invoice.stripe.com/i/synthetic-display-only",
    collection: {
      chargeAt: checkedAt,
      checkedAt,
      disposition: { kind: "defer", reason: "pending" },
      attempt: { state: "pending", attemptedAt: checkedAt, reason: null },
    },
  };
  let role: "member" | "administrator" = "member";
  let staff = false;
  let checks = 0;
  let staffChecks = 0;
  let checkResponse: InvoiceDetail | null = null;
  let checkStatus = 200;
  let waitForCheck: Promise<void> | null = null;
  const navigations: string[] = [];
  await page.route("https://invoice.stripe.com/**", async (route) => {
    expect(route.request().isNavigationRequest()).toBe(true);
    navigations.push(route.request().url());
    // A synthetic document proves the real same-tab navigation destination.
    // It does not contact Stripe or prove a provider payment/challenge.
    await route.fulfill({
      contentType: "text/html",
      body: "<h1>Synthetic hosted destination</h1><p>No provider request or payment.</p>",
    });
  });
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let json: unknown;
    if (path === "/api/access/session") {
      const session: AccessSessionResponse = {
        user: {
          id: staff ? "sample-staff" : "sample-member",
          name: "Sample viewer",
          emailVerified: true,
        },
        staffRoles: staff ? ["billing"] : [],
        signInMethods: ["email_link"],
        synthetic: true,
      };
      json = session;
    } else if (path === `/api/customers/${customerId}`) {
      json = {
        customer: {
          id: customerId,
          displayName: invoice.customer.name,
          role: staff ? null : role,
          profile: {
            displayName: invoice.customer.name,
            legalName: invoice.billTo.legalName,
            billingEmail: invoice.billTo.billingEmail,
          },
          version: 1,
          canEditProfile: role === "administrator",
          canManageMembers: role === "administrator",
          providerProfileState: "unchanged",
        },
      };
    } else if (path === "/api/billing/invoices") {
      json = { invoices: [invoice], total: 1, limit: 50, offset: 0 };
    } else if (path === `/api/billing/invoices/${invoiceId}`) {
      json = { invoice };
    } else if (path.endsWith("/preparation")) {
      json = { invoice, issueBlocker: "already_issued" };
    } else if (
      path === `/api/customers/${customerId}/invoices/${invoiceId}/check`
    ) {
      expect(route.request().method()).toBe("POST");
      expect(route.request().postDataJSON()).toEqual({});
      checks++;
      if (waitForCheck) await waitForCheck;
      if (checkStatus !== 200) {
        await route.fulfill({
          status: checkStatus,
          json: { code: "unavailable" },
        });
        return;
      }
      if (staff) {
        staffChecks++;
        invoice.state = "paid";
        invoice.providerStatus = "paid";
        invoice.collection = {
          ...invoice.collection,
          disposition: { kind: "suppress", reason: "paid" },
          attempt: { state: "succeeded", attemptedAt: checkedAt, reason: null },
        };
      } else {
        if (!checkResponse)
          throw new Error("Expected a synthetic check response.");
        Object.assign(invoice, checkResponse);
      }
      json = { invoice };
    } else if (path.endsWith("/resolution-review")) {
      json = {
        invoiceId,
        remainingMinor: invoice.state === "paid" ? 0 : 2300,
        collectionState: "idle",
        lastCheckedAt: checkedAt,
        actions: [],
        blockers: [],
        resolution: null,
        history: [],
      };
    } else {
      throw new Error(`Unexpected synthetic API request: ${path}`);
    }
    await route.fulfill({ json });
  });
  const detail = page.getByRole("region", {
    name: "Invoice details",
    exact: true,
  });
  const pay = page.getByRole("button", { name: "Pay invoice", exact: true });
  const load = async (
    collection: InvoiceCollection,
    state: "open" | "paid" = "open",
  ) => {
    invoice.collection = collection;
    invoice.state = state;
    invoice.providerStatus = state;
    await page.goto(`/invoices?invoiceId=${invoiceId}&offset=0`);
    await expect(
      detail.getByText("Payment collection", { exact: true }),
    ).toBeVisible();
    await expect(detail.locator(".invoice-status")).toHaveText(
      state === "paid" ? "Paid" : "Unpaid",
    );
  };
  const capture = async (name: string) => {
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`${name}.png`),
      fullPage: true,
    });
  };
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    staff = false;
    role = "member";
    await load({
      chargeAt: checkedAt,
      checkedAt,
      disposition: { kind: "defer", reason: "pending" },
      attempt: { state: "pending", attemptedAt: checkedAt, reason: null },
    });
    await expect(detail.getByText("Pending", { exact: true })).toBeVisible();
    await expect(pay).toHaveCount(0);
    await expect(
      page.getByRole("link", { name: "Payment settings", exact: true }),
    ).toHaveCount(0);
    await capture(`customer-held-${width}`);

    await load({
      ...invoice.collection,
      disposition: { kind: "defer", reason: "processing" },
      attempt: { state: "processing", attemptedAt: checkedAt, reason: null },
    });
    await expect(detail.getByText("Processing", { exact: true })).toBeVisible();
    await expect(pay).toHaveCount(0);

    await load({
      ...invoice.collection,
      disposition: { kind: "payable", reason: "declined" },
      attempt: { state: "failed", attemptedAt: checkedAt, reason: "declined" },
    });
    await expect(detail.getByText("Declined", { exact: true })).toBeVisible();
    await expect(pay).toBeVisible();
    await capture(`customer-declined-${width}`);
    checkResponse = structuredClone(invoice);
    await pay.click();
    await expect(page).toHaveURL(checkResponse.hostedInvoiceUrl!);
    await expect(
      page.getByRole("heading", {
        name: "Synthetic hosted destination",
        exact: true,
      }),
    ).toBeVisible();
    expect(page.context().pages()).toHaveLength(1);

    role = "administrator";
    await load({
      ...invoice.collection,
      disposition: { kind: "payable", reason: "requires_action" },
      attempt: {
        state: "requires_action",
        attemptedAt: checkedAt,
        reason: "authentication_required",
      },
    });
    await expect(
      detail.getByText("Customer action required", { exact: true }),
    ).toBeVisible();
    await expect(pay).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Payment settings", exact: true }),
    ).toHaveAttribute("href", `/customers/${customerId}/payment-settings`);
    await capture(`customer-action-${width}`);
    checkResponse = structuredClone(invoice);
    await pay.click();
    await expect(page).toHaveURL(checkResponse.hostedInvoiceUrl!);
    await expect(
      page.getByRole("heading", {
        name: "Synthetic hosted destination",
        exact: true,
      }),
    ).toBeVisible();
    expect(page.context().pages()).toHaveLength(1);

    // A stale persisted URL never grants navigation. The scoped check can hold it.
    await load({
      ...invoice.collection,
      disposition: { kind: "defer", reason: "stale" },
      attempt: null,
    });
    await expect(
      detail.getByText("Check payment status", { exact: true }),
    ).toBeVisible();
    await expect(detail.locator(".invoice-status-needs_review")).toHaveCount(0);
    checkResponse = {
      ...structuredClone(invoice),
      collection: {
        ...invoice.collection,
        disposition: { kind: "defer", reason: "processing" },
        attempt: { state: "processing", attemptedAt: checkedAt, reason: null },
      },
    };
    const beforeHeld = navigations.length;
    let releaseCheck: (() => void) | undefined;
    waitForCheck = new Promise<void>((resolve) => {
      releaseCheck = resolve;
    });
    const posted = page.waitForRequest(
      (request) =>
        new URL(request.url()).pathname ===
        `/api/customers/${customerId}/invoices/${invoiceId}/check`,
    );
    await pay.click();
    await posted;
    await expect(pay).toBeDisabled();
    await capture(`customer-checking-${width}`);
    releaseCheck!();
    waitForCheck = null;
    await expect(detail.getByText("Processing", { exact: true })).toBeVisible();
    await expect(pay).toHaveCount(0);
    expect(navigations).toHaveLength(beforeHeld);
    await capture(`customer-check-held-${width}`);

    // Unknown manual evidence still offers one Pay click; an outage stays on the portal.
    invoice.hostedInvoiceUrl = null;
    await load({
      chargeAt: null,
      checkedAt: null,
      disposition: { kind: "defer", reason: "unknown" },
      attempt: null,
    });
    checkStatus = 503;
    await pay.click();
    await expect(detail.getByRole("alert")).toBeVisible();
    await expect(pay).toBeEnabled();
    expect(navigations).toHaveLength(beforeHeld);
    await capture(`customer-check-error-${width}`);
    checkStatus = 200;
    checkResponse = {
      ...structuredClone(invoice),
      hostedInvoiceUrl: "https://invoice.stripe.com.evil.test/synthetic",
      collection: {
        ...invoice.collection,
        disposition: { kind: "payable", reason: "manual" },
      },
    };
    await pay.click();
    await expect(detail.getByRole("alert")).toHaveText(
      "The payment link could not be verified. Please try again later.",
    );
    expect(navigations).toHaveLength(beforeHeld);
    checkResponse = {
      ...checkResponse,
      hostedInvoiceUrl:
        "https://invoice.stripe.com/i/synthetic-manual-display-only",
    };
    await pay.click();
    await expect(page).toHaveURL(checkResponse.hostedInvoiceUrl!);
    await expect(
      page.getByRole("heading", {
        name: "Synthetic hosted destination",
        exact: true,
      }),
    ).toBeVisible();
    expect(page.context().pages()).toHaveLength(1);
    invoice.hostedInvoiceUrl =
      "https://invoice.stripe.com/i/synthetic-display-only";

    await load(
      {
        ...invoice.collection,
        disposition: { kind: "suppress", reason: "paid" },
        attempt: { state: "succeeded", attemptedAt: checkedAt, reason: null },
      },
      "paid",
    );
    await expect(
      detail.locator(".invoice-statuses").getByText("Paid", { exact: true }),
    ).toHaveCount(2);
    await expect(pay).toHaveCount(0);
    await capture(`customer-paid-${width}`);

    await load({
      ...invoice.collection,
      chargeAt: checkedAt,
      disposition: { kind: "payable", reason: "missed" },
      attempt: null,
    });
    await expect(
      detail.getByText(
        "Automatic payment was not attempted. Payment is needed.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(detail.getByText("Declined", { exact: true })).toHaveCount(0);
    await expect(pay).toBeVisible();
    await capture(`customer-missed-${width}`);

    staff = true;
    await page.reload();
    await page
      .getByRole("link", { name: "Review invoice", exact: true })
      .click();
    await expect(page.getByText("Staff review", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Payment settings", exact: true }),
    ).toHaveCount(0);
    await capture(`staff-review-${width}`);
    await page
      .getByRole("button", { name: "Check status", exact: true })
      .click();
    await expect(
      page.locator(".invoice-statuses").getByText("Paid", { exact: true }),
    ).toHaveCount(2);
    await expect(pay).toHaveCount(0);
    await capture(`staff-checked-${width}`);
  }
  expect(checks).toBe(14);
  expect(staffChecks).toBe(2);
  expect(navigations).toHaveLength(6);
});
