import { describe, test, expect } from "bun:test";
import { SqliteEpisodeStore } from "./store";
import { MemoryEngine } from "./engine";
import { memoryToolDefs, MEMORY_TOOL_NAMES, type MemoryToolContext } from "./tools";
import type { Embedder } from "./embedder";
import type { Episode } from "./types";

/** Deterministic 8-dim char-histogram embedder — vector path always yields
 *  candidates, so filters (filePaths, workspace) are what the assertions test. */
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

function ep(
  workspaceId: string,
  sessionId: string,
  summary: string,
  content: string,
  extra: Partial<Omit<Episode, "id">> = {},
): Omit<Episode, "id"> {
  return {
    workspaceId,
    sessionId,
    kind: "user_turn",
    summary,
    content,
    filePaths: [],
    tokenEstimate: Math.ceil(content.length / 4),
    createdAt: 1_000_000,
    createdBy: "test",
    ...extra,
  };
}

async function engineWith(): Promise<{ engine: MemoryEngine; ids: Record<string, string> }> {
  const store = new SqliteEpisodeStore(":memory:");
  const engine = new MemoryEngine({ store, embedder: new FakeEmbedder() });
  await engine.init();
  const ids: Record<string, string> = {};
  ids.a1 = engine.ingest(ep("wsA", "sA1", "alpha turn", "alpha unicorn deployment")).id;
  ids.a2 = engine.ingest(ep("wsA", "sA2", "beta turn", "beta widget refactor")).id;
  ids.aFile = engine.ingest(
    ep("wsA", "sA2", "read config", "opened the config file", { kind: "tool_call", toolName: "Read", filePaths: ["/x/config.ts"] }),
  ).id;
  ids.b1 = engine.ingest(ep("wsB", "sB1", "gamma turn", "gamma telescope migration")).id;
  await engine.drain();
  return { engine, ids };
}

const defs = () => Object.fromEntries(memoryToolDefs().map((d) => [d.name, d]));
const ctxFor = (engine: MemoryEngine, workspaceId: string, sessionId: string): MemoryToolContext => ({
  engine,
  workspaceId,
  sessionId,
});

describe("memory tool registry", () => {
  test("registry exposes exactly the four named tools", () => {
    const names = memoryToolDefs().map((d) => d.name).sort();
    expect(names).toEqual([...MEMORY_TOOL_NAMES].sort());
    for (const d of memoryToolDefs()) {
      expect(d.zodShape).toBeDefined();
      expect(d.jsonSchema).toBeDefined();
    }
  });

  test("recall returns verbatim hits with episode_id, excludes current session by default", async () => {
    const { engine } = await engineWith();
    // Caller is sA1; default excludes sA1's own turns, so we should see sA2/other.
    const text = await defs().recall!.run({ query: "widget refactor" }, ctxFor(engine, "wsA", "sA1"));
    expect(text).toContain("episode_id:");
    expect(text).toContain("widget refactor"); // verbatim content surfaced
    expect(text).not.toContain("alpha unicorn"); // sA1's own turn excluded
  });

  test("recall_file: not-found vs found", async () => {
    const { engine } = await engineWith();
    const miss = await defs().recall_file!.run({ path: "/nope/missing.ts" }, ctxFor(engine, "wsA", "sX"));
    expect(miss).toContain("No prior reads of /nope/missing.ts");
    const hit = await defs().recall_file!.run({ path: "/x/config.ts" }, ctxFor(engine, "wsA", "sX"));
    expect(hit).toContain("prior read(s) of /x/config.ts");
    expect(hit).toContain("episode_id:");
  });

  test("timeline is ordered, carries episode_id, and pages with offset", async () => {
    const { engine } = await engineWith();
    const page1 = await defs().timeline!.run({ limit: 2, offset: 0 }, ctxFor(engine, "wsA", "sA1"));
    expect(page1).toContain("episode_id:");
    // wsA has 3 episodes; a 2/2 split means page 2 has the remaining one.
    const page2 = await defs().timeline!.run({ limit: 2, offset: 2 }, ctxFor(engine, "wsA", "sA1"));
    expect(page2).toContain("offset 2");
    const empty = await defs().timeline!.run({ limit: 2, offset: 99 }, ctxFor(engine, "wsA", "sA1"));
    expect(empty).toContain("No more episodes past offset 99");
  });

  test("get_episode returns verbatim content for a same-workspace id", async () => {
    const { engine, ids } = await engineWith();
    const text = await defs().get_episode!.run({ episode_id: ids.a1 }, ctxFor(engine, "wsA", "sA1"));
    expect(text).toContain("alpha unicorn deployment");
    expect(text).toContain(`episode_id: ${ids.a1}`);
  });

  test("get_episode is tenant-scoped: a foreign-workspace id is NOT returned", async () => {
    const { engine, ids } = await engineWith();
    // ids.b1 belongs to wsB; a wsA caller must not be able to read it.
    const text = await defs().get_episode!.run({ episode_id: ids.b1 }, ctxFor(engine, "wsA", "sA1"));
    expect(text).toBe(`Episode ${ids.b1} not found in this workspace.`);
    expect(text).not.toContain("telescope");
    // And it IS reachable from its own workspace.
    const own = await defs().get_episode!.run({ episode_id: ids.b1 }, ctxFor(engine, "wsB", "sB1"));
    expect(own).toContain("gamma telescope migration");
  });

  test("clamps out-of-range args (run() doesn't trust the transport)", async () => {
    const { engine } = await engineWith();
    // limit=-1 -> clamped to >=1, offset=-5 -> clamped to 0: returns the newest
    // page rather than an empty/errored result.
    const t = await defs().timeline!.run({ limit: -1, offset: -5 }, ctxFor(engine, "wsA", "sA1"));
    expect(t).toContain("episode_id:");
    // an absurd recall limit must not blow past the max or throw.
    const r = await defs().recall!.run({ query: "widget", limit: 9999 }, ctxFor(engine, "wsA", "sA1"));
    expect(typeof r).toBe("string");
  });
});
