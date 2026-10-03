import { randomUUID } from "node:crypto";
import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Temporal } from "@js-temporal/polyfill";
import { expect, test } from "@playwright/test";
import { Pool } from "pg";
import Stripe from "stripe";
import type { InvoiceResponse } from "../../src/billing/contract";
import type {
  ScheduleResponse,
  ScheduledGroupsResponse,
} from "../../src/billing/scheduled-contract";
import type {
  CreateSubscriptionResponse,
  SubscriptionOptionsResponse,
  SubscriptionsResponse,
} from "../../src/billing/subscriptions-contract";
import type { CustomersResponse } from "../../src/customers/contract";
import { signIn } from "../portal-browser/helpers";

test("scheduled sandbox issuance retains a grouped free line and a final No charge outcome", async ({
  page,
}) => {
  test.setTimeout(240000);
  const planPath = process.env.PORTAL_SCHEDULE_TEST_PLAN!;
  const clockPath = process.env.PORTAL_SCHEDULE_TEST_CLOCK!;
  const plan: {
    timeZone: string;
    clockBefore: string;
    clockAfter: string;
    dueDate: string;
  } = JSON.parse(await readFile(planPath, "utf8"));
  expect(plan.timeZone).toBe(process.env.PORTAL_DEMO_TIME_ZONE);
  expect(JSON.parse(await readFile(clockPath, "utf8"))).toBe(plan.clockBefore);
  const artifacts = dirname(planPath);
  const origin = new URL(process.env.TEST_BASE_URL!).origin;
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
  const get = async <T>(path: string): Promise<T> => {
    const response = await page.request.get(path);
    expect(response.ok()).toBe(true);
    return response.json();
  };
  const groups = (customerId: string) =>
    get<ScheduledGroupsResponse>(
      `/api/customers/${customerId}/scheduled-groups?fromDueDate=${plan.dueDate}&throughDueDate=${plan.dueDate}&limit=100&offset=0`,
    );
  const schedule = (customerId: string) =>
    get<ScheduleResponse>(`/api/customers/${customerId}/billing-schedule`);
  const providerInvoices = async (customer: string | null) => {
    if (!customer) return [];
    const result = await stripe.invoices.list({ customer, limit: 100 });
    expect(result.has_more).toBe(false);
    return result.data;
  };
  const birchState = async (customerId: string) => {
    const { rows } = await pool.query<{
      provider_customer_id: string | null;
      invoice_count: number;
    }>(
      `select b.provider_customer_id, (select count(*)::int from invoices i
        where i.billing_customer_id=b.id) as invoice_count
        from billing_customers b where b.customer_id=$1 and b.deployment_key=$2`,
      [customerId, process.env.BILLING_DEPLOYMENT_KEY],
    );
    expect(rows.length).toBeLessThanOrEqual(1);
    return {
      rows,
      providerIds: (
        await providerInvoices(rows[0]?.provider_customer_id ?? null)
      )
        .map((invoice) => invoice.id)
        .sort(),
    };
  };
  try {
    await signIn(page, "staff@example.test");
    const customers = await get<CustomersResponse>(
      "/api/customers?limit=100&offset=0",
    );
    expect(customers.total).toBe(customers.customers.length);
    const elmMatches = customers.customers.filter((c) =>
      c.displayName.startsWith("Elm Studio"),
    );
    const birchMatches = customers.customers.filter((c) =>
      c.displayName.startsWith("Birch Works"),
    );
    expect(elmMatches).toHaveLength(1);
    expect(birchMatches).toHaveLength(1);
    const elm = elmMatches[0]!;
    const birch = birchMatches[0]!;
    const subscriptionIds: string[] = [];
    for (const [customer, fixtures] of [
      [
        elm,
        [
          ["Storage add-on", 500],
          ["Web hosting", 0],
        ],
      ],
      [birch, [["Web hosting", 0]]],
    ] as const) {
      const path = `/api/customers/${customer.id}`;
      const options = await get<SubscriptionOptionsResponse>(
        `${path}/subscription-options`,
      );
      expect(options.calendar).toMatchObject({
        timeZone: plan.timeZone,
        issueHour: 9,
      });
      for (const [label, amountMinor] of fixtures) {
        const choices = options.choices.filter(
          (choice) =>
            choice.label === label &&
            choice.amountMinor === amountMinor &&
            choice.intervalMonths === 1 &&
            choice.paymentArrangement === "manual",
        );
        expect(choices).toHaveLength(1);
        const choice = choices[0]!;
        const listed = await get<SubscriptionsResponse>(
          `${path}/subscriptions?limit=100&offset=0`,
        );
        expect(listed.total).toBe(listed.subscriptions.length);
        const matches = listed.subscriptions.filter(
          (subscription) =>
            subscription.serviceId === choice.serviceId &&
            subscription.periodAnchorDate === plan.dueDate &&
            subscription.dueAnchorDate === plan.dueDate,
        );
        expect(matches.length).toBeLessThanOrEqual(1);
        let subscription = matches[0];
        if (!subscription) {
          const response = await page.request.post(`${path}/subscriptions`, {
            headers: { origin },
            data: {
              requestId: randomUUID(),
              ...choice,
              periodAnchorDate: plan.dueDate,
              dueAnchorDate: plan.dueDate,
              firstUnbilledPeriodIndex: 0,
            },
          });
          expect(response.ok()).toBe(true);
          const created: CreateSubscriptionResponse = await response.json();
          subscription = created.subscription;
        }
        expect(subscription).toMatchObject({
          ...choice,
          firstUnbilledPeriodIndex: 0,
          billingState: "billable",
          calendar: options.calendar,
        });
        subscriptionIds.push(subscription.id);
        const current = await schedule(customer.id);
        const activation = current.schedule.activations.find(
          (a) => a.subscriptionId === subscription.id,
        );
        if (activation) {
          expect(activation.activationFromPeriodIndex).toBe(0);
          expect(activation.firstPeriod.dueDate).toBe(plan.dueDate);
        } else {
          await page.goto(`/customers/${customer.id}/billing-schedule`);
          await page
            .getByRole("combobox", { name: /^Subscription/ })
            .selectOption(subscription.id);
          await page
            .getByLabel("Activation due from", { exact: true })
            .fill(plan.dueDate);
          await page
            .getByLabel("Activation due through", { exact: true })
            .fill(plan.dueDate);
          const boundary = page.getByRole("combobox", {
            name: /^First activated service period/,
          });
          await expect(boundary.locator('option[value="0"]')).toHaveCount(1);
          await boundary.selectOption("0");
          await page
            .getByRole("button", { name: "Start invoicing", exact: true })
            .click();
          await expect
            .poll(async () =>
              (await schedule(customer.id)).schedule.activations.some(
                (a) => a.subscriptionId === subscription.id,
              ),
            )
            .toBe(true);
        }
      }
    }
    const before = await groups(elm.id);
    expect(before.total).toBe(1);
    const freeBefore = await groups(birch.id);
    expect(freeBefore.total).toBe(1);
    const birchBefore = await birchState(birch.id);
    await page.goto(`/customers/${elm.id}/billing-schedule`);
    if ((await schedule(elm.id)).schedule.issuancePaused) {
      await page
        .getByRole("button", { name: "Resume scheduled invoices", exact: true })
        .click();
      await expect
        .poll(async () => (await schedule(elm.id)).schedule.issuancePaused)
        .toBe(false);
    }
    await page
      .getByRole("button", { name: "Pause scheduled invoices", exact: true })
      .click();
    await expect
      .poll(async () => (await schedule(elm.id)).schedule.issuancePaused)
      .toBe(true);
    expect((await groups(elm.id)).groups[0]?.id).toBe(before.groups[0]?.id);
    await page
      .getByRole("button", { name: "Resume scheduled invoices", exact: true })
      .click();
    await expect
      .poll(async () => (await schedule(elm.id)).schedule.issuancePaused)
      .toBe(false);
    expect((await groups(elm.id)).groups[0]?.id).toBe(before.groups[0]?.id);

    // Only the dedicated test process reads this private clock. Financial dates
    // stay fixed, and the captured final instant is actual wall time.
    await writeFile(`${clockPath}.next`, JSON.stringify(plan.clockAfter), {
      mode: 0o600,
    });
    await rename(`${clockPath}.next`, clockPath);
    await expect
      .poll(async () => (await groups(elm.id)).groups[0]?.invoice?.state, {
        timeout: 90000,
      })
      .toBe("open");
    await expect
      .poll(async () => (await groups(birch.id)).groups[0]?.outcome, {
        timeout: 60000,
      })
      .toBe("no_charge");
    const issued = await groups(elm.id);
    const free = await groups(birch.id);
    expect(issued.total).toBe(1);
    expect(free.total).toBe(1);
    const paidGroup = issued.groups[0]!;
    const freeGroup = free.groups[0]!;
    expect(paidGroup).toMatchObject({
      kind: "sealed",
      outcome: "invoice_requested",
      totalMinor: 500,
      dueDate: plan.dueDate,
    });
    expect(
      paidGroup.periods.map((p) => p.amountMinor).sort((a, b) => a - b),
    ).toEqual([0, 500]);
    expect(freeGroup).toMatchObject({
      kind: "sealed",
      outcome: "no_charge",
      totalMinor: 0,
      invoice: null,
    });
    expect(freeGroup.periods).toHaveLength(1);
    expect(freeGroup.id).not.toBeNull();
    if (freeBefore.groups[0]?.id)
      expect(freeGroup.id).toBe(freeBefore.groups[0].id);
    expect(await birchState(birch.id)).toEqual(birchBefore);
    if (before.groups[0]?.id) {
      expect(paidGroup.id).toBe(before.groups[0].id);
      expect(paidGroup.invoice?.id).toBe(before.groups[0].invoice?.id);
    }
    const invoiceId = paidGroup.invoice!.id;
    const detail = await get<InvoiceResponse>(
      `/api/billing/invoices/${invoiceId}`,
    );
    expect(detail.invoice.providerReceipt.state).toBe("verified");
    expect(detail.invoice.calendar?.timeZone).toBe(plan.timeZone);
    expect(
      detail.invoice.lines
        .map((line) => line.amountMinor)
        .sort((a, b) => a - b),
    ).toEqual([0, 500]);
    const { rows } = await pool.query<{
      provider_invoice_id: string;
      provider_customer_id: string;
      customer_id: string;
      deployment_key: string;
    }>(
      `select i.provider_invoice_id, b.provider_customer_id, b.customer_id, i.deployment_key
        from invoices i join billing_customers b on b.id=i.billing_customer_id where i.id=$1`,
      [invoiceId],
    );
    expect(rows).toHaveLength(1);
    const ownership = rows[0]!;
    expect(ownership.customer_id).toBe(elm.id);
    expect(ownership.deployment_key).toBe(process.env.BILLING_DEPLOYMENT_KEY);
    const invoice = await stripe.invoices.retrieve(
      ownership.provider_invoice_id,
    );
    expect(invoice).toMatchObject({
      livemode: false,
      status: "open",
      currency: "usd",
      amount_due: 500,
      amount_paid: 0,
      customer: ownership.provider_customer_id,
      metadata: {
        datapad_invoice: invoiceId,
        datapad_deployment: ownership.deployment_key,
      },
    });
    const dueEnd = Temporal.PlainDate.from(plan.dueDate).toZonedDateTime({
      timeZone: plan.timeZone,
      plainTime: "23:59:59",
    });
    expect(invoice.due_date).toBe(dueEnd.epochMilliseconds / 1000);
    const lines = await stripe.invoices.listLineItems(invoice.id, {
      limit: 100,
    });
    expect(lines.has_more).toBe(false);
    expect(lines.data.map((line) => line.amount).sort((a, b) => a - b)).toEqual(
      [0, 500],
    );
    expect(lines.data.map((line) => line.metadata.datapad_line).sort()).toEqual(
      detail.invoice.lines.map((line) => line.id).sort(),
    );
    expect(
      (await providerInvoices(ownership.provider_customer_id)).filter(
        (candidate) => candidate.metadata?.datapad_invoice === invoiceId,
      ),
    ).toHaveLength(1);
    expect(invoice.invoice_pdf).toBeTruthy();
    const pdf = await page.request.get(invoice.invoice_pdf!);
    expect(pdf.ok()).toBe(true);
    const bytes = await pdf.body();
    expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
    await writeFile(join(artifacts, "scheduled-invoice.pdf"), bytes, {
      mode: 0o600,
    });

    const showHistory = async (customerId: string) => {
      await page.goto(`/customers/${customerId}/billing-schedule`);
      await page.getByLabel("Due from", { exact: true }).fill(plan.dueDate);
      await page.getByLabel("Due through", { exact: true }).fill(plan.dueDate);
      await page
        .getByRole("button", { name: "Show groups", exact: true })
        .click();
    };
    await showHistory(birch.id);
    await expect(
      page.getByText("This outcome is final. No invoice was created.", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "View invoice", exact: true }),
    ).toHaveCount(0);
    const noChargeScreenshot = join(artifacts, "scheduled-no-charge.png");
    await page.screenshot({ path: noChargeScreenshot, fullPage: true });
    await chmod(noChargeScreenshot, 0o600);
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Sign in", exact: true }),
    ).toBeVisible();
    await signIn(page, "elm-admin@example.test");
    await showHistory(elm.id);
    const view = page.getByRole("link", { name: "View invoice", exact: true });
    await expect(view).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: /^(Start invoicing|Pause scheduled invoices|Resume scheduled invoices)$/,
      }),
    ).toHaveCount(0);
    const customerSchedule = (await schedule(elm.id)).schedule;
    expect(customerSchedule.canManage).toBe(false);
    const forbidden = await page.request.post(
      `/api/customers/${elm.id}/billing-schedule`,
      {
        headers: { origin },
        data: {
          requestId: randomUUID(),
          expectedVersion: customerSchedule.version,
          change: { kind: "pause_issuance" },
        },
      },
    );
    expect(forbidden.status()).toBe(403);
    expect(
      (
        await page.request.get(`/api/customers/${birch.id}/billing-schedule`)
      ).status(),
    ).toBe(404);
    for (const [name, width] of [
      ["desktop", 1280],
      ["narrow", 390],
    ] as const) {
      await page.setViewportSize({ width, height: 900 });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
      const screenshot = join(artifacts, `scheduled-customer-${name}.png`);
      await page.screenshot({ path: screenshot, fullPage: true });
      await chmod(screenshot, 0o600);
    }
    await view.click();
    const opened = page.waitForEvent("popup");
    await page.getByRole("link", { name: /^Pay invoice/ }).click();
    const hosted = await opened;
    await hosted.waitForLoadState("domcontentloaded");
    expect(new URL(hosted.url()).origin).toBe("https://invoice.stripe.com");
    await expect(hosted.getByText(/^Test Mode$/i)).toBeVisible();
    await expect(
      hosted.getByText(detail.invoice.billTo.legalName, { exact: true }),
    ).toBeVisible();
    const formattedDue = new Intl.DateTimeFormat("en-US", {
      dateStyle: "long",
      timeZone: "UTC",
    }).format(new Date(`${plan.dueDate}T12:00:00Z`));
    await expect(
      hosted.getByText(`Due ${formattedDue}`, { exact: true }),
    ).toBeVisible();
    await hosted
      .getByRole("button", {
        name: "View invoice and payment details",
        exact: true,
      })
      .click();
    await expect(
      hosted.getByText("Storage add-on", { exact: true }),
    ).toBeVisible();
    await expect(
      hosted.getByText("Web hosting", { exact: true }),
    ).toBeVisible();
    await expect(
      hosted.getByText("$0.00", { exact: true }).first(),
    ).toBeVisible();
    const screenshot = join(artifacts, "scheduled-hosted.png");
    await hosted.screenshot({ path: screenshot, fullPage: true });
    await chmod(screenshot, 0o600);
    await hosted.close();
    await writeFile(
      join(artifacts, "scheduled-evidence.json"),
      JSON.stringify(
        {
          ...plan,
          subscriptionIds,
          groupIds: [paidGroup.id, freeGroup.id],
          invoiceId,
          providerInvoiceId: invoice.id,
          providerCustomerId: ownership.provider_customer_id,
          pdf: "scheduled-invoice.pdf",
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
  } finally {
    await pool.end();
  }
});
