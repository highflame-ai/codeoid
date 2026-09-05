import { describe, it, expect } from "vitest";

import { countVisible, filterFleet, groupFleet, roleLabel, workerShape } from "./fleet";
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

describe("groupFleet — conductor and dispatch workers", () => {
  const conductor = (id = "cond") => session(id, { name: "conductor", role: "conductor" });
  const worker = (id: string, shape: "ship" | "scout", task: string, createdAt?: string) =>
    session(id, {
      name: `worker-${shape}-${task}`,
      role: "worker",
      ...(createdAt ? { createdAt } : {}),
    });

  it("nests dispatch workers under the conductor even though they carry no parent id", () => {
    const groups = groupFleet([
      session("plain"),
      conductor(),
      worker("w1", "scout", "aaaa1111"),
      worker("w2", "ship", "bbbb2222"),
    ]);

    expect(groups.map((g) => g.lead.id)).toEqual(["plain", "cond"]);
    const cond = groups[1]!;
    expect(cond.isConductor).toBe(true);
    expect(cond.children.map((c) => c.id)).toEqual(["w1", "w2"]);
  });

  it("marks a conductor with no workers as a conductor, not a plain session", () => {
    const g = groupFleet([conductor()])[0]!;
    expect(g.isConductor).toBe(true);
    expect(g.isFleet).toBe(false);
    expect(g.children).toEqual([]);
  });

  it("orders workers oldest first, breaking ties by name", () => {
    const groups = groupFleet([
      conductor(),
      worker("late", "scout", "zzz", "2026-07-27T00:00:05.000Z"),
      worker("early", "scout", "aaa", "2026-07-27T00:00:01.000Z"),
      worker("tie-b", "ship", "bbb", "2026-07-27T00:00:01.000Z"),
    ]);
    // early and tie-b share a timestamp → name decides; late sorts after both.
    expect(groups[0]!.children.map((c) => c.name)).toEqual([
      "worker-scout-aaa",
      "worker-ship-bbb",
      "worker-scout-zzz",
    ]);
  });

  it("promotes workers to top level when no conductor is visible", () => {
    // The conductor can legitimately be absent — another tenant's client, or a
    // list that has not been delivered yet. Dropping the rows would be worse.
    const groups = groupFleet([worker("w1", "scout", "aaaa")]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.lead.id).toBe("w1");
    expect(groups[0]!.isConductor).toBe(false);
  });

  it("keeps a collaboration child under its orchestrator, not the conductor", () => {
    const parent = session("p", { collaboration: GOAL });
    const groups = groupFleet([conductor(), parent, child("c1", "p", "review")]);
    expect(groups.map((g) => g.lead.id)).toEqual(["cond", "p"]);
    expect(groups[1]!.children.map((c) => c.id)).toEqual(["c1"]);
    expect(groups[0]!.children).toEqual([]);
  });

  it("labels a worker by shape and task tail", () => {
    expect(roleLabel(worker("w", "scout", "c0234348"))).toBe("scout·c0234348");
    expect(workerShape(worker("w", "ship", "x"))).toBe("ship");
    // A user-named session is never mislabelled: only the daemon sets the role.
    expect(workerShape(session("s", { name: "worker-ship-nope" }))).toBeNull();
  });

  it("filters on role and shape, keeping the conductor as context", () => {
    const groups = groupFleet([conductor(), worker("w1", "scout", "aaaa")]);
    const g = filterFleet(groups, "scout")[0]!;
    expect(g.leadMatched).toBe(false);
    expect(g.lead.id).toBe("cond");
    expect(g.children.map((c) => c.id)).toEqual(["w1"]);

    expect(filterFleet(groups, "conductor")[0]!.leadMatched).toBe(true);
  });
});
