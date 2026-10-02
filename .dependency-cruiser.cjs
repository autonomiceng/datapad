const web = "^(src/web/|tests/architecture/)";
module.exports = {
  forbidden: [
    { name: "no-cycles", severity: "error", from: {}, to: { circular: true } },
    {
      name: "resolved-imports",
      severity: "error",
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: "web-no-server",
      severity: "error",
      from: { path: web },
      to: {
        path: "^src/(server|import-review)/",
        pathNot: "^src/import-review/contract\\.ts$",
      },
    },
    {
      name: "web-no-runtime",
      severity: "error",
      from: { path: web },
      to: { dependencyTypes: ["core"], pathNot: "^$" },
    },
    {
      name: "web-no-sql",
      severity: "error",
      from: { path: web },
      to: {
        path: "(^|/)(pg|pg-pool|pg-protocol|drizzle-orm|elysia|@elysia)(/|$)",
      },
    },
    {
      name: "import-review-private",
      severity: "error",
      from: { pathNot: "^(src/import-review/|drizzle\\.config\\.ts$)" },
      to: { path: "^src/import-review/internal/" },
    },
    {
      name: "http-no-sql",
      severity: "error",
      from: { path: "^src/server/app\\.ts$" },
      to: {
        path: "(src/import-review/internal/|src/server/db/|node_modules/(pg|drizzle-orm)/)",
      },
    },
    {
      name: "import-review-no-adapters",
      severity: "error",
      from: { path: "^src/import-review/" },
      to: { path: "^(src/(server|web)/|scripts/)" },
    },
    {
      name: "pure-no-persistence",
      severity: "error",
      from: {
        path: "^src/import-review/internal/(validate|observations|digest)\\.ts$",
      },
      to: {
        path: "(src/import-review/internal/(schema|queries|import)\\.ts$|node_modules/(pg|drizzle-orm)/)",
      },
    },
    {
      name: "contract-browser-safe",
      severity: "error",
      from: { path: "^src/import-review/contract\\.ts$" },
      to: { path: "^src/", pathNot: "^src/import-review/contract\\.ts$" },
    },
    {
      name: "contract-no-node",
      severity: "error",
      from: { path: "^src/import-review/contract\\.ts$" },
      to: { dependencyTypes: ["core"] },
    },
    {
      name: "production-no-tests",
      severity: "error",
      from: { path: "^src/" },
      to: { path: "^(tests|fixtures)/" },
    },
    {
      name: "production-no-dev-deps",
      severity: "error",
      from: { path: "^src/" },
      to: { dependencyTypes: ["npm-dev"], dependencyTypesNot: ["type-only"] },
    },
    {
      name: "entrypoints-stay-roots",
      severity: "error",
      from: { path: "^src/" },
      to: { path: "^(scripts/|src/server/index\\.ts$)" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    parser: "swc",
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.json" },
    enhancedResolveOptions: {
      conditionNames: ["import", "types", "default"],
      exportsFields: ["exports"],
    },
  },
};
