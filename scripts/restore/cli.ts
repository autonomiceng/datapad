import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { captureManifest, connect, exportSnapshot } from "./database";
import { dumpSnapshot, restoreArchive } from "./archive";
import {
  createDestination,
  createInspectionLogin,
  type OwnedDestination,
} from "./destination";
import { readSourceConfig, verifyDatabase } from "./ownership";
import { command, digest, freshDirectory, writePrivate } from "./private";

export async function rehearse(configPath: string, output: string) {
  const config = await readSourceConfig(configPath);
  const directory = await freshDirectory(output);
  const startedAt = new Date().toISOString();
  const results: Record<string, unknown> = {
    version: 1,
    startedAt,
    sourceRevision: config.source.revision,
    sourceOwnershipHash: await verifyDatabase(config.source),
    authority: "operator-filesystem-and-source-database",
    productionBackupClaim: false,
    effectsEnabled: false,
    sourceStopped: false,
    dumpExit: null,
    restoreExit: null,
    inspectionExit: null,
    teardownExit: null,
  };
  let destination: OwnedDestination | undefined;
  let stage = "snapshot";
  let completed = false;
  try {
    const source = await connect(config.source.databaseUrl);
    try {
      const version = (await source.query("SHOW server_version")).rows[0]
        .server_version;
      if (typeof version !== "string" || version.split(" ")[0] !== "18.6")
        throw new Error("PostgreSQL 18.6 source required.");
      const sourceIdentity = await source.query(
        "SELECT current_database() AS database,(SELECT oid::text FROM pg_database WHERE datname=current_database()) AS oid,system_identifier::text AS system FROM pg_control_system()",
      );
      results.sourceDatabaseIdentityHash = digest(sourceIdentity.rows[0]);
      results.sourceServerVersion = version;
      const snapshot = await exportSnapshot(source);
      results.snapshotCapturedAt = new Date().toISOString();
      const reference = await captureManifest(
        source,
        config.source.deploymentKey,
      );
      results.sourceSchemaHash = reference.schemaHash;
      results.sourceDataHash = reference.dataHash;
      results.pausedObserved = reference.pausedObserved;
      results.snapshot = "exported-repeatable-read";
      await writePrivate(join(directory, "source-manifest.json"), reference);
      stage = "dump";
      results.archiveDigest = await dumpSnapshot(
        config.source,
        snapshot,
        join(directory, "backup.dump"),
      );
      results.dumpExit = 0;
      results.dumpCompletedAt = new Date().toISOString();
      await source.query("COMMIT");
    } finally {
      await source.end();
    }
    results.tools = {
      pgDump: await command([
        "docker",
        "exec",
        config.source.containerId,
        "pg_dump",
        "--version",
      ]),
      docker: await command([
        "docker",
        "version",
        "--format",
        "{{.Server.Version}}",
      ]),
      compose: await command(["docker", "compose", "version", "--short"]),
      bun: Bun.version,
    };
    stage = "create-destination";
    destination = await createDestination(directory);
    results.destinationOwnershipHash = await verifyDatabase(
      destination.identity,
    );
    stage = "restore";
    await restoreArchive(destination.identity, join(directory, "backup.dump"));
    results.restoreExit = 0;
    results.restoreCompletedAt = new Date().toISOString();
    (results.tools as Record<string, string>).pgRestore = await command([
      "docker",
      "exec",
      destination.identity.containerId,
      "pg_restore",
      "--version",
    ]);
    const reference = await Bun.file(
      join(directory, "source-manifest.json"),
    ).json();
    stage = "restrict-inspection";
    const reader = await createInspectionLogin(destination.identity);
    const inspectionConfig = join(directory, "inspection-config.json");
    await writePrivate(inspectionConfig, {
      version: 1,
      purpose: "owned-synthetic-restore-inspection",
      destination: reader,
      nonce: destination.nonce,
      referencePath: join(directory, "source-manifest.json"),
      referenceHash: digest(reference),
    });
    stage = "inspect";
    await command([
      process.execPath,
      resolve(import.meta.dir, "inspect-cli.ts"),
      "--config",
      inspectionConfig,
      "--output",
      join(directory, "inspection"),
    ]);
    results.inspectionExit = 0;
    completed = true;
  } catch (error) {
    results.failedStage = stage;
    if (stage === "dump") results.dumpExit = 1;
    if (stage === "restore") results.restoreExit = 1;
    if (stage === "inspect") results.inspectionExit = 1;
    throw error;
  } finally {
    results.completed = completed;
    results.lastStage = stage;
    if (destination) {
      try {
        await destination.destroy();
        results.teardownExit = 0;
      } catch {
        results.teardownExit = 1;
        completed = false;
        results.completed = false;
      }
    }
    results.finishedAt = new Date().toISOString();
    await writePrivate(join(directory, "rehearsal-manifest.json"), results);
  }
  if (!completed)
    throw new Error(
      "Owned teardown failed; retained creation receipt requires review.",
    );
  return directory;
}

if (import.meta.main) {
  try {
    const { values } = parseArgs({
      options: { config: { type: "string" }, output: { type: "string" } },
      strict: true,
    });
    if (!values.config || !values.output)
      throw new Error("Explicit config and fresh output required.");
    await rehearse(values.config, values.output);
    console.log(
      "Synthetic restore rehearsal passed; backup and inspection report retained after owned destination teardown.",
    );
  } catch {
    console.error(
      "Synthetic restore rehearsal failed; private evidence and creation receipt require operator review.",
    );
    process.exitCode = 1;
  }
}
