import { expect, type Page } from "@playwright/test";

export const inbox = process.env.PORTAL_TEST_MAILPIT_URL!;
export async function signIn(page: Page, email: string, openSignIn = true) {
  const previous = await (
    await page.request.get(`${inbox}/api/v1/messages`)
  ).json();
  const previousIds = new Set(
    previous.messages.map((message: { ID: string }) => message.ID),
  );
  if (openSignIn) await page.goto("/sign-in");
  await page.getByLabel("Email address (required)").fill(email);
  await page.getByRole("button", { name: "Send sign-in link" }).click();
  await expect(page.getByRole("status")).toHaveText(
    "Check your inbox for a sign-in link.",
  );
  let messageId: string | undefined;
  await expect
    .poll(async () => {
      const response = await page.request.get(`${inbox}/api/v1/messages`);
      const data = await response.json();
      messageId = data.messages.find(
        (message: {
          ID: string;
          Subject: string;
          To: Array<{ Address: string }>;
        }) =>
          !previousIds.has(message.ID) &&
          message.Subject === "Sign in to the Datapad sample portal" &&
          message.To.some((to) => to.Address === email),
      )?.ID;
      return Boolean(messageId);
    })
    .toBe(true);
  const message = await (
    await page.request.get(`${inbox}/api/v1/message/${messageId}`)
  ).json();
  const link = message.Text.match(
    /https?:\/\/[^\s]+\/api\/auth\/magic-link\/verify[^\s]+/,
  )?.[0];
  if (!link) throw new Error("Expected a local sign-in message.");
  await page.goto(link);
  await expect(
    page.getByRole("heading", { name: "Customers", exact: true }),
  ).toBeVisible();
}
