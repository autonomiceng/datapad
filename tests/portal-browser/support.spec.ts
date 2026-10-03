import { expect, test } from "@playwright/test";
import type { ServiceResponse } from "../../src/services/contract";
import type {
  TicketResponse,
  ApproveRequest,
  RecordResultRequest,
} from "../../src/support/contract";
import { signIn } from "./helpers";

test("a customer requests service support, approves a revised change and reopens the verified result", async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await signIn(page, "elm-admin@example.test");
  await page.getByRole("link", { name: /^Elm Studio/ }).click();
  const customerPath = new URL(page.url()).pathname;
  await page.getByRole("link", { name: "Services", exact: true }).click();
  await page.getByRole("link", { name: "elm.test", exact: true }).click();
  const servicePath = new URL(page.url()).pathname;
  const service: ServiceResponse = await (
    await page.request.get(`/api${servicePath}`)
  ).json();
  const component = service.service.components.find(
    (candidate) => candidate.kind === "web",
  )!;
  await page.goto(
    `${customerPath}/tickets/new?serviceId=${service.service.id}&componentId=${component.id}`,
  );
  await expect(page.getByLabel("Service (required)")).toHaveValue(
    service.service.id,
  );
  await expect(page.getByLabel("Component (optional)")).toHaveValue(
    component.id,
  );
  await page
    .getByLabel("Subject (required)")
    .fill("Review Elm website configuration (sample)");
  await page
    .getByLabel("Message (required)")
    .fill("Please review the website configuration before changing it.");
  await page.getByRole("button", { name: "Open request", exact: true }).click();
  await expect(
    page.getByRole("heading", {
      name: "Review Elm website configuration (sample)",
      exact: true,
    }),
  ).toBeVisible();
  const ticketPath = new URL(page.url()).pathname;
  const apiPath = `/api${ticketPath}`;
  const origin = new URL(page.url()).origin;
  const staffContext = await browser.newContext({
    baseURL: process.env.TEST_BASE_URL,
    viewport: { width: 1280, height: 900 },
    timezoneId: "America/Los_Angeles",
  });
  try {
    const staff = await staffContext.newPage();
    await signIn(staff, "staff@example.test");
    // Repeated entries exercise real pagination without fifty repeated form submissions.
    let current: TicketResponse = await (
      await staff.request.get(apiPath)
    ).json();
    for (let index = 0; index < 50; index++) {
      const response = await staff.request.post(`${apiPath}/replies`, {
        headers: { origin },
        data: {
          requestId: crypto.randomUUID(),
          expectedVersion: current.ticket.version,
          body: `Configuration observation ${index + 1} (sample).`,
        },
      });
      expect(response.ok()).toBe(true);
      current = await response.json();
    }
    await staff.goto(ticketPath);
    await staff
      .getByRole("navigation", { name: "entries pages" })
      .getByRole("button", { name: "Next", exact: true })
      .click();
    await staff
      .getByLabel("Internal note (required)")
      .fill("Internal diagnostic detail for support staff only (sample).");
    await staff
      .getByRole("button", { name: "Add internal note", exact: true })
      .click();
    await expect(
      staff.getByText(
        "Internal diagnostic detail for support staff only (sample).",
        { exact: true },
      ),
    ).toBeVisible();
    await staff
      .getByLabel("Requested change (required)")
      .fill("Review the website configuration manually.");
    await staff.getByLabel("Cost in USD (required)").fill("0");
    await staff
      .getByLabel("Cost explanation (required)")
      .fill("Included support, no charge.");
    await staff
      .getByLabel("Data consequences explanation (required)")
      .fill("No customer data will be changed or deleted.");
    await staff
      .getByRole("button", { name: "Prepare proposal", exact: true })
      .click();
    await expect(
      staff.getByRole("heading", {
        name: "Proposed change · revision 1",
        exact: true,
      }),
    ).toBeVisible();
    await staff.screenshot({
      path: testInfo.outputPath("support-staff-proposal-1280.png"),
      fullPage: true,
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(ticketPath);
    await expect(page.getByLabel("Internal note (required)")).toHaveCount(0);
    await page
      .getByRole("navigation", { name: "entries pages" })
      .getByRole("button", { name: "Next", exact: true })
      .click();
    await expect(
      page.getByRole("navigation", { name: "entries pages" }),
    ).toContainText("51–51 of 51 entries");
    await expect(
      page.getByText(
        "Internal diagnostic detail for support staff only (sample).",
        { exact: true },
      ),
    ).toHaveCount(0);
    await page
      .getByRole("button", { name: "Approve revision 1", exact: true })
      .click();
    await expect(
      page.getByText("Revision approved.", { exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("support-customer-approved-390.png"),
      fullPage: true,
    });

    await staff.goto(ticketPath);
    await staff
      .getByLabel("Requested change (required)")
      .fill("Verify the website configuration manually, then report findings.");
    await staff.getByLabel("Cost in USD (required)").fill("0");
    await staff
      .getByLabel("Cost explanation (required)")
      .fill("Included support, no charge.");
    await staff
      .getByLabel("Data consequences explanation (required)")
      .fill("No customer data will be changed or deleted.");
    // A real concurrent reply forces review while preserving the staff's drafted revision.
    const latest: TicketResponse = await (
      await page.request.get(apiPath)
    ).json();
    const concurrent = await page.request.post(`${apiPath}/replies`, {
      headers: { origin },
      data: {
        requestId: crypto.randomUUID(),
        expectedVersion: latest.ticket.version,
        body: "Please include the findings in your result (sample).",
      },
    });
    expect(concurrent.ok()).toBe(true);
    await staff
      .getByRole("button", { name: "Save new revision", exact: true })
      .click();
    await expect(
      staff.getByRole("button", { name: "Reload and review", exact: true }),
    ).toBeVisible();
    await expect(staff.getByLabel("Requested change (required)")).toHaveValue(
      "Verify the website configuration manually, then report findings.",
    );
    await staff
      .getByRole("button", { name: "Reload and review", exact: true })
      .click();
    await expect(
      staff.getByRole("button", { name: "Save new revision", exact: true }),
    ).toBeEnabled();
    await staff
      .getByRole("button", { name: "Save new revision", exact: true })
      .click();
    await expect(
      staff.getByRole("heading", {
        name: "Proposed change · revision 2",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      staff.getByRole("option", {
        name: "Completed approved change",
        exact: true,
      }),
    ).toHaveJSProperty("disabled", true);

    await page.goto(ticketPath);
    current = await (await page.request.get(apiPath)).json();
    expect(current.latestProposal?.approval).toBeNull();
    const approvalRequest = page.waitForRequest(
      (request) =>
        request.url().endsWith(`${ticketPath}/approvals`) &&
        request.method() === "POST",
    );
    await page
      .getByRole("button", { name: "Approve revision 2", exact: true })
      .click();
    const approvalInput: ApproveRequest = (
      await approvalRequest
    ).postDataJSON();
    expect(approvalInput).toMatchObject({
      proposalId: current.latestProposal!.id,
      proposalVersion: 2,
      expectedVersion: current.ticket.version,
    });
    await expect(
      page.getByText("Revision approved.", { exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);

    await staff.goto(ticketPath);
    await staff.getByLabel("Result", { exact: true }).selectOption("completed");
    await staff
      .getByLabel("Verification details (required)")
      .fill(
        "Configuration reviewed manually. Findings verified with the customer (sample).",
      );
    await staff.clock.setFixedTime(new Date(Date.now() + 3_600_000));
    await staff
      .getByRole("button", { name: "Use current time", exact: true })
      .click();
    await expect(
      staff.getByLabel("Verified at", { exact: true }),
    ).toBeVisible();
    await staff
      .getByLabel("Verified at", { exact: true })
      .fill("2020-01-01T12:00");
    await expect(
      staff.getByRole("button", { name: "Use current time", exact: true }),
    ).toHaveAttribute("aria-pressed", "false");
    await staff
      .getByRole("button", { name: "Use current time", exact: true })
      .click();
    await expect(
      staff.getByText(
        "The server records the time when you submit the result.",
        { exact: true },
      ),
    ).toBeVisible();
    const resultRequest = staff.waitForRequest(
      (request) =>
        request.url().endsWith(`${ticketPath}/result`) &&
        request.method() === "POST",
    );
    const resultResponse = staff.waitForResponse(
      (response) =>
        response.url().endsWith(`${ticketPath}/result`) &&
        response.request().method() === "POST",
    );
    await staff
      .getByRole("button", { name: "Record result and resolve", exact: true })
      .click();
    const resultInput: RecordResultRequest = (
      await resultRequest
    ).postDataJSON();
    expect(resultInput.verifiedAt).toBe("now");
    expect((await resultResponse).status()).toBe(200);
    await expect(staff.getByText("Resolved", { exact: true })).toBeVisible();
    expect(
      await staff.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.goto(ticketPath);
    await page
      .getByRole("navigation", { name: "entries pages" })
      .getByRole("button", { name: "Next", exact: true })
      .click();
    await expect(
      page.getByText(
        "Configuration reviewed manually. Findings verified with the customer (sample).",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      page.getByText(
        "Internal diagnostic detail for support staff only (sample).",
        { exact: true },
      ),
    ).toHaveCount(0);
    await page
      .getByLabel("Reply (required)")
      .fill("One more question about the findings (sample).");
    await page
      .getByRole("button", { name: "Reply and reopen", exact: true })
      .click();
    await expect(page.getByText("Open", { exact: true })).toBeVisible();
    await page
      .getByRole("link", { name: "Support requests", exact: true })
      .click();
    await expect(
      page.getByRole("link", {
        name: "Review Elm website configuration (sample)",
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.getByText("Open", { exact: true })).toBeVisible();
  } finally {
    await staffContext.close();
  }
});
