/**
 * The working directory is pinned for the daemon's own work in it (#448
 * round 14, sandbox/pinned.ts): through the real SessionManager with a mock
 * backend and real git. A monorepo package session's working directory sits
 * inside what its commands write; one moved aside and replaced (by a link to
 * a planted "home", or by another real directory) is never snapshotted,
 * restored into, deleted from, forked from or read through: each is refused,
 * said on the session and audited, and what the link leads to is untouched.
 *
 * The swap is the test's own, on the host, between turns, against
 * directories it planted in its own scratch dir.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodeoidConfig } from "../config.js";
import type { ProviderEvent } from "../daemon/providers/interface.js";
import { MockSessionProvider } from "../daemon/providers/mock/session-provider.js";
import { SessionManager } from "../daemon/session-manager.js";
import { Store } from "../daemon/store.js";
import { TranscriptStore } from "../daemon/transcript.js";
import { ALL_SCOPES } from "../protocol/scopes.js";
import type { AuthContext, DaemonMessage, SessionMessage, SessionTurnsResultMsg } from "../protocol/types.js";

const AUTH: AuthContext = { sub: "user:pinned", scopes: [...ALL_SCOPES] as AuthContext["scopes"], delegationDepth: 0, accountId: "acc-p", projectId: "proj-p" };
const CLIENT = { id: "cli", auth: AUTH, send: () => {} };

function say(text: string): ProviderEvent[] {
  return [
    { type: "text_done", content: text } as ProviderEvent,
    { type: "turn_done", result: { providerId: "claude", model: "mock", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, totalCostUsd: 0, durationMs: 1 } } as ProviderEvent,
  ];
}

function mkConfig(tmp: string): CodeoidConfig {
  return {
    daemonUrl: "ws://127.0.0.1:7400",
    dbPath: join(tmp, "codeoid.db"),
    transcriptDir: join(tmp, "transcripts"),
    auth: { baseUrl: "http://localhost:8899" },
    zeroidUrl: "http://localhost:8899",
    workspaceIndex: { enabled: false, episodeThreshold: 5, timeThresholdMs: 60_000, debounceMs: 15_000 },
    compress: { enabled: false, excludeCommands: [], excludePatterns: [], compressPipes: false, minBytes: 1024 },
    labeling: {},
    telemetry: { osc8: "auto" },
    autoRotate: { enabled: false, warnPct: 0.6, rotatePct: 0.8, hardRotatePct: 0.9, minTurnsBeforeRotate: 3, strategy: "task-anchor" },
    session: {},
    conductor: { enabled: false, name: "conductor", provider: "claude" },
  } as CodeoidConfig;
}

let tmp: string;
let repo: string;
let app: string;
let victim: string;
let store: Store;
let transcript: TranscriptStore;
let managers: SessionManager[];
const audits: Array<{ action: string; detail: string }> = [];

function newManager(agentEdits: Array<(() => void) | undefined>): SessionManager {
  let turn = 0;
  const m = new SessionManager(store, transcript, undefined, undefined, undefined, {
    config: mkConfig(tmp),
    _testProviderFactory: () => {
      const p = new MockSessionProvider("claude", [say("a1"), say("a2"), say("a3")]);
      const run = p.runTurn.bind(p);
      p.runTurn = (opts) => {
        agentEdits[turn++]?.();
        return run(opts);
      };
      return p;
    },
  });
  managers.push(m);
  return m;
}

const git = (...args: string[]): string => execFileSync("git", args, { cwd: repo, encoding: "utf8" });

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "codeoid-pinned-workdir-")));
  repo = join(tmp, "mono");
  app = join(repo, "packages", "app");
  mkdirSync(app, { recursive: true });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  writeFileSync(join(app, "index.ts"), "export {};\n");
  git("add", ".");
  git("commit", "-qm", "init");
  // What a link could lead to: a planted "home" with a token and no shell startup file.
  victim = join(tmp, "victim-home");
  mkdirSync(join(victim, ".config", "gh"), { recursive: true });
  writeFileSync(join(victim, ".config", "gh", "hosts.yml"), "oauth_token: PLANTED-GH-TOKEN\n");
  store = new Store(join(tmp, "codeoid.db"));
  const audit = store.audit.bind(store);
  audits.length = 0;
  store.audit = ((sub: string, action: string, sessionId?: string, detail?: string) => {
    audits.push({ action, detail: detail ?? "" });
    return audit(sub, action, sessionId, detail);
  }) as typeof store.audit;
  transcript = new TranscriptStore(join(tmp, "transcripts"));
  managers = [];
});

afterEach(async () => {
  for (const m of managers) await m.drain(2_000).catch(() => {});
  await transcript.flush();
  rmSync(tmp, { recursive: true, force: true });
});

async function create(m: SessionManager): Promise<string> {
  const r = await m.handle({ type: "session.create", id: "c", name: `pw-${Math.random()}`, workdir: app }, AUTH, CLIENT);
  if (r.type !== "response.ok") throw new Error(JSON.stringify(r));
  return (r.data as { id: string }).id;
}

async function sendAndSettle(m: SessionManager, id: string, text: string): Promise<void> {
  const s = m._sessionForTest(id)!;
  await s.send(text, AUTH);
  for (let i = 0; i < 300 && s.status !== "idle"; i++) await Bun.sleep(10);
  expect(s.status).toBe("idle");
  // The end-of-turn snapshot, and its git, have run.
  await Bun.sleep(300);
}

async function turns(m: SessionManager, id: string): Promise<SessionTurnsResultMsg["turns"]> {
  const r = await m.handle({ type: "session.turns", id: "t", sessionId: id }, AUTH, CLIENT);
  if (r.type !== "session.turns.result") throw new Error(JSON.stringify(r));
  return r.turns;
}

function lines(m: SessionManager, id: string): string[] {
  const received: DaemonMessage[] = [];
  m._sessionForTest(id)!.attach({ id: `w-${Math.random()}`, auth: AUTH, send: (msg) => received.push(msg) });
  const replay = received.find((x) => x.type === "scrollback.replay") as { messages: SessionMessage[] } | undefined;
  return (replay?.messages ?? []).filter((x) => x.metadata?.event === "workdir.changed").map((x) => x.content);
}

/** Every file name any snapshot of the session holds. */
function snapshotted(id: string): string {
  const shadow = join(tmp, "transcripts", "checkpoints", `${id}.git`);
  if (!existsSync(shadow)) return "";
  const refs = execFileSync("git", ["--git-dir", shadow, "for-each-ref", "--format=%(objectname)", "refs/turns/"], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
  return refs.map((r) => execFileSync("git", ["--git-dir", shadow, "ls-tree", "-r", "--name-only", r], { encoding: "utf8" })).join("\n");
}

function victimUntouched(): void {
  expect(existsSync(join(victim, ".bashrc"))).toBe(false);
  expect(readFileSync(join(victim, ".config", "gh", "hosts.yml"), "utf8")).toBe("oauth_token: PLANTED-GH-TOKEN\n");
  expect(readdirSync(victim).sort()).toEqual([".config"]);
}

describe("the working directory, swapped under the session, is never followed (#448 round 14)", () => {
  it("swapped for a link: the end snapshot isn't taken of where it leads, going back a turn is refused (said, audited), what it leads to untouched", async () => {
    const m = newManager([
      // Turn 1: the agent leaves a file named like a shell startup file in its package dir.
      () => writeFileSync(join(app, ".bashrc"), "echo PLANTED-BY-REWIND\n"),
      // Turn 2: one command moves the package dir aside and puts a link to the "home" in its place.
      () => {
        renameSync(app, join(repo, "packages", "app.old"));
        symlinkSync(victim, app);
      },
    ]);
    const id = await create(m);
    await sendAndSettle(m, id, "one");
    await sendAndSettle(m, id, "two");
    // Nothing of where the link leads was copied into the session's snapshots.
    expect(snapshotted(id)).not.toContain("hosts.yml");
    expect(lines(m, id).some((l) => l.includes(`${app} changed under the session: it is reached through a symbolic link now`) && l.includes("a snapshot of the files refused"))).toBe(true);
    expect(audits.some((a) => a.action === "session.workdir_changed")).toBe(true);
    // Going back to before turn 2, files included: refused, nothing written or deleted there.
    const list = await turns(m, id);
    for (const dryRun of [true, false]) {
      const r = await m.handle({ type: "session.rewind", id: "rw", sessionId: id, turnId: list[1]!.turnId, restoreFiles: true, dryRun }, AUTH, CLIENT);
      expect(r.type).toBe("response.error");
      expect((r as { error: string }).error).toContain(`${app} changed under the session`);
      expect((r as { error: string }).error).toContain("going back a turn refused");
    }
    victimUntouched();
    // Its conversation stays as it was: nothing was taken back.
    expect((await turns(m, id)).length).toBe(2);
  });

  it("replaced by another real directory (moved aside, made again): refused the same, by its identity", async () => {
    const m = newManager([
      () => writeFileSync(join(app, "notes.md"), "turn one\n"),
      () => {
        renameSync(app, join(repo, "packages", "app.old"));
        mkdirSync(app);
        writeFileSync(join(app, "planted.md"), "planted\n");
      },
    ]);
    const id = await create(m);
    await sendAndSettle(m, id, "one");
    await sendAndSettle(m, id, "two");
    expect(snapshotted(id)).not.toContain("planted.md");
    const r = await m.handle({ type: "session.rewind", id: "rw", sessionId: id, turnId: (await turns(m, id))[1]!.turnId, restoreFiles: true }, AUTH, CLIENT);
    expect(r.type).toBe("response.error");
    expect((r as { error: string }).error).toContain("isn't the directory it was (another one is there now)");
    // The planted dir's file stays, the moved-aside one is untouched.
    expect(readFileSync(join(app, "planted.md"), "utf8")).toBe("planted\n");
    expect(readFileSync(join(repo, "packages", "app.old", "notes.md"), "utf8")).toBe("turn one\n");
  });

  it("swapped for a link: a fork from an earlier turn, and a client's file read, are refused; nothing of where it leads is copied", async () => {
    const m = newManager([
      () => writeFileSync(join(app, "notes.md"), "turn one\n"),
      () => {
        renameSync(app, join(repo, "packages", "app.old"));
        symlinkSync(victim, app);
      },
    ]);
    const id = await create(m);
    await sendAndSettle(m, id, "one");
    await sendAndSettle(m, id, "two");
    const before = readdirSync(tmp).sort();
    const f = await m.handle({ type: "session.fork", id: "f", sessionId: id, afterTurnId: (await turns(m, id))[0]!.turnId } as never, AUTH, CLIENT);
    expect(f.type).toBe("response.error");
    expect(JSON.stringify(f)).toContain("changed under the session");
    // No fork worktree was made beside the repository.
    expect(readdirSync(tmp).sort()).toEqual(before);
    const read = await m.handle({ type: "fs.read", id: "r", sessionId: id, path: ".config/gh/hosts.yml" } as never, AUTH, CLIENT);
    expect(read.type).toBe("response.error");
    expect(JSON.stringify(read)).not.toContain("PLANTED-GH-TOKEN");
    victimUntouched();
  });

  it("left as it was: snapshots, going back a turn and a fork's files work as before", async () => {
    const m = newManager([() => writeFileSync(join(app, "index.ts"), "export const x = 1;\n"), () => writeFileSync(join(app, "index.ts"), "export const x = 2;\n")]);
    const id = await create(m);
    await sendAndSettle(m, id, "one");
    await sendAndSettle(m, id, "two");
    const r = await m.handle({ type: "session.rewind", id: "rw", sessionId: id, turnId: (await turns(m, id))[1]!.turnId, restoreFiles: true }, AUTH, CLIENT);
    expect(r.type).toBe("session.rewind.result");
    expect(readFileSync(join(app, "index.ts"), "utf8")).toBe("export const x = 1;\n");
    expect(audits.some((a) => a.action === "session.workdir_changed")).toBe(false);
  });
});
