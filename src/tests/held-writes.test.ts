/**
 * File-tool writes into what a session's OS sandbox holds read-only
 * (held-writes.ts, #448): each backend's write tool, named and shaped as it
 * reaches the gate; the repository's git structure and the project settings
 * agent CLIs run code from, through links too. And, since autonomous mode
 * relies on the sandbox (#448), a write outside the working directory runs
 * unasked there: opencode end to end over the fake server.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { CodeoidConfig } from "../config.js";
import { heldWriteOf, heldWriteReason, writeTargets } from "../daemon/held-writes.js";
import { protectedWriteTargets } from "../daemon/sandbox/policy.js";
import type { ProviderEvent, SessionProvider } from "../daemon/providers/interface.js";
import { MockSessionProvider } from "../daemon/providers/mock/session-provider.js";
import { OpencodeProvider } from "../daemon/providers/opencode/index.js";
import { buildOpencodeEnv } from "../daemon/providers/opencode/policy.js";
import { OpencodeServer } from "../daemon/providers/opencode/server.js";
import { Session, type SessionCreateOptions } from "../daemon/session.js";
import { loadShellParser } from "../daemon/shell/parse.js";
import { Store } from "../daemon/store.js";
import { TranscriptStore } from "../daemon/transcript.js";
import type { AuthContext, SessionMessage, SessionMode } from "../protocol/types.js";

const FIXTURE = join(import.meta.dir, "fixtures", "fake-opencode.ts");
const AUTH: AuthContext = { sub: "u", scopes: [], delegationDepth: 0, accountId: "a", projectId: "p" };
const BASE_CONFIG = {
  workspaceIndex: { enabled: false, episodeThreshold: 5, timeThresholdMs: 60_000, debounceMs: 15_000 },
  compress: { enabled: false, excludeCommands: [], excludePatterns: [], compressPipes: false, minBytes: 1024 },
  labeling: {},
  telemetry: { osc8: "auto" },
  autoRotate: { enabled: false, warnPct: 0.6, rotatePct: 0.8, hardRotatePct: 0.9, minTurnsBeforeRotate: 3, strategy: "task-anchor" },
  session: {},
};

let root: string;
let workdir: string;
/** A directory beside the workdir: outside it, and not the temp dir's (the tests' own root is under /tmp). */
let elsewhere: string;
let store: Store;
let transcriptStore: TranscriptStore;
const sessions: Session[] = [];

beforeAll(async () => {
  await loadShellParser();
});

beforeEach(() => {
  // Outside the temp dir (the repository may be in it), so "outside the workdir" isn't also "inside the temp dir".
  root = realpathSync(mkdtempSync(join(homedir(), ".codeoid-test-held-writes-")));
  workdir = join(root, "work");
  elsewhere = join(root, "elsewhere");
  mkdirSync(join(workdir, "src"), { recursive: true });
  mkdirSync(elsewhere);
  symlinkSync(elsewhere, join(workdir, "out-link"));
  store = new Store(join(root, "codeoid.db"));
  transcriptStore = new TranscriptStore(join(root, "transcripts"));
});

afterEach(async () => {
  for (const s of sessions.splice(0)) await s.interrupt(AUTH).catch(() => {});
  try {
    await transcriptStore.flush();
  } catch {}
  try {
    store.close();
  } catch {}
  rmSync(root, { recursive: true, force: true });
});

describe("what each backend's write tool targets", () => {
  test("names the paths a write, edit, notebook edit, patch, file change or move writes; null for anything else", () => {
    expect(writeTargets("Write", { file_path: "/a" })).toEqual(["/a"]);
    expect(writeTargets("Edit", { file_path: "/a", files: ["/a", "/b"] })).toEqual(["/a", "/a", "/b"]);
    expect(writeTargets("NotebookEdit", { notebook_path: "/n.ipynb" })).toEqual(["/n.ipynb"]);
    expect(writeTargets("codex_file_change", { changes: [{ path: "a.txt", kind: "update" }, { path: "b.txt", kind: { type: "update", move_path: "/x/b.txt" } }] })).toEqual(["a.txt", "b.txt", "/x/b.txt"]);
    expect(writeTargets("codex_file_change", {})).toEqual([null]);
    expect(writeTargets("write", { path: "@src/a.ts" })).toEqual(["src/a.ts"]);
    expect(writeTargets("edit", { path: "src/a.ts" })).toEqual(["src/a.ts"]);
    expect(writeTargets("edit", { file_path: "/q/a.ts" })).toEqual(["/q/a.ts"]);
    expect(writeTargets("write_file", { file_path: "/q/a.ts" })).toEqual(["/q/a.ts"]);
    expect(writeTargets("notebook_edit", { notebook_path: "/q/n.ipynb" })).toEqual(["/q/n.ipynb"]);
    // The real Gemini CLI sends no input: a path can't be told.
    expect(writeTargets("acp_edit", {})).toEqual([null]);
    for (const read of ["Read", "Grep", "Glob", "read_file", "WebFetch", "Bash"]) expect(writeTargets(read, { file_path: "/a" })).toBeNull();
  });
});

function makeSession(provider: SessionProvider, mode: SessionMode): { session: Session; cards: SessionMessage[] } {
  const id = randomUUID();
  store.createSession({
    id, name: "hw", workdir, status: "idle", createdBy: AUTH.sub,
    createdAt: new Date().toISOString(), attachedClients: 0, accountId: AUTH.accountId, projectId: AUTH.projectId,
  });
  const opts: SessionCreateOptions = {
    name: "hw", workdir, auth: AUTH, store, transcriptStore, existingId: id, _testProvider: provider,
    initialMode: { mode, ...(mode === "autonomous" ? { maxTurns: 10 } : {}) },
    config: BASE_CONFIG as unknown as CodeoidConfig,
  };
  const session = new Session(opts);
  sessions.push(session);
  const cards: SessionMessage[] = [];
  session.attach({ id: "c", auth: AUTH, send: (m: { type: string; role?: string }) => { if (m.type === "session.message" && m.role === "tool_call") cards.push(structuredClone(m) as SessionMessage); } } as never);
  return { session, cards };
}

async function until(cond: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await Bun.sleep(5);
  }
}

type Card = { phase: string; risk?: { level: string; reasons: string[] } };

/** One call of `name`/`input` through a real Session's gate: whether it asked, its card, the budget after. */
async function gateCall(name: string, input: Record<string, unknown>, mode: SessionMode, opts: { unattended?: boolean } = {}) {
  const events: ProviderEvent[] = [
    { type: "tool_start", toolId: "t1", sdkToolUseId: "sdk-t1", name, input, approvalId: "ap-1" },
    { type: "turn_done", result: { providerId: "mock", model: "m", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, totalCostUsd: 0, durationMs: 1 } },
  ];
  const provider = new MockSessionProvider("mock", [events]);
  const { session, cards } = makeSession(provider, mode);
  const release = opts.unattended ? session.beginUnattended() : null;
  void session.send("go", AUTH);
  await until(() => provider.canUseToolResults.length > 0 || session.pendingToolApprovals().length > 0);
  const pending = session.pendingToolApprovals();
  const card = cards[0]?.tool?.state as Card | undefined;
  const status = session.status;
  const budget = session.turnsRemaining;
  if (pending.length > 0) await session.interrupt(AUTH);
  release?.();
  return { asked: pending.length > 0, pending, card, status, budget, behavior: provider.canUseToolResults[0]?.behavior };
}

describe("autonomous mode runs a write outside the working directory unasked: the OS sandbox is its boundary (#448)", () => {
  const outsideCalls = (workdir: string, elsewhere: string): Array<[string, string, Record<string, unknown>]> => [
    ["Claude Write", "Write", { file_path: join(elsewhere, "a.ts"), content: "x" }],
    ["Claude Edit", "Edit", { file_path: join(elsewhere, "a.ts"), old_string: "a", new_string: "b" }],
    ["Claude MultiEdit", "MultiEdit", { file_path: join(elsewhere, "a.ts"), edits: [] }],
    ["Claude NotebookEdit", "NotebookEdit", { notebook_path: join(elsewhere, "n.ipynb"), new_source: "" }],
    ["opencode patch", "Edit", { file_path: join(workdir, "src", "a.ts"), files: [join(workdir, "src", "a.ts"), join(elsewhere, "a.ts")], patch: "…" }],
    ["Codex file change", "codex_file_change", { changes: [{ path: join(elsewhere, "a.ts"), kind: "add", diff: "+x" }] }],
    ["pi write", "write", { path: "../elsewhere/a.ts", content: "x" }],
    ["pi edit", "edit", { path: "out-link/a.ts", edits: [] }],
    ["Qwen Code write_file", "write_file", { file_path: join(elsewhere, "a.ts"), content: "x" }],
    ["Qwen Code edit", "edit", { file_path: join(elsewhere, "a.ts"), old_string: "a", new_string: "b" }],
    ["Qwen Code notebook_edit", "notebook_edit", { notebook_path: join(elsewhere, "n.ipynb") }],
    ["Gemini CLI edit (no path given)", "acp_edit", {}],
    ["a shell redirect", "Bash", { command: `echo hi > ${join(elsewhere, "x")}` }],
    ["pi's shell", "bash", { command: `rm -f ${join(elsewhere, "x")}` }],
  ];

  for (const [label] of outsideCalls("/w", "/e")) {
    test(`${label}: runs unasked, spending budget, no outside-write reason anywhere`, async () => {
      // `workdir` and `elsewhere` are made per test.
      const [, n, i] = outsideCalls(workdir, elsewhere).find(([l]) => l === label)!;
      const r = await gateCall(n, i, "autonomous");
      expect([r.asked, r.behavior, r.card?.phase, r.budget]).toEqual([false, "allow", "executing", 9]);
    });
  }

  test("an unattended run doesn't park on one", async () => {
    const r = await gateCall("Write", { file_path: join(elsewhere, "a.ts"), content: "x" }, "autonomous", { unattended: true });
    expect([r.asked, r.behavior, r.status === "waiting_approval"]).toEqual([false, "allow", false]);
  });

  test("guarded mode is unchanged: a write asks as it always did, with no outside-write reason", async () => {
    const r = await gateCall("Write", { file_path: join(elsewhere, "a.ts"), content: "x" }, "guarded");
    expect(r.asked).toBe(true);
    expect(r.card?.risk).toBeUndefined();
  });
});

describe("opencode's write outside the working directory, end to end: autonomous mode runs it (#448)", () => {
  let server: OpencodeServer;
  let serverDir: string;
  beforeAll(() => {
    serverDir = mkdtempSync(join(tmpdir(), "codeoid-ow-srv-"));
    server = new OpencodeServer({ command: process.execPath, argsPrefix: [FIXTURE], dbPath: join(serverDir, "opencode.db"), env: () => buildOpencodeEnv(), userConfigDir: null });
  });
  afterAll(async () => {
    await server.stop();
    rmSync(serverDir, { recursive: true, force: true });
  });

  async function opencodeWrite(path: string, mode: SessionMode) {
    const provider = new OpencodeProvider({ sessionId: randomUUID(), initialBackingId: "ow", server, store: { setClaudeCodeSessionId: () => {} } as unknown as Store });
    const { session, cards } = makeSession(provider, mode);
    void session.send(`ask-write:${JSON.stringify({ path, content: "x" })}`, AUTH);
    await until(() => session.pendingToolApprovals().length > 0 || session.canonicalHistory.at(-1)?.role === "assistant");
    const pending = session.pendingToolApprovals();
    const card = cards.find((c) => c.tool?.name === "Write")?.tool?.state as Card | undefined;
    for (const p of pending) session.approve(p.approvalId, false, AUTH);
    await until(() => session.status === "idle" && session.canonicalHistory.at(-1)?.role === "assistant");
    return { asked: pending.length > 0, card, reply: String(session.canonicalHistory.at(-1)?.content ?? "") };
  }

  test("runs unasked in autonomous mode, through a link out of the workdir as inside it; guarded mode asks", async () => {
    const out = await opencodeWrite(join(workdir, "out-link", "a.ts"), "autonomous");
    expect(out.asked).toBe(false);
    expect(out.card?.phase).toBe("executing");
    expect(out.reply).toContain("wrote it");
    const inside = await opencodeWrite(join(workdir, "src", "a.ts"), "autonomous");
    expect(inside.asked).toBe(false);
    expect(inside.reply).toContain("wrote it");
    const guarded = await opencodeWrite(join(workdir, "out-link", "a.ts"), "guarded");
    expect(guarded.asked).toBe(true);
    expect(guarded.reply).toContain("not allowed");
  }, 30_000);
});

describe("file tools writing what the sandbox holds read-only (#448 round 3)", () => {
  let base: string;
  beforeAll(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), "codeoid-held-")));
  });
  afterAll(() => rmSync(base, { recursive: true, force: true }));
  const sh = (args: string[], cwd: string) => Bun.spawnSync(["git", ...args], { cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e" } });

  test("a plain repository: its .git whole, the project settings; through a link in the workspace too; nothing else", () => {
    const ws = join(base, "plain");
    mkdirSync(ws);
    sh(["init", "-q"], ws);
    symlinkSync(join(ws, ".git", "hooks"), join(ws, "hooks-link"));
    const held = protectedWriteTargets(ws, base);
    const of = (tool: string, input: Record<string, unknown>) => heldWriteOf(tool, input, ws, held);
    expect(of("Write", { file_path: join(ws, ".git", "hooks", "pre-commit") })).toEqual({ path: join(ws, ".git", "hooks", "pre-commit"), what: "git" });
    expect(of("Edit", { file_path: join(ws, ".git", "config") })?.what).toBe("git");
    expect(of("write", { path: ".git/info/attributes" })?.what).toBe("git");
    expect(of("Write", { file_path: join(ws, "hooks-link", "post-checkout") })).toEqual({ path: join(ws, ".git", "hooks", "post-checkout"), what: "git" });
    expect(of("Write", { file_path: join(ws, "sub", "..", ".git", "HEAD") })?.what).toBe("git");
    expect(of("Write", { file_path: join(ws, ".mcp.json") })?.what).toBe("settings");
    expect(of("Write", { file_path: join(ws, "opencode.jsonc") })?.what).toBe("settings");
    expect(of("write_file", { file_path: join(ws, ".claude", "hooks", "x.sh") })?.what).toBe("settings");
    expect(of("Write", { file_path: join(ws, "src", "a.ts") })).toBeNull();
    expect(of("Write", { file_path: join(ws, ".gitignore") })).toBeNull();
    expect(of("Bash", { command: "echo x > .git/config" })).toBeNull();
    expect(of("Write", { file_path: "/proc/self/cwd/.git/config" })?.what).toBe("unresolved");
    expect(heldWriteReason({ path: join(ws, ".git", "config"), what: "git" })).toContain("runs outside the sandbox");
  });

  test("a linked worktree: its .git file, its own git dir and the repository's (outside the workspace), another worktree's .git file inside it", () => {
    const repo = join(base, "repo");
    mkdirSync(repo);
    sh(["init", "-q", "-b", "main"], repo);
    writeFileSync(join(repo, "a"), "a");
    sh(["add", "."], repo);
    sh(["commit", "-qm", "i"], repo);
    const ws = join(base, "wt");
    sh(["worktree", "add", "-q", "-b", "f", ws], repo);
    sh(["worktree", "add", "-q", "-b", "g", join(ws, "nested")], repo);
    const held = protectedWriteTargets(ws, base);
    const of = (p: string) => heldWriteOf("Write", { file_path: p }, ws, held)?.what ?? null;
    expect(of(join(ws, ".git"))).toBe("git");
    expect(of(join(repo, ".git", "worktrees", "wt", "commondir"))).toBe("git");
    expect(of(join(repo, ".git", "hooks", "pre-commit"))).toBe("git");
    expect(of(join(ws, "nested", ".git"))).toBe("git");
    expect(of(join(ws, "nested", "a"))).toBeNull();
  });
});
