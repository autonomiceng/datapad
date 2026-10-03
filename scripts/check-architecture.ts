interface Report {
  summary: {
    violations: { rule: { name: string }; from: string; to: string }[];
  };
}
async function inspect(input: string): Promise<Report> {
  const child = Bun.spawn(
    [
      "./node_modules/.bin/depcruise",
      "--config",
      ".dependency-cruiser.cjs",
      "--output-type",
      "json",
      input,
    ],
    { stdout: "pipe", stderr: "inherit" },
  );
  const output = await new Response(child.stdout).text();
  const code = await child.exited;
  if (code !== 0 && code !== 1) throw new Error("Dependency analysis failed.");
  return JSON.parse(output) as Report;
}
const real = await inspect("src");
const restore = await inspect("scripts/restore");
real.summary.violations.push(...restore.summary.violations);
if (real.summary.violations.length) {
  console.error(real.summary.violations);
  throw new Error("Application imports violate module ownership.");
}
for (const [fixture, rule] of [
  ["tests/architecture/web-pg.ts", "web-no-sql"],
  ["tests/architecture/web-private.ts", "import-review-private"],
  ["tests/architecture/web-billing-private.ts", "billing-private"],
]) {
  const result = await inspect(fixture!);
  if (
    !result.summary.violations.some((violation) => violation.rule.name === rule)
  ) {
    throw new Error(`Architecture safeguard did not reject ${fixture}`);
  }
}
console.log("Application module rules and forbidden-import fixtures passed.");

export {};
