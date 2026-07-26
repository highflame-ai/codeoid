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
  validateCollaboration,
  type ProviderLookup,
} from "../daemon/collaboration.js";
import { MockSessionProvider, mockResult } from "../daemon/providers/mock/session-provider.js";
import { ProviderRegistry } from "../daemon/providers/registry.js";
import type { ProviderEvent } from "../daemon/providers/interface.js";
import { SessionManager } from "../daemon/session-manager.js";
import { Store } from "../daemon/store.js";
import { TranscriptStore } from "../daemon/transcript.js";
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
