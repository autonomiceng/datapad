import { expect, test } from "bun:test";
import { Elysia } from "elysia";
import type { HumanActor } from "../../src/access/types";
import type { InvoiceDetail } from "../../src/billing/contract";
import {
  invoiceWorkflowRoutes,
  type InvoiceWorkflowHttp,
} from "../../src/server/invoice-workflow-routes";

const origin = "http://localhost";
const customerId = "00000000-0000-4000-8000-000000000001";
const invoiceId = "00000000-0000-4000-8000-000000000002";
const requestId = "00000000-0000-4000-8000-000000000003";
const path = `/api/customers/${customerId}`;
const invoicePath = `${path}/invoices/${invoiceId}`;
const input = {
  requestId,
  expectedCustomerVersion: 7,
  dueDate: "2026-10-24",
  currency: "USD",
  lines: [{ description: "Sample hosting", amountMinor: 500 }],
};
const invoice: InvoiceDetail = {
  calendar: null,
  id: invoiceId,
  customer: { id: customerId, name: "Sample customer" },
  billTo: {
    legalName: "Sample customer",
    billingEmail: null,
    profileVersion: 7,
  },
  issueDate: "2026-10-03",
  dueDate: input.dueDate,
  readinessDate: "2026-10-03",
  currency: "USD",
  totalMinor: 500,
  state: "requested",
  providerStatus: null,
  reviewReason: null,
  lastCheckedAt: null,
  issuedAt: null,
  providerReceipt: { state: "unverified", reason: null },
  hostedInvoiceUrl: null,
  lines: [{ id: requestId, position: 0, ...input.lines[0], originRef: null }],
};
const read = (route: string) =>
  new Request(`${origin}${route}`, { headers: { cookie: "session=sample" } });
const command = (
  route: string,
  body: unknown,
  headers: Record<string, string> = { origin },
) =>
  new Request(`${origin}${route}`, {
    method: "POST",
    headers: {
      cookie: "session=sample",
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
async function error(response: Response, code: string, status: number) {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ code });
}

test("invoice workflow HTTP preserves scoped current identity and truthful outcomes while rejecting unsafe browser commands", async () => {
  let current: HumanActor | null = {
    userId: "first-staff",
    sessionId: "first-session",
  };
  let prepared = false;
  let issued = false;
  let conflict = false;
  const options: InvoiceWorkflowHttp = {
    origin,
    access: {
      resolveActor: async (headers) =>
        headers.get("cookie") === "session=sample" ? current : null,
    },
    readOptions: async (actor, id) =>
      actor.userId !== current?.userId || id !== customerId
        ? { ok: false, code: "not_found" }
        : {
            ok: true,
            value: {
              available: true,
              lines: input.lines,
              issueDate: invoice.issueDate,
              dueDate: input.dueDate,
            },
          },
    workflow: {
      prepareInvoice: async (actor, id, body) => {
        if (conflict) return { ok: false, code: "conflict" };
        if (body.requestId !== requestId)
          return { ok: false, code: "invalid_request" };
        const outcome = prepared ? "unchanged" : "created";
        prepared = true;
        return {
          ok: true,
          value: {
            outcome,
            issueBlocker: null,
            invoice: {
              ...invoice,
              customer: { id, name: "Sample customer" },
              billTo: {
                ...invoice.billTo,
                legalName: actor.userId,
                profileVersion: body.expectedCustomerVersion,
              },
              dueDate: body.dueDate,
              lines: body.lines.map((line, position) => ({
                ...line,
                position,
                id: requestId,
                originRef: null,
              })),
            },
          },
        };
      },
      getPreparation: async (actor, id, selectedId) => {
        if (id !== customerId || selectedId !== invoiceId)
          return { ok: false, code: "not_found" };
        if (actor.sessionId !== "second-session")
          return { ok: false, code: "forbidden" };
        return {
          ok: true,
          value: { invoice, issueBlocker: issued ? "already_issued" : null },
        };
      },
      confirmIssue: async (actor, id, selectedId) => {
        if (
          actor.sessionId !== "second-session" ||
          id !== customerId ||
          selectedId !== invoiceId
        )
          return { ok: false, code: "forbidden" };
        if (conflict) return { ok: false, code: "conflict" };
        const outcome = issued ? "unchanged" : "accepted";
        issued = true;
        return { ok: true, value: { outcome, invoiceId: selectedId } };
      },
      checkInvoice: async (actor, id, selectedId) => {
        if (
          actor.sessionId !== "second-session" ||
          id !== customerId ||
          selectedId !== invoiceId
        )
          return { ok: false, code: "forbidden" };
        return {
          ok: true,
          value: {
            invoice: { ...invoice, state: "paid", providerStatus: "paid" },
          },
        };
      },
    },
  };
  const app = new Elysia({ normalize: false }).use(
    invoiceWorkflowRoutes(options),
  );
  const choices = await app.handle(read(`${path}/invoice-options`));
  expect(choices.status).toBe(200);
  expect(choices.headers.get("cache-control")).toBe("no-store");
  expect(await choices.json()).toEqual({
    available: true,
    lines: input.lines,
    issueDate: invoice.issueDate,
    dueDate: input.dueDate,
  });
  const created = await app.handle(command(`${path}/invoices`, input));
  expect(created.status).toBe(201);
  expect(await created.json()).toMatchObject({
    outcome: "created",
    invoice: {
      customer: { id: customerId },
      billTo: { legalName: "first-staff", profileVersion: 7 },
      dueDate: input.dueDate,
      lines: [{ ...input.lines[0], position: 0 }],
    },
  });
  current = { userId: "second-staff", sessionId: "second-session" };
  const replay = await app.handle(command(`${path}/invoices`, input));
  expect(replay.status).toBe(200);
  expect(await replay.json()).toMatchObject({
    outcome: "unchanged",
    invoice: { billTo: { legalName: "second-staff" } },
  });
  const review = await app.handle(read(`${invoicePath}/preparation`));
  expect(review.status).toBe(200);
  expect(await review.json()).toEqual({ invoice, issueBlocker: null });
  const accepted = await app.handle(command(`${invoicePath}/issue`, {}));
  expect(accepted.status).toBe(202);
  expect(await accepted.json()).toEqual({ outcome: "accepted", invoiceId });
  const repeated = await app.handle(command(`${invoicePath}/issue`, {}));
  expect(repeated.status).toBe(200);
  expect(await repeated.json()).toEqual({ outcome: "unchanged", invoiceId });
  const checked = await app.handle(command(`${invoicePath}/check`, {}));
  expect(checked.status).toBe(200);
  expect(await checked.json()).toMatchObject({
    invoice: { id: invoiceId, state: "paid" },
  });
  await error(
    await app.handle(
      command(`${path}/invoices`, input, { origin: "https://foreign.test" }),
    ),
    "forbidden",
    403,
  );
  await error(
    await app.handle(command(`${invoicePath}/issue`, {}, {})),
    "forbidden",
    403,
  );
  await error(
    await app.handle(
      command(
        `${invoicePath}/check`,
        {},
        { origin, "content-type": "text/plain" },
      ),
    ),
    "invalid_request",
    422,
  );
  await error(
    await app.handle(
      command(`${path}/invoices`, { ...input, issueDate: invoice.issueDate }),
    ),
    "invalid_request",
    422,
  );
  await error(
    await app.handle(command(`${invoicePath}/issue`, { requestId })),
    "invalid_request",
    422,
  );
  await error(
    await app.handle(read(`${path}/invoices/${requestId}/preparation`)),
    "not_found",
    404,
  );
  conflict = true;
  await error(
    await app.handle(command(`${path}/invoices`, input)),
    "conflict",
    409,
  );
  await error(
    await app.handle(command(`${invoicePath}/issue`, {})),
    "conflict",
    409,
  );
  current = null;
  await error(
    await app.handle(command(`${invoicePath}/check`, {})),
    "unauthenticated",
    401,
  );
  current = { userId: "second-staff", sessionId: "revoked-session" };
  await error(
    await app.handle(read(`${invoicePath}/preparation`)),
    "forbidden",
    403,
  );
  current = { userId: "second-staff", sessionId: "second-session" };
  options.workflow = undefined;
  const disabled = await app.handle(read(`${path}/invoice-options`));
  expect(disabled.status).toBe(200);
  expect(await disabled.json()).toMatchObject({ available: false });
  await error(
    await app.handle(command(`${path}/invoices`, input)),
    "unavailable",
    503,
  );
  await error(
    await invoiceWorkflowRoutes().handle(read(`${path}/invoice-options`)),
    "unavailable",
    503,
  );
  options.readOptions = async () => {
    throw new Error("private SQL/provider content");
  };
  await error(
    await app.handle(read(`${path}/invoice-options`)),
    "unavailable",
    503,
  );
});
