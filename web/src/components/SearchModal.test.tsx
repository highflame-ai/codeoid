// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup, fireEvent } from "@solidjs/testing-library";

const requestMock = vi.hoisted(() =>
  vi.fn<(msg: unknown) => Promise<unknown>>(() => Promise.resolve({ sessions: [] })),
);
vi.mock("../state/connection", () => ({
  getClient: () => ({ request: requestMock }),
  newRequestId: () => "r",
}));

import SearchModal from "./SearchModal";
import {
  _resetSessionsForTest,
  focusSession,
  ingestSessionList,
} from "../state/sessions";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  _resetSessionsForTest();
  requestMock.mockReset();
  requestMock.mockImplementation(() => Promise.resolve({ sessions: [] }));
  vi.useRealTimers();
});

function openModal() {
  const r = render(() => <SearchModal />);
  fireEvent.keyDown(window, { key: "k", ctrlKey: true });
  const input = r.container.querySelector("input") as HTMLInputElement;
  expect(input).toBeTruthy();
  return { ...r, input };
}

describe("SearchModal stale in-flight results", () => {
  it("drops results that resolve after the query shrank below 2 chars", async () => {
    // A slow search we can resolve on demand.
    let resolveSearch!: (v: unknown) => void;
    requestMock.mockImplementationOnce(
      () => new Promise((res) => (resolveSearch = res)),
    );

    const { input, queryByText } = openModal();

    // Type a real query and let the debounce fire → request in flight.
    fireEvent.input(input, { target: { value: "shield" } });
    await vi.advanceTimersByTimeAsync(250);
    expect(requestMock).toHaveBeenCalledTimes(1);

    // Shrink below the 2-char threshold BEFORE the response lands.
    fireEvent.input(input, { target: { value: "s" } });

    // Now the stale response arrives.
    resolveSearch({
      sessions: [
        {
          sessionId: "sess-x",
          sessionName: "stale-hit-session",
          matchCount: 3,
          lastMatchAt: 1,
          snippets: [],
        },
      ],
    });
    await vi.advanceTimersByTimeAsync(10);

    // The old bug: the short-query branch cleared hits but never bumped
    // runId, so the in-flight response repopulated the list under the
    // "type at least 2 characters" hint.
    expect(queryByText(/stale-hit-session/)).toBeNull();
  });

  it("clears a lingering error when the query shrinks", async () => {
    requestMock.mockImplementationOnce(() => Promise.reject(new Error("search exploded")));

    const { input, queryByText, findByText } = openModal();

    fireEvent.input(input, { target: { value: "shield" } });
    await vi.advanceTimersByTimeAsync(250);
    expect(await findByText(/search exploded/)).toBeTruthy();

    fireEvent.input(input, { target: { value: "s" } });
    await vi.advanceTimersByTimeAsync(10);
    expect(queryByText(/search exploded/)).toBeNull();
  });
});

describe("SearchModal scope toggle", () => {
  /** Seed one focused session so there is a workspace worth scoping to. */
  function seedFocused(workdir = "/repos/alpha") {
    ingestSessionList([
      {
        id: "sess-a",
        name: "alpha",
        workdir,
        status: "idle",
        createdBy: "user:t",
        createdAt: new Date().toISOString(),
      } as never,
    ]);
    focusSession("sess-a");
  }

  function lastSearch(): Record<string, unknown> {
    return requestMock.mock.calls.at(-1)![0] as Record<string, unknown>;
  }

  it("scopes to the focused session's workdir by default", async () => {
    seedFocused();
    const { input } = openModal();

    fireEvent.input(input, { target: { value: "auth token" } });
    await vi.advanceTimersByTimeAsync(250);

    expect(lastSearch().scope).toBe("workspace");
    expect(lastSearch().workdir).toBe("/repos/alpha");
  });

  it("searches every workspace when nothing is focused", async () => {
    const { input } = openModal();

    fireEvent.input(input, { target: { value: "auth token" } });
    await vi.advanceTimersByTimeAsync(250);

    expect(lastSearch().scope).toBe("all");
    // No anchor may ride along — the daemon decides global on its absence.
    expect(lastSearch().workdir).toBeUndefined();
  });

  it("re-runs the query globally when the scope toggle is used", async () => {
    seedFocused();
    const { input, getByText } = openModal();

    fireEvent.input(input, { target: { value: "auth token" } });
    await vi.advanceTimersByTimeAsync(250);
    expect(lastSearch().scope).toBe("workspace");
    const before = requestMock.mock.calls.length;

    fireEvent.click(getByText("All workspaces"));
    await vi.advanceTimersByTimeAsync(250);

    // Same query, other regime — no retyping required.
    expect(requestMock.mock.calls.length).toBeGreaterThan(before);
    expect(lastSearch().scope).toBe("all");
    expect(lastSearch().query).toBe("auth token");
    expect(lastSearch().workdir).toBeUndefined();
  });

  it("hides the toggle when there is no workspace to scope to", () => {
    const { queryByText } = openModal();
    expect(queryByText("All workspaces")).toBeNull();
    expect(queryByText("This workspace")).toBeNull();
  });

  it("offers a widen button when a scoped search finds nothing", async () => {
    seedFocused();
    const { input, findByText } = openModal();

    fireEvent.input(input, { target: { value: "auth token" } });
    await vi.advanceTimersByTimeAsync(250);

    // Zero hits under workspace scope is exactly when widening helps.
    expect(await findByText(/No matches in this workspace/)).toBeTruthy();
    fireEvent.click(await findByText("Search all workspaces"));
    await vi.advanceTimersByTimeAsync(250);

    expect(lastSearch().scope).toBe("all");
  });
});
