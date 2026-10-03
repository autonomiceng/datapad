import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertCollectionsDirectory,
  assertCollectionsWindow,
  collectionsPhase,
  loadCollectionsPlan,
  readCollectionsPrivateJson,
  writeCollectionsPrivateJson,
} from "../scripts/collections-acceptance";
import { startPortal } from "../src/server/portal-server";

// Only this explicit sandbox entrypoint accepts a private BUSINESS clock.
// All effects, accepted consent, observations and retry age retain wall time.
const directory = process.env.PORTAL_COLLECTIONS_TEST_ARTIFACTS;
const clockPath = process.env.PORTAL_COLLECTIONS_TEST_CLOCK;
const planPath = process.env.PORTAL_COLLECTIONS_TEST_PLAN;
if (
  !directory ||
  !clockPath ||
  !planPath ||
  process.env.PORTAL_BILLING_SANDBOX !== "true"
)
  throw new Error(
    "Collections acceptance requires private files and the explicit sandbox.",
  );
const phase = collectionsPhase(process.env.PORTAL_COLLECTIONS_TEST_PHASE);
await assertCollectionsDirectory(directory);
const plan = await loadCollectionsPlan(planPath);
assertCollectionsWindow(plan, phase);
const now = () => {
  const stat = lstatSync(clockPath);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o777) !== 0o600 ||
    stat.size > 128
  )
    throw new Error("Invalid private collections clock.");
  const value: unknown = JSON.parse(readFileSync(clockPath, "utf8"));
  if (value === "real") {
    if (Date.now() < Date.parse(plan.chargeAt))
      throw new Error("Real collection window has not started.");
    return new Date();
  }
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    Date.parse(value) > Date.now() ||
    Date.parse(value) >= Date.parse(plan.chargeAt)
  )
    throw new Error(
      "Collections business clock cannot authorize a future charge.",
    );
  return new Date(value);
};
now();
const processToken = randomUUID();
await writeCollectionsPrivateJson(join(directory, "collections-process.json"), {
  token: processToken,
  pid: process.pid,
  startedAt: new Date().toISOString(),
  phase,
});
await startPortal({ now }, async (runtime) => {
  if (!runtime.invoiceCollections)
    throw new Error("Collections acceptance requires the real sandbox facade.");
  const collections = runtime.invoiceCollections;
  let busy = false;
  let handled: string | undefined;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    void (async () => {
      const value = await readCollectionsPrivateJson(
        join(directory, "collections-command.json"),
      );
      if (!value || typeof value !== "object")
        throw new Error("Invalid acceptance command.");
      const command = value as {
        id: string;
        invoiceId: string;
        operation: string;
      };
      if (command.id === handled) return;
      if (
        !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(command.id) ||
        command.operation !== "collect"
      )
        throw new Error("Invalid acceptance command.");
      // A private-file command can address only this fixed scenario's invoices.
      const state = (await readCollectionsPrivateJson(
        join(directory, "collections-state.json"),
      )) as {
        runId: string;
        automaticInvoiceId?: string;
        earlyInvoiceId?: string;
      };
      if (
        state.runId !== plan.runId ||
        !command.invoiceId ||
        ![state.automaticInvoiceId, state.earlyInvoiceId].includes(
          command.invoiceId,
        )
      )
        throw new Error("Acceptance command is outside the fixed scenario.");
      handled = command.id;
      let outcome: "complete" | "retry" | "needs_review" | "failed" = "failed";
      try {
        assertCollectionsWindow(plan, "collect");
        outcome = await collections.collectDueInvoice(command.invoiceId);
      } catch {
        // Never serialize SDK errors or print command/provider payloads.
      }
      await writeCollectionsPrivateJson(
        join(directory, "collections-command-result.json"),
        {
          id: command.id,
          processToken,
          outcome,
          completedAt: new Date().toISOString(),
        },
      );
    })()
      .catch(() => undefined)
      .finally(() => {
        busy = false;
      });
  }, 100);
  timer.unref();
});
