import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const mode = process.argv[2];
if (!["demo", "dev", "test", "destroy"].includes(mode ?? "")) {
  throw new Error("Expected demo, dev, test or destroy.");
}
const root = resolve(import.meta.dir, "..");
const localId = createHash("sha256").update(root).digest("hex").slice(0, 12);
const project =
  mode === "test" ? `datapad-test-${randomUUID()}` : `datapad-${localId}`;
const lock = resolve(root, ".scratch/local-run.lock");
const compose = [
  "docker",
  "compose",
  "--file",
  resolve(root, "compose.yaml"),
  "--project-name",
  project,
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
            ...(mode === "test" ? ["--volumes"] : []),
          ]);
        }
      } finally {
        if (locked) await rm(lock, { recursive: true });
      }
    }
  })();
  return cleaning;
}

async function startServer(): Promise<string> {
  const child = Bun.spawn([process.execPath, "src/server/index.ts"], {
    cwd: root,
    env: { ...env, HOST: "127.0.0.1", PORT: "0" },
    stdout: "pipe",
    stderr: "inherit",
    stdin: "ignore",
    detached: true,
  });
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
  if (mode !== "test") {
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
  if (mode === "destroy") {
    await command([...compose, "down", "--volumes"]);
  } else {
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
    env.NODE_ENV = mode === "dev" ? "development" : "production";
    env.ASSETS_DIR = mode === "dev" ? "" : "dist";
    const url = await startServer();
    if (mode === "test") {
      env.TEST_BASE_URL = url;
      await command(["./node_modules/.bin/playwright", "test"]);
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
        "Press Ctrl+C to stop. Imports persist; mise run demo:destroy removes this checkout's database.",
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
