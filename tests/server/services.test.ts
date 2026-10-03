import { afterAll, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import canonicalize from "canonicalize";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import {
  createAccess,
  createAuthentication,
  createAuditWriter,
  bootstrapSyntheticAccess,
} from "../../src/access";
import { createCustomers, createCustomerRegistry } from "../../src/customers";
import type { Customers } from "../../src/customers/types";
import type { HumanActor } from "../../src/access/types";
import type { StaffRole } from "../../src/access/contract";
import { user, session, auditEntries } from "../../src/access/internal/schema";
import {
  createServices,
  bootstrapSyntheticServices,
  assertSyntheticServices,
} from "../../src/services";
import type {
  ServiceManifest,
  SyntheticServiceRecord,
} from "../../src/services/types";
import { createBilling } from "../../src/billing";
import { SyntheticBillingProvider } from "./billing-provider";

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL is required");
const pool = new Pool({ connectionString: url, max: 2 });
const lockPool = new Pool({ connectionString: url, max: 2 });
const db = drizzle(pool);
const clear = () =>
  pool.query(
    'TRUNCATE customers, "user", organization, verification, access_audit, access_commands CASCADE',
  );
beforeEach(clear);
afterAll(async () => {
  await clear();
  await Promise.all([pool.end(), lockPool.end()]);
});
const value = <T>(
  result: { ok: true; value: T } | { ok: false; code: string },
): T => {
  if (!result.ok) throw new Error(result.code);
  return result.value;
};
const rejection = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: unknown) => error,
  );
function immutable(record: SyntheticServiceRecord) {
  return canonicalize(
    record.recordType === "service"
      ? { ...record, record: { ...record.record, attachedServiceId: null } }
      : record.recordType === "component"
        ? { ...record, record: { ...record.record, requestedSetting: null } }
        : record,
  );
}
async function setup() {
  const audit = createAuditWriter();
  const registry = createCustomerRegistry({
    operatorId: "services-test",
    audit,
    allowProfile: (profile) =>
      ["Elm (sample)", "Birch (sample)"].includes(profile.legalName) &&
      profile.displayName === profile.legalName &&
      profile.billingEmail === null,
  });
  const staffRoles: Record<string, StaffRole[]> = {
    staff: ["account_administrator"],
    support: ["support"],
    billing: ["billing"],
    customer: [],
    outsider: [],
  };
  const customersIds = await db.transaction(async (tx) => {
    await bootstrapSyntheticAccess(tx, {
      operatorId: "services-test",
      allowedEmails: Object.keys(staffRoles).map(
        (name) => `${name}@services.test`,
      ),
      users: Object.entries(staffRoles).map(([id, roles]) => ({
        id,
        name: `${id} (sample)`,
        email: `${id}@services.test`,
        staffRoles: roles,
      })),
      organizations: [
        {
          id: "elm-org",
          name: "Elm (sample)",
          slug: "elm",
          members: [{ userId: "customer", role: "administrator" }],
        },
        {
          id: "birch-org",
          name: "Birch (sample)",
          slug: "birch",
          members: [{ userId: "outsider", role: "administrator" }],
        },
      ],
    });
    const elm = await registry.ensureCustomer(tx, {
      registryKey: '["services-test","elm"]',
      initialProfile: {
        displayName: "Elm (sample)",
        legalName: "Elm (sample)",
        billingEmail: null,
      },
      organizationId: "elm-org",
    });
    const birch = await registry.ensureCustomer(tx, {
      registryKey: '["services-test","birch"]',
      initialProfile: {
        displayName: "Birch (sample)",
        legalName: "Birch (sample)",
        billingEmail: null,
      },
      organizationId: "birch-org",
    });
    return { elm: elm.customerId, birch: birch.customerId };
  });
  const actors: Record<string, HumanActor> = {};
  for (const userId of Object.keys(staffRoles)) {
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
  const auth = createAuthentication({
    pool,
    baseURL: "http://localhost:4321",
    secret: "services-test-synthetic-secret-0123456789",
    synthetic: true,
    allowedEmails: Object.keys(staffRoles).map(
      (name) => `${name}@services.test`,
    ),
    sendMagicLink: async () => {},
  });
  let customers: Customers;
  const access = createAccess({
    pool,
    lockPool,
    authentication: auth.gateway,
    getCustomerTarget: (id) => customers.getAccessTarget(id),
    getOrganizationTarget: (id) => customers.getOrganizationTarget(id),
    allowInvitation: () => false,
    signInMethods: ["email_link"],
    synthetic: true,
    baseURL: "http://localhost:4321",
    sendInvitation: async () => {},
  });
  customers = createCustomers({
    pool,
    access: access.policy,
    audit,
    allowProfile: () => true,
    providerProfile: async () => "not_linked",
  });
  const ids = {
    hosting: randomUUID(),
    otherHosting: randomUUID(),
    registration: randomUUID(),
    addon: randomUUID(),
    foreign: randomUUID(),
    foreignAddon: randomUUID(),
    container: randomUUID(),
    web: randomUUID(),
    email: randomUUID(),
    dns: randomUUID(),
    externalEmail: randomUUID(),
    externalDns: randomUUID(),
    sharedDns: randomUUID(),
    site: randomUUID(),
    otherSite: randomUUID(),
  };
  const base = {
    packageName: null,
    includedComponents: [],
    attachedServiceId: null,
  };
  const manifest: ServiceManifest = {
    services: [
      {
        ...base,
        id: ids.hosting,
        customerId: customersIds.elm,
        sourceKey: "elm:hosting",
        kind: "hosting",
        name: "Elm hosting (sample)",
        packageName: "Sample package",
        includedComponents: ["web", "email", "dns"],
      },
      {
        ...base,
        id: ids.otherHosting,
        customerId: customersIds.elm,
        sourceKey: "elm:other-hosting",
        kind: "hosting",
        name: "Elm independent DNS (sample)",
      },
      {
        ...base,
        id: ids.registration,
        customerId: customersIds.elm,
        sourceKey: "elm:registration",
        kind: "domain_registration",
        name: "Standalone registration (sample)",
      },
      {
        ...base,
        id: ids.addon,
        customerId: customersIds.elm,
        sourceKey: "elm:addon",
        kind: "addon",
        name: "Extra storage (sample)",
      },
      {
        ...base,
        id: ids.foreign,
        customerId: customersIds.birch,
        sourceKey: "birch:hosting",
        kind: "hosting",
        name: "Birch hosting (sample)",
      },
      {
        ...base,
        id: ids.foreignAddon,
        customerId: customersIds.birch,
        sourceKey: "birch:addon",
        kind: "addon",
        name: "Birch add-on (sample)",
      },
    ],
    hostingAccounts: [
      {
        id: ids.container,
        customerId: customersIds.elm,
        providerKey: "sample-plesk",
        providerLabel: "Sample hosting provider",
        label: "Elm provider container (sample)",
      },
    ],
    components: [],
    websites: [
      { id: ids.site, customerId: customersIds.elm, componentId: ids.web },
      { id: ids.otherSite, customerId: customersIds.elm, componentId: ids.web },
    ],
    names: [],
    registrations: [
      {
        serviceId: ids.registration,
        customerId: customersIds.elm,
        registeredName: "registration.example.test",
        registrarLabel: "Sample registrar",
        manager: "customer",
        expiresOn: null,
        renewalResponsibility: "customer",
      },
    ],
  };
  const component = {
    customerId: customersIds.elm,
    serviceId: ids.hosting,
    delivery: "hosted" as const,
    providerLabel: "Sample hosting provider",
    hostingAccountId: ids.container,
    manager: "staff" as const,
    requestedSetting: "enabled" as const,
    providerState: "enabled" as const,
    checkedAt: "2030-01-01T12:00:00.000Z",
  };
  manifest.components = [
    { ...component, id: ids.web, kind: "web" },
    {
      ...component,
      id: ids.email,
      kind: "email",
      requestedSetting: "disabled",
      providerState: "disabled",
    },
    { ...component, id: ids.dns, kind: "dns" },
    {
      ...component,
      id: ids.externalEmail,
      kind: "email",
      delivery: "external",
      providerLabel: "Sample external mail",
      hostingAccountId: null,
      manager: "customer",
      requestedSetting: null,
      providerState: "unknown",
      checkedAt: null,
    },
    {
      ...component,
      id: ids.externalDns,
      kind: "dns",
      delivery: "external",
      providerLabel: "Sample external DNS",
      requestedSetting: "enabled",
    },
    {
      ...component,
      id: ids.sharedDns,
      serviceId: ids.otherHosting,
      kind: "dns",
    },
  ];
  manifest.names = [
    {
      componentId: ids.web,
      customerId: customersIds.elm,
      componentKind: "web",
      websiteId: ids.site,
      hostname: "elm.example.test",
      isPrimary: true,
    },
    {
      componentId: ids.web,
      customerId: customersIds.elm,
      componentKind: "web",
      websiteId: ids.site,
      hostname: "www.elm.example.test",
      isPrimary: false,
    },
    {
      componentId: ids.web,
      customerId: customersIds.elm,
      componentKind: "web",
      websiteId: ids.otherSite,
      hostname: "shop.elm.example.test",
      isPrimary: true,
    },
    {
      componentId: ids.externalEmail,
      customerId: customersIds.elm,
      componentKind: "email",
      websiteId: null,
      hostname: "mail-only.example.test",
      isPrimary: false,
    },
    {
      componentId: ids.sharedDns,
      customerId: customersIds.elm,
      componentKind: "dns",
      websiteId: null,
      hostname: "delegated.example.test",
      isPrimary: false,
    },
  ];
  const approved = [
    ...manifest.services.map((record) => ({
      recordType: "service" as const,
      record,
    })),
    ...manifest.hostingAccounts.map((record) => ({
      recordType: "hosting_account" as const,
      record,
    })),
    ...manifest.components.map((record) => ({
      recordType: "component" as const,
      record,
    })),
    ...manifest.websites.map((record) => ({
      recordType: "website" as const,
      record,
    })),
    ...manifest.names.map((record) => ({
      recordType: "component_name" as const,
      record,
    })),
    ...manifest.registrations.map((record) => ({
      recordType: "domain_registration" as const,
      record,
    })),
  ].map(immutable);
  const allowRecord = (record: SyntheticServiceRecord) =>
    approved.includes(immutable(record));
  const bootstrap = {
    operatorId: "services-test",
    bootstrapKey: "services-test",
    manifest,
    audit,
    allowRecord,
  };
  await db.transaction((tx) => bootstrapSyntheticServices(tx, bootstrap));
  const options = {
    pool,
    authorizeCustomer: (...args: Parameters<Customers["authorizeCustomer"]>) =>
      customers.authorizeCustomer(...args),
    audit,
    allowRecord,
    providerLinks: {
      "sample-plesk": { url: "https://plesk.example.test/login" },
    },
  };
  return {
    actors,
    customerIds: customersIds,
    ids,
    manifest,
    bootstrap,
    options,
    registry,
    services: createServices(options),
  };
}

test("service authority and composite customer constraints reject foreign attachments including partial-null bypass", async () => {
  const state = await setup();
  expect(
    value(
      await state.services.listServices(
        state.actors.customer,
        state.customerIds.elm,
      ),
    ).total,
  ).toBe(4);
  expect(
    await state.services.getService(
      state.actors.customer,
      state.customerIds.birch,
      state.ids.foreign,
    ),
  ).toEqual({ ok: false, code: "not_found" });
  expect(
    await state.services.setComponentPreference(
      state.actors.billing,
      state.customerIds.elm,
      state.ids.hosting,
      state.ids.web,
      {
        requestId: randomUUID(),
        expectedVersion: 1,
        requestedSetting: "disabled",
      },
    ),
  ).toEqual({ ok: false, code: "forbidden" });
  expect(
    await state.services.attachAddon(
      state.actors.customer,
      state.customerIds.elm,
      state.ids.addon,
      {
        requestId: randomUUID(),
        expectedVersion: 1,
        attachedServiceId: state.ids.hosting,
      },
    ),
  ).toEqual({ ok: false, code: "forbidden" });
  expect(
    await state.services.attachAddon(
      state.actors.support,
      state.customerIds.elm,
      state.ids.addon,
      {
        requestId: randomUUID(),
        expectedVersion: 1,
        attachedServiceId: state.ids.foreign,
      },
    ),
  ).toEqual({ ok: false, code: "not_found" });
  expect(
    await rejection(
      pool.query(
        "update services set attached_service_id=$1,attached_service_kind=null where id=$2",
        [state.ids.foreign, state.ids.addon],
      ),
    ),
  ).toMatchObject({ code: "23514" });
  expect(
    await rejection(
      pool.query(
        "update services set attached_service_id=$1,attached_service_kind='hosting' where id=$2",
        [state.ids.foreign, state.ids.addon],
      ),
    ),
  ).toMatchObject({ code: "23503" });
  const attached = value(
    await state.services.attachAddon(
      state.actors.support,
      state.customerIds.elm,
      state.ids.addon,
      {
        requestId: randomUUID(),
        expectedVersion: 1,
        attachedServiceId: state.ids.hosting,
      },
    ),
  );
  expect(attached.service.attachedService?.id).toBe(state.ids.hosting);
  expect(
    value(
      await state.services.getService(
        state.actors.staff,
        state.customerIds.elm,
        state.ids.hosting,
      ),
    ).service.addons.map((row) => row.id),
  ).toEqual([state.ids.addon]);
  await db
    .delete(session)
    .where(eq(session.id, state.actors.support.sessionId));
  expect(
    await state.services.attachAddon(
      state.actors.support,
      state.customerIds.elm,
      state.ids.addon,
      { requestId: randomUUID(), expectedVersion: 2, attachedServiceId: null },
    ),
  ).toEqual({ ok: false, code: "unauthenticated" });
});

test("independent websites aliases mail DNS and registrations retain scoped delivery and reject contradictory routing", async () => {
  const state = await setup();
  const hosting = value(
    await state.services.getService(
      state.actors.customer,
      state.customerIds.elm,
      state.ids.hosting,
    ),
  ).service;
  expect(hosting.registration).toBeNull();
  expect(hosting.websites).toHaveLength(2);
  expect(
    hosting.websites.find((site) => site.id === state.ids.site)?.aliases,
  ).toEqual(["www.elm.example.test"]);
  expect(
    hosting.components.find((component) => component.id === state.ids.email),
  ).toMatchObject({
    requestedSetting: "disabled",
    providerState: "disabled",
    reviewReason: null,
  });
  expect(
    hosting.components.find(
      (component) => component.id === state.ids.externalEmail,
    ),
  ).toMatchObject({
    manager: "customer",
    requestedSetting: null,
    providerState: "unknown",
    checkedAt: null,
    reviewReason: null,
    domains: ["mail-only.example.test"],
  });
  expect(hosting.hostingAccounts[0]?.loginUrl).toBe(
    "https://plesk.example.test/login",
  );
  const independent = value(
    await state.services.getService(
      state.actors.customer,
      state.customerIds.elm,
      state.ids.otherHosting,
    ),
  ).service;
  expect(independent.websites).toEqual([]);
  expect(independent.components[0]).toMatchObject({
    kind: "dns",
    reviewReason: "running_without_entitlement",
    domains: ["delegated.example.test"],
  });
  expect(independent.hostingAccounts[0]?.id).toBe(
    hosting.hostingAccounts[0]?.id,
  );
  const registration = value(
    await state.services.getService(
      state.actors.customer,
      state.customerIds.elm,
      state.ids.registration,
    ),
  ).service;
  expect(registration.components).toEqual([]);
  expect(registration.registration).toMatchObject({
    registeredName: "registration.example.test",
    expiresOn: null,
  });
  expect(
    await rejection(
      pool.query(
        "insert into component_names(component_id,customer_id,component_kind,website_id,hostname,is_primary) values($1,$2,'web',$3,'www.elm.example.test',false)",
        [state.ids.web, state.customerIds.elm, state.ids.otherSite],
      ),
    ),
  ).toMatchObject({ code: "23505" });
  expect(() =>
    createServices({
      ...state.options,
      providerLinks: {
        "sample-plesk": { url: "https://user:secret@plesk.example.test/login" },
      },
    }),
  ).toThrow("credential-free");
  await assertSyntheticServices(pool, {
    manifest: state.manifest,
    allowRecord: state.options.allowRecord,
  });
});

test("preferences and attachments preserve observed delivery and billing while audit failure rolls back changes", async () => {
  const state = await setup();
  const provider = new SyntheticBillingProvider();
  provider.ownership.deploymentKey = "services-test";
  const billing = createBilling({
    pool,
    provider,
    deploymentKey: "services-test",
    customers: state.registry,
    now: () => new Date("2030-01-01T12:00:00.000Z"),
  });
  const requested = await billing.requestInvoice({
    originKey: "services:invoice",
    customer: { key: "elm", name: "Elm (sample)" },
    issueDate: "2030-01-01",
    dueDate: "2030-01-22",
    currency: "USD",
    lines: [
      {
        description: "Sample service charge",
        amountMinor: 1200,
        originRef: null,
      },
    ],
  });
  if (requested.kind !== "created") throw new Error("Expected sample invoice");
  const invoiceBefore = await billing.getInvoice(requested.invoiceId);
  const before = value(
    await state.services.getService(
      state.actors.staff,
      state.customerIds.elm,
      state.ids.hosting,
    ),
  ).service;
  const noOpId = randomUUID();
  await state.services.setComponentPreference(
    state.actors.staff,
    state.customerIds.elm,
    state.ids.hosting,
    state.ids.web,
    { requestId: noOpId, expectedVersion: 1, requestedSetting: "enabled" },
  );
  expect(
    await db
      .select()
      .from(auditEntries)
      .where(eq(auditEntries.requestId, noOpId)),
  ).toHaveLength(0);
  const changed = value(
    await state.services.setComponentPreference(
      state.actors.staff,
      state.customerIds.elm,
      state.ids.hosting,
      state.ids.web,
      { requestId: noOpId, expectedVersion: 1, requestedSetting: "disabled" },
    ),
  ).service;
  expect(
    changed.components.find((row) => row.id === state.ids.web),
  ).toMatchObject({
    requestedSetting: "disabled",
    providerState: "enabled",
    checkedAt: "2030-01-01T12:00:00.000Z",
    version: 2,
    reviewReason: "requested_state_differs",
  });
  expect(changed.components.filter((row) => row.id !== state.ids.web)).toEqual(
    before.components.filter((row) => row.id !== state.ids.web),
  );
  expect(
    await state.services.setComponentPreference(
      state.actors.staff,
      state.customerIds.elm,
      state.ids.hosting,
      state.ids.web,
      {
        requestId: randomUUID(),
        expectedVersion: 1,
        requestedSetting: "enabled",
      },
    ),
  ).toEqual({ ok: false, code: "conflict" });
  expect(
    await state.services.setComponentPreference(
      state.actors.staff,
      state.customerIds.elm,
      state.ids.hosting,
      state.ids.web,
      { requestId: noOpId, expectedVersion: 2, requestedSetting: "enabled" },
    ),
  ).toEqual({ ok: false, code: "conflict" });
  expect(
    await state.services.setComponentPreference(
      state.actors.staff,
      state.customerIds.elm,
      state.ids.hosting,
      state.ids.externalEmail,
      {
        requestId: randomUUID(),
        expectedVersion: 1,
        requestedSetting: "disabled",
      },
    ),
  ).toEqual({ ok: false, code: "invalid_request" });
  expect(
    value(
      await state.services.setComponentPreference(
        state.actors.support,
        state.customerIds.elm,
        state.ids.hosting,
        state.ids.externalDns,
        {
          requestId: randomUUID(),
          expectedVersion: 1,
          requestedSetting: "disabled",
        },
      ),
    ).service.components.find((row) => row.id === state.ids.externalDns)
      ?.requestedSetting,
  ).toBe("disabled");
  expect(
    await state.services.attachAddon(
      state.actors.staff,
      state.customerIds.elm,
      state.ids.addon,
      {
        requestId: noOpId,
        expectedVersion: 1,
        attachedServiceId: state.ids.hosting,
      },
    ),
  ).toEqual({ ok: false, code: "conflict" });
  expect(
    value(
      await state.services.getService(
        state.actors.staff,
        state.customerIds.elm,
        state.ids.addon,
      ),
    ).service,
  ).toMatchObject({ attachedService: null, version: 1 });
  await state.services.attachAddon(
    state.actors.staff,
    state.customerIds.elm,
    state.ids.addon,
    {
      requestId: randomUUID(),
      expectedVersion: 1,
      attachedServiceId: state.ids.hosting,
    },
  );
  expect(
    value(
      await state.services.attachAddon(
        state.actors.support,
        state.customerIds.elm,
        state.ids.addon,
        {
          requestId: randomUUID(),
          expectedVersion: 2,
          attachedServiceId: null,
        },
      ),
    ).service.attachedService,
  ).toBeNull();
  const failing = createServices({
    ...state.options,
    audit: {
      ...state.options.audit,
      append: async () => {
        throw new Error("Synthetic audit unavailable");
      },
    },
  });
  expect(
    await rejection(
      failing.setComponentPreference(
        state.actors.staff,
        state.customerIds.elm,
        state.ids.hosting,
        state.ids.web,
        {
          requestId: randomUUID(),
          expectedVersion: 2,
          requestedSetting: "enabled",
        },
      ),
    ),
  ).toMatchObject({ message: "Synthetic audit unavailable" });
  expect(
    value(
      await state.services.getService(
        state.actors.staff,
        state.customerIds.elm,
        state.ids.hosting,
      ),
    ).service.components.find((row) => row.id === state.ids.web)?.version,
  ).toBe(2);
  await db.transaction((tx) => bootstrapSyntheticServices(tx, state.bootstrap));
  expect(
    value(
      await state.services.getService(
        state.actors.staff,
        state.customerIds.elm,
        state.ids.hosting,
      ),
    ).service.components.find((row) => row.id === state.ids.web)
      ?.requestedSetting,
  ).toBe("disabled");
  expect(await billing.getInvoice(requested.invoiceId)).toEqual(invoiceBefore);
  await assertSyntheticServices(pool, {
    manifest: state.manifest,
    allowRecord: state.options.allowRecord,
  });
});
