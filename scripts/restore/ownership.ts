import { createHash } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import {
  command,
  digest,
  exactObject,
  noSymlinks,
  privatePath,
  readPrivate,
  textField,
} from "./private";

export interface DatabaseIdentity {
  project: string;
  composeFile: string;
  checkoutDirectory: string;
  containerId: string;
  volumeName: string;
  databaseUrl: string;
}
export interface SourceConfig {
  version: 1;
  purpose: "owned-synthetic-portal";
  source: DatabaseIdentity & {
    runDirectory: string;
    deploymentKey: string;
    revision: string;
  };
}
interface Container {
  Id: string;
  Config: { Image: string; Env: string[]; Labels: Record<string, string> };
  State: { Running: boolean };
  Mounts: { Type: string; Name: string; Destination: string }[];
  NetworkSettings: {
    Ports: Record<string, { HostIp: string; HostPort: string }[] | null>;
  };
}
export function sourceProject(runDirectory: string) {
  return `datapad-portal-billing-${createHash("sha256").update(runDirectory).digest("hex").slice(0, 12)}`;
}
export function databaseUrl(value: unknown) {
  const url = new URL(textField(value));
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    !url.username ||
    !url.password ||
    url.search ||
    url.hash ||
    !/^\/[a-zA-Z0-9_]+$/.test(url.pathname)
  )
    throw new Error("Only explicit loopback database credentials accepted.");
  return url;
}
export async function container(id: string): Promise<Container> {
  if (!/^[0-9a-f]{64}$/.test(id))
    throw new Error("Invalid owned container identity.");
  const result: Container[] = JSON.parse(
    await command(["docker", "inspect", id]),
  );
  if (result.length !== 1 || result[0].Id !== id)
    throw new Error("Container identity changed.");
  return result[0];
}
export async function verifyDatabase(
  identity: DatabaseIdentity,
  verifyLogin = true,
) {
  const item = await container(identity.containerId);
  const labels = item.Config.Labels;
  const url = databaseUrl(identity.databaseUrl);
  const env = Object.fromEntries(
    item.Config.Env.map((entry) => {
      const i = entry.indexOf("=");
      return [entry.slice(0, i), entry.slice(i + 1)];
    }),
  );
  const ports = item.NetworkSettings.Ports["5432/tcp"];
  if (
    item.Config.Image !== "postgres:18.6" ||
    !item.State.Running ||
    labels["com.docker.compose.project"] !== identity.project ||
    labels["com.docker.compose.service"] !== "db" ||
    labels["com.docker.compose.project.config_files"] !==
      identity.composeFile ||
    labels["com.docker.compose.project.working_dir"] !==
      identity.checkoutDirectory ||
    ports?.length !== 1 ||
    ports[0].HostIp !== "127.0.0.1" ||
    ports[0].HostPort !== url.port ||
    env.POSTGRES_DB !== url.pathname.slice(1) ||
    (verifyLogin &&
      (env.POSTGRES_USER !== decodeURIComponent(url.username) ||
        env.POSTGRES_PASSWORD !== decodeURIComponent(url.password))) ||
    !item.Mounts.some(
      (mount) =>
        mount.Type === "volume" &&
        mount.Name === identity.volumeName &&
        mount.Destination === "/var/lib/postgresql",
    )
  )
    throw new Error("Owned database identity verification failed.");
  const volumes: { Name: string; Labels: Record<string, string> }[] =
    JSON.parse(
      await command(["docker", "volume", "inspect", identity.volumeName]),
    );
  if (
    volumes.length !== 1 ||
    volumes[0].Name !== identity.volumeName ||
    volumes[0].Labels["com.docker.compose.project"] !== identity.project
  )
    throw new Error("Owned database volume verification failed.");
  return digest({
    containerId: item.Id,
    volume: identity.volumeName,
    project: identity.project,
  });
}
export async function readSourceConfig(path: string): Promise<SourceConfig> {
  const top = exactObject(await readPrivate(path), [
    "version",
    "purpose",
    "source",
  ]);
  if (top.version !== 1 || top.purpose !== "owned-synthetic-portal")
    throw new Error("Owned synthetic scope required.");
  const raw = exactObject(top.source, [
    "runDirectory",
    "composeProject",
    "composeFile",
    "checkoutDirectory",
    "databaseUrl",
    "deploymentKey",
    "revision",
  ]);
  const runDirectory = textField(raw.runDirectory),
    checkoutDirectory = textField(raw.checkoutDirectory),
    composeFile = textField(raw.composeFile);
  for (const path of [runDirectory, checkoutDirectory, composeFile]) {
    if (!isAbsolute(path) || resolve(path) !== path)
      throw new Error("Canonical absolute paths required.");
    await noSymlinks(path);
  }
  await privatePath(runDirectory, true);
  const saved = exactObject(
    await readPrivate(join(runDirectory, "sandbox.json")),
    ["deploymentKey", "issueDate"],
  );
  const deploymentKey = textField(raw.deploymentKey),
    revision = textField(raw.revision);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      deploymentKey,
    ) ||
    saved.deploymentKey !== deploymentKey ||
    typeof saved.issueDate !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(saved.issueDate) ||
    !/^[0-9a-f]{40}$/.test(revision) ||
    (await command(["git", "-C", checkoutDirectory, "rev-parse", "HEAD"])) !==
      revision ||
    composeFile !== join(checkoutDirectory, "compose.yaml") ||
    raw.composeProject !== sourceProject(runDirectory)
  )
    throw new Error("Synthetic source provenance mismatch.");
  const url = databaseUrl(raw.databaseUrl);
  const project = sourceProject(runDirectory);
  const ids = (
    await command([
      "docker",
      "ps",
      "--no-trunc",
      "--quiet",
      "--filter",
      `label=com.docker.compose.project=${project}`,
      "--filter",
      "label=com.docker.compose.service=db",
    ])
  )
    .split(/\s+/)
    .filter(Boolean);
  if (ids.length !== 1)
    throw new Error("Exactly one owned source database required.");
  const item = await container(ids[0]);
  const volume = item.Mounts.filter(
    (mount) =>
      mount.Type === "volume" && mount.Destination === "/var/lib/postgresql",
  );
  if (volume.length !== 1) throw new Error("Owned source volume required.");
  const source = {
    project,
    composeFile,
    checkoutDirectory,
    containerId: ids[0],
    volumeName: volume[0].Name,
    databaseUrl: url.toString(),
    runDirectory,
    deploymentKey,
    revision,
  };
  await verifyDatabase(source);
  return { version: 1, purpose: "owned-synthetic-portal", source };
}
