import { Client } from "pg";
import { digest } from "./private";
import { databaseUrl } from "./ownership";

export const identifier = (name: string) =>
  '"' + name.replaceAll('"', '""') + '"';
export const literal = (value: string) =>
  "'" + value.replaceAll("'", "''") + "'";
export const qualified = (schema: string, name: string) =>
  `${identifier(schema)}.${identifier(name)}`;
export interface TableManifest {
  schema: string;
  table: string;
  count: number;
  hash: string;
  summary: {
    statuses: Record<string, number>;
    amounts: Record<string, string>;
    receipts: Record<string, number>;
  };
}
export interface DataManifest {
  version: 1;
  schemaHash: string;
  dataHash: string;
  tables: TableManifest[];
  pausedObserved: boolean[];
}
export async function connect(url: string) {
  databaseUrl(url);
  const client = new Client({
    connectionString: url,
    connectionTimeoutMillis: 10_000,
    application_name: "synthetic-restore-inspection",
  });
  try {
    await client.connect();
  } catch (error) {
    await client.end();
    throw error;
  }
  return client;
}
export async function beginRead(client: Client) {
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  await client.query("SET LOCAL timezone = 'UTC'");
  await client.query("SET LOCAL datestyle = 'ISO, YMD'");
  await client.query("SET LOCAL intervalstyle = 'postgres'");
  await client.query("SET LOCAL statement_timeout = '60s'");
  await client.query("SET LOCAL search_path = pg_catalog");
}
export async function exportSnapshot(client: Client) {
  await beginRead(client);
  const result = await client.query<{ snapshot: string }>(
    "SELECT pg_export_snapshot() AS snapshot",
  );
  if (!/^[0-9A-F-]+$/.test(result.rows[0].snapshot))
    throw new Error("Invalid exported snapshot.");
  return result.rows[0].snapshot;
}

const schemasSql =
  "SELECT nspname AS schema FROM pg_namespace WHERE nspname <> 'information_schema' AND nspname !~ '^pg_' ORDER BY nspname";
export async function userSchemas(client: Client) {
  return (await client.query<{ schema: string }>(schemasSql)).rows.map(
    (row) => row.schema,
  );
}
const acceptedStatus = new Set([
  "active",
  "revoked",
  "invited",
  "pending",
  "attempted",
  "sending",
  "sent",
  "uncertain",
  "failed",
  "needs_review",
  "draft",
  "open",
  "paid",
  "void",
  "uncollectible",
  "confirmed",
  "cancelled",
  "paused",
  "billable",
  "enabled",
  "disabled",
  "complete",
  "completed",
  "retry",
  "created",
  "expired",
]);

export async function captureManifest(
  client: Client,
  deploymentKey?: string,
): Promise<DataManifest> {
  const tables = (
    await client.query<{ schema: string; table: string; kind: string }>(`
    SELECT n.nspname AS schema, c.relname AS table, c.relkind AS kind FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname <> 'information_schema' AND n.nspname !~ '^pg_' AND c.relkind IN ('r','p','m')
    ORDER BY n.nspname,c.relname`)
  ).rows;
  const definitions = (
    await client.query(`
    SELECT n.nspname AS schema,c.relname AS name,c.relkind AS kind,a.attname AS column,
      format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull AS required,
      pg_get_expr(d.adbin,d.adrelid) AS default,a.attidentity AS identity,a.attgenerated AS generated
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    LEFT JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
    LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
    WHERE n.nspname <> 'information_schema' AND n.nspname !~ '^pg_' AND c.relkind IN ('r','p','m','v','S')
    ORDER BY n.nspname,c.relname,a.attnum`)
  ).rows;
  const constraints = (
    await client.query(`SELECT n.nspname AS schema,c.relname AS table,k.conname AS name,
    pg_get_constraintdef(k.oid,true) AS definition FROM pg_constraint k
    JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname <> 'information_schema' AND n.nspname !~ '^pg_' ORDER BY n.nspname,c.relname,k.conname`)
  ).rows;
  const indexes = (
    await client.query(
      "SELECT schemaname,tablename,indexname,indexdef FROM pg_indexes WHERE schemaname <> 'information_schema' AND schemaname !~ '^pg_' ORDER BY schemaname,tablename,indexname",
    )
  ).rows;
  const manifests: TableManifest[] = [];
  const pausedObserved: boolean[] = [];
  for (const table of tables) {
    const columns = (
      await client.query<{ name: string }>(
        `SELECT attname AS name FROM pg_attribute
      WHERE attrelid=$1::regclass AND attnum>0 AND NOT attisdropped ORDER BY attnum`,
        [qualified(table.schema, table.table)],
      )
    ).rows.map((row) => row.name);
    if (columns.length > 1000)
      throw new Error("Synthetic table exceeds column bound.");
    // VALUES avoids PostgreSQL's function-argument limit on wide auth/job/domain tables.
    const fields = columns
      .map(
        (name) =>
          `(${literal(name)}, restore_record.${identifier(name)}::text)`,
      )
      .join(",");
    const projection = columns.length
      ? `(SELECT jsonb_object_agg(name,value) FROM (VALUES ${fields}) AS restore_fields(name,value))`
      : "'{}'::jsonb";
    const relation = qualified(table.schema, table.table);
    if (deploymentKey && columns.includes("deployment_key")) {
      const foreign = await client.query(
        `SELECT 1 FROM ONLY ${relation} WHERE deployment_key IS NOT NULL AND deployment_key <> $1 LIMIT 1`,
        [deploymentKey],
      );
      if (foreign.rowCount)
        throw new Error("Foreign deployment in synthetic source.");
    }
    const summary: TableManifest["summary"] = {
      statuses: {},
      amounts: {},
      receipts: {},
    };
    const hashes: string[] = [];
    await client.query(
      `DECLARE restore_rows NO SCROLL CURSOR FOR SELECT ${projection} AS row FROM ONLY ${relation} AS restore_record`,
    );
    try {
      for (;;) {
        const result = await client.query<{
          row: Record<string, string | null>;
        }>("FETCH 500 FROM restore_rows");
        if (!result.rows.length) break;
        for (const { row } of result.rows) {
          hashes.push(digest(row));
          if (hashes.length > 1_000_000)
            throw new Error("Synthetic table exceeds row bound.");
          for (const [key, value] of Object.entries(row)) {
            if (
              (key === "status" || key === "state") &&
              value &&
              acceptedStatus.has(value)
            )
              summary.statuses[value] = (summary.statuses[value] ?? 0) + 1;
            if (
              /^(amount_minor|total_minor|amount_paid_minor|amount_due_minor)$/.test(
                key,
              ) &&
              value &&
              /^-?\d+$/.test(value)
            ) {
              const currency =
                row.currency && /^[A-Z]{3}$/.test(row.currency)
                  ? row.currency
                  : "currency unavailable";
              const amountKey = `${key} (${currency})`;
              summary.amounts[amountKey] = (
                BigInt(summary.amounts[amountKey] ?? "0") + BigInt(value)
              ).toString();
            }
            if (
              /^(provider_id|provider_customer_id|provider_invoice_id|create_attempted_at|finalize_attempted_at|attempted_at|response_at|revoked_at|consented_at)$/.test(
                key,
              ) &&
              value !== null
            )
              summary.receipts[key] = (summary.receipts[key] ?? 0) + 1;
          }
          if (
            table.table === "billing_effect_controls" &&
            (row.paused === "true" || row.paused === "false")
          )
            pausedObserved.push(row.paused === "true");
        }
      }
    } finally {
      await client.query("CLOSE restore_rows");
    }
    hashes.sort();
    manifests.push({
      schema: table.schema,
      table: table.table,
      count: hashes.length,
      hash: digest(hashes),
      summary,
    });
  }
  const schemaHash = digest({ definitions, constraints, indexes });
  return {
    version: 1,
    schemaHash,
    dataHash: digest(manifests),
    tables: manifests,
    pausedObserved: pausedObserved.sort((a, b) => Number(a) - Number(b)),
  };
}
