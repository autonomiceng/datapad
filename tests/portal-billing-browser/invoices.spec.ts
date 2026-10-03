import { expect, test } from "@playwright/test";
import { Pool } from "pg";
import Stripe from "stripe";
import { signIn } from "../portal-browser/helpers";

test("staff issues a reviewed invoice and its customer sees a signed-webhook test payment", async ({
  page,
}) => {
  await signIn(page, "staff@example.test");
  await page.getByRole("link", { name: /^Elm Studio/ }).click();
  await page
    .getByRole("link", { name: "Prepare invoice", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Review invoice", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Issue invoice", exact: true }),
  ).toBeVisible();
  const invoiceId = new URL(page.url()).pathname.split("/").at(-2)!;
  const prepared = await (
    await page.request.get(`/api/billing/invoices/${invoiceId}`)
  ).json();
  expect(prepared.invoice.state).toBe("requested");
  expect(prepared.invoice.totalMinor).toBe(2300);
  expect(prepared.invoice.hostedInvoiceUrl).toBeNull();
  await page
    .getByRole("button", { name: "Issue invoice", exact: true })
    .click();
  await expect(page.getByRole("link", { name: /^Pay invoice/ })).toBeVisible({
    timeout: 60000,
  });
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Sign in", exact: true }),
  ).toBeVisible();
  await signIn(page, "elm-admin@example.test");
  await page.goto(`/invoices?invoiceId=${invoiceId}&offset=0`);
  const pay = page.getByRole("link", { name: /^Pay invoice/ });
  await expect(pay).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Issue invoice", exact: true }),
  ).toHaveCount(0);
  const opened = page.waitForEvent("popup");
  await pay.click();
  const hosted = await opened;
  await hosted.waitForLoadState("domcontentloaded");
  expect(new URL(hosted.url()).origin).toBe("https://invoice.stripe.com");
  await expect(hosted.getByText(/^Test Mode$/i)).toBeVisible();
  await expect(
    hosted.getByText("Elm Studio (sample)", { exact: true }),
  ).toBeVisible();
  await hosted.close();

  // Hosted card entry may require a provider challenge. This explicit sandbox
  // payment proves settlement and the real webhook, without claiming that UI path.
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const { rows } = await pool.query(
      "select provider_invoice_id, deployment_key from invoices where id=$1",
      [invoiceId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].deployment_key).toBe(process.env.BILLING_DEPLOYMENT_KEY);
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
    const invoice = await stripe.invoices.retrieve(rows[0].provider_invoice_id);
    expect(invoice.livemode).toBe(false);
    expect(invoice.metadata?.datapad_invoice).toBe(invoiceId);
    expect(invoice.metadata?.datapad_deployment).toBe(
      process.env.BILLING_DEPLOYMENT_KEY,
    );
    expect(invoice.status).toBe("open");
    expect(invoice.amount_remaining).toBe(2300);
    if (typeof invoice.customer !== "string")
      throw new Error("The sandbox invoice must identify its customer.");
    const method = await stripe.paymentMethods.attach(
      "pm_card_visa",
      { customer: invoice.customer },
      { idempotencyKey: `portal-acceptance-method:${invoiceId}` },
    );
    try {
      await stripe.invoices.pay(
        invoice.id,
        { payment_method: method.id },
        { idempotencyKey: `portal-acceptance:${invoiceId}` },
      );
    } finally {
      await stripe.paymentMethods.detach(method.id);
    }
    await expect
      .poll(
        async () => {
          const { rows } = await pool.query(
            "select count(*)::int as total from stripe_events where invoice_id=$1 and event_type='invoice.paid' and processed_at is not null",
            [invoiceId],
          );
          return rows[0].total;
        },
        { timeout: 60000 },
      )
      .toBeGreaterThan(0);
    await page.reload();
    await expect(page.getByText("Paid", { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: /^Pay invoice/ })).toHaveCount(
      0,
    );
    await expect(
      page.getByRole("link", { name: /^View invoice/ }),
    ).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  } finally {
    await pool.end();
  }
});
