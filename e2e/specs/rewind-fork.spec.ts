import { createSessionInUi, expect, focusSession, messages, openUi, send, setMode, test, waitIdle } from "../harness";

const SCRIPT = [
  { match: "^draft v1", steps: [{ tool: "Write", input: { file_path: "plan.md", content: "v1\n" } }, { text: "Wrote v1." }] },
  { match: "^draft v2", steps: [{ tool: "Write", input: { file_path: "plan.md", content: "v2\n" } }, { tool: "Write", input: { file_path: "extra.md", content: "extra\n" } }, { text: "Wrote v2." }] },
];

/** A session with two turns, each rewriting plan.md (the second also adds extra.md). */
async function twoTurns(page: Parameters<typeof send>[0], name: string, workdir: string): Promise<void> {
  await createSessionInUi(page, name, workdir);
  await setMode(page, "autonomous");
  await send(page, "draft v1");
  await expect(messages(page).filter({ hasText: "Wrote v1." })).toHaveCount(1);
  await waitIdle(page);
  await send(page, "draft v2");
  await expect(messages(page).filter({ hasText: "Wrote v2." })).toHaveCount(1);
  await waitIdle(page);
}

test("go back a turn with the files: the turn is taken back and the files restored", async ({ page, codeoid }) => {
  codeoid.setScript(SCRIPT);
  await openUi(page, codeoid);
  await twoTurns(page, "rewind", codeoid.workdir);
  expect(codeoid.readFile("plan.md")).toBe("v2\n");

  const second = messages(page).filter({ hasText: "draft v2" }).first();
  await second.hover();
  await second.getByRole("button", { name: /go back to here/ }).click();
  const dialog = page.getByRole("dialog", { name: "Go back a turn" });
  await dialog.getByRole("checkbox").check();
  await expect(dialog).toContainText("plan.md");
  await expect(dialog).toContainText("extra.md");
  await dialog.getByRole("button", { name: "Go back", exact: true }).click();
  await expect(dialog).toHaveCount(0);

  await expect(messages(page).filter({ hasText: "Wrote v2." })).toHaveCount(0);
  await expect(messages(page).filter({ hasText: "Wrote v1." })).toHaveCount(1);
  expect(codeoid.readFile("plan.md")).toBe("v1\n");
  expect(() => codeoid.readFile("extra.md")).toThrow();
});

test("fork from an earlier turn: a new session with the conversation up to there", async ({ page, codeoid }) => {
  codeoid.setScript(SCRIPT);
  await openUi(page, codeoid);
  await twoTurns(page, "origin", codeoid.workdir);

  const first = messages(page).filter({ hasText: "Wrote v1." }).first();
  await first.hover();
  await first.getByRole("button", { name: /fork from here/ }).click();
  const dialog = page.getByRole("dialog", { name: "Fork from here" });
  await dialog.getByRole("button", { name: /^Fork/ }).first().click();
  await expect(dialog).toHaveCount(0);

  // The fork is a session of its own, focused, with only the first turn.
  await expect(page.getByRole("heading", { level: 2 })).not.toHaveText("origin");
  await expect(messages(page).filter({ hasText: "Wrote v1." })).toHaveCount(1);
  await expect(messages(page).filter({ hasText: "Wrote v2." })).toHaveCount(0);
  await send(page, "in the fork");
  await expect(messages(page).filter({ hasText: "scripted: in the fork" })).toHaveCount(1);

  // The original is untouched.
  await focusSession(page, "origin");
  await expect(messages(page).filter({ hasText: "Wrote v2." })).toHaveCount(1);
  await expect(messages(page).filter({ hasText: "in the fork" })).toHaveCount(0);
});
