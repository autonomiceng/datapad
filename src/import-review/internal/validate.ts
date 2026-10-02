import { createHash } from "node:crypto";
import canonicalize from "canonicalize";
import { Value } from "@sinclair/typebox/value";
import {
  ImportFileSchema,
  type ImportFile,
  type ValidationIssue,
} from "../contract";

export function validateImport(
  input: unknown,
):
  | { ok: true; envelope: ImportFile; digest: string }
  | { ok: false; issues: ValidationIssue[] } {
  if (!Value.Check(ImportFileSchema, input))
    return { ok: false, issues: [{ code: "invalid_schema", path: "/" }] };
  const envelope = structuredClone(input);
  const issues: ValidationIssue[] = [];
  const records = [
    ...envelope.customers,
    ...envelope.services,
    ...envelope.domains,
  ];
  if (records.length > 100000) issues.push({ code: "record_limit", path: "/" });
  const instant = new Date(envelope.dataAsOf);
  if (
    !Number.isFinite(instant.getTime()) ||
    instant.getUTCFullYear() < 1 ||
    instant.toISOString().slice(0, 19) !== envelope.dataAsOf.slice(0, 19)
  )
    issues.push({ code: "invalid_timestamp", path: "/dataAsOf" });
  const identities = new Set<string>();
  for (const record of records) {
    const identity = `${record.recordType}:${record.sourceRecordId}`;
    if (identities.has(identity))
      issues.push({ code: "duplicate_identity", path: "/records" });
    identities.add(identity);
    if ("money" in record && record.money.amountMinor !== null) {
      const amount = record.money.amountMinor;
      if (
        amount === "-0" ||
        BigInt(amount) < -9223372036854775808n ||
        BigInt(amount) > 9223372036854775807n
      )
        issues.push({
          code: "invalid_money",
          path: "/records/money/amountMinor",
        });
    }
    if (record.recordType === "service" && record.attachedService !== null)
      issues.push({
        code: "invalid_attachment",
        path: "/services/attachedService",
      });
  }
  const recordTypes = new Set<string>();
  const selections = new Set<string>();
  for (const entry of envelope.recordCounts) {
    const reasons = new Set(
      entry.exclusionReasons.map((item) => item.reasonCode),
    );
    if (
      recordTypes.has(entry.recordType) ||
      selections.has(entry.selectionCode) ||
      reasons.size !== entry.exclusionReasons.length ||
      entry.selectedCount + entry.linkedCount !==
        records.filter((record) => record.recordType === entry.recordType)
          .length ||
      entry.selectedCount + entry.linkedCount + entry.excludedCount !==
        entry.reportedSourceTotalCount ||
      entry.exclusionReasons.reduce((sum, item) => sum + item.count, 0) !==
        entry.excludedCount
    )
      issues.push({ code: "invalid_record_counts", path: "/recordCounts" });
    recordTypes.add(entry.recordType);
    selections.add(entry.selectionCode);
  }
  if (issues.length) return { ok: false, issues: issues.slice(0, 20) };
  const compare = (
    a: { recordType: string; sourceRecordId: string },
    b: { recordType: string; sourceRecordId: string },
  ) =>
    a.recordType < b.recordType
      ? -1
      : a.recordType > b.recordType
        ? 1
        : a.sourceRecordId < b.sourceRecordId
          ? -1
          : a.sourceRecordId > b.sourceRecordId
            ? 1
            : 0;
  const canonical = canonicalize({
    ...envelope,
    customers: [...envelope.customers].sort(compare),
    services: [...envelope.services].sort(compare),
    domains: [...envelope.domains].sort(compare),
    recordCounts: envelope.recordCounts
      .map((entry) => ({
        ...entry,
        exclusionReasons: [...entry.exclusionReasons].sort((a, b) =>
          a.reasonCode < b.reasonCode
            ? -1
            : a.reasonCode > b.reasonCode
              ? 1
              : 0,
        ),
      }))
      .sort((a, b) =>
        a.selectionCode < b.selectionCode
          ? -1
          : a.selectionCode > b.selectionCode
            ? 1
            : 0,
      ),
  });
  if (canonical === undefined)
    throw new Error("Canonical encoding unavailable");
  return {
    ok: true,
    envelope,
    digest: createHash("sha256").update(canonical).digest("hex"),
  };
}
