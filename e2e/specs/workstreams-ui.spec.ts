import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, openUi, test } from "../harness";

// The viewports the workspace rules ask layout changes be looked at in.
const VIEWPORTS = [
  [375, 667],
  [390, 844],
  [768, 1024],
  [1280, 800],
  [1470, 830],
  [1920, 1080],
  [1280, 300],
] as const;
const SHOTS = join(process.cwd(), "test-results", "workstreams-shots");

// Workstreams W2 in the web UI: Settings shows and edits them; the new-session
// dialog says what the folder resolves to, offers an override past an
// exclusive workstream with what it changes, and the session's chip shows it.
test("workstreams in the web UI: settings, the new-session picker, a confirmed override, the chip", async ({ page, codeoid }) => {
  mkdirSync(SHOTS, { recursive: true });
  codeoid.configure({
    credentials: [{ id: "gh-acme", kind: "env" }],
    workstreams: {
      items: [
        { id: "acme", name: "Acme Corp", color: "orange", claim: "exclusive", match: { paths: [codeoid.workdir] }, env: { GH_TOKEN: { secret: "gh-acme" } } },
        { id: "mine", name: "Mine", match: { paths: ["~/never"] } },
      ],
    },
  });
  await codeoid.restart();
  await openUi(page, codeoid);

  // Settings → Workstreams lists them; add one there.
  await page.getByTitle("Settings", { exact: true }).first().click();
  await page.getByRole("button", { name: /Workstreams/ }).click();
  await expect(page.locator("span.font-medium", { hasText: "Acme Corp" })).toBeVisible();
  for (const [w, h] of VIEWPORTS) {
    await page.setViewportSize({ width: w, height: h });
    await page.screenshot({ path: join(SHOTS, `settings-${w}x${h}.png`), fullPage: false });
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByRole("button", { name: "Add workstream" }).click();
  const form = page.getByRole("form", { name: "New workstream" });
  await form.getByPlaceholder("acme", { exact: true }).fill("research");
  await form.getByPlaceholder("Acme Corp").fill("Research");
  await form.getByRole("button", { name: "Save" }).click();
  await expect(page.locator("span.font-medium", { hasText: "Research" })).toBeVisible();

  // Credentials: a value set is never shown back.
  await page.getByRole("button", { name: /Credentials/ }).click();
  await expect(page.getByTestId("credential-gh-acme")).toContainText("not set");
  await page.getByLabel("Value of gh-acme").fill("ghp_e2e_value");
  await page.getByRole("button", { name: "Set", exact: true }).click();
  await expect(page.getByTestId("credential-gh-acme")).toContainText("set (CODEOID_CRED_GH_ACME)");
  await expect(page.getByText("ghp_e2e_value")).toHaveCount(0);
  await page.keyboard.press("Escape");

  // New session in Acme's folder, choosing Mine: offered, with what changes.
  await page.getByRole("button", { name: /new session/ }).click();
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("past-claim");
  await page.getByRole("textbox", { name: /^Workdir/ }).fill(codeoid.workdir);
  await expect(page.getByLabel("Workstream")).toContainText("The folder's: acme", { timeout: 10_000 });
  await page.getByLabel("Workstream").selectOption("mine");
  await page.getByRole("button", { name: "create", exact: true }).click();
  const offer = page.getByRole("alert").filter({ hasText: "belongs to workstream" });
  await expect(offer).toContainText("“Acme Corp” (exclusive)");
  for (const [w, h] of VIEWPORTS) {
    await page.setViewportSize({ width: w, height: h });
    await offer.scrollIntoViewIfNeeded();
    // Its buttons fit, whatever the window: nothing to confirm with is cut off.
    const box = await page.getByRole("button", { name: "Start anyway" }).boundingBox();
    expect(box && box.width > 40 && box.height > 16 && box.x + box.width <= w).toBe(true);
    await page.screenshot({ path: join(SHOTS, `override-${w}x${h}.png`), fullPage: false });
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByRole("button", { name: "Start anyway" }).click();
  await expect(page.getByRole("heading", { name: "past-claim", level: 2 })).toBeVisible();
  // The session header's chip (not the list row's): beside the session's own heading.
  const header = page.getByRole("heading", { name: "past-claim", level: 2 }).locator("xpath=..");
  await expect(header.getByTestId("workstream-chip")).toContainText("Mine");
  for (const [w, h] of VIEWPORTS) {
    await page.setViewportSize({ width: w, height: h });
    await page.screenshot({ path: join(SHOTS, `session-${w}x${h}.png`), fullPage: false });
  }
});
