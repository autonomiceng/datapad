import { expect, test } from "@playwright/test";
import type { InvoiceDetail } from "../../src/billing/contract";
import type { InvoiceNoticesResponse } from "../../src/notifications/contract";

// Presentation-only fixtures exercise the staff contract and inert previews.
// Domain authorization, durable delivery and actual Mailpit capture have separate acceptance evidence.
test("staff inspects four notice stages at desktop and narrow widths while member content stays hidden", async ({
  page,
}, testInfo) => {
  const customerId = "10000000-0000-4000-8000-000000000001";
  const invoiceId = "20000000-0000-4000-8000-000000000002";
  const attemptedAt = "2026-10-03T16:00:00Z";
  const path = `/api/customers/${customerId}/invoices/${invoiceId}`;
  const reviewPath = `/customers/${customerId}/invoices/${invoiceId}/review`;
  const preview = {
    subject: "Your sample invoice is ready",
    text: "Hello Elm Studio (sample),\n\nAmount remaining: $23.00 USD\n\nAutomatic payment is not authorized for this invoice.\n\nView invoice: http://localhost/invoices?invoiceId=20000000-0000-4000-8000-000000000002&offset=0",
    html: '<p>Sample invoice HTML</p><script>parent.document.body.dataset.noticeScript="ran"</script><img src="https://preview-content.example.test/image" onerror="parent.document.body.dataset.noticeScript=\'ran\'">',
  };
  const base = {
    calendar: { timeZone: "America/Los_Angeles", hour: 9 },
    nextAttemptAt: null,
    acceptedAt: null,
    attemptedAt: null,
    recipient: null,
    profileVersion: null,
    attempts: 0,
    preview: null,
    previewKind: null,
    messageId: null,
  };
  const notices: InvoiceNoticesResponse = {
    invoiceId,
    notices: [
      {
        ...base,
        id: "40000000-0000-4000-8000-000000000001",
        stage: "invoice",
        state: "accepted",
        reason: null,
        scheduledAt: "2026-09-12T16:00:00Z",
        attemptedAt: "2026-09-12T16:00:00Z",
        acceptedAt: "2026-09-12T16:00:01Z",
        recipient: "billing@example.test",
        profileVersion: 1,
        attempts: 1,
        preview: {
          ...preview,
          text: "Your invoice was issued on Sep 12, 2026.\n\nAutomatic payment is scheduled.",
        },
        previewKind: "stamped",
        messageId: "<invoice@notices.datapad.test>",
      },
      {
        ...base,
        id: "40000000-0000-4000-8000-000000000002",
        stage: "before_due",
        state: "suppressed",
        reason: "obsolete",
        scheduledAt: "2026-09-26T16:00:00Z",
      },
      {
        ...base,
        id: "40000000-0000-4000-8000-000000000003",
        stage: "due",
        state: "pending",
        reason: "billing_contact_missing",
        scheduledAt: attemptedAt,
        nextAttemptAt: "2026-10-03T16:00:30Z",
      },
      {
        ...base,
        id: "40000000-0000-4000-8000-000000000004",
        stage: "overdue",
        state: "needs_review",
        reason: "uncertain_delivery",
        scheduledAt: "2026-10-10T16:00:00Z",
        attemptedAt: "2026-10-10T16:00:00Z",
        recipient: "billing@example.test",
        profileVersion: 1,
        attempts: 1,
        preview: { ...preview, subject: "Your sample invoice is overdue" },
        previewKind: "stamped",
        messageId: "<overdue@notices.datapad.test>",
      },
    ],
  };
  const invoice: InvoiceDetail = {
    id: invoiceId,
    customer: { id: customerId, name: "Elm Studio (sample)" },
    billTo: {
      legalName: "Elm Studio (sample)",
      billingEmail: null,
      profileVersion: 2,
    },
    issueDate: "2026-09-12",
    dueDate: "2026-10-03",
    readinessDate: "2026-09-12",
    currency: "USD",
    totalMinor: 2300,
    state: "open",
    providerStatus: "open",
    providerReceipt: { state: "verified", reason: null },
    reviewReason: null,
    issuedAt: "2026-09-12T16:00:00Z",
    lastCheckedAt: attemptedAt,
    calendar: { timeZone: "America/Los_Angeles", issueHour: 9, chargeHour: 9 },
    collection: {
      chargeAt: attemptedAt,
      checkedAt: attemptedAt,
      attempt: null,
      disposition: { kind: "payable", reason: "not_authorized" },
    },
    resolution: null,
    hostedInvoiceUrl: null,
    lines: [
      {
        id: "30000000-0000-4000-8000-000000000003",
        position: 0,
        description: "Web hosting (sample)",
        amountMinor: 2300,
        originRef: null,
      },
    ],
  };
  let staff = true;
  let noticeReads = 0;
  let denyNotices = false;
  const previewRequests: string[] = [];
  const blockedPreviewRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().startsWith("https://preview-content.example.test"))
      previewRequests.push(request.url());
  });
  page.on("requestfailed", (request) => {
    if (
      request.url().startsWith("https://preview-content.example.test") &&
      request.failure()?.errorText === "csp"
    )
      blockedPreviewRequests.push(request.url());
  });
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    expect(route.request().method()).toBe("GET");
    let json: unknown;
    if (url.pathname === "/api/access/session") {
      json = {
        user: {
          id: staff ? "sample-staff" : "sample-member",
          name: "Sample viewer",
          emailVerified: true,
        },
        staffRoles: staff ? ["billing"] : [],
        signInMethods: ["email_link"],
        synthetic: true,
      };
    } else if (url.pathname === `/api/customers/${customerId}`) {
      json = {
        customer: {
          id: customerId,
          displayName: "Elm Studio (sample)",
          role: null,
          profile: {
            displayName: "Elm Studio (sample)",
            legalName: invoice.billTo.legalName,
            billingEmail: invoice.billTo.billingEmail,
          },
          version: 1,
          canEditProfile: false,
          canManageMembers: false,
          providerProfileState: "unchanged",
        },
      };
    } else if (url.pathname === `${path}/preparation`)
      json = { invoice, issueBlocker: "already_issued" };
    else if (url.pathname === `${path}/resolution-review`)
      json = {
        invoiceId,
        remainingMinor: 2300,
        collectionState: "idle",
        lastCheckedAt: attemptedAt,
        actions: [],
        blockers: [],
        resolution: null,
        history: [],
      };
    else if (url.pathname === `${path}/notices`) {
      noticeReads++;
      if (!staff || denyNotices) {
        await route.fulfill({ status: 403, json: { code: "forbidden" } });
        return;
      }
      json = notices;
    } else
      throw new Error(
        `Unexpected notice presentation request: ${url.pathname}`,
      );
    await route.fulfill({ json });
  });
  const section = page.getByRole("region", { name: "Notices", exact: true });
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(reviewPath);
    await expect(
      section.getByRole("heading", { name: "Notices", exact: true }),
    ).toBeVisible();
    await expect(section.locator(".notice-record")).toHaveCount(4);
    await expect(
      section.getByText("Accepted by mail server", { exact: true }),
    ).toBeVisible();
    await expect(section.getByText("Not sent", { exact: true })).toBeVisible();
    await expect(
      section.getByText("No billing contact is recorded.", { exact: true }),
    ).toBeVisible();
    await expect(
      section.getByText(
        "Delivery could not be confirmed. It will not be sent again automatically. Check the inbox before contacting the customer.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      section.getByRole("link", { name: "Sample inbox", exact: true }),
    ).toHaveAttribute("href", "/sample-inbox");
    const records = section.locator(".notice-record");
    await expect(
      records.nth(2).getByText("Next attempt", { exact: true }),
    ).toBeVisible();
    await records.nth(0).getByText("Message", { exact: true }).click();
    await expect(
      records.nth(0).getByText("Saved at the first attempt.", {
        exact: true,
      }),
    ).toBeVisible();
    await records.nth(3).getByText("Message", { exact: true }).click();
    await records.nth(3).getByText("HTML preview", { exact: true }).click();
    const html = records.nth(3).locator("iframe");
    await expect(html).toHaveAttribute("sandbox", "");
    await expect(
      html.contentFrame().getByText("Sample invoice HTML", { exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(() => document.body.dataset.noticeScript),
    ).toBeUndefined();
    // Chromium emits request events for loads its CSP subsequently blocks.
    await expect
      .poll(() => blockedPreviewRequests.length)
      .toBe(previewRequests.length);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`notices-${width}.png`),
      fullPage: true,
    });
  }
  // A failed refresh must hide cached recipient/content, even in the same session.
  denyNotices = true;
  await expect(section.getByRole("alert")).toHaveText(
    "You do not have permission to view these notices.",
    { timeout: 10000 },
  );
  await expect(section.locator(".notice-record")).toHaveCount(0);
  staff = false;
  const readsBeforeMember = noticeReads;
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Billing access required", exact: true }),
  ).toBeVisible();
  await expect(section).toHaveCount(0);
  expect(noticeReads).toBe(readsBeforeMember);
});
