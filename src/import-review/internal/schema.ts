import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  CustomerObservation,
  DomainObservation,
  ServiceObservation,
  ImportFile,
} from "../contract";

export const imports = pgTable(
  "imports",
  {
    id: uuid("id").primaryKey(),
    schemaVersion: integer("schema_version").notNull(),
    sourceId: text("source_id").notNull(),
    sourceReference: text("source_reference").notNull(),
    dataAsOf: timestamp("data_as_of", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    digest: text("digest").notNull(),
    recordCounts: jsonb("record_counts")
      .$type<ImportFile["recordCounts"]>()
      .notNull(),
  },
  (table) => [
    uniqueIndex("import_identity").on(table.sourceId, table.sourceReference),
  ],
);
export const customers = pgTable(
  "import_customers",
  {
    importId: uuid("import_id")
      .notNull()
      .references(() => imports.id),
    sourceRecordId: text("source_record_id").notNull(),
    observation: jsonb("observation").$type<CustomerObservation>().notNull(),
    knownStatus: boolean("known_status").notNull(),
  },
  (table) => [primaryKey({ columns: [table.importId, table.sourceRecordId] })],
);
export const services = pgTable(
  "import_services",
  {
    importId: uuid("import_id")
      .notNull()
      .references(() => imports.id),
    recordType: text("record_type").$type<"service" | "addon">().notNull(),
    sourceRecordId: text("source_record_id").notNull(),
    customerId: text("customer_id").notNull(),
    attachedServiceId: text("attached_service_id"),
    observation: jsonb("observation").$type<ServiceObservation>().notNull(),
    knownStatus: boolean("known_status").notNull(),
    dueDate: date("due_date", { mode: "string" }),
    nextInvoiceDate: date("next_invoice_date", { mode: "string" }),
  },
  (table) => [
    primaryKey({
      columns: [table.importId, table.recordType, table.sourceRecordId],
    }),
    index("import_services_customer").on(table.importId, table.customerId),
  ],
);
export const domains = pgTable(
  "import_domains",
  {
    importId: uuid("import_id")
      .notNull()
      .references(() => imports.id),
    sourceRecordId: text("source_record_id").notNull(),
    customerId: text("customer_id").notNull(),
    observation: jsonb("observation").$type<DomainObservation>().notNull(),
    knownStatus: boolean("known_status").notNull(),
    dueDate: date("due_date", { mode: "string" }),
    nextInvoiceDate: date("next_invoice_date", { mode: "string" }),
    expiryDate: date("expiry_date", { mode: "string" }),
  },
  (table) => [
    primaryKey({ columns: [table.importId, table.sourceRecordId] }),
    index("import_domains_customer").on(table.importId, table.customerId),
  ],
);
