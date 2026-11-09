/**
 * Every directory the sandbox binds by name is pinned (#448 round 13,
 * docs/sandbox.md "Directories bound by name are pinned"), through the real
 * SessionManager with a scriptable mock backend and a fake provider (the
 * real-bwrap side is sandbox-pins-real.test.ts): an added dir swapped for a
 * link mid-turn refuses the turn's next tool call at the gate (said once,
 * audited) and is dropped at the next turn; the workspace swapped starts no
 * turn, turn after turn, and no spec is built over it.
 */

import { describe, expect, it } from "bun:test";
import { mkdirSync, renameSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { AUTH, BASH_CALL, CLIENT, DONE, infoOf, sandboxManagerHarness, until } from "./fixtures/sandbox-manager-harness.js";

const t = sandboxManagerHarness();

describe("every directory the sandbox binds by name is pinned (#448 round 13)", () => {
  it("an added dir swapped for a link mid-turn: the turn's next tool call refused at the gate (said once, audited); the next turn starts with it dropped (said)", async () => {
    const m = t.newManager();
    // The backend's first turn makes two Bash calls; the first waits on the owner (guarded).
    t.script = [[BASH_CALL("a"), BASH_CALL("b"), DONE], [BASH_CALL("c"), DONE]];
    const info = infoOf(await t.create(m, { sandbox: { addedDirs: [t.sibling] } }));
    const session = m.findByName(info?.name as string, AUTH);
    if (!session) throw new Error("no session");
    await session.ensureSandbox();
    expect(session.sandboxSetting?.pins?.ids[t.sibling]).toMatch(/^\d+:\d+@/);
    const lines = t.infoLines(m, info?.name as string);
    void session.send("go", AUTH);
    await until(() => session.pendingToolApprovals().length > 0);
    // Meanwhile, something that writes its parent swaps it for a link to a dir of yours.
    const elsewhere = join(t.tmp, "elsewhere");
    mkdirSync(elsewhere);
    renameSync(t.sibling, join(t.tmp, "moved"));
    symlinkSync(elsewhere, t.sibling);
    await m.handle({ type: "session.approve", id: "a", sessionId: info?.id as string, approvalId: session.pendingToolApprovals()[0]?.approvalId as string, approve: true } as never, AUTH, CLIENT);
    await until(() => t.decisions().length > 1);
    const refused = t.decisions()[1] as { behavior: string; message?: string };
    expect(refused.behavior).toBe("deny");
    expect(refused.message).toContain(`added directory ${t.sibling} is reached through a symbolic link now`);
    expect(refused.message).toContain("isn't followed");
    await until(() => session.toInfo().status === "idle");
    expect(lines.filter((l) => l.includes("reached through a symbolic link now")).length).toBe(1);
    expect(t.audits.some((a) => a.action === "session.sandbox_pin_refuse")).toBe(true);
    // The next turn starts with it dropped (said); its call is asked about as any is (guarded), not refused.
    void t.sendWhenReady(session, "again");
    await until(() => session.pendingToolApprovals().length > 0);
    expect(session.pendingToolApprovals()[0]?.toolName).toBe("Bash");
    expect(t.decisions()).toHaveLength(2);
    expect(session.toInfo().sandbox?.addedDirs).toBeUndefined();
    expect(lines.some((l) => l.includes(`${t.sibling} is no longer writable: it is no longer the directory it was when added: it is reached through a symbolic link now`))).toBe(true);
    expect(t.runtimeSpec()?.writable).not.toContain(t.sibling);
    expect(t.runtimeSpec()?.writable).not.toContain(elsewhere);
  });

  it("the workspace swapped for a link (to a planted home): no turn starts, turn after turn; no spec is built over it", async () => {
    const m = t.newManager();
    const info = infoOf(await t.create(m));
    const session = m.findByName(info?.name as string, AUTH);
    if (!session) throw new Error("no session");
    await session.ensureSandbox();
    expect(session.sandboxSetting?.pins?.workspace).toBe(t.workdir);
    const lines = t.infoLines(m, info?.name as string);
    const fakeHome = join(t.tmp, "fake-home");
    mkdirSync(join(fakeHome, ".ssh"), { recursive: true });
    renameSync(t.workdir, join(t.tmp, "work-moved"));
    symlinkSync(fakeHome, t.workdir);
    for (const prompt of ["one", "two"]) {
      await expect(session.send(prompt, AUTH)).rejects.toThrow(`the workspace ${t.workdir} is reached through a symbolic link now`);
    }
    expect(t.decisions()).toHaveLength(0);
    expect(lines.filter((l) => l.includes(`the workspace ${t.workdir} is reached through a symbolic link now`)).length).toBe(1);
    expect(t.audits.some((a) => a.action === "session.sandbox_refused" && a.detail.includes("the workspace"))).toBe(true);
    expect(() => t.runtimeSpec()).toThrow("the workspace");
  });
});

describe("everything the sandbox binds by name is checked at the gate (#448 round 14)", () => {
  it("a path held read-only in an added dir swapped for a link mid-turn (by another session's command, or on the host): the next tool call refused at the gate (said once, audited), never re-pinned silently", async () => {
    const m = t.newManager();
    t.script = [[BASH_CALL("a"), BASH_CALL("b"), DONE], [BASH_CALL("c"), DONE]];
    const info = infoOf(await t.create(m, { sandbox: { addedDirs: [t.sibling] } }));
    const session = m.findByName(info?.name as string, AUTH);
    if (!session) throw new Error("no session");
    await session.ensureSandbox();
    const held = join(t.sibling, ".claude");
    expect(t.runtimeSpec()?.pins?.find((p) => p.path === held)?.what).toBe("a path held read-only");
    const lines = t.infoLines(m, info?.name as string);
    void session.send("go", AUTH);
    await until(() => session.pendingToolApprovals().length > 0);
    // Meanwhile, something outside this session's sandbox swaps the held settings dir for a link.
    const elsewhere = join(t.tmp, "planted-claude");
    mkdirSync(elsewhere);
    renameSync(held, join(t.tmp, "claude-moved"));
    symlinkSync(elsewhere, held);
    await m.handle({ type: "session.approve", id: "a", sessionId: info?.id as string, approvalId: session.pendingToolApprovals()[0]?.approvalId as string, approve: true } as never, AUTH, CLIENT);
    await until(() => t.decisions().length > 1);
    const refused = t.decisions()[1] as { behavior: string; message?: string };
    expect(refused.behavior).toBe("deny");
    expect(refused.message).toContain(`a path held read-only ${held} is reached through a symbolic link now`);
    await until(() => session.toInfo().status === "idle");
    expect(lines.filter((l) => l.includes(`a path held read-only ${held} is reached through a symbolic link now`)).length).toBe(1);
    expect(t.audits.some((a) => a.action === "session.sandbox_pin_changed" && a.detail.includes(held))).toBe(true);
    // The next turn's resolution looks again: the link isn't held (nor bound) there, the turn runs.
    void t.sendWhenReady(session, "again");
    await until(() => session.pendingToolApprovals().length > 0);
    expect(t.runtimeSpec()?.readOnly).not.toContain(held);
    expect(t.runtimeSpec()?.readOnly).not.toContain(elsewhere);
  });
});
