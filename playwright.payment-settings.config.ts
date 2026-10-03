import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { defineConfig } from "@playwright/test";

// The pinned Playwright otherwise records a failure-time accessibility snapshot.
process.env.PLAYWRIGHT_NO_COPY_PROMPT = "1";

const artifacts = process.env.PORTAL_PAYMENT_SETTINGS_TEST_ARTIFACTS;
if (
  !artifacts ||
  !isAbsolute(artifacts) ||
  !process.env.TEST_BASE_URL ||
  !process.env.PORTAL_TEST_MAILPIT_URL ||
  !process.env.DATABASE_URL ||
  !process.env.BILLING_DEPLOYMENT_KEY ||
  process.env.PORTAL_BILLING_SANDBOX !== "true" ||
  !process.env.STRIPE_SECRET_KEY?.startsWith("sk_test_") ||
  process.env.PORTAL_SCHEDULE_TEST_CLOCK
)
  throw new Error(
    "Explicit hosted setup sandbox configuration and real clock are required.",
  );

// Match the resolution acceptance guard before Playwright creates any artifacts.
const directory = lstatSync(artifacts);
const fromCheckout = relative(
  realpathSync(process.cwd()),
  realpathSync(artifacts),
);
if (
  !directory.isDirectory() ||
  directory.isSymbolicLink() ||
  (directory.mode & 0o777) !== 0o700 ||
  directory.uid !== process.getuid?.() ||
  !(
    fromCheckout === ".." ||
    fromCheckout.startsWith(`..${sep}`) ||
    isAbsolute(fromCheckout)
  )
)
  throw new Error(
    "Hosted setup artifacts require an owner-only directory outside the checkout.",
  );

export default defineConfig({
  testDir: "tests/portal-billing-browser",
  testMatch: "**/payment-settings.spec.ts",
  outputDir: join(artifacts, "playwright"),
  reporter: "dot",
  workers: 1,
  retries: 0,
  repeatEach: 1,
  timeout: 240000,
  expect: { timeout: 15000 },
  use: {
    baseURL: process.env.TEST_BASE_URL,
    browserName: "chromium",
    headless: true,
    viewport: { width: 1280, height: 900 },
    timezoneId: "UTC",
    actionTimeout: 15000,
    navigationTimeout: 30000,
    // Hosted input and SDK responses must never enter automatic captures.
    trace: "off",
    screenshot: "off",
    video: "off",
  },
});
