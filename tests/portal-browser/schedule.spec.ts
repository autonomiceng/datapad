import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

test("signed-in billing staff and customers see honest scheduling unavailability without activation controls in the credential-free portal", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await signIn(page, "staff@example.test");
  await page.getByRole("link", { name: /^Elm Studio/ }).click();
  const customerPath = new URL(page.url()).pathname;
  await page
    .getByRole("link", { name: "Invoice schedule", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Invoice schedule", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("Scheduling unavailable");
  const response = await page.request.get(
    `/api${customerPath}/billing-schedule`,
  );
  expect(response.status()).toBe(503);
  expect(response.headers()["cache-control"]).toBe("no-store");
  expect(await response.json()).toEqual({ code: "unavailable" });
  await expect(
    page.getByRole("button", {
      name: "Start invoicing",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Pause scheduled invoices", exact: true }),
  ).toHaveCount(0);
  await page.screenshot({
    path: test.info().outputPath("schedule-staff-desktop.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Sign in", exact: true }),
  ).toBeVisible();
  await signIn(page, "elm-admin@example.test");
  await page.goto(`${customerPath}/billing-schedule`);
  await expect(
    page.getByRole("heading", { name: "Invoice schedule", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("Scheduling unavailable");
  await expect(
    page.getByRole("button", {
      name: "Start invoicing",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", {
      name: "Resume scheduled invoices",
      exact: true,
    }),
  ).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("alert")).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath("schedule-customer-narrow.png"),
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});
