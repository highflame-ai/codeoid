// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent } from "@solidjs/testing-library";
import { createSignal } from "solid-js";

const openRewindMock = vi.hoisted(() => vi.fn());
vi.mock("../RewindModal", () => ({ openRewind: openRewindMock }));
const openForkMock = vi.hoisted(() => vi.fn());
vi.mock("../ForkFromHereModal", () => ({ openForkFromHere: openForkMock }));

import MessageRow from "./MessageRow";
import { REASONING_UNAVAILABLE } from "../../protocol/types";
import type { SessionMessage } from "../../protocol/types";

function thinkingMsg(content: string): SessionMessage {
  return {
    type: "session.message",
    sessionId: "s",
    messageId: "m1",
    role: "thinking",
    content,
    identity: { sub: "x", name: "a", type: "agent" },
    timestamp: "2026-05-04T08:00:00Z",
  } as unknown as SessionMessage;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ThinkingBlock", () => {
  it("shows a correct line count", () => {
    const three = render(() => <MessageRow msg={thinkingMsg("a\nb\nc")} />);
    expect(three.container.textContent).toContain("reasoning (3 lines)");
    cleanup();
    const one = render(() => <MessageRow msg={thinkingMsg("no newline here")} />);
    expect(one.container.textContent).toContain("reasoning (1 line)");
  });

  it("renders a flat marker — not an expander — when no reasoning was returned", () => {
    // Backends differ: qwen-code and OSS models stream plaintext reasoning,
    // while Claude returns text only under thinking.display "summarized".
    // With nothing behind it, an expander advertises content it can't show.
    const { container } = render(() => <MessageRow msg={thinkingMsg(REASONING_UNAVAILABLE)} />);
    expect(container.querySelector("details")).toBeNull();
    expect(container.textContent).toContain(REASONING_UNAVAILABLE);
    // No line count either — "(1 line)" over a placeholder is what made the
    // original report look like a counting bug rather than absent data.
    expect(container.textContent).not.toContain("line)");
  });

  it("renders an expander when the backend DID return reasoning", () => {
    const { container } = render(() =>
      <MessageRow msg={thinkingMsg("Considering the tradeoffs\nand the constraints")} />,
    );
    const details = container.querySelector("details");
    expect(details).not.toBeNull();
    expect(container.textContent).toContain("reasoning (2 lines)");
    expect(container.textContent).toContain("Considering the tradeoffs");
  });

  it("treats whitespace-only reasoning as absent", () => {
    const { container } = render(() => <MessageRow msg={thinkingMsg("   \n  ")} />);
    expect(container.querySelector("details")).toBeNull();
  });

  it("coalesces streaming deltas to one recount per animation frame", () => {
    // Manual rAF queue so the flush moment is deterministic (same pattern
    // as streaming-markdown.test.ts, which MarkdownBlock's throttle uses).
    const queue: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      queue.push(cb);
      return queue.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});

    const [msg, setMsg] = createSignal(thinkingMsg("a\nb"));
    const { container } = render(() => <MessageRow msg={msg()} streaming={true} />);
    expect(container.textContent).toContain("reasoning (2 lines)");

    // Two rapid deltas: held until the frame fires, and only ONE frame
    // scheduled — the whole-text re-split per delta is gone.
    setMsg(thinkingMsg("a\nb\nc"));
    setMsg(thinkingMsg("a\nb\nc\nd"));
    expect(container.textContent).toContain("reasoning (2 lines)");
    expect(queue.length).toBe(1);

    // The flush delivers the LATEST text and count.
    queue.shift()!(0);
    expect(container.textContent).toContain("reasoning (4 lines)");
    expect(container.textContent).toContain("a\nb\nc\nd");
  });

  it("updates synchronously when not streaming (throttle passthrough)", () => {
    const [msg, setMsg] = createSignal(thinkingMsg("x"));
    const { container } = render(() => <MessageRow msg={msg()} />);
    expect(container.textContent).toContain("reasoning (1 line)");
    setMsg(thinkingMsg("x\ny\nz"));
    expect(container.textContent).toContain("reasoning (3 lines)");
    expect(container.textContent).toContain("x\ny\nz");
  });
});

describe("background wake", () => {
  const wake = (content: string): SessionMessage =>
    ({
      type: "session.message",
      sessionId: "s",
      messageId: "w1",
      role: "user",
      content,
      identity: { sub: "system:background", name: "system:background", type: "system" },
      timestamp: "2026-09-27T08:00:00Z",
    }) as unknown as SessionMessage;

  const BODY = [
    "<background_tasks>",
    "(daemon-injected background-task notifications — NOT a message from the owner)",
    "- [completed] task ba3emjr2: Find Studio uses",
    "- [failed] task a14fac26: # Security review",
    "",
    "A long digest body that should not be shown inline.",
    "</background_tasks>",
    "",
    "Background work you started earlier has finished.",
  ].join("\n");

  it("renders as a compact background notice, not as the owner's message", () => {
    const { container } = render(() => <MessageRow msg={wake(BODY)} />);
    const header = container.querySelector("header")!.textContent ?? "";
    expect(header).toContain("background");
    expect(header).not.toContain("you");
    expect(container.textContent).toContain("2 background tasks finished");
    expect(container.textContent).toContain("Find Studio uses");
    expect(container.textContent).toContain("failed");
    // The full body is behind a disclosure, collapsed by default.
    const details = container.querySelector("details")!;
    expect(details.open).toBe(false);
    expect(details.textContent).toContain("A long digest body");
  });

  it("leaves the owner's own messages alone", () => {
    const own = { ...wake("hello"), identity: { sub: "user:me", name: "me", type: "user" } } as unknown as SessionMessage;
    const { container } = render(() => <MessageRow msg={own} />);
    expect(container.querySelector("header")!.textContent).toContain("you");
    expect(container.querySelector("details")).toBeNull();
  });
});

describe("go back to here (#355)", () => {
  const userMsg = (turnId?: string): SessionMessage =>
    ({
      type: "session.message",
      sessionId: "s",
      messageId: "u1",
      role: "user",
      content: "hello",
      identity: { sub: "u", type: "human" },
      timestamp: "2026-05-04T08:00:00Z",
      ...(turnId ? { turnId } : {}),
    }) as unknown as SessionMessage;

  it("a prompt with a turn id offers going back to before it", () => {
    const r = render(() => <MessageRow msg={userMsg("T1")} />);
    fireEvent.click(r.getByText(/go back to here/));
    expect(openRewindMock).toHaveBeenCalledWith("s", "T1");
  });

  it("is absent on prompts from before turn ids, and on non-prompts", () => {
    const r = render(() => <MessageRow msg={userMsg()} />);
    expect(r.queryByText(/go back to here/)).toBeNull();
    cleanup();
    const t = render(() => <MessageRow msg={thinkingMsg("x")} />);
    expect(t.queryByText(/go back to here/)).toBeNull();
  });
});

describe("fork from here (#356)", () => {
  const msg = (role: "user" | "assistant", turnId?: string): SessionMessage =>
    ({
      type: "session.message",
      sessionId: "s",
      messageId: `${role}1`,
      role,
      content: "x",
      identity: { sub: "u", type: role === "user" ? "human" : "agent" },
      timestamp: "2026-05-04T08:00:00Z",
      ...(turnId ? { turnId } : {}),
    }) as unknown as SessionMessage;

  it("prompts and replies with a turn id offer forking from there; only prompts offer going back", () => {
    const r = render(() => <MessageRow msg={msg("assistant", "T7")} />);
    fireEvent.click(r.getByText(/fork from here/));
    expect(openForkMock).toHaveBeenCalledWith("s", "T7");
    expect(r.queryByText(/go back to here/)).toBeNull();
    cleanup();
    const u = render(() => <MessageRow msg={msg("user", "T1")} />);
    expect(u.getByText(/fork from here/)).toBeTruthy();
    expect(u.getByText(/go back to here/)).toBeTruthy();
  });
});
