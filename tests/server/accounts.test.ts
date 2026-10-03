import { resumeEffects } from "./effects-fixture";
import { afterAll, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { createBilling } from "../../src/billing";
import type { InvoiceRequest } from "../../src/billing/contract";
import { SyntheticBillingProvider } from "./billing-provider";
import { drizzle } from "drizzle-orm/node-postgres";
import { and, eq } from "drizzle-orm";
import {
  createAccess,
  createAuthentication,
  createAuditWriter,
  bootstrapSyntheticAccess,
  assertSyntheticAccess,
} from "../../src/access";
import {
  createCustomers,
  createCustomerRegistry,
  assertSyntheticCustomers,
} from "../../src/customers";
import type { Customers } from "../../src/customers/types";
import type { HumanActor, AuthenticationGateway } from "../../src/access/types";
import type { CustomerProfile } from "../../src/customers/contract";
import {
  member,
  invitation,
  auditEntries,
  session,
  staffGrants,
} from "../../src/access/internal/schema";

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL is required");
const pool = new Pool({ connectionString: url, max: 1 });
const lockPool = new Pool({ connectionString: url, max: 2 });
const db = drizzle(pool);
const origin = "http://localhost:4321";
const names = [
  "staff",
  "elm",
  "birch",
  "collaborator",
  "outsider",
  "invitee",
  "support",
];
const emails = names.map((name) => `${name}@accounts.test`);
const profile = (name: string): CustomerProfile => ({
  displayName: `${name} (sample)`,
  legalName: `${name} (sample)`,
  billingEmail: null,
});
const allowed = (value: CustomerProfile) =>
  ["Elm", "Elm revised", "Birch"].some(
    (name) => JSON.stringify(profile(name)) === JSON.stringify(value),
  );
const manifest = {
  operatorId: "accounts-test",
  allowedEmails: emails,
  users: names
    .filter((name) => name !== "invitee")
    .map((name) => ({
      id: name,
      name: `${name} (sample)`,
      email: `${name}@accounts.test`,
      staffRoles:
        name === "staff"
          ? ["account_administrator" as const]
          : name === "support"
            ? ["support" as const]
            : [],
    })),
  organizations: [
    {
      id: "elm-org",
      name: "Elm (sample)",
      slug: "elm",
      members: [
        { userId: "elm", role: "administrator" as const },
        { userId: "collaborator", role: "member" as const },
        { userId: "support", role: "member" as const },
      ],
    },
    {
      id: "birch-org",
      name: "Birch (sample)",
      slug: "birch",
      members: [
        { userId: "birch", role: "administrator" as const },
        { userId: "collaborator", role: "member" as const },
      ],
    },
  ],
};
const clear = () =>
  pool.query(
    'TRUNCATE customers, "user", organization, verification, access_audit, access_commands CASCADE',
  );
beforeEach(clear);
afterAll(async () => {
  await clear();
  await pool.end();
  await lockPool.end();
});
async function setup(
  gatewayWrap?: (gateway: AuthenticationGateway) => AuthenticationGateway,
) {
  const delivered = new Map<string, string>();
  const auth = createAuthentication({
    pool,
    baseURL: origin,
    secret: "synthetic-only-account-test-secret-0123456789",
    synthetic: true,
    allowedEmails: emails,
    sendMagicLink: async ({ email, url }) => {
      delivered.set(email, url);
    },
  });
  const audit = createAuditWriter();
  const registry = createCustomerRegistry({
    operatorId: "accounts-test",
    audit,
    allowProfile: allowed,
  });
  const ids = await db.transaction(async (tx) => {
    await bootstrapSyntheticAccess(tx, manifest);
    const elm = await registry.ensureCustomer(tx, {
      registryKey: '["test","elm"]',
      initialProfile: profile("Elm"),
      organizationId: "elm-org",
    });
    const birch = await registry.ensureCustomer(tx, {
      registryKey: '["test","birch"]',
      initialProfile: profile("Birch"),
      organizationId: "birch-org",
    });
    return { elm: elm.customerId, birch: birch.customerId };
  });
  let customers: Customers;
  const invitations: string[] = [];
  const access = createAccess({
    pool,
    lockPool,
    authentication: gatewayWrap ? gatewayWrap(auth.gateway) : auth.gateway,
    getCustomerTarget: (id) => customers.getAccessTarget(id),
    getOrganizationTarget: (id) => customers.getOrganizationTarget(id),
    allowInvitation: (email) => emails.includes(email),
    signInMethods: ["email_link"],
    synthetic: true,
    baseURL: origin,
    sendInvitation: async ({ invitationId }) => {
      invitations.push(invitationId);
    },
  });
  customers = createCustomers({
    pool,
    access: access.policy,
    audit,
    providerProfile: async () => {
      await pool.query("select 1");
      return "not_linked";
    },
    allowProfile: allowed,
  });
  async function login(name: string) {
    const email = `${name}@accounts.test`;
    const response = await auth.handler(
      new Request(`${origin}/api/auth/sign-in/magic-link`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ email, callbackURL: `${origin}/customers` }),
      }),
    );
    expect(response.status).toBe(200);
    const link = delivered.get(email);
    if (!link) throw new Error("Expected local mailbox proof");
    const verified = await auth.handler(new Request(link));
    const cookie = verified.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    const headers = new Headers({ cookie, origin });
    const actor = await access.resolveActor(headers);
    if (!actor)
      throw new Error(`Missing verified actor ${name}: ${verified.status}`);
    return { headers, actor, link };
  }
  return { auth, access, customers, registry, ids, login, invitations };
}
const rejection = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: unknown) => error,
  );
const value = <T>(
  result: { ok: true; value: T } | { ok: false; code: string },
): T => {
  if (!result.ok) throw new Error(result.code);
  return result.value;
};

test("current identity scopes lists, cross-customer reads, profile authority and billing visibility", async () => {
  const state = await setup();
  const staff = await state.login("staff"),
    elm = await state.login("elm"),
    collaborator = await state.login("collaborator"),
    outsider = await state.login("outsider"),
    support = await state.login("support");
  expect(value(await state.customers.listCustomers(elm.actor)).total).toBe(1);
  expect(
    value(await state.customers.listCustomers(collaborator.actor)).total,
  ).toBe(2);
  expect(value(await state.customers.listCustomers(outsider.actor)).total).toBe(
    0,
  );
  expect(await state.customers.getCustomer(elm.actor, state.ids.birch)).toEqual(
    { ok: false, code: "not_found" },
  );
  expect(
    await state.customers.updateCustomer(elm.actor, state.ids.elm, {
      requestId: randomUUID(),
      expectedVersion: 1,
      profile: profile("Elm revised"),
    }),
  ).toEqual({ ok: false, code: "forbidden" });
  expect(value(await state.customers.billingScope(staff.actor))).toEqual({
    kind: "all",
  });
  expect(value(await state.customers.billingScope(support.actor))).toEqual({
    kind: "customers",
    customerIds: [state.ids.elm],
  });
  await db.insert(staffGrants).values([
    { userId: "staff", role: "billing" },
    { userId: "staff", role: "support" },
  ]);
  const target = { customerId: state.ids.elm, organizationId: "elm-org" };
  expect(
    await db.transaction((tx) =>
      state.access.policy.authorizeCustomer(
        tx,
        staff.actor,
        target,
        "manage_payment_settings",
        true,
      ),
    ),
  ).toEqual({ ok: false, code: "forbidden" });
  expect(
    await state.access.policy.authorizeCustomer(
      db,
      support.actor,
      target,
      "manage_payment_settings",
      false,
    ),
  ).toEqual({ ok: false, code: "forbidden" });
  await db
    .update(member)
    .set({ role: "admin" })
    .where(
      and(eq(member.userId, "support"), eq(member.organizationId, "elm-org")),
    );
  const [supportMember] = await db
    .select()
    .from(member)
    .where(
      and(eq(member.userId, "support"), eq(member.organizationId, "elm-org")),
    );
  expect(
    value(
      await db.transaction((tx) =>
        state.access.policy.authorizeCustomer(
          tx,
          support.actor,
          target,
          "manage_payment_settings",
          true,
        ),
      ),
    ),
  ).toMatchObject({
    customerRole: "administrator",
    staffRoles: ["support"],
    customerMembership: {
      id: supportMember!.id,
      invitationId: null,
      invitedByUserId: null,
      invitedByStaff: null,
    },
  });
  const membershipProvenance = {
    invitationId: "synthetic-invitation",
    invitedByUserId: "synthetic-inviter",
    invitedByStaff: true,
  };
  const setupRequestId = randomUUID(),
    enrollmentRequestId = randomUUID();
  const paymentAudit = createAuditWriter();
  await db.transaction(async (tx) => {
    await paymentAudit.append(tx, {
      requestId: setupRequestId,
      actor: staff.actor,
      customerId: state.ids.elm,
      targetId: randomUUID(),
      action: "payment_setup.started",
      changedFields: ["saveTerms"],
      consentingMembershipId: "synthetic-consenting-member",
      membershipProvenance,
    });
    await paymentAudit.append(tx, {
      requestId: enrollmentRequestId,
      actor: staff.actor,
      customerId: state.ids.elm,
      targetId: randomUUID(),
      action: "payment_enrollment.changed",
      changedFields: ["method", "scopes"],
      consentingMembershipId: "synthetic-consenting-member",
      membershipProvenance,
    });
  });
  for (const requestId of [setupRequestId, enrollmentRequestId]) {
    const [entry] = await db
      .select()
      .from(auditEntries)
      .where(eq(auditEntries.requestId, requestId));
    expect(entry!.details).toEqual({
      changedFields:
        requestId === setupRequestId ? ["saveTerms"] : ["method", "scopes"],
      consentingMembershipId: "synthetic-consenting-member",
      membershipProvenance,
    });
  }
  const response = await state.auth.handler(
    new Request(`${origin}/api/auth/sign-out`, {
      method: "POST",
      headers: staff.headers,
    }),
  );
  expect(response.status).toBe(200);
  expect(await state.customers.getCustomer(staff.actor, state.ids.elm)).toEqual(
    { ok: false, code: "unauthenticated" },
  );
});

test("verified invitation acceptance, cancellation, expiry and idempotent staff management use exact customer targets", async () => {
  const state = await setup();
  const staff = await state.login("staff"),
    elm = await state.login("elm"),
    outsider = await state.login("outsider");
  const request = {
    requestId: randomUUID(),
    email: "invitee@accounts.test",
    role: "member" as const,
  };
  const created = value(
    await state.access.inviteMember(staff.headers, state.ids.elm, request),
  );
  expect(created.state).toBe("completed");
  expect(
    value(
      await state.access.inviteMember(staff.headers, state.ids.elm, request),
    ).invitationId,
  ).toBe(created.invitationId);
  const invitationId = created.invitationId!;
  expect(
    await state.access.acceptInvitation(outsider.headers, invitationId, {
      requestId: randomUUID(),
    }),
  ).toEqual({ ok: false, code: "forbidden" });
  const invitee = await state.login("invitee");
  expect(
    value(
      await state.access.acceptInvitation(invitee.headers, invitationId, {
        requestId: randomUUID(),
      }),
    ).state,
  ).toBe("completed");
  expect(value(await state.customers.listCustomers(invitee.actor)).total).toBe(
    1,
  );
  expect(
    await state.access.inviteMember(invitee.headers, state.ids.elm, {
      ...request,
      requestId: randomUUID(),
      email: "outsider@accounts.test",
    }),
  ).toEqual({ ok: false, code: "forbidden" });
  const [acceptedMember] = await db
    .select()
    .from(member)
    .where(eq(member.userId, invitee.actor.userId));
  const target = { customerId: state.ids.elm, organizationId: "elm-org" };
  const firstMembership = {
    id: acceptedMember!.id,
    invitationId,
    invitedByUserId: "staff",
    invitedByStaff: true,
  };
  expect(
    value(
      await state.access.policy.authorizeCustomer(
        db,
        invitee.actor,
        target,
        "read",
        false,
      ),
    ).customerMembership,
  ).toEqual(firstMembership);
  // Historical staff status survives removal of the inviter's current grant.
  await db.delete(staffGrants).where(eq(staffGrants.userId, "staff"));
  expect(
    value(
      await state.access.policy.authorizeCustomer(
        db,
        invitee.actor,
        target,
        "read",
        false,
      ),
    ).customerMembership,
  ).toEqual(firstMembership);
  await db
    .insert(staffGrants)
    .values({ userId: "staff", role: "account_administrator" });
  const [completion] = await db
    .select()
    .from(auditEntries)
    .where(
      and(
        eq(auditEntries.action, "invitation.accept.completed"),
        eq(auditEntries.targetId, invitationId),
      ),
    );
  expect(completion!.details.memberId).toBe(acceptedMember!.id);
  await state.access.revokeMember(
    elm.headers,
    state.ids.elm,
    acceptedMember!.id,
    { requestId: randomUUID() },
  );
  const reinvited = value(
    await state.access.inviteMember(elm.headers, state.ids.elm, {
      ...request,
      requestId: randomUUID(),
    }),
  );
  expect(
    value(
      await state.access.acceptInvitation(
        invitee.headers,
        reinvited.invitationId!,
        { requestId: randomUUID() },
      ),
    ).state,
  ).toBe("completed");
  const renewed = value(
    await state.access.policy.authorizeCustomer(
      db,
      invitee.actor,
      target,
      "read",
      false,
    ),
  ).customerMembership;
  expect(renewed).toEqual({
    id: expect.any(String),
    invitationId: reinvited.invitationId,
    invitedByUserId: "elm",
    invitedByStaff: false,
  });
  expect(renewed!.id).not.toBe(firstMembership.id);
  // New staff grants also cannot rewrite an invitation's historical status.
  await db.insert(staffGrants).values({ userId: "elm", role: "support" });
  expect(
    value(
      await db.transaction((tx) =>
        state.access.policy.authorizeCustomer(
          tx,
          invitee.actor,
          target,
          "read",
          true,
        ),
      ),
    ).customerMembership,
  ).toEqual(renewed);
  const other = value(
    await state.access.inviteMember(elm.headers, state.ids.elm, {
      ...request,
      requestId: randomUUID(),
      email: "outsider@accounts.test",
    }),
  );
  expect(
    await state.access.revokeInvitation(
      staff.headers,
      state.ids.birch,
      other.invitationId!,
      { requestId: randomUUID() },
    ),
  ).toEqual({ ok: false, code: "not_found" });
  const revoke = { requestId: randomUUID() };
  expect(
    value(
      await state.access.revokeInvitation(
        elm.headers,
        state.ids.elm,
        other.invitationId!,
        revoke,
      ),
    ).state,
  ).toBe("completed");
  expect(
    value(
      await state.access.revokeInvitation(
        elm.headers,
        state.ids.elm,
        other.invitationId!,
        revoke,
      ),
    ).state,
  ).toBe("completed");
  expect(
    await state.access.acceptInvitation(outsider.headers, other.invitationId!, {
      requestId: randomUUID(),
    }),
  ).toEqual({ ok: false, code: "conflict" });
  const expired = value(
    await state.access.inviteMember(elm.headers, state.ids.elm, {
      ...request,
      requestId: randomUUID(),
      email: "outsider@accounts.test",
    }),
  );
  await db
    .update(invitation)
    .set({ expiresAt: new Date(Date.now() - 1000) })
    .where(eq(invitation.id, expired.invitationId!));
  expect(
    await state.access.acceptInvitation(
      outsider.headers,
      expired.invitationId!,
      { requestId: randomUUID() },
    ),
  ).toEqual({ ok: false, code: "conflict" });
});

test("revocation preserves the last administrator and session locks serialize an in-flight authorized mutation", async () => {
  const state = await setup();
  const staff = await state.login("staff"),
    elm = await state.login("elm"),
    collaborator = await state.login("collaborator");
  const members = value(
    await state.access.listMembers(staff.actor, state.ids.elm),
  ).members;
  const admin = members.find((row) => row.userId === "elm")!;
  expect(
    await state.access.revokeMember(staff.headers, state.ids.elm, admin.id, {
      requestId: randomUUID(),
    }),
  ).toEqual({ ok: false, code: "conflict" });
  const ordinary = members.find((row) => row.userId === "collaborator")!;
  expect(
    value(
      await state.access.revokeMember(elm.headers, state.ids.elm, ordinary.id, {
        requestId: randomUUID(),
      }),
    ).state,
  ).toBe("completed");
  expect(
    await state.customers.getCustomer(collaborator.actor, state.ids.elm),
  ).toEqual({ ok: false, code: "not_found" });
  expect(
    value(await state.customers.listCustomers(collaborator.actor)).total,
  ).toBe(1);
  await db.transaction(async (tx) => {
    expect(
      value(
        await state.access.policy.authorizeStaff(
          tx,
          staff.actor,
          ["account_administrator"],
          true,
        ),
      ),
    ).toBeUndefined();
    const revoker = await lockPool.connect();
    try {
      await revoker.query("BEGIN");
      await revoker.query("SET LOCAL lock_timeout = '100ms'");
      expect(
        await rejection(
          revoker.query('delete from "session" where id = $1', [
            staff.actor.sessionId,
          ]),
        ),
      ).toMatchObject({ code: "55P03" });
      await revoker.query("ROLLBACK");
    } finally {
      revoker.release();
    }
  });
  await db.delete(session).where(eq(session.id, staff.actor.sessionId));
  expect(await state.access.policy.readScope(staff.actor)).toEqual({
    ok: false,
    code: "unauthenticated",
  });
});

test("stable registry preserves mutable profiles, optimistic versions and transactional audit", async () => {
  const state = await setup();
  const staff = await state.login("staff");
  const provider = new SyntheticBillingProvider();
  provider.ownership.deploymentKey = "test";
  await resumeEffects(pool, "test");
  const billing = createBilling({
    pool,
    provider,
    deploymentKey: "test",
    customers: state.registry,
    now: () => new Date("2030-01-01T12:00:00Z"),
  });
  const firstRequest: InvoiceRequest = {
    originKey: "accounts:before-edit",
    customer: { key: "elm", name: "Elm (sample)" },
    issueDate: "2030-01-01",
    dueDate: "2030-01-22",
    currency: "USD",
    lines: [
      { description: "Synthetic service", amountMinor: 1200, originRef: null },
    ],
  };
  const before = await billing.requestInvoice(firstRequest);
  if (before.kind !== "created")
    throw new Error("Expected initial invoice request");
  const requestId = randomUUID();
  const updated = value(
    await state.customers.updateCustomer(staff.actor, state.ids.elm, {
      requestId,
      expectedVersion: 1,
      profile: profile("Elm revised"),
    }),
  );
  expect(updated.customer.version).toBe(2);
  const secondRequest: InvoiceRequest = {
    ...firstRequest,
    originKey: "accounts:after-edit",
    customer: { key: "elm", name: "Elm revised (sample)" },
  };
  const after = await billing.requestInvoice(secondRequest);
  if (after.kind !== "created")
    throw new Error("Expected request after profile edit");
  const [oldInvoice, newInvoice] = await Promise.all([
    billing.getInvoice(before.invoiceId),
    billing.getInvoice(after.invoiceId),
  ]);
  expect(oldInvoice?.invoice.billTo).toEqual({
    legalName: "Elm (sample)",
    billingEmail: null,
    profileVersion: 1,
  });
  expect(newInvoice?.invoice.billTo).toEqual({
    legalName: "Elm revised (sample)",
    billingEmail: null,
    profileVersion: 2,
  });
  expect(oldInvoice?.invoice.customer.id).toBe(state.ids.elm);
  expect(newInvoice?.invoice.customer.id).toBe(state.ids.elm);
  const mapping = await pool.query<{
    customer_id: string;
    name: string;
    invoice_count: number;
  }>(
    "select b.customer_id,b.name,count(i.id)::int as invoice_count from billing_customers b join invoices i on i.billing_customer_id=b.id where b.deployment_key=$1 group by b.id",
    ["test"],
  );
  expect(mapping.rows).toEqual([
    { customer_id: state.ids.elm, name: "Elm (sample)", invoice_count: 2 },
  ]);
  await billing.assertSyntheticData(
    [firstRequest, secondRequest],
    provider.ownership.accountId,
    [profile("Elm"), profile("Elm revised")],
  );
  expect(
    await state.customers.updateCustomer(staff.actor, state.ids.elm, {
      requestId: randomUUID(),
      expectedVersion: 1,
      profile: profile("Elm"),
    }),
  ).toEqual({ ok: false, code: "conflict" });
  expect(
    await state.customers.updateCustomer(staff.actor, state.ids.elm, {
      requestId,
      expectedVersion: 2,
      profile: profile("Elm"),
    }),
  ).toEqual({ ok: false, code: "conflict" });
  const retained = await db.transaction((tx) =>
    state.registry.ensureCustomer(tx, {
      registryKey: '["test","elm"]',
      initialProfile: profile("Elm"),
    }),
  );
  expect(retained).toEqual({
    customerId: state.ids.elm,
    profile: profile("Elm revised"),
    version: 2,
  });
  const legacyRegistry = createCustomerRegistry({
    operatorId: "legacy-test",
    audit: createAuditWriter(),
    allowProfile: (current) =>
      JSON.stringify(current) === JSON.stringify(profile("Elm")),
  });
  expect(
    await rejection(
      db.transaction((tx) =>
        legacyRegistry.ensureCustomer(tx, {
          registryKey: '["test","elm"]',
          initialProfile: profile("Elm"),
        }),
      ),
    ),
  ).toMatchObject({
    message: "Current customer profile is outside the configured policy",
  });
  const events = await db
    .select()
    .from(auditEntries)
    .where(
      and(
        eq(auditEntries.requestId, requestId),
        eq(auditEntries.action, "customer.profile.updated"),
      ),
    );
  expect(events).toHaveLength(1);
  expect(events[0]?.details).toEqual({
    changedFields: ["displayName", "legalName"],
  });
  const failing = createCustomers({
    pool,
    access: state.access.policy,
    audit: {
      ...createAuditWriter(),
      append: async () => {
        throw new Error("Synthetic audit failure");
      },
    },
    providerProfile: async () => "not_linked",
    allowProfile: allowed,
  });
  expect(
    await rejection(
      failing.updateCustomer(staff.actor, state.ids.elm, {
        requestId: randomUUID(),
        expectedVersion: 2,
        profile: profile("Elm"),
      }),
    ),
  ).toMatchObject({ message: "Synthetic audit failure" });
  expect(
    value(await state.customers.getCustomer(staff.actor, state.ids.elm))
      .customer.version,
  ).toBe(2);
});

test("lost acceptance receipts reconcile membership while accepted-without-membership needs review", async () => {
  let broken = false;
  const state = await setup((gateway) => ({
    ...gateway,
    acceptInvitation: async (headers, id) => {
      if (broken)
        await db
          .update(invitation)
          .set({ status: "accepted" })
          .where(eq(invitation.id, id));
      else await gateway.acceptInvitation(headers, id);
      throw new Error("Synthetic lost library receipt");
    },
  }));
  const staff = await state.login("staff"),
    outsider = await state.login("outsider");
  const created = value(
    await state.access.inviteMember(staff.headers, state.ids.elm, {
      requestId: randomUUID(),
      email: "outsider@accounts.test",
      role: "member",
    }),
  );
  const request = { requestId: randomUUID() };
  expect(
    value(
      await state.access.acceptInvitation(
        outsider.headers,
        created.invitationId!,
        request,
      ),
    ).state,
  ).toBe("completed");
  expect(
    value(
      await state.access.acceptInvitation(
        outsider.headers,
        created.invitationId!,
        request,
      ),
    ).state,
  ).toBe("completed");
  expect(
    value(
      await state.access.policy.authorizeCustomer(
        db,
        outsider.actor,
        { customerId: state.ids.elm, organizationId: "elm-org" },
        "read",
        false,
      ),
    ).customerMembership,
  ).toEqual({
    id: expect.any(String),
    invitationId: created.invitationId,
    invitedByUserId: "staff",
    invitedByStaff: true,
  });
  broken = true;
  const second = value(
    await state.access.inviteMember(staff.headers, state.ids.birch, {
      requestId: randomUUID(),
      email: "invitee@accounts.test",
      role: "member",
    }),
  );
  const invitee = await state.login("invitee");
  expect(
    value(
      await state.access.acceptInvitation(
        invitee.headers,
        second.invitationId!,
        { requestId: randomUUID() },
      ),
    ).state,
  ).toBe("needs_review");
  expect(value(await state.customers.listCustomers(invitee.actor)).total).toBe(
    0,
  );
});

test("synthetic bootstrap never restores revoked membership and raw authentication mutations remain blocked", async () => {
  const state = await setup();
  const staff = await state.login("staff");
  const [target] = await db
    .select()
    .from(member)
    .where(
      and(
        eq(member.userId, "collaborator"),
        eq(member.organizationId, "elm-org"),
      ),
    );
  value(
    await state.access.revokeMember(staff.headers, state.ids.elm, target!.id, {
      requestId: randomUUID(),
    }),
  );
  await db.transaction((tx) => bootstrapSyntheticAccess(tx, manifest));
  expect(
    await db.select().from(member).where(eq(member.id, target!.id)),
  ).toHaveLength(0);
  await assertSyntheticAccess(pool, {
    users: manifest.users.map((row) => ({
      email: row.email,
      names: [row.name],
      staffRoles: row.staffRoles,
    })),
    organizations: manifest.organizations,
  });
  await assertSyntheticCustomers(pool, {
    registryKeys: ['["test","elm"]', '["test","birch"]'],
    organizationIds: ["elm-org", "birch-org"],
    allowProfile: allowed,
  });
  expect(
    (
      await state.auth.handler(
        new Request(`${origin}/api/auth/organization/create`, {
          method: "POST",
          headers: staff.headers,
        }),
      )
    ).status,
  ).toBe(404);
  const foreign = new Headers(staff.headers);
  foreign.set("origin", "https://foreign.test");
  expect(
    await state.access.inviteMember(foreign, state.ids.elm, {
      requestId: randomUUID(),
      email: "invitee@accounts.test",
      role: "member",
    }),
  ).toEqual({ ok: false, code: "forbidden" });
  const rejected = await state.auth.handler(
    new Request(`${origin}/api/auth/sign-in/magic-link`, {
      method: "POST",
      headers: foreign,
    }),
  );
  expect(rejected.status).toBe(403);
  const fakeActor: HumanActor = { userId: "staff", sessionId: randomUUID() };
  expect(await state.customers.getCustomer(fakeActor, state.ids.elm)).toEqual({
    ok: false,
    code: "unauthenticated",
  });
});
