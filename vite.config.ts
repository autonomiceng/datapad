import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [
    react(),
    {
      name: "browser-boundary",
      generateBundle() {
        for (const id of this.getModuleIds()) {
          const normalized = id.replaceAll("\\", "/");
          if (
            normalized.includes("/src/server/") ||
            (normalized.includes("/src/import-review/") &&
              !normalized.endsWith("/src/import-review/contract.ts")) ||
            /\/node_modules\/(?:elysia|@elysia|drizzle-orm|pg|pg-pool|pg-protocol)\//.test(
              normalized,
            )
          ) {
            this.error(`Server module reached the browser bundle: ${id}`);
          }
        }
      },
    },
  ],
  server: {
    host: "127.0.0.1",
    proxy: { "/api": process.env.API_ORIGIN ?? "http://127.0.0.1:3000" },
  },
  fmt: {
    printWidth: 80,
    proseWrap: "preserve",
    endOfLine: "lf",
    sortImports: false,
    sortPackageJson: false,
    ignorePatterns: ["bun.lock", "drizzle/meta/**", "contracts/openapi.json"],
  },
  lint: {
    ignorePatterns: ["dist/**", ".scratch/**", "node_modules/**"],
    options: { typeAware: true, typeCheck: true },
  },
});
