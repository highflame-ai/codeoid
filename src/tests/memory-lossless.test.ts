/**
 * Lossless memory: nothing an episode carries is truncated in storage, a
 * bounded view of it is indexed, long episodes are embedded in windows, the
 * embedding step can be switched off, and a compressed command's raw output
 * reaches memory instead of the compressed text.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteEpisodeStore, MemoryEngine, EpisodeChunker } from "../daemon/memory/index.js";
import type { Embedder } from "../daemon/memory/embedder.js";
import { EMBED_WINDOW_CHARS, INDEX_VIEW_MAX_CHARS, embedWindows, indexView } from "../daemon/memory/lossless.js";
import { rank } from "../daemon/memory/ranker.js";
import { GET_EPISODE_DEFAULT_PAGE, memoryToolDefs } from "../daemon/memory/tools.js";
import type { Episode } from "../daemon/memory/types.js";
import {
  BUILTIN_RULES,
  CompressionRegistry,
  formatHint,
  pruneSpill,
  runCompressed,
  takeSpill,
  writeSpill,
} from "../daemon/compress/index.js";
import type { SessionMessage } from "../protocol/types.js";

class CountingEmbedder implements Embedder {
  readonly modelName = "count-embed";
  readonly dimensions = 4;
  inits = 0;
  texts: string[] = [];
  async init(): Promise<void> {
    this.inits++;
  }
  async embed(texts: string[]): Promise<Float32Array[]> {
    this.texts.push(...texts);
    return texts.map((t, i) => new Float32Array([1, (t.length % 7) + 1, i + 1, 1]));
  }
  async close(): Promise<void> {}
}

const WS = "ws_lossless";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "codeoid-lossless-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function episode(content: string, extra: Partial<Episode> = {}): Omit<Episode, "id"> {
  return {
    workspaceId: WS,
    sessionId: "s1",
    kind: "tool_call",
    toolName: "Bash",
    summary: "Bash(make)",
    content,
    filePaths: [],
    tokenEstimate: Math.ceil(content.length / 4),
    createdAt: Date.now(),
    createdBy: "u",
    ...extra,
  };
}

/** A build log with one distinctive error buried in the middle. */
function bigLog(chars: number): string {
  const lines: string[] = [];
  let n = 0;
  let i = 0;
  while (n < chars) {
    const line =
      i === 20_000 ? "src/needle.ts:7:3 error TS2304: Cannot find name 'zebraquux'" : `compiling module_${i} ok`;
    lines.push(line);
    n += line.length + 1;
    i++;
  }
  return lines.join("\n");
}

describe("indexView", () => {
  it("leaves a body that fits untouched", () => {
    const body = "x".repeat(INDEX_VIEW_MAX_CHARS);
    expect(indexView(body)).toBe(body);
  });

  it("bounds a huge body to head + diagnostic middle lines + tail, and says so", () => {
    const full = bigLog(2 * 1024 * 1024);
    const view = indexView(full);
    expect(view.length).toBeLessThanOrEqual(INDEX_VIEW_MAX_CHARS + 1024);
    expect(view.startsWith(full.slice(0, 1000))).toBe(true);
    expect(view.endsWith(full.slice(-1000))).toBe(true);
    expect(view).toContain("zebraquux");
    expect(view).toContain("get_episode returns the full verbatim content");
  });
});

describe("embedWindows", () => {
  it("embeds a short body as one window", () => {
    expect(embedWindows("S", "short body", 8)).toEqual(["S\n\nshort body"]);
  });

  it("tiles a body that fits in the window budget", () => {
    const body = "a".repeat(EMBED_WINDOW_CHARS * 3);
    const w = embedWindows("S", body, 8);
    expect(w).toHaveLength(3);
    for (const t of w) expect(t.startsWith("S\n\n")).toBe(true);
  });

  it("puts a window on a diagnostic line buried in a long body", () => {
    const filler = (k: number) => Array.from({ length: k }, (_, i) => `step ${i} ok`).join("\n");
    const body = `${filler(2000)}\nFATAL: ledger currency table missing\n${filler(2000)}`;
    const w = embedWindows("S", body, 4);
    expect(w).toHaveLength(4);
    expect(w.some((t) => t.includes("FATAL: ledger currency table missing"))).toBe(true);
  });

  it("spreads windows over a longer body, always covering the head and the tail", () => {
    const body = `${"h".repeat(10)}${"m".repeat(EMBED_WINDOW_CHARS * 40)}${"t".repeat(10)}`;
    const w = embedWindows("S", body, 5);
    expect(w).toHaveLength(5);
    expect(w[0]!.slice(3, 13)).toBe("hhhhhhhhhh");
    expect(w[4]!.endsWith("tttttttttt")).toBe(true);
  });
});

describe("MemoryEngine — lossless storage", () => {
  it("keeps a 4 MiB tool result whole while indexing only a bounded view", async () => {
    const store = new SqliteEpisodeStore(join(tmp, "m.db"));
    const engine = new MemoryEngine({ store, embedder: new CountingEmbedder() });
    await engine.init();
    const full = bigLog(4 * 1024 * 1024);

    const saved = engine.ingest(episode(full));

    const row = store.getEpisode(saved.id)!;
    expect(row.content.length).toBeLessThan(full.length);
    expect(store.getFullContent(saved.id)).toBe(full);
    // Keyword search still finds the needle from the elided middle.
    expect(store.ftsSearch(WS, "zebraquux", 5).map((h) => h.id)).toContain(saved.id);
    // Stored compressed: far smaller than the text.
    const stats = store.storageStats();
    expect(stats.payloads).toBe(1);
    expect(stats.payloadChars).toBe(full.length);
    expect(stats.payloadBytes).toBeLessThan(full.length / 5);
    await engine.close();
  });

  it("stores a small episode once — no payload row", async () => {
    const store = new SqliteEpisodeStore(join(tmp, "m.db"));
    const engine = new MemoryEngine({ store, embedder: new CountingEmbedder() });
    await engine.init();
    const saved = engine.ingest(episode("small result"));
    expect(store.getFullContent(saved.id)).toBe("small result");
    expect(store.storageStats().payloads).toBe(0);
    await engine.close();
  });

  it("get_episode pages through the full body and says how to continue", async () => {
    const store = new SqliteEpisodeStore(join(tmp, "m.db"));
    const engine = new MemoryEngine({ store, embedder: new CountingEmbedder() });
    await engine.init();
    const full = bigLog(1024 * 1024);
    const saved = engine.ingest(episode(full));
    const getEpisode = memoryToolDefs().find((d) => d.name === "get_episode")!;
    const ctx = { engine, workspaceId: WS, sessionId: "other" };

    const first = await getEpisode.run({ episode_id: saved.id }, ctx);
    expect(first).toContain(`chars 0–${GET_EPISODE_DEFAULT_PAGE} of ${full.length}`);
    expect(first).toContain(`offset ${GET_EPISODE_DEFAULT_PAGE} to continue`);

    // Read every page back and reassemble the body exactly.
    let rebuilt = "";
    let offset = 0;
    while (offset < full.length) {
      const page = await getEpisode.run({ episode_id: saved.id, offset, max_chars: 256 * 1024 }, ctx);
      const body = page.split("\n\n").slice(1).join("\n\n");
      const chunk = body.replace(/\n\n…\[\d+ more chars — call get_episode[^\n]*$/, "");
      rebuilt += chunk;
      offset += chunk.length;
    }
    expect(rebuilt).toBe(full);
    // Another workspace can't read it.
    expect(await getEpisode.run({ episode_id: saved.id }, { ...ctx, workspaceId: "ws_other" })).toContain("not found");
    await engine.close();
  });
});

describe("MemoryEngine — windowed embeddings", () => {
  it("embeds a long episode as several windows and scores it by its best window", async () => {
    const store = new SqliteEpisodeStore(join(tmp, "m.db"));
    const embedder = new CountingEmbedder();
    const engine = new MemoryEngine({ store, embedder, maxEmbedWindows: 4 });
    await engine.init();
    const saved = engine.ingest(episode("y".repeat(EMBED_WINDOW_CHARS * 10)));
    await engine.drain();

    const matrix = store.loadVectorMatrix(WS);
    expect(matrix.ids.filter((id) => id === saved.id)).toHaveLength(4);
    // A cold rebuild reads the same rows back from SQLite.
    const cold = new SqliteEpisodeStore(join(tmp, "m.db"));
    expect(cold.loadVectorMatrix(WS).ids.filter((id) => id === saved.id)).toHaveLength(4);
    cold.close();
    await engine.close();
  });

  it("ranks with the best window score, not just window 0", () => {
    const ep = { ...episode("body"), id: "e1", embedding: new Float32Array([1, 0]) } as Episode;
    const query = new Float32Array([0, 1]);
    const [withWindows] = rank([ep], {
      queryVector: query,
      vectorScores: new Map([["e1", 0.9]]),
      ftsHits: new Map(),
      queryFilePaths: [],
      now: Date.now(),
    });
    const [windowZeroOnly] = rank([ep], { queryVector: query, ftsHits: new Map(), queryFilePaths: [], now: Date.now() });
    expect(withWindows!.components.vector).toBeCloseTo(0.9);
    expect(windowZeroOnly!.components.vector).toBe(0);
  });

  it("memory.embeddings.enabled=false never loads the model and still recalls by keyword", async () => {
    const store = new SqliteEpisodeStore(join(tmp, "m.db"));
    const embedder = new CountingEmbedder();
    const engine = new MemoryEngine({ store, embedder, embeddingsEnabled: false });
    await engine.init();
    const saved = engine.ingest(episode("ran the zebraquux migration"));
    await engine.drain();

    expect(embedder.inits).toBe(0);
    expect(embedder.texts).toHaveLength(0);
    expect(engine.embeddingsReady).toBe(false);
    expect(store.getEpisode(saved.id)!.embedding).toBeUndefined();
    const hits = await engine.recall({ workspaceId: WS, query: "zebraquux" });
    expect(hits.map((h) => h.episode.id)).toEqual([saved.id]);
    await engine.close();
  });
});

describe("raw output of compressed commands", () => {
  it("round-trips through a spill file, which is deleted once taken", () => {
    const id = writeSpill("RAW OUTPUT", tmp)!;
    const output = `compressed\n\n[codeoid: compressed 90% via r; full output in memory (raw=${id}) — recall("x")]`;
    expect(takeSpill(output, tmp)).toBe("RAW OUTPUT");
    expect(existsSync(join(tmp, `${id}.out`))).toBe(false);
    expect(takeSpill(output, tmp)).toBeNull();
  });

  it("ignores a raw reference that isn't the trailing hint line", () => {
    const id = writeSpill("RAW", tmp)!;
    expect(takeSpill(`[codeoid: raw=${id}]\nmore command output after it`, tmp)).toBeNull();
    expect(takeSpill(`raw=${id}`, tmp)).toBeNull();
  });

  it("the hint is honest when no raw output was kept", () => {
    const r = { compressed: "x", originalBytes: 1000, ruleName: "r" };
    expect(formatHint(r, "make", "0e9c5b8a-1111-4222-8333-444455556666")).toContain(
      "raw=0e9c5b8a-1111-4222-8333-444455556666",
    );
    expect(formatHint(r, "make", null)).toContain("was not kept");
  });

  it("the compressing runner spills the raw output and names it in the hint", async () => {
    const out = await runCompressed({
      command: `sh -c 'for i in $(seq 1 2000); do echo "line_$i"; done'`,
      workdir: "/tmp",
      env: process.env as Record<string, string>,
      registry: new CompressionRegistry({ rules: BUILTIN_RULES }),
      minBytes: 1024,
      compressPipes: false,
      spillDir: tmp,
    });
    expect(out.stdout).toContain("lines omitted");
    const raw = takeSpill(out.stdout, tmp)!;
    expect(raw).toContain("line_1000");
    expect(raw.trim().split("\n")).toHaveLength(2000);
  });

  it("the chunker stores the raw output in place of the compressed text", () => {
    const id = writeSpill("line_1\nline_2\nline_3 the whole thing", tmp)!;
    const emitted: Array<Omit<Episode, "id">> = [];
    const chunker = new EpisodeChunker(
      { workspaceId: WS, sessionId: "s1", createdBy: "u", spillDir: tmp },
      (ep) => emitted.push(ep),
    );
    const t = new Date().toISOString();
    chunker.onMessage(toolMsg("m1", { phase: "executing" }, t));
    chunker.onMessage(
      toolMsg(
        "m1",
        { phase: "completed", success: true, output: `line_1\n… 1 lines omitted …\n\n[codeoid: compressed 60% via g; full output in memory (raw=${id})]` },
        t,
      ),
    );
    expect(emitted[0]!.content).toContain("line_3 the whole thing");
    expect(emitted[0]!.content).toContain("uncompressed");
    expect(readdirSync(tmp)).toHaveLength(0);
  });

  it("prunes spill files nothing claimed", () => {
    const stale = writeSpill("old", tmp)!;
    const fresh = writeSpill("new", tmp)!;
    const old = (Date.now() - 2 * 24 * 3600 * 1000) / 1000;
    utimesSync(join(tmp, `${stale}.out`), old, old);
    writeFileSync(join(tmp, "unrelated.txt"), "keep");
    expect(pruneSpill(tmp, 24 * 3600 * 1000)).toBe(1);
    expect(existsSync(join(tmp, `${fresh}.out`))).toBe(true);
    expect(existsSync(join(tmp, "unrelated.txt"))).toBe(true);
  });
});

function toolMsg(messageId: string, state: Record<string, unknown>, timestamp: string): SessionMessage {
  const executing = state.phase === "executing";
  return {
    type: "session.message",
    sessionId: "s1",
    messageId,
    role: "tool_call",
    content: "Bash(...)",
    identity: { sub: "agent:test", type: "agent" },
    tool: { toolId: "tid", name: "Bash", state: executing ? { ...state, input: { command: "make" } } : state },
    timestamp,
  } as unknown as SessionMessage;
}
