import { defineConfig } from "@playwright/test";
import portal from "./playwright.portal.config";

if (
  process.env.PORTAL_BILLING_SANDBOX !== "true" ||
  !process.env.STRIPE_SECRET_KEY?.startsWith("sk_test_")
)
  throw new Error(
    "Use mise run test:portal:billing with explicit sandbox configuration.",
  );

export default defineConfig({
  ...portal,
  testDir: "tests/portal-billing-browser",
  outputDir: "test-results/portal-billing",
  timeout: 120000,
});
