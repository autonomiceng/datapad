import { importDigest } from "../import-review";

const fixtures = [
  new URL("../../fixtures/import-review/synthetic-v1.json", import.meta.url),
  new URL(
    "../../fixtures/import-review/synthetic-v1-later.json",
    import.meta.url,
  ),
];

async function allowedDigests(): Promise<Set<string>> {
  const digests = new Set<string>();
  for (const fixture of fixtures) {
    const result = importDigest(await Bun.file(fixture).json());
    if ("issues" in result)
      throw new Error("A shipped demo fixture is invalid.");
    digests.add(result.digest);
  }
  return digests;
}

export async function assertDemoImport(input: unknown): Promise<void> {
  const result = importDigest(input);
  if ("issues" in result || !(await allowedDigests()).has(result.digest)) {
    throw new Error("Demo import accepts only the shipped synthetic imports.");
  }
}

export async function assertDemoDatabase(importReview: {
  listImportDigests(): Promise<string[]>;
}): Promise<void> {
  const allowed = await allowedDigests();
  const actual = await importReview.listImportDigests();
  if (actual.some((digest) => !allowed.has(digest))) {
    throw new Error("Demo startup refused an unapproved import.");
  }
}
