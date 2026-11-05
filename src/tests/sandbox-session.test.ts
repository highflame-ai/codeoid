/**
 * A session's OS sandbox (#448), at the session: what it resolves to, the
 * fallback rules, the approval card, the unsandboxed-request approval, the
 * network asks of Claude's own sandbox, and changing the setting. Sandbox
 * providers are fakes with a chosen probe (sandbox-bwrap-real.test.ts runs
 * the real one); the backend is the mock provider under Claude's id.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { CodeoidConfig } from "../config.js";
import type { ProviderEvent } from "../daemon/providers/interface.js";
import { MockSessionProvider } from "../daemon/providers/mock/session-provider.js";
import { confinementFor } from "../daemon/sandbox/confinement.js";
import { LocalSandboxHandle } from "../daemon/sandbox/local-handle.js";
import { SandboxRegistry } from "../daemon/sandbox/registry.js";
import { openCheckSandbox, resolveSandbox, SandboxRequiredError, type SandboxRuntime, SessionSandbox, sandboxRefusalOf, widens } from "../daemon/sandbox/session-sandbox.js";
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
  const r = new SandboxRegistry("linux", HOST_HAS);
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

/** What these tests' host has on PATH: everything (Claude's sandbox needs socat on Linux; whether this machine has it doesn't matter here). */
const HOST_HAS = (name: string) => `/usr/bin/${name}`;

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
  const infos: SessionMessage[] = [];
  const dialogs: SessionUiRequestMsg[] = [];
  session.attach({
    id: "c",
    auth: AUTH,
    capabilities: [CAPABILITIES.UI_DIALOGS],
    send: (m: { type: string; role?: string }) => {
      if (m.type === "session.message" && m.role === "tool_call") cards.push(structuredClone(m) as SessionMessage);
      if (m.type === "session.message" && m.role === "info") infos.push(m as SessionMessage);
      if (m.type === "session.ui_request") dialogs.push(structuredClone(m) as SessionUiRequestMsg);
    },
  } as never);
  return { session, cards, infos, dialogs };
}

async function until(cond: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await Bun.sleep(5);
  }
}

type Card = { phase: string; sandboxed?: boolean; sandboxNote?: string; message?: string; risk?: { reasons: string[] } };

async function gateCall(name: string, input: Record<string, unknown>, opts: Parameters<typeof makeSession>[1] & { backend?: string } = {}) {
  const provider = new MockSessionProvider(opts.backend ?? "claude", [[{ type: "tool_start", toolId: "t1", sdkToolUseId: "sdk-t1", name, input, approvalId: "ap-1" }, DONE]]);
  const { session, cards, infos } = makeSession(provider, opts);
  void session.send("go", AUTH).catch(() => {});
  await until(() => provider.canUseToolResults.length > 0 || session.pendingToolApprovals().length > 0);
  const pending = session.pendingToolApprovals();
  const card = cards[0]?.tool?.state as Card | undefined;
  if (pending.length > 0) await session.interrupt(AUTH);
  const result = provider.canUseToolResults[0] as { behavior?: string; message?: string } | undefined;
  const refusal = infos.find((m) => (m.metadata as { event?: string } | undefined)?.event === "autonomous.refused");
  return { session, asked: pending.length > 0, pending, card, behavior: result?.behavior, message: result?.message, refusal };
}

/** Autonomous mode refused the call outright (#448): never asked, its reason to the agent and on the card, an info line, audited. */
function expectRefused(r: Awaited<ReturnType<typeof gateCall>>, kind: string): void {
  expect([r.asked, r.behavior]).toEqual([false, "deny"]);
  expect(r.message).toStartWith("Refused: autonomous mode doesn't allow ");
  expect(r.message).toContain("The owner can do it, or switch this session to guarded mode to be asked.");
  expect(r.card).toMatchObject({ phase: "cancelled", message: r.message });
  expect(r.refusal?.metadata).toMatchObject({ kind });
  expect(audits.some((a) => a.action === "session.autonomous_refuse" && a.sessionId === r.session.id && a.detail?.endsWith(`kind=${kind}`))).toBe(true);
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

  test("a workspace whose .git names a git dir git's records don't name back says so in the sandbox's limits (#448 round 3)", async () => {
    const ws = mkdtempSync(join(tmpdir(), "codeoid-sbx-sgd-"));
    try {
      writeFileSync(join(ws, ".git"), `gitdir: ${join(ws, "..", "elsewhere.git")}\n`);
      const r = await resolveSandbox({ registry: registry(), config: sandboxConfigOf(undefined), setting: undefined, backendId: "pi", workspace: ws });
      expect(r.info.limits?.join(" ")).toContain("committing from inside fails");
      const plain = await resolveSandbox({ registry: registry(), config: sandboxConfigOf(undefined), setting: undefined, backendId: "pi", workspace: workdir });
      expect(plain.info.limits?.join(" ") ?? "").not.toContain("committing from inside");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("the per-backend confinement table", () => {
    const bw = fakeProvider("bwrap", { available: true });
    const sb = fakeProvider("seatbelt", { available: true });
    const dk = fakeProvider("docker", { available: true });
    const kind = (b: string, p: SandboxProvider) => {
      const c = confinementFor(b, p, { platform: "linux", which: HOST_HAS });
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

  test("a command asking to run outside the sandbox is refused in autonomous mode, never asked; guarded mode asks, audited", async () => {
    const r = await gateCall("Bash", { command: "ls", dangerouslyDisableSandbox: true }, { mode: "autonomous" });
    expectRefused(r, "unsandboxed");
    expect(r.message).toContain("running a command outside the OS sandbox");
    expect(audits.some((a) => a.action === "session.unsandboxed_ask")).toBe(false);
    const guarded = await gateCall("Bash", { command: "ls", dangerouslyDisableSandbox: true }, { mode: "guarded" });
    expect(guarded.asked).toBe(true);
    expect(guarded.card).toMatchObject({ phase: "waiting_confirmation", sandboxed: false, sandboxNote: "asks to run outside the sandbox" });
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
    expect(h?.spec.writable[0]).toBe(join(root, "pi-home"));
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

  test("Claude (native): a file-tool write to the project's Claude settings is refused in autonomous mode, asked in guarded", async () => {
    const write = { file_path: join(workdir, ".claude", "settings.json"), content: "{}" };
    expectRefused(await gateCall("Write", write, { mode: "autonomous" }), "held_write");
    expect((await gateCall("Write", write, { mode: "guarded" })).asked).toBe(true);
  });

  test("Claude (native): a write to a Claude settings file outside the held ones is refused in autonomous mode as a settings write", async () => {
    const r = await gateCall("Write", { file_path: join(root, "elsewhere", ".claude", "settings.local.json"), content: "{}" }, { mode: "autonomous" });
    expectRefused(r, "claude_settings");
    expect(r.message).toContain("a Claude settings file");
  });

  test("a host-side file tool (opencode's) writing the project settings agent CLIs run code from is refused in autonomous mode while the sandbox is on; a backend whose file tools run inside it is held by the sandbox itself (#448 rounds 2, 8)", async () => {
    for (const [backend, name, input] of [
      ["opencode", "Write", { file_path: join(workdir, ".claude", "settings.json"), content: "{}" }],
      ["opencode", "Edit", { file_path: join(workdir, "a.ts"), files: [join(workdir, ".gemini", "settings.json")] }],
      ["opencode", "Write", { file_path: join(workdir, ".mcp.json"), content: "{}" }],
    ] as const) {
      const r = await gateCall(name, input as Record<string, unknown>, { mode: "autonomous", backend });
      expectRefused(r, "held_write");
      expect(r.message).toContain("project settings an agent CLI runs code from");
    }
    // pi's write runs inside the sandbox, which holds `.pi/` read-only: nothing for the gate to refuse.
    const pi = await gateCall("write", { path: ".pi/extensions/x.ts", content: "" }, { mode: "autonomous", backend: "pi" });
    expect([pi.asked, pi.behavior]).toEqual([false, "allow"]);
    // Guarded mode asks, the card saying why.
    const guarded = await gateCall("Write", { file_path: join(workdir, ".mcp.json"), content: "{}" }, { mode: "guarded", backend: "opencode" });
    expect(guarded.asked).toBe(true);
    expect(guarded.pending[0]?.risk?.reasons[0]).toContain("project settings an agent CLI runs code from");
    const plain = await gateCall("Write", { file_path: join(workdir, "src.ts"), content: "" }, { mode: "autonomous", backend: "opencode" });
    expect([plain.asked, plain.behavior]).toEqual([false, "allow"]);
    // The sandbox off: the owner's choice, nothing is held.
    const off = await gateCall("Write", { file_path: join(workdir, ".claude", "settings.json"), content: "{}" }, { mode: "autonomous", backend: "opencode", sandbox: { provider: "off" } });
    expect([off.asked, off.behavior]).toEqual([false, "allow"]);
  });

  test("file tools writing the repository's git structure are refused in autonomous mode while the sandbox is on; guarded mode asks, the card saying why (#448 round 3)", async () => {
    const execFile = (args: string[], cwd: string) => Bun.spawnSync(["git", ...args], { cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } });
    execFile(["init", "-q", "-b", "main"], workdir);
    try {
      const hook = await gateCall("Write", { file_path: join(workdir, ".git", "hooks", "pre-commit"), content: "x" }, { mode: "guarded" });
      expect(hook.asked).toBe(true);
      expect(hook.pending[0]?.risk?.reasons[0]).toContain("the repository's git structure");
      expect(hook.card?.risk?.reasons[0]).toContain("the repository's git structure");
      for (const [backend, name, input] of [
        ["claude", "Write", { file_path: join(workdir, ".git", "hooks", "pre-commit"), content: "x" }],
        ["claude", "Edit", { file_path: join(workdir, ".git", "config"), old_string: "[core]", new_string: "[core]" }],
        ["claude", "Write", { file_path: join(workdir, ".git", "commondir"), content: "x" }],
        ["claude", "NotebookEdit", { notebook_path: join(workdir, ".git", "info", "attributes.ipynb") }],
        ["opencode", "Edit", { file_path: join(workdir, "a.ts"), files: [join(workdir, ".git", "info", "attributes")] }],
      ] as const) {
        const r = await gateCall(name, input as Record<string, unknown>, { mode: "autonomous", backend });
        expectRefused(r, "held_write");
        expect(r.message).toContain("the repository's git structure");
      }
      // pi's write runs inside the sandbox, which holds the git structure itself.
      expect((await gateCall("write", { path: ".git/HEAD", content: "x" }, { mode: "autonomous", backend: "pi" })).behavior).toBe("allow");
      expect((await gateCall("Write", { file_path: join(workdir, "src.ts"), content: "" }, { mode: "autonomous" })).behavior).toBe("allow");
    } finally {
      rmSync(join(workdir, ".git"), { recursive: true, force: true });
      rmSync(join(workdir, "HEAD"), { recursive: true, force: true });
    }
  });

  test("the repository's git settings changed while the session ran: a warning line at the turn's end, and at destroy (#448 round 3)", async () => {
    const run = (args: string[]) => Bun.spawnSync(["git", ...args], { cwd: workdir, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } });
    run(["init", "-q", "-b", "main"]);
    try {
      const provider = new MockSessionProvider("claude", [[DONE], [DONE], [DONE]]);
      const { session } = makeSession(provider);
      const infos: Array<{ text: string; event?: string }> = [];
      session.attach({
        id: "w",
        auth: AUTH,
        capabilities: [],
        send: (m: { type: string; role?: string; content?: string; metadata?: { event?: string } }) => {
          if (m.type === "session.message" && m.role === "info") infos.push({ text: m.content ?? "", event: m.metadata?.event });
        },
      } as never);
      const warned = () => infos.filter((i) => i.event === "sandbox.git_changed");
      await session.send("one", AUTH);
      await until(() => session.status === "idle");
      expect(warned()).toEqual([]);
      // What a command could do during the next turn (here between them: the same look).
      run(["config", "core.fsmonitor", "planted"]);
      writeFileSync(join(workdir, ".git", "hooks", "post-checkout"), "#!/bin/sh\n", { mode: 0o755 });
      await session.send("two", AUTH);
      await until(() => warned().length === 1);
      expect(warned()[0]!.text).toContain(".git/config");
      expect(warned()[0]!.text).toContain(".git/hooks/post-checkout");
      // Said once: the next turn, with nothing changed, says nothing.
      await session.send("three", AUTH);
      await until(() => session.status === "idle");
      expect(warned()).toHaveLength(1);
      run(["config", "core.hooksPath", ".husky/_"]);
      await session.destroy(AUTH);
      expect(warned()).toHaveLength(2);
      expect(warned()[1]!.text).toContain("core.hooksPath");
    } finally {
      rmSync(join(workdir, ".git"), { recursive: true, force: true });
      rmSync(join(workdir, "HEAD"), { recursive: true, force: true });
    }
  });

  test("a commit made during the session that changed project settings (through git plumbing, never in the working tree) is named with its files: at the turn's end, once, and at destroy (#448 round 6)", async () => {
    const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e" };
    const run = (args: string[], extra: Record<string, string> = {}, input?: string) => {
      const r = Bun.spawnSync(["git", ...args], { cwd: workdir, env: { ...env, ...extra }, ...(input !== undefined ? { stdin: new TextEncoder().encode(input) } : {}) });
      if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
      return r.stdout.toString().trim();
    };
    // What an agent can do inside the sandbox: write objects and move a ref, the working tree untouched.
    const plumbingCommit = (path: string, ref: string): string => {
      const index = join(workdir, "..", `index-${Math.random().toString(36).slice(2)}`);
      run(["read-tree", "HEAD"], { GIT_INDEX_FILE: index });
      run(["update-index", "--add", "--cacheinfo", `100644,${run(["hash-object", "-w", "--stdin"], {}, '{"hooks":{}}')},${path}`], { GIT_INDEX_FILE: index });
      const commit = run(["commit-tree", run(["write-tree"], { GIT_INDEX_FILE: index }), "-p", "HEAD", "-m", "x"]);
      run(["update-ref", ref, commit]);
      rmSync(index, { force: true });
      return commit;
    };
    run(["init", "-q", "-b", "main"]);
    writeFileSync(join(workdir, "a"), "a\n");
    run(["add", "a"]);
    run(["commit", "-qm", "init"]);
    try {
      const provider = new MockSessionProvider("claude", [[DONE], [DONE], [DONE]]);
      const { session } = makeSession(provider);
      const infos: Array<{ text: string; event?: string }> = [];
      session.attach({
        id: "w",
        auth: AUTH,
        capabilities: [],
        send: (m: { type: string; role?: string; content?: string; metadata?: { event?: string } }) => {
          if (m.type === "session.message" && m.role === "info") infos.push({ text: m.content ?? "", event: m.metadata?.event });
        },
      } as never);
      const warned = () => infos.filter((i) => i.event === "sandbox.settings_committed");
      await session.send("one", AUTH);
      await until(() => session.status === "idle");
      // What the repository had before the session started isn't named.
      expect(warned()).toEqual([]);
      const planted = plumbingCommit(".claude/settings.json", "refs/heads/main");
      expect(existsSync(join(workdir, ".claude", "settings.json"))).toBe(false);
      await session.send("two", AUTH);
      await until(() => warned().length === 1);
      expect(warned()[0]!.text).toContain(".claude/settings.json");
      expect(warned()[0]!.text).toContain(planted.slice(0, 12));
      // Said once: the next turn, with no new commit, says nothing.
      await session.send("three", AUTH);
      await until(() => session.status === "idle");
      await Bun.sleep(200);
      expect(warned()).toHaveLength(1);
      // A new branch, made just before the session goes.
      const branch = plumbingCommit(".gemini/settings.json", "refs/heads/other");
      await session.destroy(AUTH);
      expect(warned()).toHaveLength(2);
      expect(warned()[1]!.text).toContain(".gemini/settings.json");
      expect(warned()[1]!.text).toContain(branch.slice(0, 12));
      expect(warned()[1]!.text).not.toContain(planted.slice(0, 12));
    } finally {
      rmSync(join(workdir, ".git"), { recursive: true, force: true });
      rmSync(join(workdir, "HEAD"), { recursive: true, force: true });
    }
  });

  test("a destroyed session's backend state (its own conversations, #448 round 2) goes with it", async () => {
    const transcripts = mkdtempSync(join(tmpdir(), "codeoid-sbx-state-"));
    try {
      const { session } = makeSession(new MockSessionProvider("pi", [[DONE]]), { config: { transcriptDir: transcripts } });
      await session.ensureSandbox();
      const state = join(transcripts, "sandbox-state", session.id.replace(/[^A-Za-z0-9_-]/g, ""), "pi", "sessions");
      mkdirSync(state, { recursive: true });
      writeFileSync(join(state, "s.jsonl"), "{}\n");
      await session.destroy(AUTH);
      expect(existsSync(join(transcripts, "sandbox-state", session.id))).toBe(false);
    } finally {
      rmSync(transcripts, { recursive: true, force: true });
    }
  });

  test("widening is told from what it would really be: a provider that can't run is no sandbox", async () => {
    const reg = new SandboxRegistry("linux", HOST_HAS);
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

describe("round 1 of the #448 audit", () => {
  test("Claude on Linux without socat: not sandboxed, with the reason (interactive runs and says so, autonomous is refused) instead of every turn failing", async () => {
    const noSocat = new SandboxRegistry("linux", (n) => (n === "socat" ? null : `/usr/bin/${n}`));
    noSocat.register(fakeProvider("bwrap", { available: true }));
    const interactive = makeSession(new MockSessionProvider("claude", [[DONE]]), { registry: noSocat });
    const info = await interactive.session.ensureSandbox();
    expect(info).toMatchObject({ state: "unavailable", enforced: false });
    expect(info?.reason).toContain("socat");
    await interactive.session.send("go", AUTH);
    const autonomous = makeSession(new MockSessionProvider("claude", [[DONE]]), { mode: "autonomous", registry: noSocat });
    await expect(autonomous.session.send("go", AUTH)).rejects.toThrow(/socat/);
    // Only Claude's own sandbox needs it: pi under the same bubblewrap is on.
    expect((await resolveSandbox({ registry: noSocat, config: sandboxConfigOf(undefined), setting: undefined, backendId: "pi" })).info.state).toBe("on");
    // macOS: Seatbelt needs no socat.
    const mac = fakeProvider("seatbelt", { available: true });
    expect(confinementFor("claude", mac, { platform: "darwin", which: () => null }).ok).toBe(true);
  });

  test("a narrowing set while the first resolution is still probing isn't lost: the last setting is what stands", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const slow: SandboxProvider = {
      ...fakeProvider("bwrap", { available: true }),
      probe: async () => {
        await gate;
        return { available: true };
      },
    };
    const r = new SandboxRegistry("linux", HOST_HAS);
    r.register(slow);
    const sbx = new SessionSandbox({ sessionId: "race", workdir, registry: r });
    let probing = false;
    const probe = slow.probe;
    slow.probe = () => {
      probing = true;
      return probe();
    };
    const first = sbx.refresh("opencode");
    // The first resolution is under way (its setting taken) before the change.
    await until(() => probing);
    await sbx.set({ network: "off" });
    const second = sbx.refresh("opencode");
    release();
    await Promise.all([first, second]);
    expect(sbx.setting).toEqual({ network: "off" });
    expect(sbx.resolvedFor("opencode")).toBe(true);
    expect(sbx.info?.network).toBe("off");
    expect(sbx.runtime?.spec.network).toEqual({ mode: "off" });
    await sbx.close();
  });

  test("a set while a resolution runs is resolved again even with no second refresh asked for", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let probes = 0;
    const slow: SandboxProvider = {
      ...fakeProvider("bwrap", { available: true }),
      probe: async () => {
        if (probes++ === 0) await gate;
        return { available: true };
      },
    };
    const r = new SandboxRegistry("linux", HOST_HAS);
    r.register(slow);
    const sbx = new SessionSandbox({ sessionId: "race2", workdir, registry: r });
    const first = sbx.refresh("opencode");
    await until(() => probes > 0);
    await sbx.set({ network: "off" });
    r.resetProbes();
    release();
    await first;
    expect(sbx.info?.network).toBe("off");
    await sbx.close();
  });

  test("a workspace of / can't be sandboxed: unavailable, with why (and a check there is refused)", async () => {
    const r = registry();
    const at = await resolveSandbox({ registry: r, config: sandboxConfigOf(undefined), setting: undefined, backendId: "pi", workspace: "/" });
    expect(at.info).toMatchObject({ state: "unavailable", enforced: false });
    expect(at.info.reason).toContain("working in /");
    const sbx = new SessionSandbox({ sessionId: "root", workdir: "/", registry: r });
    expect(await sbx.refresh("claude")).toMatchObject({ state: "unavailable" });
    expect(sbx.runtime).toBeNull();
    await sbx.close();
    expect(await openCheckSandbox({ registry: r, config: undefined, setting: undefined, workspace: "/", label: "c" })).toMatchObject({ kind: "refused" });
    // Off is still off: the owner's choice.
    expect((await resolveSandbox({ registry: r, config: sandboxConfigOf(undefined), setting: { provider: "off" }, backendId: "pi", workspace: "/" })).info.state).toBe("off");
  });

  test("a loop check's temp dir is removed when its sandbox fails to open", async () => {
    const r = new SandboxRegistry("linux", HOST_HAS);
    r.register({
      ...fakeProvider("bwrap", { available: true }),
      open: async () => {
        throw new Error("open failed");
      },
    });
    const checks = () => readdirSync(sandboxRoot()).filter((n) => n.startsWith("check-leak"));
    const before = checks().length;
    await expect(openCheckSandbox({ registry: r, config: undefined, setting: undefined, workspace: workdir, label: "leak" })).rejects.toThrow("open failed");
    expect(checks().length).toBe(before);
  });

  test("a closed handle is let go of; a change of setting closes none a backend still uses", async () => {
    const sbx = new SessionSandbox({ sessionId: "handles", workdir, registry: registry() });
    await sbx.refresh("pi");
    const rt = sbx.runtime as SandboxRuntime;
    const a = await rt.open([]);
    const b = rt.openSync([]);
    expect(sbx.openHandles).toBe(2);
    await a.close();
    expect(sbx.openHandles).toBe(1);
    await sbx.set({ network: "off" });
    // Still usable: the backend running in it is restarted when idle, never cut off mid-turn.
    expect(() => b.wrap?.(["true"], { cwd: "/", env: {} })).not.toThrow();
    expect(sbx.openHandles).toBe(1);
    await sbx.close();
    expect(sbx.openHandles).toBe(0);
    expect(() => b.wrap?.(["true"], { cwd: "/", env: {} })).toThrow(/closed/);
  });

  test("a backend's warning (a login not saved back) reaches the session's warning line (#448 round 3)", async () => {
    const said: string[] = [];
    const sbx = new SessionSandbox({ sessionId: "warn", workdir, registry: registry(), onWarning: (t) => said.push(t) });
    await sbx.refresh("pi");
    (sbx.runtime as SandboxRuntime).warn("login not saved");
    expect(said).toEqual(["login not saved"]);
    await sbx.close();
  });

  test("a private home is fresh at each start, and Claude's temp dirs are the session's own, gone with it", async () => {
    const sbx = new SessionSandbox({ sessionId: "homes", workdir, registry: registry() });
    await sbx.refresh("pi");
    const rt = sbx.runtime as SandboxRuntime;
    const home = rt.privateHome("pi");
    writeFileSync(join(home, "planted"), "x");
    expect(rt.privateHome("pi")).toBe(home);
    expect(existsSync(join(home, "planted"))).toBe(false);
    expect(statSync(home).mode & 0o777).toBe(0o700);
    const t = rt.claudeTemp();
    expect(t.commands).toBe(join(t.root, `claude-${process.getuid?.() ?? "user"}`));
    expect(existsSync(t.commands) && existsSync(t.cli)).toBe(true);
    expect(t.cli.startsWith(sandboxRoot())).toBe(true);
    await sbx.close();
    expect(existsSync(home)).toBe(false);
    expect(existsSync(t.cli)).toBe(false);
  });

  test("the sandbox isn't changed while the session is busy (a turn waiting on an approval, background work), so what runs always matches what it says", async () => {
    const provider = new MockSessionProvider("claude", [[{ type: "tool_start", toolId: "t1", sdkToolUseId: "sdk-t1", name: "Bash", input: { command: "ls" }, approvalId: "ap-1" }, DONE], [DONE]]);
    const { session } = makeSession(provider);
    await session.ensureSandbox();
    void session.send("go", AUTH).catch(() => {});
    await until(() => session.pendingToolApprovals().length > 0);
    const busy = await session.setSandbox({ network: "off" }, AUTH);
    expect(busy).toMatchObject({ ok: false });
    expect((busy as { error: string }).error).toContain("busy");
    expect(session.sandboxSetting).toBeUndefined();
    await session.interrupt(AUTH);
    await until(() => !session.pendingToolApprovals().length);
    provider.onSessionEvent?.({ type: "background_tasks", tasks: [{ id: "bg1", kind: "local_bash", description: "dev server", status: "running" }] });
    await until(() => session.toInfo().status === "idle");
    const bg = await session.setSandbox({ network: "off" }, AUTH);
    expect(bg).toMatchObject({ ok: false });
    expect((bg as { error: string }).error).toContain("background work");
  });

  test("a change while idle restarts a backend that ran, before its next turn", async () => {
    const provider = new MockSessionProvider("claude", [[DONE], [DONE]]);
    const { session } = makeSession(provider);
    await session.send("one", AUTH);
    await until(() => session.toInfo().status === "idle");
    expect(provider.hasQueried).toBe(true);
    const before = provider.teardownCount;
    expect(await session.setSandbox({ network: "off" }, AUTH)).toEqual({ ok: true });
    await until(() => provider.teardownCount > before);
    await session.send("two", AUTH);
    expect(provider.capturedOpts).toHaveLength(2);
  });

  test("a widening confirm is answered by the owner alone, with their own token: another member's or a delegated answer is refused, and who answered is audited", async () => {
    const { session, dialogs } = makeSession(new MockSessionProvider("claude", [[DONE]]));
    await session.ensureSandbox();
    let decided: boolean | undefined;
    await session.setSandbox({ provider: "off" }, AUTH, { onDecided: (a) => { decided = a; } });
    const requestId = dialogs[0]?.requestId ?? "";
    const other: AuthContext = { ...AUTH, sub: "someone-else" };
    const delegated: AuthContext = { ...AUTH, delegationDepth: 1 };
    expect(session.resolveUiRequestFromClient(requestId, { confirmed: true }, other)).toBe("forbidden");
    expect(session.resolveUiRequestFromClient(requestId, { confirmed: true }, delegated)).toBe("forbidden");
    expect(session.sandboxInfo?.state).toBe("on");
    expect(audits.filter((a) => a.action === "session.ui_response_refused")).toHaveLength(2);
    expect(session.resolveUiRequestFromClient(requestId, { confirmed: true }, AUTH)).toBe(true);
    await until(() => decided !== undefined);
    expect(decided as boolean | undefined).toBe(true);
    expect(session.sandboxInfo?.state).toBe("off");
  });
});

describe("round 8 of the #448 audit", () => {
  test("a command reaching the home runs in a sandboxed autonomous session (the sandbox hides the credentials), and is refused where it isn't sandboxed; a named credential stays refused everywhere", async () => {
    for (const command of ["ls ~", "echo $HOME", "df -h /", "stat ~", "test -d ~ && echo yes"]) {
      for (const backend of ["claude", "opencode", "pi"]) {
        const r = await gateCall("Bash", { command }, { mode: "autonomous", backend });
        expect([command, backend, r.asked, r.behavior]).toEqual([command, backend, false, "allow"]);
      }
      expectRefused(await gateCall("Bash", { command }, { mode: "autonomous", sandbox: { provider: "off" } }), "credential_dir");
    }
    const named = await gateCall("Bash", { command: `cat ${join(homedir(), ".codeoid", "config.json")}` }, { mode: "autonomous" });
    expect([named.asked, named.behavior]).toEqual([false, "deny"]);
    expect(named.message).toContain("holds credentials");
  });

  test("a pnpm-style hard-linked file in node_modules: edited unasked by a backend whose file tools run inside the sandbox (codex, pi); a host-side tool's edit is still held", async () => {
    mkdirSync(join(workdir, "node_modules", "dep"), { recursive: true });
    mkdirSync(join(root, "store"));
    writeFileSync(join(root, "store", "index.js"), "module.exports = 1;\n");
    linkSync(join(root, "store", "index.js"), join(workdir, "node_modules", "dep", "index.js"));
    const file = join(workdir, "node_modules", "dep", "index.js");
    for (const [backend, name, input] of [
      ["codex", "codex_file_change", { changes: [{ path: file, kind: "update" }] }],
      ["pi", "edit", { path: "node_modules/dep/index.js", oldText: "1", newText: "2" }],
      ["qwen", "edit", { file_path: file, old_string: "1", new_string: "2" }],
    ] as const) {
      const r = await gateCall(name, input as Record<string, unknown>, { mode: "autonomous", backend });
      expect([backend, r.asked, r.behavior]).toEqual([backend, false, "allow"]);
    }
    const claude = await gateCall("Edit", { file_path: file, old_string: "1", new_string: "2" }, { mode: "autonomous" });
    expectRefused(claude, "held_write");
  });});
