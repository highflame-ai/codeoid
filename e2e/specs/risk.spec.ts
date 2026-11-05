import { createSessionInUi, expect, messages, openUi, send, setMode, test, waitIdle } from "../harness";

// #431: approvals judge what a shell command does, not the tool's name.
test("guarded mode asks before a destructive command and says why", async ({ page, codeoid }) => {
  codeoid.setScript([
    {
      match: "^tidy up",
      steps: [
        { tool: "Bash", input: { command: "rm -rf ~" } },
        { text: "Stopped there." },
      ],
    },
  ]);
  await openUi(page, codeoid);
  await createSessionInUi(page, "risky", codeoid.workdir);
  await setMode(page, "guarded");

  await send(page, "tidy up");
  await expect(page.getByText("Approval needed")).toBeVisible();
  const bar = page.getByText("Approval needed").locator("..").locator("..");
  await expect(bar.locator('[data-risk="high"]')).toContainText("high risk: rm deletes");

  await page.getByRole("button", { name: "deny", exact: true }).click();
  await expect(messages(page).filter({ hasText: "Denied by user" })).toHaveCount(1);
  await expect(messages(page).filter({ hasText: "Stopped there." })).toHaveCount(1);
  await waitIdle(page);
});

// #448: autonomous mode waits on no one; the OS sandbox is its boundary. (The
// scripted backend runs no command it is given: these are gated, never executed.)
test("autonomous mode runs a high-risk command unasked, and refuses a read of codeoid's credentials at once, saying why", async ({ page, codeoid }) => {
  codeoid.setScript([
    {
      match: "^tidy up",
      steps: [
        { tool: "Bash", input: { command: "git push --force origin main" }, output: "pushed" },
        // A search of the dir runs in a sandboxed session (the sandbox hides it); a read of the file is refused in every mode.
        { tool: "Bash", input: { command: `cat ${codeoid.configDir}/codeoid/config.json` } },
        { text: "Done." },
      ],
    },
  ]);
  await openUi(page, codeoid);
  await createSessionInUi(page, "autonomous-risky", codeoid.workdir);
  await setMode(page, "autonomous");

  await send(page, "tidy up");
  await expect(messages(page).filter({ hasText: "Done." })).toHaveCount(1);
  await expect(messages(page).filter({ hasText: "holds credentials" }).first()).toBeVisible();
  await expect(messages(page).filter({ hasText: "completed" })).toHaveCount(1);
  await expect(page.getByText("Approval needed")).toHaveCount(0);
  await waitIdle(page);
});

test("a command naming one of codeoid's credential files is refused outright, in any mode", async ({ page, codeoid }) => {
  codeoid.setScript([
    {
      match: "^peek",
      steps: [{ tool: "Bash", input: { command: `cat ${codeoid.configDir}/codeoid/config.json` } }, { text: "Could not." }],
    },
  ]);
  await openUi(page, codeoid);
  await createSessionInUi(page, "secret", codeoid.workdir);
  await setMode(page, "autonomous");

  await send(page, "peek");
  await expect(messages(page).filter({ hasText: "holds credentials" }).first()).toBeVisible();
  await expect(page.getByText("Approval needed")).toHaveCount(0);
  await waitIdle(page);
});
