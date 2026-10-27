import { createSessionInUi, expect, messages, openUi, send, test, waitIdle } from "../harness";

const WRITE = {
  match: "^write it",
  steps: [
    { text: "Writing." },
    { tool: "Write", input: { file_path: "approved.txt", content: "approved\n" } },
    { text: "All done." },
  ],
};

test("approve a tool call from the web UI: it runs, and the card says so", async ({ page, codeoid }) => {
  codeoid.setScript([WRITE]);
  await openUi(page, codeoid);
  await createSessionInUi(page, "approve", codeoid.workdir);

  await send(page, "write it");
  const card = page.getByText("Approval needed").locator("..").locator("..");
  await expect(card).toContainText("Write");
  const tool = messages(page).filter({ hasText: "approved.txt" });
  await expect(tool).toContainText("waiting confirmation");

  await page.getByRole("button", { name: "approve", exact: true }).click();
  await expect(tool).toContainText("completed");
  await expect(messages(page).filter({ hasText: "All done." })).toHaveCount(1);
  await expect(page.getByText("Approval needed")).toHaveCount(0);
  await waitIdle(page);
  expect(codeoid.readFile("approved.txt")).toBe("approved\n");
});

test("deny from the CLI while the web UI shows the request: it resolves there too, and nothing is written", async ({ page, codeoid }) => {
  codeoid.setScript([WRITE]);
  await openUi(page, codeoid);
  await createSessionInUi(page, "deny", codeoid.workdir);

  await send(page, "write it");
  await expect(page.getByText("Approval needed")).toBeVisible();

  await codeoid.cliOk("approve", "deny", "--deny", "--yes");
  await expect(page.getByText("Approval needed")).toHaveCount(0);
  const tool = messages(page).filter({ hasText: "approved.txt" });
  await expect(tool).toContainText("Denied by user");
  await waitIdle(page);
  expect(() => codeoid.readFile("approved.txt")).toThrow();
});
