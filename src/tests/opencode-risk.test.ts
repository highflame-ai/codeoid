/**
 * opencode's shell calls are judged by risk exactly as a Claude `Bash` call
 * is (#447 with #431): through a real Session over the fake-opencode
 * fixture, the gate rates the full command line in the directory opencode
 * runs it in (its `workdir`, resolved by the path rule: a link to where it
 * leads), the card shows the level, high risk asks in autonomous mode, a
 * low read runs unasked in guarded mode with `autoAllowLowRisk`, and a
 * credential read is refused. The fixture runs nothing: an allowed call
 * only answers "ran it".
 */
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodeoidConfig } from "../config.js";
import { getConfigDir } from "../config.js";
import type { ProviderEvent, SessionProvider } from "../daemon/providers/interface.js";
import { MockSessionProvider } from "../daemon/providers/mock/session-provider.js";
import { OpencodeProvider } from "../daemon/providers/opencode/index.js";
import { buildOpencodeEnv, commandlessShellLine } from "../daemon/providers/opencode/policy.js";
import { OpencodeServer } from "../daemon/providers/opencode/server.js";
import { assessShellCommandSync } from "../daemon/risk/shell-risk.js";
import { registerSecretPaths } from "../daemon/secret-paths.js";
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

let server: OpencodeServer;
let serverDir: string;
let tmp: string;
let workdir: string;
let store: Store;
let transcriptStore: TranscriptStore;
const sessions: Session[] = [];

beforeAll(async () => {
  await loadShellParser();
  serverDir = mkdtempSync(join(tmpdir(), "codeoid-oc-risk-srv-"));
  server = new OpencodeServer({ command: process.execPath, argsPrefix: [FIXTURE], dbPath: join(serverDir, "opencode.db"), env: () => buildOpencodeEnv(), userConfigDir: null });
});
afterAll(async () => {
  await server.stop();
  rmSync(serverDir, { recursive: true, force: true });
});
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "codeoid-oc-risk-"));
  // Apart from the store: the turn's checkpoint snapshots the workdir.
  workdir = join(realpathSync(tmp), "work");
  mkdirSync(workdir);
  store = new Store(join(tmp, "codeoid.db"));
  transcriptStore = new TranscriptStore(join(tmp, "transcripts"));
});
afterEach(async () => {
  for (const s of sessions.splice(0)) await s.interrupt(AUTH).catch(() => {});
  try { await transcriptStore.flush(); } catch {}
  try { store.close(); } catch {}
  rmSync(tmp, { recursive: true, force: true });
});

function makeSession(provider: SessionProvider, mode: SessionMode, approvals?: CodeoidConfig["approvals"]): { session: Session; cards: SessionMessage[] } {
  const id = randomUUID();
  store.createSession({
    id, name: "ocr", workdir, status: "idle", createdBy: AUTH.sub,
    createdAt: new Date().toISOString(), attachedClients: 0, accountId: AUTH.accountId, projectId: AUTH.projectId,
  });
  const opts: SessionCreateOptions = {
    name: "ocr", workdir, auth: AUTH, store, transcriptStore, existingId: id, _testProvider: provider,
    initialMode: { mode, ...(mode === "autonomous" ? { maxTurns: 10 } : {}) },
    config: { ...BASE_CONFIG, ...(approvals ? { approvals } : {}) } as unknown as CodeoidConfig,
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

/** One opencode shell call of `input`, through a Session: whether it asked, what the card showed, and what the model was told. */
async function opencodeCall(input: Record<string, unknown>, mode: SessionMode, approvals?: CodeoidConfig["approvals"]) {
  const provider = new OpencodeProvider({ sessionId: randomUUID(), initialBackingId: "ocr", server, store: { setClaudeCodeSessionId: () => {} } as unknown as Store });
  const { session, cards } = makeSession(provider, mode, approvals);
  void session.send(`ask-shell:${JSON.stringify(input)}`, AUTH);
  await until(() => session.pendingToolApprovals().length > 0 || session.canonicalHistory.at(-1)?.role === "assistant");
  const pending = session.pendingToolApprovals();
  const card = cards[0]?.tool?.state as Card | undefined;
  const cardInput = cards[0]?.tool?.input as Record<string, unknown> | undefined;
  for (const p of pending) session.approve(p.approvalId, false, AUTH);
  await until(() => session.status === "idle" && session.canonicalHistory.at(-1)?.role === "assistant");
  return { asked: pending.length > 0, pending, card, cardInput, reply: String(session.canonicalHistory.at(-1)?.content ?? "") };
}

/** The same call as Claude's `Bash` makes it, through the same gate. */
async function claudeCall(input: Record<string, unknown>, mode: SessionMode, approvals?: CodeoidConfig["approvals"]) {
  const events: ProviderEvent[] = [
    { type: "tool_start", toolId: "t1", sdkToolUseId: "sdk-t1", name: "Bash", input, approvalId: "ap-1" },
    { type: "turn_done", result: { providerId: "mock", model: "m", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, totalCostUsd: 0, durationMs: 1 } },
  ];
  const provider = new MockSessionProvider("mock", [events]);
  const { session, cards } = makeSession(provider, mode, approvals);
  void session.send("go", AUTH);
  await until(() => provider.canUseToolResults.length > 0 || session.pendingToolApprovals().length > 0);
  const pending = session.pendingToolApprovals();
  const card = cards[0]?.tool?.state as Card | undefined;
  if (pending.length > 0) await session.interrupt(AUTH);
  return { asked: pending.length > 0, pending, card, behavior: provider.canUseToolResults[0]?.behavior };
}

describe("an opencode shell call is judged by risk as a Claude Bash call is (#431)", () => {
  test("`rm -rf ~` asks in autonomous mode, its card and the pending approval carry the same level and reasons as Claude's", async () => {
    const oc = await opencodeCall({ command: "rm -rf ~", description: "clean up" }, "autonomous");
    const claude = await claudeCall({ command: "rm -rf ~" }, "autonomous");
    expect(oc.asked).toBe(true);
    expect(oc.card?.phase).toBe("waiting_confirmation");
    expect(oc.card?.risk).toEqual(claude.card!.risk!);
    expect(oc.card?.risk?.level).toBe("high");
    expect(oc.pending[0]?.risk).toEqual(claude.pending[0]!.risk!);
    // The card shows the whole line, as Bash.
    expect(oc.cardInput).toMatchObject({ command: "rm -rf ~" });
    // Denied: opencode's reject carries the reason, and the model carries on.
    expect(oc.reply).toStartWith("not allowed:");
  });

  test("a low read (`git status`) runs unasked in guarded mode with autoAllowLowRisk — and asks without it", async () => {
    const relaxed = { autoAllowLowRisk: true, askOnUnknown: true };
    const oc = await opencodeCall({ command: "git status" }, "guarded", relaxed);
    expect(oc.asked).toBe(false);
    expect(oc.card?.phase).toBe("executing");
    expect(oc.reply).toBe("ran it");
    expect((await claudeCall({ command: "git status" }, "guarded", relaxed)).asked).toBe(false);
    expect((await opencodeCall({ command: "git status" }, "guarded")).asked).toBe(true);
  });

  test("a credential read is refused in any mode, never asked", async () => {
    const line = `cat ${join(getConfigDir(), "config.json")}`;
    const oc = await opencodeCall({ command: line }, "autonomous");
    expect(oc.asked).toBe(false);
    expect(oc.reply).toContain("holds credentials");
    expect((await claudeCall({ command: line }, "autonomous")).behavior).toBe("deny");
  });

  test("ps showing processes' environments (the server's password, the daemon's keys) is refused in any mode, as a read of /proc/<pid>/environ (round-17 audit)", async () => {
    for (const line of ["ps eww -C opencode", "ps auxe"]) {
      const oc = await opencodeCall({ command: line }, "autonomous");
      expect(oc.asked).toBe(false);
      expect(oc.reply).toContain("/proc/<pid>/environ");
      expect(oc.reply).not.toBe("ran it");
      expect((await claudeCall({ command: line }, "autonomous")).behavior).toBe("deny");
    }
    // A plain listing still runs in autonomous mode.
    expect((await opencodeCall({ command: "ps aux" }, "autonomous")).reply).toBe("ran it");
  });

  test("a line that could read another process's environment ($PPID's is the server's, password included) is refused in any mode on both backends: PS_FORMAT, a pid only known at run time, a root link, a search of /proc (round-18 audit)", async () => {
    for (const line of [
      "PS_FORMAT=pid,environ ps -C opencode",
      "export PS_FORMAT=environ; ps -C opencode",
      "cat /proc/$PPID/environ",
      "tr '\\0' '\\n' < /proc/$PPID/environ",
      "cat /proc/self/root/proc/4242/environ",
      "cat /proc/*/environ",
      "find /proc -name environ -exec cat {} +",
    ]) {
      for (const mode of ["autonomous", "guarded"] as const) {
        const oc = await opencodeCall({ command: line }, mode);
        expect([line, mode, oc.asked, /\/proc\/.*environ holds credentials/.test(oc.reply) ? "refused" : oc.reply]).toEqual([line, mode, false, "refused"]);
        expect([line, mode, (await claudeCall({ command: line }, mode)).behavior]).toEqual([line, mode, "deny"]);
      }
    }
    // What can't reach one still runs in autonomous mode.
    for (const line of ["PS_FORMAT=pid,cmd ps -C opencode", "cat /proc/$PPID/status"]) {
      expect([line, (await opencodeCall({ command: line }, "autonomous")).reply]).toEqual([line, "ran it"]);
    }
  });

  test("`$(< FILE)` is the read of FILE it is: the server's environment and codeoid's config are refused in any mode on both backends (round-19 audit)", async () => {
    for (const line of ["echo $(< /proc/$PPID/environ)", `echo $(< ${join(getConfigDir(), "config.json")})`]) {
      for (const mode of ["autonomous", "guarded"] as const) {
        const oc = await opencodeCall({ command: line }, mode);
        expect([line, mode, oc.asked, oc.reply.includes("holds credentials") ? "refused" : oc.reply]).toEqual([line, mode, false, "refused"]);
        expect([line, mode, (await claudeCall({ command: line }, mode)).behavior]).toEqual([line, mode, "deny"]);
      }
    }
    expect((await opencodeCall({ command: "echo $(< README.md)" }, "autonomous")).reply).toBe("ran it");
  });

  test("a debugger attaching to the server with its pid only known at run time is refused in any mode on both backends (round-19 audit)", async () => {
    for (const line of ["gdb --batch --pid=$PPID", 'gdb -batch -ex "attach $PPID"']) {
      const oc = await opencodeCall({ command: line }, "autonomous");
      expect([line, oc.asked, oc.reply.includes("holds credentials") ? "refused" : oc.reply]).toEqual([line, false, "refused"]);
      expect([line, (await claudeCall({ command: line }, "autonomous")).behavior]).toEqual([line, "deny"]);
    }
    // One whose words could attach is asked, autonomous mode included.
    expect((await opencodeCall({ command: "gdb /usr/bin/opencode $PPID" }, "autonomous")).asked).toBe(true);
  });

  test("a listing of /proc reads no environment: it runs in autonomous mode on both backends (round-19 audit)", async () => {
    for (const line of ["ls -la /proc/$$/fd", "ls /proc/$PPID"]) {
      expect([line, (await opencodeCall({ command: line }, "autonomous")).reply]).toEqual([line, "ran it"]);
      expect([line, (await claudeCall({ command: line }, "autonomous")).behavior]).toEqual([line, "allow"]);
    }
  });

  test("the directory opencode runs it in is the one judged: a bare name in codeoid's config dir is a credential read", async () => {
    const oc = await opencodeCall({ command: "cat config.json", workdir: getConfigDir() }, "autonomous");
    expect(oc.asked).toBe(false);
    expect(oc.reply).toContain("holds credentials");
    expect(oc.cardInput).toMatchObject({ command: "cat config.json", cwd: getConfigDir() });
    // ...as Claude's Bash naming that cwd is, and as the rating reads it.
    expect((await claudeCall({ command: "cat config.json", cwd: getConfigDir() }, "autonomous")).behavior).toBe("deny");
    expect(assessShellCommandSync("cat config.json", { cwd: getConfigDir(), workdir, configDir: getConfigDir() }).secret?.action).toBe("deny");
  });

  test("...through a link in the workdir too: judged where it leads (the round-15 path rule)", async () => {
    symlinkSync(getConfigDir(), join(workdir, "settings"));
    const oc = await opencodeCall({ command: "cat config.json", workdir: "settings" }, "autonomous");
    expect(oc.asked).toBe(false);
    expect(oc.reply).toContain("holds credentials");
    expect(oc.cardInput).toMatchObject({ cwd: getConfigDir() });
  });

  test("a read in a directory outside the workspace isn't low: it asks in guarded mode even with autoAllowLowRisk; inside, it doesn't", async () => {
    const relaxed = { autoAllowLowRisk: true, askOnUnknown: true };
    mkdirSync(join(workdir, "sub"));
    const inside = await opencodeCall({ command: "ls", workdir: "sub" }, "guarded", relaxed);
    expect(inside.asked).toBe(false);
    expect(inside.cardInput).toMatchObject({ cwd: join(workdir, "sub") });
    const outside = await opencodeCall({ command: "ls", workdir: "/etc" }, "guarded", relaxed);
    expect(outside.asked).toBe(true);
    expect(outside.card?.risk?.level).not.toBe("low");
    const claude = await claudeCall({ command: "ls", cwd: "/etc" }, "guarded", relaxed);
    expect(outside.card?.risk).toEqual(claude.card!.risk!);
  });
});

describe("an opencode shell call whose directory can't be resolved for certain (#431)", () => {
  // `..` after a component that doesn't exist: where it leads in opencode's process isn't known.
  const unresolved = "nope/../elsewhere";

  test("is asked in every mode, with its command's risk on the card", async () => {
    const ls = await opencodeCall({ command: "ls", workdir: unresolved }, "autonomous");
    expect(ls.asked).toBe(true);
    expect(ls.pending[0]?.toolName).toBe("opencode_unresolved_path");
    expect(ls.card?.risk?.level).toBeDefined();
    const rm = await opencodeCall({ command: "rm -rf ~", workdir: unresolved }, "autonomous");
    expect(rm.asked).toBe(true);
    expect(rm.card?.risk?.level).toBe("high");
    expect(rm.pending[0]?.risk?.level).toBe("high");
  });

  test("a low command there is still asked in guarded mode with autoAllowLowRisk: the hard gate outranks a low rating", async () => {
    const relaxed = { autoAllowLowRisk: true, askOnUnknown: true };
    const ls = await opencodeCall({ command: "ls", workdir: unresolved }, "guarded", relaxed);
    expect(ls.asked).toBe(true);
    expect(ls.pending[0]?.toolName).toBe("opencode_unresolved_path");
    expect(ls.card?.phase).toBe("waiting_confirmation");
    expect(ls.card?.risk?.level).toBe("low");
  });

  test("a credential read there is refused, as with a directory that resolves", async () => {
    const oc = await opencodeCall({ command: `cat ${join(getConfigDir(), "config.json")}`, workdir: unresolved }, "autonomous");
    expect(oc.asked).toBe(false);
    expect(oc.reply).toContain("holds credentials");
  });
});

describe("opencode's own credential files are refused to a shell command too (#431)", () => {
  test("a read of a key file codeoid wrote for opencode, or of its database, is refused like the file tools", async () => {
    const dir = join(tmp, "oc-data");
    const keys = join(dir, "codeoid-credentials");
    mkdirSync(join(keys, "ns-1"), { recursive: true });
    const undo = registerSecretPaths({ dirs: [keys], files: [join(dir, "opencode.db")] });
    try {
      for (const command of [`cat ${join(keys, "ns-1", "anthropic")}`, `sqlite3 ${join(dir, "opencode.db")} .dump`, `cd ${join(keys, "ns-1")} && cat anthropic`]) {
        const oc = await opencodeCall({ command }, "autonomous");
        expect([command, oc.asked, oc.reply.includes("holds credentials")]).toEqual([command, false, true]);
      }
    } finally {
      undo();
    }
  });
});

describe("a line opencode runs unasked by its own rule (no command in it) and the risk rating agree (#431)", () => {
  // Lines real 2.2.5 runs without a permission request (policy.ts commandlessShellLine).
  const commandless = [
    "cd .", "cd src", "cd 'my dir'", "export FOO=bar", "X=1", "X=1 Y='a b'", "# a comment", "cd src && X=1", "X=1; Y=2\nunset X", "readonly A",
    "# $(id)\nX=1", "X=1 # `id` ${A} | > (x)", "X=1;# $(id)", "# it's\nX=1", "cd ~/.codeoid", "cd /", "export PATH=/tmp/x", "unset HOME",
  ];

  test("none is one the gate would have to ask about in every mode, or refuse: the rating never contradicts running it", () => {
    for (const line of commandless) {
      expect([line, commandlessShellLine(line)]).toEqual([line, true]);
      const r = assessShellCommandSync(line, { cwd: workdir, workdir, configDir: getConfigDir() });
      expect([line, r.level === "high" || r.level === "unknown" || !!r.unreadable || !!r.secret]).toEqual([line, false]);
    }
    // ...nor a listing of the shell's state, which the session's own shell runs unasked too (round-16 audit).
    for (const line of ["export -p", "declare -p", "readonly -p", "unset -v X", "export", "declare", "typeset -x A=1", "export -f", "local"]) {
      expect([line, commandlessShellLine(line, { listing: true })]).toEqual([line, true]);
      const r = assessShellCommandSync(line, { cwd: workdir, workdir, configDir: getConfigDir() });
      expect([line, r.level === "high" || r.level === "unknown" || !!r.unreadable || !!r.secret]).toEqual([line, false]);
    }
  });

  test("through a Session: its card is shown and settled, the server is kept; an acting line that ran unasked still stops it", async () => {
    const run = async (line: string) => {
      const provider = new OpencodeProvider({ sessionId: randomUUID(), initialBackingId: "ocr", server, store: { setClaudeCodeSessionId: () => {} } as unknown as Store });
      const { session, cards } = makeSession(provider, "autonomous");
      await session.send(`unasked-shell:${line}`, AUTH);
      await until(() => session.status === "idle" || session.status === "error");
      await Bun.sleep(50);
      return { session, cards };
    };
    const pid = (await server.ensure()).pid;
    const kept = await run("cd src && X=1");
    expect(kept.session.status).toBe("idle");
    const card = kept.cards.at(-1)?.tool;
    expect(card?.name).toBe("Bash");
    expect(card?.input).toMatchObject({ command: "cd src && X=1" });
    const reply = kept.session.canonicalHistory.at(-1) as { toolCalls?: Array<{ originalName: string; success?: boolean }> };
    expect(reply.toolCalls?.[0]).toMatchObject({ originalName: "Bash", success: true });
    expect((await server.ensure()).pid).toBe(pid);
    // A listing of the session's own (bare) shell state too.
    const listed = await run("export -p");
    expect(listed.session.status).toBe("idle");
    expect(listed.cards.at(-1)?.tool?.input).toMatchObject({ command: "export -p" });
    expect((await server.ensure()).pid).toBe(pid);
    // Judged after the fact as before: a line with a command in it that ran unasked means something settled its request.
    const stopped = await run("ls");
    expect(stopped.session.status).toBe("error");
    expect((await server.ensure()).pid).not.toBe(pid);
  });
});
