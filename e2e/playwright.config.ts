/**
 * End-to-end suite (#429): a real daemon per test, real clients (the web UI in
 * Chromium, the CLI), and the scripted backend instead of a model. See
 * e2e/README.md.
 */
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./specs",
  // Each test boots its own daemon on its own port and config dir, so tests
  // run in parallel safely. CI machines are small: two at a time there.
  fullyParallel: true,
  workers: process.env.CI ? 2 : undefined,
  // No retries: a flaky end-to-end test is a bug to fix, not to hide.
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    viewport: { width: 1400, height: 950 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
