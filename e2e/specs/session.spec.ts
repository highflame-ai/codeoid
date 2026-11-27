import { createSessionInUi, expect, messages, openUi, send, setMode, test, waitIdle } from "../harness";

test("create a session in the web UI, send a prompt, and see the reply and the tool call", async ({ page, codeoid }) => {
  codeoid.setScript([
    {
      match: "^add a note",
      steps: [
        { text: "Adding a note." },
        { tool: "Write", input: { file_path: "notes/todo.md", content: "- ship the e2e suite\n" } },
        { text: "The note is in notes/todo.md." },
      ],
    },
  ]);
  await openUi(page, codeoid);
  await createSessionInUi(page, "first", codeoid.workdir);

  await send(page, "hello");
  await expect(messages(page).filter({ hasText: "scripted: hello" })).toHaveCount(1);

  // Autonomous mode, so the write runs without a prompt; the card shows it ran.
  await setMode(page, "autonomous");
  await send(page, "add a note");
  const tool = messages(page).filter({ hasText: "notes/todo.md" }).filter({ hasText: "Write" });
  await expect(tool).toContainText("completed");
  await expect(messages(page).filter({ hasText: "The note is in notes/todo.md." })).toHaveCount(1);
  await waitIdle(page);
  expect(codeoid.readFile("notes/todo.md")).toBe("- ship the e2e suite\n");

  // The CLI sees the same session.
  expect(await codeoid.cliOk("ls")).toContain("first");
});

test("a backend error mid-turn is shown, and the session takes the next prompt", async ({ page, codeoid }) => {
  codeoid.setScript([{ match: "^break", steps: [{ text: "Starting…" }, { error: "upstream exploded (scripted)" }] }]);
  await openUi(page, codeoid);
  await createSessionInUi(page, "errors", codeoid.workdir);

  await send(page, "break");
  await expect(page.getByRole("main")).toContainText("upstream exploded (scripted)");
  await waitIdle(page);

  await send(page, "still there?");
  await expect(messages(page).filter({ hasText: "scripted: still there?" })).toHaveCount(1);
});

test("a backend that dies mid-turn: the failure is shown, and the session takes the next prompt", async ({ page, codeoid }) => {
  codeoid.setScript([{ match: "^die", steps: [{ text: "About to go." }, { crash: "backend process exited (scripted)" }] }]);
  await openUi(page, codeoid);
  await createSessionInUi(page, "crash", codeoid.workdir);

  await send(page, "die");
  await expect(page.getByRole("main")).toContainText("backend process exited (scripted)");
  await waitIdle(page);

  await send(page, "back?");
  await expect(messages(page).filter({ hasText: "scripted: back?" })).toHaveCount(1);
});

test("a turn's usage shows in the session's totals", async ({ page, codeoid }) => {
  codeoid.setScript([{ match: "^count", steps: [{ text: "Counted." }, { usage: { inputTokens: 321, outputTokens: 87, costUsd: 0.42 } }] }]);
  await openUi(page, codeoid);
  await createSessionInUi(page, "usage", codeoid.workdir);

  await send(page, "count");
  await expect(messages(page).filter({ hasText: "Counted." })).toHaveCount(1);
  await waitIdle(page);
  const header = page.getByRole("main");
  await expect(header.getByText("New input").locator("..")).toContainText("321");
  await expect(header.getByText("Output", { exact: true }).locator("..")).toContainText("87");
  await expect(header.getByText("Cost", { exact: true }).locator("..")).toContainText("$0.42");
});
