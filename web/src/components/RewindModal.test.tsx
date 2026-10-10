// @vitest-environment jsdom
/**
 * The go-back dialog (#355): previews with a dry run before anything
 * happens, keeps restoring files opt-in, asks before overwriting hand edits,
 * and puts the taken-back prompt back in the composer.
 */
import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { render, cleanup, fireEvent, waitFor } from "@solidjs/testing-library";

const clientRequest = vi.hoisted(() => vi.fn<(msg: Record<string, unknown>) => Promise<unknown>>());
vi.mock("../state/connection", () => ({
  newRequestId: () => "r",
  getClient: () => ({ request: (msg: Record<string, unknown>) => clientRequest(msg) }),
}));
const setDraftMock = vi.hoisted(() => vi.fn());
const draftHolder = vi.hoisted(() => ({ value: "" }));
vi.mock("../state/prompt-drafts", () => ({ setDraft: setDraftMock, getDraft: () => draftHolder.value }));

import RewindModal, { openRewind, openUndoLast } from "./RewindModal";

const plan = (over: Record<string, unknown> = {}) => ({
  type: "session.rewind.result",
  requestId: "r",
  sessionId: "s",
  turnId: "t2",
  dryRun: true,
  planId: "plan-1",
  removedTurns: 2,
  restoredPrompt: "oops, the wrong prompt",
  irreversible: [{ tool: "Bash", detail: "git push origin main" }],
  files: { restore: ["a.txt"], remove: ["new.txt"], conflicts: [], applied: false },
  ...over,
});

beforeEach(() => {
  clientRequest.mockReset();
  setDraftMock.mockReset();
});
afterEach(() => cleanup());

describe("RewindModal", () => {
  it("previews with a dry run, then goes back without touching files unless asked", async () => {
    clientRequest.mockImplementation(async (msg) => (msg.dryRun ? plan() : plan({ dryRun: false })));
    const r = render(() => <RewindModal />);
    openRewind("s", "t2");
    await waitFor(() => expect(r.getByText(/oops, the wrong prompt/)).toBeTruthy());
    expect(clientRequest.mock.calls[0]![0]).toMatchObject({ type: "session.rewind", turnId: "t2", dryRun: true, restoreFiles: true });
    expect(r.getByText(/the 1 after it/)).toBeTruthy();
    expect(r.getByText(/git push origin main/)).toBeTruthy();
    expect(r.queryByText("a.txt")).toBeNull(); // files hidden until opted in

    fireEvent.click(r.getByRole("button", { name: "Go back" }));
    await waitFor(() => expect(setDraftMock).toHaveBeenCalledWith("s", "oops, the wrong prompt"));
    const real = clientRequest.mock.calls[1]![0];
    expect(real).toMatchObject({ type: "session.rewind", turnId: "t2" });
    expect(real.dryRun).toBeUndefined();
    expect(real.restoreFiles).toBeUndefined();
    expect(real.force).toBeUndefined();
  });

  it("restoring files shows what changes, and asks before overwriting hand edits", async () => {
    clientRequest.mockImplementation(async (msg) =>
      msg.dryRun ? plan({ files: { restore: ["a.txt"], remove: [], conflicts: ["a.txt"], applied: false } }) : plan({ dryRun: false }),
    );
    const r = render(() => <RewindModal />);
    openRewind("s", "t2");
    await waitFor(() => r.getByText(/oops/));
    fireEvent.click(r.getByRole("checkbox"));
    expect(r.getByText(/will be overwritten/)).toBeTruthy();
    fireEvent.click(r.getByRole("button", { name: "Go back and overwrite my edits" }));
    await waitFor(() => expect(clientRequest).toHaveBeenCalledTimes(2));
    expect(clientRequest.mock.calls[1]![0]).toMatchObject({ restoreFiles: true, force: true, planId: "plan-1" });
  });

  it("if the session changed since the preview, shows the fresh preview instead of going ahead", async () => {
    let calls = 0;
    clientRequest.mockImplementation(async (msg) => {
      calls++;
      if (!msg.dryRun) return plan({ dryRun: true, refused: "the session changed since the preview — review it again." });
      return calls === 1 ? plan() : plan({ planId: "plan-2", files: { restore: ["a.txt", "b.txt"], remove: [], conflicts: [], applied: false } });
    });
    const r = render(() => <RewindModal />);
    openRewind("s", "t2");
    await waitFor(() => r.getByText(/oops/));
    fireEvent.click(r.getByRole("checkbox"));
    fireEvent.click(r.getByRole("button", { name: "Go back" }));
    await waitFor(() => r.getByText(/changed since the preview/));
    expect(r.getByText("b.txt")).toBeTruthy();
    expect(setDraftMock).not.toHaveBeenCalled();
  });

  it("puts the prompt above a half-typed draft rather than over it", async () => {
    draftHolder.value = "something I was typing";
    clientRequest.mockImplementation(async (msg) => (msg.dryRun ? plan() : plan({ dryRun: false })));
    const r = render(() => <RewindModal />);
    openRewind("s", "t2");
    await waitFor(() => r.getByText(/oops/));
    fireEvent.click(r.getByRole("button", { name: "Go back" }));
    await waitFor(() => expect(setDraftMock).toHaveBeenCalledWith("s", "oops, the wrong prompt\n\nsomething I was typing"));
    draftHolder.value = "";
  });

  it("says when files can't be restored, and keeps the checkbox off", async () => {
    clientRequest.mockResolvedValue(plan({ files: undefined, filesUnavailable: "there is no snapshot of the files from when that turn started" }));
    const r = render(() => <RewindModal />);
    openRewind("s", "t2");
    await waitFor(() => r.getByText(/no snapshot/));
    expect((r.getByRole("checkbox") as HTMLInputElement).disabled).toBe(true);
  });

  it("undo targets the latest turn, and reports when there is nothing to undo", async () => {
    clientRequest.mockResolvedValueOnce({ type: "session.turns.result", requestId: "r", sessionId: "s", turns: [], checkpointsSupported: true });
    expect(await openUndoLast("s")).toBe(false);
    clientRequest.mockImplementation(async (msg) =>
      msg.type === "session.turns"
        ? { type: "session.turns.result", requestId: "r", sessionId: "s", checkpointsSupported: true, turns: [{ turnId: "t1" }, { turnId: "t9" }] }
        : plan({ turnId: "t9" }),
    );
    render(() => <RewindModal />);
    expect(await openUndoLast("s")).toBe(true);
    await waitFor(() => expect(clientRequest.mock.calls.some(([m]) => m.type === "session.rewind" && m.turnId === "t9")).toBe(true));
  });
});
