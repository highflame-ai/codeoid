/**
 * Fleet MCP handler tests (P3) — the conductor's read-only view of the
 * fleet. Drives createFleetHandlers directly with a fake dependency set
 * (plus a real StubEmbedder-backed MemoryEngine for the find/recall/summary
 * paths), so behavior is exercised without an MCP transport or the SDK.
 *
 * The load-bearing properties: read-only surface, the conductor excludes
 * itself from find, summaries are episode digests (not raw scrollback), and
 * every tool audits.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFleetHandlers,
  FLEET_SEND_TOOL_NAMES,
  FLEET_TOOL_NAMES,
  isFleetSendTool,
  type FleetDeps,
  type FleetDispatchDeps,
  type FleetSessionView,
  type FleetTaskView,
} from "../daemon/fleet.js";
import { MemoryEngine, SqliteEpisodeStore } from "../daemon/memory/index.js";
import type { Embedder } from "../daemon/memory/embedder.js";

class StubEmbedder implements Embedder {
  readonly modelName = "stub";
  readonly dimensions = 8;
  async init(): Promise<void> {}
  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((t) => {
      const v = new Float32Array(this.dimensions);
      for (let i = 0; i < t.length; i++) v[i % this.dimensions]! += t.charCodeAt(i) / 1000;
      let norm = 0;
      for (let i = 0; i < v.length; i++) norm += v[i]! * v[i]!;
      norm = Math.sqrt(norm) || 1;
      for (let i = 0; i < v.length; i++) v[i] = v[i]! / norm;
      return v;
    });
  }
  async close(): Promise<void> {}
}

let tmp: string;
let episodeStore: SqliteEpisodeStore;
let memory: MemoryEngine;
let audits: Array<{ action: string; detail: string }>;

/** A small fleet: two normal sessions + the conductor itself. */
function fleet(): FleetSessionView[] {
  return [
    {
      id: "sess-authz-0001",
      name: "authz-fix",
      workdir: join(tmp, "highflame-authz"),
      workspaceId: "ws-authz",
      status: "idle",
      providerId: "claude",
      model: "claude-opus-4-8",
      attachedClients: 1,
      createdAt: new Date(Date.now() - 3_600_000).toISOString(),
    },
    {
      id: "sess-migr-0002",
      name: "migration-work",
      workdir: join(tmp, "highflame-admin"),
      workspaceId: "ws-admin",
      status: "thinking",
      providerId: "gemini",
      attachedClients: 0,
      createdAt: new Date(Date.now() - 7_200_000).toISOString(),
    },
    {
      id: "sess-cond-9999",
      name: "conductor",
      workdir: join(tmp, ".codeoid-conductor"),
      workspaceId: "ws-conductor",
      status: "idle",
      role: "conductor",
      providerId: "claude",
      attachedClients: 1,
      createdAt: new Date().toISOString(),
    },
  ];
}

function makeDeps(overrides?: Partial<FleetDeps>): FleetDeps {
  return {
    listSessions: () => fleet(),
    memory,
    audit: (action, detail) => audits.push({ action, detail }),
    conductorSessionId: () => "sess-cond-9999",
    ...overrides,
  };
}

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "codeoid-fleet-"));
  episodeStore = new SqliteEpisodeStore(join(tmp, "memory.db"));
  memory = new MemoryEngine({ store: episodeStore, embedder: new StubEmbedder() });
  await memory.init();
  audits = [];
  // Distinct episodes per session so find/recall/summary have signal.
  memory.ingest({
    workspaceId: "ws-authz",
    sessionId: "sess-authz-0001",
    kind: "user_turn",
    summary: "fix the authz latest_only tenant scoping bug",
    content: "the authz policy latest_only query dropped account and project scope",
    filePaths: ["internal/authz/policy.go"],
    tokenEstimate: 20,
    createdAt: Date.now() - 3_600_000,
    createdBy: "user:owner",
  });
  memory.ingest({
    workspaceId: "ws-admin",
    sessionId: "sess-migr-0002",
    kind: "tool_call",
    toolName: "Bash",
    summary: "run the admin schema migration",
    content: "golang-migrate up on the admin database, add quota columns",
    filePaths: ["migrations/003_quota.sql"],
    tokenEstimate: 20,
    createdAt: Date.now() - 7_200_000,
    createdBy: "user:owner",
  });
});

afterEach(async () => {
  try { await memory.close(); } catch {}
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
});

describe("fleet handlers — read surface", () => {
  test("the auto-allowed tool set is read-class ONLY — send tools never enter allowedTools", () => {
    // THE R3 guardrail. FLEET_TOOL_NAMES feeds the provider's allowedTools
    // (auto-approved, canUseTool never fires); a send-class name leaking in
    // would silently bypass owner approval for dispatch.
    expect([...FLEET_TOOL_NAMES]).toEqual([
      "fleet_list",
      "fleet_find",
      "fleet_summary",
      "fleet_recall",
      "fleet_tasks",
      "machine_map",
    ]);
    expect([...FLEET_SEND_TOOL_NAMES]).toEqual([
      "fleet_send",
      "fleet_interrupt",
      "fleet_spawn",
      // A panel is N dispatches at once, so it belongs here and NOT in the
      // read list — being send-class is what puts it behind owner approval.
      "fleet_panel",
    ]);
    for (const sendTool of FLEET_SEND_TOOL_NAMES) {
      expect(FLEET_TOOL_NAMES).not.toContain(sendTool);
    }
  });

  test("isFleetSendTool matches only fully-qualified send-class MCP names", () => {
    expect(isFleetSendTool("mcp__codeoid_fleet__fleet_send")).toBe(true);
    expect(isFleetSendTool("mcp__codeoid_fleet__fleet_spawn")).toBe(true);
    expect(isFleetSendTool("mcp__codeoid_fleet__fleet_interrupt")).toBe(true);
    expect(isFleetSendTool("mcp__codeoid_fleet__fleet_list")).toBe(false);
    expect(isFleetSendTool("fleet_send")).toBe(false); // unqualified ≠ the MCP tool
    expect(isFleetSendTool("Bash")).toBe(false);
  });

  test("fleet_list groups sessions by workspace and marks the conductor", async () => {
    const out = await createFleetHandlers(makeDeps()).fleet_list();
    expect(out).toContain("authz-fix");
    expect(out).toContain("migration-work");
    expect(out).toContain("[conductor — you]");
    expect(out).toContain("provider=gemini");
    expect(audits.some((a) => a.action === "fleet.list")).toBe(true);
  });

  test("fleet_list on an empty fleet says so", async () => {
    const out = await createFleetHandlers(
      makeDeps({ listSessions: () => [] }),
    ).fleet_list();
    expect(out).toBe("No sessions in the fleet.");
  });

  test("fleet_find resolves a natural-language reference and excludes the conductor", async () => {
    const out = await createFleetHandlers(makeDeps()).fleet_find({
      query: "the authz latest_only fix",
    });
    expect(out).toContain("authz-fix");
    expect(out).not.toContain("conductor");
    expect(audits.some((a) => a.action === "fleet.find")).toBe(true);
  });

  test("fleet_find degrades gracefully when memory is disabled", async () => {
    const out = await createFleetHandlers(
      makeDeps({ memory: undefined }),
    ).fleet_find({ query: "anything" });
    expect(out).toContain("Memory is disabled");
  });

  test("fleet_summary returns a compressed episode digest for one session", async () => {
    const out = await createFleetHandlers(makeDeps()).fleet_summary({
      session: "authz-fix",
    });
    expect(out).toContain("authz-fix");
    expect(out).toContain("latest_only"); // from the episode summary, not raw scrollback
    expect(audits.some((a) => a.action === "fleet.summary")).toBe(true);
  });

  test("fleet_summary resolves by id prefix and reports unknown refs", async () => {
    const handlers = createFleetHandlers(makeDeps());
    expect(await handlers.fleet_summary({ session: "sess-migr" })).toContain(
      "migration-work",
    );
    expect(await handlers.fleet_summary({ session: "nope" })).toContain(
      "No session matches",
    );
  });

  test("fleet_recall pulls episode summaries across the whole fleet", async () => {
    const out = await createFleetHandlers(makeDeps()).fleet_recall({
      query: "migration quota columns",
    });
    expect(out).toContain("migration-work");
    expect(audits.some((a) => a.action === "fleet.recall")).toBe(true);
  });

  test("machine_map lists workspaces with git state (non-repo dirs → 'not a git repo')", async () => {
    const out = await createFleetHandlers(makeDeps()).machine_map();
    expect(out).toContain("highflame-authz");
    expect(out).toContain("not a git repo"); // temp dirs aren't git repos
    expect(out).toContain("authz-fix");
    expect(audits.some((a) => a.action === "fleet.machine_map")).toBe(true);
  });
});

describe("fleet handlers — send-class (P4, post-approval)", () => {
  /** Stand-in for the daemon's provider registry ids. */
  const KNOWN_PROVIDERS = ["claude", "gemini", "openai", "codex", "pi"];

  function makeDispatch(): {
    dispatch: FleetDispatchDeps;
    enqueued: Array<Parameters<FleetDispatchDeps["enqueue"]>[0]>;
    interrupted: string[];
  } {
    const enqueued: Array<Parameters<FleetDispatchDeps["enqueue"]>[0]> = [];
    const interrupted: string[] = [];
    const tasks: FleetTaskView[] = [
      {
        id: "task-abcdef12",
        kind: "spawn",
        shape: "scout",
        status: "done",
        attempts: 0,
        target: "/tmp/repo",
        createdAt: Date.now() - 60_000,
        error: null,
        resultDigest: "found the bug in auth.ts",
      },
      {
        id: "task-00112233",
        kind: "send",
        shape: "ship",
        status: "blocked",
        attempts: 2,
        target: "sess-authz-0001",
        createdAt: Date.now() - 120_000,
        error: "worker died twice",
        resultDigest: null,
      },
    ];
    return {
      enqueued,
      interrupted,
      dispatch: {
        enqueue: (input) => {
          enqueued.push(input);
          return "task-new-0001";
        },
        interrupt: async (sessionId) => {
          interrupted.push(sessionId);
        },
        checkWorkdir: (path) => (path.startsWith("/ok") ? path : null),
        // Mirrors the real SessionManager closure: fail closed on an
        // unregistered provider, pass a valid selection straight through.
        resolveBackend: (provider, model) => {
          if (provider !== undefined && !KNOWN_PROVIDERS.includes(provider)) {
            return {
              ok: false,
              error: `Unknown provider "${provider}" — available: ${KNOWN_PROVIDERS.join(", ")}`,
            };
          }
          return { ok: true, provider, model };
        },
        listTasks: () => tasks,
      },
    };
  }

  test("fleet_send resolves the target by name and enqueues a send task", async () => {
    const { dispatch, enqueued } = makeDispatch();
    const out = await createFleetHandlers(makeDeps({ dispatch })).fleet_send({
      session: "authz-fix",
      message: "continue the latest_only fix",
    });
    expect(out).toContain("Queued task");
    expect(out).toContain("authz-fix");
    expect(enqueued).toEqual([
      {
        kind: "send",
        shape: "ship",
        targetSession: "sess-authz-0001",
        prompt: "continue the latest_only fix",
      },
    ]);
    expect(audits.some((a) => a.action === "fleet.send")).toBe(true);
  });

  test("fleet_send refuses missing targets and the conductor itself", async () => {
    const { dispatch, enqueued } = makeDispatch();
    const handlers = createFleetHandlers(makeDeps({ dispatch }));
    expect(await handlers.fleet_send({ session: "nope", message: "x" })).toContain(
      "No session matches",
    );
    expect(await handlers.fleet_send({ session: "conductor", message: "x" })).toContain(
      "Refusing to dispatch to yourself",
    );
    expect(enqueued).toHaveLength(0);
  });

  test("fleet_spawn validates the workdir and enqueues with the normalized path", async () => {
    const { dispatch, enqueued } = makeDispatch();
    const handlers = createFleetHandlers(makeDeps({ dispatch }));

    expect(
      await handlers.fleet_spawn({ workdir: "/bad/path", task: "investigate" }),
    ).toContain("Workdir not usable");
    expect(enqueued).toHaveLength(0);

    const out = await handlers.fleet_spawn({ workdir: "/ok/repo", task: "investigate" });
    expect(out).toContain("Queued task");
    expect(enqueued).toEqual([
      { kind: "spawn", shape: "scout", workdir: "/ok/repo", prompt: "investigate" },
    ]);
  });

  test("fleet_spawn forwards a chosen provider + model onto the task (P0)", async () => {
    const { dispatch, enqueued } = makeDispatch();
    const handlers = createFleetHandlers(makeDeps({ dispatch }));

    const out = await handlers.fleet_spawn({
      workdir: "/ok/repo",
      task: "review this diff",
      shape: "scout",
      provider: "gemini",
      model: "gemini-2.5-pro",
    });
    // The conductor is told which backend it got, so its next dispatch
    // decision is informed by what is already running where.
    expect(out).toContain("on gemini/gemini-2.5-pro");
    expect(enqueued).toEqual([
      {
        kind: "spawn",
        shape: "scout",
        workdir: "/ok/repo",
        prompt: "review this diff",
        provider: "gemini",
        model: "gemini-2.5-pro",
      },
    ]);
  });

  test("fleet_spawn rejects an unregistered provider BEFORE queueing", async () => {
    const { dispatch, enqueued } = makeDispatch();
    const handlers = createFleetHandlers(makeDeps({ dispatch }));

    const out = await handlers.fleet_spawn({
      workdir: "/ok/repo",
      task: "x",
      provider: "not-a-backend",
    });
    expect(out).toContain('Unknown provider "not-a-backend"');
    expect(out).toContain("claude"); // names the available ones
    expect(enqueued).toHaveLength(0);
    // Audited as a rejection so a conductor probing backends is visible.
    expect(
      audits.some((a) => a.action === "fleet.spawn" && a.detail.includes("backend=rejected")),
    ).toBe(true);
  });

  test("fleet_spawn without provider/model stays on the daemon default", async () => {
    const { dispatch, enqueued } = makeDispatch();
    const handlers = createFleetHandlers(makeDeps({ dispatch }));

    const out = await handlers.fleet_spawn({ workdir: "/ok/repo", task: "x" });
    expect(out).not.toContain(" on ");
    expect(enqueued[0]!.provider).toBeUndefined();
    expect(enqueued[0]!.model).toBeUndefined();
  });

  test("fleet_interrupt resolves and interrupts, refusing self", async () => {
    const { dispatch, interrupted } = makeDispatch();
    const handlers = createFleetHandlers(makeDeps({ dispatch }));
    expect(await handlers.fleet_interrupt({ session: "migration-work" })).toContain(
      "Interrupted",
    );
    expect(interrupted).toEqual(["sess-migr-0002"]);
    expect(await handlers.fleet_interrupt({ session: "conductor" })).toContain(
      "Refusing to interrupt yourself",
    );
  });

  test("fleet_tasks renders the board with status, attempts, and digests", async () => {
    const { dispatch } = makeDispatch();
    const out = await createFleetHandlers(makeDeps({ dispatch })).fleet_tasks({});
    expect(out).toContain("task-abc");
    expect(out).toContain("found the bug in auth.ts");
    expect(out).toContain("blocked (attempts 2)");
    expect(out).toContain("worker died twice");
  });

  test("send-class tools degrade clearly when dispatch is disabled", async () => {
    const handlers = createFleetHandlers(makeDeps()); // no dispatch deps
    expect(await handlers.fleet_send({ session: "authz-fix", message: "x" })).toBe(
      "Dispatch is disabled on this daemon.",
    );
    expect(await handlers.fleet_spawn({ workdir: "/ok", task: "x" })).toBe(
      "Dispatch is disabled on this daemon.",
    );
    expect(await handlers.fleet_tasks({})).toBe("Dispatch is disabled on this daemon.");
  });
});
