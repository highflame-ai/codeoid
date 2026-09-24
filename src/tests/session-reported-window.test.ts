/**
 * The context window comes from the BACKEND, not from a table keyed on model id.
 *
 * codeoid used to infer every window from `contextWindowForModel`, a substring
 * match over model ids. That is wrong the moment a model ships: `claude-opus-5-5`
 * inferred to the 200k fallback while every turn result reported 1,000,000, so
 * the percent-of-window display, the fork seed budget, and the auto-rotate
 * occupancy that decides when a session rolls were all sized against a fifth of
 * the real capacity.
 *
 * The provider now reports what the backend said and the session prefers it.
 * The table stays as the bootstrap — nothing can know the window before a turn
 * completes (the supported-models list carries none) and some backends report
 * none at all — so these tests pin both directions: reported wins when present,
 * inference still answers when it is absent.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../daemon/store.js";
import { TranscriptStore } from "../daemon/transcript.js";
import { Session } from "../daemon/session.js";
import { MockSessionProvider, mockResult } from "../daemon/providers/mock/session-provider.js";
import { contextWindowForModel } from "../daemon/context-windows.js";
import type { ProviderEvent } from "../daemon/providers/interface.js";
import type { AuthContext } from "../protocol/types.js";
import { ALL_SCOPES } from "../protocol/scopes.js";
import { SessionManager } from "../daemon/session-manager.js";
import { normalizeModelCatalog } from "../daemon/providers/qwen/index.js";
import { targetContextWindow } from "../daemon/providers/context-windows.js";
import { MemoryEngine } from "../daemon/memory/engine.js";
import { SqliteEpisodeStore } from "../daemon/memory/store.js";
import type { Embedder } from "../daemon/memory/embedder.js";

/** `SessionInfo.usage` is assembled by #refreshUsageFromStore, which needs a
 *  memory engine to read turn rows back from — hence the fake embedder. */
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
  // Let the fire-and-forget meta writes land before the dir goes away, or
  // teardown races them and floods the output with ENOENT renames.
  await Bun.sleep(120);
  store.close();
  rmSync(tmp, { recursive: true, force: true });
});

/** One turn whose result carries (or omits) a backend-reported window. */
function sessionRunning(
  turns: ProviderEvent[][],
  onModelLimits?: (p: string, m: string, l: { contextWindow: number; maxOutputTokens?: number }) => void,
): Session {
  return new Session({
    name: "window-test",
    workdir: tmp,
    auth: AUTH,
    store,
    transcriptStore,
    existingId: randomUUID(),
    memory,
    _testProvider: new MockSessionProvider("mock", turns),
    ...(onModelLimits ? { onModelLimits } : {}),
  });
}

const turn = (result: Parameters<typeof mockResult>[0]): ProviderEvent[] => [
  { type: "text_done", content: "ok" } as ProviderEvent,
  { type: "turn_done", result: mockResult(result) } as ProviderEvent,
];

/** `send()` resolves once the prompt is queued, not once the turn is done —
 *  the events drain asynchronously, so wait for the session to go idle. */
async function runTurn(s: Session, text: string): Promise<void> {
  await s.send(text, AUTH);
  const deadline = Date.now() + 2000;
  while (s.status !== "idle") {
    if (Date.now() > deadline) throw new Error(`turn "${text}" never finished`);
    await Bun.sleep(5);
  }
}

describe("a session reports the window its backend stated", () => {
  it("prefers the reported window over what the id would infer", async () => {
    // `mock-model` is not a Claude id, so inference gives the conservative
    // 200k default — a value the assertion below would match by accident if
    // the reported number were ignored. Report something that cannot be
    // confused with it.
    expect(contextWindowForModel("mock-model")).not.toBe(777_000);

    const s = sessionRunning([turn({ contextWindow: 777_000, maxOutputTokens: 64_000 })]);
    await runTurn(s, "hi");
    expect(s.toInfo().usage?.contextWindow).toBe(777_000);
  });

  it("falls back to inference before any turn has reported", () => {
    // The state every fresh session and every just-resumed session is in:
    // nothing has run, so there is nothing to prefer.
    const s = sessionRunning([turn({ contextWindow: 777_000 })]);
    expect(s.toInfo().usage?.contextWindow).toBe(contextWindowForModel(null));
  });

  it("falls back to inference when the backend reports no window", async () => {
    // qwen against the Bailian gateway returns an empty usage map. That must
    // land on the inferred number, never on 0 — a zero window would divide
    // the percent-of-window by zero and starve the seed budget.
    const s = sessionRunning([turn({})]);
    await runTurn(s, "hi");
    const w = s.toInfo().usage?.contextWindow;
    expect(w).toBe(contextWindowForModel(null));
    expect(w).toBeGreaterThan(0);
  });

  it("keeps the last reported window when a later turn omits it", async () => {
    // Sticky on purpose. A provider that reports on turn 1 and not on turn 2
    // has not said the window changed, so flapping back to the inferred value
    // would make the number oscillate between correct and wrong.
    const s = sessionRunning([
      turn({ contextWindow: 777_000 }),
      turn({}),
    ]);
    await runTurn(s, "one");
    expect(s.toInfo().usage?.contextWindow).toBe(777_000);
    await runTurn(s, "two");
    expect(s.toInfo().usage?.contextWindow).toBe(777_000);
  });

  it("follows the backend when a later turn reports a different window", async () => {
    // The `/model` switch case: the next turn runs on another model and the
    // backend says so. Nothing here needs to know which model that was.
    const s = sessionRunning([
      turn({ contextWindow: 200_000 }),
      turn({ contextWindow: 1_000_000 }),
    ]);
    await runTurn(s, "one");
    expect(s.toInfo().usage?.contextWindow).toBe(200_000);
    await runTurn(s, "two");
    expect(s.toInfo().usage?.contextWindow).toBe(1_000_000);
  });

  it("hands the limits up so the daemon can cache them for every session", async () => {
    // A window is a property of the MODEL, not of whoever ran the turn, so the
    // first session to learn it teaches the rest — and the persisted copy is
    // what stops a restart from dropping back to inference.
    const seen: { p: string; m: string; w: number; out?: number }[] = [];
    const s = sessionRunning(
      [turn({ model: "some-model", contextWindow: 777_000, maxOutputTokens: 64_000 })],
      (p, m, l) => seen.push({ p, m, w: l.contextWindow, out: l.maxOutputTokens }),
    );
    await runTurn(s, "hi");
    expect(seen).toEqual([{ p: "mock", m: "some-model", w: 777_000, out: 64_000 }]);
  });

  it("does not hand up a window the backend never gave", async () => {
    const seen: unknown[] = [];
    const s = sessionRunning([turn({})], (...a) => seen.push(a));
    await runTurn(s, "hi");
    expect(seen).toEqual([]);
  });
});

// ── Per-provider ingress ─────────────────────────────────────────────────────

// The design has to hold for every backend codeoid drives, and they do not
// agree on how (or whether) they publish a window. Audited against each:
//
//   claude  per-turn   result.modelUsage[model].contextWindow
//   codex   per-turn   thread/tokenUsage/updated → tokenUsage.modelContextWindow
//   qwen    per-MODEL  its catalog's contextWindowSize — known BEFORE any turn
//   gemini  none       direct API; the response carries no window
//   openai  none       same
//   pi      none       same
//   acp     none       gemini-cli over ACP publishes no limits
//
// So the daemon accepts two ingresses into one (provider, model) cache and
// keeps inference as the floor for the four that report nothing. These tests
// pin that both doors work and that the silent backends stay safe.
describe("every backend's window ingress", () => {
  it("accepts a window published on the CATALOG (qwen's shape)", () => {
    const m = new SessionManager(store, transcriptStore);
    // qwen lists models with `contextWindowSize`; normalizeModelCatalog maps it
    // to `contextWindow` and the emit forwards it, so the daemon knows the
    // window with zero turns run — the one backend where that is possible.
    (m as unknown as {
      _cacheModels(p: string, raw: { value: string; displayName: string; contextWindow?: number }[]): void;
    })._cacheModels("qwen", [
      { value: "qwen3.8-max", displayName: "qwen3.8-max", contextWindow: 262_144 },
      { value: "glm-5.3", displayName: "glm-5.3" }, // no window published
    ]);
    expect(m.modelContextWindow("qwen", "qwen3.8-max")).toBe(262_144);
    // An entry without one must not invent a number.
    expect(m.modelContextWindow("qwen", "glm-5.3")).toBeUndefined();
  });

  it("normalizes qwen's contextWindowSize off the real catalog shape", () => {
    // Verbatim projection @qwen-code/sdk 0.1.8 emits: id/label/capabilities/
    // contextWindowSize — note `label`, and the window under its own name.
    const [first, second] = normalizeModelCatalog({
      subtype: "models",
      models: [
        { id: "qwen3.8-max", label: "qwen3.8-max", capabilities: [], contextWindowSize: 262_144 },
        { id: "auto", label: "auto", capabilities: [] },
      ],
    });
    expect(first).toMatchObject({ id: "qwen3.8-max", contextWindow: 262_144 });
    expect(second?.contextWindow).toBeUndefined();
  });

  it("ignores a non-positive or non-numeric published window", () => {
    // A backend that sends 0/null must fall through to inference rather than
    // poisoning the cache with a window that divides by zero.
    expect(normalizeModelCatalog({ models: [{ id: "m", label: "m", contextWindowSize: 0 }] })[0]
      ?.contextWindow).toBeUndefined();
    expect(normalizeModelCatalog({ models: [{ id: "m", label: "m", contextWindowSize: null }] })[0]
      ?.contextWindow).toBeUndefined();
  });

  it("leaves a silent backend on inference, never on zero", async () => {
    // gemini / openai / pi / acp report nothing. That is not a failure mode —
    // it is the case the static table exists for, and it must stay a positive
    // number so percent-of-window and the seed budget keep working.
    for (const providerId of ["gemini", "openai", "pi", "gemini-cli"]) {
      expect(targetContextWindow(providerId, "some-model")).toBeGreaterThan(0);
      // And nothing was cached for them, so the floor is what answers.
      expect(new SessionManager(store, transcriptStore).modelContextWindow(providerId, "some-model"))
        .toBeUndefined();
    }
  });
});
