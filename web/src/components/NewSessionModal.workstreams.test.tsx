// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

const requestMock = vi.hoisted(() => vi.fn());
vi.mock("../state/connection", () => ({
  send: vi.fn(),
  request: requestMock,
  newRequestId: () => "r",
  refreshSessions: vi.fn(() => Promise.resolve([])),
  authIdentity: vi.fn(),
  getClient: () => {
    throw new Error("not bootstrapped");
  },
}));
vi.mock("../state/packs", () => ({
  fetchPacks: vi.fn(() => Promise.resolve()),
  packsState: () => ({ installed: [], available: [], registries: [], loading: false, busy: false, loaded: true, error: null }),
}));
vi.mock("../state/pipelines", () => ({ runPipeline: vi.fn() }));
const resolveMock = vi.hoisted(() => vi.fn());
vi.mock("../state/workstreams", () => ({
  fetchWorkstreams: vi.fn(() => Promise.resolve()),
  homeChoices: () => [
    { id: "acme", name: "Acme", abstract: false },
    { id: "mine", name: "mine", abstract: false },
  ],
  resolveWorkstream: resolveMock,
}));

import NewSessionModal, { openNewSessionModal } from "./NewSessionModal";

afterEach(() => {
  cleanup();
  requestMock.mockReset();
  resolveMock.mockReset();
});

function setup() {
  resolveMock.mockResolvedValue({ home: "acme", source: "matched", matchedBy: "~/acme", candidates: [] });
  const r = render(() => <NewSessionModal />);
  openNewSessionModal();
  return r;
}

describe("the new-session dialog's workstream", () => {
  it("says what the folder resolves to, and sends an explicit choice", async () => {
    const r = setup();
    fireEvent.input(r.getByLabelText(/^Name/), { target: { value: "s1" } });
    fireEvent.input(r.getByLabelText(/^Workdir/), { target: { value: "/w/acme" } });
    await waitFor(() => expect(r.getByLabelText("Workstream").textContent).toContain("The folder's: acme (matched by ~/acme)"), { timeout: 2000 });
    fireEvent.change(r.getByLabelText("Workstream"), { target: { value: "mine" } });
    requestMock.mockResolvedValueOnce({ info: { id: "s1", name: "s1" } });
    fireEvent.click(r.getByRole("button", { name: /^create/i }));
    await waitFor(() => expect(requestMock).toHaveBeenCalled());
    expect(requestMock.mock.calls[0]![0]).toMatchObject({ type: "session.create", workstream: "mine" });
    expect(requestMock.mock.calls[0]![0]).not.toHaveProperty("override");
  });

  it("a conflict is offered with what would change; Start anyway resends with the token", async () => {
    const r = setup();
    fireEvent.input(r.getByLabelText(/^Name/), { target: { value: "s2" } });
    fireEvent.input(r.getByLabelText(/^Workdir/), { target: { value: "/w/acme" } });
    fireEvent.change(r.getByLabelText("Workstream"), { target: { value: "mine" } });
    const conflict = Object.assign(new Error('This folder belongs to workstream "acme" (exclusive).'), {
      code: "invalid_request",
      detail: { kind: "workstream_conflict", resolution: { home: "mine", source: "explicit", candidates: [], conflict: { folder: "acme", chosen: "mine", overridable: true, overrideToken: "tok-1", changes: { gains: ["notes"], withholds: ["github"], env: [] } } } },
    });
    requestMock.mockRejectedValueOnce(conflict);
    fireEvent.click(r.getByRole("button", { name: /^create/i }));
    const offer = await r.findByRole("alert");
    expect(offer.textContent).toContain("belongs to workstream “Acme” (exclusive)");
    expect(offer.textContent).toContain("“mine”'s servers (notes)");
    expect(offer.textContent).toContain("not given github");
    requestMock.mockResolvedValueOnce({ info: { id: "s2", name: "s2" } });
    fireEvent.click(r.getByRole("button", { name: "Start anyway" }));
    await waitFor(() => expect(requestMock).toHaveBeenCalledTimes(2));
    expect(requestMock.mock.calls[1]![0]).toMatchObject({ workstream: "mine", override: { token: "tok-1" } });
  });

  it("Use the folder's sets the choice and clears the offer; workstream_required is said in the UI's words", async () => {
    const r = setup();
    fireEvent.input(r.getByLabelText(/^Name/), { target: { value: "s3" } });
    fireEvent.input(r.getByLabelText(/^Workdir/), { target: { value: "/w/acme" } });
    fireEvent.change(r.getByLabelText("Workstream"), { target: { value: "mine" } });
    requestMock.mockRejectedValueOnce(
      Object.assign(new Error("conflict"), { detail: { kind: "workstream_conflict", resolution: { source: "explicit", candidates: [], conflict: { folder: "acme", chosen: "mine", overridable: true, overrideToken: "t" } } } }),
    );
    fireEvent.click(r.getByRole("button", { name: /^create/i }));
    fireEvent.click(await r.findByRole("button", { name: "Use “Acme”" }));
    expect((r.getByLabelText("Workstream") as HTMLSelectElement).value).toBe("acme");
    expect(r.queryByRole("button", { name: "Start anyway" })).toBeNull();
    requestMock.mockRejectedValueOnce(
      Object.assign(new Error("…choose the workstream with --workstream."), { detail: { kind: "workstream_required", resolution: { source: "none", candidates: [], ambiguous: ["acme", "mine"] } } }),
    );
    fireEvent.click(r.getByRole("button", { name: /^create/i }));
    await waitFor(() => expect(r.container.textContent).toContain("Choose a workstream for this folder: Acme and mine both match"));
    expect(r.container.textContent).not.toContain("--workstream");
  });

  it("a failed check says so, and a changed folder never shows the last folder's answer", async () => {
    const r = setup();
    resolveMock.mockReset();
    resolveMock.mockRejectedValue(new Error("forbidden"));
    fireEvent.input(r.getByLabelText(/^Workdir/), { target: { value: "/w/x" } });
    await waitFor(() => expect(r.getByLabelText("Workstream").textContent).toContain("couldn't check it"), { timeout: 2000 });
    resolveMock.mockReset();
    resolveMock.mockImplementation(() => new Promise(() => {}));
    fireEvent.input(r.getByLabelText(/^Workdir/), { target: { value: "/w/y" } });
    expect(r.getByLabelText("Workstream").textContent).toContain("checking");
  });
});

