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

function configureW3(codeoid: { root: string; workdir: string; configure(p: Record<string, unknown>): void }): void {
  for (const d of ["pub", "hf", "acme"]) mkdirSync(join(codeoid.root, d), { recursive: true });
  codeoid.configure({
    workstreams: {
      isolateGlobalServers: true,
      items: [
        { id: "mine", name: "Mine", share: "open", match: { paths: [codeoid.workdir] } },
        { id: "pub", name: "Pub", share: "open", match: { paths: [join(codeoid.root, "pub")] } },
        { id: "acme", name: "Acme", share: "ask", match: { paths: [join(codeoid.root, "acme")] } },
        { id: "hf", name: "HF", share: "closed", match: { paths: [join(codeoid.root, "hf")] } },
      ],
    },
  });
}

// Workstreams W3 (§5.3, §7): references by each workstream's share policy,
// and moving a session, from the CLI.
test("references follow the share policy; a session moves; a closed workstream is never read", async ({ codeoid }) => {
  configureW3(codeoid);
  await codeoid.restart();

  expect(await codeoid.cliOk("new", "r1", codeoid.workdir, "--ref", "pub")).toContain("workstream: Mine (mine)");
  const closed = await codeoid.cli("new", "r2", codeoid.workdir, "--ref", "hf");
  expect(closed.code).not.toBe(0);
  expect(closed.output).toContain('"hf" is closed');
  // The owner's own token, undelegated: an `ask` workstream is granted at once.
  const asked = await codeoid.cliOk("workstream", "ref", "add", "r1", "acme");
  expect(asked).toContain("reads: pub; acme");
  expect(await codeoid.cliOk("workstream", "ref", "rm", "r1", "pub")).toContain("reads: acme");
  // r1 read from acme (ask): the owner's token is the approval.
  expect(await codeoid.cliOk("workstream", "move", "r1", "pub")).toContain("workstream: Pub (pub)");
  await codeoid.restart();
  expect(await codeoid.cliOk("ls")).toContain("workstream: Pub (pub)");
});

// The same in the web UI: the dialog offers what the session may read, the
// header chip opens what it reads and where it lives.
test("the web UI: references in the new-session dialog, the chip's panel at every viewport", async ({ page, codeoid }) => {
  mkdirSync(SHOTS, { recursive: true });
  configureW3(codeoid);
  await codeoid.restart();
  await openUi(page, codeoid);

  await page.getByRole("button", { name: /new session/ }).click();
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("reader");
  await page.getByRole("textbox", { name: /^Workdir/ }).fill(codeoid.workdir);
  await expect(page.getByLabel("Workstream")).toContainText("The folder's: mine", { timeout: 10_000 });
  const reads = page.getByRole("group", { name: "Also reads" });
  await expect(reads).toContainText("Pub");
  await expect(reads).toContainText("Acme (asks)");
  await expect(reads).not.toContainText("HF");
  await reads.getByLabel(/^Pub/).check();
  for (const [w, h] of VIEWPORTS) {
    await page.setViewportSize({ width: w, height: h });
    await reads.scrollIntoViewIfNeeded();
    const box = await reads.boundingBox();
    expect(box && box.x >= 0 && box.x + box.width <= w && box.height > 20).toBe(true);
    await page.screenshot({ path: join(SHOTS, `reads-${w}x${h}.png`), fullPage: false });
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByRole("button", { name: "create", exact: true }).click();
  const header = page.getByRole("heading", { name: "reader", level: 2 }).locator("xpath=..");
  const chip = header.getByTestId("workstream-chip");
  await expect(chip).toContainText("Mine +1");
  // A fresh session's sandbox is no change: nothing said about its directories.
  await expect(page.getByText("Sandbox directories applied")).toHaveCount(0);

  await chip.click();
  const panel = page.getByRole("dialog", { name: "Workstream" });
  await expect(panel).toContainText("Pub");
  for (const [w, h] of VIEWPORTS) {
    await page.setViewportSize({ width: w, height: h });
    // Re-opened at each size: it is placed from the chip's box when it opens.
    await page.keyboard.press("Escape");
    await chip.click();
    const box = await panel.boundingBox();
    expect(box && box.x >= 0 && box.x + box.width <= w && box.width > 200 && box.height > 40).toBe(true);
    const move = await panel.getByRole("button", { name: "Move", exact: true }).boundingBox();
    expect(move && move.x + move.width <= w).toBe(true);
    await page.screenshot({ path: join(SHOTS, `chip-panel-${w}x${h}.png`), fullPage: false });
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  await panel.getByLabel("Add a workstream to read").selectOption("acme");
  await panel.getByRole("button", { name: "Add", exact: true }).click();
  await expect(chip).toContainText("Mine +2");
  await panel.getByRole("button", { name: "Remove" }).first().click();
  await expect(chip).toContainText("Mine +1");
});
