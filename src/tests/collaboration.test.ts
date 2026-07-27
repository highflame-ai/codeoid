/**
 * Collaborative session config — P1a (docs/collaborative-session-design.md §9).
 *
 * Three layers, deliberately separated:
 *   1. `validateCollaboration` — the semantic rules, unit-tested against a
 *      stub provider lookup.
 *   2. `parseRoleSpec` — the CLI `--role name:provider[:model][*count]` grammar.
 *   3. The real `SessionManager.handle()` create path, driven with a genuine
 *      multi-backend `ProviderRegistry` (NOT `_testProviderFactory`, which
 *      injects one mock into every session and would hide whether the config
 *      actually survives create → SessionInfo → persistence).
 *
 * The rule these guard: a collaboration naming a backend this daemon doesn't
 * have must FAIL, never silently collapse onto the default. A "multi-model"
 * session that is secretly single-model is the failure mode worth catching.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodeoidConfig } from "../config.js";
import {
  orchestratorRole,
  parseRoleSpec,
  planChildren,
  validateCollaboration,
  type ProviderLookup,
} from "../daemon/collaboration.js";
import { MockSessionProvider, mockResult } from "../daemon/providers/mock/session-provider.js";
import { ProviderRegistry } from "../daemon/providers/registry.js";
import type { ProviderEvent } from "../daemon/providers/interface.js";
import { Blackboard } from "../daemon/blackboard/service.js";
import { BlackboardStore } from "../daemon/blackboard/store.js";
import { parseClientMessage } from "@codeoid/protocol/schemas";
import { SessionManager } from "../daemon/session-manager.js";
import { Store } from "../daemon/store.js";
import { TranscriptStore } from "../daemon/transcript.js";
import { roleDeniesTool } from "../daemon/providers/tool-safety.js";
import { ALL_SCOPES } from "../protocol/scopes.js";
import { LIMITS } from "../protocol/types.js";
import type {
  AuthContext,
  ClientMessage,
  CollaborationConfig,
  DaemonMessage,
  SessionInfo,
} from "../protocol/types.js";

// ── 1. validateCollaboration ────────────────────────────────────────────────

/** Stub registry: claude + two other backends. */
const LOOKUP: ProviderLookup = {
  has: (id) => ["claude", "gemini", "openai"].includes(id),
  ids: () => ["claude", "gemini", "openai"],
};

const ok = (goal: string, roles: CollaborationConfig["roles"]) =>
  validateCollaboration({ goal, roles }, LOOKUP);

describe("validateCollaboration", () => {
  test("accepts a well-formed collaboration and normalizes it", () => {
    const r = ok("  Ship rate limiting  ", [
      { name: " orchestrator ", providerId: "claude" },
      { name: "review", providerId: "gemini", count: 3 },
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.config.goal).toBe("Ship rate limiting"); // trimmed
    expect(r.config.roles[0]!.name).toBe("orchestrator"); // trimmed
    expect(r.config.roles[0]!.count).toBe(1); // defaulted
    expect(r.config.roles[1]!.count).toBe(3); // preserved
  });

  test("rejects an empty goal", () => {
    const r = ok("   ", [{ name: "orchestrator", providerId: "claude" }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/goal must not be empty/);
  });

  test("rejects an unregistered provider and names the available ones", () => {
    const r = ok("g", [
      { name: "orchestrator", providerId: "claude" },
      { name: "review", providerId: "ollama" },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/Unknown provider "ollama"/);
      expect(r.error).toMatch(/claude, gemini, openai/);
    }
  });

  test("requires an orchestrator", () => {
    const r = ok("g", [{ name: "review", providerId: "gemini" }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/needs exactly one "orchestrator" role — got none/);
  });

  test("rejects duplicate role names case-insensitively", () => {
    const r = ok("g", [
      { name: "orchestrator", providerId: "claude" },
      { name: "Review", providerId: "gemini" },
      { name: "review", providerId: "openai" },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Duplicate collaboration role "review"/);
  });

  // v1 constraint: only the claude backend mounts the fleet MCP server.
  test("rejects a non-claude orchestrator and points at #245", () => {
    const r = ok("g", [{ name: "orchestrator", providerId: "gemini" }]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/must run on "claude" in v1/);
      expect(r.error).toMatch(/#245/);
    }
  });

  test("rejects an orchestrator that tries to fan out", () => {
    const r = ok("g", [{ name: "orchestrator", providerId: "claude", count: 2 }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/cannot fan out/);
  });

  // Reuses P0's provider-aware resolver: a Claude alias is meaningless on a
  // non-Claude backend, and catching it here beats failing on the first turn.
  test("rejects a claude model on a non-claude role", () => {
    const r = ok("g", [
      { name: "orchestrator", providerId: "claude" },
      { name: "review", providerId: "gemini", model: "opus" },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Model "opus" is not valid for provider "gemini"/);
  });

  test("passes a provider-native model through, and resolves claude aliases", () => {
    const r = ok("g", [
      { name: "orchestrator", providerId: "claude", model: "sonnet" },
      { name: "reasoning", providerId: "openai", model: "gpt-5-codex" },
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.config.roles[0]!.model).toMatch(/^claude-sonnet-/); // alias resolved
    expect(r.config.roles[1]!.model).toBe("gpt-5-codex"); // untouched
  });

  test("an empty-string model is treated as absent, not as an error", () => {
    const r = ok("g", [{ name: "orchestrator", providerId: "claude", model: "  " }]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config.roles[0]!.model).toBeUndefined();
  });

  // Stored lowercase so a downstream exact-match lookup can't miss a role
  // that validated case-insensitively.
  test("role names are normalized to lowercase", () => {
    const r = ok("g", [
      { name: "ORCHESTRATOR", providerId: "claude" },
      { name: "Review", providerId: "gemini" },
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.config.roles.map((x) => x.name)).toEqual(["orchestrator", "review"]);
    expect(orchestratorRole(r.config)?.providerId).toBe("claude");
  });

  // The published LIMITS are enforced here too, not only in the wire schema:
  // embedded frontends hold the SessionManager directly and never cross Zod.
  test("enforces the published bounds independently of Zod", () => {
    const many = ok(
      "g",
      Array.from({ length: LIMITS.COLLABORATION_ROLES_MAX + 1 }, (_, i) => ({
        name: `r${i}`,
        providerId: "gemini",
      })),
    );
    expect(many.ok).toBe(false);
    if (!many.ok) expect(many.error).toMatch(/roles — max/);

    const big = ok("x".repeat(LIMITS.COLLABORATION_GOAL_MAX + 1), [
      { name: "orchestrator", providerId: "claude" },
    ]);
    expect(big.ok).toBe(false);
    if (!big.ok) expect(big.error).toMatch(/goal is \d+ chars — max/);

    const fanout = ok("g", [
      { name: "orchestrator", providerId: "claude" },
      { name: "review", providerId: "gemini", count: LIMITS.COLLABORATION_ROLE_COUNT_MAX + 1 },
    ]);
    expect(fanout.ok).toBe(false);
    if (!fanout.ok) expect(fanout.error).toMatch(/count is \d+ — max/);

    const frac = ok("g", [
      { name: "orchestrator", providerId: "claude" },
      { name: "review", providerId: "gemini", count: 2.5 },
    ]);
    expect(frac.ok).toBe(false);
    if (!frac.ok) expect(frac.error).toMatch(/positive integer/);
  });
});

// ── 2. parseRoleSpec ────────────────────────────────────────────────────────

describe("parseRoleSpec", () => {
  test("name:provider", () => {
    expect(parseRoleSpec("orchestrator:claude")).toEqual({
      name: "orchestrator",
      providerId: "claude",
    });
  });

  test("name:provider:model", () => {
    expect(parseRoleSpec("reasoning:openai:gpt-5-codex")).toEqual({
      name: "reasoning",
      providerId: "openai",
      model: "gpt-5-codex",
    });
  });

  test("fan-out suffix", () => {
    expect(parseRoleSpec("review:gemini*3")).toEqual({
      name: "review",
      providerId: "gemini",
      count: 3,
    });
  });

  test("model and fan-out together", () => {
    expect(parseRoleSpec("review:gemini:gemini-2.5-pro*2")).toEqual({
      name: "review",
      providerId: "gemini",
      model: "gemini-2.5-pro",
      count: 2,
    });
  });

  test("tolerates surrounding whitespace", () => {
    expect(parseRoleSpec("  review : gemini * 2 ")).toEqual({
      name: "review",
      providerId: "gemini",
      count: 2,
    });
  });

  test.each([
    ["", /must not be empty/],
    ["orchestrator", /expected name:provider/],
    ["review:gemini*x", /Invalid count/],
    ["review:gemini*0", /at least 1/],
    ["review:gemini:", /model is empty/],
    [":gemini", /role name is empty/],
    ["review:", /provider is empty/],
    ["a:b:c:d", /expected name:provider/],
  ])("rejects %p", (spec, match) => {
    expect(() => parseRoleSpec(spec as string)).toThrow(match as RegExp);
  });
});

// ── 3. The real create path ─────────────────────────────────────────────────

const AUTH: AuthContext = {
  sub: "user:collab",
  scopes: [...ALL_SCOPES] as AuthContext["scopes"],
  delegationDepth: 0,
  accountId: "acc-collab",
  projectId: "proj-collab",
};
const CLIENT = { id: "client-collab", auth: AUTH, send: () => {} };

const textTurn = (text: string): ProviderEvent[] => [
  { type: "text_done", content: text } as ProviderEvent,
  { type: "turn_done", result: mockResult() } as ProviderEvent,
];

function mkConfig(): CodeoidConfig {
  return {
    daemonUrl: "ws://127.0.0.1:7400",
    dbPath: "/tmp/codeoid.db",
    transcriptDir: "/tmp/transcripts",
    auth: { baseUrl: "http://localhost:8899" },
    zeroidUrl: "http://localhost:8899",
    workspaceIndex: { enabled: false, episodeThreshold: 5, timeThresholdMs: 60_000, debounceMs: 15_000 },
    compress: { enabled: false, excludeCommands: [], excludePatterns: [], compressPipes: false, minBytes: 1024 },
    labeling: {},
    telemetry: { osc8: "auto" },
    autoRotate: { enabled: false, warnPct: 0.6, rotatePct: 0.8, hardRotatePct: 0.9, minTurnsBeforeRotate: 3, strategy: "task-anchor" },
    session: {},
    conductor: { enabled: false, name: "conductor", provider: "claude" },
    dispatch: { enabled: false, tickMs: 999_999, leaseMs: 60_000, failureLimit: 2, maxConcurrentWorkers: 2, workerToolBudget: 7, retryBaseMs: 0 },
  };
}

/** claude (default) + gemini, both mocks — so a collaboration can name a real
 *  second backend without reaching a live vendor. */
function makeRegistry(): ProviderRegistry {
  const registry = new ProviderRegistry("claude");
  for (const id of ["claude", "gemini"] as const) {
    registry.register({
      id,
      displayName: id,
      create: () => new MockSessionProvider(id, [textTurn(`${id} ok`)]),
    });
  }
  return registry;
}

let tmp: string;
let workdir: string;
let store: Store;
let transcript: TranscriptStore;
let manager: SessionManager;

function run(msg: ClientMessage): Promise<DaemonMessage> {
  return manager.handle(msg, AUTH, CLIENT);
}

const VALID: CollaborationConfig = {
  goal: "Add rate limiting to the public API",
  roles: [
    { name: "orchestrator", providerId: "claude" },
    { name: "review", providerId: "gemini", count: 2 },
  ],
};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "codeoid-collab-"));
  workdir = join(tmp, "repo");
  mkdirSync(workdir, { recursive: true });
  store = new Store(join(tmp, "codeoid.db"));
  transcript = new TranscriptStore(join(tmp, "transcripts"));
  manager = new SessionManager(store, transcript, undefined, undefined, undefined, {
    config: mkConfig(),
    providers: makeRegistry(),
  });
});

afterEach(async () => {
  try {
    await manager.drain(3_000);
  } catch {}
  // Let in-flight fire-and-forget meta writes land before the tmp dir goes
  // away. Without this, tearing down a collaboration's children races their
  // own meta writes and floods the output with ENOENT rename warnings that
  // would mask a real failure.
  await Bun.sleep(150);
  rmSync(tmp, { recursive: true, force: true });
});

describe("session.create --collaborate", () => {
  test("a valid collaboration is echoed back on SessionInfo, normalized", async () => {
    const resp = await run({
      type: "session.create",
      id: "1",
      name: "collab1",
      workdir,
      collaboration: VALID,
    });
    expect(resp.type).toBe("response.ok");
    if (resp.type !== "response.ok") return;
    const info = resp.data as SessionInfo;
    expect(info.collaboration?.goal).toBe(VALID.goal);
    expect(info.collaboration?.roles).toHaveLength(2);
    expect(info.collaboration?.roles[0]).toMatchObject({
      name: "orchestrator",
      providerId: "claude",
      count: 1, // defaulted by the daemon, not sent by the caller
    });
    expect(info.collaboration?.roles[1]).toMatchObject({
      name: "review",
      providerId: "gemini",
      count: 2,
    });
  });

  test("the collaboration is persisted to the sessions row", async () => {
    const resp = await run({
      type: "session.create",
      id: "2",
      name: "collab2",
      workdir,
      collaboration: VALID,
    });
    expect(resp.type).toBe("response.ok");
    if (resp.type !== "response.ok") return;
    const row = store.database
      .prepare("SELECT collaboration FROM sessions WHERE id = ?")
      .get((resp.data as SessionInfo).id) as { collaboration: string | null };
    expect(row.collaboration).not.toBeNull();
    const parsed = JSON.parse(row.collaboration!) as CollaborationConfig;
    expect(parsed.goal).toBe(VALID.goal);
    expect(parsed.roles.map((r) => r.providerId)).toEqual(["claude", "gemini"]);
  });

  // Regression: the status-persist saveMeta rewrites the WHOLE meta file
  // (writeMetaAtomic serializes + renames, it does not merge), so a field
  // written only at create time is erased by the first status transition —
  // and the resume path reads exactly that file. Asserting the create-time
  // write alone is not enough; this drives a real turn first.
  test("collaboration survives a status-triggered meta rewrite (resume path)", async () => {
    const resp = await run({
      type: "session.create",
      id: "meta1",
      name: "collab-meta",
      workdir,
      collaboration: VALID,
    });
    expect(resp.type).toBe("response.ok");
    if (resp.type !== "response.ok") return;
    const id = (resp.data as SessionInfo).id;
    const metaPath = transcript.metaPath(id);

    await Bun.sleep(250); // the create-time meta write is fire-and-forget
    const atCreate = JSON.parse(readFileSync(metaPath, "utf-8")) as {
      collaboration?: CollaborationConfig;
    };
    expect(atCreate.collaboration?.goal).toBe(VALID.goal);

    await run({ type: "session.send", id: "meta2", sessionId: id, text: "go" });
    await Bun.sleep(400);

    const afterTurn = JSON.parse(readFileSync(metaPath, "utf-8")) as {
      collaboration?: CollaborationConfig;
    };
    expect(afterTurn.collaboration?.goal).toBe(VALID.goal);
    expect(afterTurn.collaboration?.roles).toHaveLength(2);
  });

  test("a normal create leaves collaboration absent and the column NULL", async () => {
    const resp = await run({ type: "session.create", id: "3", name: "plain", workdir });
    expect(resp.type).toBe("response.ok");
    if (resp.type !== "response.ok") return;
    const info = resp.data as SessionInfo;
    expect(info.collaboration).toBeUndefined();
    const row = store.database
      .prepare("SELECT collaboration FROM sessions WHERE id = ?")
      .get(info.id) as { collaboration: string | null };
    expect(row.collaboration).toBeNull();
  });
});

describe("session.create --collaborate fails closed", () => {
  test("a role on an unregistered backend rejects the whole create", async () => {
    const resp = await run({
      type: "session.create",
      id: "4",
      name: "bad1",
      workdir,
      collaboration: {
        goal: "g",
        roles: [
          { name: "orchestrator", providerId: "claude" },
          { name: "review", providerId: "ollama" },
        ],
      },
    });
    expect(resp.type).toBe("response.error");
    if (resp.type === "response.error") {
      expect(resp.code).toBe("invalid_request");
      expect(resp.error).toMatch(/Unknown provider "ollama"/);
    }
    // And nothing was half-created.
    const list = await run({ type: "session.list", id: "4b" });
    expect((list as { sessions: SessionInfo[] }).sessions).toHaveLength(0);
  });

  test("a non-claude orchestrator rejects the create", async () => {
    const resp = await run({
      type: "session.create",
      id: "5",
      name: "bad2",
      workdir,
      collaboration: { goal: "g", roles: [{ name: "orchestrator", providerId: "gemini" }] },
    });
    expect(resp.type).toBe("response.error");
    if (resp.type === "response.error") expect(resp.error).toMatch(/must run on "claude" in v1/);
  });

  test("a collaboration with no orchestrator rejects the create", async () => {
    const resp = await run({
      type: "session.create",
      id: "6",
      name: "bad3",
      workdir,
      collaboration: { goal: "g", roles: [{ name: "review", providerId: "gemini" }] },
    });
    expect(resp.type).toBe("response.error");
    if (resp.type === "response.error") expect(resp.error).toMatch(/got none/);
  });
});

// ── 4. Role children (P1b) ──────────────────────────────────────────────────

/** Every live session for this tenant, parent + children. */
async function allSessions(): Promise<SessionInfo[]> {
  const resp = await run({ type: "session.list", id: `ls-${Math.random()}` });
  return (resp as { sessions: SessionInfo[] }).sessions;
}

const childrenOf = (all: SessionInfo[], parentId: string) =>
  all
    .filter((s) => s.collaborationRole?.parentSessionId === parentId)
    .sort((a, b) =>
      `${a.collaborationRole?.roleName}${a.collaborationRole?.ordinal}`.localeCompare(
        `${b.collaborationRole?.roleName}${b.collaborationRole?.ordinal}`,
      ),
    );

describe("planChildren", () => {
  test("excludes the orchestrator — the session itself plays that role", () => {
    const r = validateCollaboration(
      { goal: "g", roles: [{ name: "orchestrator", providerId: "claude" }] },
      LOOKUP,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const plan = planChildren(r.config);
    expect(plan.ok).toBe(true);
    if (plan.ok) expect(plan.children).toHaveLength(0);
  });

  test("expands fan-out into ordinals", () => {
    const r = validateCollaboration(
      {
        goal: "g",
        roles: [
          { name: "orchestrator", providerId: "claude" },
          { name: "review", providerId: "gemini", count: 3 },
        ],
      },
      LOOKUP,
    );
    if (!r.ok) throw new Error(r.error);
    const plan = planChildren(r.config);
    if (!plan.ok) throw new Error(plan.error);
    expect(plan.children.map((c) => c.ordinal)).toEqual([1, 2, 3]);
    expect(plan.children.every((c) => c.roleName === "review")).toBe(true);
  });

  // Least privilege: absent `write` means the child's identity carries no
  // write scope at all, which is what makes §6's reviewer guarantee real.
  test("defaults a role to the read-only scout shape", () => {
    const r = validateCollaboration(
      {
        goal: "g",
        roles: [
          { name: "orchestrator", providerId: "claude" },
          { name: "review", providerId: "gemini" },
          { name: "reasoning", providerId: "openai", write: true },
        ],
      },
      LOOKUP,
    );
    if (!r.ok) throw new Error(r.error);
    const plan = planChildren(r.config);
    if (!plan.ok) throw new Error(plan.error);
    const byRole = Object.fromEntries(plan.children.map((c) => [c.roleName, c]));
    expect(byRole.review!.shape).toBe("scout");
    expect(byRole.review!.write).toBe(false);
    expect(byRole.reasoning!.shape).toBe("ship");
    expect(byRole.reasoning!.write).toBe(true);
  });

  // Rejects rather than truncating: a collaboration quietly missing a reviewer
  // is worse than one that refused to start.
  test("rejects a fan-out over the child ceiling instead of truncating", () => {
    const r = validateCollaboration(
      {
        goal: "g",
        roles: [
          { name: "orchestrator", providerId: "claude" },
          { name: "a", providerId: "gemini", count: 8 },
          { name: "b", providerId: "openai", count: 8 },
        ],
      },
      LOOKUP,
    );
    if (!r.ok) throw new Error(r.error);
    const plan = planChildren(r.config);
    expect(plan.ok).toBe(false);
    if (!plan.ok) {
      expect(plan.error).toMatch(/would spawn 16 children — max 12/);
    }
  });
});

// The security claim in §6 is that a reviewer *provably* cannot write, not
// that it was asked not to. Two independent mechanisms back that, so assert
// the envelope actually denies rather than trusting the shape label.
describe("read-only roles are enforced, not requested", () => {
  const envelopeFor = (write: boolean) => ({
    write,
    network: "read-only" as const,
    envelope: "all" as const,
  });

  test("the envelope built for a read-only role denies every write tool", () => {
    const readOnly = envelopeFor(false);
    for (const tool of ["Write", "Edit", "MultiEdit", "NotebookEdit"]) {
      expect(roleDeniesTool(readOnly, tool)).toMatch(/read-only/);
    }
  });

  test("it still permits reads and the web tools a search role needs", () => {
    const readOnly = envelopeFor(false);
    for (const tool of ["Read", "Grep", "Glob", "Bash", "WebSearch", "WebFetch"]) {
      expect(roleDeniesTool(readOnly, tool)).toBeNull();
    }
  });

  test("a write role is permitted the write tools", () => {
    const writer = envelopeFor(true);
    for (const tool of ["Write", "Edit"]) {
      expect(roleDeniesTool(writer, tool)).toBeNull();
    }
  });
});

describe("collaboration children come up and are torn down", () => {
  const THREE: CollaborationConfig = {
    goal: "Add rate limiting to the public API",
    roles: [
      { name: "orchestrator", providerId: "claude" },
      { name: "reasoning", providerId: "claude", write: true },
      { name: "review", providerId: "gemini", count: 2 },
    ],
  };

  test("children spawn on their own bound backends", async () => {
    const resp = await run({
      type: "session.create",
      id: "c1",
      name: "collab",
      workdir,
      collaboration: THREE,
    });
    expect(resp.type).toBe("response.ok");
    if (resp.type !== "response.ok") return;
    const parent = resp.data as SessionInfo;

    const kids = childrenOf(await allSessions(), parent.id);
    expect(kids).toHaveLength(3); // reasoning ×1 + review ×2, orchestrator excluded
    expect(kids.map((k) => k.collaborationRole!.roleName)).toEqual([
      "reasoning",
      "review",
      "review",
    ]);
    // The whole point: each child is on the backend its role named.
    expect(kids.map((k) => k.providerId)).toEqual(["claude", "gemini", "gemini"]);
    expect(kids.map((k) => k.collaborationRole!.ordinal)).toEqual([1, 1, 2]);
    // Write authority is per role, and read-only is the default.
    expect(kids.map((k) => k.collaborationRole!.write)).toEqual([true, false, false]);
    // Children are workers, so they can never see or direct the fleet.
    expect(kids.every((k) => k.role === "worker")).toBe(true);
  });

  test("the parent runs under the compiled one-goal pack", async () => {
    const resp = await run({
      type: "session.create",
      id: "c2",
      name: "collab2",
      workdir,
      collaboration: THREE,
    });
    expect(resp.type).toBe("response.ok");
    if (resp.type !== "response.ok") return;
    // Compiled, not installed — pack vocabulary stays hidden on this path.
    expect((resp.data as SessionInfo).profile).toBe("collaboration");
  });

  test("destroying the parent tears down every child", async () => {
    const resp = await run({
      type: "session.create",
      id: "c3",
      name: "collab3",
      workdir,
      collaboration: THREE,
    });
    expect(resp.type).toBe("response.ok");
    if (resp.type !== "response.ok") return;
    const parent = resp.data as SessionInfo;
    expect(childrenOf(await allSessions(), parent.id)).toHaveLength(3);

    const destroyed = await run({
      type: "session.destroy",
      id: "c3d",
      sessionId: parent.id,
    });
    expect(destroyed.type).toBe("response.ok");

    const after = await allSessions();
    expect(childrenOf(after, parent.id)).toHaveLength(0);
    expect(after.find((s) => s.id === parent.id)).toBeUndefined();
  });

  test("a collaboration with only an orchestrator spawns nothing", async () => {
    const resp = await run({
      type: "session.create",
      id: "c4",
      name: "collab4",
      workdir,
      collaboration: { goal: "g", roles: [{ name: "orchestrator", providerId: "claude" }] },
    });
    expect(resp.type).toBe("response.ok");
    if (resp.type !== "response.ok") return;
    expect(childrenOf(await allSessions(), (resp.data as SessionInfo).id)).toHaveLength(0);
  });

  test("collaboration and pack are mutually exclusive", async () => {
    const resp = await run({
      type: "session.create",
      id: "c5",
      name: "collab5",
      workdir,
      collaboration: THREE,
      pack: "some-pack",
    });
    expect(resp.type).toBe("response.error");
    if (resp.type === "response.error") {
      expect(resp.code).toBe("invalid_request");
      expect(resp.error).toMatch(/mutually exclusive/);
    }
  });

  test("an over-ceiling fan-out is rejected before anything is created", async () => {
    const before = (await allSessions()).length;
    const resp = await run({
      type: "session.create",
      id: "c6",
      name: "collab6",
      workdir,
      collaboration: {
        goal: "g",
        roles: [
          { name: "orchestrator", providerId: "claude" },
          { name: "a", providerId: "gemini", count: 8 },
          { name: "b", providerId: "gemini", count: 8 },
        ],
      },
    });
    expect(resp.type).toBe("response.error");
    if (resp.type === "response.error") expect(resp.error).toMatch(/max 12/);
    // Nothing half-built.
    expect((await allSessions()).length).toBe(before);
  });
});

// ── Regressions found by the live smoke test + audit ────────────────────────
//
// Every one of these passed CI and the unit suite while the feature was
// actually broken end to end. They exist because "the tests are green" was not
// the same as "an agent can complete a handoff".
describe("live-verified wiring", () => {
  const CONFIG: CollaborationConfig = {
    goal: "Ship it",
    roles: [
      { name: "orchestrator", providerId: "claude" },
      { name: "search", providerId: "claude" },
    ],
  };

  const createCollab = async (id: string, name: string) => {
    manager.setBlackboardUrl("http://127.0.0.1:7400/mcp/blackboard");
    const resp = await run({
      type: "session.create",
      id,
      name,
      workdir,
      collaboration: CONFIG,
    });
    if (resp.type !== "response.ok") throw new Error("create failed");
    return resp.data as SessionInfo;
  };

  // Observed live: children spawned interactive, `blackboard_write` needs
  // approval, and NOBODY attaches to a child — so the first handoff parked at
  // waiting_approval with zero clients and the collaboration deadlocked.
  test("children spawn autonomous, because no one is there to approve", async () => {
    const parent = await createCollab("lv1", "lv1");
    const kids = childrenOf(await allSessions(), parent.id);
    expect(kids).toHaveLength(1);
    expect(kids[0]!.mode).toBe("autonomous");
    expect(kids[0]!.turnsRemaining).toBeGreaterThan(0);
  });

  // Observed by audit: only children got a mount, so the orchestrator could
  // not call blackboard_index or read findings — §4's index and §7's synthesis
  // were both impossible and the coordination loop never closed.
  // The orchestrator is the one that MOST needs the blackboard (§4 index, §7
  // synthesis) and originally got no mount at all. Paired with the teardown
  // test below, which fails if the mount is minted but never registered.
  test("a token is minted for the orchestrator as well as each child", async () => {
    const before = manager.blackboardMcp.activeTokens;
    const parent = await createCollab("lv2", "lv2");
    const kids = childrenOf(await allSessions(), parent.id);
    expect(manager.blackboardMcp.activeTokens).toBe(before + kids.length + 1);
  });

  // Observed by audit: destroying a child directly skipped revocation, leaving
  // a credential that still authorized reads/writes on the goal.
  test("destroying a child directly revokes its token", async () => {
    const parent = await createCollab("lv3", "lv3");
    const kid = childrenOf(await allSessions(), parent.id)[0]!;
    const withChild = manager.blackboardMcp.activeTokens;

    const destroyed = await run({ type: "session.destroy", id: "lv3d", sessionId: kid.id });
    expect(destroyed.type).toBe("response.ok");
    expect(manager.blackboardMcp.activeTokens).toBe(withChild - 1);
  });

  test("goal teardown revokes the orchestrator's token too", async () => {
    const before = manager.blackboardMcp.activeTokens;
    const parent = await createCollab("lv4", "lv4");
    expect(manager.blackboardMcp.activeTokens).toBeGreaterThan(before);

    await run({ type: "session.destroy", id: "lv4d", sessionId: parent.id });
    expect(manager.blackboardMcp.activeTokens).toBe(before);
  });
});

// A collaborative session IS its orchestrator, so the claude-only rule has to
// bind THIS session's backend — not just a config row that nothing runs on.
describe("the session is its orchestrator", () => {
  test("providerId is derived from the orchestrator role when omitted", async () => {
    const resp = await run({
      type: "session.create",
      id: "o1",
      name: "orch1",
      workdir,
      collaboration: VALID,
    });
    expect(resp.type).toBe("response.ok");
    if (resp.type === "response.ok") {
      expect((resp.data as SessionInfo).providerId).toBe("claude");
    }
  });

  test("a providerId that contradicts the orchestrator role is rejected", async () => {
    const resp = await run({
      type: "session.create",
      id: "o2",
      name: "orch2",
      workdir,
      providerId: "gemini", // but the orchestrator role says claude
      collaboration: VALID,
    });
    expect(resp.type).toBe("response.error");
    if (resp.type === "response.error") {
      expect(resp.code).toBe("invalid_request");
      expect(resp.error).toMatch(/conflicts with the "orchestrator" role's backend "claude"/);
    }
  });

  test("a providerId that agrees with the orchestrator role is accepted", async () => {
    const resp = await run({
      type: "session.create",
      id: "o3",
      name: "orch3",
      workdir,
      providerId: "claude",
      collaboration: VALID,
    });
    expect(resp.type).toBe("response.ok");
    if (resp.type === "response.ok") {
      expect((resp.data as SessionInfo).providerId).toBe("claude");
    }
  });

  test("a non-collaborative session still honors an explicit providerId", async () => {
    const resp = await run({
      type: "session.create",
      id: "o4",
      name: "orch4",
      workdir,
      providerId: "gemini",
    });
    expect(resp.type).toBe("response.ok");
    if (resp.type === "response.ok") {
      expect((resp.data as SessionInfo).providerId).toBe("gemini");
    }
  });
});

// ── The owner-facing blackboard wire verbs ──────────────────────────────────

// `blackboard.index` / `blackboard.read` are the only path by which a HUMAN
// sees what their fleet produced. The agent-facing MCP tools are role-scoped
// by design (§6); these are not, so what guards them is ownership of the goal
// session — and that has to hold for every way a caller can name one.
describe("blackboard.index / blackboard.read", () => {
  const CONFIG: CollaborationConfig = {
    goal: "Ship the blackboard panel",
    roles: [
      { name: "orchestrator", providerId: "claude" },
      { name: "review", providerId: "gemini", count: 2 },
    ],
  };

  /** Same daemon, a different tenant — the isolation probe. */
  const OTHER_AUTH: AuthContext = {
    ...AUTH,
    sub: "user:other",
    accountId: "acc-other",
    projectId: "proj-other",
  };

  const runAs = (msg: ClientMessage, auth: AuthContext): Promise<DaemonMessage> =>
    manager.handle(msg, auth, { id: "c2", auth, send: () => {} });

  /** Write through the REAL role-scoped path so slots + attribution are the
   *  ones agents actually produce, then read back over the wire. */
  const board = () => new Blackboard(new BlackboardStore(store.database));
  const writeAs = (goalId: string, role: string, ordinal: number, kind: string, content: string) =>
    board()
      .forRole(
        { accountId: AUTH.accountId, projectId: AUTH.projectId, goalSessionId: goalId },
        { roleName: role, ordinal, authorSub: `agent:${goalId}:${role}#${ordinal}` },
      )
      .write(kind, content);

  const createCollab = async (id: string): Promise<SessionInfo> => {
    manager.setBlackboardUrl("http://127.0.0.1:7400/mcp/blackboard");
    const resp = await run({ type: "session.create", id, name: id, workdir, collaboration: CONFIG });
    if (resp.type !== "response.ok") throw new Error(`create failed: ${JSON.stringify(resp)}`);
    return resp.data as SessionInfo;
  };

  test("indexes what the roles wrote, with the goal text for labelling", async () => {
    const parent = await createCollab("bb1");
    writeAs(parent.id, "orchestrator", 1, "spec", "SPEC BODY");
    writeAs(parent.id, "review", 1, "findings", "R1");
    writeAs(parent.id, "review", 2, "findings", "R2");

    const resp = await run({ type: "blackboard.index", id: "i1", sessionId: parent.id });
    expect(resp.type).toBe("blackboard.index.result");
    if (resp.type !== "blackboard.index.result") return;
    expect(resp.goal).toBe(CONFIG.goal);
    expect(resp.sessionId).toBe(parent.id);
    // Each reviewer occupies its own slot — a panel collapsed to one entry is
    // the exact failure MULTI_WRITER_KINDS exists to prevent.
    expect(resp.entries.map((e) => `${e.kind}:${e.slot ?? "-"}`).sort()).toEqual([
      "findings:review",
      "findings:review#2",
      "spec:-",
    ]);
    expect(resp.entries.find((e) => e.kind === "spec")?.bytes).toBe("SPEC BODY".length);
    // Bodies never travel on the index.
    expect(JSON.stringify(resp.entries)).not.toContain("SPEC BODY");
  });

  test("a role-child resolves to its parent's goal, not to an empty board", async () => {
    // Clients focus children as often as orchestrators; making each one walk
    // parentSessionId itself means a client that gets it wrong sees an EMPTY
    // board rather than an error.
    const parent = await createCollab("bb2");
    writeAs(parent.id, "orchestrator", 1, "spec", "S");
    const kid = childrenOf(await allSessions(), parent.id)[0]!;

    const resp = await run({ type: "blackboard.index", id: "i2", sessionId: kid.id });
    expect(resp.type).toBe("blackboard.index.result");
    if (resp.type !== "blackboard.index.result") return;
    expect(resp.sessionId).toBe(parent.id);
    expect(resp.entries.map((e) => e.kind)).toEqual(["spec"]);
  });

  test("a plain session says it has no blackboard instead of returning nothing", async () => {
    const resp0 = await run({ type: "session.create", id: "p1", name: "plain", workdir });
    const plain = (resp0 as { data: SessionInfo }).data;
    const resp = await run({ type: "blackboard.index", id: "i3", sessionId: plain.id });
    expect(resp.type).toBe("response.error");
    if (resp.type !== "response.error") return;
    expect(resp.code).toBe("invalid_request");
    expect(resp.error).toMatch(/not part of a collaboration/);
  });

  test("another tenant gets not_found, never someone else's board", async () => {
    const parent = await createCollab("bb3");
    writeAs(parent.id, "orchestrator", 1, "spec", "SECRET");

    const idx = await runAs(
      { type: "blackboard.index", id: "i4", sessionId: parent.id },
      OTHER_AUTH,
    );
    expect(idx.type).toBe("response.error");
    if (idx.type === "response.error") expect(idx.code).toBe("not_found");

    const read = await runAs(
      { type: "blackboard.read", id: "i5", sessionId: parent.id, kind: "spec" },
      OTHER_AUTH,
    );
    expect(read.type).toBe("response.error");
    expect(JSON.stringify(read)).not.toContain("SECRET");
  });

  test("index needs session:list and read needs session:watch", async () => {
    const parent = await createCollab("bb4");
    writeAs(parent.id, "orchestrator", 1, "spec", "S");

    // A token holding everything EXCEPT the one scope each verb requires.
    const without = (drop: string): AuthContext => ({
      ...AUTH,
      scopes: AUTH.scopes.filter((s) => s !== drop) as AuthContext["scopes"],
    });

    const idx = await runAs(
      { type: "blackboard.index", id: "i6", sessionId: parent.id },
      without("session:list"),
    );
    expect(idx.type).toBe("response.error");
    if (idx.type === "response.error") expect(idx.code).toBe("forbidden");

    const read = await runAs(
      { type: "blackboard.read", id: "i7", sessionId: parent.id, kind: "spec" },
      without("session:watch"),
    );
    expect(read.type).toBe("response.error");
    if (read.type === "response.error") expect(read.code).toBe("forbidden");

    // ...and the index still works for a watch-less token, since it carries
    // no bodies. The two verbs are deliberately gated at different tiers.
    const idxOk = await runAs(
      { type: "blackboard.index", id: "i8", sessionId: parent.id },
      without("session:watch"),
    );
    expect(idxOk.type).toBe("blackboard.index.result");
  });

  test("reads a body, including a specific reviewer's slot", async () => {
    const parent = await createCollab("bb5");
    writeAs(parent.id, "review", 1, "findings", "FIRST OPINION");
    writeAs(parent.id, "review", 2, "findings", "SECOND OPINION");

    const first = await run({
      type: "blackboard.read", id: "r1", sessionId: parent.id, kind: "findings", slot: "review",
    });
    expect(first.type).toBe("blackboard.read.result");
    if (first.type !== "blackboard.read.result") return;
    expect(first.artifact?.content).toBe("FIRST OPINION");
    expect(first.artifact?.authorRole).toBe("review");

    const second = await run({
      type: "blackboard.read", id: "r2", sessionId: parent.id, kind: "findings", slot: "review#2",
    });
    if (second.type !== "blackboard.read.result") return;
    expect(second.artifact?.content).toBe("SECOND OPINION");
  });

  test("a superseded version is still readable — writes append, never overwrite", async () => {
    const parent = await createCollab("bb6");
    writeAs(parent.id, "orchestrator", 1, "spec", "v1 text");
    writeAs(parent.id, "orchestrator", 1, "spec", "v2 text");

    const latest = await run({
      type: "blackboard.read", id: "r3", sessionId: parent.id, kind: "spec",
    });
    if (latest.type !== "blackboard.read.result") return;
    expect(latest.artifact?.version).toBe(2);
    expect(latest.artifact?.content).toBe("v2 text");

    const old = await run({
      type: "blackboard.read", id: "r4", sessionId: parent.id, kind: "spec", version: 1,
    });
    if (old.type !== "blackboard.read.result") return;
    expect(old.artifact?.content).toBe("v1 text");
  });

  test("an unwritten artifact is null, not an error", async () => {
    // A collaboration in flight legitimately has empty lanes; a client renders
    // that as pending, which it cannot do if the daemon returns an error.
    const parent = await createCollab("bb7");
    const resp = await run({
      type: "blackboard.read", id: "r5", sessionId: parent.id, kind: "research",
    });
    expect(resp.type).toBe("blackboard.read.result");
    if (resp.type !== "blackboard.read.result") return;
    expect(resp.artifact).toBeNull();
  });

  test("a malformed request is rejected at the schema, before any handler", () => {
    const rejected = (over: Record<string, unknown>) =>
      parseClientMessage({
        type: "blackboard.read", id: "r6", sessionId: "s", kind: "spec", ...over,
      }).ok;
    expect(rejected({ kind: "" })).toBe(false);
    expect(rejected({ kind: "x".repeat(65) })).toBe(false);
    expect(rejected({ version: 0 })).toBe(false);
    expect(rejected({ version: -1 })).toBe(false);
    expect(rejected({ slot: "s".repeat(129) })).toBe(false);
    // `extra/<key>` is an open namespace — the schema must let it through and
    // leave validity to the daemon, which can name the valid core kinds back.
    expect(rejected({ kind: "extra/bench-results" })).toBe(true);
  });

  test("an orphaned child reports the torn-down goal rather than an empty board", async () => {
    const parent = await createCollab("bb8");
    const kid = childrenOf(await allSessions(), parent.id)[0]!;
    // Teardown deletes the goal's artifacts, so "empty" and "gone" would be
    // indistinguishable to a client if this returned a result.
    await run({ type: "session.destroy", id: "d1", sessionId: parent.id });

    const resp = await run({ type: "blackboard.index", id: "i9", sessionId: kid.id });
    expect(resp.type).toBe("response.error");
    if (resp.type !== "response.error") return;
    expect(resp.code).toBe("not_found");
  });
});
