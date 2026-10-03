import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  beginRead,
  captureManifest,
  connect,
  exportSnapshot,
} from "../../scripts/restore/database";
import { dumpSnapshot, restoreArchive } from "../../scripts/restore/archive";
import { createDestination } from "../../scripts/restore/destination";
import {
  container,
  readSourceConfig,
  sourceProject,
  verifyDatabase,
  type SourceConfig,
} from "../../scripts/restore/ownership";
import {
  command,
  digest,
  freshDirectory,
  readPrivate,
  writePrivate,
} from "../../scripts/restore/private";

let directory: string;
let configPath: string;
let config: SourceConfig;
let savedContainerId: string | undefined;
let savedVolume: string | undefined;
let savedNetworkId: string | undefined;
let project: string;
const root = resolve(import.meta.dir, "../..");

beforeAll(async () => {
  directory = await mkdtemp(join(homedir(), ".datapad-restore-synthetic-"));
  const runDirectory = await freshDirectory(join(directory, "source-run"));
  project = sourceProject(runDirectory);
  const deploymentKey = randomUUID();
  await writePrivate(join(runDirectory, "sandbox.json"), {
    deploymentKey,
    issueDate: "2026-10-03",
  });
  const composeFile = join(root, "compose.yaml");
  await command([
    "docker",
    "compose",
    "--project-directory",
    root,
    "--file",
    composeFile,
    "--project-name",
    project,
    "create",
    "db",
  ]);
  const ids = (
    await command([
      "docker",
      "ps",
      "--all",
      "--quiet",
      "--no-trunc",
      "--filter",
      `label=com.docker.compose.project=${project}`,
      "--filter",
      "label=com.docker.compose.service=db",
    ])
  )
    .split(/\s+/)
    .filter(Boolean);
  if (ids.length !== 1)
    throw new Error("Synthetic fixture ownership unavailable.");
  savedContainerId = ids[0];
  const created = await container(savedContainerId);
  if (
    created.Config.Labels["com.docker.compose.project"] !== project ||
    created.Config.Labels["com.docker.compose.project.config_files"] !==
      composeFile
  )
    throw new Error("Fixture creation labels differ.");
  savedVolume = created.Mounts.find(
    (mount) =>
      mount.Type === "volume" && mount.Destination === "/var/lib/postgresql",
  )?.Name;
  const networks = (
    await command([
      "docker",
      "network",
      "ls",
      "--quiet",
      "--no-trunc",
      "--filter",
      `label=com.docker.compose.project=${project}`,
    ])
  )
    .split(/\s+/)
    .filter(Boolean);
  if (!savedVolume || networks.length !== 1)
    throw new Error("Fixture resources unavailable.");
  savedNetworkId = networks[0];
  await writePrivate(join(directory, "fixture-ownership.json"), {
    project,
    containerId: savedContainerId,
    volume: savedVolume,
    networkId: savedNetworkId,
  });
  await command(["docker", "start", savedContainerId]);
  const item = await container(savedContainerId);
  const ports = item.NetworkSettings.Ports["5432/tcp"];
  if (ports?.length !== 1 || ports[0].HostIp !== "127.0.0.1")
    throw new Error("Fixture loopback binding unavailable.");
  configPath = join(directory, "source-config.json");
  await writePrivate(configPath, {
    version: 1,
    purpose: "owned-synthetic-portal",
    source: {
      runDirectory,
      composeProject: project,
      composeFile,
      checkoutDirectory: root,
      databaseUrl: `postgres://example:local-example-only@127.0.0.1:${ports[0].HostPort}/example`,
      deploymentKey,
      revision: await command(["git", "-C", root, "rev-parse", "HEAD"]),
    },
  });
  config = await readSourceConfig(configPath);
  for (let attempt = 0; ; attempt++) {
    try {
      await command([
        "docker",
        "exec",
        config.source.containerId,
        "pg_isready",
        "--host=127.0.0.1",
        "--username=example",
        "--dbname=example",
      ]);
    } catch {
      if (attempt >= 60) throw new Error("Fixture startup timed out.");
      await new Promise((done) => setTimeout(done, 500));
      continue;
    }
    try {
      const client = await connect(config.source.databaseUrl);
      try {
        await client.query(`
          CREATE TABLE customers (id uuid PRIMARY KEY, name text NOT NULL);
          CREATE TABLE memberships (id uuid PRIMARY KEY, customer_id uuid REFERENCES customers(id), status text, revoked_at timestamptz);
          CREATE TABLE invoices (id uuid PRIMARY KEY, customer_id uuid REFERENCES customers(id), deployment_key text, status text, amount_minor bigint, currency text, provider_invoice_id text, finalize_attempted_at timestamptz, hosted_url text);
          CREATE TABLE payment_attempts (id uuid PRIMARY KEY, invoice_id uuid REFERENCES invoices(id), deployment_key text, status text, attempted_at timestamptz, consent_revoked_at timestamptz, dispatch_count integer);
          CREATE TABLE billing_effect_controls (deployment_key text PRIMARY KEY, paused boolean NOT NULL);
          CREATE TABLE sessions (id text PRIMARY KEY, token text, customer_id uuid REFERENCES customers(id));
          CREATE SCHEMA pgboss;
          CREATE TABLE pgboss.job (id uuid PRIMARY KEY, state text, data jsonb);
          CREATE SCHEMA drizzle;
          CREATE TABLE drizzle.__drizzle_migrations (id serial PRIMARY KEY, hash text);
          INSERT INTO drizzle.__drizzle_migrations(hash) VALUES ('synthetic-schema');
        `);
        const customer = randomUUID(),
          invoice = randomUUID();
        await client.query(
          "INSERT INTO customers VALUES ($1,'Synthetic Customer')",
          [customer],
        );
        await client.query(
          "INSERT INTO memberships VALUES ($1,$2,'revoked','2026-10-02T00:00:00Z')",
          [randomUUID(), customer],
        );
        await client.query(
          "INSERT INTO invoices VALUES ($1,$2,$3,'needs_review',9007199254740993,'USD','synthetic_receipt','2026-10-01T00:00:00Z','https://example.test/private-signed-payment')",
          [invoice, customer, deploymentKey],
        );
        await client.query(
          "INSERT INTO payment_attempts VALUES ($1,$2,$3,'attempted','2026-10-01T00:00:00Z','2026-10-02T00:00:00Z',3)",
          [randomUUID(), invoice, deploymentKey],
        );
        await client.query(
          "INSERT INTO billing_effect_controls VALUES ($1,false)",
          [deploymentKey],
        );
        await client.query(
          "INSERT INTO sessions VALUES ('synthetic-session-id','synthetic-secret-token',$1)",
          [customer],
        );
        await client.query(
          "INSERT INTO pgboss.job VALUES ($1,'created','{\"inert\":true}')",
          [randomUUID()],
        );
      } finally {
        await client.end();
      }
      break;
    } catch (error) {
      if (
        !(
          error instanceof Error &&
          "code" in error &&
          ["ECONNREFUSED", "57P03"].includes(String(error.code))
        ) ||
        attempt >= 60
      )
        throw error;
      await new Promise((done) => setTimeout(done, 500));
    }
  }
}, 60_000);

afterAll(async () => {
  if (savedContainerId) {
    const item = await container(savedContainerId);
    if (
      item.Config.Labels["com.docker.compose.project"] !== project ||
      item.Config.Labels["com.docker.compose.project.config_files"] !==
        join(root, "compose.yaml") ||
      !item.Mounts.some((mount) => mount.Name === savedVolume)
    )
      throw new Error("Fixture teardown ownership mismatch.");
    await command(["docker", "rm", "--force", savedContainerId]);
  }
  if (savedVolume) {
    const volumes: { Labels: Record<string, string> }[] = JSON.parse(
      await command(["docker", "volume", "inspect", savedVolume]),
    );
    if (
      volumes.length !== 1 ||
      volumes[0].Labels["com.docker.compose.project"] !== project
    )
      throw new Error("Fixture volume ownership mismatch.");
    await command(["docker", "volume", "rm", savedVolume]);
  }
  if (savedNetworkId) {
    const networks: { Id: string; Labels: Record<string, string> }[] =
      JSON.parse(
        await command(["docker", "network", "inspect", savedNetworkId]),
      );
    if (
      networks.length !== 1 ||
      networks[0].Id !== savedNetworkId ||
      networks[0].Labels["com.docker.compose.project"] !== project
    )
      throw new Error("Fixture network ownership mismatch.");
    await command(["docker", "network", "rm", savedNetworkId]);
  }
}, 30_000);

test("snapshot and full restore retain revoked membership and attempted work while source advances", async () => {
  const output = await freshDirectory(join(directory, "snapshot-consistency"));
  const source = await connect(config.source.databaseUrl);
  const writer = await connect(config.source.databaseUrl);
  let destination: Awaited<ReturnType<typeof createDestination>> | undefined;
  try {
    const snapshot = await exportSnapshot(source);
    const before = await captureManifest(source, config.source.deploymentKey);
    await writer.query("UPDATE invoices SET amount_minor=42,status='open'");
    await writer.query(
      "INSERT INTO pgboss.job VALUES ($1,'created','{\"afterSnapshot\":true}')",
      [randomUUID()],
    );
    const archive = join(output, "backup.dump");
    const hash = await dumpSnapshot(config.source, snapshot, archive);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect((await stat(archive)).mode & 0o777).toBe(0o600);
    await source.query("COMMIT");
    destination = await createDestination(output);
    await restoreArchive(destination.identity, archive);
    const restored = await connect(destination.identity.databaseUrl);
    try {
      await beginRead(restored);
      const after = await captureManifest(restored);
      expect(digest(after)).toBe(digest(before));
      expect(
        after.tables.find((table) => table.table === "invoices")?.summary
          .amounts["amount_minor (USD)"],
      ).toBe("9007199254740993");
      expect(
        after.tables.find((table) => table.table === "memberships")?.summary
          .statuses.revoked,
      ).toBe(1);
      expect(
        after.tables.find((table) => table.table === "payment_attempts")
          ?.summary.receipts.attempted_at,
      ).toBe(1);
      expect(after.tables.find((table) => table.table === "job")?.count).toBe(
        1,
      );
      expect(
        after.tables.find((table) => table.table === "sessions")?.count,
      ).toBe(1);
      await restored.query("COMMIT");
    } finally {
      await restored.end();
    }
    expect(
      (await writer.query("SELECT amount_minor::text AS amount FROM invoices"))
        .rows[0].amount,
    ).toBe("42");
    expect(
      (await writer.query("SELECT count(*)::int AS count FROM pgboss.job"))
        .rows[0].count,
    ).toBe(2);
  } finally {
    await source.end();
    await writer.end();
    await destination?.destroy();
  }
}, 60_000);

test("actual separate inspection journey denies writes and leaves unpaused restored auth/jobs inert", async () => {
  const sourceBefore = await connect(config.source.databaseUrl);
  let before;
  try {
    await beginRead(sourceBefore);
    before = await captureManifest(sourceBefore);
    await sourceBefore.query("COMMIT");
  } finally {
    await sourceBefore.end();
  }
  const output = join(directory, "actual-journey");
  await command([
    process.execPath,
    join(root, "scripts/restore/cli.ts"),
    "--config",
    configPath,
    "--output",
    output,
  ]);
  const inspection = (await readPrivate(
    join(output, "inspection/inspection-manifest.json"),
  )) as {
    before: unknown;
    after: unknown;
    writeDenied: boolean;
    transportsInvoked: boolean;
    graph: {
      edges: string[];
      transportsConfigured: boolean;
      workersConstructed: boolean;
    };
  };
  expect(digest(inspection.before)).toBe(digest(before));
  expect(digest(inspection.after)).toBe(digest(before));
  expect(inspection.writeDenied).toBe(true);
  expect(inspection.transportsInvoked).toBe(false);
  expect(inspection.graph.transportsConfigured).toBe(false);
  expect(inspection.graph.workersConstructed).toBe(false);
  expect(
    inspection.graph.edges.some((edge) =>
      edge.includes("scripts/restore/inspect-cli.ts"),
    ),
  ).toBe(true);
  const report = await readFile(join(output, "inspection/report.html"), "utf8");
  expect(report).toContain("pause values: false");
  for (const forbidden of [
    "synthetic-session-id",
    "synthetic-secret-token",
    "private-signed-payment",
    "postgres://",
    "href=",
    "<script",
    "<form",
  ])
    expect(report).not.toContain(forbidden);
  expect((await stat(join(output, "inspection"))).mode & 0o777).toBe(0o700);
  expect(
    (await stat(join(output, "inspection/report.html"))).mode & 0o777,
  ).toBe(0o600);
  const rehearsal = (await readPrivate(
    join(output, "rehearsal-manifest.json"),
  )) as { completed: boolean; teardownExit: number; snapshot: string };
  expect(rehearsal.completed).toBe(true);
  expect(rehearsal.teardownExit).toBe(0);
  expect(rehearsal.snapshot).toBe("exported-repeatable-read");
  const saved = (await readPrivate(join(output, "owned-destination.json"))) as {
    project: string;
  };
  expect(
    await command([
      "docker",
      "ps",
      "--all",
      "--quiet",
      "--filter",
      `label=com.docker.compose.project=${saved.project}`,
    ]),
  ).toBe("");
  expect(
    await command([
      "docker",
      "volume",
      "ls",
      "--quiet",
      "--filter",
      `label=com.docker.compose.project=${saved.project}`,
    ]),
  ).toBe("");
  const sourceAfter = await connect(config.source.databaseUrl);
  try {
    await beginRead(sourceAfter);
    expect(digest(await captureManifest(sourceAfter))).toBe(digest(before));
    await sourceAfter.query("COMMIT");
  } finally {
    await sourceAfter.end();
  }
  await verifyDatabase(config.source);
}, 60_000);
