import { createDatabase } from "../src/server/db/connection";
import { createBillingRuntime } from "../src/server/billing-runtime";

const action = process.argv[2];
if (action !== "issue" && action !== "refresh")
  throw new Error("Expected issue or refresh.");
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required.");
const database = createDatabase(url);
try {
  const runtime = await createBillingRuntime(database.pool);
  if (!runtime.commands || !runtime.request)
    throw new Error("Sandbox billing configuration is required.");
  if (action === "issue") {
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
    // This loader permits one reviewed invoice. No arbitrary provider IDs are accepted.
    const page = await runtime.reader.listInvoices({ limit: 100 });
    for (const invoice of page.invoices)
      await runtime.commands.refreshInvoice(invoice.id);
    console.log("Stored invoices checked against Stripe.");
  }
} catch {
  console.error(
    "Billing command failed; inspect private configuration and invoice status.",
  );
  process.exitCode = 1;
} finally {
  await database.close();
}
