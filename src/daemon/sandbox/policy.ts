/**
 * What a session's sandbox hides, makes writable and lets through (#448):
 * the workspace-write policy, as a {@link SandboxSpec}.
 *
 *   - the user's home is hidden whole (deny by default: a credential made
 *     after the sandbox started, or put back by a rename, or simply not on
 *     any list, isn't there), then shown again: the workspace (writable) when
 *     it is inside, a read-only allowlist of toolchains and tool settings that
 *     hold no secrets (`sandbox.homeReadable`), and what the backend itself
 *     needs (its program, its private home: backend-home.ts);
 *   - writable: the workspace, a private temp dir, a git worktree's own git
 *     dir and its repository's objects and refs, and (only when a backend's
 *     whole process is inside) that backend's private home;
 *   - read-only inside the writable: a repository's `hooks/` and `config`;
 *   - hidden besides: codeoid's config dir and every data dir it owns
 *     (database, transcripts, opencode's, memory's, the lock files) wherever
 *     they are, the agent CLIs' logins and what backends registered as
 *     credentials (secret-paths.ts), the usual credential stores (SSH, cloud
 *     CLIs, kube, docker, gnupg, gh, netrc, git credentials, keyrings: what
 *     a workspace that holds the home would show), the daemon's own temp dir,
 *     the desktop session's runtime dir, plus `sandbox.hiddenPaths`;
 *   - container runtime sockets: never reachable;
 *   - network per policy.
 */

import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { CodeoidConfig } from "../../config.js";
import { getConfigDir } from "../../config.js";
import { daemonOwnedDirs } from "../data-lock.js";
import type { HeldPath } from "../held-writes.js";
import { cliCredentialFiles, registeredSecretLocations } from "../secret-paths.js";
import { DEFAULT_HOME_READABLE } from "./home-readable.js";
import { validAllowedHost } from "./hosts.js";
import { sandboxRoot } from "./root.js";
import type { NetworkMode, NetworkPolicy, SandboxSpec } from "./types.js";

export { DEFAULT_HOME_READABLE, validAllowedHost };

/** `sandbox.*` in the config (config.ts `SandboxSchema`). */
export interface SandboxConfig {
  /** `auto` (bwrap on Linux, Seatbelt on macOS), `off`, or a provider id. */
  provider: string;
  network: NetworkMode;
  /** Hosts a command may reach with `network: allowlist`. */
  allowedHosts: string[];
  /** More paths to hide, on top of the built-in list (`~` expands). */
  hiddenPaths: string[];
  /**
   * What of the (otherwise hidden) home stays readable, read-only (`~`
   * expands): toolchains and tool settings that hold no secrets.
   */
  homeReadable: string[];
  /** The bwrap binary (default: on PATH). */
  bwrapPath?: string;
  docker: {
    /** Image a Docker sandbox runs; must carry what the backend runs (a shell, node for pi / the Gemini CLI). */
    image: string;
    /** `--runtime` (e.g. `runsc` for gVisor). */
    runtime?: string;
  };
}


export const DEFAULT_SANDBOX_CONFIG: SandboxConfig = {
  provider: "auto",
  network: "on",
  allowedHosts: [],
  hiddenPaths: [],
  homeReadable: [...DEFAULT_HOME_READABLE],
  docker: { image: "node:22-bookworm-slim" },
};

export function sandboxConfigOf(config: Pick<CodeoidConfig, "sandbox"> | undefined): SandboxConfig {
  const s = config?.sandbox;
  return {
    ...DEFAULT_SANDBOX_CONFIG,
    ...(s ?? {}),
    docker: { ...DEFAULT_SANDBOX_CONFIG.docker, ...(s?.docker ?? {}) },
  };
}

function expandHome(p: string, home: string): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return join(home, p.slice(2));
  return p;
}

/**
 * Credential stores every user may have, relative to the home directory:
 * SSH keys, cloud CLIs, kube, container registries, GPG, GitHub CLI, netrc,
 * git's stored credentials, desktop keyrings and password stores, package
 * registry tokens that live in their own file.
 */
export const HOME_CREDENTIAL_PATHS: readonly string[] = [
  ".ssh",
  ".aws",
  ".azure",
  ".config/gcloud",
  ".kube",
  ".docker",
  ".gnupg",
  ".config/gh",
  ".config/hub",
  ".config/glab-cli",
  ".netrc",
  ".git-credentials",
  ".config/git/credentials",
  ".local/share/keyrings",
  ".password-store",
  ".config/op",
  ".vault-token",
  ".pypirc",
  ".cargo/credentials",
  ".cargo/credentials.toml",
  ".terraform.d/credentials.tfrc.json",
  ".claude.json",
  "Library/Keychains",
  // Other agents' and tools' logins.
  ".local/share/opencode/auth.json",
  ".local/share/opencode/mcp-auth.json",
  ".config/github-copilot",
  ".pgpass",
  ".config/rclone",
  ".s3cfg",
  ".boto",
  ".pulumi/credentials.json",
  ".config/doctl",
  ".fly",
  ".npmrc",
  ".bunfig.toml",
  ".yarnrc.yml",
  ".gradle/gradle.properties",
  ".m2/settings.xml",
  ".local/share/uv/credentials",
];

/**
 * Container runtime sockets (and the dirs that hold them). Reaching one is
 * root on the machine, so none is ever visible inside, whatever else is.
 */
export function containerSocketPaths(home: string, env: Record<string, string | undefined> = process.env): string[] {
  const runtime = env.XDG_RUNTIME_DIR || (typeof process.getuid === "function" ? `/run/user/${process.getuid()}` : "");
  const out = [
    "/run/docker.sock",
    "/var/run/docker.sock",
    "/run/containerd",
    "/var/run/containerd",
    "/run/podman",
    "/var/run/podman",
    "/run/crio",
    "/var/run/crio",
    "/run/buildkit",
    "/run/k3s",
    join(home, ".docker/run"),
    join(home, ".colima"),
    join(home, ".lima"),
    join(home, ".rd"),
    join(home, ".orbstack"),
  ];
  if (runtime) out.push(join(runtime, "docker.sock"), join(runtime, "podman"), join(runtime, "containerd"));
  const dockerHost = env.DOCKER_HOST;
  if (dockerHost?.startsWith("unix://")) out.push(dockerHost.slice("unix://".length));
  return out;
}

/** Environment variables that point into the desktop session or an agent: never handed inside. */
export const SANDBOX_UNSET_ENV: readonly string[] = [
  "SSH_AUTH_SOCK",
  "SSH_AGENT_PID",
  "GPG_AGENT_INFO",
  "DBUS_SESSION_BUS_ADDRESS",
  "DOCKER_HOST",
  "CONTAINER_HOST",
  "KUBECONFIG",
];

export interface HiddenPathInputs {
  home?: string;
  configDir?: string;
  env?: Record<string, string | undefined>;
  /** The daemon's temp dir (os.tmpdir()): sign-in homes and the like live there. */
  daemonTmp?: string;
}

/**
 * Every path a sandbox hides for `config`, before a backend's own state is
 * taken out ({@link buildSandboxSpec}). Absolute, deduplicated; each that
 * is a symlink also by where it leads.
 */
export function hiddenPathsFor(config: CodeoidConfig | undefined, inputs: HiddenPathInputs = {}): string[] {
  const env = inputs.env ?? process.env;
  const home = inputs.home ?? env.HOME ?? homedir();
  const configDir = inputs.configDir ?? getConfigDir();
  const out: string[] = [configDir];
  if (config) {
    try {
      for (const d of daemonOwnedDirs(config)) out.push(d.dir);
    } catch {
      /* a config without the data dirs (tests): the config dir still is */
    }
  }
  for (const f of cliCredentialFiles()) out.push(f);
  const registered = registeredSecretLocations();
  out.push(...registered.dirs, ...registered.files);
  for (const rel of HOME_CREDENTIAL_PATHS) out.push(join(home, rel));
  // The desktop session's runtime dir: keyring, D-Bus, agent sockets.
  const runtime = env.XDG_RUNTIME_DIR || (typeof process.getuid === "function" ? `/run/user/${process.getuid()}` : "");
  if (runtime) out.push(runtime);
  // An agent socket wherever it is.
  if (env.SSH_AUTH_SOCK) out.push(dirname(env.SSH_AUTH_SOCK));
  // The daemon's own temp dir, when it isn't /tmp (which the sandbox replaces).
  const daemonTmp = inputs.daemonTmp ?? tmpdir();
  if (daemonTmp && resolve(daemonTmp) !== "/tmp") out.push(daemonTmp);
  const extra = sandboxConfigOf(config).hiddenPaths;
  for (const p of extra) {
    const abs = expandHome(p, home);
    if (isAbsolute(abs)) out.push(abs);
  }
  const all = new Set<string>();
  for (const p of out) {
    const abs = resolve(p);
    all.add(abs);
    try {
      if (existsSync(abs)) all.add(realpathSync(abs));
    } catch {
      /* unreadable: the literal path stands */
    }
  }
  return [...all];
}

function within(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith("/") ? parent : `${parent}/`);
}

export interface SpecInputs {
  sessionId: string;
  workspace: string;
  tempDir: string;
  network: NetworkPolicy;
  config?: CodeoidConfig;
  /**
   * What the backend's own process must still reach when it runs inside
   * (its private home: backend-home.ts, and the conversations it shares with
   * the vendor's). Taken out of the hidden list and made writable. Empty when
   * only commands run inside.
   */
  backendState?: readonly string[];
  /** Read-only locations the backend's process needs inside a hidden one (its program, its login). */
  backendReadable?: readonly string[];
  hidden?: HiddenPathInputs;
  /** Look for the workspace's git repository (default: yes). */
  git?: boolean;
  /** Hold the workspace's project settings read-only (default: yes; projectConfigPaths). */
  projectConfig?: boolean;
  /** Give the toolchains a writable cache (default: yes; sandboxCacheDir). */
  cache?: boolean;
}

/** The home a spec hides: absolute, and not `/` (nothing is left to show then). */
function hiddenHome(home: string): string | null {
  const h = resolve(home);
  return isAbsolute(home) && h !== "/" ? h : null;
}

/** `sandbox.homeReadable`, absolute (`~` expanded). */
export function homeReadablePaths(config: CodeoidConfig | undefined, home: string): string[] {
  const out: string[] = [];
  for (const p of sandboxConfigOf(config).homeReadable) {
    const abs = expandHome(p, home);
    if (isAbsolute(abs)) out.push(resolve(abs));
  }
  return out;
}

/**
 * Credential files inside a readable allowlist entry, hidden again: a
 * global npmrc of an nvm-installed node (`~/.nvm/versions/node/<v>/etc/npmrc`).
 */
export function homeCredentialFilesIn(readable: readonly string[]): string[] {
  const out: string[] = [];
  for (const r of readable) {
    if (!r.endsWith(`${sep}.nvm`)) continue;
    let versions: string[] = [];
    try {
      versions = readdirSync(join(r, "versions", "node"));
    } catch {
      continue;
    }
    for (const v of versions) out.push(join(r, "versions", "node", v, "etc", "npmrc"));
  }
  return out;
}

/** What a sandbox makes of the workspace's git repository. */
export interface GitPaths {
  /**
   * Writable, each bound at its own path (so none can be renamed or
   * replaced): the repository's git dir, a linked worktree's own git dir,
   * and the `worktrees/` dir that holds the worktrees' git dirs.
   */
  writable: string[];
  /**
   * Read-only even where the rest is writable: everything that decides which
   * config, hooks and git dir git uses (see {@link gitWorkspacePaths}).
   */
  readOnly: string[];
  /** The git dirs a commit writes in: what a backend's own sandbox must also let it write (Codex's writable roots). */
  gitDirs: string[];
}

/**
 * In a git dir, what decides which config, hooks and git dirs git uses:
 * held read-only from inside. `commondir` (in any git dir) names the
 * repository git reads its config and hooks from; `config.worktree` is read
 * where the config turns it on; `info/` holds attributes and sparse rules,
 * `modules/` the submodules' git dirs (each with its own config and hooks),
 * `remotes/` and `branches/` remotes defined as files, `worktrees/` the
 * linked worktrees' git dirs (each naming its repository in `commondir`).
 */
export const GIT_CONTROL = ["config", "config.worktree", "commondir", "hooks", "info", "modules", "remotes", "branches", "worktrees"] as const;
/** In a linked worktree's own git dir: what names its repository and its checkout, and its own config. */
const WORKTREE_CONTROL = ["commondir", "gitdir", "config.worktree"] as const;
/** Made when missing, so there is something to hold read-only: empty dirs, and an empty `config.worktree` (read only where the config turns it on). */
const GIT_PLACEHOLDER_DIRS = ["hooks", "info", "modules", "remotes", "branches", "worktrees"] as const;

function readGitFile(dotgit: string): string | null {
  try {
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotgit, "utf8"));
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Where the workspace's repository is, as git finds it (no side effects). */
export interface GitLayout {
  /** The workspace's `.git` (a dir, or a file naming its git dir). */
  dotgit: string;
  /**
   * `plain`: `.git` is the repository's git dir; `worktree`: a linked
   * worktree in git's own layout; `submodule`: a `.git` file naming a git
   * dir whose `core.worktree` names this checkout back (a submodule's under
   * `<super>/.git/modules/`); `unknown`: a `.git` file naming anything
   * else (a `--separate-git-dir` checkout, which names nothing back), or a
   * `.git` that isn't a git dir.
   */
  kind: "plain" | "worktree" | "submodule" | "unknown";
  /** The repository's git dir (its config, hooks, objects, refs); null for `unknown`. */
  common: string | null;
  /** A linked worktree's own git dir. */
  own: string | null;
  /** What an `unknown` `.git` file names, absolute. */
  named?: string;
}

/**
 * The workspace's git repository, found as git finds it: the nearest `.git`
 * at or above the workspace, below the home (never the home's own, a
 * dotfiles repository, or the root's). Null when there is none.
 */
export function gitLayoutOf(workspace: string, home: string = process.env.HOME ?? homedir()): GitLayout | null {
  const ws = resolve(workspace);
  const stop = resolve(home);
  let dotgit: string | null = null;
  for (let dir = ws; ; dir = dirname(dir)) {
    if (dir === stop || dir === "/") break;
    if (lexists(join(dir, ".git"))) {
      dotgit = join(dir, ".git");
      break;
    }
    if (dirname(dir) === dir) break;
  }
  if (!dotgit) return null;
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(dotgit);
  } catch {
    return null;
  }
  if (st.isDirectory()) return gitDirShape(dotgit) ? { dotgit, kind: "plain", common: dotgit, own: null } : { dotgit, kind: "unknown", common: null, own: null };
  if (!st.isFile()) return { dotgit, kind: "unknown", common: null, own: null };
  const named = readGitFile(dotgit);
  if (!named) return { dotgit, kind: "unknown", common: null, own: null };
  const gitDir = resolve(dirname(dotgit), named);
  const common = dirname(dirname(gitDir));
  if (basename(dirname(gitDir)) === "worktrees" && validWorktree(gitDir, common, dotgit)) return { dotgit, kind: "worktree", common, own: gitDir };
  if (validSubmodule(gitDir, dotgit)) return { dotgit, kind: "submodule", common: gitDir, own: null };
  return { dotgit, kind: "unknown", common: null, own: null, named: gitDir };
}

/**
 * What a sandbox makes of the workspace's git repository ({@link gitLayoutOf}).
 *
 * A commit writes the worktree's git dir (index, HEAD, logs, lock files)
 * and the repository's objects, refs, logs and `packed-refs` (with its
 * lock, taken beside it), so those git dirs are writable. Nothing of the
 * repository's structure is: whatever decides which config, hooks or git
 * dir git uses would run outside the sandbox at the user's next git
 * command (`core.fsmonitor`, a hook, a filter in a config git was pointed
 * at). So, read-only:
 *
 *   - in the repository's git dir: `config`, `config.worktree`,
 *     `commondir`, `hooks/`, `info/`, `modules/`, `remotes/`, `branches/`
 *     and `worktrees/` whole ({@link GIT_CONTROL}): every worktree's git
 *     dir, those added after the sandbox opened too;
 *   - in a linked worktree's own git dir (bound writable on top of
 *     `worktrees/`): `commondir`, `gitdir`, `config.worktree`;
 *   - the workspace's `.git` file, and the `.git` file of every other
 *     worktree or submodule checked out inside the workspace;
 *   - a plain repository at the top of the workspace: an empty `HEAD/`
 *     beside its `.git` (made when missing; git doesn't see an empty dir).
 *     A `.git` made invalid (its `HEAD` garbled, `refs/` removed) would
 *     have git take the workspace's top for a bare repository next, with a
 *     config planted there; a `HEAD` that is a directory isn't one.
 *
 * The git dirs themselves are bound writable at their own paths (the
 * workspace's `.git` dir too), so none can be renamed away and rebuilt. A
 * git dir must stay writable for git's lock files, so what isn't there yet
 * is made first, to hold read-only: empty `hooks/`, `info/`, `modules/`,
 * `remotes/`, `branches/`, `worktrees/`, an empty `config.worktree` in
 * every git dir of the repository, and `commondir` in the repository's git
 * dir holding `.`, which git reads as that git dir itself. When an entry
 * that must be held read-only is a link (which a bind can't hold: it can be
 * replaced), the git dir is read-only whole instead, and committing from
 * inside fails.
 *
 * A `.git` file is the agent's to write, so what it names is believed only
 * where git's own records name it back: a linked worktree
 * (`<common>/worktrees/<name>`, whose `gitdir` names this `.git`) or a
 * submodule (a git dir whose `core.worktree` names this checkout), in a git
 * dir with `objects/` and `HEAD`. Any other `.git` file is held read-only,
 * and so is what it names when that is inside the workspace: nothing
 * commits from inside then ({@link gitLayoutProblem} says so).
 */
export function gitWorkspacePaths(workspace: string, home: string = process.env.HOME ?? homedir()): GitPaths {
  const out: GitPaths = { writable: [], readOnly: [], gitDirs: [] };
  const ws = resolve(workspace);
  const layout = gitLayoutOf(ws, home);
  if (!layout) return out;
  const { dotgit, own } = layout;
  // A `.git` dir right at the top of the workspace: git's fallback when it is made invalid must find nothing.
  if (dirname(dotgit) === ws && !isLink(dotgit) && lstatSync(dotgit).isDirectory()) {
    const head = join(ws, "HEAD");
    makeIfMissing(head, "dir");
    if (emptyDir(head)) out.readOnly.push(head);
  }
  const common = layout.common;
  if (!common) {
    // Not a layout codeoid can verify: nothing of it is writable, the `.git` file can't be rewritten.
    if (lexists(dotgit) && !isLink(dotgit) && within(dotgit, ws) && !lstatSync(dotgit).isDirectory()) out.readOnly.push(dotgit);
    if (layout.named && within(layout.named, ws) && lexists(layout.named) && !isLink(layout.named)) out.readOnly.push(layout.named);
    if (lstatSync(dotgit).isDirectory() && !isLink(dotgit) && within(dotgit, ws)) out.readOnly.push(dotgit);
    return out;
  }
  // What isn't there yet can't be held read-only (a git dir stays writable for its lock files): made first.
  for (const dir of GIT_PLACEHOLDER_DIRS) makeIfMissing(join(common, dir), "dir");
  makeIfMissing(join(common, "config.worktree"), "");
  // `.` is the git dir itself, as git, libgit2 and gitoxide read it: one an agent writes can't send git elsewhere.
  makeIfMissing(join(common, "commondir"), ".\n");
  const worktrees = join(common, "worktrees");
  const others: string[] = [];
  for (const name of listDirs(worktrees)) {
    const dir = join(worktrees, name);
    makeIfMissing(join(dir, "config.worktree"), "");
    if (own && resolve(dir) === resolve(own)) continue;
    others.push(dir);
  }
  const control = [
    ...GIT_CONTROL.map((n) => join(common, n)),
    ...(own ? WORKTREE_CONTROL.map((n) => join(own, n)) : []),
  ].filter((p) => lexists(p));
  const dotgitFile = dotgit !== common;
  // A link can't be held by a bind (it can be replaced): the git dir is read-only whole, and nothing commits from inside.
  if (control.some(isLink) || (own && isLink(own)) || isLink(common)) {
    out.readOnly.push(common);
    if (dotgitFile) out.readOnly.push(dotgit);
    return out;
  }
  out.writable.push(common);
  // Over the read-only `worktrees/`: this worktree's own git dir, writable, its control read-only again.
  if (own) out.writable.push(own);
  out.readOnly.push(...control);
  if (dotgitFile) out.readOnly.push(dotgit);
  // Other checkouts of this repository inside the workspace (a worktree, a submodule): their `.git` files too.
  for (const f of [...others.map((d) => gitdirTarget(d)), ...submoduleCheckouts(join(common, "modules"))]) {
    if (f && f !== dotgit && within(f, ws) && lexists(f) && !isLink(f)) out.readOnly.push(f);
  }
  out.gitDirs.push(common, ...(own ? [own] : []));
  return out;
}

/**
 * What a file tool that runs outside the sandbox (Claude's Write and Edit,
 * opencode's, any in a backend's own process) must not write unasked while
 * the sandbox is on (#448): the repository's git dirs and its `.git`, the
 * `.git` files of other checkouts in the workspace, and the project settings
 * ({@link PROJECT_CONFIG_DIRS} whole, {@link PROJECT_CONFIG_FILES}). The
 * sandbox holds them read-only for commands; a file tool isn't one. No side
 * effects (nothing is made).
 */
export function protectedWriteTargets(workspace: string, home: string = process.env.HOME ?? homedir()): HeldPath[] {
  const ws = resolve(workspace);
  const out: HeldPath[] = [];
  const layout = gitLayoutOf(ws, home);
  if (layout) {
    for (const p of [layout.dotgit, layout.common, layout.own, layout.named]) if (p) out.push({ at: p, whole: true, what: "git" });
    if (layout.common) {
      const others = listDirs(join(layout.common, "worktrees")).map((n) => gitdirTarget(join(layout.common as string, "worktrees", n)));
      for (const f of [...others, ...submoduleCheckouts(join(layout.common, "modules"))]) if (f && within(f, ws)) out.push({ at: f, whole: true, what: "git" });
    }
  }
  for (const d of PROJECT_CONFIG_DIRS) out.push({ at: join(ws, d), whole: true, what: "settings" });
  for (const f of PROJECT_CONFIG_FILES) out.push({ at: join(ws, f), whole: false, what: "settings" });
  return out;
}

/** Why the workspace's repository gets no git protection the sandbox can verify, or null (a `.git` file in no layout git records). */
export function gitLayoutProblem(workspace: string, home: string = process.env.HOME ?? homedir()): string | null {
  const layout = gitLayoutOf(workspace, home);
  if (layout?.kind !== "unknown") return null;
  return `the repository's .git (${layout.dotgit}) names ${layout.named ? `a git dir (${layout.named})` : "nothing"} git's own records don't name back (a --separate-git-dir checkout?): the sandbox holds it read-only, so committing from inside fails`;
}

/** An empty directory (not a link). */
function emptyDir(p: string): boolean {
  try {
    return lstatSync(p).isDirectory() && readdirSync(p).length === 0;
  } catch {
    return false;
  }
}

/** git's own record that `gitDir` is the submodule git dir checked out at `dotgit`'s dir: its `core.worktree` names it back. */
function validSubmodule(gitDir: string, dotgit: string): boolean {
  try {
    if (!lstatSync(gitDir).isDirectory() || !gitDirShape(gitDir)) return false;
    // Its own repository: no `commondir`, or the `.` placeholder (gitWorkspacePaths).
    if (lexists(join(gitDir, "commondir")) && readFileSync(join(gitDir, "commondir"), "utf8").trim() !== ".") return false;
    const m = /^\s*worktree\s*=\s*(.+?)\s*$/im.exec(readFileSync(join(gitDir, "config"), "utf8"));
    if (!m?.[1]) return false;
    return realpathSync(resolve(gitDir, m[1])) === realpathSync(dirname(dotgit));
  } catch {
    return false;
  }
}

/** A git dir as git checks one: `objects/` and `HEAD`. */
function gitDirShape(dir: string): boolean {
  try {
    return lstatSync(join(dir, "objects")).isDirectory() && lstatSync(join(dir, "HEAD")).isFile();
  } catch {
    return false;
  }
}

function lexists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

function isLink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/** A dir (`"dir"`) or a file with `content`, made only where nothing (not even a link) is: never through one. Whether it was made. */
function makeIfMissing(p: string, content: string): boolean {
  try {
    if (content === "dir") mkdirSync(p, { mode: 0o755 });
    else writeFileSync(p, content, { flag: "wx", mode: 0o644 });
    return true;
  } catch {
    /* there already, or a repository codeoid can't write either */
    return false;
  }
}

/** The line codeoid's entries in a repository's `info/exclude` follow. */
const EXCLUDE_MARK = "# codeoid sandbox placeholders (#448): empty configs that keep these from being created inside";

/**
 * Keep the placeholder files codeoid made at the workspace's top out of
 * `git status` and `git add -A`, as its empty dirs are: listed in the
 * repository's `info/exclude` (read-only from inside), each anchored to its
 * place in the worktree. Never through a link; best effort.
 */
function excludePlaceholders(workspace: string, home: string, names: readonly string[]): void {
  if (names.length === 0) return;
  const layout = gitLayoutOf(workspace, home);
  if (!layout?.common) return;
  const info = join(layout.common, "info");
  const exclude = join(info, "exclude");
  try {
    if (!lexists(info)) mkdirSync(info, { mode: 0o755 });
    if (isLink(info) || isLink(exclude)) return;
    const rel = relative(dirname(layout.dotgit), resolve(workspace));
    if (rel.startsWith("..") || isAbsolute(rel)) return;
    const have = lexists(exclude) ? readFileSync(exclude, "utf8") : "";
    const lines = have.split("\n");
    const add = names.map((n) => `/${rel ? `${rel.split(sep).join("/")}/` : ""}${n}`).filter((l) => !lines.includes(l));
    if (add.length === 0) return;
    const head = lines.includes(EXCLUDE_MARK) ? [] : [EXCLUDE_MARK];
    writeFileSync(exclude, `${have}${have && !have.endsWith("\n") ? "\n" : ""}${[...head, ...add].join("\n")}\n`, { flag: "w" });
  } catch {
    /* a repository codeoid can't write: the placeholder shows in `git status` */
  }
}

function listDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/** The `.git` file a worktree's git dir names as its checkout's (its `gitdir` file), absolute. */
function gitdirTarget(worktreeGitDir: string): string | null {
  try {
    const named = readFileSync(join(worktreeGitDir, "gitdir"), "utf8").trim();
    return named ? resolve(worktreeGitDir, named) : null;
  } catch {
    return null;
  }
}

/**
 * The `.git` files of the submodules checked out from `modules` (each
 * submodule's git dir names its checkout in `core.worktree`), nested ones
 * included; bounded.
 */
function submoduleCheckouts(modules: string, depth = 0, budget = { left: 200 }): string[] {
  const out: string[] = [];
  if (depth > 4) return out;
  for (const name of listDirs(modules)) {
    if (--budget.left < 0) break;
    const dir = join(modules, name);
    if (gitDirShape(dir)) {
      try {
        const m = /^\s*worktree\s*=\s*(.+?)\s*$/im.exec(readFileSync(join(dir, "config"), "utf8"));
        if (m?.[1]) out.push(join(resolve(dir, m[1]), ".git"));
      } catch {
        /* no config: not checked out */
      }
      out.push(...submoduleCheckouts(join(dir, "modules"), depth + 1, budget));
    } else {
      // A submodule named with a slash (`libs/a`): its git dir is a level down.
      out.push(...submoduleCheckouts(dir, depth + 1, budget));
    }
  }
  return out;
}

/** git's own record that `gitDir` is the worktree whose `.git` file is `dotgit`, in a real repository `common`. */
function validWorktree(gitDir: string, common: string, dotgit: string): boolean {
  try {
    if (!lstatSync(common).isDirectory() || !lstatSync(join(common, "objects")).isDirectory() || !lstatSync(join(common, "HEAD")).isFile()) return false;
    if (!lstatSync(gitDir).isDirectory()) return false;
    const back = readFileSync(join(gitDir, "gitdir"), "utf8").trim();
    return realpathSync(resolve(gitDir, back)) === realpathSync(dotgit);
  } catch {
    return false;
  }
}

/**
 * Project settings agent CLIs load from a workspace and run code from, on
 * the host, in a later session (a Claude hook, an MCP server, a pi or
 * opencode extension; your own `opencode` loads a project `opencode.json`'s
 * MCP servers and plugins at its start): read-only from inside, so a command
 * of one backend can't plant what another runs outside any sandbox.
 * Directories whole (made empty first where missing: git doesn't see an
 * empty dir), so nothing can be added in them either; the files at the
 * workspace's top made first where missing too, holding the empty config
 * each CLI reads as nothing ({@link PROJECT_CONFIG_PLACEHOLDERS}; an empty
 * dir there breaks opencode's config load).
 */
export const PROJECT_CONFIG_DIRS: readonly string[] = [".claude", ".gemini", ".qwen", ".codex", ".pi", ".opencode"];
export const PROJECT_CONFIG_FILES: readonly string[] = [".mcp.json", "opencode.json", "opencode.jsonc"];
/** What a project config file is made with where missing: an empty config, read by its CLI as none (checked: Claude's CLI, opencode 2.2.5). */
export const PROJECT_CONFIG_PLACEHOLDERS: Readonly<Record<string, string>> = {
  ".mcp.json": '{"mcpServers":{}}\n',
  "opencode.json": "{}\n",
  "opencode.jsonc": "{}\n",
};

/**
 * {@link PROJECT_CONFIG_DIRS} and {@link PROJECT_CONFIG_FILES} of
 * `workspace`, made when missing — but only in a project's own
 * directory: in the home itself (where `~/.claude`, `~/.codex`, … are the
 * CLIs' own config dirs), a directory holding it, a temp root or `/`, what
 * is there is held and nothing is made.
 */
export function projectConfigPaths(workspace: string, home: string = process.env.HOME ?? homedir()): string[] {
  const out: string[] = [];
  const ws = realOr(resolve(workspace));
  const shared = ws === "/" || within(realOr(resolve(home)), ws) || [tmpdir(), "/tmp", "/var/tmp"].some((t) => realOr(resolve(t)) === ws);
  for (const name of PROJECT_CONFIG_DIRS) {
    const at = join(workspace, name);
    if (!shared) makeIfMissing(at, "dir");
    // A link can't be held by a bind (it can be replaced); a dir it leads to outside the workspace is out of reach anyway.
    if (lexists(at) && !isLink(at)) out.push(at);
  }
  const made: string[] = [];
  for (const name of PROJECT_CONFIG_FILES) {
    const at = join(workspace, name);
    if (!shared && makeIfMissing(at, PROJECT_CONFIG_PLACEHOLDERS[name] ?? "{}\n")) made.push(name);
    if (lexists(at) && !isLink(at)) out.push(at);
  }
  excludePlaceholders(workspace, home, made);
  return out;
}

/**
 * The sandbox's own cache dir: writable inside, where the toolchains'
 * caches are pointed ({@link toolchainCacheEnv}), since the home is
 * read-only. One per user, outside anything the user's own tools read
 * (`${XDG_CACHE_HOME:-~/.cache}/codeoid-sandbox`), shared by the sandboxed
 * sessions (what one downloads or builds another reuses). Null when it
 * can't be made.
 */
export function sandboxCacheDir(home: string, env: Record<string, string | undefined> = process.env): string | null {
  const xdg = env.XDG_CACHE_HOME && isAbsolute(env.XDG_CACHE_HOME) ? env.XDG_CACHE_HOME : join(home, ".cache");
  const dir = join(xdg, "codeoid-sandbox");
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const st = lstatSync(dir);
    if (!st.isDirectory() || (typeof process.getuid === "function" && st.uid !== process.getuid())) return null;
    return dir;
  } catch {
    return null;
  }
}

/**
 * The toolchains' cache variables, pointed into `cacheDir`: XDG's (pip, uv,
 * go's build cache and every tool that follows it), Go's build and module
 * caches (modules the user already downloaded are read from their own
 * module cache first, as a file proxy), bun's, npm's, uv's, pip's and
 * cargo's home (its registry cache).
 */
export function toolchainCacheEnv(cacheDir: string, home: string, env: Record<string, string | undefined> = process.env): Record<string, string> {
  const out: Record<string, string> = {
    XDG_CACHE_HOME: cacheDir,
    GOCACHE: join(cacheDir, "go-build"),
    GOMODCACHE: join(cacheDir, "go-mod"),
    BUN_INSTALL_CACHE_DIR: join(cacheDir, "bun"),
    npm_config_cache: join(cacheDir, "npm"),
    UV_CACHE_DIR: join(cacheDir, "uv"),
    PIP_CACHE_DIR: join(cacheDir, "pip"),
    CARGO_HOME: join(cacheDir, "cargo"),
  };
  // The user's own downloads (read-only inside, `~/go/pkg` is on the allowlist) before the network.
  const gopath = env.GOPATH?.split(":")[0] || join(home, "go");
  const downloaded = join(env.GOMODCACHE || join(gopath, "pkg", "mod"), "cache", "download");
  if (existsSync(downloaded)) out.GOPROXY = `file://${downloaded},${env.GOPROXY || "https://proxy.golang.org,direct"}`;
  return out;
}

/** The spec for one session. */
export function buildSandboxSpec(inputs: SpecInputs): SandboxSpec {
  const env = inputs.hidden?.env ?? process.env;
  const home = inputs.hidden?.home ?? env.HOME ?? homedir();
  const workspace = resolve(inputs.workspace);
  const git = inputs.git === false ? { writable: [], readOnly: [], gitDirs: [] } : gitWorkspacePaths(workspace, home);
  const projectConfig = inputs.projectConfig === false ? [] : projectConfigPaths(workspace, home);
  const cache = inputs.cache === false ? null : sandboxCacheDir(home, env);
  const own = [...(inputs.backendState ?? []).map((p) => resolve(p)), ...git.writable, ...(cache ? [cache] : [])];
  const ownReal = own.map(realOr);
  // Made now if it wasn't: what the daemon puts there later is hidden too.
  const root = sandboxRootOrNull();
  const tempDir = resolve(inputs.tempDir);
  // A workspace that is the home itself: the home is what the session works on (the hidden list still applies in it).
  const homeHidden = hiddenHome(home) === workspace ? null : hiddenHome(home);
  const userHidden = sandboxConfigOf(inputs.config).hiddenPaths.map((p) => resolve(expandHome(p, home))).filter(isAbsolute);
  const allowed = homeHidden ? homeReadablePaths(inputs.config, homeHidden).filter((r) => !userHidden.some((u) => within(r, u))) : [];
  // A link in the allowlist leads only where the allowlist (or what is outside the home) shows: what it
  // leads to elsewhere in the home stays hidden (a project of yours, with its `.env`), and the link dangles.
  const reexposed = [
    ...(inputs.backendReadable ?? []).map((p) => resolve(p)),
    // The allowlist, less what `sandbox.hiddenPaths` hides: an explicit hide wins.
    ...allowed,
  ];
  // What stays visible inside the hidden home: a hidden path there matters only inside one of these.
  const shown = [workspace, tempDir, ...own, ...ownReal, ...reexposed, ...reexposed.map(realOr)];
  const hidden = [
    ...(homeHidden ? [homeHidden] : []),
    ...hiddenPathsFor(inputs.config, inputs.hidden),
    ...homeCredentialFilesIn(reexposed),
    ...(root ? [root] : []),
  ].filter(
    (h, i, all) =>
      all.indexOf(h) === i &&
      // The backend's own state stays reachable by it; nothing it holds is taken out otherwise.
      ![...own, ...ownReal].some((o) => within(h, o)) &&
      // Inside the hidden home, only what is inside something shown needs hiding again.
      (!homeHidden || h === homeHidden || !within(h, homeHidden) || shown.some((x) => within(h, x))),
  );
  return {
    sessionId: inputs.sessionId,
    workspace,
    tempDir,
    writable: own,
    hidden,
    readOnly: [...git.readOnly, ...projectConfig],
    gitDirs: git.gitDirs,
    ...(cache ? { env: toolchainCacheEnv(cache, home, env) } : {}),
    pinned: protectedAncestors(hidden, [workspace, tempDir, ...own]),
    reexposed,
    containerSockets: containerSocketPaths(home, env),
    network: inputs.network,
    unsetEnv: SANDBOX_UNSET_ENV,
  };
}

function sandboxRootOrNull(): string | null {
  try {
    return sandboxRoot();
  } catch {
    return null;
  }
}

function realOr(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * The directories strictly between a writable root and a hidden path that
 * exists inside it: pinned (SandboxSpec.pinned), so none can be renamed to
 * carry the hidden path out from under its rule. Real paths.
 */
export function protectedAncestors(hidden: readonly string[], writableRoots: readonly string[], exists: (p: string) => boolean = existsSync): string[] {
  const roots = writableRoots.map(realOr);
  const hiddenReal = hidden.map(realOr);
  const out = new Set<string>();
  for (const at of hiddenReal) {
    if (!exists(at)) continue;
    for (const w of roots) {
      if (at === w || !within(at, w)) continue;
      for (let a = dirname(at); a !== w && within(a, w); a = dirname(a)) {
        // A dir that is hidden itself, or inside a hidden one, is never pinned: a pin binds
        // the real dir, which would show it again (the home in a workspace of /home). Hidden,
        // it is a mount point of its own (no rename) or not there at all.
        if (hiddenReal.some((h) => within(a, h))) continue;
        out.add(a);
      }
    }
  }
  return [...out];
}

/** The network policy a session asks for: its own, else the config's. */
export function networkPolicyOf(config: SandboxConfig, override?: { mode?: NetworkMode; allow?: readonly string[] }): NetworkPolicy {
  const mode = override?.mode ?? config.network;
  const allow = override?.allow ?? config.allowedHosts;
  return mode === "allowlist" ? { mode, allow: [...allow] } : { mode };
}


/**
 * Where a backend's program lives, by directory: shown read-only inside a
 * sandbox that would otherwise hide it (the home, the host's /tmp). For the
 * command (found on PATH when it is a bare name) and each absolute script
 * path before its own arguments: its directory and where it really is, the
 * package it belongs to (the nearest directory with a `package.json`: an
 * npm-installed CLI needs its `node_modules`), and the interpreter its
 * `#!` line names (`#!/usr/bin/env node`: node as PATH finds it, with the
 * install it belongs to).
 */
export function programLocations(
  command: string,
  argsPrefix: readonly string[] = [],
  path: string | undefined = process.env.PATH,
  home: string = process.env.HOME ?? homedir(),
): string[] {
  const out: string[] = [];
  const which = (name: string): string | null => Bun.which(name, path !== undefined ? { PATH: path } : {}) ?? null;
  const add = (p: string) => {
    out.push(dirname(p));
    const real = realOr(p);
    out.push(dirname(real));
    const pkg = packageRoot(real);
    if (pkg) out.push(pkg);
    return real;
  };
  for (const [i, p] of [command, ...argsPrefix].entries()) {
    const abs = isAbsolute(p) ? p : i === 0 && p && !p.includes("/") ? which(p) : null;
    if (!abs) continue;
    const real = add(abs);
    const interpreter = shebangProgram(real);
    const found = interpreter ? (isAbsolute(interpreter) ? interpreter : which(interpreter)) : null;
    if (found) {
      add(found);
      // An install's bin dir (`…/node/v22/bin/node`): the install with it (its lib).
      const dir = dirname(realOr(found));
      if (basename(dir) === "bin") out.push(dirname(dir));
    }
  }
  // Never the home itself or anything holding it (a stray `~/package.json`): that would show it all.
  const h = resolve(home);
  return [...new Set(out)].filter((d) => d !== "/" && !within(h, d));
}

/** The nearest directory at or above `file`'s holding a `package.json`, below `/`. */
function packageRoot(file: string): string | null {
  for (let dir = dirname(file); dir !== dirname(dir); dir = dirname(dir)) {
    try {
      if (lstatSync(join(dir, "package.json")).isFile()) return dir;
    } catch {
      /* not here */
    }
  }
  return null;
}

/** The program a script's `#!` line runs (`env`'s argument for `#!/usr/bin/env x`), or null. */
function shebangProgram(file: string): string | null {
  let head = "";
  try {
    const fd = openSync(file, "r");
    try {
      const buf = Buffer.alloc(256);
      head = buf.subarray(0, readSync(fd, buf, 0, 256, 0)).toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
  const m = /^#!\s*(\S+)(?:[ \t]+(?:-S[ \t]+)?(\S+))?/.exec(head);
  if (!m?.[1]) return null;
  return basename(m[1]) === "env" ? (m[2] ?? null) : m[1];
}
