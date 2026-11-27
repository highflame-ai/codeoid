/**
 * Idle backends are released (#451): a session left idle past
 * `session.idleReleaseMinutes` has its backend process (and the MCP servers it
 * started) stopped, and the next message starts it again on the same
 * conversation. Nothing in flight is ever cut off.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config.js";
import type { ProviderEvent } from "../daemon/providers/interface.js";
import { MockSessionProvider, mockResult } from "../daemon/providers/mock/session-provider.js";
import { ProviderRegistry } from "../daemon/providers/registry.js";
import { Session } from "../daemon/session.js";
import { Store } from "../daemon/store.js";
import { TranscriptStore } from "../daemon/transcript.js";
import { ALL_SCOPES } from "../protocol/scopes.js";
import type { AuthContext } from "../protocol/types.js";

const AUTH: AuthContext = { sub: "user:idle", scopes: [...ALL_SCOPES] as AuthContext["scopes"], delegationDepth: 0, accountId: "a", projectId: "p" };

let dir: string;
let store: Store;
let transcript: TranscriptStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codeoid-idle-"));
  store = new Store(join(dir, "codeoid.db"));
  transcript = new TranscriptStore(join(dir, "transcripts"));
});
afterEach(async () => {
  await Bun.sleep(50);
  try {
    await transcript.flush();
  } catch {}
  try {
    store.close();
  } catch {}
  rmSync(dir, { recursive: true, force: true });
});

const textTurn = (text: string): ProviderEvent[] => [
  { type: "text_done", content: text },
  { type: "turn_done", result: mockResult() },
];

/** 60 ms of idleness, in minutes. */
const SHORT = 0.001;

/** The daemon's defaults, with the idle limit set. */
function configWith(minutes: number) {
  const c = loadConfig({ configPath: join(dir, "absent.json"), env: {} });
  return { ...c, session: { ...c.session, idleReleaseMinutes: minutes } };
}

function session(opts: { providerId?: string; minutes?: number; script?: ProviderEvent[][] } = {}) {
  const id = opts.providerId ?? "claude";
  const provider = new MockSessionProvider(id, opts.script ?? [textTurn("first"), textTurn("second")]);
  const registry = new ProviderRegistry(id);
  registry.register({ id, displayName: id, create: () => provider });
  const s = new Session({
    name: "idle",
    workdir: dir,
    auth: AUTH,
    store,
    transcriptStore: transcript,
    existingId: randomUUID(),
    providers: registry,
    providerId: id,
    config: configWith(opts.minutes ?? SHORT),
    _testProvider: provider,
  });
  return { s, provider };
}

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(10);
  }
}

describe("idle backends are released (#451)", () => {
  test("a session idle past the limit has its backend stopped, and the next message resumes it", async () => {
    const { s, provider } = session();
    await s.send("hello", AUTH);
    await until(() => s.toInfo().status === "idle" && provider.teardownCount >= 1);
    // Stopped once, not again while it stays idle with no backend running.
    const after = provider.teardownCount;
    await Bun.sleep(200);
    expect(provider.teardownCount).toBe(after);
    // The next message starts it again on the same conversation.
    const backing = provider.backingSessionId;
    await s.send("again", AUTH);
    await until(() => provider.capturedOpts.length === 2 && s.toInfo().status === "idle");
    expect(provider.backingSessionId).toBe(backing);
  });

  test("a session whose last turn failed is released too", async () => {
    const { s, provider } = session({ script: [[{ type: "error", message: "boom" }, { type: "turn_done", result: mockResult() }]] });
    await s.send("hello", AUTH);
    await until(() => s.toInfo().status === "error" && provider.teardownCount >= 1);
  });

  test("a limit too long for one timer is not mistaken for 1 ms", async () => {
    const { s, provider } = session({ minutes: 100_000 });
    await s.send("hello", AUTH);
    await until(() => s.toInfo().status === "idle");
    await Bun.sleep(200);
    expect(provider.teardownCount).toBe(0);
  });

  test("a watcher the backend started for itself doesn't hold it", async () => {
    const { s, provider } = session();
    await s.send("hello", AUTH);
    await until(() => s.toInfo().status === "idle");
    provider.onSessionEvent?.({ type: "background_tasks", tasks: [{ id: "w1", kind: "local_bash", description: "watcher", status: "running", ambient: true }] });
    await until(() => provider.teardownCount >= 1);
  });

  test("what the backend left running is stopped with it", async () => {
    // A stand-in backend whose teardown (like codex's bare SIGKILL) leaves its child running.
    const backend = Bun.spawn(["sh", "-c", "sleep 30 & wait"], { stdout: "ignore", stderr: "ignore" });
    try {
      const { s, provider } = session({ minutes: 1 });
      Object.assign(provider, { backendProcessIds: async () => [backend.pid] });
      await s.send("hello", AUTH);
      await until(() => s.toInfo().status === "idle");
      s.releaseIdleProvider({ idle: true });
      await until(() => provider.teardownCount >= 1);
      await Promise.race([backend.exited, Bun.sleep(3000)]);
      expect(backend.exitCode !== null || backend.signalCode !== null).toBe(true);
    } finally {
      backend.kill("SIGKILL");
    }
  });

  test("0 keeps the backend running", async () => {
    const { s, provider } = session({ minutes: 0 });
    await s.send("hello", AUTH);
    await until(() => s.toInfo().status === "idle");
    await Bun.sleep(200);
    expect(provider.teardownCount).toBe(0);
  });

  test("a session that has only just gone idle keeps its backend", async () => {
    const { s, provider } = session({ minutes: 1 });
    await s.send("hello", AUTH);
    await until(() => s.toInfo().status === "idle");
    await Bun.sleep(200);
    expect(provider.teardownCount).toBe(0);
  });

  test("a backend that holds no process is never released", async () => {
    const { s, provider } = session({ providerId: "openai" });
    await s.send("hello", AUTH);
    await until(() => s.toInfo().status === "idle");
    await Bun.sleep(200);
    expect(provider.teardownCount).toBe(0);
  });

  test("live background work keeps the backend until it's done", async () => {
    const { s, provider } = session();
    await s.send("hello", AUTH);
    await until(() => s.toInfo().status === "idle");
    provider.onSessionEvent?.({ type: "background_tasks", tasks: [{ id: "bg1", kind: "local_agent", description: "still working", status: "running" }] });
    const before = provider.teardownCount;
    await Bun.sleep(200);
    expect(provider.teardownCount).toBe(before);
  });

  test("a destroyed session's countdown never fires", async () => {
    const { s, provider } = session({ minutes: 0.002 });
    await s.send("hello", AUTH);
    await until(() => s.toInfo().status === "idle");
    await s.destroy(AUTH);
    const afterDestroy = provider.teardownCount;
    await Bun.sleep(300);
    expect(provider.teardownCount).toBe(afterDestroy);
  });
});
