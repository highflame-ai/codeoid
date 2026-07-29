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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodeoidConfig } from "../config.js";
import {
  adoptPackRoles,
  childBrief,
  compileGoalPack,
  orchestratorRole,
  orphanedChildBrief,
  parseRoleSpec,
  planChildren,
  plannedChildFor,
  roleChildPosture,
  validateCollaboration,
  type PlannedChild,
  type ProviderLookup,
} from "../daemon/collaboration.js";
import type { RoleDef } from "../daemon/pipeline/pack.js";
import { MockSessionProvider, mockResult } from "../daemon/providers/mock/session-provider.js";
import type { MemoryEngine } from "../daemon/memory/index.js";
import { ProviderRegistry } from "../daemon/providers/registry.js";
import type { ProviderEvent } from "../daemon/providers/interface.js";
import { Blackboard } from "../daemon/blackboard/service.js";
import { BlackboardStore } from "../daemon/blackboard/store.js";
import { parseClientMessage } from "@highflame/codeoid-protocol/schemas";
import { SessionManager } from "../daemon/session-manager.js";
import { Store } from "../daemon/store.js";
import { TranscriptStore } from "../daemon/transcript.js";
import { roleDeniesTool } from "../daemon/providers/tool-safety.js";
import {
  buildFleetMcpServer,
  FLEET_SEND_TOOL_NAMES,
  FLEET_TOOL_NAMES,
  isFleetSendTool,
  ORCHESTRATOR_FLEET_TOOLS,
  type FleetDeps,
} from "../daemon/fleet.js";
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

function mkConfig(over: Partial<CodeoidConfig> = {}): CodeoidConfig {
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
    ...over,
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

  // The old mutual-exclusivity rule is gone (docs/role-model-binding.md §6):
  // a collaboration may now ADOPT a pack — but only an installed one, so an
  // unknown pack still fail-closes before anything is built.
  test("a collaboration naming an uninstalled pack rejects the create", async () => {
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
      expect(resp.error).toMatch(/not installed/);
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

// ── Pack adoption (docs/role-model-binding.md §6) ───────────────────────────

/** The pack roles used across the adoption tests: an orchestrator, a pinned
 *  implementer (role-pin rung), and a tiered read-only adversary. */
const ADOPT_ROLES: Record<string, RoleDef> = {
  orchestrator: { name: "orchestrator", write: false, network: false, envelope: "all" },
  implementer: {
    name: "implementer",
    summary: "Build it.",
    provider: "claude",
    model: "claude-pinned-9",
    write: true,
    network: "read-only",
    envelope: "all",
  },
  adversary: {
    name: "adversary",
    summary: "Refute, don't summarize.",
    tier: "reasoning-max",
    write: false,
    network: false,
    envelope: ["read", "grep", "glob", "bash"],
  },
};

describe("adoptPackRoles (unit)", () => {
  const adopt = (
    roles: CollaborationConfig["roles"],
    modelConfig?: Parameters<typeof adoptPackRoles>[1]["modelConfig"],
    warn?: (m: string) => void,
  ) =>
    adoptPackRoles(
      { goal: "g", roles },
      { packId: "pk", roles: ADOPT_ROLES, modelConfig, warn },
    );

  test("an unbound role name fails, listing the pack's declared roles", () => {
    const r = adopt([
      { name: "orchestrator", providerId: "claude" },
      { name: "review", providerId: "claude" },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/declares no role "review"/);
      expect(r.error).toMatch(/orchestrator, implementer, adversary/);
    }
  });

  test("write authority comes from the role YAML, and a conflicting spec is an error", () => {
    const ok = adopt([
      { name: "orchestrator", providerId: "claude" },
      { name: "implementer", providerId: "claude" },
    ]);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.config.roles[1]!.write).toBe(true); // YAML, not spec default

    const clash = adopt([
      { name: "orchestrator", providerId: "claude" },
      { name: "implementer", providerId: "claude", write: false },
    ]);
    expect(clash.ok).toBe(false);
    if (!clash.ok) expect(clash.error).toMatch(/write authority comes from pack/);
  });

  // The §6.1 chain, minus the phase-pin rung (no phases in a collaboration).
  test("a cli spec model outranks the role pin and the tier map", () => {
    const r = adopt(
      [
        { name: "orchestrator", providerId: "claude" },
        { name: "implementer", providerId: "claude", model: "claude-cli-1" },
      ],
      { modelRoles: { "pk/implementer": { provider: "claude", model: "claude-surgical-2" } } },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config.roles[1]!.model).toBe("claude-cli-1");
  });

  test("config modelRoles outranks the role-YAML pin", () => {
    const r = adopt(
      [
        { name: "orchestrator", providerId: "claude" },
        { name: "implementer", providerId: "claude" },
      ],
      { modelRoles: { "pk/implementer": { provider: "claude", model: "claude-surgical-2" } } },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config.roles[1]!.model).toBe("claude-surgical-2");
  });

  test("the role-YAML pin applies when nothing above it binds", () => {
    const r = adopt([
      { name: "orchestrator", providerId: "claude" },
      { name: "implementer", providerId: "claude" },
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config.roles[1]!.model).toBe("claude-pinned-9");
  });

  test("the tier map binds a tiered role, and an unmapped tier warns + defaults", () => {
    const mapped = adopt(
      [
        { name: "orchestrator", providerId: "claude" },
        { name: "adversary", providerId: "claude" },
      ],
      { modelTiers: { "reasoning-max": { provider: "claude", model: "claude-tiered-7" } } },
    );
    expect(mapped.ok).toBe(true);
    if (mapped.ok) expect(mapped.config.roles[1]!.model).toBe("claude-tiered-7");

    const warnings: string[] = [];
    const unmapped = adopt(
      [
        { name: "orchestrator", providerId: "claude" },
        { name: "adversary", providerId: "claude" },
      ],
      undefined,
      (m) => warnings.push(m),
    );
    expect(unmapped.ok).toBe(true);
    if (unmapped.ok) expect(unmapped.config.roles[1]!.model).toBeUndefined();
    expect(warnings.join("\n")).toMatch(/tier "reasoning-max"/);
  });

  // The roster's provider is the operator's explicit word (the collab grammar
  // makes it mandatory): a binding on another backend must not silently move
  // the role there, and its model id doesn't transfer — fall to the backend
  // default, loudly.
  test("a winning binding on a different backend is skipped with a warning", () => {
    const warnings: string[] = [];
    const r = adopt(
      [
        { name: "orchestrator", providerId: "claude" },
        { name: "implementer", providerId: "gemini" },
      ],
      undefined,
      (m) => warnings.push(m),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.config.roles[1]!.providerId).toBe("gemini"); // roster wins
      expect(r.config.roles[1]!.model).toBeUndefined(); // pin didn't transfer
    }
    expect(warnings.join("\n")).toMatch(/role-pin.*"claude".*"gemini"/);
  });

  test("purpose defaults to the role YAML's summary, spec wins when set", () => {
    const r = adopt([
      { name: "orchestrator", providerId: "claude" },
      { name: "adversary", providerId: "claude" },
      { name: "implementer", providerId: "claude", purpose: "custom purpose" },
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.config.roles[1]!.purpose).toBe("Refute, don't summarize.");
    expect(r.config.roles[2]!.purpose).toBe("custom purpose");
  });

  // A model-only pin must not defeat the cross-vendor guard: a rung that names
  // no provider still carries a vendor-shaped id, so it applies only when it
  // validates for the roster's backend — otherwise it is SKIPPED with a
  // warning, never handed to validateCollaboration to hard-fail a create over
  // a model the operator never typed.
  test("a model-only pin is validated for the roster's backend — skipped when vendor-shaped elsewhere", () => {
    const roles: Record<string, RoleDef> = {
      orchestrator: { name: "orchestrator", write: false, network: false, envelope: "all" },
      scribe: {
        name: "scribe",
        // Model WITHOUT provider — the shape the original guard missed.
        model: "claude-fable-5",
        write: true,
        network: false,
        envelope: "all",
      },
    };
    // On a claude roster the model-only pin applies.
    const onClaude = adoptPackRoles(
      {
        goal: "g",
        roles: [
          { name: "orchestrator", providerId: "claude" },
          { name: "scribe", providerId: "claude" },
        ],
      },
      { packId: "pk", roles },
    );
    expect(onClaude.ok).toBe(true);
    if (onClaude.ok) expect(onClaude.config.roles[1]!.model).toBe("claude-fable-5");

    // On a gemini roster the claude-shaped id must NOT transfer: skipped with
    // a warning naming the rung…
    const warnings: string[] = [];
    const onGemini = adoptPackRoles(
      {
        goal: "g",
        roles: [
          { name: "orchestrator", providerId: "claude" },
          { name: "scribe", providerId: "gemini" },
        ],
      },
      { packId: "pk", roles, warn: (m) => warnings.push(m) },
    );
    expect(onGemini.ok).toBe(true);
    if (!onGemini.ok) return;
    expect(onGemini.config.roles[1]!.model).toBeUndefined();
    expect(warnings.join("\n")).toMatch(/role-pin/);
    expect(warnings.join("\n")).toMatch(/not valid for backend "gemini"/);
    // …so the adopted config sails through validateCollaboration instead of
    // hard-failing on a model the operator never typed.
    const checked = validateCollaboration(onGemini.config, LOOKUP);
    expect(checked.ok).toBe(true);
    if (checked.ok) expect(checked.config.roles[1]!.model).toBeUndefined();
  });
});

describe("pack-adopted posture + constitution (unit)", () => {
  const child: PlannedChild = {
    roleName: "adversary",
    ordinal: 1,
    providerId: "claude",
    shape: "scout",
    write: false,
  };

  test("roleChildPosture passes the role YAML's real envelope through", () => {
    const p = roleChildPosture(child, "parent", "brief", {
      packId: "pk",
      role: ADOPT_ROLES.adversary!,
    });
    expect(p.pack.id).toBe("pk");
    expect(p.pack.role.network).toBe(false);
    expect(p.pack.role.envelope).toEqual(["read", "grep", "glob", "bash"]);
    expect(p.pack.role.write).toBe(false);
    // Scout hardening is unchanged — the shape still comes from the plan.
    expect(p.workerShape).toBe("scout");
  });

  test("without adoption the synthesized free-form posture is unchanged", () => {
    const p = roleChildPosture(child, "parent", "brief");
    expect(p.pack.id).toBe("collaboration");
    expect(p.pack.role).toEqual({
      name: "adversary",
      write: false,
      network: "read-only",
      envelope: "all",
    });
  });

  test("compileGoalPack composes ETHOS → goal → roster under the real pack id", () => {
    const config: CollaborationConfig = { goal: "Ship it", roles: [] };
    const compiled = compileGoalPack(config, [child], {
      id: "pk",
      constitution: "PACK ETHOS: verify, don't trust.",
    });
    expect(compiled.id).toBe("pk");
    const ethosAt = compiled.constitution.indexOf("PACK ETHOS");
    const goalAt = compiled.constitution.indexOf("Ship it");
    const rosterAt = compiled.constitution.indexOf("- adversary");
    expect(ethosAt).toBe(0);
    expect(goalAt).toBeGreaterThan(ethosAt);
    expect(rosterAt).toBeGreaterThan(goalAt);
  });

  test("free-form compileGoalPack keeps the synthetic id and constitution", () => {
    const config: CollaborationConfig = { goal: "Ship it", roles: [] };
    const compiled = compileGoalPack(config, [child]);
    expect(compiled.id).toBe("collaboration");
    expect(compiled.constitution.startsWith("# Collaborative session")).toBe(true);
  });

  test("childBrief opens with the pack ETHOS when adopted, unchanged otherwise", () => {
    const config: CollaborationConfig = { goal: "Ship it", roles: [] };
    const adopted = childBrief(config, child, "PACK ETHOS: verify, don't trust.");
    expect(adopted.startsWith("PACK ETHOS")).toBe(true);
    expect(adopted).toContain("GOAL: Ship it");
    const plain = childBrief(config, child);
    expect(plain.startsWith("<collaboration")).toBe(true);
  });
});

describe("session.create --collaborate --pack (adoption, end to end)", () => {
  /** Write a real pack dir the PackService can load. */
  function writePack(base: string): string {
    const dir = join(base, "pack-collab");
    mkdirSync(join(dir, "roles"), { recursive: true });
    writeFileSync(
      join(dir, "pack.yaml"),
      [
        "schema: codeoid/pack@v1",
        "id: collab-pack",
        "name: Collab Pack",
        "version: 1.0.0",
        "constitution: ETHOS.md",
        "roles:",
        "  - roles/orchestrator.yaml",
        "  - roles/implementer.yaml",
        "  - roles/adversary.yaml",
        "phases:",
        "  - id: build",
        "    kind: noop",
        "",
      ].join("\n"),
    );
    writeFileSync(join(dir, "ETHOS.md"), "PACK ETHOS: verify, don't trust.\n");
    writeFileSync(
      join(dir, "roles", "orchestrator.yaml"),
      "name: orchestrator\nwrite: false\nenvelope: all\n",
    );
    writeFileSync(
      join(dir, "roles", "implementer.yaml"),
      [
        "name: implementer",
        "summary: Build it.",
        "provider: claude",
        "model: claude-pinned-9",
        "write: true",
        "network: read-only",
        "envelope: all",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(dir, "roles", "adversary.yaml"),
      [
        "name: adversary",
        "summary: Refute, don't summarize.",
        "tier: reasoning-max",
        "write: false",
        "network: false",
        "envelope: [read, grep, glob, bash]",
        "",
      ].join("\n"),
    );
    return dir;
  }

  /** Swap in a manager whose config has the pack installed + operator maps.
   *  The module-level `run`/`allSessions` helpers then drive THIS manager. */
  function useManagerWithPack(): void {
    const dir = writePack(tmp);
    manager = new SessionManager(store, transcript, undefined, undefined, undefined, {
      config: mkConfig({
        pipeline: {
          enabled: false,
          defaultPack: null,
          packs: [{ dir, trusted: false }],
          modelTiers: { "reasoning-max": { provider: "claude", model: "claude-tiered-7" } },
        },
      }),
      providers: makeRegistry(),
    });
  }

  const ADOPTING: CollaborationConfig = {
    goal: "Add rate limiting to the public API",
    roles: [
      { name: "orchestrator", providerId: "claude" },
      { name: "implementer", providerId: "claude" },
      { name: "adversary", providerId: "claude" },
    ],
  };

  test("adopts the pack: real id, YAML write authority, chain-resolved models", async () => {
    useManagerWithPack();
    const resp = await run({
      type: "session.create",
      id: "pa1",
      name: "adopt1",
      workdir,
      collaboration: ADOPTING,
      pack: "collab-pack",
    });
    expect(resp.type).toBe("response.ok");
    if (resp.type !== "response.ok") return;
    const parent = resp.data as SessionInfo;

    // The synthetic pack id gave way to the real one.
    expect(parent.profile).toBe("collab-pack");

    // Adoption rewrote the roles: write from the YAML, models from the chain
    // (role pin for implementer, tier map for adversary).
    const roles = Object.fromEntries((parent.collaboration?.roles ?? []).map((r) => [r.name, r]));
    expect(roles.implementer!.write).toBe(true);
    expect(roles.implementer!.model).toBe("claude-pinned-9");
    expect(roles.adversary!.write).toBe(false);
    expect(roles.adversary!.model).toBe("claude-tiered-7");

    // Children carry the pack posture — profile names the real pack + role.
    const kids = childrenOf(await allSessions(), parent.id);
    expect(kids).toHaveLength(2);
    expect(kids.map((k) => k.profile)).toEqual([
      "collab-pack (adversary)",
      "collab-pack (implementer)",
    ]);
    expect(kids.map((k) => k.model)).toEqual(["claude-tiered-7", "claude-pinned-9"]);
    expect(kids.map((k) => k.collaborationRole!.write)).toEqual([false, true]);
  });

  test("an unbound role name rejects the create, listing the pack's roles", async () => {
    useManagerWithPack();
    const resp = await run({
      type: "session.create",
      id: "pa2",
      name: "adopt2",
      workdir,
      collaboration: {
        goal: "g",
        roles: [
          { name: "orchestrator", providerId: "claude" },
          { name: "review", providerId: "gemini", count: 2 },
        ],
      },
      pack: "collab-pack",
    });
    expect(resp.type).toBe("response.error");
    if (resp.type === "response.error") {
      expect(resp.code).toBe("invalid_request");
      expect(resp.error).toMatch(/declares no role "review"/);
      expect(resp.error).toMatch(/orchestrator, implementer, adversary/);
    }
    expect((await allSessions()).length).toBe(0);
  });

  test("packRole is rejected on a collaborative create", async () => {
    useManagerWithPack();
    const resp = await run({
      type: "session.create",
      id: "pa3",
      name: "adopt3",
      workdir,
      collaboration: ADOPTING,
      pack: "collab-pack",
      packRole: "adversary",
    });
    expect(resp.type).toBe("response.error");
    if (resp.type === "response.error") {
      expect(resp.error).toMatch(/packRole does not apply/);
    }
  });

  // §6.2: a single --pack --pack-role session with no --model resolves through
  // the same chain minus the phase-pin and cli rungs.
  test("a single pack-role session resolves its model through the chain", async () => {
    useManagerWithPack();
    const pinned = await run({
      type: "session.create",
      id: "pa5",
      name: "single-pinned",
      workdir,
      pack: "collab-pack",
      packRole: "implementer",
    });
    expect(pinned.type).toBe("response.ok");
    if (pinned.type === "response.ok") {
      const info = pinned.data as SessionInfo;
      expect(info.model).toBe("claude-pinned-9"); // role-pin rung
      expect(info.providerId).toBe("claude"); // the pin's provider, adopted
    }

    const tiered = await run({
      type: "session.create",
      id: "pa6",
      name: "single-tiered",
      workdir,
      pack: "collab-pack",
      packRole: "adversary",
    });
    expect(tiered.type).toBe("response.ok");
    if (tiered.type === "response.ok") {
      expect((tiered.data as SessionInfo).model).toBe("claude-tiered-7"); // tier rung
    }
  });

  test("an explicit model outranks the pack role's binding (§6.2 cli rung)", async () => {
    useManagerWithPack();
    const resp = await run({
      type: "session.create",
      id: "pa7",
      name: "single-explicit",
      workdir,
      pack: "collab-pack",
      packRole: "implementer",
      model: "claude-explicit-3",
    });
    expect(resp.type).toBe("response.ok");
    if (resp.type === "response.ok") {
      expect((resp.data as SessionInfo).model).toBe("claude-explicit-3");
    }
  });

  test("model does not apply to a collaborative create", async () => {
    useManagerWithPack();
    const resp = await run({
      type: "session.create",
      id: "pa8",
      name: "collab-model",
      workdir,
      collaboration: ADOPTING,
      pack: "collab-pack",
      model: "claude-explicit-3",
    });
    expect(resp.type).toBe("response.error");
    if (resp.type === "response.error") {
      expect(resp.error).toMatch(/model does not apply to a collaborative session/);
    }
  });

  test("*count fan-out stays valid under adoption", async () => {
    useManagerWithPack();
    const resp = await run({
      type: "session.create",
      id: "pa4",
      name: "adopt4",
      workdir,
      collaboration: {
        goal: "g",
        roles: [
          { name: "orchestrator", providerId: "claude" },
          { name: "adversary", providerId: "claude", count: 2 },
        ],
      },
      pack: "collab-pack",
    });
    expect(resp.type).toBe("response.ok");
    if (resp.type !== "response.ok") return;
    const kids = childrenOf(await allSessions(), (resp.data as SessionInfo).id);
    expect(kids.map((k) => k.collaborationRole!.ordinal)).toEqual([1, 2]);
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

// ── Resume: the child's restrictions are DERIVED, never re-invented ──────────

// The security property lives in this pair of pure functions, so it is pinned
// here rather than only through a manager. `plannedChildFor` is implemented by
// calling `planChildren` precisely so a resumed child cannot compute a
// different shape than the one it spawned under — and the direction that drift
// fails is a read-only reviewer coming back able to write.
describe("plannedChildFor", () => {
  const CONFIG: CollaborationConfig = {
    goal: "g",
    roles: [
      { name: "orchestrator", providerId: "claude" },
      { name: "review", providerId: "gemini", count: 3, write: false },
      { name: "reasoning", providerId: "openai", write: true, model: "gpt-5-codex" },
    ],
  };

  test("reproduces exactly what planChildren produced, member for member", () => {
    const planned = planChildren(CONFIG);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    for (const child of planned.children) {
      expect(plannedChildFor(CONFIG, child.roleName, child.ordinal)).toEqual(child);
    }
  });

  test("carries the write authority and the shape that follows from it", () => {
    expect(plannedChildFor(CONFIG, "review", 2)).toMatchObject({
      write: false,
      shape: "scout",
      providerId: "gemini",
      ordinal: 2,
    });
    expect(plannedChildFor(CONFIG, "reasoning", 1)).toMatchObject({
      write: true,
      shape: "ship",
      model: "gpt-5-codex",
    });
  });

  test("fails closed on a role or ordinal that is no longer in the config", () => {
    // No plan means no restored authority — the safe direction.
    expect(plannedChildFor(CONFIG, "review", 4)).toBeUndefined();
    expect(plannedChildFor(CONFIG, "gone", 1)).toBeUndefined();
    // The orchestrator is never a child (planChildren excludes it).
    expect(plannedChildFor(CONFIG, "orchestrator", 1)).toBeUndefined();
  });
});

describe("roleChildPosture", () => {
  const scout: PlannedChild = {
    roleName: "review",
    ordinal: 2,
    providerId: "gemini",
    shape: "scout",
    write: false,
  };

  test("a read-only role gets BOTH fences, not one of them", () => {
    const p = roleChildPosture(scout, "goal-1", "BRIEF");
    // The leaf identity profile: scout holds no tools:write.
    expect(p.workerShape).toBe("scout");
    // ...and the canUseTool gate, independently.
    expect(p.pack.role.write).toBe(false);
    expect(roleDeniesTool(p.pack.role, "Write")).toMatch(/read-only/);
    expect(roleDeniesTool(p.pack.role, "Edit")).toMatch(/read-only/);
    // Reads stay allowed — a reviewer that cannot read is useless.
    expect(roleDeniesTool(p.pack.role, "Read")).toBeNull();
  });

  test("network stays read-only, not false — the search role needs the web", () => {
    const p = roleChildPosture(scout, "goal-1", "BRIEF");
    expect(p.pack.role.network).toBe("read-only");
    expect(roleDeniesTool(p.pack.role, "WebFetch")).toBeNull();
  });

  test("a writing role gets ship and an unblocked write path", () => {
    const p = roleChildPosture(
      { roleName: "reasoning", ordinal: 1, providerId: "openai", shape: "ship", write: true },
      "goal-1",
      "BRIEF",
    );
    expect(p.workerShape).toBe("ship");
    expect(p.pack.role.write).toBe(true);
    expect(roleDeniesTool(p.pack.role, "Write")).toBeNull();
  });

  test("stamps the collaborationRole a client groups the fleet by", () => {
    const p = roleChildPosture(scout, "goal-1", "BRIEF");
    expect(p.collaborationRole).toEqual({
      parentSessionId: "goal-1",
      roleName: "review",
      ordinal: 2,
      write: false,
    });
    expect(p.role).toBe("worker");
  });
});

describe("orphanedChildBrief", () => {
  test("says the goal is gone and tells the agent to stop", () => {
    const b = orphanedChildBrief("review", false);
    expect(b).toMatch(/did not survive a daemon restart/);
    expect(b).toMatch(/blackboard is NOT mounted/);
    expect(b).toMatch(/Do not start new work/);
    expect(b).toMatch(/READ-ONLY/);
  });

  test("does not claim read-only for a role that writes", () => {
    expect(orphanedChildBrief("reasoning", true)).not.toMatch(/READ-ONLY/);
  });
});

// ── Resume: a real restart, driven through resumeSessions() ─────────────────

// A second SessionManager over the SAME sqlite file and transcript dir is what
// a daemon restart actually is. Asserting through `session.list` rather than
// through internals keeps these honest about what a client can observe.
//
// Every one of these failed before this change, and the cosmetic one was the
// least of it: children came back with no worker shape, no capability role, no
// blackboard mount, and in `guarded` mode with nobody attached — so the fleet
// rendered as unrelated sessions AND deadlocked on its first handoff.
describe("collaboration survives a daemon restart", () => {
  const CONFIG: CollaborationConfig = {
    goal: "Survive the restart",
    roles: [
      { name: "orchestrator", providerId: "claude" },
      { name: "review", providerId: "gemini", count: 2 },
      { name: "reasoning", providerId: "claude", write: true },
    ],
  };

  const BLACKBOARD_URL = "http://127.0.0.1:7400/mcp/blackboard";

  /** Restart: a fresh manager over the same on-disk state. */
  async function restart(): Promise<SessionManager> {
    await manager.drain(3_000);
    await Bun.sleep(150); // let in-flight meta writes land
    const next = new SessionManager(
      new Store(join(tmp, "codeoid.db")),
      new TranscriptStore(join(tmp, "transcripts")),
      undefined,
      undefined,
      undefined,
      { config: mkConfig(), providers: makeRegistry() },
    );
    next.setBlackboardUrl(BLACKBOARD_URL);
    await next.resumeSessions();
    manager = next; // so afterEach drains the live one
    return next;
  }

  const listFrom = async (m: SessionManager): Promise<SessionInfo[]> => {
    const resp = await m.handle(
      { type: "session.list", id: `ls-${Math.random()}` },
      AUTH,
      CLIENT,
    );
    return (resp as { sessions: SessionInfo[] }).sessions;
  };

  const createGoal = async (id: string): Promise<SessionInfo> => {
    manager.setBlackboardUrl(BLACKBOARD_URL);
    const resp = await run({ type: "session.create", id, name: id, workdir, collaboration: CONFIG });
    if (resp.type !== "response.ok") throw new Error(`create failed: ${JSON.stringify(resp)}`);
    return resp.data as SessionInfo;
  };

  test("children come back attached to their parent, with role + ordinal", async () => {
    const parent = await createGoal("rs1");
    const before = childrenOf(await allSessions(), parent.id);
    expect(before).toHaveLength(3);

    const kids = childrenOf(await listFrom(await restart()), parent.id);
    // Without collaborationRole these are three unrelated sessions whose only
    // hint of belonging together is a name prefix.
    expect(kids).toHaveLength(3);
    expect(
      kids.map((k) => `${k.collaborationRole!.roleName}#${k.collaborationRole!.ordinal}`).sort(),
    ).toEqual(["reasoning#1", "review#1", "review#2"]);
  });

  test("write authority is restored per role, not uniformly", async () => {
    const parent = await createGoal("rs2");
    const kids = childrenOf(await listFrom(await restart()), parent.id);
    const byRole = new Map(kids.map((k) => [`${k.collaborationRole!.roleName}#${k.collaborationRole!.ordinal}`, k]));
    expect(byRole.get("review#1")!.collaborationRole!.write).toBe(false);
    expect(byRole.get("review#2")!.collaborationRole!.write).toBe(false);
    expect(byRole.get("reasoning#1")!.collaborationRole!.write).toBe(true);
  });

  test("a child bound to a model resumes WITH it, not on the provider default", async () => {
    // #resumeRoleChild built its options without defaultModel, so a child
    // bound via the roster (or the tier map) came back on the provider default
    // while SessionInfo still displayed the resolved model. Same source as the
    // spawn path (`plannedChildFor`) — the two cannot drift.
    manager.setBlackboardUrl(BLACKBOARD_URL);
    const cfg: CollaborationConfig = {
      goal: "resume with the bound model",
      roles: [
        { name: "orchestrator", providerId: "claude" },
        { name: "review", providerId: "gemini", model: "gemini-2.5-pro" },
      ],
    };
    const resp = await run({ type: "session.create", id: "rsm", name: "rsm", workdir, collaboration: cfg });
    if (resp.type !== "response.ok") throw new Error(`create failed: ${JSON.stringify(resp)}`);
    const parent = resp.data as SessionInfo;
    const before = childrenOf(await allSessions(), parent.id);
    expect(before).toHaveLength(1);
    expect(before[0]!.model).toBe("gemini-2.5-pro");

    const kids = childrenOf(await listFrom(await restart()), parent.id);
    expect(kids).toHaveLength(1);
    expect(kids[0]!.model).toBe("gemini-2.5-pro");
  });

  test("the capability role comes back, so roleDeniesTool has something to deny with", async () => {
    // `profile` is "collaboration (<role>)" only when the pack AND its
    // capability role are active. Before this change a resumed child had
    // neither, so a read-only reviewer's Write went from denied to merely asked.
    const parent = await createGoal("rs3");
    const kids = childrenOf(await listFrom(await restart()), parent.id);
    expect(kids.map((k) => k.profile).sort()).toEqual([
      "collaboration (reasoning)",
      "collaboration (review)",
      "collaboration (review)",
    ]);
    expect(kids.every((k) => k.role === "worker")).toBe(true);
  });

  test("children come back autonomous with a fresh budget, not guarded", async () => {
    // NOBODY ATTACHES TO A CHILD. Guarded means the first non-safe tool call
    // parks at waiting_approval with zero clients and the goal deadlocks.
    const parent = await createGoal("rs4");
    const kids = childrenOf(await listFrom(await restart()), parent.id);
    expect(kids.map((k) => k.mode)).toEqual(["autonomous", "autonomous", "autonomous"]);
    expect(kids.every((k) => (k.turnsRemaining ?? 0) > 0)).toBe(true);
  });

  test("every member holds an ATTACHED mount, not just a minted token", async () => {
    // Asserted per session rather than via `activeTokens`, which counts tokens
    // ever minted — a mount minted and then dropped on the floor looks
    // identical there to one a session actually holds, and that difference is
    // exactly whether a resumed child can publish a handoff.
    const parent = await createGoal("rs5");
    const next = await restart();

    const resumedParent = (await listFrom(next)).find((s) => s.id === parent.id)!;
    expect(resumedParent.collaboration?.goal).toBe(CONFIG.goal);
    expect(resumedParent.collaboration?.roles).toHaveLength(3);

    const held = (id: string) => next._sessionForTest(id)?.hasBlackboardMount;
    expect(held(parent.id)).toBe(true); // §4 index + §7 synthesis

    // Guard the guard: the per-child assertions below live inside a loop, so
    // without this a regression that returns NO children passes vacuously —
    // which is exactly what happened on the first draft of this test.
    const kids = childrenOf(await listFrom(next), parent.id);
    expect(kids).toHaveLength(3);
    for (const kid of kids) {
      expect(held(kid.id)).toBe(true);
    }
    expect(next.blackboardMcp.activeTokens).toBe(4);
  });

  test("a resumed child can still read the artifacts it wrote before the restart", async () => {
    // The end-to-end point of the whole change: attribution is keyed to the
    // ROLE within the goal, so a resumed child's mount addresses the same
    // artifacts its pre-restart self published.
    const parent = await createGoal("rs6");
    const bb = new Blackboard(new BlackboardStore(store.database));
    const scope = {
      accountId: AUTH.accountId,
      projectId: AUTH.projectId,
      goalSessionId: parent.id,
    };
    bb.forRole(scope, {
      roleName: "reasoning",
      ordinal: 1,
      authorSub: `agent:${parent.id}:reasoning#1`,
    }).write("diff", "PRE-RESTART DIFF");

    const next = await restart();
    const idx = await next.handle(
      { type: "blackboard.index", id: "i1", sessionId: parent.id },
      AUTH,
      CLIENT,
    );
    expect(idx.type).toBe("blackboard.index.result");
    if (idx.type !== "blackboard.index.result") return;
    expect(idx.entries.map((e) => e.kind)).toEqual(["diff"]);
    expect(idx.entries[0]!.authorSub).toBe(`agent:${parent.id}:reasoning#1`);
  });

  test("destroying the goal after a restart revokes every resumed token", async () => {
    // The tokens minted during resume must be tracked, or each boot leaks one
    // still-valid credential per child and teardown revokes none of them.
    const parent = await createGoal("rs7");
    const next = await restart();
    expect(next.blackboardMcp.activeTokens).toBe(4);
    const destroyed = await next.handle(
      { type: "session.destroy", id: "d1", sessionId: parent.id },
      AUTH,
      CLIENT,
    );
    expect(destroyed.type).toBe("response.ok");
    expect(next.blackboardMcp.activeTokens).toBe(0);
  });

  test("an orphaned child keeps its fence but gets no mount and no budget", async () => {
    // Torn state: the child's transcript survives, its orchestrator's doesn't.
    const parent = await createGoal("rs8");
    await manager.drain(3_000);
    await Bun.sleep(150);
    rmSync(join(tmp, "transcripts", `${parent.id}.meta.json`), { force: true });
    rmSync(join(tmp, "transcripts", parent.id), { recursive: true, force: true });

    const next = await restart();
    const kids = childrenOf(await listFrom(next), parent.id);
    expect(kids).toHaveLength(3);
    // The fence holds — that is the part that must never fail open.
    const review = kids.find((k) => k.collaborationRole!.roleName === "review")!;
    expect(review.collaborationRole!.write).toBe(false);
    expect(review.profile).toBe("collaboration (review)");
    // ...but it cannot coordinate, so it is not handed turns to burn.
    expect(kids.every((k) => k.mode !== "autonomous")).toBe(true);
    // No goal, no board: minting a mount for artifacts that were dropped with
    // the goal would hand out a credential to nothing.
    for (const kid of kids) {
      expect(next._sessionForTest(kid.id)?.hasBlackboardMount).toBe(false);
    }
    expect(next.blackboardMcp.activeTokens).toBe(0);
  });
});


// ── Guard: the tenant-wide live-children cap (§11 P3) ───────────────────────

// The hole this closes, verified before it was written: role-children are
// long-lived `send`-driven sessions, not `kind:"spawn"` dispatch tasks, so
// `dispatchActiveSpawnCount` — the query behind `dispatch.maxConcurrentWorkers`
// — counts exactly zero of them. `MAX_COLLABORATION_CHILDREN` bounds ONE goal
// at 12; nothing bounded the number of goals, and `rateLimit` is unlimited by
// design. Ten collaborations meant 120 live autonomous agents, uncapped.
describe("live role-children are capped per tenant", () => {
  /** 2 children per goal, so a cap of 12 is reached in 6 creates. */
  const SMALL: CollaborationConfig = {
    goal: "small goal",
    roles: [
      { name: "orchestrator", providerId: "claude" },
      { name: "review", providerId: "gemini", count: 2 },
    ],
  };

  /** Rebuild the manager with a specific cap. */
  function withCap(maxLiveChildren: number): void {
    manager = new SessionManager(store, transcript, undefined, undefined, undefined, {
      config: mkConfig({ collaboration: { maxLiveChildren } }),
      providers: makeRegistry(),
    });
  }

  const create = (id: string, config = SMALL) =>
    run({ type: "session.create", id, name: id, workdir, collaboration: config });

  test("allows collaborations up to the cap, then refuses the one that crosses it", async () => {
    withCap(12);
    for (let i = 1; i <= 6; i++) {
      const ok = await create(`c${i}`);
      expect(ok.type).toBe("response.ok");
    }
    expect(childrenOf(await allSessions(), "").length).toBe(0); // sanity: no orphans
    const all = await allSessions();
    expect(all.filter((s) => s.collaborationRole).length).toBe(12);

    const over = await create("c7");
    expect(over.type).toBe("response.error");
    if (over.type !== "response.error") return;
    expect(over.code).toBe("rate_limited");
    // The message has to be actionable — the count, the cap, and the way out.
    expect(over.error).toMatch(/14, over the limit of 12/);
    expect(over.error).toMatch(/12 already running/);
    expect(over.error).toMatch(/collaboration\.maxLiveChildren/);
  });

  test("refuses BEFORE building anything — no orphan orchestrator left behind", async () => {
    withCap(12);
    for (let i = 1; i <= 6; i++) await create(`b${i}`);
    const before = (await allSessions()).length;

    const over = await create("b7");
    expect(over.type).toBe("response.error");
    // A rejected create that still left its orchestrator would be worse than
    // no cap: a session that exists and can never get its fleet.
    const after = await allSessions();
    expect(after.length).toBe(before);
    expect(after.some((s) => s.name === "b7")).toBe(false);
  });

  test("counts across goals, not within one", async () => {
    // Each goal is well under MAX_COLLABORATION_CHILDREN; the cap is about
    // their sum, which is the dimension nothing measured before.
    withCap(4);
    expect((await create("x1")).type).toBe("response.ok");
    expect((await create("x2")).type).toBe("response.ok");
    const third = await create("x3");
    expect(third.type).toBe("response.error");
  });

  test("destroying a finished collaboration frees its capacity", async () => {
    withCap(4);
    const first = await create("f1");
    await create("f2");
    expect((await create("f3")).type).toBe("response.error");

    const goalId = (first as { data: SessionInfo }).data.id;
    expect((await run({ type: "session.destroy", id: "d", sessionId: goalId })).type).toBe(
      "response.ok",
    );
    // Cascade teardown removed its 2 children, so there is room again.
    expect((await create("f4")).type).toBe("response.ok");
  });

  test("0 means unlimited, matching the rateLimit opt-out convention", async () => {
    withCap(0);
    for (let i = 1; i <= 8; i++) {
      expect((await create(`u${i}`)).type).toBe("response.ok");
    }
    expect((await allSessions()).filter((s) => s.collaborationRole).length).toBe(16);
  });

  test("an absent config is unlimited, not the default cap", async () => {
    // loadConfig always populates a default; an absent value only happens for a
    // hand-built config (a test, an embedder), and silently imposing a cap it
    // never declared would be the surprising direction.
    manager = new SessionManager(store, transcript, undefined, undefined, undefined, {
      config: mkConfig(),
      providers: makeRegistry(),
    });
    for (let i = 1; i <= 8; i++) {
      expect((await create(`n${i}`)).type).toBe("response.ok");
    }
  });

  test("another tenant's children do not consume this tenant's budget", async () => {
    withCap(4);
    const other: AuthContext = {
      ...AUTH,
      sub: "user:other",
      accountId: "acc-other",
      projectId: "proj-other",
    };
    for (let i = 1; i <= 2; i++) {
      const resp = await manager.handle(
        { type: "session.create", id: `o${i}`, name: `o${i}`, workdir, collaboration: SMALL },
        other,
        { id: "c-other", auth: other, send: () => {} },
      );
      expect(resp.type).toBe("response.ok");
    }
    // 4 children live, but all in the other tenant — ours is still empty.
    expect((await create("m1")).type).toBe("response.ok");
    expect((await create("m2")).type).toBe("response.ok");
    expect((await create("m3")).type).toBe("response.error");
  });

  test("a single max-size collaboration is never blocked by the cap's floor", async () => {
    // The config schema refuses a cap below MAX_COLLABORATION_CHILDREN
    // precisely so the two bounds cannot contradict each other.
    withCap(12);
    const big: CollaborationConfig = {
      goal: "big",
      roles: [
        { name: "orchestrator", providerId: "claude" },
        { name: "review", providerId: "gemini", count: 8 },
        { name: "search", providerId: "claude", count: 4 },
      ],
    };
    expect((await create("big1", big)).type).toBe("response.ok");
    expect((await allSessions()).filter((s) => s.collaborationRole).length).toBe(12);
  });
});

// ── The orchestrator's role-aware fleet surface ─────────────────────────────

// Design line 142 has always called for "a conductor-shaped Session whose fleet
// MCP surface gains role-aware delegation". It was never wired: `#create`
// passed `fleet` only for role:"conductor", while compileGoalPack's constitution
// told the orchestrator "Direct them with the fleet tools" — instructing it to
// use tools it did not have.
//
// The conductor's server could not be reused as-is. It is ONE per-tenant
// privileged session; collaborations are user-created and many, so the
// conductor's surface would let any orchestrator direct every session in the
// tenant. These tests hit the real dependency closures rather than the MCP
// transport, because that is where the scoping lives.
describe("the orchestrator's fleet surface is scoped to its own children", () => {
  const CONFIG: CollaborationConfig = {
    goal: "scoped fleet",
    roles: [
      { name: "orchestrator", providerId: "claude" },
      { name: "review", providerId: "gemini", count: 2 },
    ],
  };

  // The shared harness disables dispatch, which would make `deps.dispatch`
  // undefined and quietly turn every enforcement assertion below into a test of
  // nothing. Enabled here with an inert tick so no dispatcher loop actually runs.
  beforeEach(() => {
    manager = new SessionManager(store, transcript, undefined, undefined, undefined, {
      config: mkConfig({
        dispatch: {
          enabled: true,
          tickMs: 999_999,
          leaseMs: 60_000,
          failureLimit: 2,
          maxConcurrentWorkers: 2,
          workerToolBudget: 7,
          retryBaseMs: 0,
        },
      }),
      providers: makeRegistry(),
    });
  });

  const createGoal = async (id: string): Promise<SessionInfo> => {
    const resp = await run({ type: "session.create", id, name: id, workdir, collaboration: CONFIG });
    if (resp.type !== "response.ok") throw new Error(`create failed: ${JSON.stringify(resp)}`);
    return resp.data as SessionInfo;
  };

  const depsFor = (goalId: string): FleetDeps =>
    manager._orchestratorFleetDepsForTest(goalId, AUTH.accountId, AUTH.projectId);

  test("sees its own children and nothing else — not itself, not other goals", async () => {
    const mine = await createGoal("sf1");
    const other = await createGoal("sf2");
    await run({ type: "session.create", id: "sf3", name: "unrelated", workdir });

    const visible = depsFor(mine.id).listSessions();
    const myKids = childrenOf(await allSessions(), mine.id);
    expect(visible.map((v) => v.id).sort()).toEqual(myKids.map((k) => k.id).sort());
    expect(visible).toHaveLength(2);
    // The three things it must NOT see.
    expect(visible.some((v) => v.id === mine.id)).toBe(false);
    expect(visible.some((v) => v.name === "unrelated")).toBe(false);
    for (const kid of childrenOf(await allSessions(), other.id)) {
      expect(visible.some((v) => v.id === kid.id)).toBe(false);
    }
  });

  test("another tenant's identically-shaped goal is invisible", async () => {
    const mine = await createGoal("sf4");
    const other: AuthContext = { ...AUTH, accountId: "acc-x", projectId: "proj-x" };
    await manager.handle(
      { type: "session.create", id: "sfx", name: "sfx", workdir, collaboration: CONFIG },
      other,
      { id: "c-x", auth: other, send: () => {} },
    );
    // Same goal shape, different tenant — and the deps are built per tenant.
    expect(depsFor(mine.id).listSessions()).toHaveLength(2);
    expect(
      manager
        ._orchestratorFleetDepsForTest(mine.id, "acc-x", "proj-x")
        .listSessions(),
    ).toHaveLength(0);
  });

  test("carries no memory engine even when the daemon has one", async () => {
    // fleet_find / fleet_recall query memory tenant-wide and use listSessions
    // only to LABEL results, never to bound them. Excluded from the tool set
    // AND denied the dependency — two independent reasons not to work.
    //
    // Asserted against a daemon that HAS a memory engine, and differentially
    // against the conductor's deps. Without both halves this passes trivially,
    // because the shared harness injects no engine at all — a mutation that
    // handed `this.#memory` straight to the orchestrator went undetected until
    // this test was written this way.
    const stub = { marker: "memory-engine" } as unknown as MemoryEngine;
    manager.setMemory(stub);
    const mine = await createGoal("sf5");

    expect(depsFor(mine.id).memory).toBeUndefined();
    // The conductor legitimately gets it — proving the engine really is
    // reachable from the manager and the omission above is a choice.
    expect(manager._fleetDepsForTest(AUTH.accountId, AUTH.projectId).memory).toBe(stub);
  });

  test("refuses to spawn — the roster is fixed for the life of the goal", async () => {
    const mine = await createGoal("sf6");
    const dispatch = depsFor(mine.id).dispatch!;
    expect(() =>
      dispatch.enqueue({ kind: "spawn", shape: "scout", workdir, prompt: "go" }),
    ).toThrow(/cannot spawn workers/);
  });

  test("refuses a send to anything that is not its own child", async () => {
    const mine = await createGoal("sf7");
    const other = await createGoal("sf8");
    const plainResp = await run({ type: "session.create", id: "sf9", name: "plain", workdir });
    const plain = (plainResp as { data: SessionInfo }).data;
    const dispatch = depsFor(mine.id).dispatch!;

    const send = (targetSession: string) =>
      dispatch.enqueue({ kind: "send", shape: "scout", targetSession, prompt: "do it" });

    // Another goal's child, an unrelated session, the orchestrator itself, and
    // a target that doesn't exist — all the same refusal.
    const theirKidId = childrenOf(await allSessions(), other.id)[0]!.id;
    expect(() => send(theirKidId)).toThrow(/not a role-child/);
    expect(() => send(plain.id)).toThrow(/not a role-child/);
    expect(() => send(mine.id)).toThrow(/not a role-child/);
    expect(() => send("does-not-exist")).toThrow(/not a role-child/);
  });

  test("allows a send to its own child, attributed to the goal", async () => {
    const mine = await createGoal("sf10");
    const kid = childrenOf(await allSessions(), mine.id)[0]!;
    const dispatch = depsFor(mine.id).dispatch!;

    const taskId = dispatch.enqueue({
      kind: "send",
      shape: "scout",
      targetSession: kid.id,
      prompt: "review the diff",
    });
    expect(typeof taskId).toBe("string");
    // Attribution keys off the GOAL id, so it survives a restart the way the
    // blackboard's authorSub does.
    const board = store.dispatchListForTenant(AUTH.accountId, AUTH.projectId, 20);
    expect(board.find((t) => t.id === taskId)?.createdBy).toBe(`orchestrator:${mine.id}`);
  });

  test("interrupt is scoped the same way as send", async () => {
    const mine = await createGoal("sf11");
    const other = await createGoal("sf12");
    const dispatch = depsFor(mine.id).dispatch!;
    const theirKid = childrenOf(await allSessions(), other.id)[0]!;
    await expect(dispatch.interrupt(theirKid.id)).rejects.toThrow(/not a role-child/);
  });

  test("a panel must target only its own children", async () => {
    // A panel is N sends, so it inherits the same fence — enforced in the DEPS,
    // not in the tool's target resolution, so a second caller of this closure
    // cannot fan out across the tenant by passing raw ids.
    const mine = await createGoal("sfp1");
    const other = await createGoal("sfp2");
    const myKids = childrenOf(await allSessions(), mine.id).map((k) => k.id);
    const theirKid = childrenOf(await allSessions(), other.id)[0]!.id;
    const dispatch = depsFor(mine.id).dispatch!;

    expect(() =>
      dispatch.enqueuePanel!({ targets: [...myKids, theirKid], prompt: "review", shape: "scout" }),
    ).toThrow(/must all be role-children/);
    // ...and one stranger poisons the whole fan-out rather than running a
    // smaller panel than the owner approved.
    expect(store.dispatchListForTenant(AUTH.accountId, AUTH.projectId, 20)).toHaveLength(0);
  });

  test("a panel over its own children queues one group, attributed to the goal", async () => {
    const mine = await createGoal("sfp3");
    const myKids = childrenOf(await allSessions(), mine.id).map((k) => k.id);
    const { groupId, taskIds } = depsFor(mine.id).dispatch!.enqueuePanel!({
      targets: myKids,
      prompt: "review the diff",
      shape: "scout",
    });
    expect(taskIds).toHaveLength(myKids.length);
    const members = store.dispatchGroupMembers(AUTH.accountId, AUTH.projectId, groupId);
    expect(members.map((m) => m.targetSession).sort()).toEqual([...myKids].sort());
    expect(members.every((m) => m.createdBy === `orchestrator:${mine.id}`)).toBe(true);
    // Ordinals are stored, so the joined digest's "member N" labels are stable.
    expect(members.map((m) => m.groupOrdinal)).toEqual([1, 2]);
  });

  test("its task board shows only its own dispatches", async () => {
    // The tenant board carries every session's targets and result digests —
    // the one place the scoping above would otherwise leak.
    const mine = await createGoal("sf13");
    const other = await createGoal("sf14");
    const myKid = childrenOf(await allSessions(), mine.id)[0]!;
    const theirKid = childrenOf(await allSessions(), other.id)[0]!;

    const myTask = depsFor(mine.id).dispatch!.enqueue({
      kind: "send", shape: "scout", targetSession: myKid.id, prompt: "mine",
    });
    const theirTask = depsFor(other.id).dispatch!.enqueue({
      kind: "send", shape: "scout", targetSession: theirKid.id, prompt: "theirs",
    });

    const board = depsFor(mine.id).dispatch!.listTasks(20);
    expect(board.map((t) => t.id)).toEqual([myTask]);
    expect(board.some((t) => t.id === theirTask)).toBe(false);
    // ...and the tenant-wide view (the conductor's) still sees both.
    expect(store.dispatchListForTenant(AUTH.accountId, AUTH.projectId, 20)).toHaveLength(2);
  });
});

describe("ORCHESTRATOR_FLEET_TOOLS", () => {
  test("excludes spawn, the memory-backed tools, and machine_map", () => {
    expect([...ORCHESTRATOR_FLEET_TOOLS].sort()).toEqual([
      "fleet_interrupt",
      "fleet_list",
      "fleet_panel",
      "fleet_send",
      "fleet_tasks",
    ]);
    for (const denied of ["fleet_spawn", "fleet_find", "fleet_recall", "fleet_summary", "machine_map"]) {
      expect(ORCHESTRATOR_FLEET_TOOLS.has(denied)).toBe(false);
    }
  });

  test("the BUILT server registers exactly those tools, not just the constant", () => {
    // Asserting the constant alone would pass while `pick()` silently ignored
    // it — the filter is what actually reaches the model.
    const deps = { listSessions: () => [], audit: () => {}, conductorSessionId: () => "g" };
    const registered = (server: unknown) =>
      Object.keys(
        (server as { instance: { _registeredTools: Record<string, unknown> } }).instance
          ._registeredTools,
      ).sort();

    expect(
      registered(buildFleetMcpServer(deps as never, { tools: ORCHESTRATOR_FLEET_TOOLS })),
    ).toEqual(["fleet_interrupt", "fleet_list", "fleet_panel", "fleet_send", "fleet_tasks"]);
    // ...and the unfiltered conductor build still gets everything, so `pick()`
    // is a filter rather than a truncation.
    expect(registered(buildFleetMcpServer(deps as never))).toEqual(
      [...FLEET_TOOL_NAMES, ...FLEET_SEND_TOOL_NAMES].sort(),
    );
  });

  test("its send-class tools still trip the R3 hard approval gate", () => {
    // The subset must not accidentally become auto-approvable: keeping these
    // off allowedTools is what makes every dispatch show the owner the input.
    // Derived from FLEET_SEND_TOOL_NAMES rather than hardcoded, so adding a
    // send-class tool to the orchestrator's set can never quietly land outside
    // the R3 gate — which is what `fleet_panel` would have done.
    for (const t of ORCHESTRATOR_FLEET_TOOLS) {
      const qualified = `mcp__codeoid_fleet__${t}`;
      const isSend = (FLEET_SEND_TOOL_NAMES as readonly string[]).includes(t);
      expect(isFleetSendTool(qualified)).toBe(isSend);
    }
    // ...and a panel specifically IS send-class: it is N dispatches at once.
    expect(isFleetSendTool("mcp__codeoid_fleet__fleet_panel")).toBe(true);
  });
});

describe("the orchestrator's constitution matches the tools it actually has", () => {
  test("names each granted tool and states that spawn is absent", () => {
    // An orchestrator told to "use the fleet tools" burns a turn discovering
    // which exist; one told it has fleet_spawn burns a turn discovering it
    // doesn't. Both happened before this.
    const compiled = compileGoalPack(
      { goal: "g", roles: [{ name: "orchestrator", providerId: "claude" }] },
      [],
    );
    for (const t of ORCHESTRATOR_FLEET_TOOLS) {
      expect(compiled.constitution).toContain(`\`${t}\``);
    }
    expect(compiled.constitution).toMatch(/NO spawn tool/);
    expect(compiled.constitution).toMatch(/roster is fixed/);
    expect(compiled.constitution).not.toContain("fleet_spawn");
  });
});

// ── Guard: the per-collaboration cost roll-up at approve-time (§11 P3) ──────

// The design words it as "surfaced at approve-time", and approve-time is the R3
// gate on a send-class fleet dispatch — which is why this guard needed the
// orchestrator's dispatch surface to exist first. Cost shown on a dashboard is
// trivia; cost shown on the button that authorizes more work is a control.
describe("the collaboration cost roll-up", () => {
  const CONFIG: CollaborationConfig = {
    goal: "spend something",
    roles: [
      { name: "orchestrator", providerId: "claude" },
      { name: "review", providerId: "gemini", count: 2 },
    ],
  };

  const createGoal = async (id: string): Promise<SessionInfo> => {
    const resp = await run({ type: "session.create", id, name: id, workdir, collaboration: CONFIG });
    if (resp.type !== "response.ok") throw new Error("create failed");
    return resp.data as SessionInfo;
  };

  test("covers the orchestrator plus every live child, and counts them", async () => {
    const goal = await createGoal("cr1");
    const rollup = manager._collaborationCostForTest(goal.id)!;
    expect(rollup.goalSessionId).toBe(goal.id);
    // 2 children; the orchestrator is counted in the totals but is not a child.
    expect(rollup.children).toBe(2);
    // Nothing has run, so a fresh goal rolls up to zero rather than undefined —
    // a client renders "$0 so far", which is true and useful.
    expect(rollup.totalCostUsd).toBe(0);
    expect(rollup.numTurns).toBe(0);
  });

  test("is undefined for a session that is not a collaboration", async () => {
    const resp = await run({ type: "session.create", id: "cr2", name: "plain", workdir });
    const plain = (resp as { data: SessionInfo }).data;
    expect(manager._collaborationCostForTest(plain.id)).toBeUndefined();
    expect(manager._collaborationCostForTest("does-not-exist")).toBeUndefined();
  });

  test("does not count another goal's children, or another tenant's", async () => {
    const mine = await createGoal("cr3");
    await createGoal("cr4");
    const other: AuthContext = { ...AUTH, accountId: "acc-y", projectId: "proj-y" };
    await manager.handle(
      { type: "session.create", id: "cry", name: "cry", workdir, collaboration: CONFIG },
      other,
      { id: "c-y", auth: other, send: () => {} },
    );
    // Four other children exist across two other goals; mine still has 2.
    expect(manager._collaborationCostForTest(mine.id)!.children).toBe(2);
  });

  test("shrinks when a child is destroyed", async () => {
    const goal = await createGoal("cr5");
    const kid = childrenOf(await allSessions(), goal.id)[0]!;
    expect(manager._collaborationCostForTest(goal.id)!.children).toBe(2);
    await run({ type: "session.destroy", id: "crd", sessionId: kid.id });
    // Summed live from the session map, so teardown is reflected immediately —
    // a stored counter would have drifted here.
    expect(manager._collaborationCostForTest(goal.id)!.children).toBe(1);
  });

  test("survives a restart and still finds the resumed fleet", async () => {
    const goal = await createGoal("cr6");
    await manager.drain(3_000);
    await Bun.sleep(150);
    const next = new SessionManager(
      new Store(join(tmp, "codeoid.db")),
      new TranscriptStore(join(tmp, "transcripts")),
      undefined, undefined, undefined,
      { config: mkConfig(), providers: makeRegistry() },
    );
    await next.resumeSessions();
    manager = next;
    expect(next._collaborationCostForTest(goal.id)!.children).toBe(2);
  });
});

// ── collaboration.panels — making the parallelism visible ───────────────────

// A panel's whole point is that N agents work AT ONCE, and until this verb
// existed nothing on the wire carried that: a client could see the fleet and
// the joined result but never the fan-out in flight. Verified live before it was
// built — two frontier models reviewed the same file simultaneously and the web
// UI rendered it as an ordinary transcript message.
describe("collaboration.panels", () => {
  const CONFIG: CollaborationConfig = {
    goal: "watch me fan out",
    roles: [
      { name: "orchestrator", providerId: "claude" },
      { name: "review", providerId: "gemini", count: 3 },
    ],
  };

  function withDispatch(): void {
    manager = new SessionManager(store, transcript, undefined, undefined, undefined, {
      config: mkConfig({
        dispatch: {
          enabled: true, tickMs: 999_999, leaseMs: 60_000, failureLimit: 2,
          maxConcurrentWorkers: 2, workerToolBudget: 7, retryBaseMs: 0,
        },
      }),
      providers: makeRegistry(),
    });
  }

  const createGoal = async (id: string): Promise<SessionInfo> => {
    const resp = await run({ type: "session.create", id, name: id, workdir, collaboration: CONFIG });
    if (resp.type !== "response.ok") throw new Error("create failed");
    return resp.data as SessionInfo;
  };

  const panelsOf = async (sessionId: string) => {
    const resp = await run({ type: "collaboration.panels", id: `p-${Math.random()}`, sessionId });
    if (resp.type !== "collaboration.panels.result") throw new Error(`unexpected ${resp.type}`);
    return resp;
  };

  test("reports members in fan-out order with live status, before anything settles", async () => {
    withDispatch();
    const goal = await createGoal("pn1");
    const kids = childrenOf(await allSessions(), goal.id);
    const deps = manager._orchestratorFleetDepsForTest(goal.id, AUTH.accountId, AUTH.projectId);
    deps.dispatch!.enqueuePanel!({ targets: kids.map((k) => k.id), prompt: "review", shape: "scout" });

    const { panels, sessionId } = await panelsOf(goal.id);
    expect(sessionId).toBe(goal.id);
    expect(panels).toHaveLength(1);
    const p = panels[0]!;
    expect(p.members.map((m) => m.ordinal)).toEqual([1, 2, 3]);
    expect(p.members.map((m) => m.sessionId)).toEqual(kids.map((k) => k.id));
    expect(p.members.every((m) => m.status === "queued")).toBe(true);
    // Nothing terminal yet — this is the state a UI must be able to render.
    expect(p.settled).toBe(0);
    expect(p.joined).toBe(false);
  });

  test("settled count rises as members finish, and joined flips only at the end", async () => {
    withDispatch();
    const goal = await createGoal("pn2");
    const kids = childrenOf(await allSessions(), goal.id);
    const deps = manager._orchestratorFleetDepsForTest(goal.id, AUTH.accountId, AUTH.projectId);
    const { groupId } = deps.dispatch!.enqueuePanel!({
      targets: kids.map((k) => k.id), prompt: "review", shape: "scout",
    });
    const members = store.dispatchGroupMembers(AUTH.accountId, AUTH.projectId, groupId);

    store.dispatchComplete(members[0]!.id, "one", Date.now());
    let p = (await panelsOf(goal.id)).panels[0]!;
    expect(p.settled).toBe(1);
    expect(p.joined).toBe(false); // 1/3 — a UI shows progress, not completion

    store.dispatchComplete(members[1]!.id, "two", Date.now());
    store.dispatchComplete(members[2]!.id, "three", Date.now());
    p = (await panelsOf(goal.id)).panels[0]!;
    expect(p.settled).toBe(3);
    expect(p.joined).toBe(true);
  });

  test("a FAILED member counts as settled — the barrier joins on terminal, not success", async () => {
    // If `joined` waited for success, a UI would show a panel spinning forever
    // on a member that already gave up. The rendered state has to match the
    // barrier's actual rule.
    withDispatch();
    const goal = await createGoal("pn3");
    const kids = childrenOf(await allSessions(), goal.id);
    const deps = manager._orchestratorFleetDepsForTest(goal.id, AUTH.accountId, AUTH.projectId);
    const { groupId } = deps.dispatch!.enqueuePanel!({
      targets: kids.map((k) => k.id), prompt: "review", shape: "scout",
    });
    const members = store.dispatchGroupMembers(AUTH.accountId, AUTH.projectId, groupId);
    store.dispatchComplete(members[0]!.id, "ok", Date.now());
    store.dispatchComplete(members[1]!.id, "ok", Date.now());
    // Burn the third to blocked.
    for (let i = 0; i < 3; i++) store.dispatchFail(members[2]!.id, "nope", Date.now(), { retryable: false });

    const p = (await panelsOf(goal.id)).panels[0]!;
    expect(p.members.some((m) => m.status === "failed" || m.status === "blocked")).toBe(true);
    expect(p.settled).toBe(3);
    expect(p.joined).toBe(true);
  });

  test("a child id resolves to its parent's panels", async () => {
    withDispatch();
    const goal = await createGoal("pn4");
    const kids = childrenOf(await allSessions(), goal.id);
    manager._orchestratorFleetDepsForTest(goal.id, AUTH.accountId, AUTH.projectId)
      .dispatch!.enqueuePanel!({ targets: kids.map((k) => k.id), prompt: "r", shape: "scout" });
    const viaChild = await panelsOf(kids[0]!.id);
    expect(viaChild.sessionId).toBe(goal.id);
    expect(viaChild.panels).toHaveLength(1);
  });

  test("one goal never sees another's panels", async () => {
    withDispatch();
    const mine = await createGoal("pn5");
    const other = await createGoal("pn6");
    const all = await allSessions();
    manager._orchestratorFleetDepsForTest(other.id, AUTH.accountId, AUTH.projectId)
      .dispatch!.enqueuePanel!({
        targets: childrenOf(all, other.id).map((k) => k.id), prompt: "r", shape: "scout",
      });
    // Their panel exists; mine has none.
    expect((await panelsOf(other.id)).panels).toHaveLength(1);
    expect((await panelsOf(mine.id)).panels).toHaveLength(0);
  });

  test("a plain session is told it has no collaboration", async () => {
    withDispatch();
    const resp0 = await run({ type: "session.create", id: "pn7", name: "plain", workdir });
    const plain = (resp0 as { data: SessionInfo }).data;
    const resp = await run({ type: "collaboration.panels", id: "pn7q", sessionId: plain.id });
    expect(resp.type).toBe("response.error");
    if (resp.type === "response.error") expect(resp.code).toBe("invalid_request");
  });

  test("requires session:list", async () => {
    withDispatch();
    const goal = await createGoal("pn8");
    const noList: AuthContext = {
      ...AUTH,
      scopes: AUTH.scopes.filter((s) => s !== "session:list") as AuthContext["scopes"],
    };
    const resp = await manager.handle(
      { type: "collaboration.panels", id: "pn8q", sessionId: goal.id },
      noList,
      { id: "c2", auth: noList, send: () => {} },
    );
    expect(resp.type).toBe("response.error");
    if (resp.type === "response.error") expect(resp.code).toBe("forbidden");
  });

  test("history is bounded — a long-running goal does not stream every fan-out", async () => {
    withDispatch();
    const goal = await createGoal("pn9");
    const kids = childrenOf(await allSessions(), goal.id).map((k) => k.id);
    const deps = manager._orchestratorFleetDepsForTest(goal.id, AUTH.accountId, AUTH.projectId);
    for (let i = 0; i < 8; i++) {
      deps.dispatch!.enqueuePanel!({ targets: kids, prompt: `round ${i}`, shape: "scout" });
    }
    const { panels } = await panelsOf(goal.id);
    expect(panels.length).toBeLessThanOrEqual(5);
    expect(panels.length).toBeGreaterThan(0);
  });
});

describe("collaboration auto-start", () => {
  /**
   * Creating a collaboration used to BUILD everything and start nothing: the
   * goal was compiled into the orchestrator's constitution, the role-children
   * came up silent, and then the whole goal sat at "idle" with no transcript
   * until the owner typed into a session that already knew what it was for.
   * Observed as a collaboration reporting its children in the sidebar while the
   * centre pane stayed empty and no work ever happened.
   */
  test("starts the orchestrator on its goal instead of leaving it idle", async () => {
    const created: MockSessionProvider[] = [];
    const registry = new ProviderRegistry("claude");
    for (const id of ["claude", "gemini"] as const) {
      registry.register({
        id,
        displayName: id,
        create: () => {
          const p = new MockSessionProvider(id, [textTurn(`${id} ok`)]);
          created.push(p);
          return p;
        },
      });
    }
    manager = new SessionManager(store, transcript, undefined, undefined, undefined, {
      config: mkConfig(),
      providers: registry,
    });

    const resp = await run({
      type: "session.create",
      id: "auto-start",
      name: "collab-auto",
      workdir,
      collaboration: VALID,
    });
    expect(resp.type).toBe("response.ok");

    // The orchestrator's provider is built first; the role-children follow.
    const orchestrator = created[0]!;
    const deadline = Date.now() + 2000;
    while (orchestrator.capturedOpts.length === 0) {
      if (Date.now() > deadline) throw new Error("orchestrator never took a turn");
      await Bun.sleep(10);
    }

    // It opens on the goal itself, so the transcript is self-describing on
    // attach and on resume rather than starting with a contentless directive.
    expect(orchestrator.capturedOpts[0]!.userMessage).toContain(VALID.goal);

    // The children must STILL be silent — bringing up a fleet of N costs zero
    // tokens, and none of them should burn a turn learning to wait.
    for (const child of created.slice(1)) {
      expect(child.capturedOpts).toHaveLength(0);
    }
  });
});
