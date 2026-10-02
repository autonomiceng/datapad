import { and, asc, count, desc, eq, sql, type SQL } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { Value } from "@sinclair/typebox/value";
import { PaginationSchema } from "../contract";
import type {
  CustomerObservation,
  DomainObservation,
  DataIssue,
  Pagination,
  ServiceObservation,
  SourcesResponse,
  ImportsResponse,
  CustomersResponse,
  CustomerResponse,
  DataIssuesResponse,
} from "../contract";
import { customers, domains, services, imports } from "./schema";
import { calendarDate, statusObservation } from "./observations";
import { metadata } from "./import";

function pagination(input: Partial<Pagination> = {}): Pagination {
  const { limit = 50, offset = 0 } = input;
  if (!Value.Check(PaginationSchema, { limit, offset }))
    throw new RangeError("Invalid pagination");
  return { limit, offset };
}
const customerDto = (record: CustomerObservation) => ({
  ...record,
  label: `Customer ${record.sourceRecordId}`,
  statusObservation: statusObservation(record.recordType, record.status),
});
const serviceDto = (record: ServiceObservation) => ({
  ...record,
  statusObservation: statusObservation(record.recordType, record.status),
  dueDateObservation: calendarDate(record.dueDate),
  nextInvoiceDateObservation: calendarDate(record.nextInvoiceDate),
});
const domainDto = (record: DomainObservation) => ({
  ...record,
  statusObservation: statusObservation(record.recordType, record.status),
  dueDateObservation: calendarDate(record.dueDate),
  nextInvoiceDateObservation: calendarDate(record.nextInvoiceDate),
  expiryDateObservation: calendarDate(record.expiryDate),
});

function dataIssueQuery(importId: string): SQL {
  const parts: SQL[] = [];
  for (const [table, recordType] of [
    [customers, sql`${"customer"}`],
    [services, sql`${services.recordType}`],
    [domains, sql`${"domain"}`],
  ] as const) {
    parts.push(
      sql`SELECT ${"unrecognized_status"} AS code, ${recordType} AS "recordType", ${table.sourceRecordId} AS "sourceRecordId", ${"status"} AS field FROM ${table} WHERE ${table.importId} = ${importId} AND NOT ${table.knownStatus}`,
    );
  }
  for (const [table, recordType] of [
    [services, sql`${services.recordType}`],
    [domains, sql`${"domain"}`],
  ] as const) {
    parts.push(
      sql`SELECT ${"missing_related_record"} AS code, ${recordType} AS "recordType", ${table.sourceRecordId} AS "sourceRecordId", ${"customer"} AS field FROM ${table} WHERE ${table.importId} = ${importId} AND NOT EXISTS (SELECT 1 FROM ${customers} WHERE ${customers.importId} = ${table.importId} AND ${customers.sourceRecordId} = ${table.customerId})`,
    );
    for (const [field, column] of [
      ["dueDate", table.dueDate],
      ["nextInvoiceDate", table.nextInvoiceDate],
    ] as const) {
      parts.push(
        sql`SELECT ${"invalid_date"} AS code, ${recordType} AS "recordType", ${table.sourceRecordId} AS "sourceRecordId", ${field} AS field FROM ${table} WHERE ${table.importId} = ${importId} AND ${table.observation}->>${field} IS NOT NULL AND ${column} IS NULL`,
      );
    }
  }
  parts.push(
    sql`SELECT ${"invalid_date"} AS code, ${"domain"} AS "recordType", ${domains.sourceRecordId} AS "sourceRecordId", ${"expiryDate"} AS field FROM ${domains} WHERE ${domains.importId} = ${importId} AND ${domains.observation}->>'expiryDate' IS NOT NULL AND ${domains.expiryDate} IS NULL`,
  );
  parts.push(
    sql`SELECT ${"missing_related_record"} AS code, s.record_type AS "recordType", s.source_record_id AS "sourceRecordId", ${"attachedService"} AS field FROM import_services s WHERE s.import_id = ${importId} AND s.attached_service_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM import_services p WHERE p.import_id = s.import_id AND p.record_type = 'service' AND p.source_record_id = s.attached_service_id)`,
  );
  parts.push(
    sql`SELECT ${"different_customer"} AS code, s.record_type AS "recordType", s.source_record_id AS "sourceRecordId", ${"attachedService"} AS field FROM import_services s WHERE s.import_id = ${importId} AND s.record_type = 'addon' AND EXISTS (SELECT 1 FROM import_services p WHERE p.import_id = s.import_id AND p.record_type = 'service' AND p.source_record_id = s.attached_service_id AND p.customer_id <> s.customer_id)`,
  );
  return sql.join(parts, sql` UNION ALL `);
}

export function createReader(db: NodePgDatabase) {
  async function findImport(importId: string) {
    const [row] = await db
      .select()
      .from(imports)
      .where(eq(imports.id, importId));
    return row ? metadata(row) : null;
  }
  return {
    async listSources(input?: Partial<Pagination>): Promise<SourcesResponse> {
      const page = pagination(input);
      const items = await db
        .selectDistinct({ sourceId: imports.sourceId })
        .from(imports)
        .orderBy(asc(imports.sourceId))
        .limit(page.limit)
        .offset(page.offset);
      const [row] = await db
        .select({
          total: sql<number>`count(DISTINCT ${imports.sourceId})::integer`,
        })
        .from(imports);
      return { items, total: row.total, ...page };
    },
    async listImports(
      sourceId: string,
      input?: Partial<Pagination>,
    ): Promise<ImportsResponse | null> {
      const page = pagination(input);
      const condition = eq(imports.sourceId, sourceId);
      const [row] = await db
        .select({ total: count() })
        .from(imports)
        .where(condition);
      if (!row.total) return null;
      const items = await db
        .select()
        .from(imports)
        .where(condition)
        .orderBy(desc(imports.dataAsOf), desc(imports.sourceReference))
        .limit(page.limit)
        .offset(page.offset);
      return {
        sourceId,
        items: items.map(metadata),
        total: row.total,
        ...page,
      };
    },
    async listCustomers(
      importId: string,
      input?: Partial<Pagination>,
    ): Promise<CustomersResponse | null> {
      const page = pagination(input);
      const importMetadata = await findImport(importId);
      if (!importMetadata) return null;
      const condition = eq(customers.importId, importId);
      const [row] = await db
        .select({ total: count() })
        .from(customers)
        .where(condition);
      const items = await db
        .select({ observation: customers.observation })
        .from(customers)
        .where(condition)
        .orderBy(asc(customers.sourceRecordId))
        .limit(page.limit)
        .offset(page.offset);
      return {
        importMetadata,
        items: items.map(({ observation }) => customerDto(observation)),
        total: row.total,
        ...page,
      };
    },
    async getCustomer(
      importId: string,
      sourceRecordId: string,
      input?: Partial<Pagination>,
    ): Promise<CustomerResponse | null> {
      const page = pagination(input);
      const importMetadata = await findImport(importId);
      if (!importMetadata) return null;
      const [customer] = await db
        .select()
        .from(customers)
        .where(
          and(
            eq(customers.importId, importId),
            eq(customers.sourceRecordId, sourceRecordId),
          ),
        );
      if (!customer) return null;
      const serviceCondition = and(
        eq(services.importId, importId),
        eq(services.customerId, sourceRecordId),
      );
      const domainCondition = and(
        eq(domains.importId, importId),
        eq(domains.customerId, sourceRecordId),
      );
      const serviceRows = await db
        .select({ observation: services.observation })
        .from(services)
        .where(serviceCondition)
        .orderBy(asc(services.recordType), asc(services.sourceRecordId))
        .limit(page.limit)
        .offset(page.offset);
      const domainRows = await db
        .select({ observation: domains.observation })
        .from(domains)
        .where(domainCondition)
        .orderBy(asc(domains.sourceRecordId))
        .limit(page.limit)
        .offset(page.offset);
      const [serviceCount] = await db
        .select({ total: count() })
        .from(services)
        .where(serviceCondition);
      const [domainCount] = await db
        .select({ total: count() })
        .from(domains)
        .where(domainCondition);
      return {
        importMetadata,
        customer: customerDto(customer.observation),
        services: {
          items: serviceRows.map(({ observation }) => serviceDto(observation)),
          total: serviceCount.total,
          ...page,
        },
        domains: {
          items: domainRows.map(({ observation }) => domainDto(observation)),
          total: domainCount.total,
          ...page,
        },
      };
    },
    async listDataIssues(
      importId: string,
      input?: Partial<Pagination>,
    ): Promise<DataIssuesResponse | null> {
      const page = pagination(input);
      const importMetadata = await findImport(importId);
      if (!importMetadata) return null;
      const query = dataIssueQuery(importId);
      const totals = await db.execute<{ total: number }>(
        sql`SELECT count(*)::integer AS total FROM (${query}) dataIssues`,
      );
      const results = await db.execute<DataIssue>(
        sql`SELECT * FROM (${query}) dataIssues ORDER BY "recordType", "sourceRecordId", code, field LIMIT ${page.limit} OFFSET ${page.offset}`,
      );
      return {
        importMetadata,
        items: results.rows,
        total: totals.rows[0].total,
        ...page,
      };
    },
  };
}
