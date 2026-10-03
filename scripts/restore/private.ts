import { lstat, mkdir, open, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import canonicalize from "canonicalize";

export function digest(value: unknown): string {
  return createHash("sha256").update(canonicalize(value)!).digest("hex");
}

export async function noSymlinks(path: string) {
  if (!isAbsolute(path) || resolve(path) !== path)
    throw new Error("Canonical absolute path required.");
  let current = path;
  for (;;) {
    if ((await lstat(current)).isSymbolicLink())
      throw new Error("Symlink path rejected.");
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

async function outsideGit(path: string) {
  let current = resolve(path);
  for (;;) {
    try {
      await lstat(join(current, ".git"));
      throw new Error("Private evidence must be outside Git.");
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ENOENT")
      )
        throw error;
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

export async function privatePath(path: string, directory: boolean) {
  if (!isAbsolute(path) || resolve(path) !== path)
    throw new Error("Canonical absolute private path required.");
  await noSymlinks(path);
  await outsideGit(directory ? path : dirname(path));
  const info = await lstat(path);
  if (
    info.uid !== process.getuid?.() ||
    (info.mode & 0o777) !== (directory ? 0o700 : 0o600) ||
    (directory ? !info.isDirectory() : !info.isFile())
  )
    throw new Error("Owner-only private path required.");
  if (!directory) {
    const parent = await lstat(dirname(path));
    if (parent.uid !== process.getuid?.() || (parent.mode & 0o777) !== 0o700)
      throw new Error("Owner-only parent required.");
  }
}

export async function freshDirectory(path: string) {
  if (!isAbsolute(path) || resolve(path) !== path)
    throw new Error("Canonical absolute output path required.");
  await noSymlinks(dirname(path));
  await outsideGit(dirname(path));
  await mkdir(path, { mode: 0o700 });
  await privatePath(path, true);
  return path;
}

export async function readPrivate(path: string): Promise<unknown> {
  await privatePath(path, false);
  const info = await lstat(path);
  if (info.size > 16 * 1024 * 1024)
    throw new Error("Private JSON exceeds bounded size.");
  return JSON.parse(await readFile(path, "utf8"));
}

export async function writePrivate(path: string, value: unknown) {
  await privatePath(dirname(path), true);
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(
      typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n",
    );
    await file.sync();
  } finally {
    await file.close();
  }
}

export function exactObject(
  value: unknown,
  keys: string[],
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== [...keys].sort().join(",")
  )
    throw new Error("Invalid strict restore configuration.");
  return value as Record<string, unknown>;
}

export function textField(value: unknown): string {
  if (typeof value !== "string" || !value || value.includes("\0"))
    throw new Error("Invalid restore field.");
  return value;
}

export async function command(
  args: string[],
  options: {
    env?: Record<string, string>;
    stdin?: number;
    stdout?: number;
    rejectDiagnostics?: boolean;
  } = {},
) {
  const child = Bun.spawn(args, {
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      DOCKER_HOST: process.env.DOCKER_HOST,
      ...options.env,
    },
    stdin: options.stdin ?? "ignore",
    stdout: options.stdout ?? "pipe",
    stderr: "pipe",
  });
  const [output, errors, code] = await Promise.all([
    typeof child.stdout === "number"
      ? Promise.resolve("")
      : new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  // Tool diagnostics can contain copied records or credentials. Never forward them.
  if (
    code !== 0 ||
    ((options.stdout !== undefined || options.rejectDiagnostics) &&
      errors.trim())
  )
    throw new Error("Restore tool failed or archive warning observed.");
  return output.trim();
}
