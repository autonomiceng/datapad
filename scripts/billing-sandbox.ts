import {
  lstat,
  mkdir,
  readFile,
  realpath,
  writeFile,
  rm,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createServer } from "node:net";
import { outsideGit, readConfig } from "./billing-proof/store";
import { demoInvoice } from "../src/server/billing-demo";

async function privatePath(path: string, directory: boolean) {
  const info = await lstat(path);
  if (
    info.isSymbolicLink() ||
    (directory ? !info.isDirectory() : !info.isFile()) ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o077) !== 0
  )
    throw new Error(
      "Sandbox paths must be owner-only regular files or directories.",
    );
}

export async function openSandbox(configPath: string, runPath: string) {
  const key = await readConfig(configPath);
  const directory = resolve(runPath);
  await outsideGit(await realpath(dirname(directory)));
  await mkdir(directory, { mode: 0o700 }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    },
  );
  await privatePath(directory, true);
  await outsideGit(await realpath(directory));
  const lock = join(directory, "sandbox.lock");
  const nonce = crypto.randomUUID();
  await writeFile(lock, JSON.stringify({ pid: process.pid, nonce }), {
    flag: "wx",
    mode: 0o600,
  });
  const release = async () => {
    const owner = JSON.parse(await readFile(lock, "utf8"));
    if (owner.nonce === nonce) await rm(lock);
  };
  try {
    const path = join(directory, "sandbox.json");
    try {
      await writeFile(
        path,
        JSON.stringify({
          deploymentKey: crypto.randomUUID(),
          issueDate: new Date().toISOString().slice(0, 10),
        }),
        { flag: "wx", mode: 0o600 },
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    await privatePath(path, false);
    const state: unknown = JSON.parse(await readFile(path, "utf8"));
    if (
      !state ||
      typeof state !== "object" ||
      !("deploymentKey" in state) ||
      !("issueDate" in state) ||
      typeof state.deploymentKey !== "string" ||
      typeof state.issueDate !== "string" ||
      Object.keys(state).sort().join(",") !== "deploymentKey,issueDate" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        state.deploymentKey,
      )
    )
      throw new Error("Sandbox state is invalid.");
    demoInvoice(state.issueDate);
    return {
      directory,
      key,
      deploymentKey: state.deploymentKey,
      issueDate: state.issueDate,
      release,
    };
  } catch (error) {
    await release();
    throw error;
  }
}

export async function availableLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Unable to allocate local port.");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}
