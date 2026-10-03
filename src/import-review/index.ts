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
  /**
   * List distinct observed source IDs in ascending order; invalid
   * pagination throws RangeError.
   */
  listSources(page?: Partial<Pagination>): Promise<SourcesResponse>;
  /**
   * List imports for one source by descending Data as of and source
   * reference; null means the source has no imports.
   */
  listImports(
    sourceId: string,
    page?: Partial<Pagination>,
  ): Promise<ImportsResponse | null>;
  /**
   * List customers within one immutable import by source record ID; null
   * means the import is absent.
   */
  listCustomers(
    importId: string,
    page?: Partial<Pagination>,
  ): Promise<CustomersResponse | null>;
  /**
   * Read a customer within one import, applying pagination independently to
   * services and domains; null means the import or customer is absent.
   */
  getCustomer(
    importId: string,
    sourceRecordId: string,
    page?: Partial<Pagination>,
  ): Promise<CustomerResponse | null>;
  /**
   * Derive ordered issues from observations in one import without modifying
   * them; null means the import is absent.
   */
  listDataIssues(
    importId: string,
    page?: Partial<Pagination>,
  ): Promise<DataIssuesResponse | null>;
}
export interface ImportReview extends ImportReviewReader {
  /** Stage validated records atomically; an existing source reference returns unchanged or conflict. */
  importRecords(input: unknown): Promise<ImportResult>;
  /** Read stored import digests for the runtime's synthetic-data policy check. */
  listImportDigests(): Promise<string[]>;
}
/**
 * Validate an import and compute its canonical digest without persistence;
 * rejected input returns safe issue codes and paths.
 */
export function importDigest(
  input: unknown,
): { digest: string } | { issues: ValidationIssue[] } {
  const result = validateImport(input);
  return result.ok ? { digest: result.digest } : { issues: result.issues };
}
/**
 * Compose immutable import staging and scoped reads. Import identity
 * replays return unchanged or conflict; accepted records commit together.
 */
export function createImportReview({
  db,
}: {
  db: NodePgDatabase;
}): ImportReview {
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
