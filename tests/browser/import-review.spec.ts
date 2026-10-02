import { expect, test } from "@playwright/test";
import type { CustomerResponse } from "../../src/import-review/contract";

test("review imported records and return to an isolated earlier import", async ({
  page,
}) => {
  let releaseSources: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    releaseSources = resolve;
  });
  await page.route("**/api/import-review/sources?*", async (route) => {
    await ready;
    await route.continue();
  });
  await page.goto("/");
  await expect(
    page.getByRole("status").filter({ hasText: "Loading sources…" }),
  ).toBeVisible();
  releaseSources();
  const captures = page.getByRole("combobox", { name: "Data as of" });
  const earlierCapture = await captures
    .getByRole("option", { name: /garden-001/ })
    .getAttribute("value");
  const laterCapture = await captures
    .getByRole("option", { name: /garden-002/ })
    .getAttribute("value");
  expect(earlierCapture).toBeTruthy();
  expect(laterCapture).toBeTruthy();
  await expect(captures).toHaveValue(laterCapture!);
  await page.unroute("**/api/import-review/sources?*");

  const helpSummary = page.locator("summary").filter({ hasText: /^Help$/ });
  const importSummary = page
    .locator("summary")
    .filter({ hasText: /^Import details$/ });
  const countsSummary = page
    .locator("summary")
    .filter({ hasText: /^Record counts$/ });
  const identifiersSummary = page
    .locator("summary")
    .filter({ hasText: /^Technical identifiers$/ });
  const helpDisclosure = helpSummary.locator("..");
  const importDisclosure = importSummary.locator("..");
  const countsDisclosure = countsSummary.locator("..");
  const identifiersDisclosure = identifiersSummary.locator("..");
  await helpSummary.click();
  await importSummary.click();
  await countsSummary.click();
  await identifiersSummary.click();
  const earlierCustomersLoaded = page.waitForResponse(
    `**/api/import-review/imports/${earlierCapture}/customers?*`,
  );
  await captures.selectOption(earlierCapture!);
  await earlierCustomersLoaded;
  await expect(importDisclosure).toContainText("garden-001");
  for (const disclosure of [
    helpDisclosure,
    importDisclosure,
    countsDisclosure,
    identifiersDisclosure,
  ]) {
    await expect(disclosure).toHaveJSProperty("open", true);
  }
  await identifiersSummary.press("Enter");
  // Keep Help open so the customer list requires scrolling on a tall screen.
  const firstCustomer = page
    .getByRole("list", { name: "Customers", exact: true })
    .getByRole("button", { name: /Customer customer-elm/ });
  await firstCustomer.scrollIntoViewIfNeeded();
  const customerScroll = await page.evaluate(() => window.scrollY);
  expect(customerScroll).toBeGreaterThan(0);
  await page
    .getByRole("list", { name: "Customers", exact: true })
    .getByRole("button", { name: /Customer customer-elm/ })
    .click();
  const detail = page.getByRole("region", {
    name: "Customer customer-elm",
    exact: true,
  });
  await expect(detail).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => window.scrollY))
    .toBe(customerScroll);
  await page.getByText("Help", { exact: true }).click();
  const selectedUrl = page.url();
  await page.getByRole("button", { name: "Record type help" }).click();
  await expect(
    page.getByRole("heading", { name: "Record types", exact: true }),
  ).toBeFocused();
  const definitions = page.getByRole("region", {
    name: "Record types",
    exact: true,
  });
  await expect(definitions.getByRole("term")).toHaveText([
    "Customer",
    "Service",
    "Add-on",
    "Domain",
  ]);
  await expect(definitions.getByRole("definition")).toHaveCount(4);
  await page.getByText("Help", { exact: true }).click();
  await expect(definitions).toBeHidden();
  await expect(page).toHaveURL(selectedUrl);
  await expect(
    detail.getByRole("heading", {
      name: "Customer customer-elm",
      level: 2,
      exact: true,
    }),
  ).toBeVisible();
  await page.getByText("Import details", { exact: true }).click();
  const services = detail.getByRole("table", {
    name: /^Services and add-ons \d+$/,
  });
  const hosting = services.getByRole("row").filter({
    has: page.getByRole("heading", { name: "elm.test", level: 4, exact: true }),
  });
  await expect(
    hosting.getByRole("heading", { name: "elm.test", level: 4, exact: true }),
  ).toBeVisible();
  await expect(hosting).toContainText("Product: Garden hosting");
  await expect(hosting).toContainText("USD 23.00 · Monthly");
  await expect(hosting.getByRole("time")).toHaveText([
    "2026-10-12",
    "2026-11-12",
  ]);
  const sourceIds = detail.getByRole("checkbox", {
    name: "Show source IDs",
    exact: true,
  });
  await expect(sourceIds).not.toBeChecked();
  await expect(
    hosting.getByText("Service hosting-elm", { exact: true }),
  ).toHaveCount(0);
  const attachedAddons = services.getByRole("rowgroup").filter({
    has: page.getByRole("heading", { name: "elm.test", level: 4, exact: true }),
  });
  const addon = attachedAddons.getByRole("row").filter({
    has: page.getByRole("heading", {
      name: "Storage add-on",
      level: 4,
      exact: true,
    }),
  });
  await expect(addon).toHaveCount(1);
  await expect(addon.getByRole("rowheader")).toContainText(
    "Add-on of elm.test",
  );
  await expect(addon).toContainText("USD -1.25 · Monthly");
  await expect(addon.getByRole("cell").nth(1)).toContainText(
    "Cancellation requested: Unknown",
  );
  const paused = services.getByRole("row").filter({ hasText: "paused.test" });
  await expect(paused.getByRole("cell").nth(1)).toContainText("Suspended");
  await expect(
    paused
      .getByRole("cell")
      .nth(1)
      .getByText("Cancellation requested", { exact: true }),
  ).toBeVisible();
  await expect(paused.getByRole("cell").nth(2)).toContainText("2026-02-30");
  await expect(
    paused.getByRole("cell").nth(2).getByText("Invalid date", { exact: true }),
  ).toBeVisible();
  await expect(
    services.getByRole("row").filter({ hasText: "Community hosting" }),
  ).toContainText("USD 0.00 · Free");
  const domain = detail.getByRole("table", { name: /^Domains \d+$/ });
  await expect(domain).toContainText("elm.test");
  await expect(domain.getByRole("rowheader")).toContainText("Term: 3 years");
  await expect(domain.getByRole("time")).toHaveText([
    "2026-10-15",
    "2029-10-15",
    "2026-10-20",
  ]);
  await sourceIds.check();
  await expect(
    hosting.getByText("Service hosting-elm", { exact: true }),
  ).toBeVisible();
  await expect(
    addon.getByText("Add-on hosting-elm", { exact: true }),
  ).toBeVisible();
  await expect(
    addon.getByText("Attached to service: hosting-elm", { exact: true }),
  ).toBeVisible();
  await expect(
    domain.getByText("Domain domain-elm", { exact: true }),
  ).toBeVisible();
  const dataIssues = page.getByRole("list", {
    name: "Data issues",
    exact: true,
  });
  await expect(dataIssues).toContainText("Missing related record");
  await expect(dataIssues).toContainText("hosting-orphan");
  await expect(dataIssues).toContainText("Unrecognized status");
  await expect(dataIssues).toContainText("Invalid date");
  const earlierUrl = page.url();

  await page
    .getByRole("list", { name: "Customers", exact: true })
    .getByRole("button", { name: /Customer customer-birch/ })
    .click();
  const emptyDetail = page.getByRole("region", {
    name: "Customer customer-birch",
    exact: true,
  });
  await expect(
    emptyDetail.getByText("No services or add-ons on this page."),
  ).toBeVisible();
  await expect(emptyDetail.getByText("No domains on this page.")).toBeVisible();
  await expect(
    emptyDetail.getByRole("checkbox", { name: "Show source IDs", exact: true }),
  ).toBeChecked();

  await captures.selectOption(laterCapture!);
  await expect(identifiersDisclosure).toHaveJSProperty("open", false);
  await page
    .getByRole("list", { name: "Customers", exact: true })
    .getByRole("button", { name: /Customer customer-elm/ })
    .click();
  await expect(hosting).toContainText("USD 27.00 · Monthly");
  await expect(sourceIds).toBeChecked();
  await expect(hosting.getByRole("time")).toHaveText([
    "2026-10-12",
    "2026-12-12",
  ]);
  await expect(paused.getByRole("cell").nth(1)).not.toContainText(
    "Cancellation requested",
  );

  await captures.selectOption(earlierCapture!);
  await page
    .getByRole("list", { name: "Customers", exact: true })
    .getByRole("button", { name: /Customer customer-elm/ })
    .click();
  await expect(hosting).toContainText("USD 23.00 · Monthly");
  await expect(sourceIds).toBeChecked();
  await expect(hosting.getByRole("time")).toHaveText([
    "2026-10-12",
    "2026-11-12",
  ]);
  await expect(
    paused
      .getByRole("cell")
      .nth(1)
      .getByText("Cancellation requested", { exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(earlierUrl);
  await page.reload();
  await expect(hosting).toContainText("USD 23.00 · Monthly");
  await expect(sourceIds).not.toBeChecked();

  // Keep records whose attached service cannot be shown visible within the same page.
  await page.route(
    `**/api/import-review/imports/${earlierCapture}/customers/customer-elm?*`,
    async (route) => {
      const response = await route.fetch();
      const data: CustomerResponse = await response.json();
      const observedAddon = data.services.items.find(
        (service) => service.recordType === "addon",
      );
      if (!observedAddon) throw new Error("Expected the sample storage add-on");
      data.services.items.push(
        {
          ...observedAddon,
          sourceRecordId: "addon-unknown",
          attachedService: null,
        },
        {
          ...observedAddon,
          sourceRecordId: "addon-unavailable",
          attachedService: {
            recordType: "service",
            sourceRecordId: "service-not-shown",
          },
        },
      );
      data.services.total = data.services.items.length;
      await route.fulfill({ response, json: data });
    },
    { times: 1 },
  );
  await page.reload();
  const otherAddons = detail.getByRole("table", {
    name: "Other add-ons",
    exact: true,
  });
  await expect(otherAddons.getByRole("rowheader")).toHaveCount(2);
  await expect(addon).toHaveCount(1);
  await expect(services.getByRole("rowheader")).toHaveCount(4);
  await expect(
    detail.getByRole("heading", {
      name: "Services and add-ons 6",
      exact: true,
    }),
  ).toBeVisible();
  const unknownAddon = otherAddons
    .getByRole("row")
    .filter({ hasText: "Attached service unknown" });
  await expect(
    unknownAddon.getByText("Attached service unknown", { exact: true }),
  ).toBeVisible();
  const unavailableAddon = otherAddons
    .getByRole("row")
    .filter({ hasText: "Attached service is not shown here." });
  await expect(
    unavailableAddon.getByText(
      "Attached service is not shown here. Check Data issues.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    unavailableAddon.getByText("Attached to service: service-not-shown", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(unavailableAddon).not.toContainText("other pages");
  await expect(unavailableAddon).not.toContainText("Missing related record");
  await sourceIds.check();
  await expect(
    unknownAddon.getByText("Add-on addon-unknown", { exact: true }),
  ).toBeVisible();
  await expect(
    unavailableAddon.getByText("Add-on addon-unavailable", { exact: true }),
  ).toBeVisible();

  await page.route("**/api/import-review/sources?*", (route) =>
    route.abort("failed"),
  );
  await page.reload();
  await expect(page.getByRole("alert")).toHaveText(
    "Could not reach the server. Check your connection and try again.",
  );
  await page.unroute("**/api/import-review/sources?*");
  await page
    .getByRole("button", { name: "Retry sources", exact: true })
    .click();
  await expect(
    page.getByText("synthetic-garden", { exact: true }),
  ).toBeVisible();
  await expect(hosting).toContainText("USD 23.00 · Monthly");
});
