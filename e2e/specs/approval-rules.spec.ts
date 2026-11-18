import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createSessionInUi, expect, messages, openUi, send, setMode, test, waitIdle } from "../harness";

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
const SHOTS = join(process.cwd(), "test-results", "approval-rules-shots");

const NPM_TEST = (match: string, command: string) => ({
  match,
  steps: [{ tool: "Bash", input: { command }, output: "tests passed" }, { text: `Ran ${command}.` }],
});

// docs/secrets-and-memory-design.md §4.1: a card's answer kept for the repository.
test("allow in this repository: the next matching command runs unasked, Settings → Approvals lists it, and removing it asks again", async ({ page, codeoid }) => {
  mkdirSync(SHOTS, { recursive: true });
  codeoid.setScript([
    NPM_TEST("^first", "npm test 2>&1 | tail -20"),
    NPM_TEST("^second", "npm test -- --ci"),
    NPM_TEST("^third", "npm test"),
    NPM_TEST("^fourth", "npm test"),
  ]);
  await openUi(page, codeoid);
  await createSessionInUi(page, "rules", codeoid.workdir);
  await setMode(page, "guarded");

  await send(page, "first");
  const offer = page.getByTestId("approval-rule-offer");
  await expect(offer).toContainText("Bash(npm test:*)");
  for (const [w, h] of VIEWPORTS) {
    await page.setViewportSize({ width: w, height: h });
    // A narrow window lays the page out anew: wait for the card there, then scroll to it, as to the rest of the bar.
    await expect(offer.locator('[data-save-scope="repository"]')).toBeAttached();
    await offer.locator('[data-save-scope="repository"]').evaluate((el) => el.scrollIntoView({ block: "center" }));
    await page.screenshot({ path: join(SHOTS, `card-${w}x${h}.png`), fullPage: false });
    // The buttons are on screen and keep their size, however narrow.
    const box = await offer.locator('[data-save-scope="repository"]').boundingBox();
    expect(box && box.height >= 16 && box.width >= 60 && box.x >= 0 && box.x + box.width <= w && box.y >= 0 && box.y + box.height <= h).toBeTruthy();
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  await offer.locator('[data-save-scope="repository"]').click();
  await expect(messages(page).filter({ hasText: "Ran npm test 2>&1 | tail -20." })).toHaveCount(1);
  await waitIdle(page);

  // Covered by the rule: no card.
  await send(page, "second");
  await expect(messages(page).filter({ hasText: "Ran npm test -- --ci." })).toHaveCount(1);
  await expect(page.getByText("Approval needed")).toHaveCount(0);
  await waitIdle(page);

  // Listed, with its use; the CLI lists it too.
  await page.getByTitle("Settings", { exact: true }).first().click();
  await page.getByRole("button", { name: /Approvals/ }).click();
  const row = page.locator('[data-testid^="approval-rule-"]', { hasText: "Bash(npm test:*)" });
  await expect(row).toContainText("repository");
  await expect(row).toContainText("used 1×");
  for (const [w, h] of VIEWPORTS) {
    await page.setViewportSize({ width: w, height: h });
    await page.screenshot({ path: join(SHOTS, `settings-${w}x${h}.png`), fullPage: false });
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  expect(await codeoid.cliOk("approvals", "ls")).toContain("Bash(npm test:*)");

  await row.getByRole("button", { name: "Remove" }).click();
  await expect(row).toHaveCount(0);
  await page.keyboard.press("Escape");

  await send(page, "third");
  await expect(page.getByText("Approval needed")).toBeVisible();
  await page.getByRole("button", { name: "approve", exact: true }).click();
  await waitIdle(page);

  // Added in Settings, for everywhere: listed at once, and the next call runs on it.
  await page.getByTitle("Settings", { exact: true }).first().click();
  await page.getByRole("button", { name: /Approvals/ }).click();
  await page.getByRole("button", { name: "Add rule" }).click();
  const form = page.getByTestId("approval-rule-add");
  await form.getByPlaceholder(/Bash\(npm test/).fill("Bash(npm test:*)");
  await form.locator("select").nth(1).selectOption("everywhere");
  await form.getByRole("button", { name: "Save rule" }).click();
  await expect(page.locator('[data-testid^="approval-rule-"]', { hasText: "everywhere" })).toBeVisible();
  await expect(page.getByTestId("approval-rule-add")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await send(page, "fourth");
  await expect(messages(page).filter({ hasText: "Ran npm test." })).toHaveCount(2);
  await expect(page.getByText("Approval needed")).toHaveCount(0);
  await waitIdle(page);
});

test("from the CLI: a deny rule refuses in every mode, and approve --save keeps the card's rule for the session", async ({ page, codeoid }) => {
  codeoid.setScript([
    NPM_TEST("^publish", "npm publish --tag next"),
    NPM_TEST("^lint", "make lint"),
    NPM_TEST("^again", "make lint"),
  ]);
  await openUi(page, codeoid);
  await createSessionInUi(page, "cli-rules", codeoid.workdir);
  await setMode(page, "autonomous");
  await codeoid.cliOk("approvals", "add", "Bash(npm publish:*)", "--deny", "--everywhere");

  await send(page, "publish");
  await expect(messages(page).filter({ hasText: "your rule Bash(npm publish:*)" }).first()).toBeVisible();
  await waitIdle(page);
  // Refused, so it never ran: no output of it.
  await expect(messages(page).filter({ hasText: "tests passed" })).toHaveCount(0);

  await setMode(page, "guarded");
  await send(page, "lint");
  await expect(page.getByText("Approval needed")).toBeVisible();
  expect(await codeoid.cliOk("approve", "cli-rules", "--save", "session", "--yes")).toContain("saved Bash(make lint:*) for this session");
  await expect(messages(page).filter({ hasText: "Ran make lint." })).toHaveCount(1);
  await waitIdle(page);

  await send(page, "again");
  await expect(messages(page).filter({ hasText: "Ran make lint." })).toHaveCount(2);
  await expect(page.getByText("Approval needed")).toHaveCount(0);
  await waitIdle(page);
});
