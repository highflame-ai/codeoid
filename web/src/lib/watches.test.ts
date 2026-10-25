import { describe, expect, it } from "vitest";

import { loopRun, trigger, watch } from "./automation.fixtures";
import {
  buildTrustHead,
  buildWatchCreate,
  checkLogin,
  ciMappingText,
  emptyCiRow,
  emptyWatchForm,
  knownHeads,
  parseLogins,
  parseMovedHead,
  runsStartedBy,
  trustDiff,
  watchHealth,
  type WatchForm,
} from "./watches";

describe("a watch's health", () => {
  it("tells polling, problems, back-off, pause and self-pause apart", () => {
    expect(watchHealth(watch()).kind).toBe("ok");
    expect(watchHealth(watch({ lastPolledAt: null })).kind).toBe("pending");
    expect(watchHealth(watch({ lastError: "reading main's head: HTTP 404 (GET /repos/acme/shop/branches/main)" })).kind).toBe("problem");
    expect(watchHealth(watch({ lastError: "listing check runs: GitHub API rate limit exceeded" })).kind).toBe("backoff");
    expect(watchHealth(watch({ enabled: false })).kind).toBe("paused");
    expect(
      watchHealth(watch({ enabled: false, lastError: "gh is now signed in as @other, but this watch acts as @me, so it paused itself; …" })).kind,
    ).toBe("self_paused");
  });

  it("counts the runs it started among the listed ones", () => {
    const runs = [loopRun({ id: "a", trigger: { kind: "ci_failure", key: "k", watchId: "w_1", summary: "" } }), loopRun({ id: "b" })];
    expect(runsStartedBy("w_1", runs).map((r) => r.id)).toEqual(["a"]);
  });

  it("writes a CI mapping the way the CLI takes it", () => {
    expect(ciMappingText({ ciName: "test (*)", app: "github-actions", command: "bun test" })).toEqual({ check: "test (*)", command: "bun test" });
    expect(ciMappingText({ ciName: "lint", app: "circleci-checks", command: "bun run lint" }).check).toBe("lint@circleci-checks");
  });
});

describe("the trust list", () => {
  it("refuses the logins GitHub acts as for everyone, and checks the rest", () => {
    expect(checkLogin("web-flow", { bots: true })).toHaveProperty("error");
    expect(checkLogin("GitHub-Actions[bot]", { bots: true })).toHaveProperty("error");
    expect(checkLogin("github-merge-queue[bot]", { bots: true })).toHaveProperty("error");
    expect(checkLogin("dependabot[bot]", { bots: true })).toEqual({ login: "dependabot[bot]" });
    expect(checkLogin("dependabot[bot]", { bots: false })).toHaveProperty("error");
    expect(checkLogin("@octo-cat", { bots: false })).toEqual({ login: "octo-cat" });
    expect(checkLogin("-bad", { bots: false })).toHaveProperty("error");
    expect(checkLogin("a--b", { bots: false })).toHaveProperty("error");
  });

  it("parses a list, dropping duplicates and holding the ceiling", () => {
    expect(parseLogins("alice, Alice bob", { bots: true, max: 20, what: "x" })).toEqual({ logins: ["alice", "bob"] });
    expect(parseLogins(Array.from({ length: 21 }, (_, i) => `u${i}`).join(","), { bots: true, max: 20, what: "trusted logins" })).toEqual({
      error: "At most 20 trusted logins",
    });
  });

  it("explains that widening keeps remembered heads and narrowing forgets them", () => {
    const widen = trustDiff(["alice"], ["alice", "bob"]);
    expect(widen).toMatchObject({ added: ["bob"], removed: [], forgets: false });
    expect(widen.explanation).toMatch(/are kept/);

    const narrow = trustDiff(["alice", "bob"], ["bob"]);
    expect(narrow).toMatchObject({ added: [], removed: ["alice"], forgets: true });
    expect(narrow.explanation).toMatch(/forgets every head it judged trusted and every head you vouched for/);

    // Swapping someone out drops them: it narrows, even though it also adds.
    expect(trustDiff(["alice"], ["bob"]).forgets).toBe(true);
    // Case doesn't make a login someone else.
    expect(trustDiff(["Alice"], ["alice"])).toMatchObject({ added: [], removed: [], forgets: false, explanation: "No change." });
    expect(trustDiff(["alice"], []).forgets).toBe(true);
  });
});

describe("vouching", () => {
  it("reads the newest head each branch's history names", () => {
    const heads = knownHeads([
      trigger({ key: "untrusted:w_1:aaaaaaaaaaaaaaaa:" + ":main", kind: "head", outcome: "ignored", createdAt: "2026-10-26T11:30:00.000Z" }),
      trigger({ key: "ci:acme/shop:bbbbbbbbbbbbbbbb:9:1", createdAt: "2026-10-26T10:00:00.000Z" }),
      trigger({ key: "vouch:w_1:acme/shop:release:cccccccccccccccc", kind: "trust_anchor", branch: "release", outcome: "vouched" }),
      // A fork's head is not the branch's head in the watched repository.
      trigger({ key: "untrusted:w_1:dddddddddddddddd:someone/shop:feature", kind: "head", branch: "feature", outcome: "ignored" }),
      trigger({ key: "review:acme/shop:issue:42", kind: "review_comment", branch: "feature" }),
    ]);
    expect(heads.main).toMatchObject({ sha: "aaaaaaaaaaaaaaaa", source: "untrusted head" });
    expect(heads.release).toMatchObject({ sha: "cccccccccccccccc", source: "your last vouch" });
    expect(heads.feature).toBeUndefined();
  });

  it("reads a moved head out of the daemon's compare-and-set refusal", () => {
    expect(
      parseMovedHead("main's head is 0123456789ab now, not fedcba987654: it moved, so nothing was vouched for; look at it again"),
    ).toEqual({ branch: "main", now: "0123456789ab", pinned: "fedcba987654" });
    expect(parseMovedHead("Missing scope: session:approve")).toBeNull();
  });

  it("pins each chosen branch to its commit, or vouches for every head as read", () => {
    const picks = [
      { branch: "main", on: true, sha: "0123456789AB" },
      { branch: "release", on: false, sha: "" },
    ];
    expect(buildTrustHead(true, picks)).toEqual({ trustHead: { main: "0123456789ab" } });
    expect(buildTrustHead(true, [{ branch: "main", on: true, sha: "abc" }])).toHaveProperty("error");
    expect(buildTrustHead(false, picks)).toHaveProperty("error");
    expect(buildTrustHead(false, picks.map((p) => ({ ...p, on: true })))).toEqual({ trustHead: true });
    expect(buildTrustHead(true, picks.map((p) => ({ ...p, on: false })))).toEqual({ error: "Choose at least one branch to vouch for" });
  });
});

describe("the create form", () => {
  const form = (over: Partial<WatchForm> = {}): WatchForm => ({
    ...emptyWatchForm(),
    workdir: "/src/shop",
    ci: [{ ...emptyCiRow(), ciName: "test (*)", command: "bun test", expectTests: true }],
    ...over,
  });

  it("builds a my-PRs watch with review and trust", () => {
    expect(buildWatchCreate(form({ review: true, allow: "alice", trust: "dependabot[bot]", maxRunsPerHour: "3" }))).toEqual({
      msg: {
        type: "loop.watch.create",
        spec: {
          workdir: "/src/shop",
          myPrs: true,
          ci: [{ ciName: "test (*)", command: "bun test", expectTests: true }],
          review: { enabled: true, allow: ["alice"] },
          trust: ["dependabot[bot]"],
          maxRunsPerHour: 3,
        },
      },
    });
  });

  it("builds a branch watch, vouching only when asked", () => {
    const b = buildWatchCreate(form({ target: "branches", branches: "main, release main", trustHead: true }));
    expect(b).toMatchObject({ msg: { spec: { branches: ["main", "release"] }, trustHead: true } });
    expect(buildWatchCreate(form({ target: "branches", branches: "main" }))).not.toHaveProperty("msg.trustHead");
    // A my-PRs watch has no branch heads to vouch for.
    expect(buildWatchCreate(form({ trustHead: true }))).not.toHaveProperty("msg.trustHead");
  });

  it("keeps a non-default app and drops the default", () => {
    const b = buildWatchCreate(form({ ci: [{ ...emptyCiRow(), ciName: "lint", app: "CircleCI-Checks", command: "bun run lint" }, { ...emptyCiRow(), ciName: "t", app: "github-actions", command: "x" }] }));
    expect(b).toMatchObject({ msg: { spec: { ci: [{ ciName: "lint", app: "circleci-checks" }, { ciName: "t" }] } } });
    expect("msg" in b && "app" in b.msg.spec.ci[1]!).toBe(false);
  });

  it("names the field that is wrong", () => {
    expect(buildWatchCreate(form({ workdir: "" }))).toMatchObject({ field: "workdir" });
    expect(buildWatchCreate(form({ target: "branches", branches: "" }))).toMatchObject({ field: "branches" });
    expect(buildWatchCreate(form({ target: "branches", branches: "a:b" }))).toMatchObject({ field: "branches" });
    expect(buildWatchCreate(form({ ci: [emptyCiRow()] }))).toMatchObject({ field: "ci" });
    expect(buildWatchCreate(form({ ci: [{ ...emptyCiRow(), ciName: "t" }] }))).toEqual({ error: "Mapping 1 has no local command", field: "ci" });
    expect(buildWatchCreate(form({ ci: [{ ...emptyCiRow(), ciName: "t", command: "x", app: "bad app" }] }))).toMatchObject({ field: "ci" });
    expect(buildWatchCreate(form({ trust: "web-flow" }))).toMatchObject({ field: "trust" });
    expect(buildWatchCreate(form({ review: true, allow: "renovate[bot]" }))).toMatchObject({ field: "allow" });
    expect(buildWatchCreate(form({ maxRunsPerHour: "61" }))).toMatchObject({ field: "maxRunsPerHour" });
  });
});
