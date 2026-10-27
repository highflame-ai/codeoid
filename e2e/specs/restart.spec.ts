import { createSessionInUi, expect, focusSession, messages, openUi, send, test, waitIdle } from "../harness";

test("after a daemon restart the session comes back with its history and takes new prompts", async ({ page, codeoid }) => {
  await openUi(page, codeoid);
  await createSessionInUi(page, "survivor", codeoid.workdir);
  await send(page, "before the restart");
  await expect(messages(page).filter({ hasText: "scripted: before the restart" })).toHaveCount(1);
  await waitIdle(page);

  await codeoid.restart();

  // The open page reconnects by itself.
  await expect(page.getByText("live", { exact: true })).toBeVisible({ timeout: 20_000 });
  await focusSession(page, "survivor");
  await expect(messages(page).filter({ hasText: "scripted: before the restart" })).toHaveCount(1);
  await send(page, "after the restart");
  await expect(messages(page).filter({ hasText: "scripted: after the restart" })).toHaveCount(1);

  // A fresh page sees the same history.
  await page.reload();
  await focusSession(page, "survivor");
  for (const text of ["before the restart", "after the restart"]) {
    await expect(messages(page).filter({ hasText: `scripted: ${text}` })).toHaveCount(1);
  }
  expect(await codeoid.cliOk("ls")).toContain("survivor");
});
