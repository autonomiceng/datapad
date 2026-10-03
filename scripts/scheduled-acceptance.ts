import { Temporal } from "@js-temporal/polyfill";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

/** Private scenario facts remain fixed across sandbox restarts and retries. */
export async function prepareScheduledAcceptance(
  directory: string,
  timeZone: string,
) {
  const planPath = resolve(directory, "scheduled-acceptance.json");
  const clockPath = resolve(directory, "scheduled-clock.json");
  const wall = Temporal.Now.instant();
  const local = wall.toZonedDateTimeISO(timeZone);
  let issue = local.with({
    hour: 9,
    minute: 0,
    second: 0,
    millisecond: 0,
    microsecond: 0,
    nanosecond: 0,
  });
  if (Temporal.Instant.compare(issue.toInstant(), wall) > 0)
    issue = issue.subtract({ days: 1 });
  const candidate = {
    timeZone,
    clockBefore: issue.subtract({ minutes: 1 }).toInstant().toString(),
    clockAfter: wall.toString({ smallestUnit: "millisecond" }),
    dueDate: issue.toPlainDate().add({ days: 21 }).toString(),
  };
  try {
    await writeFile(planPath, JSON.stringify(candidate), {
      mode: 0o600,
      flag: "wx",
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const stat = await lstat(planPath);
  if (
    !stat.isFile() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o777) !== 0o600 ||
    stat.size > 1024
  )
    throw new Error("Invalid scheduled acceptance plan file.");
  const plan: unknown = JSON.parse(await readFile(planPath, "utf8"));
  if (
    !plan ||
    typeof plan !== "object" ||
    !("timeZone" in plan) ||
    plan.timeZone !== timeZone ||
    !("clockBefore" in plan) ||
    typeof plan.clockBefore !== "string" ||
    !("clockAfter" in plan) ||
    typeof plan.clockAfter !== "string" ||
    !("dueDate" in plan) ||
    typeof plan.dueDate !== "string"
  )
    throw new Error("Scheduled acceptance plan differs from this run.");
  const before = Temporal.Instant.from(plan.clockBefore);
  const after = Temporal.Instant.from(plan.clockAfter);
  const due = Temporal.PlainDate.from(plan.dueDate);
  if (
    Temporal.Instant.compare(before, after) >= 0 ||
    Temporal.PlainDate.compare(due, local.toPlainDate()) <= 0
  )
    throw new Error(
      "Scheduled acceptance plan expired; choose a new private run directory.",
    );
  try {
    const clockStat = await lstat(clockPath);
    if (
      !clockStat.isFile() ||
      clockStat.uid !== process.getuid?.() ||
      (clockStat.mode & 0o777) !== 0o600
    )
      throw new Error("Invalid scheduled acceptance clock file.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await writeFile(clockPath, JSON.stringify(plan.clockBefore), { mode: 0o600 });
  return { planPath, clockPath };
}
