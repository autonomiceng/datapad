import { defineConfig } from "@playwright/test";

if (!process.env.TEST_BASE_URL || !process.env.PORTAL_TEST_MAILPIT_URL) {
  throw new Error(
    "Use mise run test:portal to start the isolated portal and test inbox.",
  );
}

export default defineConfig({
  outputDir: "test-results/portal",
  testDir: "tests/portal-browser",
  workers: 1,
  retries: 0,
  use: {
    baseURL: process.env.TEST_BASE_URL,
    browserName: "chromium",
    headless: true,
    timezoneId: "America/Los_Angeles",
    trace: "retain-on-failure",
  },
});
