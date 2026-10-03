import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { command, digest, writePrivate } from "./private";
import { container, verifyDatabase, type DatabaseIdentity } from "./ownership";
import { connect, identifier, literal, userSchemas } from "./database";

export interface OwnedDestination {
  identity: DatabaseIdentity;
  nonce: string;
  destroy(): Promise<void>;
}
export async function createDestination(
  directory: string,
): Promise<OwnedDestination> {
  const nonce = randomUUID();
  const project = `datapad-restore-${nonce}`;
  const volumeName = `${project}-database`;
  const user = `owner_${nonce.replaceAll("-", "")}`;
  const password = randomUUID() + randomUUID();
  const database = `restore_${nonce.replaceAll("-", "")}`;
  const composeFile = join(directory, "destination-compose.json");
  await writePrivate(composeFile, {
    services: {
      db: {
        image: "postgres:18.6",
        network_mode: "bridge",
        environment: {
          POSTGRES_USER: user,
          POSTGRES_PASSWORD: password,
          POSTGRES_DB: database,
        },
        labels: { "org.datapad.restore.owner": nonce },
        ports: [{ target: 5432, host_ip: "127.0.0.1", protocol: "tcp" }],
        volumes: [
          { type: "volume", source: "database", target: "/var/lib/postgresql" },
        ],
      },
    },
    volumes: { database: { external: true, name: volumeName } },
  });
  let volumeCreated = false;
  let containerId: string | undefined;
  const destroy = async () => {
    if (containerId) {
      const item = await container(containerId);
      if (
        item.Config.Labels["org.datapad.restore.owner"] !== nonce ||
        item.Config.Labels["com.docker.compose.project"] !== project ||
        item.Config.Labels["com.docker.compose.project.config_files"] !==
          composeFile ||
        item.Config.Labels["com.docker.compose.project.working_dir"] !==
          directory ||
        !item.Mounts.some((mount) => mount.Name === volumeName)
      )
        throw new Error("Owned teardown identity mismatch.");
      await command(["docker", "rm", "--force", containerId]);
      containerId = undefined;
    }
    if (volumeCreated) {
      const volume: { Labels: Record<string, string> }[] = JSON.parse(
        await command(["docker", "volume", "inspect", volumeName]),
      );
      if (
        volume.length !== 1 ||
        volume[0].Labels["org.datapad.restore.owner"] !== nonce ||
        volume[0].Labels["com.docker.compose.project"] !== project
      )
        throw new Error("Owned teardown volume mismatch.");
      await command(["docker", "volume", "rm", volumeName]);
      volumeCreated = false;
    }
  };
  try {
    await command([
      "docker",
      "volume",
      "create",
      "--label",
      `org.datapad.restore.owner=${nonce}`,
      "--label",
      `com.docker.compose.project=${project}`,
      volumeName,
    ]);
    volumeCreated = true;
    await command([
      "docker",
      "compose",
      "--project-directory",
      directory,
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
        "--no-trunc",
        "--quiet",
        "--filter",
        `label=com.docker.compose.project=${project}`,
        "--filter",
        `label=org.datapad.restore.owner=${nonce}`,
      ])
    )
      .split(/\s+/)
      .filter(Boolean);
    if (ids.length !== 1)
      throw new Error("Fresh destination identity unavailable.");
    containerId = ids[0];
    await writePrivate(join(directory, "owned-destination.json"), {
      project,
      containerId,
      volumeName,
      nonce,
    });
    const created = await container(containerId);
    if (
      created.Config.Labels["org.datapad.restore.owner"] !== nonce ||
      created.Config.Labels["com.docker.compose.project"] !== project ||
      created.Config.Labels["com.docker.compose.project.config_files"] !==
        composeFile ||
      created.Config.Labels["com.docker.compose.project.working_dir"] !==
        directory
    )
      throw new Error("Fresh destination creation mismatch.");
    await command(["docker", "start", containerId]);
    const item = await container(containerId);
    const ports = item.NetworkSettings.Ports["5432/tcp"];
    if (ports?.length !== 1 || ports[0].HostIp !== "127.0.0.1")
      throw new Error("Destination loopback binding required.");
    const identity: DatabaseIdentity = {
      project,
      composeFile,
      checkoutDirectory: directory,
      containerId,
      volumeName,
      databaseUrl: `postgres://${user}:${password}@127.0.0.1:${ports[0].HostPort}/${database}`,
    };
    await verifyDatabase(identity);
    for (let attempt = 0; ; attempt++) {
      try {
        await command([
          "docker",
          "exec",
          identity.containerId,
          "pg_isready",
          "--host=127.0.0.1",
          `--username=${user}`,
          `--dbname=${database}`,
        ]);
      } catch {
        if (attempt >= 60) throw new Error("Destination startup timed out.");
        await new Promise((done) => setTimeout(done, 500));
        continue;
      }
      try {
        const client = await connect(identity.databaseUrl);
        try {
          const tables = await client.query(
            "SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname <> 'information_schema' AND n.nspname !~ '^pg_' AND c.relkind IN ('r','p','m') LIMIT 1",
          );
          if (tables.rowCount) throw new Error("Destination is not empty.");
          const system = await client.query(
            "SELECT system_identifier::text AS id FROM pg_control_system()",
          );
          await writePrivate(
            join(directory, "destination-database-identity.json"),
            { identityHash: digest(system.rows[0].id) },
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
    return { identity, nonce, destroy };
  } catch (error) {
    await destroy();
    throw error;
  }
}

export async function createInspectionLogin(identity: DatabaseIdentity) {
  await verifyDatabase(identity);
  const role = `inspect_${randomUUID().replaceAll("-", "")}`;
  const password = randomUUID() + randomUUID();
  const client = await connect(identity.databaseUrl);
  try {
    await client.query("BEGIN");
    await client.query(
      `CREATE ROLE ${identifier(role)} LOGIN PASSWORD ${literal(password)} NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT`,
    );
    await client.query(
      `ALTER ROLE ${identifier(role)} SET default_transaction_read_only = on`,
    );
    const db = new URL(identity.databaseUrl).pathname.slice(1);
    await client.query(`REVOKE ALL ON DATABASE ${identifier(db)} FROM PUBLIC`);
    await client.query(
      `GRANT CONNECT ON DATABASE ${identifier(db)} TO ${identifier(role)}`,
    );
    for (const schema of await userSchemas(client)) {
      const name = identifier(schema);
      await client.query(`REVOKE ALL ON SCHEMA ${name} FROM PUBLIC`);
      await client.query(
        `REVOKE ALL ON ALL TABLES IN SCHEMA ${name} FROM PUBLIC`,
      );
      await client.query(
        `REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${name} FROM PUBLIC`,
      );
      await client.query(
        `REVOKE EXECUTE ON ALL ROUTINES IN SCHEMA ${name} FROM PUBLIC`,
      );
      await client.query(
        `GRANT USAGE ON SCHEMA ${name} TO ${identifier(role)}`,
      );
      await client.query(
        `GRANT SELECT ON ALL TABLES IN SCHEMA ${name} TO ${identifier(role)}`,
      );
      await client.query(
        `GRANT SELECT ON ALL SEQUENCES IN SCHEMA ${name} TO ${identifier(role)}`,
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
  const url = new URL(identity.databaseUrl);
  url.username = role;
  url.password = password;
  return { ...identity, databaseUrl: url.toString() };
}
