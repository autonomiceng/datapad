import { createImportReview } from "../src/import-review";
import { createDatabase } from "../src/server/db/connection";
import { assertDemoImport } from "../src/server/demo-policy";

const MAX_BYTES = 32 * 1024 * 1024;
async function readInput(path: string): Promise<unknown> {
  const file = Bun.file(path);
  if (file.size > MAX_BYTES) throw new RangeError("import_too_large");
  const reader = file.stream().getReader();
  const parts: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BYTES) throw new RangeError("import_too_large");
      parts.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

async function run(): Promise<number> {
  const [path, ...extra] = process.argv.slice(2);
  if (!path || extra.length) {
    console.error("Usage: mise run import:file -- <import.json>");
    return 2;
  }
  let input: unknown;
  try {
    input = await readInput(path);
  } catch (error) {
    if (
      error instanceof SyntaxError ||
      error instanceof RangeError ||
      error instanceof TypeError
    ) {
      console.error("Invalid import file or byte limit exceeded.");
      return 2;
    }
    console.error("Unable to read import file.");
    return 1;
  }
  try {
    await assertDemoImport(input);
  } catch {
    console.error("Demo import accepts only the shipped synthetic imports.");
    return 2;
  }
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is required.");
    return 1;
  }
  const database = createDatabase(process.env.DATABASE_URL);
  try {
    const result = await createImportReview({ db: database.db }).importRecords(
      input,
    );
    console.log(JSON.stringify({ outcome: result.outcome }));
    return result.outcome === "imported" || result.outcome === "unchanged"
      ? 0
      : 2;
  } catch {
    console.error("ImportReview import unavailable.");
    return 1;
  } finally {
    await database.close();
  }
}
if (import.meta.main) process.exitCode = await run();
