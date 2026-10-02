import type {
  CustomerResponse,
  CustomersResponse,
  DataIssuesResponse,
  ImportsResponse,
  SourcesResponse,
} from "../../import-review/contract";

async function request<T>(
  path: string,
  offset: number,
  signal?: AbortSignal,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${path}?limit=50&offset=${offset}`, {
      signal,
      cache: "no-store",
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(
      "Could not reach the server. Check your connection and try again.",
    );
  }
  if (!response.ok) {
    const message =
      response.status === 404
        ? "The selected records were not found. Choose another source or import."
        : response.status === 422
          ? "This selection is invalid. Choose another source or import."
          : "Import review is unavailable. Please try again.";
    throw new Error(message);
  }
  return (await response.json()) as T;
}

const encode = encodeURIComponent;
export const listSources = (offset: number, signal?: AbortSignal) =>
  request<SourcesResponse>("/api/import-review/sources", offset, signal);
export const listImports = (
  sourceId: string,
  offset: number,
  signal?: AbortSignal,
) =>
  request<ImportsResponse>(
    `/api/import-review/sources/${encode(sourceId)}/imports`,
    offset,
    signal,
  );
export const listCustomers = (
  importId: string,
  offset: number,
  signal?: AbortSignal,
) =>
  request<CustomersResponse>(
    `/api/import-review/imports/${encode(importId)}/customers`,
    offset,
    signal,
  );
export const getCustomer = (
  importId: string,
  customerId: string,
  offset: number,
  signal?: AbortSignal,
) =>
  request<CustomerResponse>(
    `/api/import-review/imports/${encode(importId)}/customers/${encode(customerId)}`,
    offset,
    signal,
  );
export const listDataIssues = (
  importId: string,
  offset: number,
  signal?: AbortSignal,
) =>
  request<DataIssuesResponse>(
    `/api/import-review/imports/${encode(importId)}/data-issues`,
    offset,
    signal,
  );
