import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  beginRead,
  captureManifest,
  connect,
  identifier,
  qualified,
  type DataManifest,
} from "./database";
import {
  container,
  databaseUrl,
  verifyDatabase,
  type DatabaseIdentity,
} from "./ownership";
import {
  digest,
  exactObject,
  freshDirectory,
  readPrivate,
  textField,
  writePrivate,
} from "./private";
import { inspectionGraph } from "./check-boundary";

export interface InspectionConfig {
  version: 1;
  purpose: "owned-synthetic-restore-inspection";
  destination: DatabaseIdentity;
  nonce: string;
  referencePath: string;
  referenceHash: string;
}
function parseConfig(value: unknown): InspectionConfig {
  const raw = exactObject(value, [
    "version",
    "purpose",
    "destination",
    "nonce",
    "referencePath",
    "referenceHash",
  ]);
  if (raw.version !== 1 || raw.purpose !== "owned-synthetic-restore-inspection")
    throw new Error("Inspection-only configuration required.");
  const item = exactObject(raw.destination, [
    "project",
    "composeFile",
    "checkoutDirectory",
    "containerId",
    "volumeName",
    "databaseUrl",
  ]);
  const destination = Object.fromEntries(
    Object.entries(item).map(([key, value]) => [key, textField(value)]),
  ) as unknown as DatabaseIdentity;
  const nonce = textField(raw.nonce),
    referencePath = textField(raw.referencePath),
    referenceHash = textField(raw.referenceHash);
  if (
    !/^[0-9a-f-]{36}$/.test(nonce) ||
    destination.project !== `datapad-restore-${nonce}` ||
    destination.volumeName !== `${destination.project}-database` ||
    destination.composeFile !==
      join(destination.checkoutDirectory, "destination-compose.json") ||
    referencePath !==
      join(destination.checkoutDirectory, "source-manifest.json") ||
    !/^[0-9a-f]{64}$/.test(referenceHash)
  )
    throw new Error("Inspection ownership receipt mismatch.");
  databaseUrl(destination.databaseUrl);
  return {
    version: 1,
    purpose: "owned-synthetic-restore-inspection",
    destination,
    nonce,
    referencePath,
    referenceHash,
  };
}

function referenceManifest(value: unknown): DataManifest {
  const raw = exactObject(value, [
    "version",
    "schemaHash",
    "dataHash",
    "tables",
    "pausedObserved",
  ]);
  if (
    raw.version !== 1 ||
    typeof raw.schemaHash !== "string" ||
    !/^[0-9a-f]{64}$/.test(raw.schemaHash) ||
    typeof raw.dataHash !== "string" ||
    !/^[0-9a-f]{64}$/.test(raw.dataHash) ||
    !Array.isArray(raw.tables) ||
    !Array.isArray(raw.pausedObserved)
  )
    throw new Error("Invalid source reference manifest.");
  // Equality with a newly captured manifest validates table/summary structure without reflecting untrusted values.
  return raw as unknown as DataManifest;
}
function htmlReport(reference: DataManifest, graphHash: string) {
  const escape = (value: string) =>
    value.replace(
      /[&<>"']/g,
      (character) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[character]!,
    );
  const rows = reference.tables
    .map(
      (table) =>
        `<tr><td data-label="Table">${escape(table.schema + "." + table.table)}</td><td data-label="Rows">${table.count}</td><td data-label="Statuses">${escape(
          Object.entries(table.summary.statuses)
            .map(([key, count]) => `${key}: ${count}`)
            .join(", ") || "None observed",
        )}</td><td data-label="Minor-unit sums">${escape(
          Object.entries(table.summary.amounts)
            .map(([key, amount]) => `${key}: ${amount}`)
            .join(", ") || "None",
        )}</td><td data-label="Receipt and history counts">${escape(
          Object.entries(table.summary.receipts)
            .map(([key, count]) => `${key}: ${count}`)
            .join(", ") || "None",
        )}</td></tr>`,
    )
    .join("\n");
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>Synthetic restore inspection</title><style>body{font:400 16px system-ui;margin:24px;max-width:1100px}h1{font-size:24px;font-weight:600}h2{font-size:16px;font-weight:600;margin-top:32px}p,td,th{overflow-wrap:anywhere}table{border-collapse:collapse;width:100%}td,th{text-align:left;vertical-align:top;padding:8px;border-bottom:1px solid #ccc}th{font-weight:600}.support{font-size:14px}@media(max-width:640px){table,tbody,tr,td{display:block}thead{display:none}tr{margin-bottom:16px}td:before{content:attr(data-label);display:block;font-weight:600}}</style><h1>Synthetic restore inspection</h1><p>Every table matches the exported source snapshot. Inspection before and after report composition is identical. Database writes were denied in a rolled-back permission probe.</p><p>No provider or SMTP transport is configured or invoked. No worker, authentication listener, migrations or bootstrap is constructed. Dependency boundary verified and the actual report journey completed.</p><p>Observed copied pause values: ${reference.pausedObserved.length ? reference.pausedObserved.join(", ") : "No row observed"}. These values grant no permission to run effects.</p><h2>Restored records</h2><table><thead><tr><th>Table</th><th>Rows</th><th>Statuses</th><th>Minor-unit sums</th><th>Receipt and history counts</th></tr></thead><tbody>${rows}</tbody></table><h2>Verification</h2><p class="support">Data digest: ${reference.dataHash}<br>Schema digest: ${reference.schemaHash}<br>Inspection dependency digest: ${graphHash}</p><p class="support">Operator filesystem and source database authority. Copied sessions and grants authorize nothing. This synthetic copy is never promoted or resumed. No production backup or handoff guarantee.</p></html>`;
}

export async function inspectRestore(configPath: string, output: string) {
  const config = parseConfig(await readPrivate(configPath));
  const owner = exactObject(
    await readPrivate(
      join(config.destination.checkoutDirectory, "owned-destination.json"),
    ),
    ["project", "containerId", "volumeName", "nonce"],
  );
  if (
    owner.project !== config.destination.project ||
    owner.containerId !== config.destination.containerId ||
    owner.volumeName !== config.destination.volumeName ||
    owner.nonce !== config.nonce
  )
    throw new Error("Inspection destination differs from creation receipt.");
  const item = await container(config.destination.containerId);
  if (item.Config.Labels["org.datapad.restore.owner"] !== config.nonce)
    throw new Error("Inspection container owner mismatch.");
  await verifyDatabase(config.destination, false);
  const reference = referenceManifest(await readPrivate(config.referencePath));
  if (digest(reference) !== config.referenceHash)
    throw new Error("Source snapshot reference digest mismatch.");
  const graph = await inspectionGraph();
  const directory = await freshDirectory(output);
  const client = await connect(config.destination.databaseUrl);
  try {
    const role = await client.query(
      `SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=current_user`,
    );
    const privileges = role.rows[0];
    if (
      !privileges ||
      Object.values(privileges).some(Boolean) ||
      !decodeURIComponent(
        new URL(config.destination.databaseUrl).username,
      ).startsWith("inspect_")
    )
      throw new Error("Restricted inspection login required.");
    const memberships = await client.query(
      "SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=current_user) LIMIT 1",
    );
    if (memberships.rowCount)
      throw new Error("Inspection role inherits authority.");
    const target = await client.query<{
      schema: string;
      table: string;
      column: string;
    }>(`SELECT n.nspname AS schema,c.relname AS table,a.attname AS column FROM pg_class c
      JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped AND a.attgenerated=''
      WHERE n.nspname <> 'information_schema' AND n.nspname !~ '^pg_' AND c.relkind='r' ORDER BY n.nspname,c.relname,a.attnum LIMIT 1`);
    if (!target.rows.length)
      throw new Error("A restored table is required for permission proof.");
    await client.query("BEGIN READ WRITE");
    let denied = false;
    try {
      const table = target.rows[0];
      await client.query(
        `UPDATE ${qualified(table.schema, table.table)} SET ${identifier(table.column)}=${identifier(table.column)} WHERE false`,
      );
    } catch (error) {
      denied =
        error instanceof Error && "code" in error && error.code === "42501";
      if (!denied) throw error;
    } finally {
      await client.query("ROLLBACK");
    }
    if (!denied)
      throw new Error("Inspection role unexpectedly permits writes.");
    await beginRead(client);
    const before = await captureManifest(client);
    await client.query("COMMIT");
    if (digest(before) !== config.referenceHash)
      throw new Error("Restored data differs from source snapshot.");
    const report = htmlReport(before, graph.hash);
    await beginRead(client);
    const after = await captureManifest(client);
    await client.query("COMMIT");
    if (digest(after) !== digest(before))
      throw new Error("Inspection changed restored data.");
    await writePrivate(join(directory, "report.html"), report);
    await writePrivate(join(directory, "inspection-manifest.json"), {
      version: 1,
      inspectionId: randomUUID(),
      inspectedAt: new Date().toISOString(),
      referenceHash: config.referenceHash,
      before,
      after,
      writeDenied: true,
      graph,
      transportsInvoked: false,
      authority: "operator-filesystem-and-source-database",
      effectsEnabled: false,
    });
    return {
      dataHash: after.dataHash,
      schemaHash: after.schemaHash,
      graphHash: graph.hash,
    };
  } finally {
    await client.end();
  }
}
