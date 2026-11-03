/**
 * The OS sandbox (#448) through the real SessionManager with mock backends
 * and fake sandbox providers: a session's sandbox on create and in its info,
 * a setting the daemon can't use, `off` needing session:approve, set_mode
 * autonomous refused while the sandbox can't run, set_sandbox (owner only,
 * a widening asked on the session), sandbox.providers, and a loop refused
 * up front.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodeoidConfig } from "../config.js";
import type { ProviderEvent } from "../daemon/providers/interface.js";
import { MockSessionProvider } from "../daemon/providers/mock/session-provider.js";
import { ProviderRegistry } from "../daemon/providers/registry.js";
import { LocalSandboxHandle } from "../daemon/sandbox/local-handle.js";
import { SandboxRegistry } from "../daemon/sandbox/registry.js";
import type { SandboxProbe, SandboxProvider, SandboxSpec } from "../daemon/sandbox/types.js";
import { SessionManager } from "../daemon/session-manager.js";
import { Store } from "../daemon/store.js";
import { TranscriptStore } from "../daemon/transcript.js";
import { ALL_SCOPES } from "../protocol/scopes.js";
import type { AuthContext, DaemonMessage, SessionInfo } from "../protocol/types.js";

const AUTH: AuthContext = { sub: "user:sbx", scopes: [...ALL_SCOPES] as AuthContext["scopes"], delegationDepth: 0, accountId: "acc", projectId: "proj" };
const OTHER: AuthContext = { ...AUTH, sub: "user:other" };
const NO_APPROVE: AuthContext = { ...AUTH, scopes: AUTH.scopes.filter((s) => s !== "session:approve") as AuthContext["scopes"] };
const CLIENT = { id: "cli", auth: AUTH, send: () => {} };

const DONE: ProviderEvent = { type: "turn_done", result: { providerId: "claude", model: "m", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, totalCostUsd: 0, durationMs: 1 } };

function fake(id: string, probe: SandboxProbe): SandboxProvider {
  const open = (spec: SandboxSpec) => new LocalSandboxHandle(id, spec, (argv, o) => ({ argv: [...argv], env: o.env }));
  return {
    id,
    displayName: `fake-${id}`,
    capabilities: { isolation: "os", placement: "local", workspace: "mount", stdioProcess: true, commands: true, wrapsArgv: true, network: ["on", "off"], platforms: ["linux"] },
    probe: async () => probe,
    open: async (s) => open(s),
    openSync: open,
  };
}

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
  } as CodeoidConfig;
}

let tmp: string;
let workdir: string;
let store: Store;
let transcript: TranscriptStore;
let managers: SessionManager[];

function newManager(probe: SandboxProbe = { available: true }): SessionManager {
  const registry = new ProviderRegistry("claude");
  for (const id of ["claude", "openai"]) registry.register({ id, displayName: id, create: () => new MockSessionProvider(id, [[DONE], [DONE]]) });
  const sandboxRegistry = new SandboxRegistry("linux");
  sandboxRegistry.register(fake("bwrap", probe));
  sandboxRegistry.register(fake("docker", { available: false, reason: "the Docker daemon isn't reachable" }));
  const m = new SessionManager(store, transcript, undefined, undefined, undefined, { config: mkConfig(tmp), providers: registry, sandboxRegistry });
  managers.push(m);
  return m;
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "codeoid-sbx-mgr-"));
  workdir = join(tmp, "work");
  mkdirSync(workdir);
  store = new Store(join(tmp, "codeoid.db"));
  transcript = new TranscriptStore(join(tmp, "transcripts"));
  managers = [];
});

afterEach(async () => {
  try {
    await transcript.flush();
  } catch {}
  try {
    store.close();
  } catch {}
  rmSync(tmp, { recursive: true, force: true });
});

async function create(m: SessionManager, extra: Record<string, unknown> = {}, auth: AuthContext = AUTH): Promise<DaemonMessage> {
  return m.handle({ type: "session.create", id: "c", name: `s-${Math.random()}`, workdir, ...extra } as never, auth, { ...CLIENT, auth });
}
const infoOf = (r: DaemonMessage) => (r as { data?: SessionInfo }).data;

describe("SessionManager and the OS sandbox", () => {
  it("a new session's info carries its sandbox, resolved", async () => {
    const m = newManager();
    const r = await create(m);
    expect(r.type).not.toBe("response.error");
    expect(infoOf(r)?.sandbox).toMatchObject({ choice: "auto", state: "on", provider: "bwrap", confinement: "native", enforced: true });
  });

  it("a sandbox that can't run is said at create, as a warning", async () => {
    const m = newManager({ available: false, reason: "bubblewrap (bwrap) is not installed" });
    const r = (await create(m)) as { warnings?: string[] };
    expect(infoOf(r as DaemonMessage)?.sandbox?.state).toBe("unavailable");
    expect(r.warnings).toContain("not sandboxed: bubblewrap (bwrap) is not installed");
  });

  it("a setting the daemon can't use is refused; off needs session:approve", async () => {
    const m = newManager();
    expect(await create(m, { sandbox: { provider: "firecracker" } })).toMatchObject({ type: "response.error", code: "invalid_request" });
    expect(await create(m, { sandbox: { network: "allowlist", allowedHosts: ["not a host"] } })).toMatchObject({ type: "response.error", code: "invalid_request" });
    expect(await create(m, { sandbox: { provider: "off" } }, NO_APPROVE)).toMatchObject({ type: "response.error", code: "forbidden" });
    const off = await create(m, { sandbox: { provider: "off" } });
    expect(infoOf(off)?.sandbox).toMatchObject({ choice: "off", state: "off" });
  });

  it("set_mode autonomous is refused while the sandbox can't run, and allowed when it can", async () => {
    const bad = newManager({ available: false, reason: "bubblewrap (bwrap) is not installed" });
    const id = infoOf(await create(bad))?.id as string;
    const r = await bad.handle({ type: "session.set_mode", id: "m", sessionId: id, mode: "autonomous" }, AUTH, CLIENT);
    expect(r).toMatchObject({ type: "response.error", code: "invalid_request" });
    expect((r as { error: string }).error).toBe("Can't switch to autonomous: not sandboxed: bubblewrap (bwrap) is not installed");
    expect(await bad.handle({ type: "session.set_mode", id: "m", sessionId: id, mode: "guarded" }, AUTH, CLIENT)).toMatchObject({ type: "response.ok" });

    const good = newManager();
    const gid = infoOf(await create(good))?.id as string;
    expect(await good.handle({ type: "session.set_mode", id: "m", sessionId: gid, mode: "autonomous" }, AUTH, CLIENT)).toMatchObject({ type: "response.ok" });
  });

  it("set_sandbox: the owner only, with session:approve; narrowing applies, widening waits for the owner's yes", async () => {
    const m = newManager();
    const id = infoOf(await create(m))?.id as string;
    expect(await m.handle({ type: "session.set_sandbox", id: "x", sessionId: id, sandbox: { network: "off" } }, OTHER, { ...CLIENT, auth: OTHER })).toMatchObject({ code: "forbidden" });
    expect(await m.handle({ type: "session.set_sandbox", id: "x", sessionId: id, sandbox: { network: "off" } }, NO_APPROVE, { ...CLIENT, auth: NO_APPROVE })).toMatchObject({ code: "forbidden" });
    const narrowed = await m.handle({ type: "session.set_sandbox", id: "x", sessionId: id, sandbox: { network: "off" } }, AUTH, CLIENT);
    expect(narrowed).toMatchObject({ type: "response.ok", data: { sandbox: { network: "off" } } });
    const widened = await m.handle({ type: "session.set_sandbox", id: "x", sessionId: id, sandbox: { provider: "off" } }, AUTH, CLIENT);
    expect(widened).toMatchObject({ type: "response.ok", data: { pending: true } });
    expect((widened as { data: { sandbox: { state: string } } }).data.sandbox.state).toBe("on");
    expect(await m.handle({ type: "session.set_sandbox", id: "x", sessionId: id, sandbox: { provider: "nope" } }, AUTH, CLIENT)).toMatchObject({ code: "invalid_request" });
  });

  it("sandbox.providers: each provider, whether it runs here and why not, and the default", async () => {
    const m = newManager();
    const r = (await m.handle({ type: "sandbox.providers", id: "p" }, AUTH, CLIENT)) as { data: Record<string, unknown> };
    expect(r.data).toMatchObject({ enabled: true, auto: "bwrap", default: { provider: "auto", network: "on" } });
    expect(r.data.providers).toEqual([
      { id: "bwrap", displayName: "fake-bwrap", available: true, isolation: "os", placement: "local", workspace: "mount", network: ["on", "off"] },
      { id: "docker", displayName: "fake-docker", available: false, reason: "the Docker daemon isn't reachable", isolation: "os", placement: "local", workspace: "mount", network: ["on", "off"] },
    ]);
  });

  it("a fork keeps its parent's sandbox setting", async () => {
    const m = newManager();
    const parent = infoOf(await create(m, { sandbox: { network: "off" } }));
    expect(parent?.sandbox?.network).toBe("off");
    const fork = await m.handle({ type: "session.fork", id: "f", sessionId: parent?.id as string } as never, AUTH, CLIENT);
    const forkInfo = infoOf(fork);
    expect(forkInfo).toBeDefined();
    await Bun.sleep(20);
    const listed = (await m.handle({ type: "session.list", id: "l" }, AUTH, CLIENT)) as { sessions: SessionInfo[] };
    const f = listed.sessions.find((s) => s.id === forkInfo?.id);
    expect(f?.sandbox?.network).toBe("off");
  });
});
