import {
  Type,
  type Static,
  type TObject,
  type TProperties,
} from "@sinclair/typebox";

const object = <T extends TProperties>(properties: T): TObject<T> =>
  Type.Object(properties, { additionalProperties: false });
const nullable = <T extends ReturnType<typeof Type.String>>(schema: T) =>
  Type.Union([schema, Type.Null()]);
const id = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$",
});
const code = Type.String({
  minLength: 1,
  maxLength: 64,
  pattern: "^[a-z][a-z0-9_]*$",
});
const count = Type.Integer({ minimum: 0, maximum: 1000000000 });
const raw = nullable(
  Type.String({
    maxLength: 256,
    // RFC 8785 requires paired surrogates; PostgreSQL jsonb excludes U+0000.
    pattern:
      "^(?:[\\u0001-\\uD7FF\\uE000-\\uFFFF]|[\\uD800-\\uDBFF][\\uDC00-\\uDFFF])*$",
  }),
);
const RecordTypeSchema = Type.Union([
  Type.Literal("customer"),
  Type.Literal("service"),
  Type.Literal("addon"),
  Type.Literal("domain"),
]);
const RecordCountsSchema = Type.Array(
  object({
    selectionCode: code,
    recordType: RecordTypeSchema,
    selectedCount: count,
    linkedCount: count,
    excludedCount: count,
    reportedSourceTotalCount: count,
    exclusionReasons: Type.Array(object({ reasonCode: code, count }), {
      maxItems: 100,
    }),
  }),
  { minItems: 4, maxItems: 4 },
);
const customerRef = object({
  recordType: Type.Literal("customer"),
  sourceRecordId: id,
});
const serviceRef = object({
  recordType: Type.Literal("service"),
  sourceRecordId: id,
});
const MoneySchema = object({
  amountMinor: nullable(
    Type.String({ maxLength: 20, pattern: "^-?(0|[1-9][0-9]*)$" }),
  ),
  currency: nullable(Type.String({ pattern: "^[A-Z]{3}$" })),
  cadence: raw,
});
export const CustomerObservationSchema = object({
  recordType: Type.Literal("customer"),
  sourceRecordId: id,
  status: raw,
});
const ServiceObservationSchema = object({
  recordType: Type.Union([Type.Literal("service"), Type.Literal("addon")]),
  sourceRecordId: id,
  customer: customerRef,
  attachedService: Type.Union([serviceRef, Type.Null()]),
  productName: raw,
  hostname: raw,
  status: raw,
  cancellationRequested: Type.Union([Type.Boolean(), Type.Null()]),
  money: MoneySchema,
  dueDate: raw,
  nextInvoiceDate: raw,
});
const DomainObservationSchema = object({
  recordType: Type.Literal("domain"),
  sourceRecordId: id,
  customer: customerRef,
  domainName: raw,
  status: raw,
  termYears: Type.Union([
    Type.Integer({ minimum: 1, maximum: 100 }),
    Type.Null(),
  ]),
  money: MoneySchema,
  dueDate: raw,
  nextInvoiceDate: raw,
  expiryDate: raw,
});
export const ImportFileSchema = object({
  schemaVersion: Type.Literal(1),
  sourceId: id,
  sourceReference: id,
  dataAsOf: Type.String({
    pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{1,3})?Z$",
  }),
  recordCounts: RecordCountsSchema,
  customers: Type.Array(CustomerObservationSchema, { maxItems: 100000 }),
  services: Type.Array(ServiceObservationSchema, { maxItems: 100000 }),
  domains: Type.Array(DomainObservationSchema, { maxItems: 100000 }),
});
export type ImportFile = Static<typeof ImportFileSchema>;
export type RecordType = Static<typeof RecordTypeSchema>;
export type CustomerObservation = Static<typeof CustomerObservationSchema>;
export type ServiceObservation = Static<typeof ServiceObservationSchema>;
export type DomainObservation = Static<typeof DomainObservationSchema>;

export const PaginationSchema = object({
  limit: Type.Integer({ minimum: 1, maximum: 200, default: 50 }),
  offset: Type.Integer({ minimum: 0, maximum: 500000, default: 0 }),
});
export type Pagination = Static<typeof PaginationSchema>;
const ImportMetadataSchema = object({
  id: Type.String({ format: "uuid" }),
  schemaVersion: Type.Literal(1),
  sourceId: id,
  sourceReference: id,
  dataAsOf: Type.String(),
  recordCounts: RecordCountsSchema,
});
export type ImportMetadata = Static<typeof ImportMetadataSchema>;
export const DateObservationSchema = object({
  raw,
  state: Type.Union([
    Type.Literal("valid"),
    Type.Literal("unset"),
    Type.Literal("invalid"),
  ]),
  value: nullable(Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" })),
});
const StatusObservationSchema = object({ raw, known: Type.Boolean() });
const CustomerSchema = object({
  ...CustomerObservationSchema.properties,
  label: Type.String(),
  statusObservation: StatusObservationSchema,
});
const ServiceSchema = object({
  ...ServiceObservationSchema.properties,
  statusObservation: StatusObservationSchema,
  dueDateObservation: DateObservationSchema,
  nextInvoiceDateObservation: DateObservationSchema,
});
const DomainSchema = object({
  ...DomainObservationSchema.properties,
  statusObservation: StatusObservationSchema,
  dueDateObservation: DateObservationSchema,
  nextInvoiceDateObservation: DateObservationSchema,
  expiryDateObservation: DateObservationSchema,
});
const DataIssueSchema = object({
  code: Type.Union([
    Type.Literal("missing_related_record"),
    Type.Literal("unrecognized_status"),
    Type.Literal("invalid_date"),
    Type.Literal("different_customer"),
  ]),
  recordType: RecordTypeSchema,
  sourceRecordId: id,
  field: Type.Union([
    Type.Literal("customer"),
    Type.Literal("attachedService"),
    Type.Literal("status"),
    Type.Literal("dueDate"),
    Type.Literal("nextInvoiceDate"),
    Type.Literal("expiryDate"),
  ]),
});
export type DataIssue = Static<typeof DataIssueSchema>;
const page = <T extends TObject>(item: T) =>
  object({
    items: Type.Array(item),
    total: count,
    limit: Type.Integer(),
    offset: Type.Integer(),
  });
export const SourcesResponseSchema = page(object({ sourceId: id }));
export const ImportsResponseSchema = object({
  sourceId: id,
  ...page(ImportMetadataSchema).properties,
});
export const CustomersResponseSchema = object({
  importMetadata: ImportMetadataSchema,
  ...page(CustomerSchema).properties,
});
export const CustomerResponseSchema = object({
  importMetadata: ImportMetadataSchema,
  customer: CustomerSchema,
  services: page(ServiceSchema),
  domains: page(DomainSchema),
});
export const DataIssuesResponseSchema = object({
  importMetadata: ImportMetadataSchema,
  ...page(DataIssueSchema).properties,
});
export type SourcesResponse = Static<typeof SourcesResponseSchema>;
export type ImportsResponse = Static<typeof ImportsResponseSchema>;
export type CustomersResponse = Static<typeof CustomersResponseSchema>;
export type CustomerResponse = Static<typeof CustomerResponseSchema>;
export type DataIssuesResponse = Static<typeof DataIssuesResponseSchema>;
export const ErrorResponseSchema = object({
  code: Type.Union([
    Type.Literal("invalid_query"),
    Type.Literal("not_found"),
    Type.Literal("unavailable"),
  ]),
});
const ValidationIssueSchema = object({
  code: Type.Union([
    Type.Literal("invalid_schema"),
    Type.Literal("invalid_money"),
    Type.Literal("invalid_timestamp"),
    Type.Literal("duplicate_identity"),
    Type.Literal("invalid_record_counts"),
    Type.Literal("record_limit"),
    Type.Literal("invalid_attachment"),
  ]),
  path: Type.String(),
});
export type ValidationIssue = Static<typeof ValidationIssueSchema>;
export type ImportResult =
  | { outcome: "imported" | "unchanged"; importMetadata: ImportMetadata }
  | { outcome: "conflict" }
  | { outcome: "invalid"; issues: ValidationIssue[] };
