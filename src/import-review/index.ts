import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type {
  CustomerResponse,
  CustomersResponse,
  DataIssuesResponse,
  ImportResult,
  Pagination,
  ImportsResponse,
  SourcesResponse,
  ValidationIssue,
} from "./contract";
import { importRecords } from "./internal/import";
import { createReader } from "./internal/queries";
import { validateImport } from "./internal/validate";
import { imports } from "./internal/schema";

export interface ImportReviewReader {
  listSources(page?: Partial<Pagination>): Promise<SourcesResponse>;
  listImports(
    sourceId: string,
    page?: Partial<Pagination>,
  ): Promise<ImportsResponse | null>;
  listCustomers(
    importId: string,
    page?: Partial<Pagination>,
  ): Promise<CustomersResponse | null>;
  getCustomer(
    importId: string,
    sourceRecordId: string,
    page?: Partial<Pagination>,
  ): Promise<CustomerResponse | null>;
  listDataIssues(
    importId: string,
    page?: Partial<Pagination>,
  ): Promise<DataIssuesResponse | null>;
}
export function importDigest(
  input: unknown,
): { digest: string } | { issues: ValidationIssue[] } {
  const result = validateImport(input);
  return result.ok ? { digest: result.digest } : { issues: result.issues };
}
export function createImportReview({ db }: { db: NodePgDatabase }) {
  return {
    ...createReader(db),
    importRecords: (input: unknown): Promise<ImportResult> =>
      importRecords(db, input),
    listImportDigests: async (): Promise<string[]> =>
      (await db.select({ digest: imports.digest }).from(imports)).map(
        (row) => row.digest,
      ),
  };
}
