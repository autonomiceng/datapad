import { defineConfig } from "drizzle-kit";
export default defineConfig({
  dialect: "postgresql",
  schema: [
    "./src/import-review/internal/schema.ts",
    "./src/billing/internal/schema.ts",
    "./src/access/internal/schema.ts",
    "./src/customers/internal/schema.ts",
    "./src/services/internal/schema.ts",
  ],
  out: "./drizzle",
});
