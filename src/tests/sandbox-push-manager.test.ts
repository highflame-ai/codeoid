/**
 * The sandbox's `push` through the real SessionManager (a mock backend, a
 * sandboxed session): autonomous mode decides with no card; guarded mode asks
 * the owner, who sees what would be pushed where; every request is audited
 * and said in the transcript. The push itself (planning, running against a
 * real bare remote) is sandbox-push.test.ts's.
 */

import { describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
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

  it("round 1: a repository the agent makes in a workspace that wasn't one is never pushed from (its config isn't held)", async () => {
    const plain = join(t.workdir, "..", "plain");
    mkdirSync(plain, { recursive: true });
    const m = t.newManager();
    const { session } = await t.autonomous(m, { workdir: plain });
    await session.ensureSandbox();
    // What the agent's commands could do in there: a repository of its own, with a remote of its choosing.
    git(["init", "-q", "-b", "feature/z"], plain);
    writeFileSync(join(plain, "z.txt"), "z\n");
    git(["add", "."], plain);
    git(["commit", "-qm", "z"], plain);
    git(["remote", "add", "origin", "https://git.example.invalid/victim/other.git"], plain);
    const r = await session.push({});
    expect(r).toStartWith("Refused:");
    expect(r).toMatch(/aren't held read-only|git settings changed|after this session began/);
    expect(t.audits.some((a) => a.action === "session.push_done" || a.action === "session.push_failed")).toBe(false);
  });

  it("guarded: the owner is asked, the card naming the branch, the commit and where to; a no is a refusal the agent reads", async () => {
    // The remote is the owner's, set before the session began (a config written since decides nothing).
    git(["remote", "add", "origin", "https://git.example.invalid/team/repo.git"], t.workdir);
    await Bun.sleep(5);
    const m = t.newManager();
    const info = infoOf(await t.create(m));
    const session = m.findByName(info?.name as string, AUTH);
    if (!session) throw new Error("no session");
    await session.ensureSandbox();
    git(["checkout", "-q", "-b", "feature/y"], t.workdir);
    writeFileSync(join(t.workdir, "y.txt"), "y\n");
    git(["add", "."], t.workdir);
    git(["commit", "-qm", "y"], t.workdir);
    const asked = t.dialogs(m, info?.name as string);
    const pending = session.push({ reason: "open a PR" });
    await until(() => asked.length > 0);
    expect(asked[0]?.title).toBe("The agent asks to push feature/y");
    expect(asked[0]?.message).toContain("https://git.example.invalid/team/repo.git");
    expect(asked[0]?.message).toContain("The agent's reason, in its own words:\n> open a PR");
    // The remote couldn't be asked which branch is its default (no network here): the card says so.
    expect(asked[0]?.message).toContain("make sure feature/y isn't it");
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
