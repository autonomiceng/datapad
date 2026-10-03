import { open } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { command, privatePath } from "./private";
import {
  databaseUrl,
  verifyDatabase,
  type DatabaseIdentity,
} from "./ownership";

export async function archiveDigest(path: string) {
  await privatePath(path, false);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function dumpSnapshot(
  identity: DatabaseIdentity,
  snapshot: string,
  path: string,
) {
  await verifyDatabase(identity);
  const url = databaseUrl(identity.databaseUrl);
  const file = await open(path, "wx", 0o600);
  try {
    await command(
      [
        "docker",
        "exec",
        "--env",
        "PGPASSWORD",
        identity.containerId,
        "pg_dump",
        "--host=127.0.0.1",
        `--username=${decodeURIComponent(url.username)}`,
        `--dbname=${url.pathname.slice(1)}`,
        "--format=custom",
        `--snapshot=${snapshot}`,
      ],
      {
        env: { PGPASSWORD: decodeURIComponent(url.password) },
        stdout: file.fd,
      },
    );
    await file.sync();
  } finally {
    await file.close();
  }
  // Hash bytes without loading or exposing copied records.
  return archiveDigest(path);
}
export async function restoreArchive(identity: DatabaseIdentity, path: string) {
  await verifyDatabase(identity);
  await privatePath(path, false);
  const url = databaseUrl(identity.databaseUrl);
  const file = await open(path, "r");
  try {
    await command(
      [
        "docker",
        "exec",
        "--interactive",
        "--env",
        "PGPASSWORD",
        identity.containerId,
        "pg_restore",
        "--host=127.0.0.1",
        `--username=${decodeURIComponent(url.username)}`,
        `--dbname=${url.pathname.slice(1)}`,
        "--no-owner",
        "--no-privileges",
        "--single-transaction",
        "--exit-on-error",
      ],
      { env: { PGPASSWORD: decodeURIComponent(url.password) }, stdin: file.fd },
    );
  } finally {
    await file.close();
  }
}
