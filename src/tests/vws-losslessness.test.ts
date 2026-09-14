/**
 * VWS losslessness invariant (#178 Phase 1) — deterministic, no LLM.
 *
 * The gated resume-beyond-budget eval (backends.integration.test.ts) proves the
 * end-to-end behavior against a real backend. This test proves the invariant it
 * rests on, in CI, with pure pieces:
 *
 *   When the transcript seed truncates (drops the oldest turns to fit a budget),
 *   those exact turns are STILL retrievable verbatim from memory via the tool
 *   registry — get_episode by id and timeline paging.
 *
 * i.e. dropped-from-context ≠ lost. That is the whole point of paging the
 * verbatim store instead of shipping a lossy transcript.
 *
 * Also exercises the CODEOID_SEED_BUDGET_CHARS operator override that the eval
 * uses to force truncation cheaply.
 */

import { describe, test, expect, afterEach } from "bun:test";
import { renderHistorySeed, type CanonicalTurn } from "../daemon/providers/canonical.js";
import { seedBudgetChars } from "../daemon/providers/context-windows.js";
import { MemoryEngine } from "@highflame/codeoid-memory/engine.js";
import { SqliteEpisodeStore } from "@highflame/codeoid-memory/store.js";
import { memoryToolDefs, type MemoryToolContext } from "@highflame/codeoid-memory/tools.js";
import type { Embedder } from "@highflame/codeoid-memory/embedder.js";
import type { Episode } from "@highflame/codeoid-memory/types.js";

class FakeEmbedder implements Embedder {
  readonly modelName = "fake-test";
  readonly dimensions = 8;
  async init(): Promise<void> {}
  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((t) => {
      const v = new Float32Array(this.dimensions);
      for (const ch of t.toLowerCase()) {
        const c = ch.charCodeAt(0);
        if (c >= 97 && c <= 122) v[(c - 97) % this.dimensions]! += 1;
      }
      return v;
    });
  }
  async close(): Promise<void> {}
}

const SECRET = "CRIMSON-OTTER-8842";
const WS = "ws_rbb";

/** A beyond-budget history: turn 0 (oldest) holds SECRET; then bulky fillers. */
function asst(content: string): CanonicalTurn {
  return { role: "assistant", content, providerId: "claude", model: "claude-opus-4" };
}

function buildHistory(): CanonicalTurn[] {
  const h: CanonicalTurn[] = [
    { role: "user", content: `Please remember this exactly: the vault passphrase is ${SECRET}.` },
    asst("Stored."),
  ];
  for (let i = 0; i < 6; i++) {
    h.push({ role: "user", content: `Filler question ${i}: ${"lorem ipsum dolor sit amet ".repeat(8)}` });
    h.push(asst(`Filler answer ${i}: ${"consectetur adipiscing elit ".repeat(8)}`));
  }
  return h;
}

function ingestHistory(engine: MemoryEngine, history: CanonicalTurn[]): string {
  let secretId = "";
  history.forEach((t, i) => {
    const rec: Omit<Episode, "id"> = {
      workspaceId: WS,
      sessionId: "sSource",
      kind: t.role === "user" ? "user_turn" : "assistant_turn",
      summary: t.content.slice(0, 80),
      content: t.content,
      filePaths: [],
      tokenEstimate: Math.ceil(t.content.length / 4),
      createdAt: 1_000_000 + i,
      createdBy: "test",
    };
    const { id } = engine.ingest(rec);
    if (t.content.includes(SECRET)) secretId = id;
  });
  return secretId;
}

const defs = () => Object.fromEntries(memoryToolDefs().map((d) => [d.name, d]));
const ctx = (engine: MemoryEngine): MemoryToolContext => ({ engine, workspaceId: WS, sessionId: "sFork" });

describe("VWS losslessness invariant", () => {
  afterEach(() => { delete process.env.CODEOID_SEED_BUDGET_CHARS; });

  test("CODEOID_SEED_BUDGET_CHARS overrides the computed budget", () => {
    const computed = seedBudgetChars("claude", null);
    process.env.CODEOID_SEED_BUDGET_CHARS = "600";
    expect(seedBudgetChars("claude", null)).toBe(600);
    delete process.env.CODEOID_SEED_BUDGET_CHARS;
    expect(seedBudgetChars("claude", null)).toBe(computed);
    // A non-positive / non-numeric override is ignored (falls back to computed).
    process.env.CODEOID_SEED_BUDGET_CHARS = "0";
    expect(seedBudgetChars("claude", null)).toBe(computed);
    process.env.CODEOID_SEED_BUDGET_CHARS = "not-a-number";
    expect(seedBudgetChars("claude", null)).toBe(computed);
  });

  test("a tiny budget drops the oldest turn from the transcript seed", () => {
    const history = buildHistory();
    const seed = renderHistorySeed(history, { maxChars: 600 });
    // The SECRET-bearing oldest turn does NOT survive the truncated transcript…
    expect(seed.text).not.toContain(SECRET);
    expect(seed.omittedTurns).toBeGreaterThan(0);
    // …but the most recent turns are kept (transcript is newest-first).
    expect(seed.keptTurns).toBeGreaterThan(0);
    expect(seed.keptTurns).toBeLessThan(seed.totalTurns);
  });

  test("the dropped turn is still recoverable verbatim via get_episode and timeline", async () => {
    const engine = new MemoryEngine({ store: new SqliteEpisodeStore(":memory:"), embedder: new FakeEmbedder() });
    await engine.init();
    try {
      const history = buildHistory();
      const secretId = ingestHistory(engine, history);
      await engine.drain();
      expect(secretId).not.toBe("");

      // Confirm the transcript seed would have dropped it (same budget the eval uses).
      expect(renderHistorySeed(history, { maxChars: 600 }).text).not.toContain(SECRET);

      // Exact-by-id fetch returns the dropped turn verbatim.
      const byId = await defs().get_episode!.run({ episode_id: secretId }, ctx(engine));
      expect(byId).toContain(SECRET);

      // Ordered paging can always walk to it: the SECRET episode's id appears
      // somewhere in the full timeline (the page table the session map ships).
      let found = false;
      for (let offset = 0; offset < history.length + 4 && !found; offset += 4) {
        const page = await defs().timeline!.run({ offset, limit: 4 }, ctx(engine));
        if (page.includes(secretId)) found = true;
      }
      expect(found).toBe(true);
    } finally {
      await engine.close();
    }
  });
});
