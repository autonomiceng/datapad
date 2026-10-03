import { expect, test } from "@playwright/test";
import { inbox, signIn } from "./helpers";

test("real mailbox sign-in scopes customer access, saves a profile, accepts an invitation and clears access after sign-out", async ({
  page,
}) => {
  // Remote HTTP previews lack randomUUID; secure getRandomValues is still available.
  await page.addInitScript(() => {
    Object.defineProperty(globalThis.crypto, "randomUUID", {
      value: undefined,
      configurable: true,
    });
  });
  const importRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/import-review/"))
      importRequests.push(request.url());
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Sign in", exact: true }),
  ).toBeVisible();
  const navigation = page.getByRole("navigation", { name: "Resources" });
  await expect(
    navigation.getByRole("link", { name: "Sign in", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Email address (required)")).toBeVisible();
  expect(importRequests).toEqual([]);
  let releaseSession: () => void = () => {};
  const sessionReady = new Promise<void>((resolve) => {
    releaseSession = resolve;
  });
  await page.route("**/api/access/session", async (route) => {
    await sessionReady;
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ code: "unavailable" }),
    });
  });
  await page.goto("/");
  await expect(page.getByRole("status")).toHaveText("Checking your session…");
  releaseSession();
  await expect(
    page.getByRole("heading", {
      name: "Account access unavailable",
      exact: true,
    }),
  ).toBeVisible();
  await page.unroute("**/api/access/session");
  await page
    .getByRole("button", { name: "Retry account access", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Sign in", exact: true }),
  ).toBeVisible();
  await page.goto("/import-review");
  await expect(page).toHaveURL(/\/sign-in$/);
  expect(importRequests).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    navigation.getByRole("link", { name: "Sign in", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await navigation.getByRole("link", { name: "Sign in", exact: true }).click();
  await signIn(page, "staff@example.test", false);
  await expect(page).toHaveURL(/\/customers$/);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/");
  await expect(page).toHaveURL(/\/customers$/);
  expect(importRequests).toEqual([]);
  await navigation
    .getByRole("link", { name: "Import review", exact: true })
    .click();
  await expect(page).toHaveURL(/\/import-review(?:\?|$)/);
  await expect(
    page.getByRole("heading", { name: "Import review", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("combobox", { name: "Data as of", exact: true }),
  ).toContainText("garden-002");
  await expect(
    page
      .getByRole("list", { name: "Customers", exact: true })
      .getByRole("button", { name: /Customer customer-elm/ }),
  ).toBeVisible();
  await navigation
    .getByRole("link", { name: "Customers", exact: true })
    .click();
  await expect(
    page.getByRole("link", { name: "Elm Studio (sample)", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Birch Works (sample)", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("link", { name: "Elm Studio (sample)", exact: true })
    .click();
  const customerPath = new URL(page.url()).pathname;
  await page
    .getByLabel("Display name (required)")
    .fill("Elm Studio Updated (sample)");
  await page.getByRole("button", { name: "Save profile", exact: true }).click();
  await expect(page.getByText("Profile saved.", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: "Elm Studio Updated (sample)",
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByLabel("Email address (required)")
    .fill("invitee@example.test");
  await page
    .getByRole("button", { name: "Invite member", exact: true })
    .click();
  await expect(
    page.getByText("invitee@example.test", { exact: true }),
  ).toBeVisible();
  let invitationMessageId: string | undefined;
  await expect
    .poll(async () => {
      const response = await page.request.get(`${inbox}/api/v1/messages`);
      const data = await response.json();
      invitationMessageId = data.messages.find(
        (message: {
          ID: string;
          Subject: string;
          To: Array<{ Address: string }>;
        }) =>
          message.Subject ===
            "Invitation to a Datapad sample customer account" &&
          message.To.some((to) => to.Address === "invitee@example.test"),
      )?.ID;
      return Boolean(invitationMessageId);
    })
    .toBe(true);
  const invitationMessage = await (
    await page.request.get(`${inbox}/api/v1/message/${invitationMessageId}`)
  ).json();
  const invitationLink = invitationMessage.Text.match(
    /https?:\/\/[^\s]+\/invitations\/[^\s]+/,
  )?.[0];
  if (!invitationLink) throw new Error("Expected a delivered invitation link.");
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Sign in", exact: true }),
  ).toBeVisible();
  expect((await page.request.get(`/api${customerPath}`)).status()).toBe(401);
  await signIn(page, "invitee@example.test");
  await expect(
    page.getByRole("link", { name: /^Elm Studio Updated \(sample\)/ }),
  ).toHaveCount(0);
  await page.goto(invitationLink);
  await page
    .getByRole("button", { name: "Accept invitation", exact: true })
    .click();
  await expect(page.getByText("Completed.", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "View customers", exact: true }).click();
  await expect(
    page.getByRole("link", { name: /^Elm Studio Updated \(sample\)/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Birch Works (sample)", exact: true }),
  ).toHaveCount(0);
  await expect(
    navigation.getByRole("link", { name: "Import review", exact: true }),
  ).toHaveCount(0);
  const staffImportRequestCount = importRequests.length;
  await page.goto("/import-review");
  await expect(page).toHaveURL(/\/customers$/);
  expect(importRequests).toHaveLength(staffImportRequestCount);
  await page.goto(customerPath);
  await expect(
    page.getByRole("button", { name: "Save profile", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Members", exact: true }),
  ).toHaveCount(0);
  expect((await page.request.get("/api/import-review/sources")).status()).toBe(
    403,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("heading", {
      name: "Elm Studio Updated (sample)",
      exact: true,
    }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Sign in", exact: true }),
  ).toBeVisible();
  await signIn(page, "outsider@example.test");
  expect((await page.request.get(`/api${customerPath}`)).status()).toBe(404);
  const invoices = await (
    await page.request.get("/api/billing/invoices")
  ).json();
  expect(invoices.total).toBe(0);
});
