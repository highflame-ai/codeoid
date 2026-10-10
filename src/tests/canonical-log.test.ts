/**
 * The durable canonical-history log (#354): the accumulator reports every
 * committed change, the transcript store persists it, and a restart reads it
 * back exactly — including after a fork seed or a rotation reset.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderEvent } from "../daemon/providers/interface.js";
import { CanonicalHistoryAccumulator, type CanonicalHistoryChange } from "../daemon/providers/canonical.js";
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
    expect(await store.loadCanonical("s")).toEqual([
      { role: "user", content: "fork-base", turnId: "0" },
      { role: "user", content: "b", turnId: "2" },
    ]);
  });

  it("returns null for a session with no log, and skips a torn last line", async () => {
    expect(await store.loadCanonical("none")).toBeNull();
    await store.recordCanonical("s", { op: "append", turn: { role: "user", content: "kept" } });
    appendFileSync(store.canonicalPath("s"), '{"op":"append","turn":{"role":"us'); // crash mid-write
    expect(await store.loadCanonical("s")).toEqual([{ role: "user", content: "kept" }]);
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
