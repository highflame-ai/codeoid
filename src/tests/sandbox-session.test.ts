/**
 * A session's OS sandbox (#448), at the session: what it resolves to, the
 * fallback rules, the approval card, the unsandboxed-request approval, the
 * network asks of Claude's own sandbox, and changing the setting. Sandbox
 * providers are fakes with a chosen probe (sandbox-bwrap-real.test.ts runs
 * the real one); the backend is the mock provider under Claude's id.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodeoidConfig } from "../config.js";
import type { ProviderEvent } from "../daemon/providers/interface.js";
import { MockSessionProvider } from "../daemon/providers/mock/session-provider.js";
import { confinementFor } from "../daemon/sandbox/confinement.js";
import { LocalSandboxHandle } from "../daemon/sandbox/local-handle.js";
import { SandboxRegistry } from "../daemon/sandbox/registry.js";
import { resolveSandbox, SandboxRequiredError, SessionSandbox, sandboxRefusalOf, widens } from "../daemon/sandbox/session-sandbox.js";
import { sandboxConfigOf } from "../daemon/sandbox/policy.js";
import { sandboxRoot } from "../daemon/sandbox/root.js";
import type { NetworkMode, SandboxProbe, SandboxProvider, SandboxSpec } from "../daemon/sandbox/types.js";
import { Session, type SessionCreateOptions } from "../daemon/session.js";
import { loadShellParser } from "../daemon/shell/parse.js";
import { Store } from "../daemon/store.js";
import { TranscriptStore } from "../daemon/transcript.js";
import { type AuthContext, CAPABILITIES, type SessionMessage, type SessionMode, type SessionSandboxSetting, type SessionUiRequestMsg } from "../protocol/types.js";

const AUTH: AuthContext = { sub: "u", scopes: [], delegationDepth: 0, accountId: "a", projectId: "p" };
const BASE_CONFIG = {
  workspaceIndex: { enabled: false, episodeThreshold: 5, timeThresholdMs: 60_000, debounceMs: 15_000 },
  compress: { enabled: false, excludeCommands: [], excludePatterns: [], compressPipes: false, minBytes: 1024 },
  labeling: {},
  telemetry: { osc8: "auto" },
  autoRotate: { enabled: false, warnPct: 0.6, rotatePct: 0.8, hardRotatePct: 0.9, minTurnsBeforeRotate: 3, strategy: "task-anchor" },
  session: {},
};

function fakeProvider(id: string, probe: SandboxProbe, network: NetworkMode[] = ["on", "off"], extra: Partial<SandboxProvider["capabilities"]> = {}): SandboxProvider {
  const open = (spec: SandboxSpec) => new LocalSandboxHandle(id, spec, (argv, o) => ({ argv: [...argv], env: o.env }));
  return {
    id,
    displayName: `fake-${id}`,
    capabilities: { isolation: "os", placement: "local", workspace: "mount", stdioProcess: true, commands: true, wrapsArgv: true, network, platforms: ["linux"], ...extra },
    probe: async () => probe,
    open: async (spec) => open(spec),
    openSync: open,
  };
}

function registry(probe: SandboxProbe = { available: true }): SandboxRegistry {
  const r = new SandboxRegistry("linux");
  r.register(fakeProvider("bwrap", probe));
  r.register(fakeProvider("docker", { available: true }));
  return r;
}

let root: string;
let workdir: string;
let store: Store;
let transcriptStore: TranscriptStore;
const sessions: Session[] = [];
let audits: Array<{ action: string; sessionId?: string; detail?: string }> = [];

beforeAll(async () => {
  await loadShellParser();
});

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "codeoid-sbx-session-")));
  workdir = join(root, "work");
  mkdirSync(workdir, { recursive: true });
  store = new Store(join(root, "codeoid.db"));
  audits = [];
  const audit = store.audit.bind(store);
  store.audit = (subject, action, sessionId, detail) => {
    audits.push({ action, ...(sessionId ? { sessionId } : {}), ...(detail ? { detail } : {}) });
    audit(subject, action, sessionId, detail);
  };
  transcriptStore = new TranscriptStore(join(root, "transcripts"));
});

afterEach(async () => {
  for (const s of sessions.splice(0)) await s.destroy(AUTH).catch(() => {});
  try {
    await transcriptStore.flush();
  } catch {}
  try {
    store.close();
  } catch {}
  rmSync(root, { recursive: true, force: true });
});

const DONE: ProviderEvent = { type: "turn_done", result: { providerId: "claude", model: "m", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, totalCostUsd: 0, durationMs: 1 } };

function makeSession(
  provider: MockSessionProvider,
  opts: { mode?: SessionMode; registry?: SandboxRegistry; sandbox?: SessionSandboxSetting; requireSandbox?: boolean; config?: Record<string, unknown> } = {},
) {
  const id = randomUUID();
  store.createSession({
    id,
    name: "sbx",
    workdir,
    status: "idle",
    createdBy: AUTH.sub,
    createdAt: new Date().toISOString(),
    attachedClients: 0,
    accountId: AUTH.accountId,
    projectId: AUTH.projectId,
  });
  const mode = opts.mode ?? "interactive";
  const o: SessionCreateOptions = {
    name: "sbx",
    workdir,
    auth: AUTH,
    store,
    transcriptStore,
    existingId: id,
    _testProvider: provider,
    initialMode: { mode, ...(mode === "autonomous" ? { maxTurns: 10 } : {}) },
    config: { ...BASE_CONFIG, ...(opts.config ?? {}) } as unknown as CodeoidConfig,
    sandboxRegistry: opts.registry ?? registry(),
    ...(opts.sandbox ? { sandbox: opts.sandbox } : {}),
    ...(opts.requireSandbox ? { requireSandbox: true } : {}),
  };
  const session = new Session(o);
  sessions.push(session);
  const cards: SessionMessage[] = [];
  const dialogs: SessionUiRequestMsg[] = [];
  session.attach({
    id: "c",
    auth: AUTH,
    capabilities: [CAPABILITIES.UI_DIALOGS],
    send: (m: { type: string; role?: string }) => {
      if (m.type === "session.message" && m.role === "tool_call") cards.push(structuredClone(m) as SessionMessage);
      if (m.type === "session.ui_request") dialogs.push(structuredClone(m) as SessionUiRequestMsg);
    },
  } as never);
  return { session, cards, dialogs };
}

async function until(cond: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await Bun.sleep(5);
  }
}

type Card = { phase: string; sandboxed?: boolean; sandboxNote?: string };

async function gateCall(name: string, input: Record<string, unknown>, opts: Parameters<typeof makeSession>[1] = {}) {
  const provider = new MockSessionProvider("claude", [[{ type: "tool_start", toolId: "t1", sdkToolUseId: "sdk-t1", name, input, approvalId: "ap-1" }, DONE]]);
  const { session, cards } = makeSession(provider, opts);
  void session.send("go", AUTH).catch(() => {});
  await until(() => provider.canUseToolResults.length > 0 || session.pendingToolApprovals().length > 0);
  const pending = session.pendingToolApprovals();
  const card = cards[0]?.tool?.state as Card | undefined;
  if (pending.length > 0) await session.interrupt(AUTH);
  return { session, asked: pending.length > 0, card, behavior: provider.canUseToolResults[0]?.behavior };
}

describe("what a session's sandbox resolves to", () => {
  test("Claude on bubblewrap: on, Claude's own sandbox with codeoid's policy, enforced", async () => {
    const { session } = makeSession(new MockSessionProvider("claude", [[DONE]]));
    const info = await session.ensureSandbox();
    expect(info).toMatchObject({ choice: "auto", state: "on", provider: "bwrap", network: "on", confinement: "native", isolation: "os", enforced: true });
    expect(session.toInfo().sandbox).toEqual(info as never);
  });

  test("a provider that can't run here: unavailable, with its reason", async () => {
    const { session } = makeSession(new MockSessionProvider("claude", [[DONE]]), { registry: registry({ available: false, reason: "bubblewrap (bwrap) is not installed" }) });
    expect(await session.ensureSandbox()).toMatchObject({ state: "unavailable", reason: "bubblewrap (bwrap) is not installed", enforced: false });
  });

  test("an HTTP backend runs no commands: no-shell, never refused", async () => {
    const { session } = makeSession(new MockSessionProvider("openai", [[DONE]]), { mode: "autonomous", registry: registry({ available: false, reason: "x" }) });
    expect(await session.ensureSandbox()).toMatchObject({ state: "no-shell", enforced: true });
    expect(session.sandboxRefusal()).toBeNull();
  });

  test("the session's setting over the config's; off by the owner is off", async () => {
    const { session } = makeSession(new MockSessionProvider("claude", [[DONE]]), { sandbox: { provider: "off" }, config: { sandbox: { ...sandboxConfigOf(undefined), network: "off" } } });
    expect(await session.ensureSandbox()).toMatchObject({ choice: "off", state: "off", network: "off" });
  });

  test("resolution per backend and provider: process backends keep the network, an allowlist bubblewrap can't hold is off", async () => {
    const r = registry();
    const cfg = sandboxConfigOf(undefined);
    const pi = await resolveSandbox({ registry: r, config: cfg, setting: { network: "off" }, backendId: "pi" });
    expect(pi.info).toMatchObject({ state: "on", confinement: "process", network: "on", networkRequested: "off", enforced: false });
    expect(sandboxRefusalOf(pi.info)).toContain("network off");
    const oc = await resolveSandbox({ registry: r, config: cfg, setting: { network: "allowlist", allowedHosts: ["github.com"] }, backendId: "opencode" });
    expect(oc.info).toMatchObject({ state: "on", confinement: "command", network: "off", networkRequested: "allowlist", enforced: true });
    expect(oc.info.limits?.join(" ")).toContain("can't enforce a host allowlist");
    const claude = await resolveSandbox({ registry: r, config: cfg, setting: { network: "allowlist", allowedHosts: ["github.com"] }, backendId: "claude" });
    expect(claude.info).toMatchObject({ network: "allowlist", allowedHosts: ["github.com"], enforced: true });
    const claudeDocker = await resolveSandbox({ registry: r, config: cfg, setting: { provider: "docker" }, backendId: "claude" });
    expect(claudeDocker.info).toMatchObject({ state: "on", confinement: "process", provider: "docker" });
    const unknown = await resolveSandbox({ registry: r, config: cfg, setting: undefined, backendId: "some-new-backend" });
    expect(unknown.info).toMatchObject({ state: "unavailable" });
    expect(sandboxRefusalOf(unknown.info)).toContain("doesn't know how to sandbox");
  });

  test("the per-backend confinement table", () => {
    const bw = fakeProvider("bwrap", { available: true });
    const sb = fakeProvider("seatbelt", { available: true });
    const dk = fakeProvider("docker", { available: true });
    const kind = (b: string, p: SandboxProvider) => {
      const c = confinementFor(b, p);
      return c.ok ? c.plan.kind : `no: ${c.reason}`;
    };
    expect([kind("claude", bw), kind("claude", sb), kind("claude", dk)]).toEqual(["native", "native", "process"]);
    expect([kind("codex", bw), kind("codex", sb), kind("codex", dk)]).toEqual(["native", "process", "process"]);
    expect([kind("opencode", bw), kind("opencode", sb), kind("opencode", dk)]).toEqual(["command", "command", "command"]);
    for (const b of ["pi", "gemini-cli", "qwen"]) expect(kind(b, bw)).toBe("process");
    for (const b of ["openai", "gemini", "llamacpp", "oai:local"]) expect(kind(b, bw)).toBe("no-shell");
    // A remote provider with no stdio process can't hold a whole CLI.
    const remote = fakeProvider("forge", { available: true }, ["on", "off"], { placement: "remote", workspace: "sync", stdioProcess: false, wrapsArgv: false, isolation: "kernel" });
    expect(kind("pi", remote)).toContain("no:");
    expect(kind("claude", remote)).toContain("no:");
    expect(kind("opencode", remote)).toContain("no:");
  });

  test("what widens: off, a wider network, a new host, another provider", () => {
    const on = { choice: "auto", network: { mode: "on" as const } };
    const off = { choice: "auto", network: { mode: "off" as const } };
    const list = (...h: string[]) => ({ choice: "auto", network: { mode: "allowlist" as const, allow: h } });
    expect(widens(on, { choice: "off", network: { mode: "on" } })).toBe(true);
    expect(widens(off, on)).toBe(true);
    expect(widens(on, off)).toBe(false);
    expect(widens(list("a.com"), list("a.com", "b.com"))).toBe(true);
    expect(widens(list("a.com", "b.com"), list("a.com"))).toBe(false);
    expect(widens(list("a.com"), on)).toBe(true);
    expect(widens(on, { choice: "docker", network: { mode: "on" } })).toBe(true);
    expect(widens({ choice: "off", network: { mode: "on" } }, on)).toBe(false);
  });
});

describe("fallback: unattended work refuses, interactive work says so", () => {
  const unavailable = () => registry({ available: false, reason: "bubblewrap (bwrap) is not installed" });

  test("an autonomous turn doesn't start, and nothing is recorded as sent", async () => {
    const provider = new MockSessionProvider("claude", [[DONE]]);
    const { session } = makeSession(provider, { mode: "autonomous", registry: unavailable() });
    await expect(session.send("go", AUTH)).rejects.toBeInstanceOf(SandboxRequiredError);
    await expect(session.send("go", AUTH)).rejects.toThrow("Not started: not sandboxed: bubblewrap (bwrap) is not installed");
    expect(provider.capturedOpts.length).toBe(0);
    expect(audits.some((a) => a.action === "session.sandbox_refused" && a.sessionId === session.id)).toBe(true);
  });

  test("an unattended run, and a session started for unattended work, don't start either", async () => {
    const a = makeSession(new MockSessionProvider("claude", [[DONE]]), { registry: unavailable() });
    const release = a.session.beginUnattended();
    await expect(a.session.send("go", AUTH)).rejects.toBeInstanceOf(SandboxRequiredError);
    release();
    const b = makeSession(new MockSessionProvider("claude", [[DONE]]), { mode: "guarded", registry: unavailable(), requireSandbox: true });
    await expect(b.session.send("go", AUTH)).rejects.toBeInstanceOf(SandboxRequiredError);
  });

  test("an interactive turn runs, and its approval card says it isn't sandboxed and why", async () => {
    const r = await gateCall("Bash", { command: "ls" }, { registry: unavailable() });
    expect(r.asked).toBe(true);
    expect(r.card).toMatchObject({ phase: "waiting_confirmation", sandboxed: false, sandboxNote: "not sandboxed: bubblewrap (bwrap) is not installed" });
  });

  test("set_mode autonomous is refused while the sandbox can't run (sandboxRefusal for the mode)", async () => {
    const { session } = makeSession(new MockSessionProvider("claude", [[DONE]]), { registry: unavailable() });
    await session.ensureSandbox();
    expect(session.sandboxRefusal()).toBeNull();
    expect(session.sandboxRefusal({ forMode: "autonomous" })).toBe("not sandboxed: bubblewrap (bwrap) is not installed");
  });

  test("the owner's own off runs autonomous: their choice", async () => {
    const provider = new MockSessionProvider("claude", [[DONE]]);
    const { session } = makeSession(provider, { mode: "autonomous", registry: unavailable(), sandbox: { provider: "off" } });
    await session.send("go", AUTH);
    expect(provider.capturedOpts.length).toBe(1);
  });
});

describe("the approval card and the gate", () => {
  test("a shell call on a sandboxed session: sandboxed, with the provider and network", async () => {
    const r = await gateCall("Bash", { command: "ls" });
    expect(r.card).toMatchObject({ sandboxed: true, sandboxNote: "sandboxed: fake-bwrap, network on" });
  });

  test("a Claude file tool runs in the CLI, outside its sandbox: the card says so", async () => {
    const r = await gateCall("Write", { file_path: join(workdir, "a.ts"), content: "x" });
    expect(r.card).toMatchObject({ sandboxed: false, sandboxNote: "runs in the backend's own process, outside the sandbox" });
  });

  test("a command asking to run outside the sandbox is asked about even in autonomous mode, and audited", async () => {
    const r = await gateCall("Bash", { command: "ls", dangerouslyDisableSandbox: true }, { mode: "autonomous" });
    expect(r.asked).toBe(true);
    expect(r.card).toMatchObject({ phase: "waiting_confirmation", sandboxed: false, sandboxNote: "asks to run outside the sandbox" });
    expect(audits.some((a) => a.action === "session.unsandboxed_ask")).toBe(true);
    // The same command, sandboxed, runs unasked in autonomous mode.
    const plain = await gateCall("Bash", { command: "ls" }, { mode: "autonomous" });
    expect(plain.asked).toBe(false);
    expect(plain.behavior).toBe("allow");
  });

  test("Claude's sandbox asking for a host: allowed when the network is on, denied otherwise, never a card to answer", async () => {
    const on = await gateCall("SandboxNetworkAccess", { host: "example.com" }, { mode: "interactive" });
    expect(on.asked).toBe(false);
    expect(on.behavior).toBe("allow");
    const off = await gateCall("SandboxNetworkAccess", { host: "example.com" }, { mode: "interactive", sandbox: { network: "off" } });
    expect(off.asked).toBe(false);
    expect(off.behavior).toBe("deny");
    expect(off.card?.phase).toBe("waiting_confirmation");
  });
});

describe("changing a session's sandbox", () => {
  test("narrowing applies at once and is persisted", async () => {
    const { session } = makeSession(new MockSessionProvider("claude", [[DONE]]));
    await session.ensureSandbox();
    const r = await session.setSandbox({ network: "off" }, AUTH);
    expect(r).toEqual({ ok: true });
    expect(session.sandboxInfo).toMatchObject({ network: "off", state: "on" });
    expect(session.sandboxSetting).toEqual({ network: "off" });
  });

  test("widening (off) is asked on the session; a yes applies it, a no doesn't", async () => {
    const { session, dialogs } = makeSession(new MockSessionProvider("claude", [[DONE]]));
    await session.ensureSandbox();
    let decided: boolean | undefined;
    const r = await session.setSandbox({ provider: "off" }, AUTH, { onDecided: (a) => { decided = a; } });
    expect(r).toEqual({ ok: true, pending: {} });
    expect(session.sandboxInfo?.state).toBe("on");
    expect(dialogs).toHaveLength(1);
    expect(dialogs[0]?.method).toBe("confirm");
    expect(dialogs[0]?.title).toContain("Turn the sandbox off");
    session.resolveUiRequestFromClient(dialogs[0]?.requestId ?? "", { confirmed: false }, AUTH);
    await until(() => decided !== undefined);
    expect(decided).toBe(false);
    expect(session.sandboxInfo?.state).toBe("on");

    decided = undefined;
    await session.setSandbox({ provider: "off" }, AUTH, { onDecided: (a) => { decided = a; } });
    session.resolveUiRequestFromClient(dialogs[1]?.requestId ?? "", { confirmed: true }, AUTH);
    await until(() => decided !== undefined);
    expect(decided as boolean | undefined).toBe(true);
    expect(session.sandboxInfo?.state).toBe("off");
  });

  test("an unattended session can't answer a widening: it is refused", async () => {
    const { session } = makeSession(new MockSessionProvider("claude", [[DONE]]));
    await session.ensureSandbox();
    const release = session.beginUnattended();
    let decided: [boolean, string | undefined] | undefined;
    await session.setSandbox({ provider: "off" }, AUTH, { onDecided: (a, why) => { decided = [a, why]; } });
    await until(() => decided !== undefined);
    expect(decided).toEqual([false, "unattended"]);
    release();
  });

  test("a bad setting is refused", async () => {
    const { session } = makeSession(new MockSessionProvider("claude", [[DONE]]));
    expect(await session.setSandbox({ provider: "firecracker" }, AUTH)).toMatchObject({ ok: false });
    expect(await session.setSandbox({ network: "allowlist", allowedHosts: ["http://x"] }, AUTH)).toMatchObject({ ok: false });
  });

  test("the session's private temp dir is made when a backend first needs it (0700) and removed when the session goes", async () => {
    const sbx = new SessionSandbox({ sessionId: "s/../1", workdir, registry: registry() });
    await sbx.refresh("pi");
    const dir = sbx.runtime?.spec.tempDir ?? "";
    // Under the daemon's private sandbox root, which every sandbox hides.
    expect(dir.startsWith(join(sandboxRoot(), "tmp-s1-"))).toBe(true);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(sandboxRoot()).mode & 0o777).toBe(0o700);
    expect(sbx.runtime?.spec.hidden).toContain(sandboxRoot());
    const h = await sbx.runtime?.open([join(root, "pi-home")]);
    expect(h?.spec.writable).toEqual([join(root, "pi-home")]);
    await sbx.close();
    await sbx.close();
    expect(existsSync(dir)).toBe(false);
    expect(() => h?.wrap?.(["true"], { cwd: "/", env: {} })).toThrow(/closed/);
  });
});

describe("review fixes (#448)", () => {
  test("a changed setting keeps the last runtime until the new one is resolved: never nothing in between", async () => {
    const sbx = new SessionSandbox({ sessionId: "keep", workdir, registry: registry() });
    await sbx.refresh("claude");
    const before = sbx.runtimeFor("claude");
    expect(before).not.toBeNull();
    await sbx.set({ network: "off" });
    expect(sbx.resolvedFor("claude")).toBe(false);
    expect(sbx.runtimeFor("claude")).toBe(before);
    expect(sbx.runtimeFor("codex")).toBeNull();
    await sbx.refresh("claude");
    expect(sbx.runtimeFor("claude")?.spec.network).toEqual({ mode: "off" });
    await sbx.close();
  });

  test("a named launcher is rewritten in place, whole", async () => {
    const sbx = new SessionSandbox({ sessionId: "launch", workdir, registry: registry() });
    await sbx.refresh("opencode");
    const rt = sbx.runtime;
    if (!rt) throw new Error("no runtime");
    const a = rt.launcher(await rt.open([]), ["/bin/echo", "one"], [], "shell");
    const b = rt.launcher(await rt.open([]), ["/bin/echo", "two"], [], "shell");
    expect(a).toBe(b);
    expect(readFileSync(b, "utf8")).toContain("'two'");
    expect(a.startsWith(join(sandboxRoot(), "launch-"))).toBe(true);
    await sbx.close();
  });

  test("Claude under Docker: a dangerouslyDisableSandbox flag leaves nothing, so it isn't the always-ask", async () => {
    const r = await gateCall("Bash", { command: "ls", dangerouslyDisableSandbox: true }, { mode: "autonomous", sandbox: { provider: "docker" } });
    expect(r.asked).toBe(false);
    expect(r.behavior).toBe("allow");
  });

  test("Claude (native): a file-tool write to the project's Claude settings asks in every mode", async () => {
    const r = await gateCall("Write", { file_path: join(workdir, ".claude", "settings.json"), content: "{}" }, { mode: "autonomous" });
    expect(r.asked).toBe(true);
  });

  test("widening is told from what it would really be: a provider that can't run is no sandbox", async () => {
    const reg = new SandboxRegistry("linux");
    reg.register(fakeProvider("bwrap", { available: true }));
    reg.register(fakeProvider("docker", { available: false, reason: "no daemon" }));
    const { session, dialogs } = makeSession(new MockSessionProvider("claude", [[DONE]]), { registry: reg });
    await session.ensureSandbox();
    expect(session.widensSandbox({ provider: "docker" })).toBe(true);
    expect(session.widensSandbox({ network: "off" })).toBe(false);
    await session.setSandbox({ provider: "docker" }, AUTH);
    await until(() => dialogs.length > 0);
    expect(dialogs[0]?.title).toContain("Turn the sandbox off");
    expect(dialogs[0]?.message).toContain("no daemon");
  });
});
