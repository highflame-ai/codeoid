/**
 * Session-list ordering.
 *
 * The behaviour these pin, in order of how badly the failure reads to a user:
 *
 *   1. A session blocked on YOU is never buried under idle ones — including
 *      when the blocked party is a fleet's child and the orchestrator is idle.
 *   2. The list orders by relevance, not creation time (the original bug).
 *   3. It does not reorder under the pointer.
 *   4. It degrades sanely against a daemon that never sends lastActivityAt.
 */

import { describe, it, expect } from "vitest";

import {
  BAND,
  activityKey,
  bandOf,
  bandOfGroup,
  bandSections,
  compareByRecency,
  holdOrder,
  snapshotOrder,
} from "./session-order";
import type { FleetGroup } from "./fleet";
import type { SessionInfo, SessionStatus } from "../protocol/types";

function mk(
  id: string,
  over: Partial<SessionInfo> & { status?: SessionStatus } = {},
): SessionInfo {
  return {
    id,
    name: id,
    workdir: `/repo/${id}`,
    status: "idle",
    createdBy: "u",
    createdAt: "2026-01-01T00:00:00.000Z",
    attachedClients: 0,
    ...over,
  } as SessionInfo;
}

const group = (lead: SessionInfo, children: SessionInfo[] = []): FleetGroup => ({
  lead,
  children,
  isFleet: children.length > 0,
  isConductor: lead.role === "conductor",
});

describe("bands", () => {
  it("puts anything blocked on a human in NEEDS_YOU", () => {
    expect(bandOf("waiting_approval")).toBe(BAND.NEEDS_YOU);
    // A failed session is the other thing that wants a human; filing it under
    // idle is how a failure goes unnoticed for an hour.
    expect(bandOf("error")).toBe(BAND.NEEDS_YOU);
  });

  it("treats thinking and tool_running as one band so they cannot thrash", () => {
    // These alternate several times a second. If they banded differently the
    // row would jitter continuously.
    expect(bandOf("thinking")).toBe(BAND.WORKING);
    expect(bandOf("tool_running")).toBe(BAND.WORKING);
  });

  it("idle is idle", () => {
    expect(bandOf("idle")).toBe(BAND.IDLE);
  });

  it("a fleet takes the most urgent band of anything in it", () => {
    // The orchestrator sits idle while its children work — banding on the lead
    // alone would hide a child that is blocked on an approval.
    const fleet = group(mk("goal", { status: "idle" }), [
      mk("kid-1", { status: "idle" }),
      mk("kid-2", { status: "waiting_approval" }),
    ]);
    expect(bandOfGroup(fleet)).toBe(BAND.NEEDS_YOU);
  });
});

describe("recency", () => {
  it("orders by lastActivityAt, not createdAt — the original bug", () => {
    // Old session, driven all morning; new session, untouched since creation.
    const old = mk("old", {
      createdAt: "2026-01-01T00:00:00.000Z",
      lastActivityAt: "2026-06-01T12:00:00.000Z",
    });
    const fresh = mk("fresh", {
      createdAt: "2026-05-01T00:00:00.000Z",
      lastActivityAt: "2026-05-01T00:00:00.000Z",
    });
    expect([fresh, old].sort(compareByRecency).map((s) => s.id)).toEqual(["old", "fresh"]);
  });

  it("falls back to createdAt when the daemon never sends lastActivityAt", () => {
    // An older daemon must not sink every session to epoch 0 — that would be
    // worse than the behaviour being replaced.
    const s = mk("legacy", { createdAt: "2026-03-03T00:00:00.000Z" });
    expect(activityKey(s)).toBe(Date.parse("2026-03-03T00:00:00.000Z"));
  });

  it("survives an unparseable timestamp instead of producing NaN order", () => {
    expect(activityKey(mk("bad", { lastActivityAt: "not-a-date" }))).toBe(0);
  });

  it("a fleet is as recent as its busiest child", () => {
    const fleet = group(
      mk("goal", { lastActivityAt: "2026-01-01T00:00:00.000Z" }),
      [mk("kid", { lastActivityAt: "2026-09-09T00:00:00.000Z" })],
    );
    const solo = group(mk("solo", { lastActivityAt: "2026-05-05T00:00:00.000Z" }));
    const [section] = bandSections([solo, fleet]);
    expect(section!.groups.map((g) => g.lead.id)).toEqual(["goal", "solo"]);
  });
});

describe("bandSections", () => {
  it("orders bands NEEDS YOU → WORKING → IDLE and drops empty ones", () => {
    const sections = bandSections([
      group(mk("i", { status: "idle" })),
      group(mk("w", { status: "thinking" })),
      group(mk("n", { status: "waiting_approval" })),
    ]);
    expect(sections.map((s) => s.label)).toEqual(["Needs you", "Working", "Idle"]);
    expect(sections.map((s) => s.groups[0]!.lead.id)).toEqual(["n", "w", "i"]);

    // No empty headers when a band has nothing in it.
    expect(bandSections([group(mk("only", { status: "idle" }))]).map((s) => s.label)).toEqual([
      "Idle",
    ]);
  });

  it("is deterministic for same-millisecond sessions", () => {
    // A fan-out creates children within the same millisecond; without a
    // tie-break they would swap places on every re-render.
    const at = "2026-04-04T00:00:00.000Z";
    const a = group(mk("bbb", { lastActivityAt: at }));
    const b = group(mk("aaa", { lastActivityAt: at }));
    const once = bandSections([a, b]).flatMap((s) => s.groups.map((g) => g.lead.id));
    const twice = bandSections([b, a]).flatMap((s) => s.groups.map((g) => g.lead.id));
    expect(once).toEqual(twice);
  });
});

describe("holdOrder — does not reorder under the pointer", () => {
  it("keeps a row in place when its band changes mid-hover", () => {
    const idle = group(mk("a", { status: "idle", lastActivityAt: "2026-01-02T00:00:00.000Z" }));
    const other = group(mk("b", { status: "idle", lastActivityAt: "2026-01-01T00:00:00.000Z" }));
    const before = bandSections([idle, other]);
    const snap = snapshotOrder(before);
    expect(before.map((s) => s.label)).toEqual(["Idle"]);

    // 'b' starts asking for approval — normally it would jump to a new top band.
    const after = bandSections([
      idle,
      group(mk("b", { status: "waiting_approval", lastActivityAt: "2026-01-01T00:00:00.000Z" })),
    ]);
    expect(after.map((s) => s.label)).toEqual(["Needs you", "Idle"]);

    // Held: the layout the user is pointing at is unchanged.
    const held = holdOrder(after, snap);
    expect(held.map((s) => s.label)).toEqual(["Idle"]);
    expect(held[0]!.groups.map((g) => g.lead.id)).toEqual(["a", "b"]);
  });

  it("still shows new sessions and drops destroyed ones while holding", () => {
    // Order is frozen; MEMBERSHIP is not. Freezing membership would leave a
    // destroyed session clickable — a worse bug than the one being prevented.
    const a = group(mk("a", { status: "idle" }));
    const b = group(mk("b", { status: "idle" }));
    const snap = snapshotOrder(bandSections([a, b]));

    const c = group(mk("c", { status: "idle" }));
    const held = holdOrder(bandSections([a, c]), snap); // b destroyed, c appeared
    const ids = held.flatMap((s) => s.groups.map((g) => g.lead.id));
    expect(ids).toContain("a");
    expect(ids).toContain("c");
    expect(ids).not.toContain("b");
    // The newcomer appends rather than displacing the row being aimed at.
    expect(ids.indexOf("c")).toBeGreaterThan(ids.indexOf("a"));
  });

  it("is a no-op without a snapshot", () => {
    const live = bandSections([group(mk("a", { status: "waiting_approval" }))]);
    expect(holdOrder(live, null)).toEqual(live);
  });
});
