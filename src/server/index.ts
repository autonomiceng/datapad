import { createImportReview } from "../import-review";
import { createApp } from "./app";
import { createDatabase } from "./db/connection";
import { assertDemoDatabase } from "./demo-policy";
import { createBillingRuntime } from "./billing-runtime";
import { createBillingWorker } from "../worker";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const url = process.env.DATABASE_URL;
if (!url) fail("DATABASE_URL is required.");
const host = process.env.HOST ?? "127.0.0.1";
if (!["127.0.0.1", "::1", "localhost"].includes(host)) {
  fail("The synthetic import review server requires a loopback host.");
}
const port = Number(process.env.PORT ?? "3000");
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  fail("PORT must be an integer between 0 and 65535.");
}
const database = createDatabase(url);
const importReview = createImportReview({ db: database.db });
let billing;
let worker: Awaited<ReturnType<typeof createBillingWorker>> | undefined;
try {
  await assertDemoDatabase(importReview);
  billing = await createBillingRuntime(database.pool);
} catch {
  await database.close();
  fail("Demo startup refused: unavailable or unapproved import review data.");
}
const app = createApp({
  importReview,
  billing,
  assetsDir: process.env.ASSETS_DIR ?? "dist",
});
try {
  app.listen({ hostname: host, port });
  if (billing.commands)
    worker = await createBillingWorker({
      databaseUrl: url,
      billing: billing.commands,
    });
} catch {
  await app.stop().catch(() => {});
  await database.close();
  fail("Unable to start the import review server.");
}
console.log(`Listening on ${app.server?.url.toString().replace(/\/$/, "")}`);
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  try {
    await app.stop();
    await worker?.stop();
  } finally {
    await database.close();
  }
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
