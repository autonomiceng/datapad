import { expect, test } from "@playwright/test";

test("invoice navigation supports an empty local database and missing detail", async ({
  page,
}) => {
  await page.clock.install();
  let detailRequests = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/billing/invoices/"))
      detailRequests++;
  });
  await page.goto("/");
  await page.getByRole("link", { name: "Invoices", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Invoices", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("No invoices yet.", { exact: true }),
  ).toBeVisible();
  await page.goto("/invoices?invoiceId=00000000-0000-4000-8000-000000000000");
  await expect(page.getByRole("alert")).toContainText("Invoice not found");
  await page.clock.runFor(15000);
  expect(detailRequests).toBe(1);
  detailRequests = 0;
  await page.goto("/invoices?invoiceId=invalid");
  await expect(page.getByRole("alert")).toContainText(
    "Invalid invoice request",
  );
  await page.clock.runFor(15000);
  expect(detailRequests).toBe(1);
});
