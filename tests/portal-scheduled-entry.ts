import { lstatSync, readFileSync } from "node:fs";
import { startPortal } from "../src/server/portal-server";

// This entrypoint is used only by the explicit sandbox acceptance task.
const path = process.env.PORTAL_SCHEDULE_TEST_CLOCK;
if (!path || process.env.PORTAL_BILLING_SANDBOX !== "true")
  throw new Error(
    "Scheduled acceptance requires its private clock file and sandbox.",
  );
const now = () => {
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o777) !== 0o600 ||
    stat.size > 128
  )
    throw new Error("Invalid acceptance clock file.");
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    throw new Error("Invalid acceptance clock instant.");
  return new Date(value);
};
await startPortal({ now });
