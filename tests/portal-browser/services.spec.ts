import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

test("staff records independent preferences and add-on attachment while customers retain read-only access", async ({
  page,
}) => {
  await signIn(page, "staff@example.test");
  await page.getByRole("link", { name: /^Elm Studio/ }).click();
  const customerPath = new URL(page.url()).pathname;
  await page.getByRole("link", { name: "Services", exact: true }).click();
  await page.getByRole("link", { name: "elm.test", exact: true }).click();
  const hostingPath = new URL(page.url()).pathname;
  await expect(
    page.getByText("Aliases: www.elm.test", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("shop.elm.test", { exact: true })).toBeVisible();
  await expect(
    page.getByText("External mail provider (sample)", { exact: true }),
  ).toBeVisible();
  const requested = page.getByLabel("Requested setting for Web hosting", {
    exact: true,
  });
  await requested.selectOption("disabled");
  await page
    .locator("form")
    .filter({ has: requested })
    .getByRole("button", { name: "Save preference", exact: true })
    .click();
  await expect(
    page.getByText("Saved. The provider has not been changed.", {
      exact: true,
    }),
  ).toBeVisible();
  const persisted = await (await page.request.get(`/api${hostingPath}`)).json();
  expect(
    persisted.service.components.find(
      (component: { kind: string }) => component.kind === "web",
    ),
  ).toMatchObject({ requestedSetting: "disabled", providerState: "enabled" });
  expect(
    persisted.service.components.find(
      (component: { kind: string; delivery: string }) =>
        component.kind === "email" && component.delivery === "external",
    ),
  ).toMatchObject({ requestedSetting: null, providerState: "enabled" });
  await page.getByRole("link", { name: "Services", exact: true }).click();
  await page.getByRole("link", { name: "Backup storage", exact: true }).click();
  const addonPath = new URL(page.url()).pathname;
  await page
    .getByRole("combobox", { name: "Attach to existing service", exact: true })
    .selectOption({ label: "elm.test (Hosting)" });
  await page
    .getByRole("button", { name: "Save attachment", exact: true })
    .click();
  await expect(
    page.getByText("Saved. Billing has not been changed.", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Detach add-on", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Detach add-on", exact: true }),
  ).toHaveCount(0);
  const detached = await (await page.request.get(`/api${addonPath}`)).json();
  expect(detached.service.attachedService).toBeNull();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Sign in", exact: true }),
  ).toBeVisible();
  await signIn(page, "elm-admin@example.test");
  await page.goto(hostingPath);
  await expect(
    page.getByRole("heading", { name: "elm.test", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Save preference", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText("Extra storage", { exact: true })).toBeVisible();
  const foreignOrigin = await page.request.patch(
    `/api${hostingPath}/components/${persisted.service.components[0].id}/preference`,
    {
      headers: { origin: "https://untrusted.example.test" },
      data: {
        requestId: crypto.randomUUID(),
        expectedVersion: 1,
        requestedSetting: "enabled",
      },
    },
  );
  expect(foreignOrigin.status()).toBe(403);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.goto(`${customerPath}/services`);
  await page
    .getByRole("link", { name: "elm-domain.test", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Registration", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Save attachment", exact: true }),
  ).toHaveCount(0);
});
