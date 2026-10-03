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
        path: "^src/(server|import-review|billing|stripe|worker|access|customers|services)/",
        pathNot:
          "^src/(import-review|billing|access|customers|services)/contract\\.ts$",
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
        path: "(^|/)(pg|pg-pool|pg-protocol|pg-boss|stripe|drizzle-orm|elysia|@elysia|better-auth|@better-auth|nodemailer)(/|$)",
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
      from: {
        path: "^src/server/(app|billing-routes|account-routes|service-routes|invoice-workflow-routes|portal-app)\\.ts$",
      },
      to: {
        path: "(src/(import-review|billing|access|customers|services)/internal/|src/server/db/|node_modules/(pg|drizzle-orm)/)",
      },
    },
    {
      name: "import-review-no-adapters",
      severity: "error",
      from: { path: "^src/import-review/" },
      to: {
        path: "^(src/(server|web|billing|stripe|worker|services)/|scripts/)",
      },
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
      from: {
        path: "^src/(import-review|billing|access|customers|services)/contract\\.ts$",
      },
      to: {
        path: "^src/",
        pathNot:
          "^src/(import-review|billing|access|customers|services)/contract\\.ts$",
      },
    },
    {
      name: "contract-no-node",
      severity: "error",
      from: {
        path: "^src/(import-review|billing|access|customers|services)/contract\\.ts$",
      },
      to: { dependencyTypes: ["core"] },
    },
    {
      name: "billing-private",
      severity: "error",
      from: { pathNot: "^(src/billing/|drizzle\\.config\\.ts$)" },
      to: { path: "^src/billing/internal/" },
    },
    {
      name: "billing-no-adapters",
      severity: "error",
      from: { path: "^src/billing/" },
      to: {
        path: "^(src/(server|web|stripe|worker|import-review)/|scripts/|node_modules/(stripe|pg-boss)/)",
      },
    },
    {
      name: "access-private",
      severity: "error",
      from: { pathNot: "^(src/access/|drizzle\\.config\\.ts$)" },
      to: { path: "^src/access/internal/" },
    },
    {
      name: "customers-private",
      severity: "error",
      from: { pathNot: "^(src/customers/|drizzle\\.config\\.ts$)" },
      to: { path: "^src/customers/internal/" },
    },
    {
      name: "customers-no-adapters",
      severity: "error",
      from: { path: "^src/customers/" },
      to: {
        path: "^(src/(server|web|billing|stripe|worker|import-review)/|scripts/|node_modules/(better-auth|@better-auth|stripe|pg-boss)/)",
      },
    },
    {
      name: "access-no-composition",
      severity: "error",
      from: { path: "^src/access/" },
      to: {
        path: "^(src/(server|web|billing|stripe|worker|import-review|customers|services)/|scripts/)",
      },
    },
    {
      name: "services-private",
      severity: "error",
      from: { pathNot: "^(src/services/|drizzle\\.config\\.ts$)" },
      to: { path: "^src/services/internal/" },
    },
    {
      name: "services-no-adapters",
      severity: "error",
      from: { path: "^src/services/" },
      to: {
        path: "^(src/(server|web|billing|stripe|worker|import-review)/|scripts/|node_modules/(better-auth|@better-auth|stripe|pg-boss)/)",
      },
    },
    {
      name: "stripe-no-composition",
      severity: "error",
      from: { path: "^src/stripe/" },
      to: { path: "^(src/(server|web|worker|import-review)/|scripts/)" },
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
