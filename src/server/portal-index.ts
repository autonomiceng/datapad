import { resolve } from "node:path";
import { createDatabase } from "./db/connection";
import { createImportReview } from "../import-review";
import { assertDemoDatabase } from "./demo-policy";
import { createApp } from "./app";
import { createPortalRuntime } from "./portal-runtime";
import { createBillingWorker } from "../worker";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
if (process.env.HOST && process.env.HOST !== "127.0.0.1")
  throw new Error("The synthetic portal binds to loopback.");
const database = createDatabase(process.env.DATABASE_URL);
const importReview = createImportReview({ db: database.db });
let worker: Awaited<ReturnType<typeof createBillingWorker>> | undefined;
let runtime: Awaited<ReturnType<typeof createPortalRuntime>> | undefined;
try {
  await assertDemoDatabase(importReview);
  runtime = await createPortalRuntime(database.pool);
  const app = createApp({
    importReview,
    billing: runtime.billing,
    invoiceWorkflow: runtime.invoiceWorkflow,
    subscriptions: runtime.subscriptions,
    services: runtime.services,
    accounts: runtime.accounts,
    assetsDir: process.env.ASSETS_DIR
      ? resolve(process.env.ASSETS_DIR)
      : undefined,
  });
  app.get(
    "/sample-inbox",
    () =>
      new Response(null, {
        status: 302,
        headers: { location: runtime!.inbox, "cache-control": "no-store" },
      }),
    { detail: { hide: true } },
  );
  const port = Number(process.env.PORT ?? 0);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error("Invalid portal port.");
  app.listen({ hostname: "127.0.0.1", port });
  if (runtime.commands)
    worker = await createBillingWorker({
      databaseUrl: process.env.DATABASE_URL,
      billing: runtime.commands,
    });
  console.log(`Listening on http://127.0.0.1:${app.server!.port}`);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await app.stop();
    await worker?.stop();
    await runtime?.close();
    await database.close();
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
} catch {
  await worker?.stop();
  await runtime?.close();
  await database.close();
  console.error("Synthetic portal startup failed.");
  process.exitCode = 1;
}
