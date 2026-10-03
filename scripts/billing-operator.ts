import { parseArgs } from "node:util";
import { createDatabase } from "../src/server/db/connection";
import { createBillingRuntime } from "../src/server/billing-runtime";
import { createPortalRuntime } from "../src/server/portal-runtime";
import type { ReconciliationCursor } from "../src/billing";

const action = process.argv[2];
if (action !== "issue" && action !== "refresh")
  throw new Error("Expected issue or refresh.");
const { values } = parseArgs({
  args: process.argv.slice(3),
  strict: true,
  options: {
    portal: { type: "boolean" },
    "page-budget": { type: "string", default: "10" },
    cursor: { type: "string" },
  },
});
const budget = Number(values["page-budget"]);
if (
  !Number.isSafeInteger(budget) ||
  budget < 1 ||
  budget > 100 ||
  (action === "issue" && (values.portal || values.cursor))
)
  throw new Error("Invalid reconciliation arguments.");
let cursor:
  | { after: ReconciliationCursor; through: ReconciliationCursor }
  | undefined;
if (values.cursor) {
  const value: unknown = JSON.parse(values.cursor);
  const valid = (entry: unknown): entry is ReconciliationCursor =>
    Boolean(
      entry &&
      typeof entry === "object" &&
      "createdAt" in entry &&
      typeof entry.createdAt === "string" &&
      "invoiceId" in entry &&
      typeof entry.invoiceId === "string" &&
      Object.keys(entry).sort().join(",") === "createdAt,invoiceId",
    );
  if (
    !value ||
    typeof value !== "object" ||
    !("after" in value) ||
    !("through" in value) ||
    !valid(value.after) ||
    !valid(value.through) ||
    Object.keys(value).sort().join(",") !== "after,through"
  )
    throw new Error("Invalid reconciliation cursor.");
  cursor = { after: value.after, through: value.through };
}
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required.");
const database = createDatabase(url);
let portal: Awaited<ReturnType<typeof createPortalRuntime>> | undefined;
try {
  portal = values.portal ? await createPortalRuntime(database.pool) : undefined;
  const runtime = portal
    ? {
        commands: portal.commands,
        reader: portal.billing.reader,
        request: undefined,
      }
    : await createBillingRuntime(database.pool);
  if (!runtime.commands)
    throw new Error("Sandbox billing configuration is required.");
  if (action === "issue") {
    if (!runtime.request) throw new Error("An operator request is required.");
    const result = await runtime.commands.requestInvoice(runtime.request);
    if (result.kind !== "created" && result.kind !== "unchanged")
      throw new Error("Synthetic invoice request refused.");
    const issue = await runtime.commands.requestIssue(result.invoiceId);
    if (
      issue.kind !== "accepted" &&
      issue.kind !== "unchanged" &&
      issue.kind !== "needs_review"
    )
      throw new Error("Invoice is not eligible for issue.");
    console.log(
      issue.kind === "needs_review"
        ? "Invoice needs review. Processing remains paused; the app will show its status."
        : "Synthetic invoice issue requested. The worker will process it.",
    );
  } else {
    let after = cursor?.after ?? null;
    let through = cursor?.through ?? null;
    let checked = 0;
    const failures: Array<{
      invoiceId: string;
      outcome: "retry" | "needs_review" | "unavailable";
    }> = [];
    for (let index = 0; index < budget; index++) {
      const page = await runtime.commands.reconciliationPage({
        limit: 100,
        after,
        through,
      });
      through = page.through;
      for (const invoiceId of page.invoiceIds) {
        try {
          const outcome = await runtime.commands.refreshInvoice(invoiceId);
          if (outcome !== "complete") failures.push({ invoiceId, outcome });
        } catch {
          failures.push({ invoiceId, outcome: "unavailable" });
        }
        checked++;
      }
      after = page.next;
      if (!after) break;
    }
    console.log(
      JSON.stringify({
        complete: after === null,
        checked,
        needsReviewOrRetry: failures.length,
        failures,
        cursor: after ? { after, through } : null,
      }),
    );
    if (failures.length || after) process.exitCode = 2;
  }
} catch {
  console.error(
    "Billing command failed; inspect private configuration and invoice status.",
  );
  process.exitCode = 1;
} finally {
  await portal?.close();
  await database.close();
}
