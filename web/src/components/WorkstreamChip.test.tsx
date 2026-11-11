// @vitest-environment jsdom
import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";

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
});
