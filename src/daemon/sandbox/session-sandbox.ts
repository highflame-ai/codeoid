/**
 * One session's sandbox (#448): the setting it carries, what that resolves
 * to for its backend on this machine ({@link SessionSandboxInfo}), its
 * private temp dir, and the handles opened for it.
 *
 * Resolution: the session's setting over the daemon's `sandbox.*`; the
 * provider (`auto` is the platform's own) and whether it runs here; how
 * the backend is put inside it (confinement.ts); the network that can be
 * enforced that way. Narrowing is never silent and widening never happens
 * unseen: an allowlist a provider can't enforce runs with the network off
 * (and says so); a backend that needs the network to reach its model keeps
 * it on, and the session is then not `enforced`, so nothing unattended
 * starts on it.
 */

import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { SessionSandboxInfo, SessionSandboxSetting } from "../../protocol/types.js";
import { type CodeoidConfig, getConfigDir } from "../../config.js";
import type { ClaudeTempDirs } from "./claude-native.js";
import { type ConfinementPlan, confinementFor, runsNoCommands } from "./confinement.js";
import { GIT_BIN } from "../git-env.js";
import { CWD_FROM_CALLER } from "./docker.js";
import { buildSandboxSpec, dockerSocketPaths, gitLayoutOf, gitLayoutProblem, hiddenPathsFor, networkPolicyOf, type SandboxConfig, sandboxConfigOf, sandboxWorkspaceOf, unconnectableDockerSockets, validAllowedHost } from "./policy.js";
import {
  addedDirProblem,
  addedDirReal,
  linkInPath,
  nestedControl,
  normalizeSandboxDir,
  PROJECT_ROOT_PARENT,
  PROJECT_ROOT_SCAN_LIMIT,
  projectRootSecretsAsync,
  repositoryOfConfig,
  type RootScan,
  rootScanKey,
  resolveProjectRoots,
  SCAN_SKIPPED_DIRS,
  stillRealDir,
} from "./project-roots.js";
import { ENTRY_GRACE_MS, WorktreeEntryGuard, type WorktreeEntryFinding } from "./worktree-entries.js";
import { inPinnedDirSync, type PinnedDir, pinDir, realPathOnce, removeEmptyDir, pinProblem, pinRecord, pinRefusal, pinsProblem, SandboxPinError, unguardedArgv } from "./pinned.js";
import { existingFolderName, mainCheckoutOf, sessionFolderName, worktreeFoldersOf, worktreeLocationDirs, worktreeRootNotes } from "./worktrees.js";
import type { SandboxRegistry } from "./registry.js";
import { cliWorktrees, gitProgramLocations, gitShimSpec, writeGitShim } from "./git-shim.js";
import { launcherRoot, sandboxRoot } from "./root.js";
import {
  type NetworkMode,
  type NetworkPolicy,
  SANDBOX_AUTO,
  SANDBOX_OFF,
  type SandboxExecOptions,
  type SandboxExecResult,
  type SandboxHandle,
  type SandboxProvider,
  type SandboxSpawnOptions,
  type SandboxSpec,
} from "./types.js";

/**
 * What Docker access also lets a command reach under Claude's own Linux
 * sandbox, which can't allow a single socket (`allowAllUnixSockets`): the
 * limits line says it (docs/sandbox.md, Docker access).
 */
export const CLAUDE_ALL_SOCKETS_NOTE =
  "on Claude's Linux sandbox that lets a command connect to any unix socket it can see: the host's /tmp, the desktop's runtime dir, the system bus and every other runtime's socket are hidden, and local databases' (Postgres, MySQL, Redis) while the network is off, but a socket in the workspace, in what your home shows (sandbox.homeReadable) or in a system dir open to every user (systemd's journal, printing; a database's with the network on) is reachable";

/** A session's sandbox can't satisfy what an unattended or autonomous run needs. */
export class SandboxRequiredError extends Error {
  override name = "SandboxRequiredError";
}

/**
 * Why an autonomous session, a routine or a loop can't start on `info`, or
 * null: a sandbox asked for that can't run here, or one that can't hold what
 * was asked (the network). One the owner turned off runs (their choice,
 * itself an approval); a backend that runs no commands needs none.
 */
export function sandboxRefusalOf(info: SessionSandboxInfo): string | null {
  if (info.state === "unavailable") return `not sandboxed: ${info.reason ?? "the sandbox can't run here"}`;
  if (info.state === "on" && !info.enforced) {
    const why = info.limits?.find((l) => l.includes("network")) ?? "the sandbox can't hold what was asked";
    return `the sandbox can't enforce network ${info.networkRequested ?? info.network}: ${why}`;
  }
  return null;
}

export interface OpenOptions {
  /**
   * The backend's own process talks to its model from inside: the network is
   * on for the handle, while the backend's own sandbox holds its commands to
   * the session's network (Codex's).
   */
  backendNetwork?: boolean;
  /** Read-only locations the backend's process needs that would otherwise be hidden or under the host's /tmp (its own program). */
  readable?: readonly string[];
}

/** What a resolved, running sandbox gives a backend. */
export interface SandboxRuntime {
  readonly info: SessionSandboxInfo;
  readonly plan: ConfinementPlan;
  readonly provider: SandboxProvider;
  readonly config: SandboxConfig;
  /** The spec commands run under (no backend state). */
  readonly spec: SandboxSpec;
  /**
   * A handle whose spec also lets the backend's own process reach its state
   * (`backendState`: its home, login, sessions). Closed with the session or
   * when the sandbox is changed.
   */
  open(backendState?: readonly string[], opts?: OpenOptions): Promise<SandboxHandle>;
  /** The same, for a caller that can't wait (a spawn callback); local providers only. */
  openSync(backendState?: readonly string[], opts?: OpenOptions): SandboxHandle;
  /**
   * An executable that runs `argv` inside `handle` with the arguments it is
   * given appended, in the directory it is started from, for a spawner
   * codeoid doesn't control (an SDK that takes a path to its CLI, opencode's
   * shell). Written to a daemon-private dir outside anything the sandbox can
   * write; removed with the session. `envNames`: the variables its caller
   * passes that must reach the program (a provider that copies them by name,
   * Docker's `-e NAME`). `name`: rewrite that launcher in place (atomically)
   * rather than add one — a caller that refreshes it as the filesystem
   * changes (a hidden path that appeared or went).
   */
  launcher(handle: SandboxHandle, argv: readonly string[], envNames?: readonly string[], name?: string): string;
  /**
   * A fresh, empty, private directory for the backend's own home inside the
   * sandbox (backend-home.ts), the same path for the same `key` each time:
   * what was there from its last start is gone.
   */
  privateHome(key: string): string;
  /**
   * The session's own dir for what its backend keeps across starts (its
   * conversations: backend-home.ts), the same for the same `key` each time:
   * under the daemon's transcripts (hidden from every sandbox but this
   * session's backend), removed with the session.
   */
  stateDir(key: string): string;
  /** Claude's native sandbox: where its CLI and its commands keep temp files (claude-native.ts). */
  claudeTemp(): ClaudeTempDirs;
  /** Say something on the session (a warning line): a login not written back from the sandbox (backend-home.ts). */
  warn(text: string): void;
  /**
   * A dir to put first on the `PATH` of a backend CLI that runs outside the
   * sandbox (Claude's, under its own sandbox): its `git` runs the real one
   * inside this sandbox, offline, with an environment of its own and a
   * fresh temp dir per git (git-shim.ts), so a
   * repository a command planted runs nothing on the host. The same dir for
   * the runtime's life; `caller` names the CLI in the script.
   */
  gitShim(caller: string): string;
}

/** A sandbox setting with the config filled in: the provider choice, the network, and whether commands reach the container runtime. */
export interface EffectiveSandbox {
  choice: string;
  network: NetworkPolicy;
  /** The host's container runtime socket is reachable (`sandbox.docker.socket` / the session's `dockerSocket`): root-equivalent. */
  dockerSocket: boolean;
  /** Project roots as set (`@parent`, or absolute with `~` expanded): readable (project-roots.ts). */
  projectRoots: string[];
  /** Directories the session writes besides its workspace, absolute. */
  addedDirs: string[];
  /** Those the agent added itself (an autonomous `request_directory`): a project root's credential hiding stays in them. */
  agentDirs: string[];
}

/** The setting a session ends up with: its own fields over the config's. */
export function effectiveSetting(config: SandboxConfig, setting: SessionSandboxSetting | undefined): EffectiveSandbox {
  const choice = setting?.provider ?? config.provider;
  const network = networkPolicyOf(config, {
    ...(setting?.network ? { mode: setting.network } : {}),
    ...(setting?.allowedHosts ? { allow: setting.allowedHosts } : {}),
  });
  const home = process.env.HOME ?? homedir();
  const roots = (setting?.projectRoots ?? config.projectRoots ?? [PROJECT_ROOT_PARENT]).map((r) => (r === PROJECT_ROOT_PARENT ? r : (normalizeSandboxDir(r, home) ?? r)));
  const added = (setting?.addedDirs ?? []).map((d) => normalizeSandboxDir(d, home)).filter((d): d is string => d !== null);
  const agent = new Set((setting?.agentDirs ?? []).map((d) => normalizeSandboxDir(d, home)));
  return {
    choice,
    network,
    dockerSocket: setting?.dockerSocket ?? config.docker.socket ?? false,
    projectRoots: [...new Set(roots)],
    addedDirs: [...new Set(added)],
    agentDirs: [...new Set(added)].filter((d) => agent.has(d)),
  };
}

/**
 * `setting` with each added directory `before` didn't have kept by where it
 * really is now, when it is granted (project-roots.ts `addedDirReal`), and
 * pinned there (pinned.ts: what it is, `dev:ino`): what is bound is that
 * directory, never where a link there leads later, nor another one put in
 * its place. One already kept stays as it was (a link put there since is
 * dropped at the next build, never followed). An added dir inside another
 * one isn't kept twice (the outer holds it). The agent's own (`agentDirs`)
 * are those still added.
 */
export function canonicalAddedDirs(setting: SessionSandboxSetting, before?: SessionSandboxSetting): SessionSandboxSetting {
  if (!setting.addedDirs) {
    if (!setting.agentDirs) return setting;
    const { agentDirs: _a, ...rest } = setting;
    return rest;
  }
  const had = new Set(before?.addedDirs ?? []);
  const unique = [...new Set(setting.addedDirs.map((d) => (had.has(d) ? d : (addedDirReal(d) ?? d))))];
  const inside = (d: string, o: string) => d !== o && d.startsWith(o.endsWith("/") ? o : `${o}/`);
  const dirs = unique.filter((d) => !unique.some((o) => inside(d, o)));
  const ids: Record<string, string> = { ...(setting.pins?.ids ?? before?.pins?.ids ?? {}) };
  // A dir no longer added has no pin; one granted now is pinned as it is now (a grant again is a grant anew).
  for (const d of before?.addedDirs ?? []) if (!dirs.includes(d)) delete ids[d];
  for (const d of dirs) {
    if (had.has(d)) continue;
    const record = pinRecord(d);
    if (record) ids[d] = record;
    else delete ids[d];
  }
  const agent = new Set(setting.agentDirs ?? []);
  const agentDirs = dirs.filter((d) => agent.has(d));
  const { agentDirs: _a, pins: _p, ...rest } = setting;
  const pins = setting.pins ?? before?.pins;
  return {
    ...rest,
    addedDirs: dirs,
    ...(agentDirs.length > 0 ? { agentDirs } : {}),
    ...(Object.keys(ids).length > 0 || pins ? { pins: { ...(pins ?? {}), ids } } : {}),
  };
}

/** The setting's fields that only say which directories are readable or writable: a change to them alone is applied between turns, never restarting work (SessionSandbox.set). */
const DIR_FIELDS = ["projectRoots", "addedDirs", "agentDirs"] as const;

function withoutDirs(setting: SessionSandboxSetting | undefined): string {
  // `pins` is what the daemon keeps of the directories, not a choice: no change of it is one of the setting.
  const { projectRoots: _r, addedDirs: _a, agentDirs: _g, pins: _p, ...rest } = setting ?? {};
  return JSON.stringify(Object.entries(rest).sort(([a], [b]) => a.localeCompare(b)));
}

function dirsChanged(before: SessionSandboxSetting | undefined, after: SessionSandboxSetting | undefined): boolean {
  return DIR_FIELDS.some((k) => JSON.stringify(before?.[k] ?? null) !== JSON.stringify(after?.[k] ?? null));
}

/** Whether `before` → `after` changes only the readable roots or the added directories. */
export function onlyDirsChanged(before: SessionSandboxSetting | undefined, after: SessionSandboxSetting | undefined): boolean {
  return withoutDirs(before) === withoutDirs(after) && dirsChanged(before, after);
}

/** Whether `before` → `after` changes nothing but what the daemon keeps of the directories (their pins). */
function sameSetting(before: SessionSandboxSetting | undefined, after: SessionSandboxSetting | undefined): boolean {
  return withoutDirs(before) === withoutDirs(after) && !dirsChanged(before, after);
}

/** A setting in words, for a change's line and audit: "bwrap, network on, Docker access". */
export function describeSandbox(e: EffectiveSandbox): string {
  if (e.choice === SANDBOX_OFF) return "off";
  return `${e.choice}, network ${e.network.mode}${e.network.mode === "allowlist" ? ` (${(e.network.allow ?? []).join(", ")})` : ""}${e.dockerSocket ? ", Docker access" : ""}${e.addedDirs.length > 0 ? `, also writes ${e.addedDirs.join(", ")}` : ""}`;
}

/** Why a setting is malformed (an unknown provider, a host that isn't one), or null. */
export function sandboxSettingProblem(setting: SessionSandboxSetting, registry: SandboxRegistry): string | null {
  if (setting.provider !== undefined && !registry.knows(setting.provider)) {
    return `unknown sandbox provider "${setting.provider}" — available: ${[SANDBOX_AUTO, SANDBOX_OFF, ...registry.ids()].join(", ")}`;
  }
  const bad = (setting.allowedHosts ?? []).filter((h) => !validAllowedHost(h));
  if (bad.length > 0) return `not a host an allowlist can name: ${bad.slice(0, 3).join(", ")}`;
  const notAbsolute = [...(setting.addedDirs ?? []), ...(setting.projectRoots ?? []).filter((r) => r !== PROJECT_ROOT_PARENT)].filter((d) => normalizeSandboxDir(d) === null);
  if (notAbsolute.length > 0) return `not an absolute path: ${notAbsolute.slice(0, 3).join(", ")}`;
  return null;
}

/** How wide a setting is, to tell a widening change (asked) from a narrowing one (applied). */
function networkWidth(mode: NetworkMode): number {
  return mode === "off" ? 0 : mode === "allowlist" ? 1 : 2;
}

/**
 * Whether moving from `before` to `after` lets commands do more: the sandbox
 * turned off, the network wider, an allowlist with a host it didn't have,
 * the container runtime's socket let in (root on the machine), a directory
 * added to what commands write or a project root to what they read.
 * Switching provider counts as widening (a different boundary).
 */
export function widens(
  before: { choice: string; network: NetworkPolicy; dockerSocket?: boolean; projectRoots?: readonly string[]; addedDirs?: readonly string[] },
  after: { choice: string; network: NetworkPolicy; dockerSocket?: boolean; projectRoots?: readonly string[]; addedDirs?: readonly string[] },
): boolean {
  if (after.choice === SANDBOX_OFF && before.choice !== SANDBOX_OFF) return true;
  if (before.choice === SANDBOX_OFF) return false;
  if (after.choice !== before.choice) return true;
  if (after.dockerSocket === true && before.dockerSocket !== true) return true;
  // A directory written, or a root read, that wasn't: the owner's call (removing one narrows).
  if ((after.addedDirs ?? []).some((d) => !(before.addedDirs ?? []).includes(d))) return true;
  if ((after.projectRoots ?? []).some((r) => !(before.projectRoots ?? []).includes(r))) return true;
  const b = networkWidth(before.network.mode);
  const a = networkWidth(after.network.mode);
  if (a !== b) return a > b;
  if (after.network.mode === "allowlist") {
    const had = new Set(before.network.allow ?? []);
    return (after.network.allow ?? []).some((h) => !had.has(h));
  }
  return false;
}

/** The network this plan enforces for `asked`: narrowed when it can't do an allowlist, widened (and said) when it can't turn it off. */
function enforcedNetwork(plan: ConfinementPlan, asked: NetworkMode, providerName: string): { mode: NetworkMode; note?: string; widened: boolean } {
  if (plan.network.includes(asked)) return { mode: asked, widened: false };
  if (asked === "allowlist" && plan.network.includes("off")) {
    return { mode: "off", note: `${providerName} can't enforce a host allowlist here, so commands get no network`, widened: false };
  }
  const best = plan.network.includes("off") ? "off" : "on";
  return { mode: best, note: `the network can't be ${asked === "off" ? "turned off" : "limited to an allowlist"} this way: ${plan.via}, and the backend needs it to reach its model`, widened: best === "on" };
}

/** Why `workspace` can't be a sandbox's writable workspace, or null: `/` would make the whole filesystem writable, and cover the sandbox's own /proc, /dev and /tmp. */
export function workspaceProblem(workspace: string): string | null {
  return resolve(workspace) === "/" ? "a session working in / can't be sandboxed (the whole filesystem would be its writable workspace) — give it a project directory" : null;
}

/** What the limits line says of a session whose workspace is the home. */
export const HOME_WORKSPACE_NOTE =
  "the workspace is your home: commands can read and write all of it but what the sandbox hides (credential stores, the agents' logins, codeoid's own dirs) — only credentials are protected";

/** What {@link sandboxDirsOf} gives back. */
export interface SandboxDirs {
  roots: string[];
  added: string[];
  notes: string[];
  homeWorkspace: boolean;
  dropped: Array<{ dir: string; why: string }>;
  /** Pins taken now (pinned.ts), by real path: a root or added dir seen for the first time. */
  pinned: Record<string, string>;
  /** The look through the roots for credential files, reused by every spec built from this resolution. */
  scan?: RootScan;
}

/**
 * A session's project roots and added directories for its sandbox's
 * workspace `top` (project-roots.ts): what is used, and what isn't and why.
 * An added dir inside the workspace is dropped (writable already); one that
 * is no longer a directory at the real path it was granted at (a link put
 * there, removed), another directory than the one pinned there
 * (`opts.pins`, pinned.ts), or can't be one now, is `dropped`, said. A root
 * the same, or too big to look through for credential files, isn't used,
 * said, and so is a repository there whose git config is hidden for the
 * credential in it (never the session's own repository's). A root or added
 * dir with no pin is pinned now (`pinned`). The agent's own added dirs
 * (`opts.agentDirs`) keep a root's credential hiding.
 */
export async function sandboxDirsOf(
  top: string,
  rootEntries: readonly string[],
  addedDirs: readonly string[],
  config?: CodeoidConfig,
  opts: { pins?: Readonly<Record<string, string>>; agentDirs?: readonly string[]; scanLimit?: number } = {},
): Promise<SandboxDirs> {
  const home = resolve(process.env.HOME ?? homedir());
  const configDir = getConfigDir();
  const pins = opts.pins ?? {};
  const pinned: Record<string, string> = {};
  const homeWorkspace = resolve(top) === home;
  const r = resolveProjectRoots(rootEntries, top, { home, configDir });
  const notes = [...(homeWorkspace ? [HOME_WORKSPACE_NOTE] : []), ...(homeWorkspace ? [] : r.notes)];
  const hidden = addedDirs.length > 0 ? hiddenPathsFor(config) : [];
  const added: string[] = [];
  const dropped: Array<{ dir: string; why: string }> = [];
  for (const d of addedDirs) {
    if (resolve(d) === resolve(top) || resolve(d).startsWith(`${resolve(top)}/`)) continue;
    const stored = pins[resolve(d)];
    const changed = stored ? pinProblem(d, "it", { stored }) : null;
    const problem = changed
      ? `it is no longer the directory it was when added: ${changed.replace(/^it \S+ /, "it ")}`
      : stillRealDir(d)
        ? addedDirProblem(d, { home, configDir, hidden })
        : `it is no longer the directory it was when added (${linkInPath(d) ? `${linkInPath(d)} is a symbolic link now` : "removed, or not a directory"})`;
    if (problem) {
      notes.push(`added directory ${d}: ${problem}: not writable`);
      dropped.push({ dir: d, why: problem });
      continue;
    }
    added.push(resolve(d));
    if (!stored) {
      const record = pinRecord(d);
      if (record) pinned[resolve(d)] = record;
    }
  }
  let roots: string[] = [];
  for (const root of homeWorkspace ? [] : r.roots) {
    const stored = pins[root];
    const changed = stored ? pinProblem(root, "project root", { stored }) : null;
    if (changed) {
      notes.push(`${changed}: not used — set the session's project roots again to use it as it is now`);
      continue;
    }
    roots.push(root);
    if (!stored) {
      const record = pinRecord(root);
      if (record) pinned[root] = record;
    }
  }
  const agent = new Set((opts.agentDirs ?? []).map((d) => resolve(d)));
  const agentAdded = added.filter((d) => agent.has(d));
  let scan: RootScan | undefined;
  if (roots.length > 0 || agentAdded.length > 0) {
    // The session's own: its workspace, its repository's git dir (a fork's worktree uses the main checkout's), and
    // what its owner added; the agent's own added dirs are looked through as a root is. Without holding the
    // daemon's event loop; every spec built from this resolution reuses it.
    const layout = gitLayoutOf(top, home);
    const own = [top, ...(layout?.common ? [layout.common] : []), ...added.filter((d) => !agent.has(d))];
    const scanned = [...roots, ...agentAdded];
    const limit = opts.scanLimit ?? PROJECT_ROOT_SCAN_LIMIT;
    const secrets = await projectRootSecretsAsync(scanned, own, limit);
    scan = { key: rootScanKey(scanned, own), result: secrets };
    for (const over of secrets.over) {
      if (agent.has(over)) {
        const why = `more than ${limit} directories to look through for credential files (${[...SCAN_SKIPPED_DIRS].slice(0, 2).join(", ")} and the like aside), which stay hidden in a directory the agent added itself`;
        notes.push(`added directory ${over}: ${why}: not writable — the owner can add it (\`/sandbox add\`), or a narrower one`);
        dropped.push({ dir: over, why });
        continue;
      }
      notes.push(
        over === r.defaultRoot
          ? `no project root: the default, the repository's parent (${over}), holds more than ${limit} directories to look through for credential files (build outputs such as target/, build/, dist/ and vendor/ count; ${[...SCAN_SKIPPED_DIRS].slice(0, 3).join(", ")} and the like don't): not used, so other repositories aren't readable — set sandbox.projectRoots (or the session's own) to the repositories you need`
          : `project root ${over}: more than ${limit} directories to look through for credential files (${[...SCAN_SKIPPED_DIRS].slice(0, 2).join(", ")} and the like aside): not used — name narrower roots in sandbox.projectRoots (or the session's own), the repositories you need`,
      );
    }
    roots = roots.filter((x) => !secrets.over.includes(x));
    for (const c of secrets.gitConfigs.slice(0, 5)) {
      notes.push(`${c} holds a credential (a remote URL with a user or password in it, or an http extraheader): hidden, so git in ${repositoryOfConfig(c)} can't read its config from this session`);
    }
    if (secrets.gitConfigs.length > 5) notes.push(`and ${secrets.gitConfigs.length - 5} more repositories' git configs holding a credential: hidden`);
    for (const d of dropped) {
      const i = added.indexOf(d.dir);
      if (i >= 0) added.splice(i, 1);
    }
  }
  return { roots, added, notes, homeWorkspace, dropped, pinned, ...(scan ? { scan } : {}) };
}

/** The repositories an added dir holds besides its own (a folder of them): the end-of-turn git look covers each. */
export function addedRepositories(addedDirs: readonly string[]): string[] {
  return [...new Set(addedDirs.flatMap((d) => nestedControl(d).repos.filter((r) => resolve(r) !== resolve(d))))];
}

/** What a setting resolves to for a backend now (no side effects beyond a cached probe). */
export async function resolveSandbox(opts: {
  registry: SandboxRegistry;
  config: SandboxConfig;
  setting: SessionSandboxSetting | undefined;
  backendId: string;
  /** The session's working directory: `/` can't be a sandbox's workspace. */
  workspace?: string;
  /** The daemon's whole config: what an added directory may not be in (its data dirs: policy.ts `hiddenPathsFor`). */
  codeoidConfig?: CodeoidConfig;
  /** The sandbox's workspace as pinned for the session (default: the workspace's, policy.ts `sandboxWorkspaceOf`). */
  top?: string;
}): Promise<{
  info: SessionSandboxInfo;
  provider: SandboxProvider | null;
  plan: ConfinementPlan | null;
  network: NetworkPolicy;
  droppedDirs?: Array<{ dir: string; why: string }>;
  /** Roots and added dirs pinned by this resolution (sandboxDirsOf). */
  pinned?: Record<string, string>;
  /** The look through the roots for credential files (sandboxDirsOf), for the specs built from this resolution. */
  rootScan?: RootScan;
}> {
  const { choice, network, dockerSocket, projectRoots, addedDirs, agentDirs } = effectiveSetting(opts.config, opts.setting);
  const base = {
    choice,
    network: network.mode,
    ...(network.mode === "allowlist" ? { allowedHosts: [...(network.allow ?? [])] } : {}),
  };
  if (runsNoCommands(opts.backendId)) {
    const r = confinementFor(opts.backendId, null);
    return { info: { ...base, state: "no-shell", reason: `${opts.backendId} runs no commands`, enforced: true }, provider: null, plan: r.ok ? r.plan : null, network };
  }
  if (choice === SANDBOX_OFF) {
    return { info: { ...base, state: "off", reason: "the sandbox is turned off for this session", enforced: false }, provider: null, plan: null, network };
  }
  const resolved = await opts.registry.resolve(choice);
  if (resolved.kind === "off") return { info: { ...base, state: "off", reason: "turned off", enforced: false }, provider: null, plan: null, network };
  if (resolved.kind === "unknown") return { info: { ...base, state: "unavailable", reason: resolved.reason, enforced: false }, provider: null, plan: null, network };
  const provider = resolved.provider;
  const named = { provider: provider.id, providerName: provider.displayName, isolation: provider.capabilities.isolation };
  if (!resolved.probe.available) {
    return { info: { ...base, ...named, state: "unavailable", reason: resolved.probe.reason, enforced: false }, provider, plan: null, network };
  }
  const rootProblem = opts.workspace !== undefined ? workspaceProblem(opts.workspace) : null;
  if (rootProblem) return { info: { ...base, ...named, state: "unavailable", reason: rootProblem, enforced: false }, provider, plan: null, network };
  const c = confinementFor(opts.backendId, provider, opts.registry.host);
  if (!c.ok) return { info: { ...base, ...named, state: "unavailable", reason: c.reason, enforced: false }, provider, plan: null, network };
  const net = enforcedNetwork(c.plan, network.mode, provider.displayName);
  // A repository whose `.git` names a git dir codeoid can't verify: held read-only, said (policy.ts gitWorkspacePaths).
  const gitNote = opts.workspace !== undefined && c.plan.kind !== "no-shell" ? gitLayoutProblem(opts.workspace) : null;
  // A monorepo's package: what its commands may write is the whole repository (#448 round 9).
  const top = opts.workspace !== undefined && c.plan.kind !== "no-shell" ? (opts.top ?? sandboxWorkspaceOf(opts.workspace)) : null;
  const topNote = top && opts.workspace !== undefined && top !== resolve(opts.workspace) ? `the workspace is the repository's top (${top}), which the working directory is inside: all of it is readable and writable, its git structure and every project settings dir on the way held read-only` : null;
  // The container runtime's socket, when the owner let it in: said, and said when there is none to reach.
  const home = process.env.HOME ?? homedir();
  const sockets = dockerSocket ? dockerSocketPaths(home) : [];
  const unconnectable = dockerSocket && sockets.length === 0 ? unconnectableDockerSockets(home) : [];
  // Claude's Linux sandbox can't allow one socket: every one a command can see is connectable then (#448 round 10).
  const allSockets = sockets.length > 0 && c.plan.kind === "native" && process.platform === "linux";
  const dockerNote = dockerSocket
    ? sockets.length > 0
      ? `Docker access: commands can reach the container runtime (${sockets.join(", ")}), which can reach the whole machine (a container can mount /)${allSockets ? `; ${CLAUDE_ALL_SOCKETS_NOTE}` : ""}`
      : unconnectable.length > 0
        ? `Docker access was asked for, but the container runtime socket found here (${unconnectable.join(", ")}) isn't one you can connect to (is your user in its group?): not shown`
        : "Docker access was asked for, but no container runtime socket was found here"
    : null;
  // `sandbox.worktreeRoots` refused here, or missing and not beside the repository (never made): said (worktrees.ts).
  const layout = top !== null && opts.config.worktreeRoots.length > 0 ? gitLayoutOf(top) : null;
  const rootNotes = layout ? worktreeRootNotes(layout, { roots: opts.config.worktreeRoots, configDir: getConfigDir() }) : [];
  // Working across repositories: the project roots it reads, the directories it writes besides its workspace.
  const dirs: SandboxDirs =
    top !== null
      ? await sandboxDirsOf(top, projectRoots, addedDirs, opts.codeoidConfig, { ...(opts.setting?.pins ? { pins: opts.setting.pins.ids } : {}), agentDirs })
      : { roots: [], added: [], notes: [], homeWorkspace: false, dropped: [], pinned: {} };
  const limits = [...c.plan.limits, ...(net.note ? [net.note] : []), ...(gitNote ? [gitNote] : []), ...(topNote ? [topNote] : []), ...(dockerNote ? [dockerNote] : []), ...rootNotes, ...dirs.notes];
  const applied: NetworkPolicy = net.mode === "allowlist" ? network : { mode: net.mode };
  return {
    info: {
      choice,
      ...named,
      state: "on",
      network: net.mode,
      ...(net.mode !== network.mode ? { networkRequested: network.mode } : {}),
      ...(network.mode === "allowlist" ? { allowedHosts: [...(network.allow ?? [])] } : {}),
      confinement: c.plan.kind === "no-shell" ? undefined : c.plan.kind,
      via: c.plan.via,
      ...(limits.length > 0 ? { limits } : {}),
      ...(dockerSocket ? { dockerSocket: true } : {}),
      ...(dirs.roots.length > 0 ? { projectRoots: dirs.roots } : {}),
      ...(dirs.added.length > 0 ? { addedDirs: dirs.added } : {}),
      ...(dirs.homeWorkspace ? { homeWorkspace: true } : {}),
      enforced: !net.widened,
    },
    provider,
    plan: c.plan,
    network: applied,
    ...(dirs.dropped.length > 0 ? { droppedDirs: dirs.dropped } : {}),
    ...(Object.keys(dirs.pinned).length > 0 ? { pinned: dirs.pinned } : {}),
    ...(dirs.scan ? { rootScan: dirs.scan } : {}),
  };
}

/** A session's sandbox: its setting, what it resolved to, its temp dir and handles. */
export class SessionSandbox {
  readonly #sessionId: string;
  readonly #workdir: string;
  readonly #registry: SandboxRegistry;
  readonly #config: CodeoidConfig | undefined;
  #setting: SessionSandboxSetting | undefined;
  #info: SessionSandboxInfo | null = null;
  #runtime: SandboxRuntime | null = null;
  #tempDir: string | null = null;
  #handles = new Set<SandboxHandle>();
  #resolvedFor: string | null = null;
  /** The setting changed since the last resolution (which still stands until the next one replaces it). */
  #stale = false;
  /** Bumped by every {@link set}: a resolution that started before it is done again. */
  #generation = 0;
  /** Resolutions run one at a time, in order: the last one asked for is the one that stands. */
  #refreshing: Promise<unknown> = Promise.resolve();
  #closed = false;
  #launcherDir: string | null = null;
  #launchers = 0;
  #homesDir: string | null = null;
  #claudeTemp: ClaudeTempDirs | null = null;
  #gitTempDir: string | null = null;
  /** The session's worktree folder name (worktrees.ts), once found or chosen: the same for its life. */
  #folderName: string | null = null;
  /** The worktree folders a spec gave the session: the empty ones are removed (tidyFolders, close). */
  #folders = new Set<string>();
  /** The repository's worktree entries as git makes them (#448 round 11, worktree-entries.ts). */
  readonly #entries = new WorktreeEntryGuard();
  /** The same for each added directory's repository that isn't the workspace's, by its git dir. */
  readonly #addedEntries = new Map<string, WorktreeEntryGuard>();
  /** The project roots and added directories the last resolution applied (the runtime's: a change waits for the next). */
  #dirs: { roots: string[]; added: string[]; scan?: RootScan } = { roots: [], added: [] };
  #droppedDirs: Array<{ dir: string; why: string }> = [];
  /** The setting's directories changed since the last resolution, nothing else (applied between turns: Session). */
  #dirsStale = false;
  /** A pinned directory was found changed (pinProblem): the next resolution between turns looks at them again. */
  #pinsBroken = false;
  /** Pins were taken since the setting was last saved (takePinsChanged). */
  #pinsChanged = false;
  /** The spec last built for the session: what its commands can write, for the entries' look. */
  #lastSpec: SandboxSpec | null = null;
  /** The spec last built under the running resolution: what the gate checks the pins of (pinProblem). */
  #gateSpec: SandboxSpec | null = null;
  #entriesRecheck: ReturnType<typeof setTimeout> | null = null;

  readonly #onWarning: ((text: string) => void) | undefined;
  readonly #onWorktreeEntries: ((common: string, findings: WorktreeEntryFinding[]) => void) | undefined;
  readonly #name: () => string;

  constructor(opts: {
    sessionId: string;
    /** The session's name (its worktree folder is named after it, with a short id: worktrees.ts `sessionFolderName`). */
    name?: string | (() => string);
    workdir: string;
    registry: SandboxRegistry;
    config?: CodeoidConfig;
    setting?: SessionSandboxSetting;
    /** A warning line on the session (SandboxRuntime.warn). */
    onWarning?: (text: string) => void;
    /** What a look at the repository's worktree entries found (checkWorktreeEntries): said on the session and audited. */
    onWorktreeEntries?: (common: string, findings: WorktreeEntryFinding[]) => void;
  }) {
    this.#onWarning = opts.onWarning;
    this.#onWorktreeEntries = opts.onWorktreeEntries;
    this.#sessionId = opts.sessionId;
    const name = opts.name;
    this.#name = typeof name === "function" ? name : () => name ?? opts.sessionId;
    this.#workdir = opts.workdir;
    this.#registry = opts.registry;
    this.#config = opts.config;
    this.#setting = opts.setting;
  }

  get registry(): SandboxRegistry {
    return this.#registry;
  }

  /** The session's own setting (persisted); absent fields follow the config. */
  get setting(): SessionSandboxSetting | undefined {
    return this.#setting;
  }

  /** The daemon's config section. */
  get config(): SandboxConfig {
    return sandboxConfigOf(this.#config);
  }

  /** What `setting` means with the config filled in. */
  effective(setting: SessionSandboxSetting | undefined = this.#setting): EffectiveSandbox {
    return effectiveSetting(this.config, setting);
  }

  /** The last resolution, or null before the first. */
  get info(): SessionSandboxInfo | null {
    return this.#info;
  }

  /** What a backend is given while the sandbox is on; null when off, unavailable, or the backend runs no commands. */
  get runtime(): SandboxRuntime | null {
    return this.#runtime;
  }

  /** Whether the last resolution was for `backendId` with the current setting. */
  resolvedFor(backendId: string): boolean {
    return this.#resolvedFor === backendId && !this.#stale;
  }

  /**
   * The runtime for `backendId`: the last resolution's, kept while a changed
   * setting is being resolved (never nothing in between: that would read as
   * "off" to a backend starting meanwhile). Null when that resolution was for
   * another backend, or isn't on.
   */
  runtimeFor(backendId: string): SandboxRuntime | null {
    return this.#resolvedFor === backendId ? this.#runtime : null;
  }

  /**
   * Change the setting; the next {@link refresh} resolves it and replaces the
   * runtime. Handles a backend opened under the old one stay until that
   * backend is torn down (Session restarts it, idle: a running turn is never
   * cut off by a change of setting) or the session closes.
   */
  async set(setting: SessionSandboxSetting | undefined, opts: { repinRoots?: boolean } = {}): Promise<void> {
    let next = setting && Object.keys(setting).length > 0 ? canonicalAddedDirs({ ...setting }, this.#setting) : undefined;
    // The project roots set again (the owner's own): each pinned anew at the next resolution, as it is then.
    if (opts.repinRoots && next?.pins) {
      const keep = new Set([...(next.addedDirs ?? []), ...(next.pins.workspace ? [next.pins.workspace] : [])]);
      next = { ...next, pins: { ...next.pins, ids: Object.fromEntries(Object.entries(next.pins.ids).filter(([k]) => keep.has(k))) } };
    }
    if (sameSetting(this.#setting, next)) {
      if (opts.repinRoots) this.#dirsStale = true;
    } else if (onlyDirsChanged(this.#setting, next) && !this.#stale) {
      // Only which directories are read or written: the runtime stands until Session applies it between turns.
      this.#dirsStale = true;
    } else this.#stale = true;
    this.#setting = next;
    this.#generation += 1;
  }

  /** Whether pins were taken (or let go) since the last call: the setting holding them is saved then (Session). */
  takePinsChanged(): boolean {
    const changed = this.#pinsChanged;
    this.#pinsChanged = false;
    return changed;
  }

  /**
   * The sandbox's workspace: the one pinned for this working directory (the
   * repository's top in a monorepo, found once), else as found now.
   */
  #workspace(): string {
    const pins = this.#setting?.pins;
    if (pins?.workspace && pins.workdir === resolve(this.#workdir)) return pins.workspace;
    return sandboxWorkspaceOf(this.#workdir);
  }

  /** The sandbox's workspace (the repository's top in a monorepo), as pinned for the session. */
  get workspace(): string {
    return this.#workspace();
  }

  /**
   * Pin the workspace and the working directory when they aren't (a new
   * session, or one from before pins: the working directory's identity from
   * #448 round 14): as they are now, at their real paths.
   */
  #pinWorkspace(): void {
    const pins = this.#setting?.pins;
    const workdir = resolve(this.#workdir);
    if (pins?.workspace && pins.workdir === workdir) {
      if (pins.ids[workdir] || pins.workspace === workdir) return;
      // Pinned before the working directory was: its identity now.
      const record = pinRecord(workdir);
      if (!record) return;
      this.#setting = { ...(this.#setting ?? {}), pins: { ...pins, ids: { ...pins.ids, [workdir]: record } } };
      this.#pinsChanged = true;
      return;
    }
    const workspace = sandboxWorkspaceOf(workdir);
    const record = pinRecord(workspace);
    if (!record) return;
    const ids = { ...(pins?.ids ?? {}) };
    if (pins?.workspace && pins.workspace !== workspace) delete ids[pins.workspace];
    if (pins?.workdir && pins.workdir !== workdir && pins.workdir !== workspace) delete ids[pins.workdir];
    ids[workspace] = record;
    const own = workdir === workspace ? record : pinRecord(workdir);
    if (own) ids[workdir] = own;
    this.#setting = { ...(this.#setting ?? {}), pins: { workdir, workspace, ids } };
    this.#pinsChanged = true;
  }

  /**
   * The working directory as the daemon uses it on the host (pinned.ts
   * {@link PinnedDir}: checkpoints, going back a turn, a fork's files, the
   * end-of-turn git looks), pinned when it wasn't yet. Throws
   * {@link PinnedPathError} (for `op`) when it isn't the directory pinned.
   */
  workdirPin(op: string): PinnedDir {
    this.#pinWorkspace();
    const workdir = resolve(this.#workdir);
    return pinDir(workdir, "the working directory", this.#setting?.pins?.ids[workdir] ?? null, op);
  }

  /** Keep what a resolution pinned (roots, added dirs seen for the first time). */
  #keepPins(pinned: Record<string, string> | undefined): void {
    if (!pinned || Object.keys(pinned).length === 0 || this.#closed) return;
    const pins = this.#setting?.pins ?? { ids: {} };
    this.#setting = { ...(this.#setting ?? {}), pins: { ...pins, ids: { ...pins.ids, ...pinned } } };
    this.#pinsChanged = true;
  }

  /**
   * Why the running sandbox's directories aren't what was pinned (the
   * workspace, the working directory, an added dir, a project root, a
   * worktree folder: pinned.ts), in the sentence a refused call carries, or
   * null. Asked at the gate before every tool call: what has changed is
   * never run against, and is looked at again at the next resolution
   * between turns (an added dir or root changed is left out then, said; a
   * workspace changed keeps every call refused until it is put back).
   */
  pinProblem(): string | null {
    if (this.#closed || !this.#runtime) return null;
    const ids = this.#setting?.pins?.ids ?? {};
    const workspace = this.#workspace();
    const workdir = resolve(this.#workdir);
    const problem =
      pinProblem(workspace, "the workspace", { ...(ids[workspace] ? { stored: ids[workspace] } : { mayBeMissing: true }) }) ??
      (workdir !== workspace ? pinProblem(workdir, "the working directory", ids[workdir] ? { stored: ids[workdir] } : { mayBeMissing: true }) : null) ??
      this.#dirs.added.map((d) => pinProblem(d, "added directory", ids[d] ? { stored: ids[d] } : {})).find((p) => p !== null) ??
      this.#dirs.roots.map((r) => pinProblem(r, "project root", ids[r] ? { stored: ids[r] } : {})).find((p) => p !== null) ??
      // Everything else the running sandbox binds by name (#448 round 14: a dir held in place, a path held
      // read-only, the repository's git dirs, a worktree folder or location): changed by another session's
      // command or on the host, it is said here, and the next resolution looks again.
      pinsProblem(this.#gateSpec?.pins);
    if (!problem) return null;
    this.#pinsBroken = true;
    return pinRefusal(problem);
  }

  /**
   * Whether the setting's directories (project roots, added dirs) changed
   * since the last resolution: applied by the next {@link refresh}, which
   * Session runs only between turns with no background work (a Claude query
   * rebuilt mid-work would end it; a process backend is restarted).
   */
  get dirsPending(): boolean {
    return this.#dirsStale || this.#pinsBroken;
  }

  /** The added directories the running sandbox has (SandboxSpec.addedDirs as resolved): what host-side file tools are held to. */
  appliedAddedDirs(): string[] {
    return [...this.#dirs.added];
  }

  /** The project roots the running sandbox reads. */
  appliedProjectRoots(): string[] {
    return [...this.#dirs.roots];
  }

  /** The added directories the last resolution left out, and why (project-roots.ts `stillRealDir`, `addedDirProblem`): Session says it, and drops them. */
  droppedDirs(): Array<{ dir: string; why: string }> {
    return [...this.#droppedDirs];
  }

  /**
   * Take `dirs` out of the setting's added directories, as the last
   * resolution already left them out (droppedDirs): nothing to apply, so the
   * runtime stands; a dir there again later isn't added again unasked.
   */
  forget(dirs: readonly string[]): void {
    if (!this.#setting?.addedDirs) return;
    const gone = new Set(dirs.map((d) => resolve(d)));
    const kept = this.#setting.addedDirs.filter((d) => !gone.has(resolve(normalizeSandboxDir(d) ?? d)));
    if (kept.length === this.#setting.addedDirs.length) return;
    const { addedDirs: _old, agentDirs, pins, ...rest } = this.#setting;
    const agent = (agentDirs ?? []).filter((d) => kept.includes(d));
    const ids = Object.fromEntries(Object.entries(pins?.ids ?? {}).filter(([k]) => !gone.has(k)));
    const base: SessionSandboxSetting = { ...rest, ...(agent.length > 0 ? { agentDirs: agent } : {}), ...(pins ? { pins: { ...pins, ids } } : {}) };
    this.#setting = kept.length > 0 ? { ...base, addedDirs: kept } : Object.keys(base).length > 0 ? base : undefined;
    this.#droppedDirs = this.#droppedDirs.filter((d) => !gone.has(resolve(d.dir)));
  }

  /** The session's temp dir, once made (its commands write it): null before. */
  get tempDirPath(): string | null {
    return this.#tempDir;
  }

  /** The repositories the session writes besides its workspace: its added dirs, and every repository inside one. */
  appliedRepositories(): string[] {
    return [...new Set([...this.#dirs.added, ...addedRepositories(this.#dirs.added)])];
  }

  /**
   * Resolve for `backendId` (a provider switch, a setting change, the first
   * turn). One at a time; one that started before a {@link set} resolves
   * again, so a change made while a slow probe runs is never lost.
   */
  refresh(backendId: string): Promise<SessionSandboxInfo> {
    const run = this.#refreshing.catch(() => {}).then(() => this.#refreshNow(backendId));
    this.#refreshing = run;
    return run;
  }

  async #refreshNow(backendId: string): Promise<SessionSandboxInfo> {
    let r: Awaited<ReturnType<typeof resolveSandbox>>;
    for (;;) {
      const generation = this.#generation;
      this.#pinWorkspace();
      r = await resolveSandbox({
        registry: this.#registry,
        config: this.config,
        setting: this.#setting,
        backendId,
        workspace: this.#workdir,
        top: this.#workspace(),
        ...(this.#config ? { codeoidConfig: this.#config } : {}),
      });
      if (generation === this.#generation) break;
    }
    this.#keepPins(r.pinned);
    this.#pinsBroken = false;
    // The spec the gate checks is the new resolution's, once built: the last one's pins are its handles' to check.
    this.#gateSpec = null;
    if (this.#closed) {
      this.#runtime = null;
      return r.info;
    }
    this.#info = r.info;
    this.#resolvedFor = backendId;
    this.#stale = false;
    this.#dirsStale = false;
    const dirs = { roots: [...(r.info.projectRoots ?? [])], added: [...(r.info.addedDirs ?? [])], ...(r.rootScan ? { scan: r.rootScan } : {}) };
    this.#dirs = dirs;
    this.#droppedDirs = r.droppedDirs ?? [];
    if (r.info.state !== "on" || !r.provider || !r.plan) {
      this.#runtime = null;
      return r.info;
    }
    const provider = r.provider;
    const plan = r.plan;
    const config = this.config;
    const dockerSocket = r.info.dockerSocket === true;
    // Local services' sockets follow the network the session asked for, not a handle's (a process backend's has it on
    // for its model) nor one widened because the backend can't turn it off: hiding them needs no network rule.
    const hideLocalServices = (r.info.networkRequested ?? r.info.network) !== "on";
    const open = (backendState: readonly string[] = [], o: OpenOptions = {}) => {
      if (this.#closed) throw new Error(`session ${this.#sessionId} is gone`);
      return this.#spec(o.backendNetwork ? { mode: "on" } : r.network, backendState, o.readable ?? [], dockerSocket, hideLocalServices, dirs);
    };
    // Built (and the temp dir made) when a backend first needs it, then kept: a worktree added or removed in the
    // repository never rebuilds it (#448 round 11: that would rebuild a Claude query, its background tasks with it).
    // An entry made meanwhile is checked instead (checkWorktreeEntries), and held from the next spec on.
    let spec: SandboxSpec | null = null;
    let gitShim: string | null = null;
    this.#runtime = {
      info: r.info,
      plan,
      provider,
      config,
      get spec() {
        spec ??= open([]);
        return spec;
      },
      open: async (backendState, o) => this.#track(await provider.open(open(backendState, o))),
      openSync: (backendState, o) => {
        if (!provider.openSync) throw new Error(`${provider.displayName} can't be opened synchronously`);
        return this.#track(provider.openSync(open(backendState, o)));
      },
      launcher: (handle, argv, envNames, name) => this.#writeLauncher(handle, argv, envNames ?? [], name),
      privateHome: (key) => this.#privateHome(key),
      stateDir: (key) => this.#stateDir(key),
      claudeTemp: () => this.#ensureClaudeTemp(),
      gitShim: (caller) => {
        // Checked at each query: one removed meanwhile (a temp cleaner) is written again rather than leave the CLI the host's git.
        if (!gitShim || !existsSync(join(gitShim, "git"))) gitShim = this.#writeGitShim(provider, caller);
        return gitShim;
      },
      warn: (text) => {
        try {
          this.#onWarning?.(text);
        } catch {
          /* a session gone meanwhile: the daemon's log has it */
        }
      },
    };
    return r.info;
  }

  #sessionSlug(): string {
    return this.#sessionId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || "session";
  }

  #privateHome(key: string): string {
    if (this.#closed) throw new Error(`session ${this.#sessionId} is gone`);
    if (!this.#homesDir) this.#homesDir = mkdtempSync(join(sandboxRoot(), `home-${this.#sessionSlug()}-`));
    const dir = join(this.#homesDir, key.replace(/[^A-Za-z0-9_-]/g, "") || "backend");
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { mode: 0o700 });
    return dir;
  }

  /** The session's state root: under the transcripts dir when there is one, else (an embedder, tests) with its private homes. */
  #stateRoot(): string {
    const dir = this.#config?.transcriptDir;
    const safe = this.#sessionId.replace(/[^A-Za-z0-9_-]/g, "") || "session";
    if (dir) return join(resolve(dir), "sandbox-state", safe);
    if (!this.#homesDir) this.#homesDir = mkdtempSync(join(sandboxRoot(), `home-${this.#sessionSlug()}-`));
    return join(this.#homesDir, ".state");
  }

  #stateDir(key: string): string {
    if (this.#closed) throw new Error(`session ${this.#sessionId} is gone`);
    const dir = join(this.#stateRoot(), key.replace(/[^A-Za-z0-9_-]/g, "") || "backend");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  /** Remove what the session's backends kept across starts (with the session: its destroy). */
  removeState(): void {
    rmSync(this.#stateRoot(), { recursive: true, force: true });
  }

  #ensureClaudeTemp(): ClaudeTempDirs {
    if (this.#closed) throw new Error(`session ${this.#sessionId} is gone`);
    if (!this.#claudeTemp) {
      const base = mkdtempSync(join(sandboxRoot(), `claude-${this.#sessionSlug()}-`));
      const uid = typeof process.getuid === "function" ? process.getuid() : "user";
      const t: ClaudeTempDirs = { cli: join(base, "cli"), root: join(base, "cmd"), commands: join(base, "cmd", `claude-${uid}`) };
      mkdirSync(t.cli, { mode: 0o700 });
      mkdirSync(t.commands, { recursive: true, mode: 0o700 });
      this.#claudeTemp = t;
    }
    return this.#claudeTemp;
  }

  #ensureLauncherDir(): string {
    if (!this.#launcherDir) this.#launcherDir = mkdtempSync(`${launcherRoot()}${this.#sessionSlug()}-`);
    return this.#launcherDir;
  }

  /**
   * The git shim's dir (git-shim.ts) in the session's launcher dir: a
   * launcher for the shim's spec (the command sandbox, offline, a fresh temp
   * dir per git, the CLI's worktree dirs writable) when the provider can
   * start a local program inside, else git defused.
   */
  #writeGitShim(provider: SandboxProvider, caller: string): string {
    if (this.#closed) throw new Error(`session ${this.#sessionId} is gone`);
    const launcherDir = this.#ensureLauncherDir();
    // Gone (a temp cleaner, #448 round 5): made again, so a CLI started now finds the shim, not the host's git.
    mkdirSync(launcherDir, { recursive: true, mode: 0o700 });
    const dir = join(launcherDir, "git-bin");
    let launcher: string | null = null;
    let program: string | null = null;
    if (provider.openSync && provider.capabilities.wrapsArgv && provider.capabilities.placement === "local") {
      const spec = gitShimSpec(this.#spec({ mode: "off" }, [], gitProgramLocations()), { tempParent: this.#ensureGitTempDir(), worktrees: cliWorktrees(this.#workdir) });
      const handle = this.#track(provider.openSync(spec));
      // In the caller's own directory, or not at all: one the sandbox hides isn't swapped for another (bwrap's `$HOME`).
      launcher = this.#writeLauncher(handle, [GIT_BIN], [], "git", CWD_FROM_CALLER);
      // The provider's own program (past the pin guard's shell): when it is gone, git runs defused.
      program = handle.wrap ? (unguardedArgv(handle.wrap([GIT_BIN], { cwd: "", env: {} }).argv)[0] ?? null) : null;
    }
    return writeGitShim(dir, { launcher, provider: program, caller, home: homedir() });
  }

  /** Where the shim's git gets a fresh temp dir per run where the provider needs a real one (Seatbelt): its own, not the session's. */
  #ensureGitTempDir(): string {
    if (!this.#gitTempDir) this.#gitTempDir = mkdtempSync(join(sandboxRoot(), `git-tmp-${this.#sessionSlug()}-`));
    mkdirSync(this.#gitTempDir, { recursive: true, mode: 0o700 });
    return this.#gitTempDir;
  }

  #writeLauncher(handle: SandboxHandle, argv: readonly string[], envNames: readonly string[], name?: string, cwd = ""): string {
    if (!handle.wrap) throw new Error(`${handle.providerId} can't start a local program inside`);
    const launcherDir = this.#ensureLauncherDir();
    // Started from wherever its caller is: the cwd is the caller's, not fixed here
    // (CWD_FROM_CALLER: named to the provider as the dir it is run from).
    const wrapped = handle.wrap(argv, { cwd, env: Object.fromEntries(envNames.map((n) => [n, ""])) });
    const path = join(launcherDir, `launch-${name ? name.replace(/[^A-Za-z0-9_-]/g, "") : ++this.#launchers}`);
    // Written beside it and renamed over it: a caller running it meanwhile gets the old one or the new one, whole.
    const part = `${path}.${++this.#launchers}.part`;
    writeFileSync(part, launcherScript(wrapped.argv), { mode: 0o700 });
    renameSync(part, path);
    return path;
  }

  /** Kept until closed (by its backend when its process ends, or with the session); a closed one is let go. */
  #track(h: SandboxHandle): SandboxHandle {
    const tracked = new TrackedHandle(h, () => this.#handles.delete(tracked));
    this.#handles.add(tracked);
    return tracked;
  }

  /** How many handles are open (tests). */
  get openHandles(): number {
    return this.#handles.size;
  }

  #spec(
    network: NetworkPolicy,
    backendState: readonly string[],
    readable: readonly string[] = [],
    dockerSocket = false,
    hideLocalServices = network.mode !== "on",
    dirs: { roots: readonly string[]; added: readonly string[]; scan?: RootScan } = this.#dirs,
  ): SandboxSpec {
    // A monorepo's package: the repository's top (#448 round 9), as pinned; the session's cwd stays the workdir.
    const workspace = this.#workspace();
    const folder = this.#worktreeFolderName(workspace, dirs.added);
    // The repositories' worktree entries looked at first: the spec holds every one the session didn't make.
    if (folder) {
      this.#checkEntries();
      for (const d of dirs.added) this.#checkEntriesOf(d);
    }
    const agent = new Set(this.effective().agentDirs);
    const build = () => buildSandboxSpec({
      backendReadable: readable,
      sessionId: this.#sessionId,
      workspace,
      workdir: this.#workdir,
      tempDir: this.#ensureTempDir(),
      network,
      ...(this.#config ? { config: this.#config } : {}),
      backendState,
      ...(folder ? { worktreeFolder: folder, ownWorktreeEntries: this.#entries.ownEntries() } : {}),
      dockerSocket,
      hideLocalServices,
      projectRoots: dirs.roots,
      addedDirs: dirs.added.map((dir) => {
        const guard = this.#guardFor(dir);
        return { dir, ...(agent.has(dir) ? { agent: true } : {}), ...(folder && guard ? { ownWorktreeEntries: guard.ownEntries() } : {}) };
      }),
      ...(this.#setting?.pins ? { pins: this.#setting.pins.ids } : {}),
      ...(dirs.scan ? { rootScan: dirs.scan } : {}),
    });
    let spec: SandboxSpec;
    try {
      spec = build();
    } catch (err) {
      // A pinned directory changed (pinned.ts): refused, and looked at again at the next resolution.
      if (err instanceof SandboxPinError) this.#pinsBroken = true;
      throw err;
    }
    for (const f of spec.worktreeFolders ?? []) this.#folders.add(f);
    this.#lastSpec = spec;
    this.#gateSpec = spec;
    return spec;
  }

  /** The worktree-entry guard of an added dir's repository: the workspace's own when it is the same repository; null outside one. */
  #guardFor(dir: string): WorktreeEntryGuard | null {
    const common = gitLayoutOf(dir)?.common;
    if (!common) return null;
    const mine = gitLayoutOf(this.#workspace())?.common;
    if (mine && resolve(mine) === resolve(common)) return this.#entries;
    let g = this.#addedEntries.get(resolve(common));
    if (!g) {
      g = new WorktreeEntryGuard();
      this.#addedEntries.set(resolve(common), g);
    }
    return g;
  }

  /**
   * Look at the repository's worktree entries now (#448 round 11,
   * worktree-entries.ts): what isn't as git makes it is restored where that
   * is certain, and said (onWorktreeEntries) either way. At the end of every
   * turn, at destroy, and when a spec is built. Only while the sandbox is on
   * (its commands are what could have changed them unseen). Never throws.
   */
  checkWorktreeEntries(): void {
    if (this.#closed || !this.#runtime) return;
    if (!this.#worktreeFolderName(this.#workspace(), this.#dirs.added)) return;
    this.#checkEntries();
    for (const d of this.#dirs.added) this.#checkEntriesOf(d);
  }

  #checkEntries(): void {
    this.#checkEntriesOf(this.#workspace(), this.#entries);
  }

  /** {@link checkWorktreeEntries} for the repository `workspace` is in (the workspace's, or an added dir's), with its guard. */
  #checkEntriesOf(workspace: string, guard: WorktreeEntryGuard | null = this.#guardFor(workspace)): void {
    try {
      const layout = gitLayoutOf(workspace);
      const folder = this.#folderName;
      if (!layout?.common || !folder || !guard) return;
      const opts = { roots: this.config.worktreeRoots, configDir: getConfigDir() };
      const main = mainCheckoutOf(layout);
      const last = this.#lastSpec;
      // Before the first spec, the folders as they are (nothing is made for a look).
      const folders = last ? [...(last.worktreeFolders ?? [])] : worktreeFoldersOf(layout, folder, { ...opts, workspace, make: false }).folders;
      const dot = main ? join(main, ".worktrees") : null;
      // In the repository's git dir as it is now, pinned for the look (pinned.ts, #448 round 14): what the guard
      // restores is written there, never where a link put in its place leads; changed meanwhile, it is refused.
      const commonDir = layout.common;
      const common = pinDir(realPathOnce(commonDir), "the repository's git dir", null, "the look at its worktree entries");
      const { findings, pending } = inPinnedDirSync(common, "the look at its worktree entries", () => guard.check({
        common: commonDir,
        main,
        ownFolders: folders,
        writable: [workspace, ...(this.#tempDir ? [this.#tempDir] : []), ...folders, ...(last?.writable ?? [])],
        readOnly: last?.readOnly ?? [],
        locations: [...worktreeLocationDirs(layout, opts).locations.map((l) => l.dir), ...(dot ? [dot] : [])],
      }));
      if (pending && !this.#entriesRecheck) {
        // An entry git may still be making: looked at once it is done.
        this.#entriesRecheck = setTimeout(() => {
          this.#entriesRecheck = null;
          this.checkWorktreeEntries();
        }, ENTRY_GRACE_MS + 100);
        this.#entriesRecheck.unref?.();
      }
      if (findings.length > 0) this.#onWorktreeEntries?.(layout.common, findings);
    } catch (err) {
      console.error(`[codeoid/sandbox ${this.#sessionId.slice(0, 8)}] looking at the repository's worktree entries failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Make the session's worktree folders again where {@link tidyFolders}
   * removed them (a turn's start: its commands, and a Claude query's sandbox,
   * need them there). Never through a link (worktrees.ts `worktreeFoldersOf`).
   */
  prepareFolders(): void {
    if (this.#closed || this.#folders.size === 0 || [...this.#folders].every((f) => existsSync(f))) return;
    for (const workspace of [this.#workspace(), ...this.#dirs.added]) {
      try {
        const layout = gitLayoutOf(workspace);
        if (!layout || !this.#folderName) continue;
        worktreeFoldersOf(layout, this.#folderName, { roots: this.config.worktreeRoots, configDir: getConfigDir(), workspace });
      } catch {
        /* a folder that can't be made: a worktree add there fails, as outside one */
      }
    }
  }

  /**
   * Remove the session's worktree folders that are empty, and the location
   * holding one when that is left empty too (#448 round 11: nothing of the
   * sandbox's stays beside your repository for a session that made no
   * worktree): never anything with something in it, never through a link.
   * At the end of a turn with nothing running, and with the session.
   */
  tidyFolders(): void {
    for (const f of this.#folders) {
      // Empty ones only, never through a link (pinned.ts, #448 round 14): the folder, then its location.
      for (const dir of [f, dirname(f)]) if (!removeEmptyDir(dir)) break;
    }
  }

  /**
   * The session's worktree folder name (#448 round 10, worktrees.ts): the
   * one it already has in a location (found by its short id, so a rename
   * or a daemon restart keeps it), else its name and short id. Null outside
   * a repository codeoid can verify.
   */
  #worktreeFolderName(workspace: string, added: readonly string[] = []): string | null {
    if (this.#folderName) return this.#folderName;
    // The workspace's repository first, then each added dir's: one name in every repository the session writes.
    const layouts = [workspace, ...added].map((d) => gitLayoutOf(d)).filter((l) => l?.common);
    if (layouts.length === 0) return null;
    const locations = layouts.flatMap((l) => (l ? worktreeLocationDirs(l, { roots: this.config.worktreeRoots, configDir: getConfigDir() }).locations : []));
    this.#folderName = existingFolderName(locations, this.#sessionId) ?? sessionFolderName(this.#name(), this.#sessionId);
    return this.#folderName;
  }

  /**
   * Where the session's commands may check a git worktree out: its own
   * folder in each worktree location (SandboxSpec.worktreeFolders), as the
   * running sandbox has them; empty without one.
   */
  worktreeFolders(): string[] {
    try {
      return [...(this.#runtime?.spec.worktreeFolders ?? [])];
    } catch {
      return [];
    }
  }

  /** The session's private temp dir (made on first use, 0700). */
  #ensureTempDir(): string {
    if (!this.#tempDir) this.#tempDir = mkdtempSync(join(sandboxRoot(), `tmp-${this.#sessionSlug()}-`));
    return this.#tempDir;
  }

  async #closeHandles(): Promise<void> {
    const handles = [...this.#handles];
    this.#handles.clear();
    await Promise.all(handles.map((h) => h.close().catch(() => {})));
  }

  /** End everything opened for the session and remove its temp dir (idempotent). */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#runtime = null;
    await this.#closeHandles();
    if (this.#tempDir) {
      rmSync(this.#tempDir, { recursive: true, force: true });
      this.#tempDir = null;
    }
    for (const dir of [this.#launcherDir, this.#homesDir, this.#gitTempDir, this.#claudeTemp ? join(this.#claudeTemp.cli, "..") : null]) {
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
    if (this.#entriesRecheck) {
      clearTimeout(this.#entriesRecheck);
      this.#entriesRecheck = null;
    }
    // The session's worktree folders it left empty: never one with anything in it (a worktree is the user's to keep).
    this.tidyFolders();
    this.#folders.clear();
    this.#launcherDir = null;
    this.#gitTempDir = null;
    this.#homesDir = null;
    this.#claudeTemp = null;
  }
}

/** A handle the session tracks, let go of when closed. */
class TrackedHandle implements SandboxHandle {
  readonly #inner: SandboxHandle;
  readonly #onClose: () => void;
  readonly wrap?: SandboxHandle["wrap"];

  constructor(inner: SandboxHandle, onClose: () => void) {
    this.#inner = inner;
    this.#onClose = onClose;
    if (inner.wrap) this.wrap = inner.wrap.bind(inner);
  }

  get providerId(): string {
    return this.#inner.providerId;
  }

  get spec(): SandboxSpec {
    return this.#inner.spec;
  }

  spawn(command: string, args: readonly string[], opts: SandboxSpawnOptions) {
    return this.#inner.spawn(command, args, opts);
  }

  exec(argv: readonly string[], opts: SandboxExecOptions): Promise<SandboxExecResult> {
    return this.#inner.exec(argv, opts);
  }

  async close(): Promise<void> {
    this.#onClose();
    await this.#inner.close();
  }
}

/** A word as the shell reads it literally. */
export function shellQuote(word: string): string {
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

/**
 * A POSIX sh script that execs `argv` with its own arguments appended. A
 * word that is {@link CWD_FROM_CALLER} becomes the directory it is run from.
 */
export function launcherScript(argv: readonly string[]): string {
  const words = argv.map((w) => (w === CWD_FROM_CALLER ? '"$PWD"' : shellQuote(w)));
  return `#!/bin/sh\n# Written by codeoid (#448): starts a backend inside its session's sandbox.\nexec ${words.join(" ")} "$@"\n`;
}

export { launcherRoot } from "./root.js";

/** How a check runs (#448): inside a sandbox, refused (the one asked for can't run), or as is (off / no sandboxing). */
export type CheckSandbox =
  | { kind: "on"; wrap: NonNullable<SandboxHandle["wrap"]>; close(): Promise<void> }
  | { kind: "refused"; reason: string }
  | { kind: "off" };

/**
 * A sandbox for a daemon-run check over agent-written code (a loop's
 * acceptance checks, a routine's gate): the same setting a session would
 * resolve, the check's directory as the workspace, a fresh private temp dir.
 * Off (by setting) runs as is; one that can't run here, or can't hold its
 * network, is refused (the check doesn't run).
 */
export async function openCheckSandbox(opts: {
  registry: SandboxRegistry;
  config: CodeoidConfig | undefined;
  setting: SessionSandboxSetting | undefined;
  workspace: string;
  label: string;
}): Promise<CheckSandbox> {
  const cfg = sandboxConfigOf(opts.config);
  const { choice, network, dockerSocket } = effectiveSetting(cfg, opts.setting);
  if (choice === SANDBOX_OFF) return { kind: "off" };
  const resolved = await opts.registry.resolve(choice);
  if (resolved.kind === "off") return { kind: "off" };
  if (resolved.kind === "unknown") return { kind: "refused", reason: resolved.reason };
  if (!resolved.probe.available) return { kind: "refused", reason: resolved.probe.reason };
  const provider = resolved.provider;
  if (!provider.capabilities.commands || !provider.capabilities.wrapsArgv) {
    return { kind: "refused", reason: `${provider.displayName} can't run a local command` };
  }
  const rootProblem = workspaceProblem(opts.workspace);
  if (rootProblem) return { kind: "refused", reason: rootProblem };
  const mode: NetworkMode = provider.capabilities.network.includes(network.mode) ? network.mode : "off";
  const safe = opts.label.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || "check";
  const tempDir = mkdtempSync(join(sandboxRoot(), `check-${safe}-`));
  let handle: SandboxHandle;
  try {
    const spec = buildSandboxSpec({
      sessionId: `check-${safe}`,
      workspace: sandboxWorkspaceOf(opts.workspace),
      workdir: opts.workspace,
      tempDir,
      network: mode === "allowlist" ? network : { mode },
      ...(opts.config ? { config: opts.config } : {}),
      // A check that starts containers (testcontainers) gets the socket when the owner let the run's sandbox have it.
      dockerSocket,
    });
    handle = await provider.open(spec);
  } catch (err) {
    // Nothing opened: nothing of it is left behind.
    rmSync(tempDir, { recursive: true, force: true });
    throw err;
  }
  if (!handle.wrap) {
    await handle.close();
    rmSync(tempDir, { recursive: true, force: true });
    return { kind: "refused", reason: `${provider.displayName} can't run a local command` };
  }
  return {
    kind: "on",
    wrap: handle.wrap.bind(handle),
    close: async () => {
      await handle.close();
      rmSync(tempDir, { recursive: true, force: true });
    },
  };
}
