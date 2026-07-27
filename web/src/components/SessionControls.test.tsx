// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent, waitFor } from "@solidjs/testing-library";

const requestMock = vi.hoisted(() =>
  vi.fn<(msg: unknown) => Promise<unknown>>(() => Promise.resolve(undefined)),
);
const authMock = vi.hoisted(() => vi.fn(() => undefined as unknown));
const refreshSessionsMock = vi.hoisted(() => vi.fn(() => Promise.resolve([])));
vi.mock("../state/connection", () => ({
  send: vi.fn(),
  request: requestMock,
  refreshSessions: refreshSessionsMock,
  newRequestId: () => "r",
  authIdentity: authMock,
}));
const fetchModelsMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("../state/models", () => ({ fetchModels: fetchModelsMock, modelCatalog: () => [] }));
vi.mock("./SessionExportModal", () => ({ openExportModal: vi.fn() }));
const openBlackboardMock = vi.hoisted(() => vi.fn());
vi.mock("../state/blackboard", () => ({ openBlackboard: openBlackboardMock }));

import SessionControls from "./SessionControls";
import {
  getSession,
  ingestSessionList,
  focusSession,
  focusedSession,
  mergeSession,
  _resetSessionsForTest,
} from "../state/sessions";
import type { SessionInfo } from "../protocol/types";

function sess(providerId?: string, status: SessionInfo["status"] = "idle"): SessionInfo {
  return {
    id: "s",
    name: "s",
    workdir: "/tmp",
    status,
    mode: "guarded",
    createdBy: "u",
    createdAt: "2026-05-04T08:00:00Z",
    attachedClients: 0,
    ...(providerId ? { providerId } : {}),
  } as SessionInfo;
}

function mockAuth(providers?: string[], capabilities?: string[]): void {
  authMock.mockReturnValue({
    type: "auth.ok",
    identity: { sub: "u", type: "human" },
    scopes: [],
    ...(providers ? { providers } : {}),
    ...(capabilities ? { capabilities } : {}),
  });
}

afterEach(() => {
  cleanup();
  _resetSessionsForTest();
  fetchModelsMock.mockClear();
  refreshSessionsMock.mockClear();
  requestMock.mockReset();
  requestMock.mockImplementation(() => Promise.resolve(undefined));
  authMock.mockReset();
});

describe("SessionControls mode dropdown dismissal", () => {
  it("opens on click and closes on Escape (not just mouse-leave)", async () => {
    ingestSessionList([sess()]);
    focusSession("s");
    const { getByTitle, queryByText } = render(() => <SessionControls />);

    // Closed initially — the option rows aren't in the DOM.
    expect(queryByText("interactive")).toBeNull();

    fireEvent.click(getByTitle("Cycle execution mode"));
    expect(queryByText("interactive")).not.toBeNull(); // menu open

    // Escape (keyboard/touch users can't trigger onMouseLeave) closes it.
    fireEvent.keyDown(document, { key: "Escape" });
    expect(queryByText("interactive")).toBeNull();
  });

  it("closes on an outside pointer-down", () => {
    ingestSessionList([sess()]);
    focusSession("s");
    const { getByTitle, queryByText } = render(() => <SessionControls />);
    fireEvent.click(getByTitle("Cycle execution mode"));
    expect(queryByText("interactive")).not.toBeNull();
    fireEvent.pointerDown(document.body); // click somewhere outside the menu
    expect(queryByText("interactive")).toBeNull();
  });
});

describe("ModePicker requests", () => {
  const MODE_TITLE = "Cycle execution mode";

  it("sends session.set_mode via request() and closes the menu on resolve", async () => {
    ingestSessionList([sess()]);
    focusSession("s");
    const { getByTitle, getByText, queryByText } = render(() => <SessionControls />);
    fireEvent.click(getByTitle(MODE_TITLE));
    fireEvent.click(getByText("autonomous"));
    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "session.set_mode",
          sessionId: "s",
          mode: "autonomous",
        }),
      ),
    );
    await waitFor(() => expect(queryByText("autonomous")).toBeNull()); // menu closed
  });

  it("keeps the menu open and surfaces a rejection inline", async () => {
    requestMock.mockImplementationOnce(() =>
      Promise.reject(new Error("mode locked by policy")),
    );
    ingestSessionList([sess()]);
    focusSession("s");
    const { getByTitle, getByText, queryByText, findByText } = render(() => (
      <SessionControls />
    ));
    fireEvent.click(getByTitle(MODE_TITLE));
    fireEvent.click(getByText("interactive"));
    expect(await findByText(/mode locked/)).toBeTruthy();
    expect(queryByText("autonomous")).not.toBeNull(); // still open, retry possible
  });

  it("disables the options while a request is in flight", () => {
    requestMock.mockImplementationOnce(() => new Promise(() => {}));
    ingestSessionList([sess()]);
    focusSession("s");
    const { getByTitle, getByText } = render(() => <SessionControls />);
    fireEvent.click(getByTitle(MODE_TITLE));
    const opt = getByText("interactive").closest("button") as HTMLButtonElement;
    fireEvent.click(opt);
    expect(opt.disabled).toBe(true);
  });
});

describe("ModelPicker custom model id", () => {
  const MODEL_TITLE = "Switch model (next turn applies)";

  /** The picker's open state is module-level (bare `/model` opens it), so a
   * previous test can leave it open — only toggle when it's closed. */
  function openModelMenu(
    getByTitle: (t: string) => HTMLElement,
    queryByPlaceholderText: (t: string) => HTMLElement | null,
  ): HTMLInputElement {
    if (!queryByPlaceholderText("custom model id")) {
      fireEvent.click(getByTitle(MODEL_TITLE));
    }
    return queryByPlaceholderText("custom model id") as HTMLInputElement;
  }

  it("submits via request() and keeps the typed id on rejection", async () => {
    requestMock.mockImplementationOnce(() =>
      Promise.reject(new Error("unknown model: clade-5-typo")),
    );
    ingestSessionList([sess()]);
    focusSession("s");
    const { getByTitle, queryByPlaceholderText, findByText } = render(() => (
      <SessionControls />
    ));
    const input = openModelMenu(getByTitle, queryByPlaceholderText);
    fireEvent.input(input, { target: { value: "clade-5-typo" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(requestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "session.set_model",
        sessionId: "s",
        model: "clade-5-typo",
      }),
    );
    // Rejection surfaces inline; the text stays put so the user can fix it.
    expect(await findByText(/unknown model/)).toBeTruthy();
    expect(input.value).toBe("clade-5-typo");
  });

  it("clears the input and closes the menu on resolve", async () => {
    ingestSessionList([sess()]);
    focusSession("s");
    const { getByTitle, queryByPlaceholderText } = render(() => <SessionControls />);
    const input = openModelMenu(getByTitle, queryByPlaceholderText);
    fireEvent.input(input, { target: { value: "claude-sonnet-4-5" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: "session.set_model", model: "claude-sonnet-4-5" }),
      ),
    );
    await waitFor(() => expect(queryByPlaceholderText("custom model id")).toBeNull());
  });
});

describe("RotateButton", () => {
  const ROTATE_TITLE =
    "Rotate the Claude Code backing context (refresh skills/settings; memory preserved)";

  it("rotates via request(), disabling while in flight (no double-fire)", async () => {
    let resolveReq!: (v: unknown) => void;
    requestMock.mockImplementationOnce(
      () => new Promise((r) => (resolveReq = r)),
    );
    ingestSessionList([sess()]);
    focusSession("s");
    const { getByTitle } = render(() => <SessionControls />);
    const btn = getByTitle(ROTATE_TITLE) as HTMLButtonElement;
    fireEvent.click(btn);
    fireEvent.click(btn); // second click while in flight must not re-send
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(requestMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: "session.rotate", sessionId: "s" }),
    );
    expect(btn.disabled).toBe(true);
    resolveReq(undefined);
    await waitFor(() => expect(btn.disabled).toBe(false));
  });

  it("surfaces a rotate rejection inline", async () => {
    requestMock.mockImplementationOnce(() =>
      Promise.reject(new Error("rotate failed: harness busy")),
    );
    ingestSessionList([sess()]);
    focusSession("s");
    const { getByTitle, findByText } = render(() => <SessionControls />);
    fireEvent.click(getByTitle(ROTATE_TITLE));
    expect(await findByText(/rotate failed/)).toBeTruthy();
  });
});

describe("DestroyButton", () => {
  const DESTROY_TITLE = "Destroy this session";

  it("removes the session only after the daemon confirms", async () => {
    ingestSessionList([sess()]);
    focusSession("s");
    const { getByTitle, getByText } = render(() => <SessionControls />);
    fireEvent.click(getByTitle(DESTROY_TITLE));
    fireEvent.click(getByText("yes"));
    expect(requestMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: "session.destroy", sessionId: "s" }),
    );
    // Removal happens on resolve, not optimistically at click time.
    await waitFor(() => expect(getSession("s")).toBeUndefined());
  });

  it("keeps the session and shows the error inline when destroy is rejected", async () => {
    requestMock.mockImplementationOnce(() =>
      Promise.reject(new Error("session is mid-turn")),
    );
    ingestSessionList([sess()]);
    focusSession("s");
    const { getByTitle, getByText, findByText } = render(() => <SessionControls />);
    fireEvent.click(getByTitle(DESTROY_TITLE));
    fireEvent.click(getByText("yes"));
    expect(await findByText(/mid-turn/)).toBeTruthy();
    expect(getSession("s")).toBeDefined(); // list did NOT desync
  });

  it("disables the confirm button while the destroy is in flight", async () => {
    let resolveReq!: (v: unknown) => void;
    requestMock.mockImplementationOnce(
      () => new Promise((r) => (resolveReq = r)),
    );
    ingestSessionList([sess()]);
    focusSession("s");
    const { getByTitle, getByText } = render(() => <SessionControls />);
    fireEvent.click(getByTitle(DESTROY_TITLE));
    const yes = getByText("yes") as HTMLButtonElement;
    fireEvent.click(yes);
    expect(yes.disabled).toBe(true);
    expect(getSession("s")).toBeDefined(); // still present while pending
    resolveReq(undefined);
    await waitFor(() => expect(getSession("s")).toBeUndefined());
  });
});

describe("ProviderPicker", () => {
  const PICKER_TITLE = "Switch this session's backend (/provider <id>)";

  it("is hidden on single-backend and legacy daemons", () => {
    mockAuth(["claude"]);
    ingestSessionList([sess()]);
    focusSession("s");
    const { queryByTitle } = render(() => <SessionControls />);
    expect(queryByTitle(PICKER_TITLE)).toBeNull();
    cleanup();

    mockAuth(undefined); // legacy daemon: no providers advertised
    ingestSessionList([sess()]);
    focusSession("s");
    const { queryByTitle: q2 } = render(() => <SessionControls />);
    expect(q2(PICKER_TITLE)).toBeNull();
  });

  it("shows the current backend and switches via session.set_provider", async () => {
    mockAuth(["claude", "pi"]);
    ingestSessionList([sess("claude")]);
    focusSession("s");
    const { getByText, getByTitle } = render(() => <SessionControls />);
    fireEvent.click(getByTitle(PICKER_TITLE));
    fireEvent.click(getByText("pi"));
    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "session.set_provider",
          sessionId: "s",
          providerId: "pi",
        }),
      ),
    );
  });

  it("selecting the current backend is a no-op close", () => {
    mockAuth(["claude", "pi"]);
    ingestSessionList([sess("pi")]);
    focusSession("s");
    const { getAllByText, getByTitle } = render(() => <SessionControls />);
    fireEvent.click(getByTitle(PICKER_TITLE));
    // First "pi" is the button label, the menu entry is the last match.
    const entries = getAllByText("pi");
    fireEvent.click(entries[entries.length - 1]!);
    expect(requestMock).not.toHaveBeenCalled();
  });

  it("surfaces the daemon's rejection inline (mid-turn switch)", async () => {
    requestMock.mockImplementationOnce(() =>
      Promise.reject(new Error("Session is mid-turn — interrupt it, then switch providers")),
    );
    mockAuth(["claude", "pi"]);
    ingestSessionList([sess("claude")]);
    focusSession("s");
    const { getByText, getByTitle, findByText } = render(() => <SessionControls />);
    fireEvent.click(getByTitle(PICKER_TITLE));
    fireEvent.click(getByText("pi"));
    expect(await findByText(/mid-turn/)).toBeTruthy();
  });
});

describe("WorktreeChip", () => {
  it("shows the isolated worktree branch when the session has one", async () => {
    mockAuth(["claude"]);
    ingestSessionList([
      {
        ...sess("claude"),
        worktree: { path: "/repo-worktrees/fix-a1b2", branch: "codeoid/fix-a1b2", createdByCodeoid: true },
      } as SessionInfo,
    ]);
    focusSession("s");
    const { getByText, getByTitle } = render(() => <SessionControls />);
    expect(getByText("codeoid/fix-a1b2")).toBeTruthy();
    expect(getByTitle(/Isolated git worktree/)).toBeTruthy();
  });

  it("renders no chip when the session shares its workdir (no worktree)", async () => {
    mockAuth(["claude"]);
    ingestSessionList([sess("claude")]);
    focusSession("s");
    const { queryByTitle } = render(() => <SessionControls />);
    expect(queryByTitle(/Isolated git worktree/)).toBeNull();
  });
});

describe("ForkButton", () => {
  const FORK_TITLE = "Fork this conversation into a new session (/fork)";

  it("default fork: same backend, isolated, from current state (no providerId/isolate/baseBranch)", async () => {
    // request() resolves to the daemon's response.ok envelope, not the bare
    // SessionInfo — doFork must unwrap `.data` (regression guard for the fork
    // never appearing in the sidebar).
    requestMock.mockResolvedValueOnce({
      type: "response.ok",
      requestId: "r",
      data: { id: "fork-1", name: "s (fork)", providerId: "claude" },
    });
    mockAuth(["claude"]);
    ingestSessionList([sess("claude")]);
    focusSession("s");
    const { getByTitle, getByText } = render(() => <SessionControls />);
    fireEvent.click(getByTitle(FORK_TITLE)); // open the dropdown
    fireEvent.click(getByText("fork (same backend)"));
    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: "session.fork", sessionId: "s" }),
      ),
    );
    const call = requestMock.mock.calls[0]![0];
    // Defaults: same backend, isolated, current state → none of these sent.
    expect(call).not.toHaveProperty("providerId");
    expect(call).not.toHaveProperty("isolate");
    expect(call).not.toHaveProperty("baseBranch");
    // The fork must land in the store (so the sidebar shows it) and become
    // focused — this is the regression that left the sidebar unchanged.
    await waitFor(() => expect(getSession("fork-1")).toBeTruthy());
    expect(focusedSession()?.id).toBe("fork-1");
    expect(refreshSessionsMock).not.toHaveBeenCalled(); // took the .data path
  });

  it("falls back to refreshSessions() when the daemon returns no data payload", async () => {
    // Older daemon: response.ok with no `.data`. doFork can't merge a fork it
    // wasn't handed, so it must refresh the list rather than silently no-op.
    requestMock.mockResolvedValueOnce({ type: "response.ok", requestId: "r" });
    mockAuth(["claude"]);
    ingestSessionList([sess("claude")]);
    focusSession("s");
    const { getByTitle, getByText } = render(() => <SessionControls />);
    fireEvent.click(getByTitle(FORK_TITLE));
    fireEvent.click(getByText("fork (same backend)"));
    await waitFor(() => expect(refreshSessionsMock).toHaveBeenCalledTimes(1));
  });

  it("the base-branch input is disabled while 'Fork from current state' is on", async () => {
    mockAuth(["claude"]);
    ingestSessionList([sess("claude")]);
    focusSession("s");
    const { getByTitle, getByPlaceholderText } = render(() => <SessionControls />);
    fireEvent.click(getByTitle(FORK_TITLE));
    const base = getByPlaceholderText(/using current state/) as HTMLInputElement;
    expect(base.disabled).toBe(true);
  });

  it("forks WHILE the session is mid-turn (status=thinking) — not gated on the turn", async () => {
    // Repro guard for "clicked fork while the model was streaming and nothing
    // happened". The daemon accepts fork mid-turn; the control must work
    // regardless of status.
    requestMock.mockResolvedValueOnce({
      type: "response.ok",
      requestId: "r",
      data: { id: "fork-mid", name: "s (fork)", providerId: "claude" },
    });
    mockAuth(["claude"]);
    ingestSessionList([sess("claude", "thinking")]);
    focusSession("s");
    const { getByTitle, getByText } = render(() => <SessionControls />);
    // Sanity: the session really is mid-turn — the interrupt button is enabled.
    const interrupt = getByTitle(/Interrupt the running turn/) as HTMLButtonElement;
    expect(interrupt.disabled).toBe(false);
    const fork = getByTitle(FORK_TITLE) as HTMLButtonElement;
    expect(fork.disabled).toBe(false);
    fireEvent.click(fork);
    fireEvent.click(getByText("fork (same backend)"));
    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: "session.fork", sessionId: "s" }),
      ),
    );
  });

  it("sends isolate:false when 'Isolated git worktree' is turned off (no base controls)", async () => {
    requestMock.mockResolvedValueOnce({
      type: "response.ok",
      requestId: "r",
      data: { id: "fork-opt", name: "s (fork)", providerId: "claude" },
    });
    mockAuth(["claude"]);
    ingestSessionList([sess("claude")]);
    focusSession("s");
    const { getByTitle, getByText } = render(() => <SessionControls />);
    fireEvent.click(getByTitle(FORK_TITLE));
    fireEvent.click(getByText("Isolated git worktree")); // toggle isolation off
    fireEvent.click(getByText("fork (same backend)"));
    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith(expect.objectContaining({ type: "session.fork", isolate: false })),
    );
    expect(requestMock.mock.calls[0]![0]).not.toHaveProperty("baseBranch");
  });

  it("toggling off 'Fork from current state' prefills the branch with 'main' and forks from it", async () => {
    requestMock.mockResolvedValueOnce({
      type: "response.ok",
      requestId: "r",
      data: { id: "fork-base", name: "s (fork)", providerId: "claude" },
    });
    mockAuth(["claude"]);
    ingestSessionList([sess("claude")]);
    focusSession("s");
    const { getByTitle, getByText, getByPlaceholderText } = render(() => <SessionControls />);
    fireEvent.click(getByTitle(FORK_TITLE));
    fireEvent.click(getByText("Fork from current state")); // off → input enabled + prefilled "main"
    expect((getByPlaceholderText(/base branch/) as HTMLInputElement).value).toBe("main");
    fireEvent.click(getByText("fork (same backend)"));
    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: "session.fork", baseBranch: "main" }),
      ),
    );
  });

  it("blocks the fork action when 'from a base' is selected but the branch is cleared", async () => {
    mockAuth(["claude"]);
    ingestSessionList([sess("claude")]);
    focusSession("s");
    const { getByTitle, getByText, getByPlaceholderText } = render(() => <SessionControls />);
    fireEvent.click(getByTitle(FORK_TITLE));
    fireEvent.click(getByText("Fork from current state")); // off → prefilled "main"
    fireEvent.input(getByPlaceholderText(/base branch/), { target: { value: "" } }); // clear it
    const forkBtn = getByText("fork (same backend)").closest("button") as HTMLButtonElement;
    expect(forkBtn.disabled).toBe(true);
    fireEvent.click(forkBtn);
    expect(requestMock).not.toHaveBeenCalled();
  });

  it("multi-backend daemon: dropdown offers fork-onto each OTHER backend", async () => {
    requestMock.mockResolvedValueOnce({
      type: "response.ok",
      requestId: "r",
      data: { id: "fork-2", name: "s (fork)", providerId: "codex" },
    });
    mockAuth(["claude", "codex", "pi"]);
    ingestSessionList([sess("claude")]);
    focusSession("s");
    const { getByTitle, getByText } = render(() => <SessionControls />);
    fireEvent.click(getByTitle(FORK_TITLE));
    expect(getByText("continue on")).toBeTruthy();
    expect(getByText("codex")).toBeTruthy();
    fireEvent.click(getByText("codex"));
    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: "session.fork", sessionId: "s", providerId: "codex" }),
      ),
    );
  });

  it("surfaces a fork rejection inline", async () => {
    requestMock.mockImplementationOnce(() =>
      Promise.reject(new Error("Cannot fork a conductor session")),
    );
    mockAuth(["claude", "pi"]);
    ingestSessionList([sess("claude")]);
    focusSession("s");
    const { getByTitle, getByText, findByText } = render(() => <SessionControls />);
    fireEvent.click(getByTitle(FORK_TITLE));
    fireEvent.click(getByText("fork (same backend)"));
    expect(await findByText(/Cannot fork/)).toBeTruthy();
  });
});

describe("ModelPicker — catalog follows the backend", () => {
  it("fetches the focused session's backend catalog on mount", () => {
    mockAuth(["claude", "codex"]);
    ingestSessionList([sess("codex")]);
    focusSession("s");
    render(() => <SessionControls />);
    // Not the daemon default — the SESSION's backend.
    expect(fetchModelsMock).toHaveBeenCalledWith("codex");
  });

  it("refetches when the session's backend switches (the reported bug)", async () => {
    mockAuth(["claude", "codex"]);
    ingestSessionList([sess("claude")]);
    focusSession("s");
    render(() => <SessionControls />);
    expect(fetchModelsMock).toHaveBeenCalledWith("claude");
    fetchModelsMock.mockClear();

    // A `/provider` switch arrives as an info_update flipping providerId.
    mergeSession({ id: "s", providerId: "codex" });
    await waitFor(() => expect(fetchModelsMock).toHaveBeenCalledWith("codex"));
  });
});

describe("ForkedFromChip — lineage", () => {
  function forkSess(parentId: string, atTurn: number): SessionInfo {
    return {
      ...sess(),
      id: "fork-1",
      name: "parent (fork)",
      forkedFrom: { sessionId: parentId, name: "Sandbox", atTurn },
    } as SessionInfo;
  }

  it("renders 'from <parent> · turn N' and focuses the parent on click", async () => {
    const parent = { ...sess(), id: "p", name: "Sandbox" } as SessionInfo;
    ingestSessionList([parent, forkSess("p", 12)]);
    focusSession("fork-1");
    const { getByTitle, getByText } = render(() => <SessionControls />);

    // Chip shows the parent name + branch point.
    expect(getByText("Sandbox")).toBeTruthy();
    expect(getByText("· turn 12")).toBeTruthy();
    const chip = getByTitle(/Forked from “Sandbox” after 12 turn/);

    // Clicking focuses the parent.
    fireEvent.click(chip);
    const { focusedSessionId } = await import("../state/sessions");
    expect(focusedSessionId()).toBe("p");
  });

  it("is a static (disabled) label when the parent is no longer open", () => {
    // Only the fork is in the list — the parent was destroyed.
    ingestSessionList([forkSess("gone", 3)]);
    focusSession("fork-1");
    const { getByTitle } = render(() => <SessionControls />);
    const chip = getByTitle(/Forked from “Sandbox” \(no longer open\)/) as HTMLButtonElement;
    expect(chip.disabled).toBe(true);
  });

  it("no chip for a non-forked session", () => {
    ingestSessionList([sess()]);
    focusSession("s");
    const { queryByText } = render(() => <SessionControls />);
    expect(queryByText(/from/)).toBeNull();
  });

  it("switching from a forked to a non-forked session doesn't crash the chip", () => {
    // Reactive-disposal hazard: parentAlive() must tolerate forkedFrom going
    // undefined when focus moves to a non-fork, before <Show> tears down.
    const plain = { ...sess(), id: "s" } as SessionInfo;
    ingestSessionList([plain, forkSess("s", 4)]);
    focusSession("fork-1");
    const { queryByText } = render(() => <SessionControls />);
    expect(queryByText("· turn 4")).toBeTruthy();
    // Switch focus to the non-fork — must not throw as the chip disposes.
    expect(() => focusSession("s")).not.toThrow();
    expect(queryByText("· turn 4")).toBeNull();
  });
});

describe("SessionControls — goal blackboard button", () => {
  const orchestrator = () =>
    ({
      ...sess(),
      collaboration: { goal: "g", roles: [{ name: "orchestrator", providerId: "claude" }] },
    }) as SessionInfo;

  const roleChild = () =>
    ({
      ...sess(),
      collaborationRole: { parentSessionId: "p", roleName: "review", ordinal: 1, write: false },
    }) as SessionInfo;

  it("offers the board for an orchestrator when the daemon advertises it", () => {
    mockAuth(undefined, ["blackboard"]);
    ingestSessionList([orchestrator()]);
    focusSession("s");
    const { getByText } = render(() => <SessionControls />);
    fireEvent.click(getByText("board"));
    expect(openBlackboardMock).toHaveBeenCalledWith("s");
  });

  it("offers it for a role-child too — the daemon resolves the parent hop", () => {
    mockAuth(undefined, ["blackboard"]);
    ingestSessionList([roleChild()]);
    focusSession("s");
    const { getByText } = render(() => <SessionControls />);
    expect(getByText("board")).toBeTruthy();
  });

  it("hides it on a daemon that doesn't advertise the capability", () => {
    // An affordance that errors on click is worse than no affordance.
    mockAuth();
    ingestSessionList([orchestrator()]);
    focusSession("s");
    const { queryByText } = render(() => <SessionControls />);
    expect(queryByText("board")).toBeNull();
  });

  it("hides it for a session with no collaboration at all", () => {
    mockAuth(undefined, ["blackboard"]);
    ingestSessionList([sess()]);
    focusSession("s");
    const { queryByText } = render(() => <SessionControls />);
    expect(queryByText("board")).toBeNull();
  });
});
