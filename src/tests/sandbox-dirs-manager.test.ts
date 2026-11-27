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
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
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

const realHome = process.env.HOME;
function git(args: string[], cwd: string): void {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: cwd, GIT_CONFIG_NOSYSTEM: "1" } });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
}

beforeEach(() => {
  specs = [];
  // Not the host's temp dir (no project root is in one), with a home of the test's own beside it (the projects are
  // in no hidden dir of it).
  const parent = process.env.CODEOID_TEST_SANDBOX_DIR ?? join(homedir(), ".cache");
  mkdirSync(parent, { recursive: true });
  tmp = realpathSync(mkdtempSync(join(parent, "codeoid-sbx-dirs-")));
  process.env.HOME = join(tmp, "home");
  mkdirSync(process.env.HOME);
  // <tmp>/projects/{work,sibling}, each a repository: the default project root is <tmp>/projects.
  root = join(tmp, "projects");
  workdir = join(root, "work");
  sibling = join(root, "sibling");
  elsewhere = join(tmp, "elsewhere");
  for (const d of [workdir, sibling, elsewhere]) mkdirSync(d, { recursive: true });
  for (const d of [workdir, sibling]) git(["init", "-q"], d);
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
  process.env.HOME = realHome;
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
    // The audit row is written as the setting changes; the session's info follows once its sandbox is re-resolved.
    await until(() => (m.findByName(info?.name as string, AUTH)?.toInfo()?.sandbox?.addedDirs?.length ?? 0) > 0);
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
    const home = process.env.HOME as string;
    for (const bad of ["/", home, "~", join(home, ".config"), join(tmp, "missing"), "/usr"]) {
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

describe("an added directory is what it is when granted (#448 round 12)", () => {
  async function autonomous(m: SessionManager) {
    const info = infoOf(await create(m));
    expect(await m.handle({ type: "session.set_mode", id: "m", sessionId: info?.id as string, mode: "autonomous" }, AUTH, CLIENT)).toMatchObject({ type: "response.ok" });
    const session = m.findByName(info?.name as string, AUTH);
    await session?.ensureSandbox();
    return { info, session };
  }

  it("autonomous: a link (its own worktree folder's, leading anywhere of yours) is refused; so are a folder of repositories, a settings or git dir; a repository is added by its real path", async () => {
    const m = newManager();
    const { session } = await autonomous(m);
    // The agent's own worktree folder is writable to it and under the root: a link there, to a dir of yours.
    const folder = join(root, "work-worktrees", "agent-folder");
    mkdirSync(folder, { recursive: true });
    symlinkSync(elsewhere, join(folder, "x"));
    const viaLink = await session?.requestDirectory({ path: join(folder, "x"), reason: "r" });
    expect(viaLink).toContain("Refused:");
    expect(viaLink).toContain("goes through a symbolic link");
    // A plain folder holding repositories: the owner's to add (every repository in it at once).
    const clients = join(root, "clients");
    mkdirSync(join(clients, "beta"), { recursive: true });
    git(["init", "-q"], join(clients, "beta"));
    expect(await session?.requestDirectory({ path: clients, reason: "r" })).toContain(`Refused: ${clients} isn't in a repository`);
    // What runs outside the sandbox: never writable.
    for (const control of [join(sibling, ".claude"), join(sibling, ".git"), join(sibling, ".git", "hooks")]) {
      mkdirSync(control, { recursive: true });
      expect(await session?.requestDirectory({ path: control, reason: "r" })).toContain("Refused:");
    }
    expect(session?.toInfo().sandbox?.addedDirs).toBeUndefined();
    // A repository under the root: added, by where it really is.
    const alias = join(root, "sibling-alias");
    symlinkSync(sibling, alias);
    expect(await session?.requestDirectory({ path: alias, reason: "r" })).toContain("goes through a symbolic link");
    expect(await session?.requestDirectory({ path: join(sibling, "src", "..", "."), reason: "r" })).toContain(`Added: ${sibling}`);
    expect(session?.sandboxSetting?.addedDirs).toEqual([sibling]);
  });

  it("guarded: the owner's card names where a link leads, and what is kept is that directory", async () => {
    const m = newManager();
    const info = infoOf(await create(m));
    const session = m.findByName(info?.name as string, AUTH);
    await session?.ensureSandbox();
    const asked = dialogs(m, info?.name as string);
    const link = join(root, "work-worktrees", "agent-folder", "docs");
    mkdirSync(join(root, "work-worktrees", "agent-folder"), { recursive: true });
    symlinkSync(elsewhere, link);
    const pending = session?.requestDirectory({ path: link, reason: "notes" }) as Promise<string>;
    await until(() => asked.length > 0);
    expect(asked[0]?.title).toBe(`The agent asks to write ${elsewhere}`);
    expect(asked[0]?.message).toContain(`${link} leads there`);
    await m.handle({ type: "session.ui_response", id: "u", sessionId: info?.id as string, requestId: asked[0]?.requestId as string, confirmed: true } as never, AUTH, CLIENT);
    expect(await pending).toContain(`Added: ${elsewhere}`);
    expect(session?.sandboxSetting?.addedDirs).toEqual([elsewhere]);
  });

  it("a folder of repositories added by the owner: the card says their git structure and settings stay read-only", async () => {
    const m = newManager();
    const info = infoOf(await create(m));
    const session = m.findByName(info?.name as string, AUTH);
    await session?.ensureSandbox();
    const clients = join(root, "clients");
    for (const r of ["beta", "gamma"]) {
      mkdirSync(join(clients, r), { recursive: true });
      git(["init", "-q"], join(clients, r));
    }
    const asked = dialogs(m, info?.name as string);
    await m.handle({ type: "session.sandbox_dir", id: "d", sessionId: info?.id as string, action: "add", path: clients }, AUTH, CLIENT);
    await until(() => asked.length > 0);
    expect(asked[0]?.message).toContain("and so do those of the 2 repositories inside it");
  });

  it("replaced by a link after it was granted: dropped at the next build, said and audited, out of the setting; never followed", async () => {
    const m = newManager();
    const { session } = await autonomous(m);
    expect(await session?.requestDirectory({ path: sibling, reason: "r" })).toContain(`Added: ${sibling}`);
    await session?.send("one", AUTH);
    await until(() => session?.toInfo().status === "idle");
    expect(session?.toInfo().sandbox?.addedDirs).toEqual([sibling]);
    // Swapped (by whatever can write its parent) for a link to a dir of yours.
    renameSync(sibling, join(tmp, "moved"));
    symlinkSync(elsewhere, sibling);
    const infos: string[] = [];
    session?.attach({ id: "watch", auth: AUTH, send: (msg: { type: string; role?: string; content?: string }) => void (msg.type === "session.message" && msg.role === "info" && infos.push(String(msg.content))) } as never);
    specs = [];
    await session?.setSandbox({ ...(session?.sandboxSetting ?? {}), network: "off" }, AUTH);
    await session?.ensureSandbox();
    expect(session?.toInfo().sandbox?.addedDirs).toBeUndefined();
    expect(session?.sandboxSetting?.addedDirs ?? []).toEqual([]);
    expect(infos.some((t) => t.includes(`${sibling} is no longer writable`) && t.includes("symbolic link"))).toBe(true);
    expect(audits.some((a) => a.action === "session.sandbox_dir_dropped" && a.detail.startsWith(sibling))).toBe(true);
    for (const spec of specs) expect(spec.writable).not.toContain(elsewhere);
  });

  it("an unattended run in autonomous mode (a routine's, a loop worker's) follows the autonomous rule: a repository under a root, never anything else", async () => {
    const m = newManager();
    const { session } = await autonomous(m);
    const release = session?.beginUnattended();
    try {
      expect(await session?.requestDirectory({ path: elsewhere, reason: "x" })).toContain("isn't under this session's project roots");
      expect(await session?.requestDirectory({ path: sibling, reason: "x" })).toContain(`Added: ${sibling}`);
    } finally {
      release?.();
    }
  });
});
