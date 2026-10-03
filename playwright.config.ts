import { defineConfig } from "@playwright/test";

if (!process.env.TEST_BASE_URL) {
  throw new Error(
    "Use mise run test:app to start an isolated database and server.",
  );
}

export default defineConfig({
  testDir: "tests/browser",
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
