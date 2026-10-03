import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { createDatabase } from "../../src/server/db/connection";
import { assertDemoImport } from "../../src/server/demo-policy";
import { createImportReview, importDigest } from "../../src/import-review";
import type {
  ImportResult,
  ImportFile,
} from "../../src/import-review/contract";
import first from "../../fixtures/import-review/synthetic-v1.json";
import later from "../../fixtures/import-review/synthetic-v1-later.json";

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL is required");
const connection = createDatabase(url);
const importReview = createImportReview(connection);
const prefix = `test-${randomUUID()}`;
const sourceIds = new Set<string>();
function fixture(suffix: string, value: unknown = first): ImportFile {
  const copy: ImportFile = JSON.parse(JSON.stringify(value));
  copy.sourceId = `${prefix}-${suffix}`;
  sourceIds.add(copy.sourceId);
  return copy;
}
function importMetadata(result: ImportResult) {
  if (result.outcome !== "imported" && result.outcome !== "unchanged")
    throw new Error(`Unexpected ${result.outcome}`);
  return result.importMetadata;
}
beforeAll(() => {
  expect(process.env.TZ).toBe("Asia/Tokyo");
});
afterAll(async () => {
  for (const sourceId of sourceIds) {
    await connection.db.transaction(async (tx) => {
      for (const table of [
        "import_services",
        "import_domains",
        "import_customers",
      ]) {
        await tx.execute(
          sql`DELETE FROM ${sql.identifier(table)} WHERE import_id IN (SELECT id FROM imports WHERE source_id = ${sourceId})`,
        );
      }
      await tx.execute(sql`DELETE FROM imports WHERE source_id = ${sourceId}`);
    });
  }
  await connection.close();
});

test("imports and reads the full import with record counts and typed references", async () => {
  const value = fixture("read");
  const imported = importMetadata(await importReview.importRecords(value));
  const customers = await importReview.listCustomers(imported.id);
  expect(customers?.items.map((row) => row.label)).toEqual([
    "Customer customer-birch",
    "Customer customer-elm",
  ]);
  expect(customers?.importMetadata.recordCounts).toEqual(value.recordCounts);
  expect(customers?.importMetadata.dataAsOf).toBe("2026-10-01T12:00:00.000Z");
  const detail = await importReview.getCustomer(imported.id, "customer-elm");
  expect(detail?.services.total).toBe(4);
  expect(detail?.domains.total).toBe(1);
  expect(
    detail?.services.items.find((item) => item.recordType === "addon")
      ?.attachedService,
  ).toEqual({ recordType: "service", sourceRecordId: "hosting-elm" });
  expect(detail?.domains.items[0].customer).toEqual({
    recordType: "customer",
    sourceRecordId: "customer-elm",
  });
  const bounded = await importReview.getCustomer(imported.id, "customer-elm", {
    limit: 1,
    offset: 1,
  });
  expect(bounded?.services.items).toHaveLength(1);
  expect(bounded?.services.total).toBe(4);
  expect(bounded?.domains.items).toEqual([]);
});

test("arbitrates repeat and concurrent imports across independent connections", async () => {
  const value = fixture("concurrent");
  const other = createDatabase(url);
  try {
    const results = await Promise.all([
      importReview.importRecords(value),
      createImportReview(other).importRecords(value),
    ]);
    expect(results.map((result) => result.outcome).sort()).toEqual([
      "imported",
      "unchanged",
    ]);
    expect(importMetadata(results[0]).id).toBe(importMetadata(results[1]).id);
    expect((await importReview.importRecords(value)).outcome).toBe("unchanged");
    const changed = structuredClone(value);
    changed.services[0].money.amountMinor = "2301";
    expect(await importReview.importRecords(changed)).toEqual({
      outcome: "conflict",
    });
    const stored = await importReview.getCustomer(
      importMetadata(results[0]).id,
      "customer-elm",
    );
    expect(
      stored?.services.items.find(
        (record) =>
          record.recordType === "service" &&
          record.sourceRecordId === "hosting-elm",
      )?.money.amountMinor,
    ).toBe("2300");
  } finally {
    await other.close();
  }
});

test("isolates sources and imports with deterministic latest ordering", async () => {
  const old = fixture("isolation");
  const next = fixture("isolation", later);
  const tied = structuredClone(next);
  tied.sourceReference = "garden-003";
  const unrelated = fixture("other");
  unrelated.services[0].money.amountMinor = "9900";
  const oldMeta = importMetadata(await importReview.importRecords(old));
  const nextMeta = importMetadata(await importReview.importRecords(next));
  importMetadata(await importReview.importRecords(tied));
  const otherMeta = importMetadata(await importReview.importRecords(unrelated));
  expect(
    (await importReview.listImports(old.sourceId))?.items.map(
      (item) => item.sourceReference,
    ),
  ).toEqual(["garden-003", "garden-002", "garden-001"]);
  for (const [id, amount] of [
    [oldMeta.id, "2300"],
    [nextMeta.id, "2700"],
    [otherMeta.id, "9900"],
  ]) {
    const detail = await importReview.getCustomer(id, "customer-elm");
    expect(
      detail?.services.items.find(
        (record) =>
          record.recordType === "service" &&
          record.sourceRecordId === "hosting-elm",
      )?.money.amountMinor,
    ).toBe(amount);
  }
});

test("rejects malformed envelopes atomically while preserving record-type-scoped IDs", async () => {
  const invalid = fixture("invalid");
  const variants: unknown[] = [];
  const missing = JSON.parse(JSON.stringify(invalid));
  delete missing.services[0].cancellationRequested;
  variants.push(missing);
  variants.push({ ...invalid, email: "unaccepted@example.test" });
  for (const amount of [
    "-0",
    "01",
    "1.0",
    "9223372036854775808",
    "-9223372036854775809",
  ]) {
    const copy = structuredClone(invalid);
    copy.services[0].money.amountMinor = amount;
    variants.push(copy);
  }
  for (const malformed of ["\ud800", "\udc00", "prefix\u0000suffix"]) {
    const copy = structuredClone(invalid);
    copy.services[0].productName = malformed;
    expect(importDigest(copy)).toEqual({
      issues: [{ code: "invalid_schema", path: "/" }],
    });
    variants.push(copy);
  }
  const unicode = structuredClone(invalid);
  unicode.services[0].productName = "Garden \ud83c\udf31";
  expect(importDigest(unicode)).toHaveProperty("digest");
  const duplicate = structuredClone(invalid);
  duplicate.services.push(duplicate.services[0]);
  variants.push(duplicate);
  const mismatch = structuredClone(invalid);
  mismatch.recordCounts[0].selectedCount++;
  variants.push(mismatch);
  const timestamp = structuredClone(invalid);
  timestamp.dataAsOf = "2026-02-30T12:00:00Z";
  variants.push(timestamp);
  variants.push({ ...invalid, dataAsOf: "0000-01-01T12:00:00Z" });
  const selection = structuredClone(invalid);
  selection.recordCounts[1].selectionCode =
    selection.recordCounts[0].selectionCode;
  variants.push(selection);
  const reason = structuredClone(invalid);
  reason.recordCounts[1].exclusionReasons = [
    { reasonCode: "outside_selection", count: 1 },
    { reasonCode: "outside_selection", count: 1 },
  ];
  variants.push(reason);
  for (const value of variants)
    expect((await importReview.importRecords(value)).outcome).toBe("invalid");
  expect(await importReview.listImports(invalid.sourceId)).toBeNull();
  const accepted = importMetadata(await importReview.importRecords(invalid));
  const detail = await importReview.getCustomer(accepted.id, "customer-elm");
  expect(
    detail?.services.items
      .filter((record) => record.sourceRecordId === "hosting-elm")
      .map((record) => record.recordType),
  ).toEqual(["addon", "service"]);
  const rejected = await assertDemoImport(invalid).then(
    () => null,
    (error: unknown) => error,
  );
  expect(rejected).toBeInstanceOf(Error);
  await assertDemoImport(first);
});

test("preserves observed statuses, cancellation, money and calendar semantics", async () => {
  const value = fixture("semantics");
  value.services[1].nextInvoiceDate = "2028-02-29";
  value.services[0].money.amountMinor = null;
  const meta = importMetadata(await importReview.importRecords(value));
  const detail = await importReview.getCustomer(meta.id, "customer-elm");
  expect(
    detail?.services.items.find(
      (record) =>
        record.recordType === "service" &&
        record.sourceRecordId === "hosting-elm",
    )?.money.amountMinor,
  ).toBeNull();
  const free = detail?.services.items.find(
    (record) => record.sourceRecordId === "hosting-free",
  );
  expect(free?.money.amountMinor).toBe("0");
  expect(free?.dueDateObservation).toEqual({
    raw: null,
    state: "unset",
    value: null,
  });
  expect(free?.nextInvoiceDateObservation.value).toBe("2028-02-29");
  const paused = detail?.services.items.find(
    (record) => record.sourceRecordId === "hosting-paused",
  );
  expect(paused?.status).toBe("Suspended");
  expect(paused?.cancellationRequested).toBe(true);
  expect(paused?.dueDateObservation).toEqual({
    raw: "2026-02-30",
    state: "invalid",
    value: null,
  });
  const addon = detail?.services.items.find(
    (record) => record.recordType === "addon",
  );
  expect(addon?.money.amountMinor).toBe("-125");
  expect(addon?.cancellationRequested).toBeNull();
  expect(detail?.domains.items[0].termYears).toBe(3);
  expect(detail?.domains.items[0].expiryDateObservation.value).toBe(
    "2026-10-20",
  );
  expect(detail?.domains.items[0].dueDateObservation.value).toBe("2026-10-15");
  expect(detail?.domains.items[0].nextInvoiceDateObservation.value).toBe(
    "2029-10-15",
  );
  const dataIssues = await importReview.listDataIssues(meta.id);
  expect(dataIssues?.items).toEqual([
    {
      code: "invalid_date",
      recordType: "service",
      sourceRecordId: "hosting-orphan",
      field: "nextInvoiceDate",
    },
    {
      code: "missing_related_record",
      recordType: "service",
      sourceRecordId: "hosting-orphan",
      field: "customer",
    },
    {
      code: "unrecognized_status",
      recordType: "service",
      sourceRecordId: "hosting-orphan",
      field: "status",
    },
    {
      code: "invalid_date",
      recordType: "service",
      sourceRecordId: "hosting-paused",
      field: "dueDate",
    },
  ]);
  expect(
    (await importReview.listDataIssues(meta.id, { limit: 1, offset: 2 }))
      ?.items,
  ).toEqual(dataIssues?.items.slice(2, 3));
  const tail = await importReview.listDataIssues(meta.id, { offset: 500000 });
  expect(tail?.items).toEqual([]);
  expect(tail?.total).toBe(dataIssues?.total);

  for (const [relation, attachedService, code] of [
    [
      "different-customer",
      { recordType: "service", sourceRecordId: "hosting-elm" },
      "different_customer",
    ],
    [
      "missing-parent",
      { recordType: "service", sourceRecordId: "hosting-absent" },
      "missing_related_record",
    ],
    ["unknown-parent", null, null],
  ] as const) {
    const observed = fixture(`semantics-${relation}`);
    const observedAddon = observed.services.find(
      (record) => record.recordType === "addon",
    )!;
    observedAddon.customer.sourceRecordId = "customer-birch";
    observedAddon.attachedService = attachedService;
    const imported = importMetadata(await importReview.importRecords(observed));
    const issues = await importReview.listDataIssues(imported.id);
    expect(
      issues?.items.filter((issue) => issue.recordType === "addon"),
    ).toEqual(
      code === null
        ? []
        : [
            {
              code,
              recordType: "addon",
              sourceRecordId: observedAddon.sourceRecordId,
              field: "attachedService",
            },
          ],
    );
    const customer = await importReview.getCustomer(
      imported.id,
      "customer-birch",
    );
    expect(customer?.services.items[0].customer).toEqual(
      observedAddon.customer,
    );
    expect(customer?.services.items[0].attachedService).toEqual(
      attachedService,
    );
  }
});

test("canonical digest ignores object and unordered collection order but covers accepted fields", () => {
  const value = fixture("digest");
  const reordered = Object.fromEntries(Object.entries(value).reverse());
  reordered.customers = [...value.customers].reverse();
  reordered.services = [...value.services].reverse();
  reordered.domains = [...value.domains].reverse();
  reordered.recordCounts = [...value.recordCounts].reverse();
  expect(importDigest(reordered)).toEqual(importDigest(value));
  const changed = structuredClone(value);
  changed.services[0].cancellationRequested = null;
  expect(importDigest(changed)).not.toEqual(importDigest(value));
  expect(importDigest({ ...value, schemaVersion: 2 })).toHaveProperty("issues");
});
