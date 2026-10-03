import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { signIn, inbox } from "../portal-browser/helpers";
import type {
  CustomerResponse,
  CustomersResponse,
} from "../../src/customers/contract";
import type {
  PrepareInvoiceRequest,
  PrepareInvoiceResponse,
  InvoicePreparationOptionsResponse,
} from "../../src/billing/contract";
import type { InvoiceNoticesResponse } from "../../src/notifications/contract";

test("invoice email reaches the local inbox with the exact staff preview and customer payment link", async ({
  page,
}) => {
  await signIn(page, "staff@example.test");
  const headers = { origin: process.env.TEST_BASE_URL! };
  const customers: CustomersResponse = await (
    await page.request.get("/api/customers")
  ).json();
  const customerId = customers.customers.find((customer) =>
    customer.displayName.startsWith("Elm Studio"),
  )!.id;
  const path = `/api/customers/${customerId}`;
  let { customer }: CustomerResponse = await (
    await page.request.get(path)
  ).json();
  if (customer.profile.billingEmail !== "billing-elm@example.test") {
    const updated = await page.request.patch(path, {
      headers,
      data: {
        requestId: randomUUID(),
        expectedVersion: customer.version,
        profile: {
          ...customer.profile,
          billingEmail: "billing-elm@example.test",
        },
      },
    });
    expect(updated.ok()).toBe(true);
    ({ customer } = await updated.json());
  }
  const artifact = join(
    process.env.PORTAL_NOTICE_TEST_ARTIFACTS!,
    "notice-delivery-request.json",
  );
  let request: PrepareInvoiceRequest;
  try {
    request = JSON.parse(await readFile(artifact, "utf8"));
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "ENOENT"
    )
      throw error;
    const choices: InvoicePreparationOptionsResponse = await (
      await page.request.get(`${path}/invoice-options`)
    ).json();
    request = {
      requestId: randomUUID(),
      expectedCustomerVersion: customer.version,
      dueDate: choices.dueDate,
      currency: "USD",
      lines: [{ description: "Web hosting", amountMinor: 2300 }],
    };
    // Persist identity before preparing, so a rerun observes the same invoice.
    await writeFile(artifact, JSON.stringify(request), {
      mode: 0o600,
      flag: "wx",
    });
  }
  const prepared = await page.request.post(`${path}/invoices`, {
    headers,
    data: request,
  });
  expect(prepared.ok()).toBe(true);
  const preparation: PrepareInvoiceResponse = await prepared.json();
  const invoiceId = preparation.invoice.id;
  const invoicePath = `${path}/invoices/${invoiceId}`;
  const issued = await page.request.post(`${invoicePath}/issue`, {
    headers,
    data: {},
  });
  expect(issued.ok()).toBe(true);
  let notices: InvoiceNoticesResponse | undefined;
  await expect
    .poll(
      async () => {
        const response = await page.request.get(`${invoicePath}/notices`);
        expect(response.ok()).toBe(true);
        notices = await response.json();
        return notices!.notices.find((notice) => notice.stage === "invoice")
          ?.state;
      },
      { timeout: 60000 },
    )
    .toBe("accepted");
  const sent = notices!.notices.find((notice) => notice.stage === "invoice")!;
  expect(sent.recipient).toBe("billing-elm@example.test");
  expect(sent.attempts).toBe(1);
  expect(sent.previewKind).toBe("stamped");
  const capturePath = join(
    process.env.PORTAL_NOTICE_TEST_ARTIFACTS!,
    "notice-mailpit-capture.json",
  );
  type CapturedMessage = {
    Text: string;
    HTML: string;
    MessageID: string;
    Subject: string;
    To: { Address: string }[];
  };
  let matching: CapturedMessage | undefined;
  try {
    // Mailpit is disposable; preserve its actual receipt before any later browser assertion.
    matching = JSON.parse(await readFile(capturePath, "utf8"));
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "ENOENT"
    )
      throw error;
    const mailbox = await (
      await page.request.get(`${inbox}/api/v1/messages`)
    ).json();
    for (const item of mailbox.messages.filter(
      (message: { Subject: string; To: { Address: string }[] }) =>
        message.Subject === sent.preview!.subject &&
        message.To.some((to) => to.Address === sent.recipient),
    )) {
      const message: CapturedMessage = await (
        await page.request.get(`${inbox}/api/v1/message/${item.ID}`)
      ).json();
      if (message.Text.includes(invoiceId)) {
        expect(matching).toBeUndefined();
        matching = message;
      }
    }
    expect(matching).toBeDefined();
    await writeFile(capturePath, JSON.stringify(matching), {
      flag: "wx",
      mode: 0o600,
    });
  }
  expect(matching!.MessageID.replace(/^<|>$/g, "")).toBe(
    sent.messageId!.replace(/^<|>$/g, ""),
  );
  expect(matching!.Subject).toBe(sent.preview!.subject);
  expect(matching!.To.map((to) => to.Address)).toEqual([sent.recipient]);
  expect(matching!.Text.replace(/\r\n/g, "\n").trim()).toBe(
    sent.preview!.text.trim(),
  );
  expect(matching!.Text).toContain("$23.00 USD");
  const paymentLink = matching!.Text.match(
    /View invoice: (https?:\/\/\S+)/,
  )?.[1];
  expect(paymentLink).toBeTruthy();
  await page.goto(`/customers/${customerId}/invoices/${invoiceId}/review`);
  await expect(
    page.getByRole("heading", { name: "Notices", exact: true }),
  ).toBeVisible();
  await page.getByText("Message", { exact: true }).click();
  await expect(
    page.getByText(sent.preview!.subject, { exact: true }),
  ).toBeVisible();
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: join(
        process.env.PORTAL_NOTICE_TEST_ARTIFACTS!,
        `notice-preview-${width}.png`,
      ),
      fullPage: true,
    });
  }
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await signIn(page, "elm-admin@example.test");
  expect((await page.request.get(`${invoicePath}/notices`)).status()).toBe(403);
  await page.goto(`/invoices?invoiceId=${invoiceId}`);
  await expect(
    page.getByRole("button", { name: "Pay invoice", exact: true }),
  ).toBeVisible();
  // Exercise the link captured from the actual email. Provider checks can refresh signed URLs.
  await page.goto(paymentLink!);
  await page.waitForURL((url) => url.origin === "https://invoice.stripe.com");
  expect(new URL(page.url()).pathname).toContain("/test_");
  await expect(
    page.getByRole("heading", { name: "$23.00", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("cell", { name: customer.profile.displayName, exact: true }),
  ).toBeVisible();
});
