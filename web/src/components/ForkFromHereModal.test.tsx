// @vitest-environment jsdom
/** Fork from here (#356): forks after the chosen turn, isolated by default, optionally onto another backend. */
import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { render, cleanup, fireEvent, waitFor } from "@solidjs/testing-library";

const requestMock = vi.hoisted(() => vi.fn<(msg: Record<string, unknown>) => Promise<unknown>>());
vi.mock("../state/connection", () => ({
  request: (msg: Record<string, unknown>) => requestMock(msg),
  newRequestId: () => "r",
  refreshSessions: vi.fn(() => Promise.resolve([])),
  authIdentity: () => ({ providers: ["claude", "pi"] }),
}));
const focusMock = vi.hoisted(() => vi.fn());
vi.mock("../state/sessions", () => ({
  getSession: () => ({ id: "s", providerId: "claude" }),
  mergeSession: vi.fn(),
  focusSession: focusMock,
}));

import ForkFromHereModal, { openForkFromHere } from "./ForkFromHereModal";

beforeEach(() => {
  requestMock.mockReset();
  focusMock.mockReset();
});
afterEach(() => cleanup());

describe("ForkFromHereModal", () => {
  it("forks after the chosen turn into its own worktree and focuses the fork", async () => {
    requestMock.mockResolvedValue({ type: "response.ok", data: { id: "fork-1" } });
    const r = render(() => <ForkFromHereModal />);
    openForkFromHere("s", "t2");
    fireEvent.click((await r.findAllByRole("button", { name: /^Fork\s*claude/ }))[0]!);
    await waitFor(() => expect(focusMock).toHaveBeenCalledWith("fork-1"));
    const msg = requestMock.mock.calls[0]![0];
    expect(msg).toMatchObject({ type: "session.fork", sessionId: "s", afterTurnId: "t2" });
    expect(msg.isolate).toBeUndefined();
    expect(msg.providerId).toBeUndefined();
  });

  it("can share the folder, and continue on another backend", async () => {
    requestMock.mockResolvedValue({ type: "response.ok", data: { id: "fork-2" } });
    const r = render(() => <ForkFromHereModal />);
    openForkFromHere("s", "t1");
    fireEvent.click(await r.findByRole("checkbox"));
    fireEvent.click(r.getByText("pi"));
    await waitFor(() => expect(requestMock).toHaveBeenCalled());
    expect(requestMock.mock.calls[0]![0]).toMatchObject({ afterTurnId: "t1", providerId: "pi", isolate: false });
  });

  it("shows the daemon's refusal", async () => {
    requestMock.mockRejectedValue(new Error("That turn isn't in this session"));
    const r = render(() => <ForkFromHereModal />);
    openForkFromHere("s", "gone");
    fireEvent.click((await r.findAllByRole("button", { name: /^Fork\s*claude/ }))[0]!);
    await waitFor(() => r.getByText(/isn't in this session/));
  });
});
