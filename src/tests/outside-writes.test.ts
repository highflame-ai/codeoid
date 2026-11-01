/**
 * Autonomous mode asks before writing outside the session's working
 * directory (outside-writes.ts), on every backend, at codeoid's own gate:
 *
 *   - each backend's write tool, named and shaped as it reaches the gate
 *     (Claude, opencode, Codex, pi, Qwen Code, the Gemini CLI);
 *   - a symlink in the workdir that leads out, a `..` that leads out, a path
 *     that can't be resolved for certain (none given, `/proc/self/cwd/…`),
 *     the temp dir (inside), a read outside (not asked);
 *   - a shell command whose redirect or `rm`/`cp`/`tee`/… target is outside,
 *     and one whose target the parser can't place (today's behaviour);
 *   - the card says why; guarded mode is unchanged; the autonomous budget
 *     isn't spent; an unattended run parks on it, as on a high-risk command;
 *   - opencode end to end over the fake server.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { CodeoidConfig } from "../config.js";
import { outsideWriteOf, writeTargets } from "../daemon/outside-writes.js";
import type { ProviderEvent, SessionProvider } from "../daemon/providers/interface.js";
import { MockSessionProvider } from "../daemon/providers/mock/session-provider.js";
import { OpencodeProvider } from "../daemon/providers/opencode/index.js";
import { buildOpencodeEnv } from "../daemon/providers/opencode/policy.js";
import { OpencodeServer } from "../daemon/providers/opencode/server.js";
import { shellWriteTargets } from "../daemon/risk/effects.js";
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
  root = realpathSync(mkdtempSync(join(homedir(), ".codeoid-test-outside-writes-")));
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

describe("whether a write leads outside the working directory", () => {
  test("inside: a relative or absolute path in the workdir, a new file under a new dir, the temp dir", () => {
    expect(outsideWriteOf("Write", { file_path: join(workdir, "src", "a.ts") }, workdir)).toBeNull();
    expect(outsideWriteOf("write", { path: "src/new/deeper/a.ts" }, workdir)).toBeNull();
    expect(outsideWriteOf("codex_file_change", { changes: [{ path: "src/a.ts" }] }, workdir)).toBeNull();
    expect(outsideWriteOf("Write", { file_path: join(tmpdir(), "scratch.txt") }, workdir)).toBeNull();
    expect(outsideWriteOf("Write", { file_path: "/tmp/scratch.txt" }, workdir)).toBeNull();
  });

  test("outside: an absolute path elsewhere, a symlink that leads out, a `..` that leads out, a move's destination", () => {
    expect(outsideWriteOf("Write", { file_path: join(elsewhere, "a") }, workdir)).toEqual({ path: join(elsewhere, "a"), resolved: true });
    // Through the workdir's own link: where the write lands.
    expect(outsideWriteOf("Edit", { file_path: join(workdir, "out-link", "a") }, workdir)).toEqual({ path: join(elsewhere, "a"), resolved: true });
    expect(outsideWriteOf("write", { path: "out-link/new/b" }, workdir)).toEqual({ path: join(elsewhere, "new", "b"), resolved: true });
    expect(outsideWriteOf("write_file", { file_path: join(workdir, "src", "..", "..", "elsewhere", "c") }, workdir)).toEqual({ path: join(elsewhere, "c"), resolved: true });
    expect(outsideWriteOf("codex_file_change", { changes: [{ path: "src/a.ts", kind: { type: "update", move_path: join(elsewhere, "a.ts") } }] }, workdir)?.path).toBe(join(elsewhere, "a.ts"));
    // opencode's patch: every file it touches is in `files`.
    expect(outsideWriteOf("Edit", { file_path: join(workdir, "src", "a.ts"), files: [join(workdir, "src", "a.ts"), join(elsewhere, "b.ts")] }, workdir)?.path).toBe(join(elsewhere, "b.ts"));
  });

  test("a path that can't be resolved for certain counts as outside", () => {
    expect(outsideWriteOf("acp_edit", {}, workdir)).toMatchObject({ resolved: false });
    expect(outsideWriteOf("Write", {}, workdir)).toMatchObject({ resolved: false });
    expect(outsideWriteOf("Write", { file_path: "/proc/self/cwd/a" }, workdir)).toEqual({ path: "/proc/self/cwd/a", resolved: false });
    expect(outsideWriteOf("write", { path: "~someone/a" }, workdir)).toEqual({ path: "~someone/a", resolved: false });
  });

  test("a read, search or listing outside isn't a write", () => {
    for (const [tool, input] of [
      ["Read", { file_path: join(elsewhere, "a") }],
      ["Grep", { pattern: "x", path: elsewhere }],
      ["Glob", { pattern: "*", path: elsewhere }],
      ["read_file", { absolute_path: join(elsewhere, "a") }],
    ] as const) {
      expect(outsideWriteOf(tool, input, workdir)).toBeNull();
    }
  });

  test("a shell command: a target the parser names outside is outside; one it can't place is left as today", () => {
    const bash = (command: string, cwd?: string) => outsideWriteOf("Bash", { command, ...(cwd ? { cwd } : {}) }, workdir);
    expect(bash(`echo hi > ${elsewhere}/x`)?.path).toBe(join(elsewhere, "x"));
    expect(bash("echo hi > out-link/x")?.path).toBe(join(elsewhere, "x"));
    expect(bash("echo hi >> ../elsewhere/log")?.path).toBe(join(elsewhere, "log"));
    expect(bash(`rm -f ${elsewhere}/x`)?.path).toBe(join(elsewhere, "x"));
    expect(bash(`cp src/a ${elsewhere}/`)?.path).toBe(elsewhere);
    expect(bash(`mv ${elsewhere}/a src/a`)?.path).toBe(join(elsewhere, "a"));
    expect(bash(`echo x | tee ${elsewhere}/t`)?.path).toBe(join(elsewhere, "t"));
    expect(bash(`cd ${elsewhere} && touch made`)?.path).toBe(join(elsewhere, "made"));
    expect(bash("touch here", elsewhere)?.path).toBe(join(elsewhere, "here"));
    // Inside, scratch and devices: not outside.
    expect(bash("echo hi > src/x && rm -f src/y")).toBeNull();
    expect(bash("echo hi > /tmp/scratch 2>/dev/null")).toBeNull();
    expect(bash("make 2>&1 >/dev/null")).toBeNull();
    // Reads outside: not writes.
    expect(bash(`cat ${elsewhere}/a > src/copy`)).toBeNull();
    // Targets the parser can't place: today's behaviour (not asked for this).
    expect(bash('echo hi > "$OUT"')).toBeNull();
    expect(bash("cd $DIR && touch x")).toBeNull();
    expect(shellWriteTargets('echo hi > "$OUT"', { workdir })).toEqual([]);
  });
});

function makeSession(provider: SessionProvider, mode: SessionMode): { session: Session; cards: SessionMessage[] } {
  const id = randomUUID();
  store.createSession({
    id, name: "ow", workdir, status: "idle", createdBy: AUTH.sub,
    createdAt: new Date().toISOString(), attachedClients: 0, accountId: AUTH.accountId, projectId: AUTH.projectId,
  });
  const opts: SessionCreateOptions = {
    name: "ow", workdir, auth: AUTH, store, transcriptStore, existingId: id, _testProvider: provider,
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

describe("autonomous mode asks before a write outside the working directory, at the session's gate", () => {
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
    test(`${label}: asked, the card says why, the budget isn't spent`, async () => {
      // `workdir` and `elsewhere` are made per test.
      const [, n, i] = outsideCalls(workdir, elsewhere).find(([l]) => l === label)!;
      const r = await gateCall(n, i, "autonomous");
      expect(r.asked).toBe(true);
      expect(r.card?.phase).toBe("waiting_confirmation");
      expect(r.card?.risk?.reasons[0]).toStartWith("writes outside the working directory: ");
      expect(r.pending[0]?.risk?.reasons[0]).toBe(r.card?.risk?.reasons[0]);
      expect(r.budget).toBe(10);
    });
  }

  test("the card names the resolved path: a link's target, not the link", async () => {
    const r = await gateCall("Write", { file_path: join(workdir, "out-link", "a.ts"), content: "x" }, "autonomous");
    expect(r.card?.risk).toEqual({ level: "medium", reasons: [`writes outside the working directory: ${join(elsewhere, "a.ts")}`] });
    const unresolved = await gateCall("acp_edit", {}, "autonomous");
    expect(unresolved.card?.risk?.reasons[0]).toContain("can't be resolved for certain");
  });

  test("inside the workdir or the temp dir, and reads outside, run unasked as before", async () => {
    for (const [name, input] of [
      ["Write", { file_path: join(workdir, "src", "a.ts"), content: "x" }],
      ["write", { path: "src/b.ts", content: "x" }],
      ["Write", { file_path: join(tmpdir(), `codeoid-ow-${randomUUID()}.txt`), content: "x" }],
      ["Read", { file_path: join(elsewhere, "a.ts") }],
      ["Grep", { pattern: "x", path: elsewhere }],
      ["Bash", { command: "echo hi > src/x" }],
      ["Bash", { command: 'echo hi > "$OUT"' }],
    ] as Array<[string, Record<string, unknown>]>) {
      const r = await gateCall(name, input, "autonomous");
      expect([name, r.asked, r.behavior]).toEqual([name, false, "allow"]);
      expect(r.card?.risk?.reasons[0] ?? "").not.toContain("outside the working directory");
    }
  });

  test("guarded mode is unchanged: a write asks as it always did, with no outside-write reason", async () => {
    const r = await gateCall("Write", { file_path: join(elsewhere, "a.ts"), content: "x" }, "guarded");
    expect(r.asked).toBe(true);
    expect(r.card?.risk).toBeUndefined();
  });

  test("a high-risk command outside keeps its level and its own reason first, the outside write said after", async () => {
    const r = await gateCall("Bash", { command: `rm -rf ${elsewhere}` }, "autonomous");
    expect(r.asked).toBe(true);
    expect(r.card?.risk?.level).toBe("high");
    expect(r.card?.risk?.reasons[0]).not.toContain("outside the working directory");
    expect(r.card?.risk?.reasons.at(-1)).toBe(`writes outside the working directory: ${elsewhere}`);
  });

  test("an unattended run parks on it for the owner, as on a high-risk command", async () => {
    const r = await gateCall("Write", { file_path: join(elsewhere, "a.ts"), content: "x" }, "autonomous", { unattended: true });
    expect(r.asked).toBe(true);
    expect(r.status).toBe("waiting_approval");
    expect(r.budget).toBe(10);
  });
});

describe("opencode's write outside the working directory, end to end", () => {
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

  test("asked in autonomous mode, its card naming where it lands; inside, it runs unasked", async () => {
    const out = await opencodeWrite(join(workdir, "out-link", "a.ts"), "autonomous");
    expect(out.asked).toBe(true);
    expect(out.card?.risk?.reasons[0]).toBe(`writes outside the working directory: ${join(elsewhere, "a.ts")}`);
    expect(out.reply).toContain("not allowed");
    const inside = await opencodeWrite(join(workdir, "src", "a.ts"), "autonomous");
    expect(inside.asked).toBe(false);
    expect(inside.reply).toContain("wrote it");
  }, 30_000);
});
