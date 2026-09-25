/**
 * A session's context window comes from what its backend stated, resolved in
 * one place and used by every consumer: display, occupancy caps, auto-rotate,
 * and the history seed a provider switch or fork hands the next backend.
 *
 * Each block below pins a failure the first version of this change had:
 *
 *   - the stated window was a bare number that outlived the model it described,
 *     so `/provider codex` from an Opus session seeded codex with a history
 *     sized for Opus's 1M (2.45M chars into a 272k window, no truncation
 *     notice) and kept displaying 1M on a backend that never reports;
 *   - auto-rotate still divided by a 1M constant, so a 200k or 272k session
 *     could never reach its 0.97 hard ceiling;
 *   - the display was only computed inside the memory-engine refresh, so with
 *     memory off it was never set at all;
 *   - a fork never saw its parent's window, so it seeded against the 200k floor
 *     on a 1M model.
 *
 * The floors still answer when nothing has been stated — before a first turn,
 * and on backends that publish no limits (gemini, openai, acp).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../daemon/store.js";
import { TranscriptStore } from "../daemon/transcript.js";
import { Session, type WindowScope } from "../daemon/session.js";
import { SessionManager } from "../daemon/session-manager.js";
import { ProviderRegistry } from "../daemon/providers/registry.js";
import { MockSessionProvider, mockResult } from "../daemon/providers/mock/session-provider.js";
import { seedBudgetChars, targetContextWindow } from "../daemon/providers/context-windows.js";
import type { ProviderEvent } from "../daemon/providers/interface.js";
import type { CodeoidConfig } from "../config.js";
import type { AuthContext } from "../protocol/types.js";
import { ALL_SCOPES } from "../protocol/scopes.js";
import { MemoryEngine } from "../daemon/memory/engine.js";
import { SqliteEpisodeStore } from "../daemon/memory/store.js";
import type { Embedder } from "../daemon/memory/embedder.js";

/** `SessionInfo.usage`'s token fields come from #refreshUsageFromStore, which
 *  reads turn rows back through a memory engine — hence the fake embedder. */
class FakeEmbedder implements Embedder {
  readonly modelName = "fake-test";
  readonly dimensions = 8;
  async init(): Promise<void> {}
  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map(() => new Float32Array(this.dimensions));
  }
  async close(): Promise<void> {}
}

const AUTH: AuthContext = {
  sub: "user:window",
  scopes: [...ALL_SCOPES] as AuthContext["scopes"],
  delegationDepth: 0,
  accountId: "acc-w",
  projectId: "proj-w",
};

let tmp: string;
let store: Store;
let transcriptStore: TranscriptStore;
let memory: MemoryEngine;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "codeoid-window-"));
  store = new Store(join(tmp, "codeoid.db"));
  transcriptStore = new TranscriptStore(join(tmp, "transcripts"));
  memory = new MemoryEngine({ store: new SqliteEpisodeStore(":memory:"), embedder: new FakeEmbedder() });
  await memory.init();
});

afterEach(async () => {
  // Drain the fire-and-forget meta writes deterministically before the dir
  // goes away, rather than sleeping and hoping.
  try {
    await transcriptStore.flush();
  } catch {}
  await memory.close();
  store.close();
  rmSync(tmp, { recursive: true, force: true });
});

const turn = (result: Parameters<typeof mockResult>[0]): ProviderEvent[] => [
  { type: "text_done", content: "ok" } as ProviderEvent,
  { type: "turn_done", result: mockResult(result) } as ProviderEvent,
];

/** `send()` resolves once the prompt is queued; the turn drains asynchronously. */
async function runTurn(s: Session, text: string): Promise<void> {
  await s.send(text, AUTH);
  const deadline = Date.now() + 2000;
  while (s.status !== "idle" && s.status !== "error") {
    if (Date.now() > deadline) throw new Error(`turn "${text}" never finished`);
    await Bun.sleep(5);
  }
}

function newSession(opts: {
  turns?: ProviderEvent[][];
  registry?: ProviderRegistry;
  providerId?: string;
  withMemory?: boolean;
  config?: CodeoidConfig;
  onModelLimits?: (scope: WindowScope, p: string, m: string, w: number) => void;
  modelWindow?: (scope: WindowScope, p: string, m: string) => number | undefined;
}): Session {
  return new Session({
    name: "window-test",
    workdir: tmp,
    auth: AUTH,
    store,
    transcriptStore,
    existingId: randomUUID(),
    ...(opts.withMemory === false ? {} : { memory }),
    ...(opts.registry
      ? { providers: opts.registry, providerId: opts.providerId }
      : { _testProvider: new MockSessionProvider("mock", opts.turns ?? []) }),
    ...(opts.config ? { config: opts.config } : {}),
    ...(opts.onModelLimits ? { onModelLimits: opts.onModelLimits } : {}),
    ...(opts.modelWindow ? { modelWindow: opts.modelWindow } : {}),
  });
}

/** Two-backend registry, capturing each built provider for inspection. */
function twoBackends(a: ProviderEvent[][], b: ProviderEvent[][] = []) {
  const created: Record<string, MockSessionProvider[]> = { "mock-a": [], "mock-b": [] };
  const registry = new ProviderRegistry("mock-a");
  for (const id of ["mock-a", "mock-b"] as const) {
    registry.register({
      id,
      displayName: id,
      create: () => {
        const p = new MockSessionProvider(id, (id === "mock-a" ? a : b).map((t) => [...t]));
        created[id]!.push(p);
        return p;
      },
    });
  }
  return { registry, created };
}

describe("a session reports the window its backend stated", () => {
  it("prefers the stated window over the floor", async () => {
    const s = newSession({ turns: [turn({ contextWindow: 777_000 })] });
    await runTurn(s, "hi");
    expect(s.toInfo().usage?.contextWindow).toBe(777_000);
  });

  it("answers with the provider's floor before any turn has reported", () => {
    // Every fresh and just-resumed session is here. The floor is provider-
    // aware: the Claude-only table used to answer for every backend.
    const s = newSession({ turns: [turn({ contextWindow: 777_000 })] });
    expect(s.toInfo().usage?.contextWindow).toBe(targetContextWindow("mock", null));
  });

  it("stays on the floor, never zero, when the backend states nothing", async () => {
    const s = newSession({ turns: [turn({})] });
    await runTurn(s, "hi");
    expect(s.toInfo().usage?.contextWindow).toBe(targetContextWindow("mock", null));
  });

  it("keeps the stated window across a turn that omits it", async () => {
    // Omitting a number is not changing it; falling back here would make the
    // window oscillate between stated and guessed.
    const s = newSession({ turns: [turn({ contextWindow: 777_000 }), turn({})] });
    await runTurn(s, "one");
    await runTurn(s, "two");
    expect(s.toInfo().usage?.contextWindow).toBe(777_000);
  });

  it("follows a later turn that states a different window", async () => {
    const s = newSession({ turns: [turn({ contextWindow: 200_000 }), turn({ contextWindow: 1_000_000 })] });
    await runTurn(s, "one");
    expect(s.toInfo().usage?.contextWindow).toBe(200_000);
    await runTurn(s, "two");
    expect(s.toInfo().usage?.contextWindow).toBe(1_000_000);
  });

  it("is set even with the memory engine off", async () => {
    // The display used to be computed only inside the memory refresh, so with
    // CODEOID_MEMORY=0 it was never emitted and the web UI divided by 200k —
    // a 1M session at 400k read "ctx 200%".
    const s = newSession({ turns: [turn({ contextWindow: 1_000_000 })], withMemory: false });
    await runTurn(s, "hi");
    expect(s.toInfo().usage?.contextWindow).toBe(1_000_000);
  });
});

describe("the stated window never outlives the model it describes", () => {
  it("a provider switch seeds and displays for the INCOMING backend", async () => {
    // The headline regression. mock-a states a large window; after switching,
    // mock-b's seed must be sized for mock-b, not for mock-a's number.
    const { registry, created } = twoBackends([turn({ contextWindow: 1_000_000 })]);
    const s = newSession({ registry, providerId: "mock-a" });
    await runTurn(s, "on a");
    expect(s.toInfo().usage?.contextWindow).toBe(1_000_000);

    const res = await s.switchProvider("mock-b", AUTH);
    expect(res.ok).toBe(true);
    expect(created["mock-b"]![0]!.seededMaxChars).toBe(seedBudgetChars("mock-b", null));
    expect(s.toInfo().usage?.contextWindow).toBe(targetContextWindow("mock-b", null));
  });

  it("a model switch drops it until the new model states its own", async () => {
    const s = newSession({ turns: [turn({ contextWindow: 777_000 })] });
    await runTurn(s, "hi");
    await s.setModel("some-other-model", undefined, AUTH);
    expect(s.toInfo().usage?.contextWindow).toBe(targetContextWindow("mock", "some-other-model"));
  });
});

describe("auto-rotate sizes occupancy against the stated window", () => {
  it("fires the hard ceiling on a 200k model instead of waiting for 970k", async () => {
    // Against a 1M constant, 195k is 19.5% — the 0.97 hard net could never
    // fire for a model whose window is 200k. Against the stated window it is
    // 97.5%, which is exactly what the net is for.
    const config = {
      session: {},
      autoRotate: { enabled: false, rotatePct: 0.9, hardRotatePct: 0.97, minTurnsBeforeRotate: 5 },
    } as unknown as CodeoidConfig;
    const s = newSession({
      turns: [turn({ inputTokens: 195_000, contextWindow: 200_000 }), turn({ contextWindow: 200_000 })],
      config,
    });
    await runTurn(s, "fill");
    expect(s.toInfo().usage?.lastTurnInputTokens).toBe(195_000);
    await runTurn(s, "next");
    expect(s.toInfo().rotation?.count).toBe(1);
  });
});

describe("the daemon remembers stated windows per scope", () => {
  it("hands a stated window up with the scope it was seen in", async () => {
    const seen: unknown[] = [];
    const s = newSession({
      turns: [turn({ model: "some-model", contextWindow: 777_000 })],
      onModelLimits: (scope, p, m, w) => seen.push({ scope, p, m, w }),
    });
    await runTurn(s, "hi");
    expect(seen).toEqual([
      { scope: { accountId: "acc-w", projectId: "proj-w", workdir: tmp }, p: "mock", m: "some-model", w: 777_000 },
    ]);
  });

  it("never teaches a placeholder model id", async () => {
    // "unknown" (and codex's bare "codex", pi's "pi-default") name no model;
    // as a cache key they would answer for whatever that default happens to be.
    const seen: unknown[] = [];
    const s = newSession({
      turns: [turn({ model: "unknown", contextWindow: 777_000 })],
      onModelLimits: (...a) => seen.push(a),
    });
    await runTurn(s, "hi");
    expect(seen).toEqual([]);
    // ...though this session still displays what its backend said.
    expect(s.toInfo().usage?.contextWindow).toBe(777_000);
  });

  it("scopes the cache, so one workdir's settings can't size another tenant's seed", () => {
    // The Claude CLI derives the window from settings a workdir can override
    // (CLAUDE_CODE_MAX_CONTEXT_TOKENS is unclamped). Unscoped, one workdir's
    // 4M became every tenant's fork budget.
    const m = new SessionManager(store, transcriptStore);
    const cache = m as unknown as { _cacheModelLimits(s: WindowScope, p: string, mo: string, w: number): void };
    const a: WindowScope = { accountId: "A", projectId: "p", workdir: "/w1" };
    const b: WindowScope = { accountId: "B", projectId: "p", workdir: "/w2" };
    cache._cacheModelLimits(a, "claude", "claude-opus-5-5", 4_000_000);
    expect(m.modelContextWindow(a, "claude", "claude-opus-5-5")).toBe(4_000_000);
    expect(m.modelContextWindow(b, "claude", "claude-opus-5-5")).toBeUndefined();
    // Survives a restart, in its own scope only.
    const next = new SessionManager(store, transcriptStore);
    expect(next.modelContextWindow(a, "claude", "claude-opus-5-5")).toBe(4_000_000);
    expect(next.modelContextWindow(b, "claude", "claude-opus-5-5")).toBeUndefined();
  });

  it("serves a catalog-published window, and stops when the catalog does", () => {
    // Read from the catalog itself rather than copied into the turn cache:
    // the copy was upsert-only, so a window the backend stopped publishing
    // kept winning forever.
    const m = new SessionManager(store, transcriptStore);
    const cache = m as unknown as {
      _cacheModels(p: string, raw: { value: string; displayName: string; contextWindow?: number }[]): void;
    };
    const scope: WindowScope = { accountId: "A", projectId: "p", workdir: "/w" };
    cache._cacheModels("qwen", [{ value: "qwen3.8-max", displayName: "Qwen 3.8 Max", contextWindow: 262_144 }]);
    expect(m.modelContextWindow(scope, "qwen", "qwen3.8-max")).toBe(262_144);
    cache._cacheModels("qwen", [{ value: "qwen3.8-max", displayName: "Qwen 3.8 Max" }]);
    expect(m.modelContextWindow(scope, "qwen", "qwen3.8-max")).toBeUndefined();
  });

  it("uses a remembered window for the session's model before any turn", async () => {
    // What makes the persisted cache worth persisting: a resumed session on a
    // model the table doesn't know renders the stated window, not the guess.
    const s = newSession({
      turns: [],
      modelWindow: (_scope, p, model) => (p === "mock" && model === "known-model" ? 555_000 : undefined),
    });
    await s.setModel("known-model", undefined, AUTH);
    expect(s.toInfo().usage?.contextWindow).toBe(555_000);
  });

  it("a fork on the same model inherits its parent's stated window", async () => {
    const parent = newSession({ turns: [turn({ contextWindow: 1_000_000 })] });
    await runTurn(parent, "hi");
    const fork = newSession({ turns: [] });
    fork.inheritObservedLimits(parent);
    expect(fork.toInfo().usage?.contextWindow).toBe(1_000_000);
  });

  it("a fork on a different model does not", async () => {
    const parent = newSession({ turns: [turn({ contextWindow: 1_000_000 })] });
    await runTurn(parent, "hi");
    const fork = newSession({ turns: [] });
    await fork.setModel("different-model", undefined, AUTH);
    fork.inheritObservedLimits(parent);
    expect(fork.toInfo().usage?.contextWindow).toBe(targetContextWindow("mock", "different-model"));
  });
});
