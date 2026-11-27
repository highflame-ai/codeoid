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
let script: ProviderEvent[][] | undefined;
let providers: MockSessionProvider[] = [];

function items() {
  return [
    { id: "mine", share: "open", match: { paths: ["~/mine"] } },
    { id: "acme", share: "ask", claim: "exclusive", match: { paths: ["~/acme"] } },
    { id: "hf", share: "closed", match: { paths: ["~/hf"] } },
  ];
}

beforeEach(() => {
  script = undefined;
  providers = [];
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
    _testProviderFactory: () => {
      const p = new MockSessionProvider("mock", script ?? [say("the closed customer secret result"), say("two"), say("three")]);
      providers.push(p);
      return p;
    },
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
    // Past acme's exclusive claim: refused unless the owner approved this very call's card.
    expect(check(join(home, "acme"), "mine")).toMatchObject({ ok: false });
    const card = manager._fleetCardWorkstreamForTest(AUTH.accountId, AUTH.projectId)("mcp__codeoid_fleet__fleet_spawn", { workdir: join(home, "acme"), workstream: "mine" })!;
    const token = manager._issueFleetTokenForTest(AUTH.accountId, AUTH.projectId, card)!;
    expect(check(join(home, "acme"), "mine", "a-made-up-token")).toMatchObject({ ok: false });
    expect(check(join(home, "acme"), "mine", token)).toMatchObject({ ok: true, workstream: "mine", override: true });
    // Spent: a second spawn needs its own approval.
    expect(check(join(home, "acme"), "mine", token)).toMatchObject({ ok: false });
    expect(check(join(home, "hf"), "mine")).toMatchObject({ ok: false });
    // A closed workstream's worker works only in its own folders.
    expect(check(join(home, "loose"), "hf")).toMatchObject({ ok: false });
    expect(check(join(home, "hf"), "hf")).toEqual({ ok: true, workstream: "hf" });
    expect(check(join(home, "mine"), "nope")).toMatchObject({ ok: false });
  });

  test("the approval card names the workstream, and warns of an override or a refusal", () => {
    const card = manager._fleetCardWorkstreamForTest(AUTH.accountId, AUTH.projectId);
    expect(card("mcp__codeoid_fleet__fleet_spawn", { workdir: join(home, "mine"), task: "t" })).toEqual({ workstream: "mine" });
    expect(card("mcp__codeoid_fleet__fleet_spawn", { workdir: join(home, "acme"), task: "t", workstream: "mine" })).toMatchObject({ workstream: "mine", warning: expect.stringContaining('Past workstream "acme"') });
    expect(card("mcp__codeoid_fleet__fleet_spawn", { workdir: join(home, "loose"), task: "t" })?.warning).toContain("refused");
  });

  test("the worker is homed in the named workstream, an override as such", async () => {
    const card = manager._fleetCardWorkstreamForTest(AUTH.accountId, AUTH.projectId)("mcp__codeoid_fleet__fleet_spawn", { workdir: join(home, "acme"), workstream: "mine" })!;
    const ok = deps().checkWorkstream!(join(home, "acme"), "mine", manager._issueFleetTokenForTest(AUTH.accountId, AUTH.projectId, card));
    if (!ok.ok) throw new Error(ok.error);
    const id = deps().enqueue({ kind: "spawn", shape: "scout", workdir: join(home, "acme"), prompt: "go", workstream: "mine", workstreamOverride: true, ...(ok.revision ? { workstreamRevision: ok.revision } : {}) });
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

describe("approving a spawn card that warns", () => {
  test("is the owner's own: a delegated token is refused; the owner's approval is what the handler counts", async () => {
    script = [[{ type: "tool_start", toolId: "t1", sdkToolUseId: "s1", name: "mcp__codeoid_fleet__fleet_spawn", input: { workdir: join(home, "acme"), task: "t", workstream: "mine" }, approvalId: "ap-1" } as ProviderEvent, done]];
    const made = (await manager.handle({ type: "session.create", id: "c", name: "conductor", workdir: ".", role: "conductor" } as never, AUTH, CLIENT)) as { data: SessionInfo };
    const conductor = manager._sessionForTest(made.data.id)!;
    void conductor.send("spawn", AUTH);
    await until(() => conductor.pendingToolApprovals().length > 0);
    const pending = conductor.pendingToolApprovals()[0]!;
    expect(pending.targetWorkstream).toMatchObject({ workstream: "mine", warning: expect.stringContaining('Past workstream "acme"') });
    const delegated = { ...AUTH, delegationDepth: 1 };
    expect(await manager.handle({ type: "session.approve", id: "a1", sessionId: conductor.id, approvalId: pending.approvalId, approved: true } as never, delegated, { ...CLIENT, auth: delegated })).toMatchObject({ code: "forbidden" });
    // Another member's own token isn't the owner's either.
    const member = { ...AUTH, sub: "user:other-member" };
    expect(await manager.handle({ type: "session.approve", id: "a3", sessionId: conductor.id, approvalId: pending.approvalId, approved: true } as never, member, { ...CLIENT, auth: member })).toMatchObject({ code: "forbidden" });
    expect(await manager.handle({ type: "session.approve", id: "a2", sessionId: conductor.id, approvalId: pending.approvalId, approved: true } as never, AUTH, CLIENT)).toMatchObject({ type: "response.ok" });
    // The approval put a token in the call's own input: the handler would present it.
    await until(() => (providers.at(-1)?.canUseToolResults.length ?? 0) > 0);
    const allowed = providers.at(-1)!.canUseToolResults[0]!;
    expect(allowed.behavior).toBe("allow");
    const token = allowed.updatedInput?.confirmation as string;
    expect(typeof token).toBe("string");
    expect(deps().checkWorkstream!(join(home, "acme"), "mine", token)).toMatchObject({ ok: true, override: true });
  });
});

describe("a confirmation holds only where it was given", () => {
  test("an override queued at one revision is refused at claim after the workstreams changed", async () => {
    deps().enqueue({ kind: "spawn", shape: "scout", workdir: join(home, "acme"), prompt: "go", workstream: "mine", workstreamOverride: true, workstreamRevision: "an-old-revision" });
    await manager.dispatcher.tick();
    const listed = (await manager.handle({ type: "session.list", id: "l" }, AUTH, CLIENT)) as { sessions: SessionInfo[] };
    expect(listed.sessions.find((s) => s.role === "worker")).toBeUndefined();
    const board = manager._fleetDepsForTest(AUTH.accountId, AUTH.projectId).dispatch!.listTasks(5);
    expect(board[0]?.error ?? "").toContain("workstream");
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
