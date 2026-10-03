import { defineConfig } from "@playwright/test";
import portal from "./playwright.portal.config";

if (
  process.env.PORTAL_BILLING_SANDBOX !== "true" ||
  !process.env.STRIPE_SECRET_KEY?.startsWith("sk_test_") ||
  !process.env.PORTAL_NOTICE_TEST_ARTIFACTS
)
  throw new Error(
    "Use mise run test:portal:notices with explicit sandbox configuration.",
  );

export default defineConfig({
  ...portal,
  testDir: "tests/portal-billing-browser",
  outputDir: "test-results/portal-notices",
  timeout: 120000,
  testMatch: "**/notice-delivery.spec.ts",
});
