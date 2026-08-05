// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent } from "@solidjs/testing-library";

vi.mock("../state/connection", () => ({
  send: vi.fn(),
  request: vi.fn(() => Promise.resolve(undefined)),
  newRequestId: () => "r",
  authIdentity: () => undefined,
}));
// Not under test — stub the heavy child panels so this focuses on the filter.
vi.mock("./files/FileTree", () => ({ default: () => null }));
vi.mock("./AnalyticsPanel", () => ({ default: () => null }));
vi.mock("./NewSessionModal", () => ({ openNewSessionModal: vi.fn() }));
// Panel state is daemon-fed; drive it directly so the render is under test
// rather than the polling transport.
const liveProgressMock = vi.hoisted(() => vi.fn<() => unknown>(() => null));
const livePanelMemberMock = vi.hoisted(() => vi.fn<(id: string) => unknown>(() => null));
vi.mock("../state/panels", () => ({
  fetchPanels: vi.fn(() => Promise.resolve()),
  resetPanels: vi.fn(),
  liveProgress: liveProgressMock,
  livePanelMember: livePanelMemberMock,
}));

import SessionListPane from "./SessionListPane";
import { ingestSessionList, _resetSessionsForTest } from "../state/sessions";
import type { SessionInfo } from "../protocol/types";

function sess(id: string, name: string, workdir = "/tmp"): SessionInfo {
  return {
    id,
    name,
    workdir,
    status: "idle",
    mode: "guarded",
    createdBy: "u",
    createdAt: "2026-05-04T08:00:00Z",
    attachedClients: 0,
  } as SessionInfo;
}

/** An orchestrator: a session carrying a `collaboration` config. */
function orchestrator(id: string, name: string, goal: string): SessionInfo {
  return {
    ...sess(id, name, "/repo/fleet"),
    collaboration: { goal, roles: [{ name: "orchestrator", providerId: "claude" }] },
  } as SessionInfo;
}

/** A role-child: a session carrying `collaborationRole` pointing at its parent. */
function roleChild(
  parentId: string,
  parentName: string,
  roleName: string,
  ordinal: number,
  write: boolean,
  providerId = "claude",
): SessionInfo {
  const suffix = ordinal > 1 ? `-${ordinal}` : "";
  return {
    ...sess(`${parentId}:${roleName}${suffix}`, `${parentName}:${roleName}${suffix}`, "/repo/fleet"),
    providerId,
    collaborationRole: { parentSessionId: parentId, roleName, ordinal, write },
  } as SessionInfo;
}

afterEach(() => {
  cleanup();
  _resetSessionsForTest();
});

describe("SessionListPane — session filter", () => {
  it("filters the visible sessions by name or workdir as you type", () => {
    ingestSessionList([
      sess("a", "alpha", "/repo/a"),
      sess("b", "beta", "/repo/b"),
      sess("c", "gamma redteam", "/work/rt"),
    ]);
    const { getByLabelText, getByText, queryByText } = render(() => <SessionListPane />);

    // All sessions visible initially.
    expect(getByText("alpha")).toBeTruthy();
    expect(getByText("beta")).toBeTruthy();
    expect(getByText("gamma redteam")).toBeTruthy();

    // Filter by name substring.
    const input = getByLabelText("Filter sessions by name") as HTMLInputElement;
    fireEvent.input(input, { target: { value: "redteam" } });
    expect(queryByText("alpha")).toBeNull();
    expect(queryByText("beta")).toBeNull();
    expect(getByText("gamma redteam")).toBeTruthy();

    // Filter by workdir substring.
    fireEvent.input(input, { target: { value: "/repo" } });
    expect(getByText("alpha")).toBeTruthy();
    expect(getByText("beta")).toBeTruthy();
    expect(queryByText("gamma redteam")).toBeNull();
  });

  it("shows a no-match hint pointing at Ctrl+K content search", () => {
    ingestSessionList([sess("a", "alpha"), sess("b", "beta")]);
    const { getByLabelText, getByText, queryByText } = render(() => <SessionListPane />);
    fireEvent.input(getByLabelText("Filter sessions by name"), { target: { value: "zzz-nope" } });
    expect(queryByText("alpha")).toBeNull();
    expect(getByText(/No session name matches/)).toBeTruthy();
    expect(getByText(/search message content/)).toBeTruthy();
  });

  it("the clear button restores the full list", () => {
    ingestSessionList([sess("a", "alpha"), sess("b", "beta")]);
    const { getByLabelText, getByText, queryByText } = render(() => <SessionListPane />);
    const input = getByLabelText("Filter sessions by name") as HTMLInputElement;
    fireEvent.input(input, { target: { value: "alpha" } });
    expect(queryByText("beta")).toBeNull();
    fireEvent.click(getByLabelText("Clear filter"));
    expect(getByText("beta")).toBeTruthy();
  });
});

describe("SessionListPane — fleet rendering", () => {
  const FLEET = [
    orchestrator("p", "refactor-auth", "make auth boring again"),
    roleChild("p", "refactor-auth", "review", 2, false, "gemini"),
    roleChild("p", "refactor-auth", "search", 1, false, "claude"),
    roleChild("p", "refactor-auth", "review", 1, false, "gemini"),
    roleChild("p", "refactor-auth", "reasoning", 1, true, "openai"),
    sess("solo", "unrelated", "/tmp/other"),
  ];

  it("renders children by role label, not by their prefixed session name", () => {
    ingestSessionList(FLEET);
    const { getByText, queryByText } = render(() => <SessionListPane />);

    expect(getByText("refactor-auth")).toBeTruthy();
    // `review` ×2 fan-out gets ordinals; singletons don't.
    expect(getByText("review")).toBeTruthy();
    expect(getByText("review#2")).toBeTruthy();
    expect(getByText("search")).toBeTruthy();
    expect(getByText("reasoning")).toBeTruthy();
    // The daemon-generated name is in the tooltip, not the visible label.
    expect(queryByText("refactor-auth:review-2")).toBeNull();
  });

  it("shows the goal on the orchestrator row", () => {
    ingestSessionList(FLEET);
    const { getByText } = render(() => <SessionListPane />);
    expect(getByText(/make auth boring again/)).toBeTruthy();
  });

  it("badges read-only roles and marks the writer differently", () => {
    ingestSessionList(FLEET);
    const { getAllByTitle } = render(() => <SessionListPane />);
    // search, review, review#2 are read-only; reasoning writes.
    expect(getAllByTitle(/Read-only role/)).toHaveLength(3);
    expect(getAllByTitle(/may write to the workspace/)).toHaveLength(1);
  });

  it("shows every child's backend, including claude", () => {
    // A mixed fleet is the point; "claude" must be stated, not implied by the
    // absence of a chip the way it is for standalone sessions.
    ingestSessionList(FLEET);
    const { getAllByTitle, queryAllByTitle } = render(() => <SessionListPane />);
    expect(getAllByTitle(/Backend: gemini/)).toHaveLength(2);
    expect(getAllByTitle(/Backend: openai/)).toHaveLength(1);
    expect(getAllByTitle(/Backend: claude/)).toHaveLength(1);
    // ...but the standalone session still suppresses the default-backend chip.
    expect(queryAllByTitle(/Backend: claude/)).toHaveLength(1);
  });

  it("collapses and re-expands the fleet from the group toggle", () => {
    ingestSessionList(FLEET);
    const { getByLabelText, queryByText, getByText } = render(() => <SessionListPane />);

    fireEvent.click(getByLabelText(/Collapse fleet \(4 roles\)/));
    expect(queryByText("search")).toBeNull();
    expect(queryByText("review#2")).toBeNull();
    // The orchestrator itself stays put.
    expect(getByText("refactor-auth")).toBeTruthy();

    fireEvent.click(getByLabelText(/Expand fleet \(4 roles\)/));
    expect(getByText("search")).toBeTruthy();
  });

  it("keeps the orchestrator visible as context when only a child matches", () => {
    ingestSessionList(FLEET);
    const { getByLabelText, getByText, queryByText } = render(() => <SessionListPane />);
    fireEvent.input(getByLabelText("Filter sessions by name"), {
      target: { value: "reasoning" },
    });
    // A bare role row with no indication of its goal would be unreadable.
    expect(getByText("refactor-auth")).toBeTruthy();
    expect(getByText("reasoning")).toBeTruthy();
    expect(queryByText("search")).toBeNull();
    expect(queryByText("unrelated")).toBeNull();
  });

  it("keeps an orphan child visible, at top level, with its role badges intact", () => {
    // Parent destroyed while the child drains — the child must not vanish. It
    // shows its full name (no parent row above it to supply the context) but
    // still reads as a role-child.
    ingestSessionList([roleChild("ghost", "gone", "search", 1, false)]);
    const { getByText, getByTitle } = render(() => <SessionListPane />);
    expect(getByText("gone:search")).toBeTruthy();
    expect(getByTitle(/Read-only role/)).toBeTruthy();
  });
});

describe("SessionListPane — live panel state", () => {
  const FLEET = [
    orchestrator("p", "refactor-auth", "make auth boring again"),
    roleChild("p", "refactor-auth", "review", 1, false, "gemini"),
    roleChild("p", "refactor-auth", "review", 2, false, "gemini"),
    roleChild("p", "refactor-auth", "search", 1, false, "claude"),
  ];

  afterEach(() => {
    liveProgressMock.mockReturnValue(null);
    livePanelMemberMock.mockReturnValue(null);
  });

  it("shows nothing when no fan-out is in flight", () => {
    ingestSessionList(FLEET);
    const { queryByText } = render(() => <SessionListPane />);
    expect(queryByText(/panel/)).toBeNull();
  });

  it("shows settled-of-total on the orchestrator while a panel runs", () => {
    liveProgressMock.mockReturnValue({ settled: 2, total: 3, panels: 1 });
    ingestSessionList(FLEET);
    const { getByText, getByRole } = render(() => <SessionListPane />);
    expect(getByText("2/3")).toBeTruthy();
    const bar = getByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("2");
    expect(bar.getAttribute("aria-valuemax")).toBe("3");
  });

  it("counts SETTLED members, so a failed member does not stall the bar", () => {
    // The barrier joins on all-terminal. Counting successes would leave a
    // finished panel showing 2/3 forever — the exact confusion this removes.
    liveProgressMock.mockReturnValue({ settled: 3, total: 3, panels: 1 });
    ingestSessionList(FLEET);
    const { getByText, getByTitle } = render(() => <SessionListPane />);
    expect(getByText("3/3")).toBeTruthy();
    expect(getByTitle(/including failures/)).toBeTruthy();
  });

  it("aggregates when TWO fan-outs are live at once", () => {
    // Concurrent panels are legal — an orchestrator can start a second while the
    // first resolves. Showing one panel's numbers understates the outstanding work.
    liveProgressMock.mockReturnValue({ settled: 1, total: 5, panels: 2 });
    ingestSessionList(FLEET);
    const { getByText, getByTitle } = render(() => <SessionListPane />);
    expect(getByText(/panels ×2/)).toBeTruthy();
    expect(getByText("1/5")).toBeTruthy();
    expect(getByTitle(/2 panels in flight/)).toBeTruthy();
  });

  it("badges each participating child with its position and state", () => {
    liveProgressMock.mockReturnValue({ settled: 1, total: 2, panels: 1 });
    livePanelMemberMock.mockImplementation((id: string) =>
      id === "p:review" ? { ordinal: 1, status: "running" }
      : id === "p:review-2" ? { ordinal: 2, status: "failed" }
      : null,
    );
    ingestSessionList(FLEET);
    const { getByTitle, queryAllByTitle } = render(() => <SessionListPane />);
    expect(getByTitle("Panel member 1 — working")).toBeTruthy();
    // A failed member is SHOWN, not hidden — same rule as the joined digest.
    expect(getByTitle("Panel member 2 — failed")).toBeTruthy();
    expect(queryAllByTitle(/Panel member/)).toHaveLength(2);
  });
});

describe("SessionListPane — background tasks", () => {
  it("shows a pulsing bg chip with the task details in the tooltip", () => {
    ingestSessionList([
      {
        ...sess("s1", "paper-review", "/repo/paper"),
        backgroundTasks: [
          { id: "abcd1234", kind: "subagent", description: "survey venues", status: "running" },
          { id: "efgh5678", kind: "shell", description: "", status: "running" },
        ],
      } as SessionInfo,
    ]);
    const { getByText, getByTitle } = render(() => <SessionListPane />);
    // The count is the signal: an idle-looking session with live background
    // work is exactly the state that used to read as a hang.
    expect(getByText("2 bg")).toBeTruthy();
    const tip = getByTitle(/survey venues/);
    expect(tip.getAttribute("title")).toContain("[subagent] survey venues — running");
    // A task with no description falls back to its id prefix.
    expect(tip.getAttribute("title")).toContain("[shell] efgh5678 — running");
  });

  it("shows nothing when the field is absent — older daemons stay clean", () => {
    ingestSessionList([sess("s1", "plain", "/repo/x")]);
    const { queryByText } = render(() => <SessionListPane />);
    expect(queryByText(/bg/)).toBeNull();
  });
});
