import { join } from "node:path";
import { defineConfig } from "@playwright/test";
import {
  assertCollectionsDirectory,
  assertCollectionsWindow,
  collectionsPhase,
  loadCollectionsPlan,
} from "./scripts/collections-acceptance";

process.env.PLAYWRIGHT_NO_COPY_PROMPT = "1";
const artifacts = process.env.PORTAL_COLLECTIONS_TEST_ARTIFACTS;
const planPath = process.env.PORTAL_COLLECTIONS_TEST_PLAN;
if (
  !artifacts ||
  !planPath ||
  !process.env.PORTAL_COLLECTIONS_TEST_CLOCK ||
  !process.env.TEST_BASE_URL ||
  !process.env.PORTAL_TEST_MAILPIT_URL ||
  !process.env.DATABASE_URL ||
  !process.env.BILLING_DEPLOYMENT_KEY ||
  process.env.PORTAL_BILLING_SANDBOX !== "true" ||
  !process.env.STRIPE_SECRET_KEY?.startsWith("sk_test_")
)
  throw new Error(
    "Use the explicit collections sandbox acceptance task with private evidence.",
  );
await assertCollectionsDirectory(artifacts);
assertCollectionsWindow(
  await loadCollectionsPlan(planPath),
  collectionsPhase(process.env.PORTAL_COLLECTIONS_TEST_PHASE),
);

export default defineConfig({
  testDir: "tests/portal-billing-browser",
  testMatch: "**/collections.spec.ts",
  outputDir: join(artifacts, "collections-playwright"),
  reporter: "dot",
  workers: 1,
  retries: 0,
  repeatEach: 1,
  timeout: 300000,
  expect: { timeout: 15000 },
  use: {
    baseURL: process.env.TEST_BASE_URL,
    browserName: "chromium",
    headless: true,
    viewport: { width: 1280, height: 900 },
    timezoneId: "America/Los_Angeles",
    actionTimeout: 15000,
    navigationTimeout: 30000,
    trace: "off",
    screenshot: "off",
    video: "off",
  },
});
