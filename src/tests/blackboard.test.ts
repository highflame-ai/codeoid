/**
 * Goal blackboard — store + role-scoped access
 * (docs/collaborative-session-design.md §4, §6).
 *
 * The properties under test, in priority order:
 *   1. TENANT ISOLATION — a goal id is not a permission. Two tenants can hold
 *      the same goal session id and must not see each other's artifacts.
 *   2. INDEPENDENCE — a reviewer reads `diff`+`spec` and cannot reach
 *      `research` or `findings`, not even a peer reviewer's. A panel whose
 *      members can read each other is an echo, not a panel.
 *   3. NO SILENT COLLAPSE — each reviewer writes its own slot, so reviewer #2
 *      cannot overwrite reviewer #1 and quietly reduce a panel to one voice.
 *   4. APPEND-ONLY — writes version, never overwrite, so a handoff's history
 *      survives.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Blackboard, DEFAULT_ROLE_IO, type RoleIdentity } from "../daemon/blackboard/service.js";
import { BlackboardStore, type GoalScope } from "../daemon/blackboard/store.js";
import {
  ARTIFACT_CONTENT_MAX,
  CORE_ARTIFACT_KINDS,
  isValidArtifactKind,
} from "../daemon/blackboard/types.js";
import { Store } from "../daemon/store.js";

let tmp: string;
let store: Store;
let bbStore: BlackboardStore;
let bb: Blackboard;

const GOAL: GoalScope = { accountId: "acc", projectId: "proj", goalSessionId: "goal-1" };
/** Same goal id, different tenant — the isolation probe. */
const OTHER_TENANT: GoalScope = { ...GOAL, accountId: "acc-2" };
/** Same tenant + account, different project — projects are a boundary too. */
const OTHER_PROJECT: GoalScope = { ...GOAL, projectId: "proj-2" };

const ident = (roleName: string, ordinal = 1): RoleIdentity => ({
  roleName,
  ordinal,
  authorSub: `agent:${roleName}${ordinal}`,
});

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "codeoid-bb-"));
  store = new Store(join(tmp, "codeoid.db"));
  bbStore = new BlackboardStore(store.database);
  bb = new Blackboard(bbStore);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// ── Kind vocabulary ─────────────────────────────────────────────────────────

describe("artifact kinds", () => {
  test("accepts every core kind", () => {
    for (const k of CORE_ARTIFACT_KINDS) expect(isValidArtifactKind(k)).toBe(true);
  });

  test("accepts a well-formed extra/<key>", () => {
    expect(isValidArtifactKind("extra/bench-results")).toBe(true);
    expect(isValidArtifactKind("extra/x")).toBe(true);
  });

  // Rejecting matters: a typo'd kind that became a fresh extra/ slot would look
  // like a successful handoff while the intended reader waits forever.
  test.each([
    "diffs",
    "Spec",
    "extra/",
    "extra/UPPER",
    "extra/has space",
    "extra/nested/key",
    "extra/-leading",
    "",
    "findings ",
  ])("rejects %p", (kind) => {
    expect(isValidArtifactKind(kind)).toBe(false);
  });
});

// ── Store: versioning + tenant isolation ────────────────────────────────────

describe("BlackboardStore", () => {
  test("appends versions instead of overwriting", () => {
    const a = bbStore.append({ scope: GOAL, kind: "spec", content: "v1", authorSub: "a", now: 1 });
    const b = bbStore.append({ scope: GOAL, kind: "spec", content: "v2", authorSub: "a", now: 2 });
    expect(a.version).toBe(1);
    expect(b.version).toBe(2);
    expect(bbStore.latest(GOAL, "spec")?.content).toBe("v2");
    // History intact — the point of append-only.
    expect(bbStore.version(GOAL, "spec", 1)?.content).toBe("v1");
  });

  test("versions independently per slot", () => {
    bbStore.append({ scope: GOAL, kind: "findings", slot: "review", content: "r1", authorSub: "a", now: 1 });
    bbStore.append({ scope: GOAL, kind: "findings", slot: "review#2", content: "r2", authorSub: "b", now: 2 });
    bbStore.append({ scope: GOAL, kind: "findings", slot: "review", content: "r1b", authorSub: "a", now: 3 });
    expect(bbStore.latest(GOAL, "findings", "review")?.content).toBe("r1b");
    expect(bbStore.latest(GOAL, "findings", "review#2")?.content).toBe("r2");
    const all = bbStore.latestAllSlots(GOAL, "findings");
    expect(all).toHaveLength(2);
    expect(all.map((a) => a.content).sort()).toEqual(["r1b", "r2"]);
  });

  test("a null slot is distinct from a named one", () => {
    bbStore.append({ scope: GOAL, kind: "spec", content: "singleton", authorSub: "a", now: 1 });
    bbStore.append({ scope: GOAL, kind: "spec", slot: "odd", content: "slotted", authorSub: "a", now: 2 });
    expect(bbStore.latest(GOAL, "spec")?.content).toBe("singleton");
    expect(bbStore.latest(GOAL, "spec", "odd")?.content).toBe("slotted");
  });

  // A goal id is not a permission. If it were, one leaked/colliding session id
  // would expose another account's artifacts.
  test("isolates tenants that share a goal session id", () => {
    bbStore.append({ scope: GOAL, kind: "spec", content: "ours", authorSub: "a", now: 1 });
    bbStore.append({ scope: OTHER_TENANT, kind: "spec", content: "theirs", authorSub: "z", now: 1 });

    expect(bbStore.latest(GOAL, "spec")?.content).toBe("ours");
    expect(bbStore.latest(OTHER_TENANT, "spec")?.content).toBe("theirs");
    expect(bbStore.index(GOAL)).toHaveLength(1);
    expect(bbStore.index(OTHER_TENANT)).toHaveLength(1);
    // Both start at version 1 — neither tenant's write advanced the other's.
    expect(bbStore.latest(GOAL, "spec")?.version).toBe(1);
    expect(bbStore.latest(OTHER_TENANT, "spec")?.version).toBe(1);
  });

  test("isolates projects within one account", () => {
    bbStore.append({ scope: GOAL, kind: "spec", content: "p1", authorSub: "a", now: 1 });
    expect(bbStore.latest(OTHER_PROJECT, "spec")).toBeNull();
  });

  test("deleteGoal removes only that tenant's goal", () => {
    bbStore.append({ scope: GOAL, kind: "spec", content: "ours", authorSub: "a", now: 1 });
    bbStore.append({ scope: OTHER_TENANT, kind: "spec", content: "theirs", authorSub: "z", now: 1 });
    expect(bbStore.deleteGoal(GOAL)).toBe(1);
    expect(bbStore.latest(GOAL, "spec")).toBeNull();
    expect(bbStore.latest(OTHER_TENANT, "spec")?.content).toBe("theirs");
  });

  test("the index reports version, author and size without bodies", () => {
    bbStore.append({ scope: GOAL, kind: "spec", content: "hello", authorSub: "a", authorRole: "orchestrator", now: 5 });
    bbStore.append({ scope: GOAL, kind: "spec", content: "hello there", authorSub: "a", authorRole: "orchestrator", now: 6 });
    const [entry] = bbStore.index(GOAL);
    expect(entry).toMatchObject({
      kind: "spec",
      slot: null,
      version: 2,
      authorSub: "a",
      authorRole: "orchestrator",
      bytes: "hello there".length,
    });
    // No `content` key at all — the orchestrator holds an index, not bodies.
    expect(entry as unknown as Record<string, unknown>).not.toHaveProperty("content");
  });

  test("index lists one row per (kind, slot) at its latest version", () => {
    bbStore.append({ scope: GOAL, kind: "findings", slot: "review", content: "a", authorSub: "a", now: 1 });
    bbStore.append({ scope: GOAL, kind: "findings", slot: "review#2", content: "b", authorSub: "b", now: 2 });
    bbStore.append({ scope: GOAL, kind: "diff", content: "d", authorSub: "c", now: 3 });
    const idx = bbStore.index(GOAL);
    expect(idx).toHaveLength(3);
    expect(idx.map((e) => `${e.kind}/${e.slot ?? "-"}`).sort()).toEqual([
      "diff/-",
      "findings/review",
      "findings/review#2",
    ]);
  });
});

// ── Service: role scoping ───────────────────────────────────────────────────

describe("role scoping is fail-closed", () => {
  test("an unprofiled role that declares nothing can do nothing", () => {
    const h = bb.forRole(GOAL, ident("mystery-role"));
    expect(h.reads).toEqual([]);
    expect(h.writes).toEqual([]);
    const r = h.read("spec");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/may not read "spec"/);
    const w = h.write("spec", "x");
    expect(w.ok).toBe(false);
    if (!w.ok) expect(w.error).toMatch(/may not write "spec"/);
  });

  test("an explicit empty declaration also grants nothing", () => {
    const h = bb.forRole(GOAL, ident("review"), { reads: [], writes: [] });
    // Declared-empty must NOT fall through to the default profile.
    expect(h.reads).toEqual([]);
    expect(h.read("diff").ok).toBe(false);
  });

  test("a declaration overrides the default profile", () => {
    const h = bb.forRole(GOAL, ident("review"), { reads: ["research"], writes: ["extra/notes"] });
    expect(h.read("research").ok).toBe(true);
    expect(h.read("diff").ok).toBe(false); // not declared, despite the profile
    expect(h.write("extra/notes", "n").ok).toBe(true);
    expect(h.write("findings", "f").ok).toBe(false);
  });

  test("an unknown kind is rejected even when scoping would allow it", () => {
    const h = bb.forRole(GOAL, ident("review"), { reads: ["diffs"], writes: ["findings"] });
    const r = h.read("diffs");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Unknown artifact kind/);
  });

  test("oversized content is refused rather than truncated", () => {
    const h = bb.forRole(GOAL, ident("search"));
    const w = h.write("research", "x".repeat(ARTIFACT_CONTENT_MAX + 1));
    expect(w.ok).toBe(false);
    if (!w.ok) expect(w.error).toMatch(/max \d+/);
  });
});

// This is the §6 guarantee, and the reason review's read set is exactly two
// kinds: a reviewer is unbiased BECAUSE it cannot see the author's reasoning or
// its peers' verdicts — not because a prompt asked it not to look.
describe("reviewer independence", () => {
  test("the default review profile reads diff + spec and nothing else", () => {
    expect(DEFAULT_ROLE_IO.review).toEqual({ reads: ["spec", "diff"], writes: ["findings"] });
  });

  test("a reviewer cannot read research (implementer reasoning by proxy)", () => {
    bb.forRole(GOAL, ident("search")).write("research", "how I approached it");
    const r = bb.forRole(GOAL, ident("review")).read("research");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/may not read "research"/);
  });

  test("a reviewer cannot read findings — not even a peer's", () => {
    const r1 = bb.forRole(GOAL, ident("review", 1));
    const r2 = bb.forRole(GOAL, ident("review", 2));
    expect(r1.write("findings", "looks fine").ok).toBe(true);
    expect(r2.read("findings").ok).toBe(false);
    expect(r2.readAll("findings").ok).toBe(false);
  });

  test("each reviewer writes its own slot, so a panel cannot collapse", () => {
    expect(bb.forRole(GOAL, ident("review", 1)).write("findings", "from one").ok).toBe(true);
    expect(bb.forRole(GOAL, ident("review", 2)).write("findings", "from two").ok).toBe(true);
    expect(bb.forRole(GOAL, ident("review", 3)).write("findings", "from three").ok).toBe(true);

    // Three distinct opinions survive, each at version 1 of its own slot.
    const all = bbStore.latestAllSlots(GOAL, "findings");
    expect(all).toHaveLength(3);
    expect(all.every((a) => a.version === 1)).toBe(true);
    expect(all.map((a) => a.content).sort()).toEqual(["from one", "from three", "from two"]);
    expect(all.map((a) => a.slot).sort()).toEqual(["review", "review#2", "review#3"]);
  });

  // A caller-supplied slot would hand one reviewer the ability to overwrite
  // another's findings, which is exactly what slots exist to prevent — so the
  // write API takes no slot at all.
  test("a reviewer has no way to name another reviewer's slot", () => {
    const h = bb.forRole(GOAL, ident("review", 2));
    expect(h.write.length).toBe(2); // (kind, content) — no slot parameter
  });

  test("the orchestrator can read every reviewer's findings for synthesis", () => {
    bb.forRole(GOAL, ident("review", 1)).write("findings", "one");
    bb.forRole(GOAL, ident("review", 2)).write("findings", "two");
    const all = bb.forRole(GOAL, ident("orchestrator")).readAll("findings");
    expect(all.ok).toBe(true);
    if (all.ok) expect(all.value.map((a) => a.content).sort()).toEqual(["one", "two"]);
  });
});

describe("the default profile wires the §3 handoff chain", () => {
  test("search → architecture → reasoning → review flows through artifacts", () => {
    const search = bb.forRole(GOAL, ident("search"));
    const arch = bb.forRole(GOAL, ident("architecture"));
    const reason = bb.forRole(GOAL, ident("reasoning"));
    const review = bb.forRole(GOAL, ident("review"));
    const orch = bb.forRole(GOAL, ident("orchestrator"));

    expect(orch.write("spec", "SPEC").ok).toBe(true);
    expect(search.read("spec").ok).toBe(true);
    expect(search.write("research", "RESEARCH").ok).toBe(true);

    expect(arch.read("research").ok).toBe(true);
    expect(arch.write("adr", "ADR").ok).toBe(true);

    expect(reason.read("adr").ok).toBe(true);
    // The reasoner never reads raw research — it works from the decided ADR.
    expect(reason.read("research").ok).toBe(false);
    expect(reason.write("diff", "DIFF").ok).toBe(true);

    expect(review.read("diff").ok).toBe(true);
    expect(review.write("findings", "FINDINGS").ok).toBe(true);

    // Nobody wrote outside their lane.
    expect(search.write("diff", "x").ok).toBe(false);
    expect(review.write("diff", "x").ok).toBe(false);
    expect(arch.write("diff", "x").ok).toBe(false);
  });

  test("every artifact is stamped with its producing identity and role", () => {
    bb.forRole(GOAL, ident("search")).write("research", "R");
    const a = bbStore.latest(GOAL, "research");
    expect(a?.authorSub).toBe("agent:search1");
    expect(a?.authorRole).toBe("search");
  });

  // Knowing a diff EXISTS is not reading it; the orchestrator needs the whole
  // picture to schedule, and the index carries no bodies.
  test("the index is visible regardless of read scope", () => {
    bb.forRole(GOAL, ident("search")).write("research", "R");
    const idx = bb.forRole(GOAL, ident("review")).index();
    expect(idx.map((e) => e.kind)).toContain("research");
    expect(bb.forRole(GOAL, ident("review")).read("research").ok).toBe(false);
  });
});
