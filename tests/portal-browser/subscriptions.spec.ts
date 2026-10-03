import { expect, test } from "@playwright/test";
import type {
  SubscriptionOptionsResponse,
  SubscriptionResponse,
} from "../../src/billing/subscriptions-contract";
import { signIn } from "./helpers";

test("billing staff creates and generates an agreement, schedules future terms, and customers read it at desktop and narrow widths", async ({
  page,
}) => {
  await signIn(page, "staff@example.test");
  await page.getByRole("link", { name: /^Elm Studio/ }).click();
  const customerPath = new URL(page.url()).pathname;
  await page.getByRole("link", { name: "Subscriptions", exact: true }).click();
  const response = await page.request.get(
    `/api${customerPath}/subscription-options`,
  );
  expect(response.ok()).toBe(true);
  const options: SubscriptionOptionsResponse = await response.json();
  const manual = options.choices.find(
    (choice) =>
      choice.serviceId !== null &&
      choice.amountMinor === 2300 &&
      choice.intervalMonths === 1 &&
      choice.paymentArrangement === "manual",
  );
  if (!manual)
    throw new Error(
      "Composition must offer the reviewed monthly manual hosting choice.",
    );
  const automatic = options.choices.find(
    (choice) =>
      choice.serviceId === manual.serviceId &&
      choice.label === manual.label &&
      choice.intervalMonths === manual.intervalMonths &&
      choice.amountMinor === manual.amountMinor &&
      choice.paymentArrangement === "automatic",
  );
  if (!automatic)
    throw new Error(
      "Composition must offer automatic terms for the same hosting agreement.",
    );
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page
    .getByRole("combobox", { name: "Service", exact: true })
    .selectOption({ label: "Consulting" });
  await page
    .getByRole("combobox", { name: "Billing frequency", exact: true })
    .selectOption({ label: "Yearly" });
  await page
    .getByLabel("Service periods repeat from", { exact: true })
    .fill("2024-02-29");
  await page
    .getByLabel("Due dates repeat from", { exact: true })
    .fill("2024-02-29");
  let laterYear = Number(options.dueAnchorDate.slice(0, 4)) + 1;
  if (new Date(Date.UTC(laterYear, 1, 29)).getUTCMonth() === 1) laterYear++;
  const dueFrom = page.getByLabel("First unbilled due from", { exact: true });
  const dueThrough = page.getByLabel("First unbilled due through", {
    exact: true,
  });
  await dueFrom.fill(`${laterYear}-02-01`);
  await dueThrough.fill("");
  await expect(
    page.getByText("Enter a complete date.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Create subscription", exact: true }),
  ).toBeDisabled();
  await dueThrough.fill(`${laterYear + 4}-03-01`);
  await expect(
    page.getByRole("alert").filter({ hasText: "Search up to 36 months" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Create subscription", exact: true }),
  ).toBeDisabled();
  await dueThrough.fill(`${laterYear}-03-01`);
  const oldFirst = page.getByRole("combobox", {
    name: "First unbilled period",
    exact: true,
  });
  await expect(oldFirst.locator("option").nth(1)).toContainText(
    `due Feb 28, ${laterYear}`,
  );
  await oldFirst.selectOption({
    label: (await oldFirst.locator("option").nth(1).textContent())!,
  });
  await expect(
    page.getByLabel("Service periods repeat from", { exact: true }),
  ).toHaveValue("2024-02-29");
  await expect(
    page.getByLabel("Due dates repeat from", { exact: true }),
  ).toHaveValue("2024-02-29");
  await page
    .getByRole("button", { name: "Create subscription", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Consulting", exact: true }),
  ).toBeVisible();
  const oldResponse = await page.request.get(
    `/api${new URL(page.url()).pathname}`,
  );
  expect(oldResponse.ok()).toBe(true);
  const oldAgreement: SubscriptionResponse = await oldResponse.json();
  expect(oldAgreement.subscription).toMatchObject({
    periodAnchorDate: "2024-02-29",
    dueAnchorDate: "2024-02-29",
    intervalMonths: 12,
    firstUnbilledPeriodIndex: laterYear - 2024,
    firstUnbilled: { dueDate: `${laterYear}-02-28` },
  });
  await expect(
    page.getByRole("heading", { name: "Consulting", exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Subscriptions", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Service", exact: true })
    .selectOption({ label: manual.label });
  await page
    .getByRole("combobox", { name: "Billing frequency", exact: true })
    .selectOption({ label: "Monthly" });
  await page
    .getByRole("combobox", { name: "Price", exact: true })
    .selectOption({ label: "$23.00" });
  await page
    .getByRole("combobox", { name: "Payment arrangement", exact: true })
    .selectOption({ label: "Manual" });
  const first = page.getByRole("combobox", {
    name: "First unbilled period",
    exact: true,
  });
  await expect(first.locator("option").nth(1)).toBeAttached();
  const firstLabel = await first.locator("option").nth(1).textContent();
  if (!firstLabel)
    throw new Error("Expected a human service-period and due-date choice.");
  await first.selectOption({ label: firstLabel });
  await page
    .getByRole("button", { name: "Create subscription", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: manual.label, exact: true }),
  ).toBeVisible();
  const agreementPath = new URL(page.url()).pathname;
  const agreementResponse = await page.request.get(`/api${agreementPath}`);
  expect(agreementResponse.ok()).toBe(true);
  const agreement: SubscriptionResponse = await agreementResponse.json();
  await expect(
    page
      .locator(".subscription-facts")
      .getByText(`Due ${firstLabel.split(", due ")[1]}`, { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("alert").filter({ hasText: "Incomplete forecast" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Update forecast", exact: true })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: "Forecast updated" }),
  ).toBeVisible();
  await expect(
    page.getByRole("alert").filter({ hasText: "Incomplete forecast" }),
  ).toHaveCount(0);
  await expect(
    page
      .locator(".subscription-forecast")
      .getByText("$23.00", { exact: true })
      .first(),
  ).toBeVisible();
  await page
    .getByRole("combobox", { name: "Payment arrangement", exact: true })
    .selectOption({ label: "Automatic" });
  const effective = page.getByRole("combobox", {
    name: "Effective service period",
    exact: true,
  });
  await expect(effective.locator("option").nth(2)).toBeAttached();
  const effectiveLabel = await effective.locator("option").nth(2).textContent();
  if (!effectiveLabel) throw new Error("Expected a future service boundary.");
  await effective.selectOption({ label: effectiveLabel });
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  const upcoming = page.locator(".subscription-upcoming");
  await expect(
    upcoming.getByText(`Due ${effectiveLabel.split(", due ")[1]}`, {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    upcoming.getByText(`${manual.label}, $23.00 per month, automatic payment`, {
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("combobox", { name: "Change type", exact: true })
    .selectOption("pause_billing");
  await expect(
    page.getByText(/Paused periods are not billed later\./),
  ).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath("subscriptions-staff-desktop.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Sign in", exact: true }),
  ).toBeVisible();
  await signIn(page, "elm-admin@example.test");
  await page.goto(agreementPath);
  await expect(
    page.getByRole("heading", { name: manual.label, exact: true }),
  ).toBeVisible();
  await expect(
    page
      .locator(".subscription-facts")
      .getByText(`Due ${firstLabel.split(", due ")[1]}`, { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Save changes", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", {
      name: "Update forecast",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("combobox", { name: "Change type", exact: true }),
  ).toHaveCount(0);
  await page.goto(`${customerPath}/subscriptions`);
  await expect(
    page.getByRole("link", { name: manual.label, exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Create subscription", exact: true }),
  ).toHaveCount(0);
  const forecast = page.locator(".subscription-forecast");
  const forecastDue = agreement.subscription.firstUnbilled.dueDate;
  const initialFrom = await forecast
    .getByLabel("Due from", { exact: true })
    .inputValue();
  const initialThrough = await forecast
    .getByLabel("Due through", { exact: true })
    .inputValue();
  await forecast.getByLabel("Due from", { exact: true }).fill(forecastDue);
  await forecast.getByLabel("Due through", { exact: true }).fill(forecastDue);
  await forecast
    .getByRole("button", { name: "Show forecast", exact: true })
    .click();
  await expect(forecast.locator(".subscription-group")).toHaveCount(1);
  const filteredGroups = await forecast
    .locator(".subscription-groups")
    .innerText();
  await page.getByRole("link", { name: manual.label, exact: true }).click();
  await expect(
    page.getByRole("heading", { name: manual.label, exact: true }),
  ).toBeVisible();
  await page.goBack();
  await expect(forecast.getByLabel("Due from", { exact: true })).toHaveValue(
    forecastDue,
  );
  await expect(forecast.getByLabel("Due through", { exact: true })).toHaveValue(
    forecastDue,
  );
  await expect(forecast.locator(".subscription-groups")).toHaveText(
    filteredGroups,
    { useInnerText: true },
  );
  await page.goBack();
  await expect(forecast.getByLabel("Due from", { exact: true })).toHaveValue(
    initialFrom,
  );
  await expect(forecast.getByLabel("Due through", { exact: true })).toHaveValue(
    initialThrough,
  );
  await page.goForward();
  await expect(forecast.getByLabel("Due from", { exact: true })).toHaveValue(
    forecastDue,
  );
  await expect(forecast.getByLabel("Due through", { exact: true })).toHaveValue(
    forecastDue,
  );
  await expect(forecast.locator(".subscription-groups")).toHaveText(
    filteredGroups,
    { useInnerText: true },
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("link", { name: manual.label, exact: true }).click();
  await expect(page.getByText("Timezone", { exact: true })).toBeVisible();
  await expect(
    upcoming.getByText(`Due ${effectiveLabel.split(", due ")[1]}`, {
      exact: true,
    }),
  ).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath("subscriptions-customer-narrow.png"),
    fullPage: true,
  });
  expect(errors).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
