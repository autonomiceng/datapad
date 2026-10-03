import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const contractPath = "src/access/types.ts";
const fixtures = [
  {
    path: "src/notifications/internal/notices.ts",
    source: "export function createInvoiceNotices() {}",
    rule: "require-jsdoc",
  },
  {
    path: contractPath,
    source: "export interface Example { read(): Promise<void>; }",
    rule: "require-jsdoc",
  },
  {
    path: contractPath,
    source: "function read() {}\nexport { read };",
    rule: "require-jsdoc",
  },
  {
    path: contractPath,
    source: "/** @public */\nexport function example() {}",
    rule: "require-description",
  },
  {
    path: contractPath,
    source:
      "export interface Example {\n/** Reads the current account without provider requests. */\nread(): Promise<void>;\n}",
    rule: null,
  },
  {
    path: "src/billing/internal/workflow.ts",
    source: "export function createBillingWorkflow() {}",
    rule: "require-jsdoc",
  },
  {
    path: contractPath,
    source: "function helper() {}\nhelper();\nexport {};",
    rule: null,
  },
  {
    path: "src/billing/internal/workflow.ts",
    source: "export function helper() {}",
    rule: null,
  },
];

const workspace = process.cwd();
const directory = await mkdtemp(join(tmpdir(), "datapad-documentation-"));
try {
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({
      name: "documentation-policy-fixture",
      private: true,
      type: "module",
    }),
  );
  await symlink(
    resolve(workspace, "vite.config.ts"),
    join(directory, "vite.config.ts"),
  );
  await symlink(
    resolve(workspace, "node_modules"),
    join(directory, "node_modules"),
  );
  for (const folder of [
    "src/access",
    "src/billing/internal",
    "src/notifications/internal",
    "tests",
  ])
    await mkdir(join(directory, folder), { recursive: true });
  for (const fixture of fixtures) {
    await writeFile(join(directory, fixture.path), fixture.source);
    const child = Bun.spawn(["./node_modules/.bin/vp", "lint", fixture.path], {
      cwd: directory,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    const output = stdout + stderr;
    if (
      fixture.rule
        ? code !== 1 || !output.includes(`jsdoc-js(${fixture.rule})`)
        : code !== 0
    ) {
      throw new Error(`Documentation safeguard failed:\n${output}`);
    }
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
console.log("Documentation requirements and helper exclusions passed.");
