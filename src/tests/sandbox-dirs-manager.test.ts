/**
 * Working across repositories (docs/sandbox.md, "Working across
 * repositories") through the real SessionManager with mock backends and a
 * fake sandbox provider: a session's project roots and added directories in
 * its info; adding one is the owner's own widening (asked on the session,
 * never a delegated token's or another member's), removing one narrows;
 * create, fork and resume keep them; the agent's `request_directory` asks the
 * owner in guarded mode, is decided by the project roots in autonomous mode,
 * and never parks an unattended run.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { sandboxBadge, sandboxSummary } from "@highflame/codeoid-core";
import type { CodeoidConfig } from "../config.js";
import type { ProviderEvent } from "../daemon/providers/interface.js";
import { MockSessionProvider } from "../daemon/providers/mock/session-provider.js";
import { ProviderRegistry } from "../daemon/providers/registry.js";
import { LocalSandboxHandle } from "../daemon/sandbox/local-handle.js";
import { SandboxRegistry } from "../daemon/sandbox/registry.js";
import type { SandboxProvider, SandboxSpec } from "../daemon/sandbox/types.js";
import { SessionManager } from "../daemon/session-manager.js";
import { Store } from "../daemon/store.js";
import { TranscriptStore } from "../daemon/transcript.js";
import { ALL_SCOPES } from "../protocol/scopes.js";
import { type AuthContext, CAPABILITIES, type DaemonMessage, type SessionInfo } from "../protocol/types.js";

const AUTH: AuthContext = { sub: "user:dirs", scopes: [...ALL_SCOPES] as AuthContext["scopes"], delegationDepth: 0, accountId: "acc", projectId: "proj" };
const OTHER: AuthContext = { ...AUTH, sub: "user:other" };
const NO_APPROVE: AuthContext = { ...AUTH, scopes: AUTH.scopes.filter((s) => s !== "session:approve") as AuthContext["scopes"] };
const DELEGATED: AuthContext = { ...AUTH, delegationDepth: 1, delegatedBy: AUTH.sub } as AuthContext;
const CLIENT = { id: "cli", auth: AUTH, send: () => {} };
const DONE: ProviderEvent = { type: "turn_done", result: { providerId: "claude", model: "m", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, totalCostUsd: 0, durationMs: 1 } };

let specs: SandboxSpec[] = [];
function fake(): SandboxProvider {
  const open = (spec: SandboxSpec) => {
    specs.push(spec);
    return new LocalSandboxHandle("bwrap", spec, (argv, o) => ({ argv: [...argv], env: o.env }));
  };
  return {
    id: "bwrap",
    displayName: "fake-bwrap",
    capabilities: { isolation: "os", placement: "local", workspace: "mount", stdioProcess: true, commands: true, wrapsArgv: true, network: ["on", "off"], platforms: ["linux"] },
    probe: async () => ({ available: true }),
    open: async (s) => open(s),
    openSync: open,
  };
}

let tmp: string;
let root: string;
let workdir: string;
let sibling: string;
let elsewhere: string;
let store: Store;
let transcript: TranscriptStore;
let audits: Array<{ action: string; detail: string }>;

function config(): CodeoidConfig {
  return {
    daemonUrl: "ws://127.0.0.1:7400",
    dbPath: join(tmp, "data", "codeoid.db"),
    transcriptDir: join(tmp, "data", "transcripts"),
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

function newManager(): SessionManager {
  const registry = new ProviderRegistry("claude");
  registry.register({ id: "claude", displayName: "claude", create: () => new MockSessionProvider("claude", [[DONE], [DONE], [DONE]]) });
  const sandboxRegistry = new SandboxRegistry("linux", (n) => `/usr/bin/${n}`);
  sandboxRegistry.register(fake());
  return new SessionManager(store, transcript, undefined, undefined, undefined, { config: config(), providers: registry, sandboxRegistry });
}

beforeEach(() => {
  specs = [];
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "codeoid-sbx-dirs-")));
  // <tmp>/projects/{work,sibling}: the default project root is <tmp>/projects.
  root = join(tmp, "projects");
  workdir = join(root, "work");
  sibling = join(root, "sibling");
  elsewhere = join(tmp, "elsewhere");
  for (const d of [workdir, sibling, elsewhere]) mkdirSync(d, { recursive: true });
  // codeoid's own data beside the projects, never around them (an added dir is never in what the sandbox hides).
  mkdirSync(join(tmp, "data"));
  store = new Store(join(tmp, "data", "codeoid.db"));
  transcript = new TranscriptStore(join(tmp, "data", "transcripts"));
  audits = [];
  const audit = store.audit.bind(store);
  store.audit = (subject, action, sessionId, detail) => {
    audits.push({ action, detail: detail ?? "" });
    audit(subject, action, sessionId, detail);
  };
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
  return m.handle({ type: "session.create", id: "c", name: `s-${Math.random().toString(36).slice(2, 8)}`, workdir, ...extra } as never, auth, { ...CLIENT, auth });
}
const infoOf = (r: DaemonMessage) => (r as { data?: SessionInfo }).data;

/** Every confirm raised on the session, as a client with dialogs sees it. */
function dialogs(m: SessionManager, name: string): Array<{ requestId: string; title: string; message: string }> {
  const asked: Array<{ requestId: string; title: string; message: string }> = [];
  m.findByName(name, AUTH)?.attach({
    id: `dialogs-${Math.random()}`,
    auth: AUTH,
    capabilities: [CAPABILITIES.UI_DIALOGS],
    send: (msg: { type: string; requestId?: string; title?: string; message?: string }) => {
      if (msg.type === "session.ui_request") asked.push({ requestId: msg.requestId ?? "", title: msg.title ?? "", message: msg.message ?? "" });
    },
  } as never);
  return asked;
}

async function until(pred: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !pred(); i++) await Bun.sleep(10);
}

describe("project roots and added directories through the SessionManager", () => {
  it("a session's info carries its project root (the repository's parent by default), and the chip and ls say what it reads", async () => {
    const m = newManager();
    const info = infoOf(await create(m));
    expect(info?.sandbox?.projectRoots).toEqual([root]);
    expect(info?.sandbox?.addedDirs).toBeUndefined();
    expect(sandboxBadge(info?.sandbox)?.title).toContain(`reads ${root}`);
    expect(sandboxSummary(info?.sandbox)).toContain(`reads ${root}`);
    // A session's own roots: none.
    const none = infoOf(await create(m, { sandbox: { projectRoots: [] } }));
    expect(none?.sandbox?.projectRoots).toBeUndefined();
  });

  it("session.sandbox_dir add: the owner's own, with session:approve, undelegated; asked on the session, applied on the owner's yes", async () => {
    const m = newManager();
    const info = infoOf(await create(m));
    const id = info?.id as string;
    for (const who of [OTHER, NO_APPROVE, DELEGATED]) {
      expect(await m.handle({ type: "session.sandbox_dir", id: "d", sessionId: id, action: "add", path: sibling }, who, { ...CLIENT, auth: who })).toMatchObject({ type: "response.error", code: "forbidden" });
    }
    const asked = dialogs(m, info?.name as string);
    expect(await m.handle({ type: "session.sandbox_dir", id: "d", sessionId: id, action: "add", path: sibling }, AUTH, CLIENT)).toMatchObject({ type: "response.ok", data: { pending: true } });
    await until(() => asked.length > 0);
    expect(asked[0]?.title).toBe(`Let "${info?.name}" write ${sibling}?`);
    const requestId = asked[0]?.requestId as string;
    for (const who of [DELEGATED, OTHER]) {
      expect(await m.handle({ type: "session.ui_response", id: "u", sessionId: id, requestId, confirmed: true } as never, who, { ...CLIENT, auth: who })).toMatchObject({ type: "response.error", code: "forbidden" });
    }
    expect(await m.handle({ type: "session.ui_response", id: "u", sessionId: id, requestId, confirmed: true } as never, AUTH, CLIENT)).toMatchObject({ type: "response.ok" });
    await until(() => audits.some((a) => a.action === "session.sandbox_dir_added"));
    expect(audits.find((a) => a.action === "session.sandbox_dir_added")?.detail).toBe(`${sibling} by=owner`);
    const after = m.findByName(info?.name as string, AUTH)?.toInfo();
    expect(after?.sandbox?.addedDirs).toEqual([sibling]);
    expect(sandboxSummary(after?.sandbox)).toContain(`also writes ${sibling}`);
    // Removing narrows: applied, by a delegated token too.
    expect(await m.handle({ type: "session.sandbox_dir", id: "d", sessionId: id, action: "remove", path: sibling }, DELEGATED, { ...CLIENT, auth: DELEGATED })).toMatchObject({ type: "response.ok" });
    expect(m.findByName(info?.name as string, AUTH)?.toInfo().sandbox?.addedDirs).toBeUndefined();
  });

  it("refused: /, the home, a hidden dir of the home, what doesn't exist; already writable: the workspace", async () => {
    const m = newManager();
    const id = infoOf(await create(m))?.id as string;
    const add = (path: string) => m.handle({ type: "session.sandbox_dir", id: "d", sessionId: id, action: "add", path }, AUTH, CLIENT);
    for (const bad of ["/", homedir(), "~", join(homedir(), ".config"), join(tmp, "missing"), "/usr"]) {
      expect(await add(bad)).toMatchObject({ type: "response.error", code: "invalid_request" });
    }
    const inside = await add(join(workdir));
    expect(inside).toMatchObject({ type: "response.ok" });
    expect((inside as { data: { message: string } }).data.message).toContain("in the session's workspace");
  });

  it("create with added dirs and roots of its own: wider than the daemon's, so session:approve and an undelegated token; a fork keeps them for its owner only; a restart keeps them", async () => {
    const m = newManager();
    for (const who of [DELEGATED, NO_APPROVE]) {
      expect(await create(m, { sandbox: { addedDirs: [sibling] } }, who)).toMatchObject({ type: "response.error", code: "forbidden" });
      expect(await create(m, { sandbox: { projectRoots: [elsewhere] } }, who)).toMatchObject({ type: "response.error", code: "forbidden" });
    }
    expect(await create(m, { sandbox: { addedDirs: ["/"] } })).toMatchObject({ type: "response.error", code: "invalid_request" });
    expect(await create(m, { sandbox: { projectRoots: ["~"] } })).toMatchObject({ type: "response.error", code: "invalid_request" });
    // Fewer roots than the daemon's is narrower: anyone who may create.
    expect(infoOf(await create(m, { sandbox: { projectRoots: [] } }, DELEGATED))?.sandbox?.projectRoots).toBeUndefined();
    const info = infoOf(await create(m, { sandbox: { addedDirs: [sibling], projectRoots: ["@parent", elsewhere] } }));
    expect(info?.sandbox).toMatchObject({ addedDirs: [sibling], projectRoots: [root, elsewhere] });
    for (const who of [OTHER, DELEGATED]) {
      expect(await m.handle({ type: "session.fork", id: "f", sessionId: info?.id as string } as never, who, { ...CLIENT, auth: who })).toMatchObject({ type: "response.error", code: "forbidden" });
    }
    const fork = infoOf(await m.handle({ type: "session.fork", id: "f", sessionId: info?.id as string } as never, AUTH, CLIENT));
    await Bun.sleep(20);
    const listed = (await m.handle({ type: "session.list", id: "l" }, AUTH, CLIENT)) as { sessions: SessionInfo[] };
    expect(listed.sessions.find((s) => s.id === fork?.id)?.sandbox?.addedDirs).toEqual([sibling]);

    // The daemon restarts: the session comes back with them.
    await transcript.flush();
    const next = newManager();
    await next.resumeSessions();
    const back = next.findByName(info?.name as string, AUTH);
    await back?.ensureSandbox();
    expect(back?.toInfo().sandbox).toMatchObject({ addedDirs: [sibling], projectRoots: [root, elsewhere] });
  });

  it("request_directory, guarded: the owner is asked with the directory and the reason; yes adds it, no refuses it", async () => {
    const m = newManager();
    const info = infoOf(await create(m));
    const session = m.findByName(info?.name as string, AUTH);
    await session?.ensureSandbox();
    const asked = dialogs(m, info?.name as string);
    const pending = session?.requestDirectory({ path: sibling, reason: "update the shared types" }) as Promise<string>;
    await until(() => asked.length > 0);
    expect(asked[0]?.title).toBe(`The agent asks to write ${sibling}`);
    expect(asked[0]?.message).toContain("Its reason: update the shared types");
    // Not the agent's own token, nor anyone else's: the owner answers.
    expect(await m.handle({ type: "session.ui_response", id: "u", sessionId: info?.id as string, requestId: asked[0]?.requestId as string, confirmed: true } as never, DELEGATED, { ...CLIENT, auth: DELEGATED })).toMatchObject({ code: "forbidden" });
    await m.handle({ type: "session.ui_response", id: "u", sessionId: info?.id as string, requestId: asked[0]?.requestId as string, confirmed: true } as never, AUTH, CLIENT);
    const text = await pending;
    expect(text).toContain(`Added: ${sibling} is writable to your commands from your next turn`);
    expect(session?.toInfo().sandbox?.addedDirs).toEqual([sibling]);
    expect(audits.find((a) => a.action === "session.sandbox_dir_added")?.detail).toContain("by=agent the owner approved reason=update the shared types");

    const declined = session?.requestDirectory({ path: elsewhere, reason: "why not" }) as Promise<string>;
    await until(() => asked.length > 1);
    await m.handle({ type: "session.ui_response", id: "u", sessionId: info?.id as string, requestId: asked[1]?.requestId as string, confirmed: false } as never, AUTH, CLIENT);
    expect(await declined).toBe("Refused: the owner declined.");
    expect(session?.toInfo().sandbox?.addedDirs).toEqual([sibling]);
  });

  it("request_directory, autonomous: under a project root it is added unasked (audited); elsewhere refused at once, with a reason; never parks", async () => {
    const m = newManager();
    const info = infoOf(await create(m));
    const id = info?.id as string;
    expect(await m.handle({ type: "session.set_mode", id: "m", sessionId: id, mode: "autonomous" }, AUTH, CLIENT)).toMatchObject({ type: "response.ok" });
    const session = m.findByName(info?.name as string, AUTH);
    await session?.ensureSandbox();
    const asked = dialogs(m, info?.name as string);
    expect(await session?.requestDirectory({ path: sibling, reason: "fix the client too" })).toContain(`Added: ${sibling}`);
    expect(audits.find((a) => a.action === "session.sandbox_dir_added")?.detail).toContain("under a project root, autonomous");
    const refused = await session?.requestDirectory({ path: elsewhere, reason: "needs it" });
    expect(refused).toContain(`Refused: ${elsewhere} isn't under this session's project roots (${root})`);
    expect(refused).toContain(`/sandbox add ${elsewhere}`);
    expect(asked).toHaveLength(0);
    expect(session?.toInfo().sandbox?.addedDirs).toEqual([sibling]);
    expect(await session?.requestDirectory({ path: homedir(), reason: "all of it" })).toContain("Refused:");
    // The root itself (every repository in it) is the owner's to add, not the agent's unasked.
    expect(await session?.requestDirectory({ path: root, reason: "everything" })).toContain(`Refused: ${root} isn't under this session's project roots`);
  });

  it("request_directory on an unattended run (a routine, a loop) in guarded mode: refused, not parked", async () => {
    const m = newManager();
    const info = infoOf(await create(m));
    const session = m.findByName(info?.name as string, AUTH);
    await session?.ensureSandbox();
    const release = session?.beginUnattended();
    try {
      expect(await session?.requestDirectory({ path: sibling, reason: "x" })).toContain("Refused: nobody is there to approve it in this unattended run");
    } finally {
      release?.();
    }
    expect(session?.toInfo().sandbox?.addedDirs).toBeUndefined();
  });
});
