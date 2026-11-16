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
    expect(await session.push({})).toContain("there is no remote named origin");
    git(["remote", "add", "origin", "https://git.example.invalid/team/repo.git"], t.workdir);
    expect(await session.push({})).toBe("Refused: main is a protected branch (sandbox.push.protectedBranches): push your work to a branch of its own, and open a pull request.");
    expect(asked).toHaveLength(0);
    expect(t.audits.filter((a) => a.action === "session.push_request")).toHaveLength(2);
    expect(t.audits.filter((a) => a.action === "session.push_refused").map((a) => a.detail)).toEqual([
      expect.stringContaining("no remote named origin"),
      expect.stringContaining("main is a protected branch"),
    ]);
  });

  it("round 1: a repository the agent makes in a workspace that wasn't one is never pushed from (its config isn't held)", async () => {
    const plain = join(t.workdir, "..", "plain");
    mkdirSync(plain, { recursive: true });
    const m = t.newManager();
    const { session } = await t.autonomous(m, { workdir: plain });
    await session.send("go", AUTH);
    await until(() => session.toInfo().status === "idle");
    // What the agent's commands could do in there: a repository of its own, with a remote of its choosing.
    git(["init", "-q", "-b", "feature/z"], plain);
    writeFileSync(join(plain, "z.txt"), "z\n");
    git(["add", "."], plain);
    git(["commit", "-qm", "z"], plain);
    git(["remote", "add", "origin", "https://git.example.invalid/victim/other.git"], plain);
    const r = await session.push({});
    expect(r).toStartWith("Refused:");
    expect(r).toMatch(/aren't held read-only|wasn't a git repository when it began|made where an agent worked/);
    expect(t.audits.some((a) => a.action === "session.push_done" || a.action === "session.push_failed")).toBe(false);
  });

  it("round 2: a repository an agent made in an earlier session's workspace is refused in a later one", async () => {
    const plain = join(t.workdir, "..", "plain2");
    mkdirSync(plain, { recursive: true });
    const m = t.newManager();
    // Session 1 works there while it isn't a repository (its first turn notes that).
    const first = await t.autonomous(m, { workdir: plain });
    await first.session.send("go", AUTH);
    await until(() => first.session.toInfo().status === "idle");
    // Its agent makes one.
    git(["init", "-q", "-b", "feature/z"], plain);
    writeFileSync(join(plain, "z.txt"), "z\n");
    git(["add", "."], plain);
    git(["commit", "-qm", "z"], plain);
    git(["remote", "add", "origin", "https://git.example.invalid/victim/other.git"], plain);
    // Session 2, later, in the same place.
    const second = await t.autonomous(m, { workdir: plain });
    await second.session.send("go", AUTH);
    await until(() => second.session.toInfo().status === "idle");
    // Nothing an agent made decides anything: the owner never trusted pushes from there.
    const r = await second.session.push({});
    expect(r).toContain("the owner hasn't trusted agent pushes from this repository");
  });

  it("round 3: once the owner trusts the repository's remote, an autonomous push goes ahead; .gitattributes and branch tracking don't matter; a changed URL needs trusting again", async () => {
    git(["remote", "add", "origin", "https://git.example.invalid/team/repo.git"], t.workdir);
    const m = t.newManager();
    const { session } = await t.autonomous(m);
    // Not trusted yet: refused, saying how.
    git(["checkout", "-q", "-b", "feature/first"], t.workdir);
    expect(await session.push({})).toContain("codeoid sandbox trust-push");
    expect(await m.handle({ type: "sandbox.trust_push", id: "tp", action: "trust", path: t.workdir } as never, AUTH, CLIENT)).toMatchObject({ type: "response.ok", data: { remote: "origin" } });
    expect(t.audits.some((a) => a.action === "sandbox.push_trusted")).toBe(true);
    await session.send("go", AUTH);
    await until(() => session.toInfo().status === "idle");
    git(["checkout", "-q", "-b", "feature/attr"], t.workdir);
    writeFileSync(join(t.workdir, ".gitattributes"), "*.png binary\n");
    git(["add", "."], t.workdir);
    git(["commit", "-qm", "attrs"], t.workdir);
    git(["config", "branch.feature/attr.remote", "origin"], t.workdir);
    await t.sendWhenReady(session, "again");
    await until(() => session.toInfo().status === "idle");
    // Gets past every trust check to the remote lookup (no network here: autonomous mode refuses an unknown default).
    expect(await session.push({})).toContain("which branch is its default");
    git(["remote", "set-url", "origin", "https://elsewhere.example.invalid/x.git"], t.workdir);
    expect(await session.push({})).toContain("the owner hasn't trusted agent pushes from this repository to https://elsewhere.example.invalid/x.git");
    // A delegated token can't trust anything.
    const delegated = { ...AUTH, delegationDepth: 1 };
    expect(await m.handle({ type: "sandbox.trust_push", id: "tp2", action: "trust", path: t.workdir } as never, delegated, CLIENT)).toMatchObject({ type: "response.error", code: "forbidden" });
  });

  it("round 4: a trust is its owner's; it can always be taken back, whatever state the repository is in", async () => {
    git(["remote", "add", "origin", "https://git.example.invalid/team/repo.git"], t.workdir);
    const m = t.newManager();
    const { session } = await t.autonomous(m);
    git(["checkout", "-q", "-b", "feature/o"], t.workdir);
    // Another user's trust decides nothing for this owner's session.
    const other = { ...AUTH, sub: "user:someone-else" };
    expect(await m.handle({ type: "sandbox.trust_push", id: "t1", action: "trust", path: t.workdir } as never, other, CLIENT)).toMatchObject({ type: "response.ok" });
    expect(await session.push({})).toContain("the owner hasn't trusted");
    // The owner's own does; then the remote goes away, and taking it back still works.
    expect(await m.handle({ type: "sandbox.trust_push", id: "t2", action: "trust", path: t.workdir } as never, AUTH, CLIENT)).toMatchObject({ type: "response.ok" });
    expect(await session.push({})).not.toContain("the owner hasn't trusted");
    git(["remote", "remove", "origin"], t.workdir);
    expect(await m.handle({ type: "sandbox.trust_push", id: "t3", action: "untrust", path: t.workdir } as never, AUTH, CLIENT)).toMatchObject({ type: "response.ok", data: { removed: true } });
    const listed = (await m.handle({ type: "sandbox.trust_push", id: "l", action: "list" } as never, AUTH, CLIENT)) as { data?: { trusts: unknown[] } };
    expect(listed.data?.trusts).toEqual([]);
  });

  it("round 2: a drain during the plan stops it before anything is pushed; push isn't listed where it's off", async () => {
    git(["remote", "add", "origin", "https://git.example.invalid/team/repo.git"], t.workdir);
    const m = t.newManager();
    const { session } = await t.autonomous(m);
    await session.send("go", AUTH);
    await until(() => session.toInfo().status === "idle");
    git(["checkout", "-q", "-b", "feature/d"], t.workdir);
    await m.handle({ type: "sandbox.trust_push", id: "tp", action: "trust", path: t.workdir } as never, AUTH, CLIENT);
    const pending = session.push({});
    session.beginDrain();
    const r = await pending;
    expect(r).toStartWith("Refused:");
    expect(t.audits.some((a) => a.action === "session.push_done" || a.action === "session.push_failed")).toBe(false);
    expect(session.pushOffered).toBe(true);
  });

  it("guarded: the owner is asked, the card naming the branch, the commit and where to; a no is a refusal the agent reads", async () => {
    // The remote is the owner's, set before the session began (a config written since decides nothing).
    git(["remote", "add", "origin", "https://git.example.invalid/team/repo.git"], t.workdir);
    await Bun.sleep(5);
    const m = t.newManager();
    const info = infoOf(await t.create(m));
    const session = m.findByName(info?.name as string, AUTH);
    if (!session) throw new Error("no session");
    await session.send("go", AUTH);
    await until(() => session.toInfo().status === "idle");
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
    expect(asked[0]?.message).toContain("You haven't trusted agent pushes from this repository to this URL yet");
    await m.handle({ type: "session.ui_response", id: "u", sessionId: info?.id as string, requestId: asked[0]?.requestId as string, value: "Don't push" } as never, AUTH, CLIENT);
    expect(await pending).toBe("Refused: the owner declined.");
    expect(t.audits.some((a) => a.action === "session.push_denied")).toBe(true);
    // A second call while none is running is decided afresh.
    const again = session.push({});
    await until(() => asked.length > 1);
    // The owner pushes and trusts: the trust is recorded (the push itself fails here: no network).
    await m.handle({ type: "session.ui_response", id: "u2", sessionId: info?.id as string, requestId: asked[1]?.requestId as string, value: "Push, and trust https://git.example.invalid/team/repo.git for this repository's agent pushes (autonomous mode too)" } as never, AUTH, CLIENT);
    expect(await again).toStartWith("Failed:");
    expect(t.audits.some((a) => a.action === "session.push_trusted")).toBe(true);
    const listed = (await m.handle({ type: "sandbox.trust_push", id: "l", action: "list" } as never, AUTH, CLIENT)) as { data?: { trusts: Array<{ url: string }> } };
    expect(listed.data?.trusts.map((x) => x.url)).toEqual(["https://git.example.invalid/team/repo.git"]);
  });
});
