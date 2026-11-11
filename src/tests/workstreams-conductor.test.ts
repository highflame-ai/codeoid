/**
 * Workstreams W4 (docs/workstreams-design.md §10): the conductor's spawns are
 * homed in a named workstream (a conflict is the conductor's to resolve, an
 * override is what the approval card says), their cards name the workstream,
 * a closed workstream's worker reports status only, and egress is planned
 * into a worker homed where the message belongs.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodeoidConfig } from "../config.js";
import type { ProviderEvent } from "../daemon/providers/interface.js";
import { MockSessionProvider } from "../daemon/providers/mock/session-provider.js";
import { SessionManager } from "../daemon/session-manager.js";
import { Store } from "../daemon/store.js";
import { TranscriptStore } from "../daemon/transcript.js";
import { planEgress } from "../daemon/workstreams/egress.js";
import { FolderReader } from "../daemon/workstreams/folder.js";
import { workstreamsSchema } from "../daemon/workstreams/schema.js";
import { WorkstreamService } from "../daemon/workstreams/service.js";
import { ALL_SCOPES } from "../protocol/scopes.js";
import type { AuthContext, SessionInfo } from "../protocol/types.js";

const AUTH: AuthContext = { sub: "user:cond", scopes: [...ALL_SCOPES] as AuthContext["scopes"], delegationDepth: 0, accountId: "acc-c", projectId: "proj-c" };
const CLIENT = { id: "client-c", auth: AUTH, send: () => {} };
const done: ProviderEvent = { type: "turn_done", result: { providerId: "mock", model: "m", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, totalCostUsd: 0, durationMs: 1 } } as ProviderEvent;
const say = (text: string): ProviderEvent[] => [{ type: "text_done", content: text } as ProviderEvent, done];

let tmp: string;
let home: string;
let store: Store;
let transcript: TranscriptStore;
let manager: SessionManager;

function items() {
  return [
    { id: "mine", share: "open", match: { paths: ["~/mine"] } },
    { id: "acme", share: "ask", claim: "exclusive", match: { paths: ["~/acme"] } },
    { id: "hf", share: "closed", match: { paths: ["~/hf"] } },
  ];
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "codeoid-ws-cond-")));
  home = join(tmp, "home");
  for (const d of ["mine", "acme", "hf", "loose"]) mkdirSync(join(home, d), { recursive: true });
  store = new Store(join(tmp, "codeoid.db"));
  transcript = new TranscriptStore(join(tmp, "transcripts"));
  const config = {
    daemonUrl: "ws://127.0.0.1:7400",
    dbPath: join(tmp, "codeoid.db"),
    transcriptDir: join(tmp, "transcripts"),
    auth: { baseUrl: "http://localhost:8899" },
    zeroidUrl: "http://localhost:8899",
    workspaceIndex: { enabled: false, episodeThreshold: 5, timeThresholdMs: 60_000, debounceMs: 15_000 },
    compress: { enabled: false, excludeCommands: [], excludePatterns: [], compressPipes: false, minBytes: 1024 },
    labeling: {},
    telemetry: { osc8: "auto" },
    autoRotate: { enabled: false, warnPct: 0.6, rotatePct: 0.8, hardRotatePct: 0.9, minTurnsBeforeRotate: 3, strategy: "task-anchor" },
    session: {},
    conductor: { enabled: true, name: "conductor", provider: "claude" },
    dispatch: { enabled: true, tickMs: 999_999, leaseMs: 60_000, failureLimit: 1, maxConcurrentWorkers: 2, workerToolBudget: 7, retryBaseMs: 0 },
    workstreams: workstreamsSchema.parse({ isolateGlobalServers: true, items: items() }),
  } as unknown as CodeoidConfig;
  manager = new SessionManager(store, transcript, undefined, undefined, undefined, {
    config,
    _testProviderFactory: () => new MockSessionProvider("mock", [say("the closed customer secret result"), say("two"), say("three")]),
    _testFolderReader: new FolderReader({ home, sshConfig: "" }),
  });
});

afterEach(async () => {
  manager.stopDispatcher();
  try {
    await manager.drain(3_000);
  } catch {}
  try {
    await transcript.flush();
  } catch {}
  try {
    store.close();
  } catch {}
  rmSync(tmp, { recursive: true, force: true });
});

const deps = () => manager._fleetDispatchDeps(AUTH.accountId, AUTH.projectId);

async function until(cond: () => boolean, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await Bun.sleep(5);
  }
}

describe("a spawn's home", () => {
  test("named or the folder's; none refused; past an exclusive claim an override; a closed folder never", () => {
    const check = deps().checkWorkstream!;
    expect(check(join(home, "mine"), undefined)).toEqual({ ok: true, workstream: "mine" });
    expect(check(join(home, "loose"), undefined)).toMatchObject({ ok: false });
    expect(check(join(home, "loose"), "mine")).toEqual({ ok: true, workstream: "mine" });
    expect(check(join(home, "acme"), "mine")).toEqual({ ok: true, workstream: "mine", override: true });
    expect(check(join(home, "hf"), "mine")).toMatchObject({ ok: false });
    expect(check(join(home, "mine"), "nope")).toMatchObject({ ok: false });
  });

  test("the approval card names the workstream, and warns of an override or a refusal", () => {
    const card = manager._fleetCardWorkstreamForTest(AUTH.accountId, AUTH.projectId);
    expect(card("mcp__codeoid_fleet__fleet_spawn", { workdir: join(home, "mine"), task: "t" })).toEqual({ workstream: "mine" });
    expect(card("mcp__codeoid_fleet__fleet_spawn", { workdir: join(home, "acme"), task: "t", workstream: "mine" })).toMatchObject({ workstream: "mine", warning: expect.stringContaining("Past the folder's own") });
    expect(card("mcp__codeoid_fleet__fleet_spawn", { workdir: join(home, "loose"), task: "t" })?.warning).toContain("refused");
  });

  test("the worker is homed in the named workstream, an override as such", async () => {
    const id = deps().enqueue({ kind: "spawn", shape: "scout", workdir: join(home, "acme"), prompt: "go", workstream: "mine", workstreamOverride: true });
    expect(id).toBeTruthy();
    await manager.dispatcher.tick();
    const listed = (await manager.handle({ type: "session.list", id: "l" }, AUTH, CLIENT)) as { sessions: SessionInfo[] };
    const worker = listed.sessions.find((s) => s.role === "worker");
    expect(worker?.workstream).toMatchObject({ id: "mine", source: "override" });
  });

  test("a closed workstream's worker reports its status, never its text", async () => {
    deps().enqueue({ kind: "spawn", shape: "scout", workdir: join(home, "hf"), prompt: "go" });
    await manager.dispatcher.tick();
    const board = () => manager._fleetDepsForTest(AUTH.accountId, AUTH.projectId).dispatch!.listTasks(5);
    await until(() => board()[0]?.status === "done");
    const digest = board()[0]?.resultDigest ?? "";
    expect(digest).toContain("closed");
    expect(digest).not.toContain("customer secret");
  });
});

describe("egress (stub)", () => {
  test("planned into a worker homed in the named workstream, never guessed, never by a worker", () => {
    const s = new WorkstreamService(workstreamsSchema.parse({ items: items() }), new FolderReader({ home, sshConfig: "" }));
    expect(planEgress(s, { workstream: "acme", channel: "slack", recipient: "#eng", from: { role: "conductor" } })).toEqual({
      ok: true,
      worker: { workstream: "acme" },
      card: { workstream: "acme", channel: "slack", recipient: "#eng" },
    });
    expect(planEgress(s, { channel: "slack", recipient: "#eng", from: { role: "conductor" } })).toMatchObject({ ok: false });
    expect(planEgress(s, { workstream: "nope", channel: "slack", recipient: "#eng", from: { role: "conductor" } })).toMatchObject({ ok: false });
    expect(planEgress(s, { workstream: "acme", channel: "slack", recipient: "#eng", from: { role: "worker" } })).toMatchObject({ ok: false });
    expect(planEgress(new WorkstreamService(undefined), { workstream: "acme", channel: "slack", recipient: "x", from: { role: "conductor" } })).toMatchObject({ ok: false });
  });
});
