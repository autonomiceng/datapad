import { expect, test } from "bun:test";
import { openapi } from "@elysia/openapi";
import { Elysia } from "elysia";
import { getCookies } from "better-auth/cookies";
import { exportOpenApi } from "../../scripts/openapi";
import { createApp } from "../../src/server/app";
import {
  accountRoutes,
  type AccountHttp,
} from "../../src/server/account-routes";
import type { AccessActionResponse } from "../../src/access/contract";
import type { HumanActor } from "../../src/access/types";

const origin = "http://localhost";

test("OpenAPI distinguishes portal sessions, public reads and signed webhooks", async () => {
  for (const baseURL of [origin, "https://portal.example.test"]) {
    const exported = await exportOpenApi(true, baseURL);
    expect(exported).toBe(await exportOpenApi(true, baseURL));
    const contract = JSON.parse(exported);
    expect(contract.security).toEqual([{ portalSession: [] }]);
    expect(contract.components.securitySchemes.portalSession).toMatchObject({
      type: "apiKey",
      in: "cookie",
      name: getCookies({ baseURL }).sessionToken.name,
    });
    for (const path of Object.keys(contract.paths)) {
      for (const method of Object.keys(contract.paths[path])) {
        const operation = contract.paths[path][method];
        expect(operation.security ?? contract.security).toEqual(
          path === "/api/access/session"
            ? []
            : path === "/api/billing/webhooks/stripe"
              ? [{ stripeSignature: [] }]
              : [{ portalSession: [] }],
        );
      }
    }
    // Auth transport remains hidden, rather than inventing a session requirement
    // for the sign-in and mailbox-verification endpoints.
    expect(
      Object.keys(contract.paths).some((path) => path.startsWith("/api/auth/")),
    ).toBe(false);
  }
  const standalone = JSON.parse(await exportOpenApi());
  expect(standalone.security).toEqual([]);
  expect(standalone.components.securitySchemes.portalSession).toBeUndefined();
  for (const path of ["/api/import-review/sources", "/api/billing/invoices"]) {
    expect(standalone.paths[path].get.security ?? standalone.security).toEqual(
      [],
    );
  }
  expect(standalone.paths["/api/access/session"]).toBeUndefined();
  const webhook = standalone.paths["/api/billing/webhooks/stripe"].post;
  expect(webhook.security).toEqual([{ stripeSignature: [] }]);
  expect(standalone.components.securitySchemes.stripeSignature).toMatchObject({
    type: "apiKey",
    in: "header",
    name: "Stripe-Signature",
  });
  expect(webhook.parameters).toContainEqual({
    in: "header",
    name: "Stripe-Signature",
    required: true,
    schema: { type: "string" },
  });
  expect(webhook.responses["400"]).toBeDefined();
});
const customerId = "00000000-0000-4000-8000-000000000001";
const requestId = "00000000-0000-4000-8000-000000000002";
const actor: HumanActor = {
  userId: "user-synthetic",
  sessionId: "session-current",
};
const profile = {
  displayName: "Sample customer",
  legalName: "Sample customer Ltd",
  billingEmail: null,
};
const update = { requestId, expectedVersion: 1, profile };
const invite = { requestId, email: "member@example.test", role: "member" };
const unused = async (): Promise<never> => {
  throw new Error("Unexpected account operation.");
};
const ports = (): AccountHttp => ({
  origin,
  access: {
    resolveActor: unused,
    getSession: unused,
    listMembers: unused,
    listInvitations: unused,
    inviteMember: unused,
    revokeMember: unused,
    revokeInvitation: unused,
    acceptInvitation: unused,
  },
  customers: {
    listCustomers: unused,
    getCustomer: unused,
    updateCustomer: unused,
  },
});
const command = (
  path: string,
  body: unknown,
  headers: Record<string, string> = { origin },
  method: "POST" | "PATCH" = "POST",
) =>
  new Request(`${origin}${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
async function error(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ code });
}

test("account HTTP rejects signed-out and untrusted-origin commands before domain work", async () => {
  expect(() =>
    createApp({
      importReview: {
        listSources: unused,
        listImports: unused,
        listCustomers: unused,
        getCustomer: unused,
        listDataIssues: unused,
      },
      accounts: {
        routes: ports(),
        authHandler: unused,
        authorizeImport: unused,
      },
      billing: { reader: { listInvoices: unused, getInvoice: unused } },
    }),
  ).toThrow("Authenticated billing requires current account authorization.");
  const options = ports();
  options.access.getSession = async () => ({
    user: null,
    staffRoles: [],
    signInMethods: ["email_link"],
    synthetic: true,
  });
  options.access.resolveActor = async () => null;
  const app = accountRoutes(options);
  const session = await app.handle(new Request(`${origin}/api/access/session`));
  expect(session.status).toBe(200);
  expect(session.headers.get("cache-control")).toBe("no-store");
  expect(await session.json()).toEqual({
    user: null,
    staffRoles: [],
    signInMethods: ["email_link"],
    synthetic: true,
  });
  await error(
    await app.handle(new Request(`${origin}/api/customers`)),
    401,
    "unauthenticated",
  );
  await error(
    await app.handle(
      command(`/api/customers/${customerId}`, update, { origin }, "PATCH"),
    ),
    401,
    "unauthenticated",
  );
  await error(
    await app.handle(
      command("/api/access/invitations/invite-synthetic/accept", { requestId }),
    ),
    401,
    "unauthenticated",
  );

  options.access.resolveActor = async () => actor;
  await error(
    await app.handle(
      command(`/api/customers/${customerId}/invitations`, invite, {
        origin: "https://foreign.test",
        "sec-fetch-site": "same-origin",
        "x-forwarded-host": "localhost",
        "x-forwarded-proto": "http",
      }),
    ),
    403,
    "forbidden",
  );
  await error(
    await app.handle(
      command(
        `/api/customers/${customerId}/members/member-synthetic/revoke`,
        { requestId },
        {
          "sec-fetch-site": "same-origin",
          "x-forwarded-origin": origin,
        },
      ),
    ),
    403,
    "forbidden",
  );
  await error(
    await app.handle(
      command(
        `/api/customers/${customerId}/invitations/invite-synthetic/revoke`,
        { requestId },
        {
          origin: `${origin}/`,
        },
      ),
    ),
    403,
    "forbidden",
  );
  await error(
    await app.handle(
      new Request(`${origin}/api/customers/${customerId}`, {
        method: "PATCH",
        headers: { origin, "content-type": "text/plain" },
        body: JSON.stringify(update),
      }),
    ),
    422,
    "invalid_request",
  );
});

test("account HTTP forwards current actor and scoped IDs, preserves action state and returns safe contract errors", async () => {
  const options = ports();
  const calls: unknown[] = [];
  let currentActor = actor;
  let failRead = false;
  options.access.resolveActor = async (headers) => {
    expect(headers.get("cookie")).toBe("session=synthetic");
    return currentActor;
  };
  options.customers.listCustomers = async (resolved, page) => {
    if (failRead) throw new Error("private SQL with personal values");
    calls.push(["list", resolved, page]);
    return {
      ok: true,
      value: { customers: [], total: 0, limit: 50, offset: 0 },
    };
  };
  options.customers.getCustomer = async (resolved, id) => {
    calls.push(["detail", resolved, id]);
    return { ok: false, code: "not_found" };
  };
  options.customers.updateCustomer = async (resolved, id, input) => {
    calls.push(["profile", resolved, id, input]);
    return { ok: false, code: "conflict" };
  };
  options.access.listMembers = async (resolved, id, page) => {
    calls.push(["members", resolved, id, page]);
    return { ok: false, code: "forbidden" };
  };
  options.access.listInvitations = async (resolved, id, page) => {
    calls.push(["invitations", resolved, id, page]);
    return { ok: false, code: "unavailable" };
  };
  const action: AccessActionResponse = {
    actionId: requestId,
    state: "pending",
    invitationId: "invite-synthetic",
  };
  const commandHeaders = { origin, cookie: "session=synthetic" };
  const checkHeaders = (headers: Headers) => {
    expect(headers.get("cookie")).toBe(commandHeaders.cookie);
    expect(headers.get("origin")).toBe(origin);
  };
  options.access.inviteMember = async (headers, id, input) => {
    checkHeaders(headers);
    calls.push(["invite", id, input]);
    return { ok: false, code: "invalid_request" };
  };
  options.access.revokeInvitation = async (headers, id, invitation, input) => {
    checkHeaders(headers);
    calls.push(["revokeInvitation", id, invitation, input]);
    return { ok: true, value: { ...action, state: "completed" } };
  };
  options.access.revokeMember = async (headers, id, member, input) => {
    checkHeaders(headers);
    calls.push(["revokeMember", id, member, input]);
    return {
      ok: true,
      value: { ...action, state: "needs_review", invitationId: null },
    };
  };
  options.access.acceptInvitation = async (headers, invitation, input) => {
    checkHeaders(headers);
    calls.push(["accept", invitation, input]);
    return { ok: true, value: action };
  };
  const app = new Elysia({ normalize: false })
    .use(openapi({ provider: null }))
    .use(accountRoutes(options))
    .get("/health", () => "ok");
  const read = (path: string) =>
    app.handle(
      new Request(`${origin}${path}`, {
        headers: { cookie: commandHeaders.cookie },
      }),
    );
  const list = await read("/api/customers");
  expect(list.status).toBe(200);
  expect(await list.json()).toEqual({
    customers: [],
    total: 0,
    limit: 50,
    offset: 0,
  });
  currentActor = { userId: "user-second", sessionId: "session-second" };
  await error(await read(`/api/customers/${customerId}`), 404, "not_found");
  await error(
    await app.handle(
      command(`/api/customers/${customerId}`, update, commandHeaders, "PATCH"),
    ),
    409,
    "conflict",
  );
  await error(
    await read(`/api/customers/${customerId}/members?limit=100&offset=7`),
    403,
    "forbidden",
  );
  await error(
    await read(`/api/customers/${customerId}/invitations`),
    503,
    "unavailable",
  );
  await error(
    await app.handle(
      command(
        `/api/customers/${customerId}/invitations`,
        invite,
        commandHeaders,
      ),
    ),
    422,
    "invalid_request",
  );
  const revokedInvitation = await app.handle(
    command(
      `/api/customers/${customerId}/invitations/invite-synthetic/revoke`,
      { requestId },
      commandHeaders,
    ),
  );
  expect(revokedInvitation.status).toBe(200);
  expect(await revokedInvitation.json()).toEqual({
    ...action,
    state: "completed",
  });
  const revokedMember = await app.handle(
    command(
      `/api/customers/${customerId}/members/member-synthetic/revoke`,
      { requestId },
      commandHeaders,
    ),
  );
  expect(revokedMember.status).toBe(200);
  expect(await revokedMember.json()).toEqual({
    ...action,
    state: "needs_review",
    invitationId: null,
  });
  const accepted = await app.handle(
    command(
      "/api/access/invitations/invite-synthetic/accept",
      { requestId },
      commandHeaders,
    ),
  );
  expect(accepted.status).toBe(200);
  expect(await accepted.json()).toEqual(action);
  expect(calls).toEqual([
    ["list", actor, { limit: 50, offset: 0 }],
    ["detail", currentActor, customerId],
    ["profile", currentActor, customerId, update],
    ["members", currentActor, customerId, { limit: 100, offset: 7 }],
    ["invitations", currentActor, customerId, { limit: 50, offset: 0 }],
    ["invite", customerId, invite],
    ["revokeInvitation", customerId, "invite-synthetic", { requestId }],
    ["revokeMember", customerId, "member-synthetic", { requestId }],
    ["accept", "invite-synthetic", { requestId }],
  ]);

  await error(await read("/api/customers?limit=101"), 422, "invalid_request");
  await error(
    await read("/api/customers?private=value"),
    422,
    "invalid_request",
  );
  await error(await read("/api/customers/invalid"), 422, "invalid_request");
  await error(
    await app.handle(
      command(
        `/api/customers/${customerId}/members/${"m".repeat(129)}/revoke`,
        { requestId },
        commandHeaders,
      ),
    ),
    422,
    "invalid_request",
  );
  await error(
    await app.handle(
      command(
        `/api/customers/${customerId}`,
        {
          ...update,
          profile: { ...profile, staffRoles: ["account_administrator"] },
        },
        commandHeaders,
        "PATCH",
      ),
    ),
    422,
    "invalid_request",
  );
  await error(
    await app.handle(
      command(
        `/api/customers/${customerId}`,
        { ...update, expectedVersion: "1" },
        commandHeaders,
        "PATCH",
      ),
    ),
    422,
    "invalid_request",
  );
  await error(
    await app.handle(
      command(
        "/api/access/invitations/invite-synthetic/accept",
        { requestId, email: "claimed@example.test" },
        commandHeaders,
      ),
    ),
    422,
    "invalid_request",
  );
  expect(calls).toHaveLength(9);
  failRead = true;
  await error(await read("/api/customers"), 503, "unavailable");
  expect((await read("/health")).headers.get("cache-control")).toBe("no-store");
  const specification = await (await read("/openapi/json")).json();
  expect(
    specification.paths["/api/customers/{customerId}"].patch.operationId,
  ).toBe("updateCustomer");
  expect(
    specification.paths["/api/access/invitations/{invitationId}/accept"].post
      .operationId,
  ).toBe("acceptCustomerInvitation");
  expect(
    specification.paths["/api/customers/{customerId}/members/{memberId}/revoke"]
      .post.requestBody.content["application/json"].schema,
  ).toMatchObject({ additionalProperties: false, required: ["requestId"] });
});
