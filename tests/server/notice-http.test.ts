import { expect, test } from "bun:test";
import { Elysia } from "elysia";
import type { HumanActor } from "../../src/access/types";
import type { InvoiceNoticesResponse } from "../../src/notifications/contract";
import { noticeRoutes, type NoticeHttp } from "../../src/server/notice-routes";

const customerId = "10000000-0000-4000-8000-000000000001";
const invoiceId = "20000000-0000-4000-8000-000000000002";
const otherId = "30000000-0000-4000-8000-000000000003";
const path = `/api/customers/${customerId}/invoices/${invoiceId}/notices`;
const read = (value = path) => new Request(`http://localhost${value}`);
const response: InvoiceNoticesResponse = {
  invoiceId,
  notices: [
    {
      id: otherId,
      stage: "invoice",
      state: "accepted",
      reason: null,
      calendar: { timeZone: "America/Los_Angeles", hour: 9 },
      scheduledAt: "2026-10-03T16:00:00Z",
      attempts: 1,
      nextAttemptAt: null,
      attemptedAt: "2026-10-03T16:00:00Z",
      acceptedAt: "2026-10-03T16:00:01Z",
      recipient: "billing@example.test",
      profileVersion: 1,
      preview: {
        subject: "Sample invoice",
        text: "Sample content",
        html: "<p>Sample content</p>",
      },
      previewKind: "stamped",
      messageId: "<sample@notices.datapad.test>",
    },
  ],
};
async function error(value: Response, status: number, code: string) {
  expect(value.status).toBe(status);
  expect(value.headers.get("cache-control")).toBe("no-store");
  expect(await value.json()).toEqual({ code });
}

test("notice HTTP resolves current identity and delegates exact scope without delivery capabilities", async () => {
  let actor: HumanActor | null = {
    userId: "sample-staff",
    sessionId: "sample-session",
  };
  let reads = 0;
  const config: NoticeHttp = {
    access: { resolveActor: async () => actor },
    notices: {
      getInvoiceNotices: async (current, customer, invoice) => {
        reads++;
        expect(current).toEqual(actor!);
        if (current.userId !== "sample-staff")
          return { ok: false, code: "forbidden" };
        if (customer !== customerId || invoice !== invoiceId)
          return { ok: false, code: "not_found" };
        return { ok: true, value: response };
      },
    },
  };
  const app = new Elysia({ normalize: false }).use(noticeRoutes(config));
  const value = await app.handle(read());
  expect(value.status).toBe(200);
  expect(value.headers.get("cache-control")).toBe("no-store");
  expect(await value.json()).toEqual(response);
  await error(
    await app.handle(
      read(`/api/customers/${otherId}/invoices/${invoiceId}/notices`),
    ),
    404,
    "not_found",
  );
  await error(
    await app.handle(
      read(`/api/customers/${customerId}/invoices/${otherId}/notices`),
    ),
    404,
    "not_found",
  );
  actor = { userId: "sample-member", sessionId: "sample-member-session" };
  await error(await app.handle(read()), 403, "forbidden");
  actor = null;
  await error(await app.handle(read()), 401, "unauthenticated");
  expect(reads).toBe(4);
});

test("notice HTTP rejects extra inputs and masks unavailable storage without content leaks", async () => {
  let calls = 0;
  const config: NoticeHttp = {
    access: {
      resolveActor: async () => ({
        userId: "sample-staff",
        sessionId: "sample-session",
      }),
    },
    notices: {
      getInvoiceNotices: async () => {
        calls++;
        throw new Error("private storage detail");
      },
    },
  };
  const app = new Elysia({ normalize: false }).use(noticeRoutes(config));
  await error(
    await app.handle(read(`${path}?recipient=foreign@example.test`)),
    422,
    "invalid_request",
  );
  await error(
    await app.handle(read("/api/customers/invalid/invoices/invalid/notices")),
    422,
    "invalid_request",
  );
  expect(calls).toBe(0);
  await error(await app.handle(read()), 503, "unavailable");
  config.notices = undefined;
  await error(await app.handle(read()), 503, "unavailable");
  await error(await noticeRoutes().handle(read()), 503, "unavailable");
  expect(calls).toBe(1);
});
