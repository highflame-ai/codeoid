import { mkdirSync } from "node:fs";
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
const SHOTS = join(process.cwd(), "test-results", "workstreams-shots");

// Workstreams W4 (§10): the conductor's send-class card names the workstream
// the action runs in, and warns when approving it confirms an override.
test("the conductor's spawn card names the workstream, and warns of an override", async ({ page, codeoid }) => {
  mkdirSync(SHOTS, { recursive: true });
  const acme = join(codeoid.root, "acme");
  mkdirSync(acme, { recursive: true });
  codeoid.configure({
    conductor: { enabled: true, provider: "scripted" },
    workstreams: {
      isolateGlobalServers: true,
      items: [
        { id: "mine", match: { paths: [codeoid.workdir] } },
        { id: "acme", claim: "exclusive", match: { paths: [acme] } },
      ],
    },
  });
  codeoid.setScript([
    {
      match: "^spawn it",
      steps: [
        { text: "Spawning a worker." },
        { tool: "mcp__codeoid_fleet__fleet_spawn", input: { workdir: acme, task: "look around", workstream: "mine" } },
        { text: "Done." },
      ],
    },
  ]);
  await codeoid.restart();
  // `conductor` is made on first use; the send leaves its turn waiting on the spawn's card.
  await codeoid.cliOk("send", "conductor", "spawn it");
  await openUi(page, codeoid);
  await page.getByRole("button", { name: "Conductor", exact: true }).click();
  const line = page.getByTestId("approval-workstream");
  await expect(line).toContainText("workstream mine", { timeout: 15_000 });
  await expect(line).toContainText("Past the folder's own workstream");
  for (const [w, h] of VIEWPORTS) {
    await page.setViewportSize({ width: w, height: h });
    // The bar re-renders on a resize: wait for the line as it is now, never a node swapped out.
    await expect(line).toBeVisible();
    for (let i = 0; i < 3; i++) {
      try {
        await line.scrollIntoViewIfNeeded({ timeout: 2_000 });
        break;
      } catch {}
    }
    await page.screenshot({ path: join(SHOTS, `conductor-card-${w}x${h}.png`), fullPage: false });
    const box = await line.boundingBox();
    // On screen, not only in the DOM: inside the window both ways.
    expect([w, h, box && box.x >= 0 && box.x + box.width <= w && box.y >= 0 && box.y + box.height <= h && box.height > 8]).toEqual([w, h, true]);
    const approve = await page.getByRole("button", { name: "approve", exact: true }).boundingBox();
    expect([w, h, approve !== null && approve.x + approve.width <= w]).toEqual([w, h, true]);
  }
});
