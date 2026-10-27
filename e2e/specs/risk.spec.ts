import { createSessionInUi, expect, messages, openUi, send, setMode, test, waitIdle } from "../harness";

// #431: approvals judge what a shell command does, not the tool's name.
test("autonomous mode still asks before a destructive command, says why, and runs a harmless one unasked", async ({ page, codeoid }) => {
  codeoid.setScript([
    {
      match: "^tidy up",
      steps: [
        { text: "Looking first." },
        { tool: "Bash", input: { command: "ls -la" } },
        { tool: "Bash", input: { command: "rm -rf ~" } },
        { text: "Stopped there." },
      ],
    },
  ]);
  await openUi(page, codeoid);
  await createSessionInUi(page, "risky", codeoid.workdir);
  await setMode(page, "autonomous");

  await send(page, "tidy up");
  // The read ran without asking; the delete asks, in autonomous mode too, and says why.
  await expect(page.getByText("Approval needed")).toBeVisible();
  const bar = page.getByText("Approval needed").locator("..").locator("..");
  await expect(bar.locator('[data-risk="high"]')).toContainText("high risk: rm deletes");
  await expect(messages(page).filter({ hasText: "completed" })).toHaveCount(1);

  await page.getByRole("button", { name: "deny", exact: true }).click();
  await expect(messages(page).filter({ hasText: "Denied by user" })).toHaveCount(1);
  await expect(messages(page).filter({ hasText: "Stopped there." })).toHaveCount(1);
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
