import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Type, type TProperties, type TSchema } from "@sinclair/typebox";
import { TypeCompiler } from "@sinclair/typebox/compiler";
import { createManifest, ProofError, type Manifest } from "./core.ts";

const object = <T extends TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
const nullable = <T extends TSchema>(schema: T) =>
  Type.Union([schema, Type.Null()]);
const string = Type.String();
const integer = Type.Integer();
const state = Type.Union([
  Type.Literal("pending"),
  Type.Literal("done"),
  Type.Literal("uncertain"),
]);
const invoiceSchema = object({
  id: string,
  status: nullable(
    Type.Union([
      Type.Literal("draft"),
      Type.Literal("open"),
      Type.Literal("paid"),
      Type.Literal("uncollectible"),
      Type.Literal("void"),
    ]),
  ),
  amountDue: integer,
  amountPaid: integer,
  attemptCount: integer,
  hostedInvoiceUrl: nullable(string),
  invoicePdf: nullable(string),
  dueDate: nullable(integer),
  created: integer,
  finalizedAt: nullable(integer),
  lineCount: integer,
  paymentCount: integer,
  observedAt: integer,
});
const manifestValidator = TypeCompiler.Compile(
  object({
    schemaVersion: Type.Literal(1),
    runId: Type.String({ pattern: "^[0-9a-f-]{36}$" }),
    createdAt: string,
    timezone: Type.Literal("UTC"),
    clock: object({
      id: Type.Optional(string),
      frozenTime: integer,
      status: Type.Optional(string),
    }),
    customers: object({
      manual: Type.Optional(string),
      automatic: Type.Optional(string),
    }),
    groups: Type.Array(
      object({
        id: string,
        customer: Type.Union([
          Type.Literal("manual"),
          Type.Literal("automatic"),
        ]),
        scenario: Type.Union([
          Type.Literal("manual"),
          Type.Literal("automatic"),
          Type.Literal("early"),
          Type.Literal("decline"),
          Type.Literal("authentication"),
          Type.Literal("void"),
          Type.Literal("zero"),
        ]),
        dueDate: string,
        readyDate: string,
        chargeAt: integer,
        lines: Type.Array(
          object({
            id: string,
            description: string,
            amount: Type.Integer({ minimum: 0 }),
          }),
        ),
        invoice: Type.Optional(invoiceSchema),
        action: Type.Optional(string),
      }),
      { minItems: 7, maxItems: 7 },
    ),
    operations: Type.Record(
      string,
      object({
        id: string,
        kind: string,
        intent: Type.Unknown(),
        state,
        objectId: Type.Optional(string),
        errorCode: Type.Optional(string),
        error: Type.Optional(
          object({
            type: string,
            statusCode: Type.Optional(integer),
            param: Type.Optional(string),
            message: string,
            requestId: Type.Optional(string),
          }),
        ),
      }),
    ),
    events: Type.Array(
      object({
        at: string,
        clockTime: integer,
        kind: string,
        groupId: Type.Optional(string),
        message: string,
      }),
    ),
  }),
);

export async function outsideGit(path: string) {
  let directory = path;
  while (true) {
    try {
      await lstat(join(directory, ".git"));
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        const parent = dirname(directory);
        if (parent === directory) return;
        directory = parent;
        continue;
      }
      throw error;
    }
    throw new ProofError(
      "Private configuration and run directories must be outside every Git checkout.",
    );
  }
}
async function privatePath(path: string, directory: boolean) {
  const info = await lstat(path);
  if (
    info.isSymbolicLink() ||
    (directory ? !info.isDirectory() : !info.isFile()) ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o077) !== 0
  )
    throw new ProofError(
      "Private paths must be owned by the current user, without symlinks or group/other permissions.",
    );
}
export async function readConfig(path: string): Promise<string> {
  const absolute = resolve(path);
  await privatePath(absolute, false);
  const actual = await realpath(absolute);
  await outsideGit(dirname(actual));
  const contents = await readFile(actual, "utf8");
  const lines = contents
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  const match =
    lines.length === 1
      ? /^STRIPE_SECRET_KEY=(sk_test_[A-Za-z0-9]+)$/.exec(lines[0])
      : null;
  if (!match)
    throw new ProofError(
      "Configuration must contain only STRIPE_SECRET_KEY=sk_test_...; shell syntax and live credentials are rejected.",
    );
  return match[1];
}
export async function atomicWrite(
  directory: string,
  filename: "manifest.json" | "report.html",
  content: string,
) {
  const temporary = join(directory, `.${filename}.${crypto.randomUUID()}.tmp`);
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(content, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, join(directory, filename));
  const parent = await open(directory, "r");
  try {
    await parent.sync();
  } finally {
    await parent.close();
  }
}
export async function openRun(path: string) {
  const absolute = resolve(path);
  // Require an existing parent so both lexical and resolved Git ancestry can be checked before writing.
  const parent = await realpath(dirname(absolute));
  await outsideGit(dirname(absolute));
  await outsideGit(parent);
  await mkdir(absolute, { mode: 0o700 }).catch((error) => {
    if (
      !(
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "EEXIST"
      )
    )
      throw error;
  });
  await privatePath(absolute, true);
  const directory = await realpath(absolute);
  await outsideGit(directory);
  const lockPath = join(directory, "run.lock");
  let lock;
  try {
    lock = await open(lockPath, "wx", 0o600);
  } catch {
    throw new ProofError(
      "Run is locked. Verify the recorded PID and command are stopped before manually removing run.lock.",
    );
  }
  const identity = {
    pid: process.pid,
    nonce: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  };
  await lock.writeFile(JSON.stringify(identity));
  await lock.sync();
  await lock.close();
  return {
    directory,
    async read(): Promise<Manifest | undefined> {
      const path = join(directory, "manifest.json");
      try {
        await stat(path);
      } catch (error) {
        if (
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "ENOENT"
        )
          return undefined;
        throw error;
      }
      await privatePath(path, false);
      const manifest: unknown = JSON.parse(await readFile(path, "utf8"));
      if (!manifestValidator.Check(manifest))
        throw new ProofError(
          "Run manifest is invalid; restore or inspect private evidence before proceeding.",
        );
      const expected = createManifest(manifest.groups[0].readyDate);
      for (const [index, group] of manifest.groups.entries()) {
        const { invoice: _invoice, action: _action, ...definition } = group;
        const { action: _expectedAction, ...expectedDefinition } =
          expected.groups[index];
        if (JSON.stringify(definition) !== JSON.stringify(expectedDefinition))
          throw new ProofError(
            "Synthetic scenario definitions changed; stopped for review.",
          );
      }
      return manifest;
    },
    async release() {
      const current: unknown = JSON.parse(await readFile(lockPath, "utf8"));
      if (
        current &&
        typeof current === "object" &&
        "nonce" in current &&
        current.nonce === identity.nonce
      )
        await unlink(lockPath);
    },
  };
}
