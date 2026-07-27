import { describe, it, expect } from "vitest";

import { countVisible, filterFleet, groupFleet, roleLabel } from "./fleet";
import type { CollaborationConfig, SessionInfo } from "../protocol/types";

function session(
  id: string,
  over: Partial<SessionInfo> = {},
): SessionInfo {
  return {
    id,
    name: id,
    workdir: `/repo/${id}`,
    status: "idle",
    createdAt: "2026-07-27T00:00:00.000Z",
    ...over,
  } as SessionInfo;
}

const GOAL: CollaborationConfig = {
  goal: "ship the thing",
  roles: [{ name: "orchestrator", providerId: "claude" }],
};

function child(
  id: string,
  parentSessionId: string,
  roleName: string,
  ordinal = 1,
  write = false,
): SessionInfo {
  return session(id, {
    collaborationRole: { parentSessionId, roleName, ordinal, write },
  });
}

describe("groupFleet", () => {
  it("nests role-children under their orchestrator and keeps lead order", () => {
    const parent = session("p", { collaboration: GOAL });
    const groups = groupFleet([
      session("standalone-b"),
      parent,
      child("c2", "p", "review", 2),
      child("c1", "p", "review", 1),
      session("standalone-a"),
    ]);

    expect(groups.map((g) => g.lead.id)).toEqual([
      "standalone-b",
      "p",
      "standalone-a",
    ]);
    const fleet = groups[1]!;
    expect(fleet.isFleet).toBe(true);
    expect(fleet.children.map((c) => c.id)).toEqual(["c1", "c2"]);
  });

  it("orders children by role name then ordinal, not by list position", () => {
    const parent = session("p", { collaboration: GOAL });
    const groups = groupFleet([
      parent,
      child("r2", "p", "review", 2),
      child("s1", "p", "search", 1),
      child("r1", "p", "review", 1),
      child("a1", "p", "architecture", 1),
    ]);
    expect(groups[0]!.children.map((c) => c.id)).toEqual(["a1", "r1", "r2", "s1"]);
  });

  it("marks a collaboration with no children yet as a fleet", () => {
    // Between session.create and #spawnCollaborationChildren the parent exists
    // alone; it must not render as a plain session and then become a fleet.
    const groups = groupFleet([session("p", { collaboration: GOAL })]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.isFleet).toBe(true);
    expect(groups[0]!.children).toEqual([]);
  });

  it("promotes an orphan child to a top-level group instead of dropping it", () => {
    // Parent destroyed while the child drains, or not yet delivered to this
    // client. Either way the child must stay visible.
    const groups = groupFleet([child("c1", "gone", "search", 1)]);
    expect(groups.map((g) => g.lead.id)).toEqual(["c1"]);
    expect(groups[0]!.isFleet).toBe(false);
  });

  it("does not nest a child under a parent that is merely name-similar", () => {
    const groups = groupFleet([
      session("p", { collaboration: GOAL }),
      child("c1", "p-other", "search", 1),
    ]);
    expect(groups.map((g) => g.lead.id)).toEqual(["p", "c1"]);
    expect(groups[0]!.children).toEqual([]);
  });

  it("returns an empty list for no sessions", () => {
    expect(groupFleet([])).toEqual([]);
  });
});

describe("filterFleet", () => {
  const parent = session("p", { name: "refactor-auth", collaboration: GOAL });
  const groups = groupFleet([
    parent,
    child("c1", "p", "search", 1),
    child("c2", "p", "review", 1),
    session("unrelated", { name: "scratch", workdir: "/tmp/scratch" }),
  ]);

  it("passes everything through for an empty query", () => {
    const out = filterFleet(groups, "  ");
    expect(out).toHaveLength(2);
    expect(out.every((g) => g.leadMatched)).toBe(true);
    expect(out[0]!.children).toHaveLength(2);
  });

  it("keeps the whole fleet when the lead matches", () => {
    const out = filterFleet(groups, "refactor");
    expect(out).toHaveLength(1);
    expect(out[0]!.leadMatched).toBe(true);
    expect(out[0]!.children.map((c) => c.id)).toEqual(["c2", "c1"]);
  });

  it("keeps the lead as unmatched context when only a child matches", () => {
    const out = filterFleet(groups, "search");
    expect(out).toHaveLength(1);
    expect(out[0]!.lead.id).toBe("p");
    expect(out[0]!.leadMatched).toBe(false);
    expect(out[0]!.children.map((c) => c.id)).toEqual(["c1"]);
  });

  it("matches a child on its role name, which is not part of its session name", () => {
    // The child's own `name` is daemon-generated; the role is what the user
    // actually thinks in.
    const out = filterFleet(groups, "review");
    expect(out).toHaveLength(1);
    expect(out[0]!.children.map((c) => c.id)).toEqual(["c2"]);
  });

  it("matches on workdir", () => {
    const out = filterFleet(groups, "/tmp/scratch");
    expect(out.map((g) => g.lead.id)).toEqual(["unrelated"]);
  });

  it("drops groups where nothing matches", () => {
    expect(filterFleet(groups, "nothing-here")).toEqual([]);
  });
});

describe("countVisible", () => {
  it("counts leads plus their children", () => {
    const groups = groupFleet([
      session("p", { collaboration: GOAL }),
      child("c1", "p", "search", 1),
      child("c2", "p", "review", 1),
      session("solo"),
    ]);
    expect(countVisible(groups)).toBe(4);
    expect(countVisible([])).toBe(0);
  });
});

describe("roleLabel", () => {
  it("omits the ordinal for a singleton role and shows it for a fan-out", () => {
    expect(roleLabel(child("c", "p", "search", 1))).toBe("search");
    expect(roleLabel(child("c", "p", "review", 2))).toBe("review#2");
  });

  it("returns null for a session that is not a role-child", () => {
    expect(roleLabel(session("solo"))).toBeNull();
  });
});
