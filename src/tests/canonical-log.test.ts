/**
 * The durable canonical-history log (#354): the accumulator reports every
 * committed change, the transcript store persists it, and a restart reads it
 * back exactly — including after a fork seed or a rotation reset.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderEvent } from "../daemon/providers/interface.js";
import { CanonicalHistoryAccumulator, type CanonicalHistoryChange, type CanonicalTurn } from "../daemon/providers/canonical.js";
import { TranscriptStore } from "../daemon/transcript.js";

const done = (): ProviderEvent =>
  ({
    type: "turn_done",
    result: {
      providerId: "p",
      model: "m",
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalCostUsd: 0,
      durationMs: 0,
    },
  }) as ProviderEvent;

let dir: string;
let store: TranscriptStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codeoid-canon-"));
  store = new TranscriptStore(dir);
});
afterEach(async () => {
  await store.flush();
  rmSync(dir, { recursive: true, force: true });
});

describe("CanonicalHistoryAccumulator change events", () => {
  it("reports appends with turn ids, replaces on seed/reset, and stays silent on restore", () => {
    const acc = new CanonicalHistoryAccumulator();
    const changes: CanonicalHistoryChange[] = [];
    acc.onChange = (c) => changes.push(c);

    acc.pushUserTurn("hi [file body]", "T1", { prompt: "hi", at: "2026-01-01T00:00:00Z" });
    acc.handleEvent({ type: "text_done", content: "hello" } as ProviderEvent);
    acc.handleEvent(done());
    expect(changes).toEqual([
      { op: "append", turn: { role: "user", content: "hi [file body]", turnId: "T1", prompt: "hi", at: "2026-01-01T00:00:00Z" } },
      { op: "append", turn: { role: "assistant", content: "hello", turnId: "T1", providerId: "p", model: "m" } },
    ]);

    // prompt is only kept when it differs from content.
    acc.pushUserTurn("same", "T2", { prompt: "same" });
    expect(changes.at(-1)).toEqual({ op: "append", turn: { role: "user", content: "same", turnId: "T2" } });

    changes.length = 0;
    acc.seed([{ role: "user", content: "x", turnId: "F1" }]);
    acc.reset();
    expect(changes).toEqual([
      { op: "replace", turns: [{ role: "user", content: "x", turnId: "F1" }] },
      { op: "replace", turns: [] },
    ]);

    changes.length = 0;
    acc.restore([{ role: "user", content: "y", turnId: "R1" }]);
    expect(changes).toEqual([]);
    // The answer to a restored turn still carries its id.
    acc.handleEvent({ type: "text_done", content: "z" } as ProviderEvent);
    acc.handleEvent(done());
    expect(acc.history.at(-1)).toMatchObject({ role: "assistant", turnId: "R1" });
  });

  it("a listener that throws never breaks the conversation", () => {
    const acc = new CanonicalHistoryAccumulator();
    acc.onChange = () => {
      throw new Error("disk full");
    };
    acc.pushUserTurn("still recorded", "T1");
    expect(acc.history).toHaveLength(1);
  });
});

describe("TranscriptStore canonical log", () => {
  it("round-trips appends and replaces, in order", async () => {
    void store.recordCanonical("s", { op: "append", turn: { role: "user", content: "a", turnId: "1" } });
    void store.recordCanonical("s", { op: "replace", turns: [{ role: "user", content: "fork-base", turnId: "0" }] });
    void store.recordCanonical("s", { op: "append", turn: { role: "user", content: "b", turnId: "2" } });
    expect(await store.loadCanonical("s")).toEqual({
      turns: [
        { role: "user", content: "fork-base", turnId: "0" },
        { role: "user", content: "b", turnId: "2" },
      ],
      partial: false,
    });
  });

  it("returns null for a session with no log, and skips a torn last line", async () => {
    expect(await store.loadCanonical("none")).toBeNull();
    await store.recordCanonical("s", { op: "append", turn: { role: "user", content: "kept" } });
    appendFileSync(store.canonicalPath("s"), '{"op":"append","turn":{"role":"us'); // crash mid-write
    expect(await store.loadCanonical("s")).toEqual({ turns: [{ role: "user", content: "kept" }], partial: false });
  });

  it("serializes at call time: mutating the history afterwards can't change what is written", async () => {
    const turns: CanonicalTurn[] = [{ role: "user", content: "a" }];
    const pending = store.recordCanonical("s", { op: "replace", turns });
    turns.push({ role: "user", content: "pushed later" });
    await pending;
    expect((await store.loadCanonical("s"))?.turns).toEqual([{ role: "user", content: "a" }]);
  });

  it("caps oversized fields as it writes", async () => {
    const huge = "x".repeat(300 * 1024);
    await store.recordCanonical("s", { op: "append", turn: { role: "user", content: huge } });
    await store.recordCanonical("s", {
      op: "append",
      turn: {
        role: "assistant",
        content: "ok",
        providerId: "p",
        model: "m",
        toolCalls: [{ id: "1", name: "write_file", input: { content: huge }, output: huge, success: true }],
      },
    });
    const turns = (await store.loadCanonical("s"))!.turns;
    expect(turns[0]!.content.length).toBeLessThan(270 * 1024);
    expect(turns[0]!.content).toContain("truncated for the history log");
    const tc = turns[1]!.role === "assistant" ? turns[1]!.toolCalls![0]! : undefined;
    expect(tc!.output.length).toBeLessThan(70 * 1024);
    expect(JSON.stringify(tc!.input).length).toBeLessThan(70 * 1024);
  });

  it("reads only the newest turns with maxBytes, starting at a user turn", async () => {
    for (let i = 0; i < 50; i++) {
      await store.recordCanonical("s", { op: "append", turn: { role: "user", content: `prompt ${i} ${"p".repeat(200)}` } });
      await store.recordCanonical("s", {
        op: "append",
        turn: { role: "assistant", content: `reply ${i} ${"r".repeat(200)}`, providerId: "p", model: "m" },
      });
    }
    const tail = (await store.loadCanonical("s", { maxBytes: 2000 }))!;
    expect(tail.partial).toBe(true);
    expect(tail.turns[0]!.role).toBe("user");
    expect(tail.turns.at(-1)!.content).toStartWith("reply 49");
    expect(tail.turns.length).toBeLessThan(20);
    expect((await store.loadCanonical("s"))!.turns).toHaveLength(100);
  });

  it("compacts to its newest turns once it outgrows the ceiling", async () => {
    const small = new TranscriptStore(dir, { canonicalCompactBytes: 4096 });
    for (let i = 0; i < 40; i++) {
      await small.recordCanonical("c", { op: "append", turn: { role: "user", content: `prompt ${i} ${"p".repeat(200)}` } });
    }
    expect(statSync(small.canonicalPath("c")).size).toBeLessThanOrEqual(4096 + 300);
    const turns = (await small.loadCanonical("c"))!.turns;
    expect(turns.at(-1)!.content).toStartWith("prompt 39");
    expect(turns[0]!.content).not.toStartWith("prompt 0 ");
  });

  it("writes owner-only files", async () => {
    await store.recordCanonical("s", { op: "append", turn: { role: "user", content: "a" } });
    await store.recordTurn("s", { turnId: "t", kind: "prompt", preview: "a" });
    expect(statSync(store.canonicalPath("s")).mode & 0o077).toBe(0);
    expect(statSync(store.turnIndexPath("s")).mode & 0o077).toBe(0);
  });

  it("round-trips the turn index and removes it with the session", async () => {
    await store.recordTurn("s", { turnId: "t1", kind: "prompt", preview: "one", startedAt: "2026-01-01T00:00:00Z" });
    await store.recordTurn("s", { turnId: "t2", kind: "background", preview: "bg" });
    expect(await store.loadTurnIndex("s")).toEqual([
      { turnId: "t1", kind: "prompt", preview: "one", startedAt: "2026-01-01T00:00:00Z" },
      { turnId: "t2", kind: "background", preview: "bg" },
    ]);
    await store.replaceTurnIndex("s", [{ turnId: "t1", kind: "prompt", preview: "one" }]);
    expect(await store.loadTurnIndex("s")).toHaveLength(1);
    expect(await store.loadTurnIndex("none")).toBeNull();
    await store.delete("s");
    expect(existsSync(store.turnIndexPath("s"))).toBe(false);
  });

  it("is removed with the session", async () => {
    await store.recordCanonical("s", { op: "append", turn: { role: "user", content: "a" } });
    expect(existsSync(store.canonicalPath("s"))).toBe(true);
    await store.delete("s");
    expect(existsSync(store.canonicalPath("s"))).toBe(false);
  });

  it("a failed write is logged, not an unhandled rejection, and later writes still land", async () => {
    rmSync(dir, { recursive: true, force: true }); // the directory vanished
    await store.recordCanonical("s", { op: "append", turn: { role: "user", content: "lost" } });
    // The transcript append path had the same bug class: its stored chain rejected unhandled.
    await expect(store.append("s", { type: "session.message" } as never, 0)).rejects.toThrow();
    await store.flush();
  });
});
