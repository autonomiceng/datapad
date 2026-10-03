import { defineConfig } from "@playwright/test";
import billing from "./playwright.billing.config";

if (
  !process.env.PORTAL_SCHEDULE_TEST_CLOCK ||
  !process.env.PORTAL_SCHEDULE_TEST_PLAN
)
  throw new Error(
    "Use mise run test:portal:scheduled with explicit sandbox configuration.",
  );

export default defineConfig({
  ...billing,
  testMatch: "**/scheduled.spec.ts",
  testIgnore: [],
  outputDir: "test-results/portal-scheduled",
});
