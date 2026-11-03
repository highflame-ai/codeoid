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
import { type AuthContext, CAPABILITIES, type DaemonMessage, type SessionInfo } from "../protocol/types.js";

const AUTH: AuthContext = { sub: "user:sbx", scopes: [...ALL_SCOPES] as AuthContext["scopes"], delegationDepth: 0, accountId: "acc", projectId: "proj" };
const OTHER: AuthContext = { ...AUTH, sub: "user:other" };
const NO_APPROVE: AuthContext = { ...AUTH, scopes: AUTH.scopes.filter((s) => s !== "session:approve") as AuthContext["scopes"] };
const CLIENT = { id: "cli", auth: AUTH, send: () => {} };

/** What these tests' host has on PATH: everything (Claude's sandbox needs socat on Linux; whether this machine has it doesn't matter here). */
const HOST_HAS = (name: string) => `/usr/bin/${name}`;

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

function newManager(probe: SandboxProbe = { available: true }, sandbox?: Record<string, unknown>): SessionManager {
  const registry = new ProviderRegistry("claude");
  for (const id of ["claude", "openai"]) registry.register({ id, displayName: id, create: () => new MockSessionProvider(id, [[DONE], [DONE]]) });
  const sandboxRegistry = new SandboxRegistry("linux", HOST_HAS);
  sandboxRegistry.register(fake("bwrap", probe));
  sandboxRegistry.register(fake("docker", { available: false, reason: "the Docker daemon isn't reachable" }));
  const config = { ...mkConfig(tmp), ...(sandbox ? { sandbox: { provider: "auto", network: "on", allowedHosts: [], hiddenPaths: [], homeReadable: [], docker: { image: "x" }, ...sandbox } } : {}) } as CodeoidConfig;
  const m = new SessionManager(store, transcript, undefined, undefined, undefined, { config, providers: registry, sandboxRegistry });
  managers.push(m);
  return m;
}

/** A manager whose daemon-wide sandbox default is `sandbox` (over auto, network on). */
function newManagerWith(sandbox: Record<string, unknown>): SessionManager {
  return newManager({ available: true }, sandbox);
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

  it("a provider named explicitly that can't run here is refused (it would be no sandbox at all); auto still runs, and says so", async () => {
    const m = newManager();
    const r = await create(m, { sandbox: { provider: "docker" } });
    expect(r).toMatchObject({ type: "response.error", code: "invalid_request" });
    expect((r as { error: string }).error).toContain("the docker sandbox can't run here: the Docker daemon isn't reachable");
    const id = infoOf(await create(m))?.id as string;
    expect(await m.handle({ type: "session.set_sandbox", id: "x", sessionId: id, sandbox: { provider: "docker" } }, AUTH, CLIENT)).toMatchObject({ code: "invalid_request" });
  });

  it("a delegated token can't widen a session's sandbox (it could answer its own confirm); it can narrow it", async () => {
    const m = newManager();
    const id = infoOf(await create(m))?.id as string;
    const delegated: AuthContext = { ...AUTH, delegationDepth: 1, delegatedBy: AUTH.sub } as AuthContext;
    expect(await m.handle({ type: "session.set_sandbox", id: "x", sessionId: id, sandbox: { network: "off" } }, delegated, { ...CLIENT, auth: delegated })).toMatchObject({ type: "response.ok" });
    const wider = await m.handle({ type: "session.set_sandbox", id: "x", sessionId: id, sandbox: { network: "on" } }, delegated, { ...CLIENT, auth: delegated });
    expect(wider).toMatchObject({ type: "response.error", code: "forbidden" });
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

describe("round 1 of the #448 audit: wider than the daemon's sandbox is the owner's own", () => {
  const DELEGATED: AuthContext = { ...AUTH, delegationDepth: 1, delegatedBy: AUTH.sub } as AuthContext;
  let audits: Array<{ action: string; detail: string }> = [];
  beforeEach(() => {
    audits = [];
    const audit = store.audit.bind(store);
    store.audit = (subject, action, sessionId, detail) => {
      audits.push({ action, detail: detail ?? "" });
      audit(subject, action, sessionId, detail);
    };
  });
  const audited = (action: string) => audits.filter((a) => a.action === action);

  it("create: off, a wider network or another provider needs session:approve and an undelegated token; narrower needs neither", async () => {
    const m = newManagerWith({ network: "off" });
    for (const sandbox of [{ provider: "off" }, { network: "on" }, { provider: "bwrap" }, { network: "allowlist", allowedHosts: ["github.com"] }]) {
      const r = await create(m, { sandbox }, DELEGATED);
      expect(r).toMatchObject({ type: "response.error", code: "forbidden" });
      expect(await create(m, { sandbox }, NO_APPROVE)).toMatchObject({ type: "response.error", code: "forbidden" });
    }
    expect(audited("session.sandbox_wider_refused").length).toBeGreaterThan(0);
    // The daemon's own, or narrower: anyone who may create.
    expect(infoOf(await create(m, { sandbox: { network: "off" } }, DELEGATED))?.sandbox?.network).toBe("off");
    expect(infoOf(await create(m, {}, DELEGATED))?.sandbox?.state).toBe("on");
    // The owner, undelegated: as before.
    expect(infoOf(await create(m, { sandbox: { provider: "off" } }))?.sandbox?.state).toBe("off");
  });

  it("a fork carries a wider sandbox only for its owner, undelegated; a narrower one for anyone in the tenant", async () => {
    const m = newManager();
    const off = infoOf(await create(m, { sandbox: { provider: "off" } }))?.id as string;
    expect(await m.handle({ type: "session.fork", id: "f", sessionId: off } as never, OTHER, { ...CLIENT, auth: OTHER })).toMatchObject({ type: "response.error", code: "forbidden" });
    expect(await m.handle({ type: "session.fork", id: "f", sessionId: off } as never, DELEGATED, { ...CLIENT, auth: DELEGATED })).toMatchObject({ type: "response.error", code: "forbidden" });
    expect((await m.handle({ type: "session.fork", id: "f", sessionId: off } as never, AUTH, CLIENT)).type).not.toBe("response.error");
    const narrow = infoOf(await create(m, { sandbox: { network: "off" } }))?.id as string;
    expect((await m.handle({ type: "session.fork", id: "f", sessionId: narrow } as never, OTHER, { ...CLIENT, auth: OTHER })).type).not.toBe("response.error");
  });

  it("the turn-off confirm is answered only by the owner's own token, through the manager too", async () => {
    const m = newManager();
    const info = infoOf(await create(m));
    const id = info?.id as string;
    const asked: Array<{ requestId: string }> = [];
    m.findByName(info?.name as string, AUTH)?.attach({
      id: "dialogs",
      auth: AUTH,
      capabilities: [CAPABILITIES.UI_DIALOGS],
      send: (msg: { type: string; requestId?: string }) => {
        if (msg.type === "session.ui_request") asked.push({ requestId: msg.requestId ?? "" });
      },
    } as never);
    expect(await m.handle({ type: "session.set_sandbox", id: "x", sessionId: id, sandbox: { provider: "off" } }, AUTH, CLIENT)).toMatchObject({ data: { pending: true } });
    for (let i = 0; i < 100 && asked.length === 0; i++) await Bun.sleep(10);
    const requestId = asked[0]?.requestId ?? "";
    expect(requestId).not.toBe("");
    for (const who of [DELEGATED, OTHER]) {
      expect(await m.handle({ type: "session.ui_response", id: "u", sessionId: id, requestId, confirmed: true } as never, who, { ...CLIENT, auth: who })).toMatchObject({ type: "response.error", code: "forbidden" });
    }
    expect(await m.handle({ type: "session.ui_response", id: "u", sessionId: id, requestId, confirmed: true } as never, AUTH, CLIENT)).toMatchObject({ type: "response.ok" });
    for (let i = 0; i < 100 && audited("session.set_sandbox").length === 0; i++) await Bun.sleep(10);
    expect(audited("session.set_sandbox").at(-1)?.detail).toContain("→ off");
  });

  it("a delegated token can't change the daemon's sandbox settings, and is audited", async () => {
    const m = newManager();
    for (const key of ["sandbox.provider", "sandbox.bwrapPath", "sandbox.docker.image", "sandbox.homeReadable"]) {
      const r = await m.handle({ type: "settings.set", id: "s", patches: [{ key, value: "off" }] } as never, DELEGATED, { ...CLIENT, auth: DELEGATED });
      expect(r).toMatchObject({ type: "response.error", code: "forbidden" });
      expect((r as { error: string }).error).toContain("sandbox");
    }
    expect(audited("settings.set.denied").some((a) => a.detail.includes("sandbox.provider") && a.detail.includes("delegated"))).toBe(true);
  });

  it("a session whose sandbox is off is made autonomous only by its owner's own token", async () => {
    const m = newManager();
    const id = infoOf(await create(m, { sandbox: { provider: "off" } }))?.id as string;
    expect(await m.handle({ type: "session.set_mode", id: "m", sessionId: id, mode: "autonomous" }, DELEGATED, { ...CLIENT, auth: DELEGATED })).toMatchObject({ code: "forbidden" });
    expect(await m.handle({ type: "session.set_mode", id: "m", sessionId: id, mode: "autonomous" }, OTHER, { ...CLIENT, auth: OTHER })).toMatchObject({ code: "forbidden" });
    expect(await m.handle({ type: "session.set_mode", id: "m", sessionId: id, mode: "autonomous" }, AUTH, CLIENT)).toMatchObject({ type: "response.ok" });
  });
});
