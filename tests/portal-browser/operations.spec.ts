import { expect, test } from "@playwright/test";
import { signIn, inbox } from "./helpers";
import { bootstrapPortalEffects } from "../../scripts/portal-effects-bootstrap";
import type { BillingOperationsResponse } from "../../src/billing/operations-contract";

test("billing staff pause writes and a repeated synthetic startup preserves their decision", async ({
  page,
}, testInfo) => {
  await signIn(page, "staff@example.test");
  await page
    .getByRole("link", { name: "Billing operations", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Billing actions enabled", exact: true }),
  ).toBeVisible();
  await page
    .getByLabel("Reason (required)")
    .fill("Review the synthetic billing queue.");
  await page
    .getByRole("button", { name: "Pause billing actions", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Billing actions paused", exact: true }),
  ).toBeVisible();
  const paused: BillingOperationsResponse = await (
    await page.request.get("/api/billing/operations")
  ).json();
  await bootstrapPortalEffects({
    localOrigin: process.env.TEST_BASE_URL!,
    origin: process.env.TEST_BASE_URL!,
    inbox,
  });
  const after: BillingOperationsResponse = await (
    await page.request.get("/api/billing/operations")
  ).json();
  expect(after.control).toEqual(paused.control);
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`billing-operations-${width}.png`),
      fullPage: true,
    });
  }
  await page
    .getByLabel("Reason (required)")
    .fill("Resume the reviewed synthetic queue.");
  await page
    .getByRole("button", { name: "Resume billing actions", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Billing actions enabled", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Sign in", exact: true }),
  ).toBeVisible();
  expect((await page.request.get("/api/billing/operations")).status()).toBe(
    401,
  );
  await signIn(page, "elm-admin@example.test", false);
  expect((await page.request.get("/api/billing/operations")).status()).toBe(
    403,
  );
  await expect(
    page.getByRole("link", { name: "Billing operations", exact: true }),
  ).toHaveCount(0);
  await page.goto("/billing-operations");
  await expect(
    page.getByText("Billing staff access is required.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /billing actions$/ }),
  ).toHaveCount(0);
});
