import { randomUUID } from "node:crypto";
import { lstat, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { Temporal } from "@js-temporal/polyfill";

export type CollectionsPhase = "prepare" | "collect" | "verify-restart";
export interface CollectionsPlan {
  version: 1;
  runId: string;
  timeZone: "America/Los_Angeles";
  dueDate: string;
  serviceStart: string;
  issueAt: string;
  historicalClock: string;
  chargeAt: string;
  dueEndAt: string;
  requests: { hosting: string; storage: string; early: string };
}

export async function assertCollectionsDirectory(directory: string) {
  if (!isAbsolute(directory))
    throw new Error(
      "Collections evidence requires an absolute private directory.",
    );
  const stat = await lstat(directory);
  const outside = relative(
    await realpath(process.cwd()),
    await realpath(directory),
  );
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o777) !== 0o700 ||
    !(outside === ".." || outside.startsWith(`..${sep}`) || isAbsolute(outside))
  )
    throw new Error(
      "Collections evidence requires an owner-only directory outside the checkout.",
    );
}

export async function readCollectionsPrivateJson(
  path: string,
): Promise<unknown> {
  const stat = await lstat(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o777) !== 0o600 ||
    stat.size > 1024 * 1024
  )
    throw new Error("Invalid private collections evidence file.");
  return JSON.parse(await readFile(path, "utf8"));
}

export async function writeCollectionsPrivateJson(
  path: string,
  value: unknown,
) {
  // Refuse a substituted target, and replace atomically so the running server
  // never reads a partially written clock or restart checkpoint.
  try {
    await readCollectionsPrivateJson(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const next = `${path}.${randomUUID()}.next`;
  await writeFile(next, JSON.stringify(value, null, 2) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  await rename(next, path);
}

export function collectionsPhase(value: string | undefined): CollectionsPhase {
  if (value !== "prepare" && value !== "collect" && value !== "verify-restart")
    throw new Error(
      "Choose collections acceptance phase prepare, collect or verify-restart.",
    );
  return value;
}

export async function loadCollectionsPlan(
  path: string,
): Promise<CollectionsPlan> {
  const value = await readCollectionsPrivateJson(path);
  if (!value || typeof value !== "object")
    throw new Error("Invalid collections plan.");
  const plan = value as CollectionsPlan;
  if (
    plan.version !== 1 ||
    plan.timeZone !== "America/Los_Angeles" ||
    typeof plan.runId !== "string" ||
    !plan.requests ||
    ![plan.runId, ...Object.values(plan.requests)].every(
      (id) =>
        typeof id === "string" &&
        /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id),
    ) ||
    Object.keys(plan.requests).sort().join() !== "early,hosting,storage"
  )
    throw new Error("Invalid collections plan identity.");
  const due = Temporal.PlainDate.from(plan.dueDate);
  const local = (date: Temporal.PlainDate, time: string) =>
    date
      .toZonedDateTime({
        timeZone: plan.timeZone,
        plainTime: time,
      })
      .toInstant()
      .toString();
  const sameInstant = (left: string, right: string) =>
    Temporal.Instant.compare(left, right) === 0;
  if (
    plan.serviceStart !== due.add({ days: 1 }).toString() ||
    !sameInstant(plan.issueAt, local(due.subtract({ days: 21 }), "09:00")) ||
    !sameInstant(plan.chargeAt, local(due, "09:00")) ||
    !sameInstant(plan.dueEndAt, local(due, "23:59:59")) ||
    !sameInstant(
      plan.historicalClock,
      Temporal.Instant.from(plan.issueAt).subtract({ minutes: 1 }).toString(),
    )
  )
    throw new Error("Collections plan calendar differs from LA09.");
  return plan;
}

/** This is a real-wall guard. It never waits or advances to a future instant. */
export function assertCollectionsWindow(
  plan: CollectionsPlan,
  phase: CollectionsPhase,
) {
  const now = new Date();
  const today = Temporal.Instant.from(now.toISOString())
    .toZonedDateTimeISO(plan.timeZone)
    .toPlainDate()
    .toString();
  if (today !== plan.dueDate || now.getTime() >= Date.parse(plan.dueEndAt))
    throw new Error(
      "Collections acceptance plan expired; choose a new private run directory.",
    );
  if (phase === "prepare" && now.getTime() >= Date.parse(plan.chargeAt))
    throw new Error(
      "Prepare and early payment must finish before real 09:00 LA.",
    );
  if (phase !== "prepare" && now.getTime() < Date.parse(plan.chargeAt))
    throw new Error(
      "Collection requires real wall time at or after 09:00 LA; rerun during that window.",
    );
}

/** Preserve the fixed plan and current calendar phase across owned restarts. */
export async function prepareCollectionsAcceptance(
  directory: string,
  timeZone: string,
  phase: CollectionsPhase,
) {
  await assertCollectionsDirectory(directory);
  if (timeZone !== "America/Los_Angeles")
    throw new Error("Collections acceptance requires America/Los_Angeles.");
  const planPath = join(directory, "collections-acceptance.json");
  const clockPath = join(directory, "collections-clock.json");
  const due = Temporal.Now.plainDateISO(timeZone);
  const instant = (date: Temporal.PlainDate, time: string) =>
    date.toZonedDateTime({ timeZone, plainTime: time }).toInstant();
  const issue = instant(due.subtract({ days: 21 }), "09:00");
  const candidate: CollectionsPlan = {
    version: 1,
    runId: randomUUID(),
    timeZone,
    dueDate: due.toString(),
    serviceStart: due.add({ days: 1 }).toString(),
    issueAt: issue.toString(),
    historicalClock: issue.subtract({ minutes: 1 }).toString(),
    chargeAt: instant(due, "09:00").toString(),
    dueEndAt: instant(due, "23:59:59").toString(),
    requests: {
      hosting: randomUUID(),
      storage: randomUUID(),
      early: randomUUID(),
    },
  };
  try {
    await writeFile(planPath, JSON.stringify(candidate), {
      mode: 0o600,
      flag: "wx",
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const plan = await loadCollectionsPlan(planPath);
  assertCollectionsWindow(plan, phase);
  try {
    await readCollectionsPrivateJson(clockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (phase !== "prepare")
      throw new Error("Prepare collections acceptance before collecting.");
    await writeFile(clockPath, JSON.stringify(plan.historicalClock), {
      mode: 0o600,
      flag: "wx",
    });
  }
  return { planPath, clockPath };
}
