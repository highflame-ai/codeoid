// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

const change = vi.hoisted(() => vi.fn());
vi.mock("../state/workstreams", () => ({
  changeSessionWorkstream: change,
  fetchWorkstreams: vi.fn(() => Promise.resolve()),
  homeChoices: () => [
    { id: "acme", name: "Acme", share: "ask" },
    { id: "pub", name: "Pub", share: "open" },
    { id: "hf", name: "HF", share: "closed" },
  ],
  workstreamsState: () => ({ workstreams: [{ id: "acme", name: "Acme", share: "ask" }, { id: "pub", name: "Pub", share: "open" }, { id: "hf", name: "HF", share: "closed" }] }),
}));

import type { SessionInfo } from "../protocol/types";
import { chipColor, WorkstreamChip } from "./WorkstreamChip";

const session = (workstream?: SessionInfo["workstream"]) => ({ id: "s", name: "s", workdir: "/w", status: "idle", createdBy: "u", createdAt: "t", attachedClients: 0, ...(workstream ? { workstream } : {}) }) as SessionInfo;

afterEach(() => cleanup());

describe("WorkstreamChip", () => {
  it("shows the name, how it was decided, and nothing on a daemon without workstreams", () => {
    const { getByTestId, unmount } = render(() => <WorkstreamChip session={session({ id: "acme", name: "Acme", source: "matched", matchedBy: "~/acme" })} />);
    expect(getByTestId("workstream-chip").textContent).toContain("Acme");
    expect(getByTestId("workstream-chip").getAttribute("title")).toContain("matched by ~/acme");
    unmount();
    const none = render(() => <WorkstreamChip session={session()} />);
    expect(none.container.textContent).toBe("");
  });

  it("orphaned is red, an override amber, no home says so", () => {
    const o = render(() => <WorkstreamChip session={session({ id: "gone", source: "matched", orphaned: true })} />);
    expect(o.getByTestId("workstream-chip").className).toContain("text-danger");
    cleanup();
    const v = render(() => <WorkstreamChip session={session({ id: "a", source: "override" })} />);
    expect(v.getByTestId("workstream-chip").className).toContain("text-warn");
    cleanup();
    const n = render(() => <WorkstreamChip session={session({ source: "none" })} />);
    expect(n.getByTestId("workstream-chip").textContent).toContain("no workstream");
  });

  it("a config color is a name or #hex only — never arbitrary CSS", () => {
    expect(chipColor("orange")).toBe("orange");
    expect(chipColor("#f97316")).toBe("#f97316");
    expect(chipColor("red; background:url(x)")).toBeUndefined();
    expect(chipColor(undefined)).toBeUndefined();
  });

  it("editable: a panel with what it reads (remove), what it could read (never a closed one), and a move; a pending ask is said", async () => {
    change.mockResolvedValue({ pending: false });
    const r = render(() => <WorkstreamChip editable session={session({ id: "acme", name: "Acme", source: "matched", references: [{ workstream: "pub" }] })} />);
    expect(r.getByTestId("workstream-chip").textContent).toContain("+1");
    fireEvent.click(r.getByTestId("workstream-chip"));
    const panel = r.getByRole("dialog", { name: "Workstream" });
    expect(panel.textContent).toContain("Pub");
    // Nothing more to read: pub is read already, hf is closed, acme is the home.
    expect(r.queryByLabelText("Add a workstream to read")).toBeNull();
    fireEvent.click(r.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(change).toHaveBeenCalledWith("s", { kind: "remove_reference", workstream: "pub" }));
    change.mockResolvedValueOnce({ pending: true });
    fireEvent.change(r.getByLabelText("Move to workstream"), { target: { value: "pub" } });
    fireEvent.click(r.getByRole("button", { name: "Move" }));
    await waitFor(() => expect(r.getByRole("status").textContent).toContain("Asked on the session"));
    change.mockRejectedValueOnce(new Error("closed: no"));
    fireEvent.change(r.getByLabelText("Move to workstream"), { target: { value: "hf" } });
    fireEvent.click(r.getByRole("button", { name: "Move" }));
    await waitFor(() => expect(r.getByRole("alert").textContent).toContain("closed: no"));
  });
});
