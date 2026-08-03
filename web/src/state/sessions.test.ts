import { describe, it, expect, beforeEach } from "vitest";
import {
  _resetSessionsForTest,
  focusedSession,
  focusedSessionId,
  focusNext,
  focusPrev,
  focusSession,
  getSession,
  ingestSessionList,
  mergeSession,
  removeSession,
  sessionList,
  setSessionStatus,
} from "./sessions";
import { _resetDraftsForTest, getDraft, setDraft } from "./prompt-drafts";
import type { SessionInfo } from "../protocol/types";

function s(id: string, createdAt: string, overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id,
    name: id,
    workdir: "/tmp",
    status: "idle",
    createdBy: "you",
    createdAt,
    attachedClients: 0,
    ...overrides,
  };
}

describe("sessions store", () => {
  beforeEach(() => {
    _resetSessionsForTest();
    _resetDraftsForTest();
  });

  it("ingestSessionList prunes per-session state (draft) of a removed session", () => {
    // Regression: a remote removal (session dropped from the authoritative list)
    // used to delete only byId, leaking the message buffer / resume cursor / draft.
    ingestSessionList([s("a", "2026-05-01T08:00:00Z"), s("b", "2026-05-02T08:00:00Z")]);
    setDraft("b", "half-typed message");
    expect(getDraft("b")).toBe("half-typed message");
    ingestSessionList([s("a", "2026-05-01T08:00:00Z")]); // "b" gone
    expect(getDraft("b")).toBe("");
  });

  it("ingests a list and sorts newest-first", () => {
    ingestSessionList([
      s("a", "2026-05-01T08:00:00Z"),
      s("b", "2026-05-04T08:00:00Z"),
      s("c", "2026-05-02T08:00:00Z"),
    ]);
    expect(sessionList().map((x) => x.id)).toEqual(["b", "c", "a"]);
  });

  it("auto-focuses the most recent on first ingest", () => {
    ingestSessionList([
      s("a", "2026-05-01T08:00:00Z"),
      s("b", "2026-05-04T08:00:00Z"),
    ]);
    expect(focusedSessionId()).toBe("b");
    expect(focusedSession()?.id).toBe("b");
  });

  it("preserves explicit focus across ingest if focused id still exists", () => {
    ingestSessionList([s("a", "2026-05-01T08:00:00Z")]);
    focusSession("a");
    ingestSessionList([
      s("a", "2026-05-01T08:00:00Z"),
      s("b", "2026-05-04T08:00:00Z"),
    ]);
    expect(focusedSessionId()).toBe("a");
  });

  it("re-focuses on the most recent if focused id disappears", () => {
    ingestSessionList([s("a", "2026-05-01T08:00:00Z")]);
    focusSession("a");
    ingestSessionList([s("b", "2026-05-04T08:00:00Z")]);
    expect(focusedSessionId()).toBe("b");
  });

  it("merges partial updates without dropping fields", () => {
    ingestSessionList([s("a", "2026-05-01T08:00:00Z", { name: "alpha" })]);
    mergeSession({ id: "a", model: "claude-opus-4-7" });
    expect(getSession("a")?.name).toBe("alpha");
    expect(getSession("a")?.model).toBe("claude-opus-4-7");
  });

  it("mergeSession upserts a session it hasn't seen yet (info_update from another client)", () => {
    // Regression: produce() never runs on an undefined leaf, so the old
    // "materialises lazily" path silently dropped info_update for an unknown id.
    mergeSession(s("remote-1", "2026-05-02T08:00:00Z", { name: "remote" }));
    expect(getSession("remote-1")?.name).toBe("remote");
  });

  it("setSessionStatus is a noop for unknown sessions", () => {
    setSessionStatus("ghost", "thinking");
    expect(getSession("ghost")).toBeUndefined();
  });

  it("setSessionStatus updates only the status field", () => {
    ingestSessionList([s("a", "2026-05-01T08:00:00Z")]);
    setSessionStatus("a", "tool_running");
    expect(getSession("a")?.status).toBe("tool_running");
    expect(getSession("a")?.workdir).toBe("/tmp");
  });

  it("mergeSession ignores prototype-polluting keys from a network payload", () => {
    ingestSessionList([s("a", "2026-05-01T08:00:00Z")]);
    const evil = JSON.parse(
      '{"id":"a","name":"renamed","__proto__":{"polluted":true}}',
    ) as Partial<SessionInfo> & { id: string };
    mergeSession(evil);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(getSession("a")?.name).toBe("renamed"); // legit fields still merge
    // Upsert path (unknown id) is guarded too.
    const evilNew = JSON.parse(
      '{"id":"b","name":"b","workdir":"/tmp","status":"idle","createdBy":"you","createdAt":"2026-05-02T08:00:00Z","attachedClients":0,"__proto__":{"polluted2":true}}',
    ) as SessionInfo;
    mergeSession(evilNew);
    expect(({} as Record<string, unknown>).polluted2).toBeUndefined();
    expect(getSession("b")?.name).toBe("b");
  });

  it("ingestSessionList keeps a live status_change that's newer than the list snapshot", () => {
    ingestSessionList([s("a", "2026-05-01T08:00:00Z", { status: "thinking" })]);
    const requestedAt = Date.now() - 1000; // list was requested a second ago
    setSessionStatus("a", "idle"); // a live idle lands "now" (after the request)
    // A stale snapshot still saying "thinking" must NOT clobber the live idle.
    ingestSessionList([s("a", "2026-05-01T08:00:00Z", { status: "thinking" })], requestedAt);
    expect(getSession("a")?.status).toBe("idle");
    // With no `since` (non-reconnect ingest) the snapshot still applies normally.
    ingestSessionList([s("a", "2026-05-01T08:00:00Z", { status: "thinking" })]);
    expect(getSession("a")?.status).toBe("thinking");
  });

  it("removeSession refocuses the next remaining session", () => {
    ingestSessionList([
      s("a", "2026-05-01T08:00:00Z"),
      s("b", "2026-05-04T08:00:00Z"),
    ]);
    focusSession("b");
    removeSession("b");
    expect(getSession("b")).toBeUndefined();
    expect(focusedSessionId()).toBe("a");
  });

  it("ingestSessionList merges per-id: unchanged sessions keep their store object identity", () => {
    ingestSessionList([
      s("a", "2026-05-01T08:00:00Z", { name: "alpha" }),
      s("b", "2026-05-02T08:00:00Z"),
    ]);
    const before = getSession("a");
    // Fresh payload objects, same field values for "a", changed status for "b".
    ingestSessionList([
      s("a", "2026-05-01T08:00:00Z", { name: "alpha" }),
      s("b", "2026-05-02T08:00:00Z", { status: "thinking" }),
    ]);
    expect(getSession("a")).toBe(before!);
    expect(getSession("a")?.name).toBe("alpha");
    expect(getSession("b")?.status).toBe("thinking");
  });

  it("ingestSessionList updates changed fields, adds new sessions, deletes missing ones", () => {
    ingestSessionList([
      s("a", "2026-05-01T08:00:00Z", { name: "old-name" }),
      s("gone", "2026-05-02T08:00:00Z"),
    ]);
    const before = getSession("a");
    ingestSessionList([
      s("a", "2026-05-01T08:00:00Z", { name: "new-name" }),
      s("fresh", "2026-05-03T08:00:00Z"),
    ]);
    // Updated in place — identity preserved even when a field changed.
    expect(getSession("a")).toBe(before!);
    expect(getSession("a")?.name).toBe("new-name");
    expect(getSession("gone")).toBeUndefined();
    expect(getSession("fresh")?.id).toBe("fresh");
    expect(sessionList().map((x) => x.id)).toEqual(["fresh", "a"]);
  });

  it("ingestSessionList drops fields the daemon no longer sends", () => {
    ingestSessionList([s("a", "2026-05-01T08:00:00Z", { model: "claude-opus-4-7" })]);
    expect(getSession("a")?.model).toBe("claude-opus-4-7");
    ingestSessionList([s("a", "2026-05-01T08:00:00Z")]);
    expect(getSession("a")?.model).toBeUndefined();
  });

  it("ingestSessionList ignores prototype-polluting keys in network payloads", () => {
    ingestSessionList([s("a", "2026-05-01T08:00:00Z")]);
    // JSON.parse yields "__proto__" as a plain own property (unlike an
    // object literal); the merge loop must not assign it through.
    const evil = JSON.parse(
      '{"id":"a","name":"renamed","workdir":"/tmp","status":"idle","createdBy":"you","createdAt":"2026-05-01T08:00:00Z","attachedClients":0,"__proto__":{"polluted":true}}',
    ) as SessionInfo;
    ingestSessionList([evil]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(getSession("a")!)).toBe(Object.prototype);
    expect(getSession("a")?.name).toBe("renamed"); // legitimate fields still merge
  });

  it("ingestSessionList keeps object-field identity when deep-equal", () => {
    // Every list refresh delivers fresh array/object references; when the
    // contents are unchanged the merge must not reassign the field (which
    // would notify its subscribers on every poll for nothing).
    ingestSessionList([
      s("a", "2026-05-01T08:00:00Z", { pinnedFiles: ["x.ts", "y.ts"] }),
    ]);
    const before = getSession("a")?.pinnedFiles;
    ingestSessionList([
      s("a", "2026-05-01T08:00:00Z", { pinnedFiles: ["x.ts", "y.ts"] }),
    ]);
    expect(getSession("a")?.pinnedFiles).toBe(before); // same reference
    // A real change still lands.
    ingestSessionList([
      s("a", "2026-05-01T08:00:00Z", { pinnedFiles: ["x.ts"] }),
    ]);
    expect(getSession("a")?.pinnedFiles).toEqual(["x.ts"]);
  });

  it("focusNext / focusPrev wrap around the sorted list", () => {
    ingestSessionList([
      s("a", "2026-05-01T08:00:00Z"),
      s("b", "2026-05-02T08:00:00Z"),
      s("c", "2026-05-03T08:00:00Z"),
    ]);
    // sorted newest-first → c, b, a
    focusSession("c");
    focusNext();
    expect(focusedSessionId()).toBe("b");
    focusNext();
    expect(focusedSessionId()).toBe("a");
    focusNext();
    expect(focusedSessionId()).toBe("c");
    focusPrev();
    expect(focusedSessionId()).toBe("a");
  });
});

describe("removeSession — collaboration cascade", () => {
  /**
   * Destroying a collaboration goal tears its role-children down on the daemon
   * too (they have per-goal lifetime). The store used to drop only the goal, so
   * the sidebar kept listing children whose sessions no longer existed —
   * clicking one attached to nothing, and the ghosts survived until a refresh.
   */
  const child = (id: string, parentSessionId: string, createdAt: string) =>
    s(id, createdAt, {
      collaborationRole: { parentSessionId, roleName: "review", ordinal: 1, write: false },
    } as Partial<SessionInfo>);

  beforeEach(() => {
    _resetSessionsForTest();
    _resetDraftsForTest();
  });

  it("removes a goal's role-children along with the goal", () => {
    ingestSessionList([
      s("goal", "2026-01-01T00:00:00Z"),
      child("kid-1", "goal", "2026-01-01T00:00:01Z"),
      child("kid-2", "goal", "2026-01-01T00:00:02Z"),
      s("unrelated", "2026-01-01T00:00:03Z"),
    ]);

    removeSession("goal");

    expect(sessionList().map((x) => x.id)).toEqual(["unrelated"]);
  });

  it("leaves siblings alone when a single child is destroyed", () => {
    ingestSessionList([
      s("goal", "2026-01-01T00:00:00Z"),
      child("kid-1", "goal", "2026-01-01T00:00:01Z"),
      child("kid-2", "goal", "2026-01-01T00:00:02Z"),
    ]);

    // Children are individually destroyable; that must not take the goal or the
    // sibling with it.
    removeSession("kid-1");

    expect(sessionList().map((x) => x.id).sort()).toEqual(["goal", "kid-2"]);
  });

  it("refocuses off a child that went with its goal", () => {
    ingestSessionList([
      s("goal", "2026-01-01T00:00:00Z"),
      child("kid-1", "goal", "2026-01-01T00:00:01Z"),
      s("other", "2026-01-01T00:00:02Z"),
    ]);
    focusSession("kid-1");

    removeSession("goal");

    // Focus must not be left pointing at a session that no longer exists.
    expect(focusedSessionId()).toBe("other");
  });
});
