import { isAbsolute, join } from "node:path";
import { defineConfig } from "@playwright/test";
import billing from "./playwright.billing.config";

const artifacts = process.env.PORTAL_RESOLUTION_TEST_ARTIFACTS;
if (!artifacts || !isAbsolute(artifacts))
  throw new Error(
    "Use mise run test:portal:resolutions with a private artifact directory.",
  );

process.umask(0o077);

export default defineConfig({
  ...billing,
  testMatch: "**/resolutions.spec.ts",
  testIgnore: [],
  outputDir: join(artifacts, "playwright"),
  timeout: 240000,
  reporter: "list",
  use: {
    ...billing.use,
    trace: "off",
    screenshot: "off",
    video: "off",
    viewport: { width: 1280, height: 900 },
    actionTimeout: 15000,
  },
});
