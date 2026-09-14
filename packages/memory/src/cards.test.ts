import { describe, test, expect } from "bun:test";
import { SessionCardStore } from "./cards";

function freshStore(): SessionCardStore {
  return new SessionCardStore(":memory:");
}

describe("SessionCardStore — cards", () => {
  test("upsert + get round-trips all fields", () => {
    const s = freshStore();
    s.upsertCard({
      sessionId: "sess-1",
      workspaceId: "ws-a",
      repo: "highflame-authz",
      branch: "fix/latest-only",
      task: "fix the latest_only tenant-scope bug",
      state: "WIP",
      lastAction: "wrote shared latestVersionIDs helper",
      openThreads: ["add regression test"],
      entities: ["studio#870", "latest_only"],
      createdAt: 1000,
      updatedAt: 1000,
    });

    const c = s.getCard("sess-1")!;
    expect(c.repo).toBe("highflame-authz");
    expect(c.branch).toBe("fix/latest-only");
    expect(c.state).toBe("WIP");
    expect(c.openThreads).toEqual(["add regression test"]);
    expect(c.entities).toEqual(["studio#870", "latest_only"]);
    expect(c.createdAt).toBe(1000);
    s.close();
  });

  test("upsert preserves createdAt but advances updatedAt", () => {
    const s = freshStore();
    s.upsertCard({ sessionId: "s", workspaceId: "w", openThreads: [], entities: [], createdAt: 100, updatedAt: 100 });
    s.upsertCard({ sessionId: "s", workspaceId: "w", state: "merged", openThreads: [], entities: [], updatedAt: 200 });
    const c = s.getCard("s")!;
    expect(c.createdAt).toBe(100);
    expect(c.updatedAt).toBe(200);
    expect(c.state).toBe("merged");
    s.close();
  });

  test("FTS finds a card by an exact identifier and by a fuzzy term", () => {
    const s = freshStore();
    s.upsertCard({
      sessionId: "sess-870",
      workspaceId: "ws-a",
      repo: "highflame-studio",
      task: "latest_only tenant scope regression",
      openThreads: [],
      entities: ["studio#870"],
      updatedAt: 1,
    });
    s.upsertCard({
      sessionId: "sess-durga",
      workspaceId: "ws-b",
      repo: "durga",
      task: "extraction eval field accuracy",
      openThreads: [],
      entities: [],
      updatedAt: 2,
    });

    const byId = s.ftsSearchCards("studio#870");
    expect(byId[0]?.sessionId).toBe("sess-870");

    const byFuzzy = s.ftsSearchCards("extraction eval");
    expect(byFuzzy[0]?.sessionId).toBe("sess-durga");
    s.close();
  });

  test("listCards orders by updatedAt desc and scopes by workspace", () => {
    const s = freshStore();
    s.upsertCard({ sessionId: "a", workspaceId: "w1", openThreads: [], entities: [], updatedAt: 10 });
    s.upsertCard({ sessionId: "b", workspaceId: "w1", openThreads: [], entities: [], updatedAt: 30 });
    s.upsertCard({ sessionId: "c", workspaceId: "w2", openThreads: [], entities: [], updatedAt: 20 });

    expect(s.listCards().map((c) => c.sessionId)).toEqual(["b", "c", "a"]);
    expect(s.listCards(50, "w1").map((c) => c.sessionId)).toEqual(["b", "a"]);
    s.close();
  });
});

describe("SessionCardStore — bi-temporal facts", () => {
  test("assertFact supersedes: invalidate-don't-delete", () => {
    const s = freshStore();
    const subject = "session:sess-1";

    s.assertFact({ sessionId: "sess-1", subject, predicate: "status", object: "WIP", validAt: 100, now: 100 });
    s.assertFact({ sessionId: "sess-1", subject, predicate: "status", object: "merged", validAt: 200, now: 210 });

    // Current belief = merged, single open fact.
    const cur = s.currentFacts(subject);
    expect(cur).toHaveLength(1);
    expect(cur[0]!.object).toBe("merged");

    // Nothing deleted — both versions still on disk.
    const all = s.factsForSession("sess-1");
    expect(all).toHaveLength(2);
    const wip = all.find((f) => f.object === "WIP")!;
    expect(wip.invalidAt).toBe(200); // closed at the new fact's validAt (event time)
    expect(wip.expiredAt).toBe(210); // superseded at now (system time)
    s.close();
  });

  test("factsAsOf time-travels to the right version", () => {
    const s = freshStore();
    const subject = "session:sess-1";
    s.assertFact({ sessionId: "sess-1", subject, predicate: "status", object: "WIP", validAt: 100, now: 100 });
    s.assertFact({ sessionId: "sess-1", subject, predicate: "status", object: "merged", validAt: 200, now: 200 });

    expect(s.factsAsOf(subject, 150).map((f) => f.object)).toEqual(["WIP"]);
    expect(s.factsAsOf(subject, 250).map((f) => f.object)).toEqual(["merged"]);
    expect(s.factsAsOf(subject, 50)).toHaveLength(0); // before anything was true
    s.close();
  });

  test("re-asserting the same object is a no-op (no churn)", () => {
    const s = freshStore();
    const subject = "session:sess-1";
    const a = s.assertFact({ sessionId: "sess-1", subject, predicate: "status", object: "WIP", validAt: 100, now: 100 });
    const b = s.assertFact({ sessionId: "sess-1", subject, predicate: "status", object: "WIP", validAt: 150, now: 150 });
    expect(b.id).toBe(a.id);
    expect(s.factsForSession("sess-1")).toHaveLength(1);
    s.close();
  });

  test("distinct predicates coexist as open facts", () => {
    const s = freshStore();
    const subject = "session:sess-1";
    s.assertFact({ sessionId: "sess-1", subject, predicate: "status", object: "WIP", now: 1 });
    s.assertFact({ sessionId: "sess-1", subject, predicate: "branch", object: "fix/x", now: 1 });
    expect(s.currentFacts(subject)).toHaveLength(2);
    s.close();
  });

  test("out-of-order validAt is rejected — never corrupts the open fact", () => {
    const s = freshStore();
    const subject = "session:sess-1";
    s.assertFact({ sessionId: "sess-1", subject, predicate: "status", object: "merged", validAt: 200, now: 200 });

    // Closing the open fact at validAt=100 would set invalid_at < valid_at,
    // making it unsatisfiable for every factsAsOf() — reject instead.
    expect(() =>
      s.assertFact({ sessionId: "sess-1", subject, predicate: "status", object: "WIP", validAt: 100, now: 300 }),
    ).toThrow(/out-of-order validAt/);

    // The open fact survived untouched, both live and in time-travel reads.
    expect(s.currentFacts(subject).map((f) => f.object)).toEqual(["merged"]);
    expect(s.factsAsOf(subject, 250).map((f) => f.object)).toEqual(["merged"]);
    s.close();
  });
});
