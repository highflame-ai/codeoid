/**
 * The git gateway through the real SessionManager (a mock backend, a sandboxed session; the harness's provider runs
 * commands as they are, with the spec's env): a remote the owner connects is reached by the agent's own git; guarded
 * mode asks the owner per push; an unconnected remote is offered to the owner in guarded mode and refused in
 * autonomous mode; only the owner, undelegated, connects. The remote is a local bare repository (file://,
 * a test-only allowance).
 */
import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { AUTH, CLIENT, git, infoOf, sandboxManagerHarness, until } from "./fixtures/sandbox-manager-harness.js";

// The test-only allowance: a local bare repository as a connected remote (file://).
process.env.CODEOID_GIT_GATEWAY_TEST_FILE = "1";
const t = sandboxManagerHarness();

function upstreamRepo(): string {
  const up = join(t.tmp, "upstream.git");
  git(["init", "-q", "--bare", "-b", "main", up], t.tmp);
  git(["remote", "add", "origin", `file://${up}`], t.workdir);
  git(["push", "-q", "origin", "main"], t.workdir);
  return up;
}

/** The agent's git, as a sandboxed command runs it: the session's spec env (here unsandboxed: the harness's provider). */
async function agentGit(args: string[]): Promise<{ code: number; out: string }> {
  const spec = t.runtimeSpec();
  if (!spec) throw new Error("no spec");
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: join(t.tmp, "home"), GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "a", GIT_AUTHOR_EMAIL: "a@a", GIT_COMMITTER_NAME: "a", GIT_COMMITTER_EMAIL: "a@a", ...(spec.env ?? {}) };
  const p = Bun.spawn(["git", ...args], { cwd: t.workdir, env, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out: out + err };
}

const commitOn = (branch: string) => {
  git(["checkout", "-q", "-B", branch], t.workdir);
  writeFileSync(join(t.workdir, `${branch.replace(/\//g, "-")}.txt`), `${branch}\n`);
  git(["add", "."], t.workdir);
  git(["commit", "-qm", branch], t.workdir);
};
const refOf = (up: string, ref: string) => {
  try {
    return execFileSync("git", ["-C", up, "rev-parse", "--verify", "-q", ref], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
};

describe("the git gateway, decided by the session", () => {
  it("autonomous: a connected remote takes the agent's own push of its branch; main is refused; audited and said", async () => {
    const up = upstreamRepo();
    const m = t.newManager();
    // Only the owner, undelegated, with settings:write, connects.
    expect(await m.handle({ type: "sandbox.git_connect", id: "c0", action: "connect", path: t.workdir } as never, { ...AUTH, delegationDepth: 1 }, CLIENT)).toMatchObject({ type: "response.error", code: "forbidden" });
    expect(await m.handle({ type: "sandbox.git_connect", id: "c1", action: "connect", path: t.workdir } as never, AUTH, CLIENT)).toMatchObject({ type: "response.ok", data: { kind: "ssh" } });
    expect(t.audits.some((a) => a.action === "sandbox.git_connected")).toBe(true);
    const { session } = await t.autonomous(m);
    await session.send("go", AUTH);
    await until(() => session.toInfo().status === "idle");
    expect(t.runtimeSpec()?.gatewaySockets?.length).toBe(1);
    commitOn("feature/a");
    const r = await agentGit(["push", "origin", "feature/a"]);
    expect([r.code, r.out]).toEqual([0, expect.stringContaining("codeoid pushed feature/a")]);
    expect(refOf(up, "refs/heads/feature/a")).toBe(execFileSync("git", ["-C", t.workdir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim());
    await until(() => t.audits.some((a) => a.action === "session.git_push_done"));
    commitOn("main");
    const main = await agentGit(["push", "origin", "main"]);
    expect(main.code).not.toBe(0);
    expect(main.out).toContain("main is a protected branch");
    await until(() => t.audits.some((a) => a.action === "session.git_push_refused"));
    // Listed for its owner; disconnected, the agent's git no longer reaches it.
    const listed = (await m.handle({ type: "sandbox.git_connect", id: "l", action: "list" } as never, AUTH, CLIENT)) as { data?: { connections: Array<{ url: string }> } };
    expect(listed.data?.connections.map((c) => c.url)).toEqual([expect.stringContaining("upstream.git")]);
    expect(await m.handle({ type: "sandbox.git_connect", id: "d", action: "disconnect", path: t.workdir } as never, AUTH, CLIENT)).toMatchObject({ type: "response.ok", data: { removed: true } });
    commitOn("feature/b");
    const after = await agentGit(["push", "origin", "feature/b"]);
    expect(after.code).not.toBe(0);
    expect(after.out).toContain("isn't connected for agents");
    expect(refOf(up, "refs/heads/feature/b")).toBe("");
  });

  it("guarded: an unconnected remote is offered to the owner; each push is asked; a no is a refusal the agent's git reads", async () => {
    const up = upstreamRepo();
    const m = t.newManager();
    // The owner connected another remote (the gateway is only for an owner who did); the network off: the
    // workspace's own remotes go through the gateway, connected or not.
    const other = join(t.tmp, "other.git");
    git(["init", "-q", "--bare", "-b", "main", other], t.tmp);
    git(["push", "-q", `file://${other}`, "main"], t.workdir);
    expect(await m.handle({ type: "sandbox.git_connect", id: "c-other", action: "connect", url: `file://${other}` } as never, AUTH, CLIENT)).toMatchObject({ type: "response.ok" });
    const info = infoOf(await t.create(m, { sandbox: { network: "off" } }));
    const session = m.findByName(info?.name as string, AUTH);
    if (!session) throw new Error("no session");
    await session.ensureSandbox();
    await session.send("go", AUTH);
    await until(() => session.toInfo().status === "idle");
    const asked = t.dialogs(m, info?.name as string);
    commitOn("feature/g");
    const answer = async (n: number, confirmed: boolean) => {
      await until(() => asked.length > n);
      await m.handle({ type: "session.ui_response", id: `u${n}`, sessionId: info?.id as string, requestId: asked[n]?.requestId as string, confirmed } as never, AUTH, CLIENT);
    };
    const pushing = agentGit(["push", "origin", "feature/g"]);
    // Round 12: connecting is a settings change: the owner's token without settings:write can't say yes to it.
    await until(() => asked.length > 0);
    const noSettings = { ...AUTH, scopes: (AUTH.scopes as string[]).filter((s) => s !== "settings:write") };
    expect(await m.handle({ type: "session.ui_response", id: "u-ns", sessionId: info?.id as string, requestId: asked[0]?.requestId as string, confirmed: true } as never, noSettings as never, CLIENT)).toMatchObject({ type: "response.error", code: "forbidden" });
    // First the connection (the remote isn't connected), then the push itself.
    await answer(0, true);
    expect(asked[0]?.title).toContain("reached for");
    await answer(1, true);
    expect(asked[1]?.message).toContain("feature/g");
    const r = await pushing;
    expect([r.code, r.out]).toEqual([0, expect.stringContaining("codeoid pushed feature/g")]);
    expect(refOf(up, "refs/heads/feature/g")).not.toBe("");
    // The next push: connected now, only the push is asked; declined.
    commitOn("feature/h");
    const declined = agentGit(["push", "origin", "feature/h"]);
    await answer(2, false);
    const d = await declined;
    expect(d.code).not.toBe(0);
    expect(d.out).toContain("the owner declined");
    expect(refOf(up, "refs/heads/feature/h")).toBe("");
    expect(t.audits.some((a) => a.action === "session.git_push_denied")).toBe(true);
  });

  it("round 2: a remote connected while a session runs reaches it at its next turn; a session a delegated token made gets none", async () => {
    const up = upstreamRepo();
    const m = t.newManager();
    const { session } = await t.autonomous(m);
    await session.send("go", AUTH);
    await until(() => session.toInfo().status === "idle");
    expect(t.runtimeSpec()?.gatewaySockets).toBeUndefined();
    expect(await m.handle({ type: "sandbox.git_connect", id: "c", action: "connect", path: t.workdir } as never, AUTH, CLIENT)).toMatchObject({ type: "response.ok" });
    await t.sendWhenReady(session, "again");
    await until(() => session.toInfo().status === "idle");
    expect(t.runtimeSpec()?.gatewaySockets?.length).toBe(1);
    commitOn("feature/late-connect");
    const r = await agentGit(["push", "origin", "feature/late-connect"]);
    expect([r.code, r.out]).toEqual([0, expect.stringContaining("codeoid pushed")]);
    expect(refOf(up, "refs/heads/feature/late-connect")).not.toBe("");
    // A session made with a delegated token: the owner's connections aren't its own.
    expect(session.gitAccessProblem("git-upload-pack")).toBeNull();
    const delegated = { ...AUTH, delegationDepth: 1 };
    const info = infoOf(await m.handle({ type: "session.create", id: "cd", name: "deleg", workdir: t.workdir } as never, delegated, { ...CLIENT, auth: delegated }));
    const d = info ? m.findByName(info.name, AUTH) : undefined;
    expect(d?.gitAccessProblem("git-upload-pack")).toContain("delegated token");
  });
});
