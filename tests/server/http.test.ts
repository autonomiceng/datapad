import { afterAll, beforeEach, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportOpenApi } from "../../scripts/openapi";
import { createImportReview } from "../../src/import-review";
import type { ImportFile } from "../../src/import-review/contract";
import { createApp } from "../../src/server/app";
import { createDatabase } from "../../src/server/db/connection";
import { assertDemoDatabase } from "../../src/server/demo-policy";

const url = process.env.TEST_DATABASE_URL;
if (!url)
  throw new Error(
    "TEST_DATABASE_URL must identify the isolated test database.",
  );
const database = createDatabase(url);
const importReview = createImportReview({ db: database.db });
const app = createApp({ importReview });
const clear = () => database.db.execute(sql`TRUNCATE imports CASCADE`);
beforeEach(clear);
afterAll(async () => {
  try {
    await clear();
  } finally {
    await database.close();
  }
});
const request = (path: string) => new Request(`http://localhost${path}`);

test("HTTP scopes reads, bounds pagination, sanitizes failures and demo policy rejects unapproved imports", async () => {
  const empty = await app.handle(request("/api/import-review/sources"));
  expect(empty.status).toBe(200);
  expect(empty.headers.get("cache-control")).toBe("no-store");
  expect(await empty.json()).toEqual({
    items: [],
    total: 0,
    limit: 50,
    offset: 0,
  });

  const envelope: ImportFile = await Bun.file(
    new URL("../../fixtures/import-review/synthetic-v1.json", import.meta.url),
  ).json();
  envelope.sourceId = "synthetic-http";
  envelope.sourceReference = "http-pages";
  envelope.customers.push(
    ...Array.from({ length: 203 }, (_, index) => ({
      recordType: "customer" as const,
      sourceRecordId: `customer-page-${String(index).padStart(3, "0")}`,
      status: "Active",
    })),
  );
  const selection = envelope.recordCounts.find(
    (entry) => entry.recordType === "customer",
  )!;
  selection.selectedCount = 205;
  selection.linkedCount = 0;
  selection.reportedSourceTotalCount = 205;
  const imported = await importReview.importRecords(envelope);
  expect(imported.outcome).toBe("imported");
  if (imported.outcome !== "imported")
    throw new Error("Synthetic HTTP fixture failed to import.");
  const importId = imported.importMetadata.id;
  const customerPath = `/api/import-review/imports/${importId}/customers`;

  const defaultPage = await app.handle(request(customerPath));
  expect(defaultPage.status).toBe(200);
  const defaults = await defaultPage.json();
  expect(defaults).toMatchObject({
    total: 205,
    limit: 50,
    offset: 0,
  });
  expect(defaults.items).toHaveLength(50);
  const maximum = await app.handle(request(`${customerPath}?limit=200`));
  expect(maximum.status).toBe(200);
  expect((await maximum.json()).items).toHaveLength(200);
  const beyond = await app.handle(
    request(`${customerPath}?limit=200&offset=205`),
  );
  expect(beyond.status).toBe(200);
  expect(await beyond.json()).toMatchObject({
    items: [],
    total: 205,
    limit: 200,
    offset: 205,
  });

  const detail = await app.handle(
    request(`${customerPath}/customer-elm?limit=1`),
  );
  expect(detail.status).toBe(200);
  const children = await detail.json();
  expect(children.services.items).toHaveLength(1);
  expect(children.domains.items).toHaveLength(1);
  for (const path of [
    "/api/import-review/sources/synthetic-http/imports",
    `/api/import-review/imports/${importId}/data-issues`,
  ]) {
    const response = await app.handle(request(path));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
  }

  for (const query of [
    "limit=201",
    "limit=0",
    "limit=1.5",
    "limit=unavailable",
    "offset=-1",
    "offset=500001",
    "unexpected=private-value",
  ]) {
    const invalid = await app.handle(request(`${customerPath}?${query}`));
    expect(invalid.status).toBe(422);
    expect(invalid.headers.get("cache-control")).toBe("no-store");
    expect(await invalid.json()).toEqual({ code: "invalid_query" });
  }
  for (const path of [
    "/api/import-review/sources/absent/imports",
    "/api/import-review/imports/00000000-0000-4000-8000-000000000000/customers",
    `${customerPath}/absent`,
    "/api/import-review/imports/00000000-0000-4000-8000-000000000000/data-issues",
  ]) {
    const missing = await app.handle(request(path));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ code: "not_found" });
  }

  const unavailable = createDatabase(
    "postgresql://synthetic:synthetic@127.0.0.1:1/unreachable",
  );
  try {
    const failure = await createApp({
      importReview: createImportReview({ db: unavailable.db }),
    }).handle(request("/api/import-review/sources"));
    expect(failure.status).toBe(503);
    expect(failure.headers.get("cache-control")).toBe("no-store");
    expect(await failure.json()).toEqual({ code: "unavailable" });
  } finally {
    await unavailable.close();
  }
  const policyError = await assertDemoDatabase(importReview).catch(
    (error: unknown) => error,
  );
  expect(policyError).toBeInstanceOf(Error);

  const assetsDir = await mkdtemp(join(tmpdir(), "datapad-assets-"));
  try {
    await writeFile(
      join(assetsDir, "index.html"),
      "<!doctype html><title>Synthetic import review</title>",
    );
    const withAssets = createApp({ importReview, assetsDir });
    await withAssets.modules;
    for (const path of ["/api", "/api/missing"]) {
      const missing = await withAssets.handle(request(path));
      expect(missing.status).toBe(404);
      expect(missing.headers.get("cache-control")).toBe("no-store");
      expect(await missing.json()).toEqual({ code: "not_found" });
    }
    expect(
      await (await withAssets.handle(request("/import-review"))).text(),
    ).toContain("<title>Synthetic import review</title>");
  } finally {
    await rm(assetsDir, { recursive: true, force: true });
  }
});

test("offline OpenAPI describes the actual read operations, errors and stable IDs without accessing persistence", async () => {
  const exported = await exportOpenApi();
  expect(exported).toBe(await exportOpenApi());
  const contract = JSON.parse(exported);
  const requestedSetting =
    contract.paths["/api/customers/{customerId}/services/{serviceId}"].get
      .responses["200"].content["application/json"].schema.properties.service
      .properties.components.items.properties.requestedSetting;
  expect(requestedSetting).toEqual({
    anyOf: [
      { const: "enabled", type: "string" },
      { const: "disabled", type: "string" },
      { type: "null" },
    ],
  });
  const invoiceProperties =
    contract.paths["/api/billing/invoices/{invoiceId}"].get.responses["200"]
      .content["application/json"].schema.properties.invoice.properties;
  for (const nullable of [
    invoiceProperties.providerStatus,
    invoiceProperties.reviewReason,
    invoiceProperties.providerReceipt.properties.reason,
  ]) {
    expect(nullable.anyOf).toContainEqual({ type: "null" });
    expect(nullable.enum).toBeUndefined();
  }
  const live = await app.handle(request("/api/openapi/json"));
  expect(live.status).toBe(200);
  expect(live.headers.get("cache-control")).toBe("no-store");
  expect(await live.json()).toEqual(contract);
  expect(exported).toBe(
    await Bun.file(
      new URL("../../contracts/openapi.json", import.meta.url),
    ).text(),
  );
  const operations = {
    "/api/import-review/sources": "listImportReviewSources",
    "/api/import-review/sources/{sourceId}/imports": "listImportReviewImports",
    "/api/import-review/imports/{importId}/customers":
      "listImportReviewCustomers",
    "/api/import-review/imports/{importId}/customers/{customerId}":
      "getImportReviewCustomer",
    "/api/import-review/imports/{importId}/data-issues": "listDataIssues",
  };
  const billingPaths = [
    "/api/billing/invoices",
    "/api/billing/invoices/{invoiceId}",
    "/api/billing/webhooks/stripe",
  ];
  expect(Object.keys(contract.paths)).toEqual([
    ...Object.keys(operations),
    ...billingPaths,
    "/api/customers/{customerId}/services",
    "/api/customers/{customerId}/services/{serviceId}",
    "/api/customers/{customerId}/services/{serviceId}/components/{componentId}/preference",
    "/api/customers/{customerId}/addons/{addonId}/attach",
    "/api/customers/{customerId}/invoice-options",
    "/api/customers/{customerId}/invoices",
    "/api/customers/{customerId}/invoices/{invoiceId}/preparation",
    "/api/customers/{customerId}/invoices/{invoiceId}/issue",
    "/api/customers/{customerId}/invoices/{invoiceId}/check",
    "/api/customers/{customerId}/subscription-options",
    "/api/customers/{customerId}/subscriptions",
    "/api/customers/{customerId}/subscriptions/{subscriptionId}",
    "/api/customers/{customerId}/subscription-boundaries",
    "/api/customers/{customerId}/billing-forecast",
    "/api/customers/{customerId}/billing-schedule",
    "/api/customers/{customerId}/scheduled-groups",
    "/api/customers/{customerId}/invoices/{invoiceId}/resolution-review",
    "/api/customers/{customerId}/invoices/{invoiceId}/external-payment",
    "/api/customers/{customerId}/invoices/{invoiceId}/void",
    "/api/customers/{customerId}/invoices/{invoiceId}/receipt-correction",
    "/api/customers/{customerId}/invoices/{invoiceId}/reconcile",
    "/api/customers/{customerId}/invoices/{invoiceId}/notices",
    "/api/customers/{customerId}/payment-settings",
    "/api/customers/{customerId}/payment-setups",
    "/api/customers/{customerId}/payment-setups/{setupId}/refresh",
    "/api/customers/{customerId}/automatic-payment-enrollment",
    "/api/customers/{customerId}/automatic-payment-enrollment/reduce",
  ]);
  expect(contract.paths[billingPaths[0]].get.operationId).toBe("listInvoices");
  expect(contract.paths[billingPaths[1]].get.operationId).toBe("getInvoice");
  expect(contract.paths[billingPaths[2]].post.operationId).toBe(
    "receiveStripeBillingEvent",
  );
  for (const [path, operationId] of Object.entries(operations)) {
    expect(Object.keys(contract.paths[path])).toEqual(["get"]);
    const operation = contract.paths[path].get;
    expect(operation.operationId).toBe(operationId);
    expect(Object.keys(operation.responses).sort()).toEqual(
      path.endsWith("/sources")
        ? ["200", "401", "403", "422", "503"]
        : ["200", "401", "403", "404", "422", "503"],
    );
  }
  const sources = contract.paths["/api/import-review/sources"].get;
  const portal = await exportOpenApi(true);
  expect(portal).toBe(
    await Bun.file(
      new URL("../../contracts/portal-openapi.json", import.meta.url),
    ).text(),
  );
  expect(
    JSON.parse(portal).paths["/api/customers/{customerId}"].patch.operationId,
  ).toBe("updateCustomer");
  const customerRole =
    JSON.parse(portal).paths["/api/customers"].get.responses["200"].content[
      "application/json"
    ].schema.properties.customers.items.properties.role;
  expect(customerRole).toEqual({
    anyOf: [
      { const: "administrator", type: "string" },
      { const: "member", type: "string" },
      { type: "null" },
    ],
  });
  const limit = sources.parameters.find(
    (parameter: { name: string }) => parameter.name === "limit",
  );
  expect(limit).toMatchObject({
    in: "query",
    required: false,
    schema: { minimum: 1, maximum: 200, default: 50 },
  });
  expect(
    sources.responses["503"].content["application/json"].schema,
  ).toMatchObject({
    additionalProperties: false,
    properties: {
      code: { enum: ["invalid_query", "not_found", "unavailable"] },
    },
  });
  const detail =
    contract.paths[
      "/api/import-review/imports/{importId}/customers/{customerId}"
    ].get.responses["200"].content["application/json"].schema;
  expect(detail).toMatchObject({
    type: "object",
    properties: {
      importMetadata: { properties: { id: { format: "uuid" } } },
      services: { properties: { items: { type: "array" } } },
      domains: { properties: { items: { type: "array" } } },
    },
  });
});
