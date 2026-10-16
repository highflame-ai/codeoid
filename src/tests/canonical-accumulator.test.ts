import { describe, expect, test } from "bun:test";
import { CanonicalHistoryAccumulator } from "../daemon/providers/canonical.js";
import type { ProviderEvent } from "../daemon/providers/interface.js";

/** A turn_done event carrying no produced content (the shape the Claude provider
 *  emits when it rebuilds its query loop — no text, no tools, no thinking). */
function turnDone(): ProviderEvent {
  return {
    type: "turn_done",
    result: {
      providerId: "mock",
      model: "mock",
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalCostUsd: 0,
      durationMs: 0,
    },
  } as ProviderEvent;
}
const textDone = (content: string): ProviderEvent => ({ type: "text_done", content }) as ProviderEvent;

describe("CanonicalHistoryAccumulator — content-free turn_done", () => {
  test("a content-free turn_done does NOT commit a phantom empty assistant turn", () => {
    const acc = new CanonicalHistoryAccumulator();
    acc.pushUserTurn("/spec do the thing");
    expect(acc.history).toHaveLength(1);
    expect(acc.history[0]!.role).toBe("user");

    // Rebuild-style turn_done with nothing produced — must be a no-op.
    acc.handleEvent(turnDone());
    expect(acc.history).toHaveLength(1); // still just the user turn
    expect(acc.history[acc.history.length - 1]!.role).toBe("user");
  });

  test("a turn that produced text DOES commit an assistant turn", () => {
    const acc = new CanonicalHistoryAccumulator();
    acc.pushUserTurn("hi");
    acc.handleEvent(textDone("here is the spec\n⟦PHASE-COMPLETE⟧"));
    acc.handleEvent(turnDone());
    expect(acc.history).toHaveLength(2);
    const last = acc.history[1]!;
    expect(last.role).toBe("assistant");
    if (last.role === "assistant") expect(last.content).toContain("here is the spec");
  });

  test("multiple content-free rebuild rests never accumulate phantom turns", () => {
    const acc = new CanonicalHistoryAccumulator();
    acc.pushUserTurn("go");
    acc.handleEvent(turnDone());
    acc.handleEvent(turnDone());
    acc.handleEvent(turnDone());
    expect(acc.history).toHaveLength(1); // only the user turn survives
  });
});

describe("CanonicalHistoryAccumulator — the final message", () => {
  test("lastTextBlock is the turn's last text, without the narration before it", () => {
    const acc = new CanonicalHistoryAccumulator();
    acc.pushUserTurn("audit the docs");
    acc.handleEvent(textDone("Checking the config first."));
    acc.handleEvent(textDone("Fixed six things:\n- a\n- b"));
    acc.handleEvent(turnDone());
    expect(acc.lastTextBlock).toBe("Fixed six things:\n- a\n- b");
    // The history keeps every block.
    const last = acc.history.at(-1)!;
    if (last.role === "assistant") expect(last.content).toContain("Checking the config first.");
    // A new prompt forgets it, so a turn that writes nothing can't inherit the last one's.
    acc.pushUserTurn("again");
    expect(acc.lastTextBlock).toBeNull();
  });
});
