import { afterAll, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { and, eq } from "drizzle-orm";
import { createAuditWriter, bootstrapSyntheticAccess } from "../../src/access";
import { createPolicy } from "../../src/access/internal/policy";
import {
  user,
  session,
  member,
  invitation,
  staffGrants,
  auditEntries,
} from "../../src/access/internal/schema";
import type {
  AccessResult,
  AuditWriter,
  HumanActor,
} from "../../src/access/types";
import type { StaffRole } from "../../src/access/contract";
import { createCustomers, createCustomerRegistry } from "../../src/customers";
import { createServices, bootstrapSyntheticServices } from "../../src/services";
import type { ServiceManifest } from "../../src/services/types";
import {
  services as serviceRows,
  serviceComponents,
} from "../../src/services/schema";
import { createSupport, type SupportOptions } from "../../src/support";
import type {
  TicketResponse,
  ProposeRequest,
} from "../../src/support/contract";
import {
  supportTickets,
  supportEntries,
  supportApprovals,
  supportProposals,
} from "../../src/support/internal/schema";

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL is required");
const pool = new Pool({ connectionString: url, max: 4 });
const db = drizzle(pool);
const clear = () =>
  pool.query(
    'TRUNCATE customers, "user", organization, verification, access_audit, access_commands CASCADE',
  );
beforeEach(clear);
afterAll(async () => {
  await clear();
  await pool.end();
});
function value<T>(result: AccessResult<T>): T {
  if (!result.ok) throw new Error(result.code);
  return result.value;
}
const rejection = (promise: PromiseLike<unknown>) =>
  promise.then(
    () => null,
    (error: unknown) => error,
  );
const command = (ticket: TicketResponse) => ({
  requestId: randomUUID(),
  expectedVersion: ticket.ticket.version,
});
const proposalInput = (ticket: TicketResponse): ProposeRequest => ({
  ...command(ticket),
  action: "Disable sample web delivery",
  cost: {
    kind: "known",
    currency: "USD",
    amountMinor: 0,
    description: "No charge",
  },
  dataEffect: { kind: "known", description: "No data changes" },
});
const approvalInput = (ticket: TicketResponse) => ({
  ...command(ticket),
  proposalId: ticket.latestProposal!.id,
  proposalVersion: ticket.latestProposal!.version,
});
async function setup() {
  const audit = createAuditWriter();
  const registry = createCustomerRegistry({
    audit,
    operatorId: "support-test",
    allowProfile: () => true,
  });
  const roles: Record<string, StaffRole[]> = {
    support: ["support"],
    account: ["account_administrator"],
    billing: ["billing"],
    admin: [],
    ordinary: [],
    outsider: [],
    dual: ["support"],
    selfInvited: ["account_administrator"],
    staffInvited: [],
  };
  const ids = await db.transaction(async (tx) => {
    await bootstrapSyntheticAccess(tx, {
      operatorId: "support-test",
      allowedEmails: Object.keys(roles).map(
        (id) => `${id.toLowerCase()}@support.test`,
      ),
      users: Object.entries(roles).map(([id, staffRoles]) => ({
        id,
        name: `${id} (sample)`,
        email: `${id.toLowerCase()}@support.test`,
        staffRoles,
      })),
      organizations: [
        {
          id: "elm-org",
          name: "Elm (sample)",
          slug: "elm",
          members: [
            { userId: "admin", role: "administrator" },
            { userId: "ordinary", role: "member" },
            { userId: "dual", role: "administrator" },
            { userId: "selfInvited", role: "administrator" },
            { userId: "staffInvited", role: "administrator" },
          ],
        },
        {
          id: "birch-org",
          name: "Birch (sample)",
          slug: "birch",
          members: [{ userId: "outsider", role: "administrator" }],
        },
      ],
    });
    const register = (key: string, organizationId: string | null) =>
      registry.ensureCustomer(tx, {
        registryKey: JSON.stringify(["support-test", key]),
        organizationId,
        initialProfile: {
          displayName: `${key} (sample)`,
          legalName: `${key} (sample)`,
          billingEmail: null,
        },
      });
    return {
      elm: (await register("Elm", "elm-org")).customerId,
      birch: (await register("Birch", "birch-org")).customerId,
      unbound: (await register("Unbound", null)).customerId,
    };
  });
  const actors: Record<string, HumanActor> = {};
  for (const userId of Object.keys(roles)) {
    await db
      .update(user)
      .set({ emailVerified: true })
      .where(eq(user.id, userId));
    const sessionId = randomUUID();
    await db.insert(session).values({
      id: sessionId,
      userId,
      token: randomUUID(),
      expiresAt: new Date(Date.now() + 86400000),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    actors[userId] = { userId, sessionId };
  }
  // Real access provenance receipts tied to the exact current membership.
  for (const [userId, inviterId] of [
    ["selfInvited", "selfInvited"],
    ["staffInvited", "account"],
  ]) {
    const [membership] = await db
      .select()
      .from(member)
      .where(eq(member.userId, userId));
    const invitationId = randomUUID();
    await db.insert(invitation).values({
      id: invitationId,
      organizationId: "elm-org",
      email: `${userId.toLowerCase()}@support.test`,
      role: "admin",
      status: "accepted",
      expiresAt: new Date(Date.now() + 86400000),
      createdAt: new Date(),
      inviterId,
    });
    await db.insert(auditEntries).values([
      {
        id: randomUUID(),
        actorId: inviterId,
        customerId: ids.elm,
        targetId: invitationId,
        action: "invitation.create.requested",
        details: { invitedByStaff: true },
      },
      {
        id: randomUUID(),
        actorId: userId,
        customerId: ids.elm,
        targetId: invitationId,
        action: "invitation.accept.completed",
        details: { memberId: membership.id },
      },
    ]);
  }
  const customers = createCustomers({
    pool,
    access: createPolicy(pool),
    audit,
    allowProfile: () => true,
    providerProfile: async () => "not_linked",
  });
  const serviceIds = {
    elm: randomUUID(),
    birch: randomUUID(),
    unbound: randomUUID(),
    component: randomUUID(),
    foreignComponent: randomUUID(),
  };
  const manifest: ServiceManifest = {
    services: (["elm", "birch", "unbound"] as const).map((key) => ({
      id: serviceIds[key],
      customerId: ids[key],
      sourceKey: key,
      kind: "hosting",
      name: `${key} sample hosting`,
      packageName: null,
      includedComponents: ["web"],
      attachedServiceId: null,
    })),
    components: [
      {
        id: serviceIds.component,
        customerId: ids.elm,
        serviceId: serviceIds.elm,
      },
      {
        id: serviceIds.foreignComponent,
        customerId: ids.birch,
        serviceId: serviceIds.birch,
      },
    ].map((target) => ({
      ...target,
      kind: "web",
      delivery: "external",
      providerLabel: "Sample provider",
      hostingAccountId: null,
      manager: "staff",
      requestedSetting: "enabled",
      providerState: "unknown",
      checkedAt: null,
    })),
    hostingAccounts: [],
    websites: [],
    names: [],
    registrations: [],
  };
  await db.transaction((tx) =>
    bootstrapSyntheticServices(tx, {
      audit,
      operatorId: "support-test",
      bootstrapKey: "support-test",
      manifest,
      allowRecord: () => true,
    }),
  );
  const services = createServices({
    pool,
    authorizeCustomer: (...args) => customers.authorizeCustomer(...args),
    audit,
    allowRecord: () => true,
    providerLinks: {},
  });
  const options: SupportOptions = {
    pool,
    authorizeCustomer: (...args) => customers.authorizeCustomer(...args),
    audit,
    readTarget: (...args) => services.readTarget(...args),
  };
  const support = createSupport(options);
  const open = async () =>
    value(
      await support.openTicket(actors.ordinary, ids.elm, {
        requestId: randomUUID(),
        serviceId: serviceIds.elm,
        componentId: serviceIds.component,
        subject: "Sample web request",
        body: "Please review web delivery.",
      }),
    );
  return { support, options, services, actors, ids, serviceIds, open };
}

test("support privacy, roles, revocation and membership provenance", async () => {
  const s = await setup();
  let ticket = await s.open();
  const original = value(
    await s.support.getTicket(s.actors.ordinary, s.ids.elm, ticket.ticket.id),
  );
  const originalList = value(
    await s.support.listTickets(s.actors.ordinary, s.ids.elm),
  );
  ticket = value(
    await s.support.addNote(s.actors.support, s.ids.elm, ticket.ticket.id, {
      ...command(ticket),
      body: "Private investigation by staff.",
    }),
  );
  expect(ticket.total).toBe(2);
  expect(ticket.ticket.version).toBe(original.ticket.version);
  expect(
    value(
      await s.support.getTicket(s.actors.ordinary, s.ids.elm, ticket.ticket.id),
    ),
  ).toEqual(original);
  expect(
    value(await s.support.listTickets(s.actors.ordinary, s.ids.elm)),
  ).toEqual(originalList);
  expect(
    value(
      await s.support.getTicket(
        s.actors.ordinary,
        s.ids.elm,
        ticket.ticket.id,
        { limit: 1, offset: 1 },
      ),
    ),
  ).toMatchObject({ entries: [], total: 1 });
  expect(
    value(
      await s.support.getTicket(s.actors.support, s.ids.elm, ticket.ticket.id, {
        limit: 1,
        offset: 1,
      }),
    ),
  ).toMatchObject({ total: 2 });
  for (const role of ["account", "billing"]) {
    expect(await s.support.listTickets(s.actors[role], s.ids.elm)).toEqual({
      ok: false,
      code: "forbidden",
    });
    expect(
      await s.support.reply(s.actors[role], s.ids.elm, ticket.ticket.id, {
        ...command(ticket),
        body: "Denied",
      }),
    ).toEqual({ ok: false, code: "forbidden" });
  }
  expect(
    await s.support.getTicket(s.actors.outsider, s.ids.elm, ticket.ticket.id),
  ).toEqual({ ok: false, code: "not_found" });
  expect(
    await s.support.getTicket(s.actors.support, s.ids.birch, ticket.ticket.id),
  ).toEqual({ ok: false, code: "not_found" });
  expect(
    await s.support.addNote(s.actors.ordinary, s.ids.elm, ticket.ticket.id, {
      ...command(ticket),
      body: "Denied",
    }),
  ).toEqual({ ok: false, code: "forbidden" });
  expect(
    await s.support.openTicket(s.actors.ordinary, s.ids.elm, {
      requestId: randomUUID(),
      serviceId: s.serviceIds.elm,
      componentId: s.serviceIds.foreignComponent,
      subject: "Wrong component",
      body: "Denied",
    }),
  ).toEqual({ ok: false, code: "not_found" });
  expect(
    await rejection(
      db.insert(supportTickets).values({
        id: randomUUID(),
        customerId: s.ids.elm,
        serviceId: s.serviceIds.elm,
        componentId: s.serviceIds.foreignComponent,
        subject: "Wrong component",
        openedByUserId: "ordinary",
      }),
    ),
  ).toBeInstanceOf(Error);
  expect(
    await rejection(
      db.insert(supportEntries).values({
        id: randomUUID(),
        ticketId: ticket.ticket.id,
        customerId: s.ids.birch,
        kind: "reply",
        body: "Wrong customer",
        authorUserId: "outsider",
      }),
    ),
  ).toBeInstanceOf(Error);
  ticket = value(
    await s.support.propose(
      s.actors.support,
      s.ids.elm,
      ticket.ticket.id,
      proposalInput(ticket),
    ),
  );
  expect(
    value(
      await s.support.getTicket(
        s.actors.selfInvited,
        s.ids.elm,
        ticket.ticket.id,
      ),
    ).permissions,
  ).toMatchObject({ canApprove: false, approvalBlockedReason: "self_invited" });
  expect(
    await s.support.approve(
      s.actors.selfInvited,
      s.ids.elm,
      ticket.ticket.id,
      approvalInput(ticket),
    ),
  ).toEqual({ ok: false, code: "forbidden" });
  expect(
    await s.support.approve(
      s.actors.ordinary,
      s.ids.elm,
      ticket.ticket.id,
      approvalInput(ticket),
    ),
  ).toEqual({ ok: false, code: "forbidden" });
  ticket = value(
    await s.support.approve(
      s.actors.staffInvited,
      s.ids.elm,
      ticket.ticket.id,
      approvalInput(ticket),
    ),
  );
  expect(ticket.latestProposal?.approval).not.toHaveProperty(
    "staffAttribution",
  );
  const staffView = value(
    await s.support.getTicket(s.actors.support, s.ids.elm, ticket.ticket.id),
  );
  expect(staffView.latestProposal?.approval?.staffAttribution).toMatchObject({
    invitedByUserId: "account",
    invitedByStaff: true,
  });
  ticket = value(
    await s.support.propose(
      s.actors.support,
      s.ids.elm,
      ticket.ticket.id,
      proposalInput(ticket),
    ),
  );
  ticket = value(
    await s.support.approve(
      s.actors.dual,
      s.ids.elm,
      ticket.ticket.id,
      approvalInput(ticket),
    ),
  );
  expect(ticket.latestProposal?.approval?.staffAttribution?.staffRoles).toEqual(
    ["support"],
  );
  const [stored] = await db
    .select()
    .from(supportApprovals)
    .where(eq(supportApprovals.proposalId, ticket.latestProposal!.id));
  expect(stored).toMatchObject({
    approvedByUserId: "dual",
    sessionId: s.actors.dual.sessionId,
    invitationId: null,
  });
  const unbound = value(
    await s.support.openTicket(s.actors.support, s.ids.unbound, {
      requestId: randomUUID(),
      serviceId: s.serviceIds.unbound,
      componentId: null,
      subject: "Unbound customer",
      body: "Staff investigation",
    }),
  );
  expect(unbound.permissions).toMatchObject({
    canApprove: false,
    approvalBlockedReason: "no_customer_organization",
  });
  await db.delete(member).where(eq(member.userId, "ordinary"));
  expect(
    await s.support.reply(s.actors.ordinary, s.ids.elm, ticket.ticket.id, {
      ...command(ticket),
      body: "Revoked",
    }),
  ).toEqual({ ok: false, code: "not_found" });
  await db.delete(staffGrants).where(eq(staffGrants.userId, "support"));
  expect(
    await s.support.addNote(s.actors.support, s.ids.elm, ticket.ticket.id, {
      ...command(ticket),
      body: "Revoked",
    }),
  ).toEqual({ ok: false, code: "not_found" });
  await db.delete(session).where(eq(session.id, s.actors.admin.sessionId));
  expect(
    await s.support.getTicket(s.actors.admin, s.ids.elm, ticket.ticket.id),
  ).toEqual({ ok: false, code: "unauthenticated" });
});

test("support request/reply lifecycle, stale concurrency and audit rollback", async () => {
  const s = await setup();
  const openRequest = {
    requestId: randomUUID(),
    serviceId: s.serviceIds.elm,
    componentId: null,
    subject: "Repeated open",
    body: "One persisted request",
  };
  const opened = await Promise.all([
    s.support.openTicket(s.actors.ordinary, s.ids.elm, openRequest),
    s.support.openTicket(s.actors.ordinary, s.ids.elm, {
      ...openRequest,
      requestId: openRequest.requestId.toUpperCase(),
    }),
  ]);
  expect(opened.filter((result) => result.ok)).toHaveLength(1);
  expect(opened.filter((result) => !result.ok)).toEqual([
    { ok: false, code: "conflict" },
  ]);
  let ticket = await s.open();
  const request = { ...command(ticket), body: "More details from customer." };
  const concurrent = await Promise.all([
    s.support.reply(s.actors.ordinary, s.ids.elm, ticket.ticket.id, request),
    s.support.reply(s.actors.ordinary, s.ids.elm, ticket.ticket.id, {
      ...request,
      requestId: randomUUID(),
    }),
  ]);
  expect(concurrent.filter((result) => result.ok)).toHaveLength(1);
  expect(concurrent.filter((result) => !result.ok)).toEqual([
    { ok: false, code: "conflict" },
  ]);
  ticket = value(
    await s.support.getTicket(s.actors.ordinary, s.ids.elm, ticket.ticket.id),
  );
  expect(ticket.ticket.version).toBe(2);
  expect(ticket.total).toBe(2);
  const used = concurrent[0].ok
    ? request.requestId
    : (
        await db
          .select()
          .from(auditEntries)
          .where(eq(auditEntries.action, "ticket.replied"))
      )[0].requestId!;
  expect(
    await s.support.reply(s.actors.ordinary, s.ids.elm, ticket.ticket.id, {
      ...command(ticket),
      requestId: used,
      body: "Reused identity",
    }),
  ).toEqual({ ok: false, code: "conflict" });
  const failAudit: AuditWriter = {
    ...s.options.audit,
    append: async () => {
      throw new Error("synthetic audit failure");
    },
  };
  const failing = createSupport({ ...s.options, audit: failAudit });
  const failedRequest = { ...command(ticket), body: "Must roll back" };
  expect(
    await rejection(
      failing.reply(
        s.actors.ordinary,
        s.ids.elm,
        ticket.ticket.id,
        failedRequest,
      ),
    ),
  ).toEqual(new Error("synthetic audit failure"));
  expect(
    value(
      await s.support.getTicket(s.actors.ordinary, s.ids.elm, ticket.ticket.id),
    ),
  ).toEqual(ticket);
  ticket = value(
    await s.support.reply(
      s.actors.ordinary,
      s.ids.elm,
      ticket.ticket.id,
      failedRequest,
    ),
  );
  const beforeOpen = value(
    await s.support.listTickets(s.actors.ordinary, s.ids.elm),
  );
  expect(
    await rejection(
      failing.openTicket(s.actors.ordinary, s.ids.elm, {
        requestId: randomUUID(),
        serviceId: s.serviceIds.elm,
        componentId: null,
        subject: "Rollback open",
        body: "No partial ticket",
      }),
    ),
  ).toBeInstanceOf(Error);
  expect(
    value(await s.support.listTickets(s.actors.ordinary, s.ids.elm)),
  ).toEqual(beforeOpen);
  expect(
    await s.support.recordResult(
      s.actors.support,
      s.ids.elm,
      ticket.ticket.id,
      {
        ...command(ticket),
        outcome: "unchanged",
        body: "Verification cannot precede the request.",
        verifiedAt: new Date(
          Date.parse(ticket.ticket.createdAt) - 1000,
        ).toISOString(),
      },
    ),
  ).toEqual({ ok: false, code: "invalid_request" });
  ticket = value(
    await s.support.recordResult(
      s.actors.support,
      s.ids.elm,
      ticket.ticket.id,
      {
        ...command(ticket),
        outcome: "unchanged",
        body: "Verified no change was made.",
        verifiedAt: new Date().toISOString(),
      },
    ),
  );
  expect(ticket.ticket.status).toBe("resolved");
  expect(
    ticket.entries.find((entry) => entry.kind === "result")?.result,
  ).toMatchObject({
    outcome: "unchanged",
    proposalId: null,
    approvedTarget: null,
  });
  ticket = value(
    await s.support.reply(s.actors.ordinary, s.ids.elm, ticket.ticket.id, {
      ...command(ticket),
      body: "Please reconsider.",
    }),
  );
  expect(ticket.ticket.status).toBe("open");
  expect(ticket.entries.map((entry) => entry.body)).toContain(
    "Verified no change was made.",
  );
  expect(
    await s.support.reply(s.actors.ordinary, s.ids.elm, ticket.ticket.id, {
      ...command(ticket),
      body: "\u0000",
    }),
  ).toEqual({ ok: false, code: "invalid_request" });
  const audit = await db
    .select()
    .from(auditEntries)
    .where(eq(auditEntries.targetId, ticket.ticket.id));
  expect(
    audit.filter((entry) => entry.action.startsWith("ticket.")),
  ).toHaveLength(ticket.ticket.version);
  expect(JSON.stringify(audit)).not.toContain("Please reconsider");
});

test("support exact proposal consent, unknown effects, changed targets and zero effects", async () => {
  const s = await setup();
  const serviceBefore = await db.select().from(serviceRows);
  const componentsBefore = await db.select().from(serviceComponents);
  const billingBefore = await pool.query(
    "select (select count(*) from invoices)::int as invoices",
  );
  let ticket = await s.open();
  ticket = value(
    await s.support.propose(
      s.actors.dual,
      s.ids.elm,
      ticket.ticket.id,
      proposalInput(ticket),
    ),
  );
  expect(
    await s.support.approve(
      s.actors.dual,
      s.ids.elm,
      ticket.ticket.id,
      approvalInput(ticket),
    ),
  ).toEqual({ ok: false, code: "forbidden" });
  ticket = value(
    await s.support.propose(s.actors.support, s.ids.elm, ticket.ticket.id, {
      ...proposalInput(ticket),
      cost: { kind: "unknown", reason: "Awaiting estimate" },
    }),
  );
  expect(
    await s.support.approve(
      s.actors.admin,
      s.ids.elm,
      ticket.ticket.id,
      approvalInput(ticket),
    ),
  ).toEqual({ ok: false, code: "conflict" });
  ticket = value(
    await s.support.propose(s.actors.support, s.ids.elm, ticket.ticket.id, {
      ...proposalInput(ticket),
      dataEffect: { kind: "unknown", reason: "Investigation pending" },
    }),
  );
  expect(
    await s.support.approve(
      s.actors.admin,
      s.ids.elm,
      ticket.ticket.id,
      approvalInput(ticket),
    ),
  ).toEqual({ ok: false, code: "conflict" });
  ticket = value(
    await s.support.propose(
      s.actors.support,
      s.ids.elm,
      ticket.ticket.id,
      proposalInput(ticket),
    ),
  );
  const oldProposal = ticket.latestProposal!;
  ticket = value(
    await s.support.approve(
      s.actors.admin,
      s.ids.elm,
      ticket.ticket.id,
      approvalInput(ticket),
    ),
  );
  ticket = value(
    await s.support.propose(s.actors.support, s.ids.elm, ticket.ticket.id, {
      ...proposalInput(ticket),
      action: "Revised web request",
    }),
  );
  expect(ticket.latestProposal?.approval).toBeNull();
  expect(
    await s.support.approve(s.actors.admin, s.ids.elm, ticket.ticket.id, {
      ...command(ticket),
      proposalId: oldProposal.id,
      proposalVersion: oldProposal.version,
    }),
  ).toEqual({ ok: false, code: "conflict" });
  expect(
    await s.support.recordResult(
      s.actors.support,
      s.ids.elm,
      ticket.ticket.id,
      {
        ...command(ticket),
        outcome: "completed",
        proposalId: oldProposal.id,
        proposalVersion: oldProposal.version,
        body: "Stale approval",
        verifiedAt: new Date().toISOString(),
      },
    ),
  ).toEqual({ ok: false, code: "conflict" });
  expect(await db.select().from(serviceRows)).toEqual(serviceBefore);
  expect(await db.select().from(serviceComponents)).toEqual(componentsBefore);
  expect(
    (
      await pool.query(
        "select (select count(*) from invoices)::int as invoices",
      )
    ).rows,
  ).toEqual(billingBefore.rows);
  // Independent Services work changes the target before consent, so a fresh proposal is required.
  value(
    await s.services.setComponentPreference(
      s.actors.support,
      s.ids.elm,
      s.serviceIds.elm,
      s.serviceIds.component,
      {
        requestId: randomUUID(),
        expectedVersion: 1,
        requestedSetting: "disabled",
      },
    ),
  );
  expect(
    value(
      await s.support.getTicket(s.actors.admin, s.ids.elm, ticket.ticket.id),
    ).permissions,
  ).toMatchObject({
    canApprove: false,
    approvalBlockedReason: "target_changed",
  });
  expect(
    await s.support.approve(
      s.actors.admin,
      s.ids.elm,
      ticket.ticket.id,
      approvalInput(ticket),
    ),
  ).toEqual({ ok: false, code: "conflict" });
  ticket = value(
    await s.support.propose(
      s.actors.support,
      s.ids.elm,
      ticket.ticket.id,
      proposalInput(ticket),
    ),
  );
  ticket = value(
    await s.support.approve(
      s.actors.admin,
      s.ids.elm,
      ticket.ticket.id,
      approvalInput(ticket),
    ),
  );
  // Intended work changes the version after approval; ownership remains the completion gate.
  value(
    await s.services.setComponentPreference(
      s.actors.support,
      s.ids.elm,
      s.serviceIds.elm,
      s.serviceIds.component,
      {
        requestId: randomUUID(),
        expectedVersion: 2,
        requestedSetting: "enabled",
      },
    ),
  );
  const afterWork = await db.select().from(serviceComponents);
  const missingTarget = createSupport({
    ...s.options,
    readTarget: async () => null,
  });
  const completion = {
    ...approvalInput(ticket),
    outcome: "completed" as const,
    body: "Staff verified the requested setting.",
    verifiedAt: "now",
  };
  for (const verifiedAt of [
    new Date(Date.now() + 60_000).toISOString(),
    new Date(
      Date.parse(ticket.latestProposal!.approval!.approvedAt) - 1000,
    ).toISOString(),
  ]) {
    expect(
      await s.support.recordResult(
        s.actors.support,
        s.ids.elm,
        ticket.ticket.id,
        {
          ...completion,
          requestId: randomUUID(),
          verifiedAt,
        },
      ),
    ).toEqual({ ok: false, code: "invalid_request" });
  }
  expect(
    await missingTarget.recordResult(
      s.actors.support,
      s.ids.elm,
      ticket.ticket.id,
      completion,
    ),
  ).toEqual({ ok: false, code: "not_found" });
  ticket = value(
    await s.support.recordResult(
      s.actors.support,
      s.ids.elm,
      ticket.ticket.id,
      completion,
    ),
  );
  expect(
    await s.support.recordResult(
      s.actors.support,
      s.ids.elm,
      ticket.ticket.id,
      completion,
    ),
  ).toEqual({ ok: false, code: "conflict" });
  expect(
    value(
      await s.support.getTicket(s.actors.support, s.ids.elm, ticket.ticket.id),
    ),
  ).toEqual(ticket);
  const persistedResults = await db
    .select()
    .from(supportEntries)
    .where(
      and(
        eq(supportEntries.ticketId, ticket.ticket.id),
        eq(supportEntries.kind, "result"),
      ),
    );
  expect(persistedResults).toHaveLength(1);
  expect(persistedResults[0].result?.verifiedAt).toBe(
    ticket.entries.find((entry) => entry.kind === "result")?.result?.verifiedAt,
  );
  expect(persistedResults[0].result?.verifiedAt).not.toBe("now");
  const resultAudit = await db
    .select()
    .from(auditEntries)
    .where(eq(auditEntries.requestId, completion.requestId));
  expect(resultAudit).toHaveLength(1);
  const result = ticket.entries.find((entry) => entry.kind === "result");
  expect(result).toMatchObject({
    authorUserId: "support",
    result: {
      outcome: "completed",
      proposalId: ticket.latestProposal!.id,
      proposalVersion: ticket.latestProposal!.version,
      approvedTarget: { component: { version: 2 } },
      observedTarget: { component: { version: 3 } },
    },
  });
  expect(ticket.ticket.status).toBe("resolved");
  expect(await db.select().from(serviceComponents)).toEqual(afterWork);
  expect(await db.select().from(serviceRows)).toEqual(serviceBefore);
  expect(
    (
      await pool.query(
        "select (select count(*) from invoices)::int as invoices",
      )
    ).rows,
  ).toEqual(billingBefore.rows);
  expect(
    await db
      .select()
      .from(supportProposals)
      .where(
        and(
          eq(supportProposals.ticketId, ticket.ticket.id),
          eq(supportProposals.id, oldProposal.id),
        ),
      ),
  ).toHaveLength(1);
  expect(
    await db
      .select()
      .from(supportApprovals)
      .where(eq(supportApprovals.proposalId, oldProposal.id)),
  ).toHaveLength(1);
});
