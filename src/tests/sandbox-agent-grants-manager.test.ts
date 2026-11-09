/**
 * #448 round 13, through the real SessionManager with a mock backend and a
 * fake provider (the real-bwrap side is sandbox-agent-grants-real.test.ts):
 *
 *   - an added directory the agent added itself (autonomous
 *     `request_directory`) keeps a project root's credential hiding, kept
 *     with the setting (`agentDirs`) across a restart; one the owner added
 *     (or approved) is the session's own, and the owner's card says its
 *     credentials become readable; the owner may add an agent's as theirs;
 *   - an autonomous grant never touches another session's checkout (its
 *     workspace, inside it, holding it), a checkout in a worktree location
 *     (forks, loops, `--worktree`), or another checkout of the session's own
 *     repository; the owner's card warns of the same.
 */

import { describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AUTH, CLIENT, git, infoOf, sandboxManagerHarness, until } from "./fixtures/sandbox-manager-harness.js";

const t = sandboxManagerHarness();

describe("an autonomous grant never unhides credentials (#448 round 13)", () => {
  it("the agent's own added dir keeps the root's credential hiding (kept across a restart); the owner's card says theirs become readable; the owner may add it as theirs", async () => {
    const m = t.newManager();
    const { info, session } = await t.autonomous(m);
    const reply = await session.requestDirectory({ path: t.sibling, reason: "fix the client too" });
    expect(reply).toContain(`Added: ${t.sibling}`);
    expect(reply).toContain("Its credential files (.env files, keys, a token in a git config) stay hidden to you");
    expect(session.sandboxSetting?.agentDirs).toEqual([t.sibling]);
    expect(t.audits.find((a) => a.action === "session.sandbox_dir_added")?.detail).toContain(`${t.sibling} by=agent`);
    // Applied at the next turn: its commands' spec writes the sibling, and its .env stays hidden.
    await session.send("go", AUTH);
    await until(() => session.toInfo().status === "idle");
    expect(session.toInfo().sandbox?.addedDirs).toEqual([t.sibling]);
    const spec = t.runtimeSpec();
    expect(spec?.writable).toContain(t.sibling);
    expect(spec?.hidden).toContain(join(t.sibling, ".env"));
    // The restart keeps who added it.
    await t.transcript.flush();
    const meta = JSON.parse(readFileSync(join(t.tmp, "data", "transcripts", `${info?.id}.meta.json`), "utf8")) as { sandbox?: { agentDirs?: string[] } };
    expect(meta.sandbox?.agentDirs).toEqual([t.sibling]);

    // The owner adds it as theirs: asked, the card saying its credentials become readable.
    const asked = t.dialogs(m, info?.name as string);
    expect(await m.handle({ type: "session.sandbox_dir", id: "d", sessionId: info?.id as string, action: "add", path: t.sibling }, AUTH, CLIENT)).toMatchObject({ type: "response.ok", data: { pending: true } });
    await until(() => asked.length > 0);
    expect(asked[0]?.message).toContain("credential files (.env files, keys, a token in a git config) become readable");
    await m.handle({ type: "session.ui_response", id: "u", sessionId: info?.id as string, requestId: asked[0]?.requestId as string, confirmed: true } as never, AUTH, CLIENT);
    await until(() => session.sandboxSetting?.agentDirs === undefined);
    expect(session.sandboxSetting?.addedDirs).toEqual([t.sibling]);
    await t.sendWhenReady(session, "again");
    await until(() => session.toInfo().status === "idle");
    expect(t.runtimeSpec()?.writable).toContain(t.sibling);
    expect(t.runtimeSpec()?.hidden).not.toContain(join(t.sibling, ".env"));
  });

  it("guarded: the owner approving the agent's request is the owner's grant (its card says the credentials become readable)", async () => {
    const m = t.newManager();
    const info = infoOf(await t.create(m));
    const session = m.findByName(info?.name as string, AUTH);
    if (!session) throw new Error("no session");
    await session.ensureSandbox();
    const asked = t.dialogs(m, info?.name as string);
    const pending = session.requestDirectory({ path: t.sibling, reason: "r" });
    await until(() => asked.length > 0);
    expect(asked[0]?.message).toContain("become readable to its commands");
    await m.handle({ type: "session.ui_response", id: "u", sessionId: info?.id as string, requestId: asked[0]?.requestId as string, confirmed: true } as never, AUTH, CLIENT);
    expect(await pending).not.toContain("stay hidden");
    expect(session.sandboxSetting?.addedDirs).toEqual([t.sibling]);
    expect(session.sandboxSetting?.agentDirs).toBeUndefined();
  });
});

describe("an autonomous grant never touches another session's or codeoid's checkouts (#448 round 13)", () => {
  it("another session's workspace, a dir inside it, a dir holding it: refused; the owner's card warns", async () => {
    const m = t.newManager();
    // Another session works in the sibling.
    const other = infoOf(await m.handle({ type: "session.create", id: "o", name: "other", workdir: t.sibling } as never, AUTH, CLIENT));
    expect(other?.id).toBeTruthy();
    const { info, session } = await t.autonomous(m);
    mkdirSync(join(t.sibling, "src"), { recursive: true });
    for (const path of [t.sibling, join(t.sibling, "src")]) {
      const r = await session.requestDirectory({ path, reason: "r" });
      expect(r).toContain("Refused:");
      expect(r).toContain(`session "other"'s workspace`);
    }
    expect(session.sandboxSetting?.addedDirs).toBeUndefined();
    // The owner may add it, warned.
    const asked = t.dialogs(m, info?.name as string);
    await m.handle({ type: "session.sandbox_dir", id: "d", sessionId: info?.id as string, action: "add", path: t.sibling }, AUTH, CLIENT);
    await until(() => asked.length > 0);
    expect(asked[0]?.message).toContain(`Warning: ${t.sibling} is session "other"'s workspace`);
  });

  it("a checkout in a worktree location (a fork's, a loop's), and the session's own main checkout from its worktree: refused", async () => {
    const m = t.newManager();
    // A loop's checkout of the sibling, beside it in codeoid's location.
    const loopCheckout = join(t.root, "sibling-worktrees", "loop-run-abcd1234");
    mkdirSync(join(t.root, "sibling-worktrees"), { recursive: true });
    git(["worktree", "add", "-q", loopCheckout, "-b", "loop"], t.sibling);
    const { session } = await t.autonomous(m);
    const r = await session.requestDirectory({ path: loopCheckout, reason: "r" });
    expect(r).toContain("Refused:");
    expect(r).toContain("a worktree location");
    // A session in a fork's worktree of `work` asks for `work` itself (its parent's main checkout).
    const forkCheckout = join(t.root, "work-worktrees", "fork-1");
    mkdirSync(join(t.root, "work-worktrees"), { recursive: true });
    git(["worktree", "add", "-q", forkCheckout, "-b", "fork"], t.workdir);
    const fork = await t.autonomous(m, { workdir: forkCheckout });
    const main = await fork.session.requestDirectory({ path: t.workdir, reason: "r" });
    expect(main).toContain("Refused:");
    expect(main).toMatch(/another checkout of this session's own repository|session ".*"'s workspace/);
  });
});
