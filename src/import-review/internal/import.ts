import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { ImportResult, ImportMetadata } from "../contract";
import { customers, domains, services, imports } from "./schema";
import { calendarDate, statusObservation } from "./observations";
import { validateImport } from "./validate";

export function metadata(row: typeof imports.$inferSelect): ImportMetadata {
  return {
    id: row.id,
    schemaVersion: 1,
    sourceId: row.sourceId,
    sourceReference: row.sourceReference,
    dataAsOf: new Date(row.dataAsOf).toISOString(),
    recordCounts: row.recordCounts,
  };
}
export async function importRecords(
  db: NodePgDatabase,
  input: unknown,
): Promise<ImportResult> {
  const result = validateImport(input);
  if (!result.ok) return { outcome: "invalid", issues: result.issues };
  const { envelope, digest } = result;
  return db.transaction(
    async (tx) => {
      const [inserted] = await tx
        .insert(imports)
        .values({
          id: randomUUID(),
          schemaVersion: 1,
          sourceId: envelope.sourceId,
          sourceReference: envelope.sourceReference,
          dataAsOf: envelope.dataAsOf,
          digest,
          recordCounts: envelope.recordCounts,
        })
        .onConflictDoNothing({
          target: [imports.sourceId, imports.sourceReference],
        })
        .returning();
      if (!inserted) {
        const [existing] = await tx
          .select()
          .from(imports)
          .where(
            and(
              eq(imports.sourceId, envelope.sourceId),
              eq(imports.sourceReference, envelope.sourceReference),
            ),
          );
        if (!existing) throw new Error("Import unavailable");
        return existing.digest === digest
          ? { outcome: "unchanged", importMetadata: metadata(existing) }
          : { outcome: "conflict" };
      }
      for (let start = 0; start < envelope.customers.length; start += 1000) {
        await tx.insert(customers).values(
          envelope.customers.slice(start, start + 1000).map((record) => ({
            importId: inserted.id,
            sourceRecordId: record.sourceRecordId,
            observation: record,
            knownStatus: statusObservation(record.recordType, record.status)
              .known,
          })),
        );
      }
      for (let start = 0; start < envelope.services.length; start += 1000) {
        await tx.insert(services).values(
          envelope.services.slice(start, start + 1000).map((record) => ({
            importId: inserted.id,
            recordType: record.recordType,
            sourceRecordId: record.sourceRecordId,
            customerId: record.customer.sourceRecordId,
            attachedServiceId: record.attachedService?.sourceRecordId ?? null,
            observation: record,
            knownStatus: statusObservation(record.recordType, record.status)
              .known,
            dueDate: calendarDate(record.dueDate).value,
            nextInvoiceDate: calendarDate(record.nextInvoiceDate).value,
          })),
        );
      }
      for (let start = 0; start < envelope.domains.length; start += 1000) {
        await tx.insert(domains).values(
          envelope.domains.slice(start, start + 1000).map((record) => ({
            importId: inserted.id,
            sourceRecordId: record.sourceRecordId,
            customerId: record.customer.sourceRecordId,
            observation: record,
            knownStatus: statusObservation(record.recordType, record.status)
              .known,
            dueDate: calendarDate(record.dueDate).value,
            nextInvoiceDate: calendarDate(record.nextInvoiceDate).value,
            expiryDate: calendarDate(record.expiryDate).value,
          })),
        );
      }
      return { outcome: "imported", importMetadata: metadata(inserted) };
    },
    { isolationLevel: "read committed" },
  );
}
