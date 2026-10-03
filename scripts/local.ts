import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { openSandbox, availableLoopbackPort } from "./billing-sandbox";
import { prepareScheduledAcceptance } from "./scheduled-acceptance";
import { startStripeListener } from "./stripe-listener";

const mode = process.argv[2];
if (
  ![
    "demo",
    "dev",
    "test",
    "destroy",
    "billing",
    "portal",
    "portal-billing",
    "portal-billing-test",
    "portal-scheduled-test",
    "portal-test",
    "portal-destroy",
  ].includes(mode ?? "")
) {
  throw new Error(
    "Expected demo, dev, test, destroy, billing, portal, portal-billing, portal-billing-test, portal-scheduled-test, portal-test or portal-destroy.",
  );
}
const portal =
  mode === "portal" ||
  mode === "portal-billing" ||
  mode === "portal-billing-test" ||
  mode === "portal-scheduled-test" ||
  mode === "portal-test" ||
  mode === "portal-destroy";
const sandboxMode =
  mode === "billing" ||
  mode === "portal-billing" ||
  mode === "portal-billing-test" ||
  mode === "portal-scheduled-test";
const isolated = mode === "test" || mode === "portal-test";
const scheduledTesting = mode === "portal-scheduled-test";
const testing = isolated || mode === "portal-billing-test" || scheduledTesting;
const { values } = parseArgs({
  args: process.argv.slice(3),
  options: {
    config: { type: "string" },
    "run-dir": { type: "string" },
    origin: { type: "string" },
    "inbox-origin": { type: "string" },
    "time-zone": { type: "string" },
  },
  strict: true,
});
if (sandboxMode && (!values.config || !values["run-dir"]))
  throw new Error("Billing requires --config and --run-dir outside Git.");
if (!sandboxMode && (values.config || values["run-dir"]))
  throw new Error("Sandbox arguments require billing or portal-billing mode.");
if (
  (values.origin || values["inbox-origin"]) &&
  mode !== "portal" &&
  mode !== "portal-billing"
)
  throw new Error("An external origin requires portal demo mode.");
let sandbox: Awaited<ReturnType<typeof openSandbox>> | undefined;
let serverPort = 0;
const root = resolve(import.meta.dir, "..");
const localId = createHash("sha256").update(root).digest("hex").slice(0, 12);
const project = isolated
  ? `datapad-test-${randomUUID()}`
  : sandboxMode
    ? `datapad-${portal ? "portal-billing" : "billing"}-${createHash("sha256").update(resolve(values["run-dir"]!)).digest("hex").slice(0, 12)}`
    : portal
      ? `datapad-portal-${localId}`
      : `datapad-${localId}`;
const lock = resolve(
  root,
  mode === "portal-billing-test" || scheduledTesting
    ? ".scratch/billing-test.lock"
    : sandboxMode
      ? ".scratch/billing-run.lock"
      : ".scratch/local-run.lock",
);
const compose = [
  "docker",
  "compose",
  "--file",
  resolve(root, "compose.yaml"),
  "--project-name",
  project,
  ...(portal ? ["--profile", "portal"] : []),
];
const env: Record<string, string | undefined> = { ...process.env };
const children: ReturnType<typeof Bun.spawn>[] = [];
let locked = false;
let databaseStarted = false;
let cleaning: Promise<void> | undefined;

async function command(args: string[], capture = false): Promise<string> {
  const child = Bun.spawn(args, {
    cwd: root,
    env,
    stdin: "ignore",
    stdout: capture ? "pipe" : "inherit",
    stderr: "inherit",
  });
  const output = capture ? await new Response(child.stdout).text() : "";
  const code = await child.exited;
  if (code !== 0) throw new Error(`${args[0]} exited with status ${code}`);
  return output.trim();
}

async function stopChildren() {
  for (const child of [...children].reverse()) {
    if (child.exitCode !== null) continue;
    // Every background child starts in its own process group; no process-name lookup.
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      child.exited,
      new Promise<void>((done) => {
        timeout = setTimeout(() => {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            /* already exited */
          }
          done();
        }, 5000);
      }),
    ]);
    clearTimeout(timeout);
    await child.exited;
  }
}

function cleanup(): Promise<void> {
  cleaning ??= (async () => {
    try {
      await stopChildren();
    } finally {
      try {
        if (databaseStarted) {
          await command([
            ...compose,
            "down",
            ...(isolated ? ["--volumes"] : []),
          ]);
        }
      } finally {
        if (locked) await rm(lock, { recursive: true });
        await sandbox?.release();
      }
    }
  })();
  return cleaning;
}

async function startServer(): Promise<string> {
  const child = Bun.spawn(
    [
      process.execPath,
      scheduledTesting
        ? "tests/portal-scheduled-entry.ts"
        : portal
          ? "src/server/portal-index.ts"
          : "src/server/index.ts",
    ],
    {
      cwd: root,
      env: { ...env, HOST: "127.0.0.1", PORT: String(serverPort) },
      stdout: "pipe",
      stderr: "inherit",
      stdin: "ignore",
      detached: true,
    },
  );
  children.push(child);
  const reader = child.stdout.getReader();
  let startupTimer: ReturnType<typeof setTimeout> | undefined;
  const ready = new Promise<string>((accept, reject) => {
    startupTimer = setTimeout(
      () => reject(new Error("Server startup timed out.")),
      30000,
    );
    void (async () => {
      let text = "";
      const decoder = new TextDecoder();
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        const part = decoder.decode(chunk.value, { stream: true });
        process.stdout.write(part);
        text += part;
        const match = text.match(/Listening on (http:\/\/127\.0\.0\.1:\d+)/);
        if (match?.[1]) {
          clearTimeout(startupTimer);
          accept(match[1]);
        }
      }
      reject(new Error("Server exited before becoming ready."));
    })().catch(reject);
  });
  try {
    return await ready;
  } finally {
    clearTimeout(startupTimer);
  }
}

let finish: (() => void) | undefined;
let interrupted = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    interrupted = true;
    finish?.();
  });
}

try {
  if (!isolated) {
    await mkdir(resolve(root, ".scratch"), { recursive: true });
    try {
      await mkdir(lock);
    } catch {
      throw new Error(
        "A local run is active (or left a stale .scratch/local-run.lock). Stop it before continuing.",
      );
    }
    locked = true;
    await writeFile(
      resolve(lock, "owner.json"),
      JSON.stringify({ pid: process.pid, root, project }),
    );
  }
  if (mode === "destroy" || mode === "portal-destroy") {
    await command([...compose, "down", "--volumes"]);
  } else {
    if (sandboxMode)
      sandbox = await openSandbox(values.config!, values["run-dir"]!);
    databaseStarted = true;
    await command([
      ...compose,
      "up",
      "--detach",
      "--wait",
      "--wait-timeout",
      "60",
    ]);
    const binding = await command([...compose, "port", "db", "5432"], true);
    const port = /^127\.0\.0\.1:(\d+)$/.exec(binding)?.[1];
    if (!port) throw new Error("Expected exactly one loopback database port.");
    env.DATABASE_URL = `postgres://example:local-example-only@127.0.0.1:${port}/example`;
    env.TEST_DATABASE_URL = env.DATABASE_URL;
    env.TZ = "Asia/Tokyo";
    await command([process.execPath, "scripts/migrate.ts"]);
    if (mode === "test")
      await command([process.execPath, "test", "tests/server"]);
    if (interrupted) throw new Error("Run interrupted.");
    for (const fixture of [
      "fixtures/import-review/synthetic-v1.json",
      "fixtures/import-review/synthetic-v1-later.json",
    ]) {
      await command([process.execPath, "scripts/import-records.ts", fixture]);
    }
    if (portal) {
      serverPort = await availableLoopbackPort();
      const origin = values.origin ?? `http://127.0.0.1:${serverPort}`;
      const parsedOrigin = new URL(origin);
      if (
        !["http:", "https:"].includes(parsedOrigin.protocol) ||
        parsedOrigin.origin !== origin
      )
        throw new Error(
          "Portal origin must be an HTTP(S) origin without a path or credentials.",
        );
      const smtpBinding = await command(
        [...compose, "port", "mail", "1025"],
        true,
      );
      const inboxBinding = await command(
        [...compose, "port", "mail", "8025"],
        true,
      );
      const smtpPort = /^127\.0\.0\.1:(\d+)$/.exec(smtpBinding)?.[1];
      const inboxPort = /^127\.0\.0\.1:(\d+)$/.exec(inboxBinding)?.[1];
      if (!smtpPort || !inboxPort)
        throw new Error("Expected loopback-only test mail ports.");
      // Provider credentials are injected only by the explicit sandbox mode below.
      delete env.PORTAL_BILLING_SANDBOX;
      delete env.PORTAL_SCHEDULE_TEST_CLOCK;
      delete env.PORTAL_SCHEDULE_TEST_PLAN;
      env.PORTAL_DEMO_TIME_ZONE =
        values["time-zone"] ??
        (scheduledTesting ? "America/Los_Angeles" : "UTC");
      for (const key of Object.keys(env)) {
        if (key.startsWith("STRIPE_") || key.startsWith("BILLING_"))
          delete env[key];
      }
      env.PORTAL_DEMO_ORIGIN = origin;
      env.PORTAL_DEMO_SECRET = `${randomUUID()}${randomUUID()}`;
      env.PORTAL_DEMO_SMTP_URL = `smtp://127.0.0.1:${smtpPort}`;
      env.PORTAL_TEST_MAILPIT_URL = `http://127.0.0.1:${inboxPort}`;
      const inboxOrigin = values["inbox-origin"] ?? env.PORTAL_TEST_MAILPIT_URL;
      if (
        !["http:", "https:"].includes(new URL(inboxOrigin).protocol) ||
        new URL(inboxOrigin).origin !== inboxOrigin
      )
        throw new Error(
          "Inbox origin must be an HTTP(S) origin without a path or credentials.",
        );
      env.PORTAL_DEMO_INBOX_URL = inboxOrigin;
      await command([process.execPath, "scripts/portal-seed.ts"]);
      console.log(`Sample inbox: ${env.PORTAL_TEST_MAILPIT_URL}`);
    }
    if (sandbox) {
      if (!portal) serverPort = await availableLoopbackPort();
      const listener = startStripeListener({
        secretKey: sandbox.key,
        forwardTo: `http://127.0.0.1:${serverPort}/api/billing/webhooks/stripe`,
        configPath: resolve(sandbox.directory, "stripe-cli.toml"),
      });
      children.push(listener.child);
      env.STRIPE_WEBHOOK_SECRET = await listener.ready;
      env.STRIPE_SECRET_KEY = sandbox.key;
      env.BILLING_DEPLOYMENT_KEY = sandbox.deploymentKey;
      if (portal) {
        env.PORTAL_BILLING_SANDBOX = "true";
        if (scheduledTesting) {
          const acceptance = await prepareScheduledAcceptance(
            sandbox.directory,
            env.PORTAL_DEMO_TIME_ZONE!,
          );
          env.PORTAL_SCHEDULE_TEST_CLOCK = acceptance.clockPath;
          env.PORTAL_SCHEDULE_TEST_PLAN = acceptance.planPath;
        }
      } else {
        env.BILLING_ISSUE_DATE = sandbox.issueDate;
        await command([
          process.execPath,
          "scripts/billing-operator.ts",
          "issue",
        ]);
      }
    }
    env.NODE_ENV = mode === "dev" ? "development" : "production";
    env.ASSETS_DIR = mode === "dev" ? "" : "dist";
    const url = await startServer();
    if (testing) {
      env.TEST_BASE_URL = url;
      await command([
        "./node_modules/.bin/playwright",
        "test",
        ...(portal
          ? [
              "--config",
              scheduledTesting
                ? "playwright.scheduled.config.ts"
                : mode === "portal-billing-test"
                  ? "playwright.billing.config.ts"
                  : "playwright.portal.config.ts",
            ]
          : []),
      ]);
    } else {
      if (mode === "dev") {
        const web = Bun.spawn(
          [
            "./node_modules/.bin/vp",
            "dev",
            "--host",
            "127.0.0.1",
            "--port",
            "0",
          ],
          {
            cwd: root,
            env: { ...env, API_ORIGIN: url },
            stdin: "ignore",
            stdout: "inherit",
            stderr: "inherit",
            detached: true,
          },
        );
        children.push(web);
      }
      console.log(
        sandboxMode
          ? "Press Ctrl+C to stop. Sandbox data persists for this run directory."
          : portal
            ? "Press Ctrl+C to stop. Customer data persists; mise run portal:destroy removes this checkout's demo database."
            : "Press Ctrl+C to stop. Imports persist; mise run demo:destroy removes this checkout's database.",
      );
      await Promise.race([
        new Promise<void>((done) => {
          finish = done;
          if (interrupted) done();
        }),
        ...children.map(async (child) => {
          await child.exited;
          throw new Error("Application process exited unexpectedly.");
        }),
      ]);
    }
  }
} finally {
  await cleanup();
}
