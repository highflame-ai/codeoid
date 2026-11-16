/**
 * The sandbox's `push` through the real SessionManager (a mock backend, a
 * sandboxed session): autonomous mode decides with no card; guarded mode asks
 * the owner, who sees what would be pushed where; every request is audited
 * and said in the transcript. The push itself (planning, running against a
 * real bare remote) is sandbox-push.test.ts's.
 */

import { describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { AUTH, CLIENT, git, infoOf, sandboxManagerHarness, until } from "./fixtures/sandbox-manager-harness.js";

const t = sandboxManagerHarness();

describe("push, decided by the session", () => {
  it("autonomous: a protected branch, or a missing remote, is refused at once, with no card; audited and said", async () => {
    const m = t.newManager();
    const { info, session } = await t.autonomous(m);
    const asked = t.dialogs(m, info?.name as string);
    expect(await session.push({})).toBe("Refused: main is a protected branch (sandbox.push.protectedBranches): push your work to a branch of its own, and open a pull request.");
    git(["checkout", "-q", "-b", "feature/x"], t.workdir);
    expect(await session.push({})).toContain("there is no remote named origin");
    expect(asked).toHaveLength(0);
    expect(t.audits.filter((a) => a.action === "session.push_request")).toHaveLength(2);
    expect(t.audits.filter((a) => a.action === "session.push_refused").map((a) => a.detail)).toEqual([
      expect.stringContaining("main is a protected branch"),
      expect.stringContaining("no remote named origin"),
    ]);
  });

  it("guarded: the owner is asked, the card naming the branch, the commit and where to; a no is a refusal the agent reads", async () => {
    const m = t.newManager();
    const info = infoOf(await t.create(m));
    const session = m.findByName(info?.name as string, AUTH);
    if (!session) throw new Error("no session");
    await session.ensureSandbox();
    git(["checkout", "-q", "-b", "feature/y"], t.workdir);
    writeFileSync(join(t.workdir, "y.txt"), "y\n");
    git(["add", "."], t.workdir);
    git(["commit", "-qm", "y"], t.workdir);
    git(["remote", "add", "origin", "https://git.example.invalid/team/repo.git"], t.workdir);
    const asked = t.dialogs(m, info?.name as string);
    const pending = session.push({ reason: "open a PR" });
    await until(() => asked.length > 0);
    expect(asked[0]?.title).toBe("The agent asks to push feature/y");
    expect(asked[0]?.message).toContain("https://git.example.invalid/team/repo.git");
    expect(asked[0]?.message).toContain("Its reason: open a PR");
    await m.handle({ type: "session.ui_response", id: "u", sessionId: info?.id as string, requestId: asked[0]?.requestId as string, confirmed: false } as never, AUTH, CLIENT);
    expect(await pending).toBe("Refused: the owner declined.");
    expect(t.audits.some((a) => a.action === "session.push_denied")).toBe(true);
    // A second call while none is running is decided afresh.
    const again = session.push({});
    await until(() => asked.length > 1);
    await m.handle({ type: "session.ui_response", id: "u2", sessionId: info?.id as string, requestId: asked[1]?.requestId as string, confirmed: false } as never, AUTH, CLIENT);
    expect(await again).toContain("Refused");
  });
});
