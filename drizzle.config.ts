import { defineConfig } from "drizzle-kit";
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/import-review/internal/schema.ts",
  out: "./drizzle",
});
