/**
 * opencode through a real Session (#447): the reply reaches canonical
 * history (what forks, switches, rewinds and routine summaries read), a
 * turn's usage and native point are recorded, and an approval asked by
 * opencode waits on codeoid's own approval bar until a person answers.
 *
 * Over the fake-opencode fixture; provider-opencode.test.ts covers the
 * provider on its own.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodeoidConfig } from "../config.js";
import type { CanonicalTurn } from "../daemon/providers/canonical.js";
import type { ProviderEvent } from "../daemon/providers/interface.js";
import { OpencodeProvider } from "../daemon/providers/opencode/index.js";
import { OpencodeServer } from "../daemon/providers/opencode/server.js";
import { buildOpencodeEnv } from "../daemon/providers/opencode/policy.js";
import { ProviderRegistry } from "../daemon/providers/registry.js";
import { SessionManager } from "../daemon/session-manager.js";
import { Store } from "../daemon/store.js";
import { TranscriptStore } from "../daemon/transcript.js";
import { ALL_SCOPES } from "../protocol/scopes.js";
import type { AuthContext } from "../protocol/types.js";

const FIXTURE = join(import.meta.dir, "fixtures", "fake-opencode.ts");
const AUTH: AuthContext = { sub: "user:oc", scopes: [...ALL_SCOPES] as AuthContext["scopes"], delegationDepth: 0, accountId: "acc-oc", projectId: "proj-oc" };
const CLIENT = { id: "cli", auth: AUTH, send: () => {} };

/** Holds a turn's last `turn_done` from Session while `hold` is set: Session hasn't read the turn's end yet. */
let hold: { reached: () => void; release: Promise<void> } | null = null;

async function* held(events: AsyncIterable<ProviderEvent>): AsyncIterable<ProviderEvent> {
  for await (const e of events) {
    if (e.type === "turn_done" && e.result.stopReason !== "steered" && hold) {
      const h = hold;
      hold = null;
      h.reached();
      await h.release;
    }
    yield e;
  }
}

describe("opencode through a Session", () => {
  let tmp: string;
  let store: Store;
  let transcript: TranscriptStore;
  let server: OpencodeServer;
  let manager: SessionManager;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "codeoid-oc-session-"));
    store = new Store(join(tmp, "codeoid.db"));
    transcript = new TranscriptStore(join(tmp, "transcripts"));
    server = new OpencodeServer({ command: process.execPath, argsPrefix: [FIXTURE], dbPath: join(tmp, "opencode", "opencode.db"), env: () => buildOpencodeEnv() });
    const registry = new ProviderRegistry("opencode");
    registry.register({
      id: "opencode",
      displayName: "opencode",
      create: (init) => {
        const p = new OpencodeProvider({ sessionId: init.sessionId, initialBackingId: init.initialBackingId, server, store: init.store });
        const run = p.runTurn.bind(p);
        p.runTurn = (opts) => {
          const r = run(opts);
          return { ...r, events: held(r.events) };
        };
        return p;
      },
    });
    const config = {
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
    } as unknown as CodeoidConfig;
    manager = new SessionManager(store, transcript, undefined, undefined, undefined, { config, providers: registry });
  });

  afterEach(async () => {
    await manager.drain(2_000).catch(() => {});
    await server.stop();
    await transcript.flush();
    rmSync(tmp, { recursive: true, force: true });
  });

  async function newSession(): Promise<string> {
    const workdir = join(tmp, "work");
    mkdirSync(workdir, { recursive: true });
    const r = await manager.handle({ type: "session.create", id: "c", name: `oc-${Math.random()}`, workdir }, AUTH, CLIENT);
    if (r.type !== "response.ok") throw new Error(JSON.stringify(r));
    return (r.data as { id: string }).id;
  }

  async function until(check: () => boolean, ms = 5_000): Promise<void> {
    for (let i = 0; i < ms / 10 && !check(); i++) await Bun.sleep(10);
  }

  it("records the reply in canonical history, with opencode's native point, and persists the ses_ id", async () => {
    const id = await newSession();
    const s = manager._sessionForTest(id)!;
    await s.send("hi", AUTH);
    await until(() => s.status === "idle" && s.canonicalHistory.length >= 2);
    const history = s.canonicalHistory as CanonicalTurn[];
    expect(history.map((t) => [t.role, t.content])).toEqual([
      ["user", "hi"],
      ["assistant", "Hello, world"],
    ]);
    const reply = history[1] as Extract<CanonicalTurn, { role: "assistant" }>;
    expect(reply.providerId).toBe("opencode");
    expect(reply.native?.backingId).toMatch(/^ses_/);
    expect(store.getClaudeCodeSessionId(id)).toBe(reply.native!.backingId);
  });

  it("a message sent before the first turn reached opencode steers it once the prompt is posted, and the session goes idle", async () => {
    const id = await newSession();
    const s = manager._sessionForTest(id)!;
    const first = s.send("steer", AUTH);
    await until(() => s.status === "thinking");
    await s.send("and also this", AUTH, undefined, "now");
    await first;
    await until(() => s.status === "idle" && s.canonicalHistory.at(-1)?.role === "assistant");
    expect(s.status).toBe("idle");
    expect(s.canonicalHistory.at(-1)?.content).toContain("steered: and also this (steer)");
    const conn = await server.ensure();
    const msgs = await conn.client.messages(store.getClaudeCodeSessionId(id)!);
    // The turn's own prompt went first.
    expect(msgs.data.filter((m) => m.type === "user").map((m) => (m as { text?: string }).text)).toEqual(["steer", "and also this"]);
  });

  it("a message sent after opencode's turn ended, before Session read its end, starts a turn of its own: answered, nothing lost", async () => {
    const id = await newSession();
    const s = manager._sessionForTest(id)!;
    let reached = () => {};
    let release = () => {};
    const atEnd = new Promise<void>((r) => {
      reached = r;
    });
    const released = new Promise<void>((r) => {
      release = r;
    });
    hold = { reached: () => reached(), release: released };
    await s.send("hi", AUTH);
    await atEnd;
    // The provider closed its turn; Session still shows it working.
    expect(s.status).toBe("thinking");
    setTimeout(release, 100);
    await s.send("and one more", AUTH, undefined, "now");
    await until(() => s.status === "idle" && s.canonicalHistory.at(-1)?.role === "assistant" && s.canonicalHistory.length >= 4);
    const history = s.canonicalHistory as CanonicalTurn[];
    expect(history.map((t) => t.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(history[2]!.content).toBe("and one more");
    expect(history[3]!.content).toBe("Hello, world");
    const conn = await server.ensure();
    const msgs = await conn.client.messages(store.getClaudeCodeSessionId(id)!);
    expect(msgs.data.filter((m) => m.type === "user").map((m) => (m as { text?: string }).text)).toEqual(["hi", "and one more"]);
    // Both turns' ends were read, their spend with them.
    await until(() => (s.toInfo().usage?.numTurns ?? 0) >= 2);
    expect(s.toInfo().usage?.numTurns).toBe(2);
  }, 15_000);

  it("a message sent while an interrupt is settling starts a turn of its own: answered, not dropped", async () => {
    const id = await newSession();
    const s = manager._sessionForTest(id)!;
    await s.send("slow", AUTH);
    await until(() => s.status === "thinking");
    await Bun.sleep(150);
    const stopped = s.interrupt(AUTH);
    // The user's Stop is still on its way to opencode: Session still shows the turn working.
    expect(s.status).toBe("thinking");
    await s.send("after the stop", AUTH);
    await stopped;
    await until(() => s.status === "idle" && s.canonicalHistory.at(-1)?.role === "assistant" && s.canonicalHistory.at(-2)?.content === "after the stop", 10_000);
    expect(s.canonicalHistory.at(-2)?.content).toBe("after the stop");
    expect(s.canonicalHistory.at(-1)?.content).toBe("Hello, world");
    const conn = await server.ensure();
    const msgs = await conn.client.messages(store.getClaudeCodeSessionId(id)!);
    expect(msgs.data.filter((m) => m.type === "user").map((m) => (m as { text?: string }).text)).toEqual(["slow", "after the stop"]);
  }, 20_000);

  it("an opencode permission waits on codeoid's approval bar, and the approver's yes runs it", async () => {
    const id = await newSession();
    const s = manager._sessionForTest(id)!;
    await s.send("use-shell", AUTH);
    await until(() => s.status === "waiting_approval");
    expect(s.status).toBe("waiting_approval");
    const conn = await server.ensure();
    const pending = await conn.client.pendingPermissions(store.getClaudeCodeSessionId(id)!);
    expect(pending).toHaveLength(1);
    expect(s.approve(`opencode-${pending[0]!.id}`, true, AUTH)).toBe("settled");
    await until(() => s.status === "idle" && s.canonicalHistory.length >= 2);
    const reply = s.canonicalHistory.at(-1) as Extract<CanonicalTurn, { role: "assistant" }>;
    expect(reply.content).toBe("listed it");
    expect(reply.toolCalls?.[0]).toMatchObject({ originalName: "Bash", input: { command: "ls -la /tmp" }, success: true });
  });

  it("a person's no is opencode's reject, with the reason", async () => {
    const id = await newSession();
    const s = manager._sessionForTest(id)!;
    await s.send("use-shell", AUTH);
    await until(() => s.status === "waiting_approval");
    const conn = await server.ensure();
    const [req] = await conn.client.pendingPermissions(store.getClaudeCodeSessionId(id)!);
    s.approve(`opencode-${req!.id}`, false, AUTH);
    await until(() => s.status === "idle" && s.canonicalHistory.length >= 2);
    expect(s.canonicalHistory.at(-1)?.content).toStartWith("not allowed:");
  });
});
