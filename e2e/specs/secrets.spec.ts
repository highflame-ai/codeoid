import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createSessionInUi, expect, messages, openUi, send, test, waitIdle } from "../harness";

// Made-up credentials of the right shape, split so no contiguous token sits in this file.
const GHP = `ghp_${"Zx9Qw3Er5Ty7Ui1Op2As4Df6Gh8Jk0Lz3Xc5V"}`;
const PASSWORD = `hunter${"2xyz"}`;

/** Every transcript, canonical history and turn index the daemon wrote. */
function storedText(configDir: string): string {
  const dir = join(configDir, "codeoid", "transcripts");
  return readdirSync(dir)
    .filter((n) => n.endsWith(".jsonl"))
    .map((n) => readFileSync(join(dir, n), "utf8"))
    .join("\n");
}

// docs/secrets-and-memory-design.md §2: a secret a tool prints and a reply
// repeats is shown and stored as a reference; a workstream that keeps them
// lets its owner get it back; older data can be scrubbed, never while the
// daemon runs.
test("a leaked token is shown and stored as a reference, kept where the workstream says so, revealed to its owner", async ({ page, codeoid }) => {
  codeoid.configure({
    workstreams: { items: [{ id: "keep", name: "Keep", captureSecrets: "vault", match: { paths: [codeoid.workdir] } }] },
  });
  await codeoid.restart();
  codeoid.setScript([
    {
      match: "^leak",
      steps: [
        { tool: "Read", input: { file_path: "notes.md" }, output: `token=${GHP}\nDB_PASSWORD=${PASSWORD}\n` },
        { text: `The token is ${GHP}, and the password is ${PASSWORD}.` },
      ],
    },
  ]);
  await openUi(page, codeoid);
  await createSessionInUi(page, "leaky", codeoid.workdir);
  await send(page, "leak it");
  const approve = page.getByRole("button", { name: "approve", exact: true });
  if (await approve.isVisible().catch(() => false)) await approve.click();
  await expect(messages(page).filter({ hasText: "The token is" })).toHaveCount(1);
  await waitIdle(page);

  // On screen: references, never the values.
  const main = page.getByRole("main");
  await expect(main).toContainText(/‹secret:github-token:[0-9a-f]{8}›/);
  await expect(main).not.toContainText(GHP);
  await expect(main).not.toContainText(PASSWORD);

  // On disk: the same.
  const stored = storedText(codeoid.configDir);
  expect(stored).not.toContain(GHP);
  expect(stored).not.toContain(PASSWORD);
  expect(stored).toMatch(/‹secret:github-token:[0-9a-f]{8}›/);

  // A new page load replays the scrollback: still references.
  await page.reload();
  await expect(page.getByText("live", { exact: true })).toBeVisible();
  await expect(page.locator("body")).not.toContainText(GHP);

  // The workstream keeps it: listed without the value, revealed to the owner.
  const ls = await codeoid.cliOk("secret", "ls");
  expect(ls).toContain("github-token");
  expect(ls).not.toContain(GHP);
  const ref = /keep:([0-9a-f]{8})\s+github-token/.exec(ls)?.[0].split(/\s+/)[0];
  expect(ref).toBeTruthy();
  expect((await codeoid.cliOk("secret", "reveal", ref!)).trim()).toBe(GHP);
  expect(await codeoid.cliOk("secret", "forget", ref!)).toContain("Forgot");
  expect(await codeoid.cliOk("secret", "ls")).not.toContain(ref!);

  // Scrubbing older data refuses while the daemon runs.
  const scrub = await codeoid.cli("secret", "scrub", "--dry-run");
  expect(scrub.code).not.toBe(0);
  expect(scrub.output).toContain("the daemon is running");
});
