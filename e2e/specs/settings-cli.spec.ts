import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, openUi, test } from "../harness";

const VIEWPORTS = [
  [375, 667],
  [390, 844],
  [768, 1024],
  [1280, 800],
  [1470, 830],
  [1920, 1080],
  [1280, 300],
] as const;
const SHOTS = join(process.cwd(), "test-results", "settings-cli-shots");

// `codeoid settings` (docs/CONFIGURATION.md): the settings drawer from a
// terminal, over the same messages, so what it writes is what the web UI shows.
test("codeoid settings: the Claude Code CLI override set from a terminal shows in the web UI, and unsets", async ({ page, codeoid }) => {
  const listed = await codeoid.cliOk("settings", "ls", "claude");
  expect(listed).toMatch(/providers\.claude\.command\s+\(unset\)/);

  const set = await codeoid.cliOk("settings", "set", "providers.claude.command", "claude");
  expect(set).toContain("providers.claude.command = claude");
  expect(set).toContain("restarts");
  const config = JSON.parse(readFileSync(join(codeoid.configDir, "codeoid", "config.json"), "utf8")) as { providers?: { claude?: { command?: string } } };
  expect(config.providers?.claude?.command).toBe("claude");
  expect(await codeoid.cliOk("settings", "get", "providers.claude.command")).toMatch(/providers\.claude\.command\s+claude\s+\[config\]/);

  // The web UI's drawer shows the same value.
  await openUi(page, codeoid);
  await page.getByTitle("Settings", { exact: true }).first().click();
  await page.getByRole("button", { name: /Claude$/ }).first().click();
  await page.getByLabel("Show advanced").check();
  await expect(page.getByText("Claude Code CLI", { exact: true }).first()).toBeVisible();
  const field = page.locator('input[placeholder="claude"]').last();
  await expect(field).toHaveValue("claude");
  mkdirSync(SHOTS, { recursive: true });
  for (const [w, h] of VIEWPORTS) {
    await page.setViewportSize({ width: w, height: h });
    await field.scrollIntoViewIfNeeded();
    const box = await field.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThan(60);
    expect(box?.height ?? 0).toBeGreaterThan(16);
    await page.screenshot({ path: join(SHOTS, `claude-cli-${w}x${h}.png`), fullPage: false });
  }
  await page.setViewportSize({ width: 1280, height: 800 });

  // Values are checked before they are sent; a secret never comes from the command line.
  const bad = await codeoid.cli("settings", "set", "sandbox.docker.socket", "maybe");
  expect(bad.code).not.toBe(0);
  expect(bad.output).toContain("give true or false");
  const secret = await codeoid.cli("settings", "set", "ANTHROPIC_API_KEY", "sk-ant-not-real");
  expect(secret.code).not.toBe(0);
  expect(secret.output).toContain("shell history");
  const typo = await codeoid.cli("settings", "get", "claude.command");
  expect(typo.code).not.toBe(0);
  expect(typo.output).toContain("providers.claude.command");

  expect(await codeoid.cliOk("settings", "unset", "providers.claude.command")).toContain("providers.claude.command = (unset)");
  expect(await codeoid.cliOk("settings", "ls", "claude")).toMatch(/providers\.claude\.command\s+\(unset\)/);
});
