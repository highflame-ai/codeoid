// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup, fireEvent } from "@solidjs/testing-library";

const requestMock = vi.hoisted(() =>
  vi.fn<(msg: unknown, opts?: unknown) => Promise<unknown>>(),
);
vi.mock("../state/connection", () => ({
  getClient: () => ({ request: requestMock }),
  newRequestId: () => `r-${Math.random()}`,
}));

import BlackboardDrawer from "./BlackboardDrawer";
import {
  closeBlackboard,
  openBlackboard,
  _resetBlackboardForTest,
} from "../state/blackboard";
import type { BlackboardIndexEntry } from "../protocol/types";

function entry(
  kind: string,
  slot: string | null,
  over: Partial<BlackboardIndexEntry> = {},
): BlackboardIndexEntry {
  return {
    kind,
    slot,
    version: 1,
    authorSub: `agent:goal-1:${kind}`,
    authorRole: slot?.split("#")[0] ?? kind,
    updatedAt: Date.now() - 60_000,
    bytes: 2048,
    ...over,
  };
}

const BOARD = [
  entry("findings", "review#2"),
  entry("diff", null, { authorRole: "reasoning", bytes: 300_000, version: 3 }),
  entry("spec", null, { authorRole: "orchestrator", bytes: 900 }),
  entry("findings", "review"),
  entry("research", null, { authorRole: "search" }),
];

const indexResult = (entries: BlackboardIndexEntry[]) => ({
  type: "blackboard.index.result" as const,
  requestId: "x",
  sessionId: "goal-1",
  goal: "make auth boring again",
  entries,
});

const readResult = (content: string | null, kind: string, slot: string | null) => ({
  type: "blackboard.read.result" as const,
  requestId: "x",
  sessionId: "goal-1",
  artifact:
    content === null
      ? null
      : {
          kind,
          slot,
          version: 2,
          content,
          authorSub: "a",
          authorRole: "review",
          createdAt: Date.now() - 30_000,
        },
});

/** Open the drawer with a loaded board and wait for the first paint. */
async function openWith(entries: BlackboardIndexEntry[]) {
  requestMock.mockResolvedValue(indexResult(entries));
  const view = render(() => <BlackboardDrawer />);
  openBlackboard("goal-1");
  await vi.waitFor(() => expect(view.queryByText(/make auth boring again/)).toBeTruthy());
  requestMock.mockReset();
  return view;
}

beforeEach(() => _resetBlackboardForTest());
afterEach(() => {
  cleanup();
  closeBlackboard();
  requestMock.mockReset();
  _resetBlackboardForTest();
  vi.useRealTimers();
});

describe("BlackboardDrawer", () => {
  it("renders nothing until opened", () => {
    const { container } = render(() => <BlackboardDrawer />);
    expect(container.textContent).toBe("");
  });

  it("lists artifacts in SDLC flow order, not alphabetically", async () => {
    // Alphabetical would put `diff` first and bury `spec` — the board should
    // read as the pipeline it is.
    const { container } = await openWith(BOARD);
    const kinds = [...container.querySelectorAll("nav button")].map(
      (b) => b.querySelector("span")?.textContent,
    );
    expect(kinds).toEqual(["spec", "research", "diff", "findings", "findings"]);
  });

  it("shows each writer's slot, so a panel never reads as one voice", async () => {
    const { getAllByTitle } = await openWith(BOARD);
    const slots = getAllByTitle("Writer slot").map((el) => el.textContent);
    // Two `findings` rows, distinguishable. One row would mean the panel
    // silently collapsed to a single opinion.
    expect(slots).toEqual(["review", "review#2"]);
  });

  it("shows the goal and a human-readable size, and no bodies", async () => {
    const { getByText, container } = await openWith(BOARD);
    expect(getByText(/make auth boring again/)).toBeTruthy();
    expect(getByText("293 KB")).toBeTruthy(); // the 300_000-byte diff
    expect(getByText("900 B")).toBeTruthy();
    expect(container.querySelector("pre")).toBeNull();
  });

  it("fetches a body only when an artifact is picked", async () => {
    const { getByText, container } = await openWith(BOARD);
    expect(requestMock).not.toHaveBeenCalled();

    requestMock.mockResolvedValueOnce(readResult("REVIEWER TWO SAYS NO", "findings", "review#2"));
    fireEvent.click(getByText("review#2"));
    await vi.waitFor(() =>
      expect(container.querySelector("pre")?.textContent).toBe("REVIEWER TWO SAYS NO"),
    );
    expect(requestMock.mock.calls[0]![0]).toMatchObject({
      type: "blackboard.read",
      kind: "findings",
      slot: "review#2",
    });
  });

  it("renders an unwritten artifact as pending rather than as a failure", async () => {
    const { getByText, container } = await openWith(BOARD);
    requestMock.mockResolvedValueOnce(readResult(null, "research", null));
    fireEvent.click(getByText("research"));
    await vi.waitFor(() => expect(getByText(/hasn't published a version/)).toBeTruthy());
    expect(container.querySelector("pre")).toBeNull();
  });

  it("surfaces a read failure inline", async () => {
    const { getByText } = await openWith(BOARD);
    requestMock.mockRejectedValueOnce(new Error("Missing scope: session:watch"));
    fireEvent.click(getByText("spec"));
    await vi.waitFor(() => expect(getByText(/Missing scope: session:watch/)).toBeTruthy());
  });

  it("explains an empty board instead of showing a blank pane", async () => {
    const { getByText } = await openWith([]);
    expect(getByText(/Nothing written yet/)).toBeTruthy();
  });

  it("closes on Escape", async () => {
    const { container } = await openWith(BOARD);
    fireEvent.keyDown(window, { key: "Escape" });
    await vi.waitFor(() => expect(container.textContent).toBe(""));
  });

  it("refreshes on demand", async () => {
    const { getByLabelText, getByText } = await openWith(BOARD);
    requestMock.mockResolvedValueOnce(
      indexResult([...BOARD, entry("adr", null, { authorRole: "architecture" })]),
    );
    fireEvent.click(getByLabelText("Refresh blackboard"));
    await vi.waitFor(() => expect(getByText("adr")).toBeTruthy());
  });

  it("stops polling once closed", async () => {
    vi.useFakeTimers();
    requestMock.mockResolvedValue(indexResult(BOARD));
    render(() => <BlackboardDrawer />);
    openBlackboard("goal-1");
    await vi.waitFor(() => expect(requestMock).toHaveBeenCalledTimes(1));

    await vi.advanceTimersByTimeAsync(9_000);
    const whileOpen = requestMock.mock.calls.length;
    expect(whileOpen).toBeGreaterThan(1); // it does poll

    closeBlackboard();
    await vi.advanceTimersByTimeAsync(20_000);
    // A timer left running against a drawer nobody is looking at would keep
    // hitting the daemon for the life of the tab.
    expect(requestMock.mock.calls.length).toBe(whileOpen);
  });
});
