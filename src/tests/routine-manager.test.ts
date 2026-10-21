/**
 * Routines through the real SessionManager (docs/routines.md): the protocol
 * handlers with their scope and tenancy gates, real run sessions on a scripted
 * backend, the HTTP trigger, the native spend cap reaching the backend, the
 * routine_end hook, and worktree isolation.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodeoidConfig } from "../config.js";
import { HookBus } from "../daemon/hooks/bus.js";
import type { ProviderEvent } from "../daemon/providers/interface.js";
import { MockSessionProvider } from "../daemon/providers/mock/session-provider.js";
import { ProviderRegistry } from "../daemon/providers/registry.js";
import { handleRoutineFire } from "../daemon/routines/http.js";
import { SessionManager } from "../daemon/session-manager.js";
import { Store } from "../daemon/store.js";
import { TranscriptStore } from "../daemon/transcript.js";
import { ALL_SCOPES, OPERATOR_SCOPES, SCOPES, WATCHER_SCOPES } from "../protocol/scopes.js";
import type {
  AuthContext,
  DaemonMessage,
  RoutineRunResultMsg,
  RoutineRunsResultMsg,
  RoutineSnapshotMsg,
  RoutineTokenResultMsg,
  ScrollbackPageResultMsg,
} from "../protocol/types.js";

const OWNER: AuthContext = { sub: "spiffe://t/user/owner", scopes: [...ALL_SCOPES], delegationDepth: 0, accountId: "acc", projectId: "proj" };
const OPERATOR: AuthContext = { ...OWNER, sub: "spiffe://t/user/op", scopes: [...OPERATOR_SCOPES] };
const WATCHER: AuthContext = { ...OWNER, sub: "spiffe://t/user/watch", scopes: [...WATCHER_SCOPES] };
const OTHER: AuthContext = { ...OWNER, sub: "spiffe://t/user/other", accountId: "acc-2" };
/** Can manage routines but not grant auto-approval. */
const NO_APPROVE: AuthContext = {
  ...OWNER,
  sub: "spiffe://t/user/limited",
  scopes: [SCOPES.SESSION_LIST, SCOPES.SESSION_CREATE, SCOPES.SESSION_SEND],
};

const reply = (text: string, cost = 0.05): ProviderEvent[] => [
  { type: "text_done", content: text } as ProviderEvent,
  {
    type: "turn_done",
    result: { providerId: "claude", model: "mock", inputTokens: 40, outputTokens: 9, cacheReadTokens: 0, cacheCreationTokens: 0, totalCostUsd: cost, durationMs: 3 },
  } as ProviderEvent,
];
/** A turn that asks to run a shell command — parks unless auto-approved. */
const shell: ProviderEvent[] = [
  { type: "tool_start", toolId: "t1", sdkToolUseId: "u1", name: "Bash", input: { command: "rm -rf build" }, approvalId: "a1" } as ProviderEvent,
];

function mkConfig(tmp: string): CodeoidConfig {
  return {
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
    conductor: { enabled: false, name: "conductor", provider: "claude" },
    routines: { enabled: true, tickMs: 600_000, maxConcurrentRuns: 2, minIntervalSeconds: 60, apiFiresPerHour: 30, missedGraceSeconds: 120 },
  } as CodeoidConfig;
}

let tmp: string;
let repo: string;
let store: Store;
let transcript: TranscriptStore;
let manager: SessionManager;
let providers: MockSessionProvider[];
let nextScript: ProviderEvent[][];
let hookFile: string;

const CLIENT = (auth: AuthContext) => ({ id: `c-${auth.sub}`, auth, send: () => {} });
const call = (msg: Record<string, unknown>, auth: AuthContext = OWNER): Promise<DaemonMessage> =>
  manager.handle({ id: "r", ...msg } as never, auth, CLIENT(auth));

async function settled(): Promise<void> {
  const svc = manager.routines!;
  for (let i = 0; i < 300; i++) {
    if (svc.store.activeRuns().length === 0) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`routine runs still active: ${JSON.stringify(svc.store.activeRuns().map((r) => r.status))}`);
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "codeoid-routine-mgr-"));
  repo = join(tmp, "repo");
  mkdirSync(repo);
  const git = (...a: string[]) => execFileSync("git", a, { cwd: repo });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  writeFileSync(join(repo, "README.md"), "hi\n");
  git("add", ".");
  git("commit", "-qm", "init");
  store = new Store(join(tmp, "codeoid.db"));
  transcript = new TranscriptStore(join(tmp, "transcripts"));
  providers = [];
  nextScript = [reply("Found 2 stale PRs: #12, #15.")];
  hookFile = join(tmp, "hook.json");
  const registry = new ProviderRegistry("claude");
  registry.register({
    id: "claude",
    displayName: "claude",
    create: () => {
      const p = new MockSessionProvider("claude", nextScript.map((t) => [...t]));
      providers.push(p);
      return p;
    },
  });
  manager = new SessionManager(store, transcript, undefined, undefined, undefined, {
    config: mkConfig(tmp),
    providers: registry,
    hooks: new HookBus([{ event: "routine_end", type: "command", command: `cat > "${hookFile}"` }]),
  });
});

afterEach(async () => {
  await manager.drain(2_000).catch(() => {});
  await transcript.flush();
  rmSync(tmp, { recursive: true, force: true });
});

async function create(spec: Record<string, unknown>, auth: AuthContext = OWNER): Promise<RoutineSnapshotMsg> {
  const res = await call({ type: "routine.create", spec: { name: "triage", prompt: "Triage open PRs.", workdir: repo, ...spec } }, auth);
  if (res.type !== "routine.snapshot") throw new Error(JSON.stringify(res));
  return res;
}

describe("routine lifecycle through the protocol", () => {
  it("create → run now → a real session answers → history, summary, and the routine's identity", async () => {
    const created = await create({ schedule: { kind: "cron", expr: "0 9 * * 1-5", timezone: "Asia/Singapore" } });
    expect(created.routine.scheduleText).toBe("cron 0 9 * * 1-5 (Asia/Singapore)");
    expect(created.routine.upcoming).toHaveLength(3);
    expect(created.apiToken).toBeUndefined();

    const fired = (await call({ type: "routine.run", routine: "triage" })) as RoutineRunResultMsg;
    expect(fired.type).toBe("routine.run.result");
    await settled();

    const got = (await call({ type: "routine.get", routine: "triage" })) as RoutineSnapshotMsg;
    const [run] = got.runs!;
    expect(run).toMatchObject({ trigger: "manual", status: "succeeded", summary: "Found 2 stale PRs: #12, #15.", costUsd: 0.05 });
    expect(got.routine.lastRun?.id).toBe(run!.id);

    // The run's session is real, the owner's, and the prompt is attributed to the routine.
    const page = (await call({ type: "scrollback.page", sessionId: run!.sessionId })) as ScrollbackPageResultMsg;
    const prompt = page.messages.find((m) => m.role === "user")!;
    expect(prompt.identity).toMatchObject({ sub: OWNER.sub, name: "routine:triage", type: "agent" });
    expect(prompt.content).toContain("Triage open PRs.");
    expect(prompt.content).toContain("[SILENT]");

    // The routine_end hook carried the outcome (to Slack, a pager, …).
    for (let i = 0; i < 50 && !existsSync(hookFile); i++) await new Promise((r) => setTimeout(r, 20));
    const hook = JSON.parse(readFileSync(hookFile, "utf8"));
    expect(hook).toMatchObject({ event: "routine_end", routine: { name: "triage" }, run: { status: "succeeded", summary: "Found 2 stale PRs: #12, #15." }, notify: true });

    // Audit names the routine as the actor of its run.
    const audits = store.database.query("SELECT subject, action FROM audit_log WHERE action LIKE 'routine.%' ORDER BY id").all() as Array<{ subject: string; action: string }>;
    expect(audits.map((a) => a.action)).toEqual(["routine.create", "routine.fire", "routine.run.queued", "routine.run.started", "routine.run.finished"]);
    expect(audits.at(-1)!.subject).toBe(`routine:${created.routine.id}`);
  });

  it("lists, pages runs, previews, pauses, and deletes", async () => {
    await create({});
    await call({ type: "routine.run", routine: "triage" });
    await settled();
    await call({ type: "routine.run", routine: "triage" });
    await settled();
    const list = await call({ type: "routine.list" });
    expect(list.type === "routine.list.result" && list.routines.map((r) => r.name)).toEqual(["triage"]);
    const p1 = (await call({ type: "routine.runs", routine: "triage", limit: 1 })) as RoutineRunsResultMsg;
    expect(p1.runs).toHaveLength(1);
    expect(p1.hasMore).toBe(true);
    const preview = await call({ type: "routine.preview", schedule: { kind: "every", seconds: 900 }, count: 2 });
    expect(preview.type === "routine.preview.result" && preview.fires).toHaveLength(2);
    const paused = (await call({ type: "routine.update", routine: "triage", enabled: false })) as RoutineSnapshotMsg;
    expect(paused.routine.enabled).toBe(false);
    expect((await call({ type: "routine.delete", routine: "triage" })).type).toBe("response.ok");
    expect((await call({ type: "routine.get", routine: "triage" })).type).toBe("response.error");
  });

  it("a guarded routine that wants to run a command parks for the owner — needs_attention, session left waiting", async () => {
    nextScript = [shell];
    await create({ approvals: "guarded" });
    await call({ type: "routine.run", routine: "triage" });
    await settled();
    const got = (await call({ type: "routine.get", routine: "triage" })) as RoutineSnapshotMsg;
    const run = got.runs![0]!;
    expect(run.status).toBe("needs_attention");
    expect(run.reason).toBe("waiting for approval to run Bash");
    const sessions = await call({ type: "session.list" });
    const s = sessions.type === "session.list.result" ? sessions.sessions.find((x) => x.id === run.sessionId) : undefined;
    expect(s?.status).toBe("waiting_approval");
    // Once the run has ended, the session is the owner's to act on.
    expect(s?.managedBy).toBeUndefined();
  });

  it("an in-flight run's session is marked managedBy=routine", async () => {
    const { routine } = await create({});
    const sessionId = (await call({ type: "session.create", name: "x", workdir: repo })) as { data?: { id: string } };
    const id = sessionId.data!.id;
    manager.routines!.store.insertRun({
      id: "r-live",
      routineId: routine.id,
      accountId: OWNER.accountId,
      projectId: OWNER.projectId,
      trigger: "manual",
      status: "running",
      scheduledFor: null,
      createdAt: Date.now(),
      startedAt: Date.now(),
      endedAt: null,
      sessionId: id,
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      summary: null,
      reason: null,
      checkOutput: null,
      payload: null,
    });
    const list = await call({ type: "session.list" });
    expect(list.type === "session.list.result" && list.sessions.find((s) => s.id === id)?.managedBy).toBe("routine");
  });

  it("a check that finds nothing never starts an agent", async () => {
    await create({ approvals: "guarded", check: { command: "test -f NOT_THERE && echo found || true" } });
    await call({ type: "routine.run", routine: "triage" });
    await settled();
    const got = (await call({ type: "routine.get", routine: "triage" })) as RoutineSnapshotMsg;
    expect(got.runs![0]).toMatchObject({ status: "silent", costUsd: 0 });
    expect(providers).toHaveLength(0);
  });
});

describe("authority", () => {
  it("no scope of its own: anyone who can create and prompt sessions can keep routines", async () => {
    // The operator preset can, as the operator themselves...
    const own: AuthContext = { ...OPERATOR, delegationDepth: 0 };
    expect((await create({}, own)).routine.ownerSub).toBe(OPERATOR.sub);
    // ...but a teammate's share token arrives delegated, and can't set up standing authority.
    const shared: AuthContext = { ...OPERATOR, delegationDepth: 1, delegatedBy: OWNER.sub };
    const res = await call({ type: "routine.create", spec: { name: "x", prompt: "p", workdir: repo } }, shared);
    expect(res).toMatchObject({ type: "response.error", code: "forbidden" });
    expect(res.type === "response.error" && res.error).toContain("delegated");
  });

  it("pre-approving work needs session:approve — autonomous, or a check command", async () => {
    for (const spec of [{}, { approvals: "guarded", check: { command: "echo hi" } }]) {
      const res = await call({ type: "routine.create", spec: { name: "x", prompt: "p", workdir: repo, ...spec } }, NO_APPROVE);
      expect(res).toMatchObject({ type: "response.error", code: "forbidden" });
      expect(res.type === "response.error" && res.error).toContain("session:approve");
    }
    // A guarded routine with no check grants nothing beyond the holder's own send.
    expect((await create({ approvals: "guarded" }, NO_APPROVE)).routine.name).toBe("triage");
    // ...and it can't be switched to autonomous later without the scope either.
    const up = await call({ type: "routine.update", routine: "triage", spec: { approvals: "autonomous" } }, NO_APPROVE);
    expect(up).toMatchObject({ type: "response.error", code: "forbidden" });
  });

  it("firing or re-tokening a routine that pre-approves work needs session:approve too", async () => {
    // The same person, through a narrower credential.
    const owner: AuthContext = { ...OWNER, sub: NO_APPROVE.sub };
    await create({ api: true }, owner);
    for (const msg of [{ type: "routine.run", routine: "triage" }, { type: "routine.token", routine: "triage" }]) {
      const res = await call(msg, NO_APPROVE);
      expect(res).toMatchObject({ code: "forbidden" });
      expect(res.type === "response.error" && res.error).toContain("session:approve");
    }
    // ...but pausing is a safety stop any managing credential may pull.
    expect(await call({ type: "routine.update", routine: "triage", enabled: false }, NO_APPROVE)).toMatchObject({ type: "routine.snapshot" });
    expect(await call({ type: "routine.update", routine: "triage", enabled: true }, NO_APPROVE)).toMatchObject({ code: "forbidden" });
  });

  it("a read-only token can't read routines (prompts, checks, payloads) or fire them", async () => {
    await create({});
    for (const msg of [{ type: "routine.list" }, { type: "routine.get", routine: "triage" }, { type: "routine.runs", routine: "triage" }, { type: "routine.run", routine: "triage" }]) {
      expect(await call(msg, WATCHER)).toMatchObject({ code: "forbidden", error: "Missing scope: session:create" });
    }
    // A schedule preview reveals nothing, so session:list is enough.
    expect((await call({ type: "routine.preview", schedule: { kind: "every", seconds: 900 } }, WATCHER)).type).toBe("routine.preview.result");
  });

  it("a routine is its owner's: a teammate in the same tenant can't see, change, fire, or re-token it", async () => {
    const { routine } = await create({ api: true });
    const fired = (await call({ type: "routine.run", routine: "triage" })) as RoutineRunResultMsg;
    await settled();
    const TEAMMATE: AuthContext = { ...OWNER, sub: "spiffe://t/user/teammate" };
    const list = await call({ type: "routine.list" }, TEAMMATE);
    expect(list.type === "routine.list.result" && list.routines).toEqual([]);
    for (const ref of ["triage", routine.id]) {
      for (const msg of [
        { type: "routine.get", routine: ref },
        { type: "routine.update", routine: ref, spec: { prompt: "something else" } },
        { type: "routine.run", routine: ref },
        { type: "routine.token", routine: ref },
        { type: "routine.delete", routine: ref },
      ]) {
        expect(await call(msg, TEAMMATE)).toMatchObject({ code: "not_found" });
      }
    }
    expect(await call({ type: "routine.cancel_run", runId: fired.run.id }, TEAMMATE)).toMatchObject({ code: "not_found" });
    // ...and their own routine of the same name is theirs alone.
    expect((await create({}, TEAMMATE)).routine.ownerSub).toBe(TEAMMATE.sub);
  });

  it("a delegated token can read routines but not create or change them", async () => {
    await create({});
    const AGENT: AuthContext = { ...OWNER, delegationDepth: 1, delegatedBy: OWNER.sub };
    expect((await call({ type: "routine.list" }, AGENT)).type).toBe("routine.list.result");
    const made = await call({ type: "routine.create", spec: { name: "y", prompt: "p", workdir: repo } }, AGENT);
    expect(made).toMatchObject({ code: "forbidden" });
    expect(made.type === "response.error" && made.error).toContain("delegated");
    expect(await call({ type: "routine.update", routine: "triage", enabled: false }, AGENT)).toMatchObject({ code: "forbidden" });
  });

  it("another tenant can't see, read, fire, or cancel anything — by name or by id", async () => {
    const { routine } = await create({});
    const fired = (await call({ type: "routine.run", routine: "triage" })) as RoutineRunResultMsg;
    await settled();
    const list = await call({ type: "routine.list" }, OTHER);
    expect(list.type === "routine.list.result" && list.routines).toEqual([]);
    for (const ref of ["triage", routine.id]) {
      expect(await call({ type: "routine.get", routine: ref }, OTHER)).toMatchObject({ code: "not_found" });
      expect(await call({ type: "routine.run", routine: ref }, OTHER)).toMatchObject({ code: "not_found" });
    }
    expect(await call({ type: "routine.cancel_run", runId: fired.run.id }, OTHER)).toMatchObject({ code: "not_found" });
  });
});

describe("the API trigger", () => {
  const fireReq = (id: string, token: string | null, body: string, headers: Record<string, string> = {}) =>
    new Request(`http://127.0.0.1/routines/${id}/fire`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      body,
    });

  it("fires with its token, and the payload reaches the agent as data", async () => {
    const { routine, apiToken } = await create({ api: true, prompt: "An alert fired: {{payload}}" });
    expect(apiToken).toMatch(/^rt_/);
    const res = await handleRoutineFire(fireReq(routine.id, apiToken!, JSON.stringify({ text: "p99 latency 4s on /checkout" })), routine.id, manager.routines!);
    expect(res.status).toBe(202);
    const body = (await res.json()) as { runId: string };
    await settled();
    const run = manager.routines!.store.getRun(body.runId)!;
    expect(run).toMatchObject({ trigger: "api", status: "succeeded", payload: "p99 latency 4s on /checkout" });
    const prompt = providers[0]!.capturedOpts[0]!.userMessage;
    expect(prompt).toContain('<routine-data source="payload"');
    expect(prompt).toContain("p99 latency 4s on /checkout");
  });

  it("refuses wrong tokens, unknown routines, an API trigger that is off, and browsers — all without leaking which", async () => {
    const on = await create({ name: "on", api: true });
    const off = await create({ name: "off" });
    const tokenRes = (await call({ type: "routine.token", routine: "on" })) as RoutineTokenResultMsg;
    expect(tokenRes.endpointPath).toBe(`/routines/${on.routine.id}/fire`);
    // The token from create was replaced by the rotation.
    const cases: Array<[string, string | null]> = [
      [on.routine.id, on.apiToken!],
      [on.routine.id, null],
      [off.routine.id, tokenRes.apiToken],
      ["00000000-0000-4000-8000-000000000000", tokenRes.apiToken],
    ];
    for (const [id, token] of cases) {
      const res = await handleRoutineFire(fireReq(id, token, "{}"), id, manager.routines!);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized" });
    }
    const browser = await handleRoutineFire(fireReq(on.routine.id, tokenRes.apiToken, "{}", { Origin: "https://evil.example" }), on.routine.id, manager.routines!);
    expect(browser.status).toBe(403);
    const ok = await handleRoutineFire(fireReq(on.routine.id, tokenRes.apiToken, "{}"), on.routine.id, manager.routines!);
    expect(ok.status).toBe(202);
    await settled();
  });
});

describe("budgets and isolation", () => {
  it("a fresh run session hands its spend ceiling to the backend; a persistent one does not", async () => {
    await create({ name: "fresh", maxCostUsd: 0.5 });
    await create({ name: "kept", maxCostUsd: 0.5, session: "persistent" });
    await call({ type: "routine.run", routine: "fresh" });
    await settled();
    await call({ type: "routine.run", routine: "kept" });
    await settled();
    expect(providers[0]!.capturedOpts[0]!.maxBudgetUsd).toBe(0.5);
    // A persistent session's query outlives one run, so a native cap would
    // count across runs — the daemon enforces it per run instead.
    expect(providers[1]!.capturedOpts[0]!.maxBudgetUsd).toBeUndefined();
  });

  it("worktree isolation runs the agent in its own git worktree, never the checkout you work in", async () => {
    await create({ worktree: true });
    await call({ type: "routine.run", routine: "triage" });
    await settled();
    const run = ((await call({ type: "routine.get", routine: "triage" })) as RoutineSnapshotMsg).runs![0]!;
    const list = await call({ type: "session.list" });
    const s = list.type === "session.list.result" ? list.sessions.find((x) => x.id === run.sessionId)! : undefined;
    expect(s?.worktree?.branch).toMatch(/^codeoid\/triage-/);
    expect(s?.workdir).not.toBe(repo);
    expect(providers[0]!.capturedOpts[0]!.workdir).toBe(s!.workdir);
  });
});
