/**
 * opencode under a routine's spend cap (#447 with #430): through the real
 * SessionManager and Session over the fake-opencode fixture. A turn's cost
 * is opencode's own figure, counted against the cap; a turn whose spend
 * isn't fully known stops a capped routine, and never reads as $0.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodeoidConfig } from "../config.js";
import { OpencodeProvider } from "../daemon/providers/opencode/index.js";
import { OpencodeServer } from "../daemon/providers/opencode/server.js";
import { buildOpencodeEnv } from "../daemon/providers/opencode/policy.js";
import { ProviderRegistry } from "../daemon/providers/registry.js";
import { SessionManager } from "../daemon/session-manager.js";
import { Store } from "../daemon/store.js";
import { TranscriptStore } from "../daemon/transcript.js";
import { ALL_SCOPES } from "../protocol/scopes.js";
import type { AuthContext, DaemonMessage, RoutineSnapshotMsg } from "../protocol/types.js";

const FIXTURE = join(import.meta.dir, "fixtures", "fake-opencode.ts");
const OWNER: AuthContext = { sub: "spiffe://t/user/owner", scopes: [...ALL_SCOPES], delegationDepth: 0, accountId: "acc", projectId: "proj" };
const CLIENT = { id: "c-owner", auth: OWNER, send: () => {} };

let tmp: string;
let repo: string;
let store: Store;
let transcript: TranscriptStore;
let server: OpencodeServer;
let manager: SessionManager;
let config: CodeoidConfig;

const call = (msg: Record<string, unknown>): Promise<DaemonMessage> => manager.handle({ id: "r", ...msg } as never, OWNER, CLIENT);

async function settled(): Promise<void> {
  const svc = manager.routines!;
  for (let i = 0; i < 500; i++) {
    if (svc.store.activeRuns().length === 0) return;
    await Bun.sleep(20);
  }
  throw new Error("routine runs still active");
}

async function runOnce(name: string, prompt: string, cap: Record<string, number>) {
  const res = await call({ type: "routine.create", spec: { name, prompt, workdir: repo, ...cap } });
  if (res.type !== "routine.snapshot") throw new Error(JSON.stringify(res));
  await call({ type: "routine.run", routine: name });
  await settled();
  const got = (await call({ type: "routine.get", routine: name })) as RoutineSnapshotMsg;
  return got.runs![0]!;
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "codeoid-oc-routine-"));
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
  server = new OpencodeServer({ command: process.execPath, argsPrefix: [FIXTURE], dbPath: join(tmp, "opencode", "opencode.db"), env: () => buildOpencodeEnv(), userConfigDir: null });
  const registry = new ProviderRegistry("opencode");
  registry.register({
    id: "opencode",
    displayName: "opencode",
    create: (init) => new OpencodeProvider({ sessionId: init.sessionId, initialBackingId: init.initialBackingId, server, store: init.store }),
  });
  config = {
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
  manager = new SessionManager(store, transcript, undefined, undefined, undefined, { config, providers: registry });
});

afterEach(async () => {
  await manager.drain(2_000).catch(() => {});
  await server.stop();
  await transcript.flush();
  rmSync(tmp, { recursive: true, force: true });
});

describe("opencode under a routine's spend cap (#430)", () => {
  it("counts opencode's own figure: a reply and the title it bills, known", async () => {
    const run = await runOnce("oc-known", "hi", { maxCostUsd: 1 });
    expect(run.status).toBe("succeeded");
    expect(run.costUsd).toBeCloseTo(0.0123 + 0.0007, 6);
    expect(manager.routines!.store.getRun(run.id)!.costUnknown).toBeFalsy();
  });

  it("stops on a turn whose spend isn't known — a step that reported no usage — never reading it as $0", async () => {
    const run = await runOnce("oc-unknown", "no-usage", { maxCostUsd: 1 });
    expect(run.status).toBe("failed");
    expect(manager.routines!.store.getRun(run.id)!.costUnknown).toBe(true);
  });

  it("stops on a turn mixing priced steps with ones opencode billed $0 for", async () => {
    const run = await runOnce("oc-mixed", "zero-cost-mixed", { dailyCostUsd: 5 });
    expect(run.status).toBe("failed");
    expect(manager.routines!.store.getRun(run.id)!.costUnknown).toBe(true);
  });

  it("an uncapped routine on the same turn runs to its end, the cost unknown on the record", async () => {
    const run = await runOnce("oc-uncapped", "no-usage", {});
    expect(run.status).toBe("succeeded");
    expect(manager.routines!.store.getRun(run.id)!.costUnknown).toBe(true);
  });
});

describe("opencode turn costs as Session records them (#430)", () => {
  async function session() {
    const workdir = join(tmp, "work");
    mkdirSync(workdir, { recursive: true });
    const r = await manager.handle({ type: "session.create", id: "c", name: `oc-${Math.random()}`, workdir }, OWNER, CLIENT);
    if (r.type !== "response.ok") throw new Error(JSON.stringify(r));
    const s = manager._sessionForTest((r.data as { id: string }).id)!;
    const send = async (text: string) => {
      await s.send(text, OWNER);
      for (let i = 0; i < 500 && s.status !== "idle" && s.status !== "error"; i++) await Bun.sleep(10);
      await Bun.sleep(30);
    };
    return { s, send };
  }

  it("records opencode's figure, not an estimate; a failed turn's spend once, on that turn", async () => {
    const { s, send } = await session();
    await send("hi");
    let u = s.toInfo().usage!;
    expect(u.totalCostUsd).toBeCloseTo(0.0123 + 0.0007, 6);
    expect(u.costEstimated).toBeUndefined();
    expect(u.costUnknownTurns).toBeUndefined();
    await send("fail");
    expect(s.status).toBe("error");
    await send("hi");
    u = s.toInfo().usage!;
    // Three turns recorded, the failed one at the $0 its refused request cost: nothing counted twice.
    expect(u.numTurns).toBe(3);
    expect(u.totalCostUsd).toBeCloseTo(0.0123 * 2 + 0.0007, 6);
    expect(u.costUnknownTurns).toBeUndefined();
  });

  it("a Stop while the model answers is a turn of unknown cost", async () => {
    const { s, send } = await session();
    await send("hi");
    void s.send("slow", OWNER);
    for (let i = 0; i < 200 && s.status !== "thinking"; i++) await Bun.sleep(10);
    await Bun.sleep(200);
    await s.interrupt(OWNER);
    for (let i = 0; i < 500 && s.status !== "idle"; i++) await Bun.sleep(10);
    await Bun.sleep(50);
    expect(s.toInfo().usage!.costUnknownTurns).toBe(1);
  });

  it("a $0 with tokens is priced as Session prices tokens: unknown with no price, the user's price under pricing.models", async () => {
    const { s, send } = await session();
    await send("hi");
    await send("zero-cost");
    expect(s.toInfo().usage!.costUnknownTurns).toBe(1);
    // A subscription the user calls free, by its opencode model id.
    config.pricing = { models: { "anthropic/claude-sonnet-4": { input: 0, output: 0 } } };
    await send("zero-cost");
    const u = s.toInfo().usage!;
    expect(u.costUnknownTurns).toBe(1);
    expect(u.costEstimated).toBe(true);
    expect(u.totalCostUsd).toBeCloseTo(0.0123 + 0.0007, 6);
  });
});
