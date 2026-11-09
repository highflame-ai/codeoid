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

import { accessSync, closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync, writeFileSync } from "node:fs";
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
import { controlDirProblem, nestedControl, type NestedControl, projectRootSecrets, stillRealDir } from "./project-roots.js";
import { isOwnWorktree, worktreeAdminsOf, worktreeFoldersOf } from "./worktrees.js";
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
  /**
   * More places a command may check a worktree of its repository out, on top
   * of `<repo>-worktrees/` and `<repo>/.worktrees/` (`~` expands; a relative
   * one is the repository's main checkout's): each repository gets
   * `<root>/<repo>/`, each session its own folder there (worktrees.ts).
   */
  worktreeRoots: string[];
  /**
   * Where a session's commands may read other repositories, read-only
   * (`~` expands; {@link PROJECT_ROOT_PARENT} is the parent of the session's
   * repository, the default): everything under one, but what the hidden list
   * hides (project-roots.ts `resolveProjectRoots`). Absent: the default.
   */
  projectRoots?: string[];
  docker: {
    /** Image a Docker sandbox runs; must carry what the backend runs (a shell, node for pi / the Gemini CLI). */
    image: string;
    /** `--runtime` (e.g. `runsc` for gVisor). */
    runtime?: string;
    /**
     * Let sandboxed commands reach the host's container runtime socket
     * (testcontainers, `docker run`): off by default. Root-equivalent: a
     * container can mount `/`. A session's own `dockerSocket` overrides it.
     */
    socket: boolean;
  };
}


export const DEFAULT_SANDBOX_CONFIG: SandboxConfig = {
  provider: "auto",
  network: "on",
  allowedHosts: [],
  hiddenPaths: [],
  homeReadable: [...DEFAULT_HOME_READABLE],
  worktreeRoots: [],
  projectRoots: ["@parent"],
  docker: { image: "node:22-bookworm-slim", socket: false },
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
 * Container and VM runtime sockets (and the dirs that hold them). Reaching
 * one is root on the machine (a privileged container, a VM with the host's
 * disk), so none is ever visible inside, whatever else is; Docker access
 * shows only the runtime's own ({@link dockerSocketPaths}).
 */
export function containerSocketPaths(home: string, env: Record<string, string | undefined> = process.env): string[] {
  const runtime = env.XDG_RUNTIME_DIR || (typeof process.getuid === "function" ? `/run/user/${process.getuid()}` : "");
  const out = [
    "/run/docker.sock",
    "/var/run/docker.sock",
    // dockerd's own dir: its plugins' and its containerd's sockets.
    "/run/docker",
    "/var/run/docker",
    "/run/cri-dockerd.sock",
    "/var/run/cri-dockerd.sock",
    "/run/containerd",
    "/var/run/containerd",
    "/run/podman",
    "/var/run/podman",
    "/run/crio",
    "/var/run/crio",
    "/run/buildkit",
    "/run/k3s",
    "/var/run/k3s",
    "/run/k0s",
    "/run/firecracker-containerd",
    "/var/snap/microk8s/common/run",
    "/var/run/balena-engine.sock",
    "/var/run/balena.sock",
    // libvirt (group libvirt: a VM with the host's disk), LXD and Incus (group lxd / incus-admin: a privileged container).
    "/run/libvirt",
    "/var/run/libvirt",
    "/var/snap/lxd/common/lxd",
    "/var/snap/lxd/common/lxd-user",
    "/var/lib/lxd",
    "/run/lxd",
    "/var/lib/incus",
    "/run/incus",
    join(home, ".docker/run"),
    join(home, ".colima"),
    join(home, ".lima"),
    join(home, ".rd"),
    join(home, ".orbstack"),
  ];
  if (runtime) out.push(join(runtime, "docker.sock"), join(runtime, "docker"), join(runtime, "podman"), join(runtime, "containerd"), join(runtime, "libvirt"));
  const dockerHost = env.DOCKER_HOST;
  if (dockerHost?.startsWith("unix://")) out.push(dockerHost.slice("unix://".length));
  return out;
}

/**
 * The host's other shared socket dirs a command must not reach: the system
 * D-Bus (polkit lets a desktop user mount drives, change the network, power
 * off) and screen's sessions. Hidden in every sandbox (the desktop session's
 * runtime dir, with its bus and agents, already is).
 */
export const HOST_SOCKET_DIRS: readonly string[] = ["/run/dbus", "/var/run/dbus", "/run/screen", "/var/run/screen"];

/**
 * Local services' socket dirs that let a connection in by who the user is,
 * no password asked (#448 round 11): Postgres's peer auth, MySQL and
 * MariaDB's `unix_socket`, a Redis or memcached socket with no auth. With the
 * network off (or an allowlist) a sandboxed command must not reach them: a
 * filesystem socket isn't the network, so unsharing it doesn't stop one.
 */
export const LOCAL_SERVICE_SOCKET_DIRS: readonly string[] = [
  "/run/postgresql",
  "/var/run/postgresql",
  "/run/mysqld",
  "/var/run/mysqld",
  "/run/mariadb",
  "/var/run/mariadb",
  "/var/lib/mysql/mysql.sock",
  "/run/redis",
  "/var/run/redis",
  "/run/redis-server",
  "/run/valkey",
  "/var/run/valkey",
  "/run/memcached",
  "/var/run/memcached",
  "/run/mongodb",
  "/var/run/mongodb",
  "/run/pgbouncer",
  "/var/run/pgbouncer",
];

/** Such sockets in the host's shared temp dirs (Homebrew's and source builds' defaults): Postgres, MySQL, MariaDB, Redis, MongoDB. */
const TEMP_SERVICE_SOCKET = /^(?:\.s\.PGSQL\.\d+(?:\.lock)?|mysqlx?\.sock(?:\.lock)?|mysqld?\.sock|redis(?:-server)?(?:-\d+)?\.sock|valkey(?:-\d+)?\.sock|mongodb-\d+\.sock|memcached\.sock)$/;

/**
 * The host's local service sockets a sandbox hides while its network is off
 * or an allowlist ({@link LOCAL_SERVICE_SOCKET_DIRS}, and those found now in
 * `/tmp`, `/private/tmp` and `/var/tmp`). `sandbox.hiddenPaths` hides more.
 */
export function localServiceSocketPaths(tempDirs: readonly string[] = ["/tmp", "/private/tmp", "/var/tmp"]): string[] {
  const out = [...LOCAL_SERVICE_SOCKET_DIRS];
  for (const t of tempDirs) {
    let names: string[] = [];
    try {
      names = readdirSync(t);
    } catch {
      continue;
    }
    for (const n of names) if (TEMP_SERVICE_SOCKET.test(n)) out.push(join(t, n));
  }
  return out;
}

/**
 * The host's container runtime sockets that exist now, for a sandbox whose
 * owner opted in (`sandbox.docker.socket`): `$DOCKER_HOST`'s when it is a
 * unix socket, then Docker's, rootless Docker's, Podman's (rootless, then
 * the system's); on macOS Docker Desktop's (`~/.docker/run/docker.sock`,
 * `/var/run/docker.sock`), Colima's, OrbStack's, Rancher Desktop's. First
 * the one a client should use (`DOCKER_HOST`). Each is root on the machine.
 */
export function dockerSocketPaths(
  home: string,
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
  isSocket: (p: string) => boolean = socketAt,
): string[] {
  const runtime = env.XDG_RUNTIME_DIR || (typeof process.getuid === "function" ? `/run/user/${process.getuid()}` : "");
  const host = env.DOCKER_HOST?.startsWith("unix://") ? env.DOCKER_HOST.slice("unix://".length) : null;
  const candidates =
    platform === "darwin"
      ? [join(home, ".docker/run/docker.sock"), "/var/run/docker.sock", join(home, ".colima/default/docker.sock"), join(home, ".orbstack/run/docker.sock"), join(home, ".rd/docker.sock")]
      : // The user's own (rootless) runtime first: when both exist, DOCKER_HOST names the one that isn't root on the host.
        [...(runtime ? [join(runtime, "docker.sock"), join(runtime, "podman/podman.sock")] : []), "/var/run/docker.sock", "/run/docker.sock", "/run/podman/podman.sock"];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const p of [...(host && isAbsolute(host) ? [host] : []), ...candidates]) {
    if (!isSocket(p)) continue;
    const real = realOr(p);
    if (seen.has(real)) continue;
    seen.add(real);
    out.push(p);
  }
  return out;
}

/** A socket the daemon's user can connect to (writable: `/var/run/docker.sock` of a user not in the docker group isn't). */
function socketAt(p: string): boolean {
  try {
    if (!statSync(p).isSocket()) return false;
    accessSync(p, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** The runtime sockets {@link dockerSocketPaths} looks for that exist but the daemon's user can't connect to (said, not shown). */
export function unconnectableDockerSockets(home: string, env: Record<string, string | undefined> = process.env, platform: NodeJS.Platform = process.platform): string[] {
  const exists = (p: string) => {
    try {
      return statSync(p).isSocket();
    } catch {
      return false;
    }
  };
  const connectable = new Set(dockerSocketPaths(home, env, platform));
  return dockerSocketPaths(home, env, platform, exists).filter((p) => !connectable.has(p));
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
  // The system bus and screen's sessions (#448 round 10).
  out.push(...HOST_SOCKET_DIRS);
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
  /**
   * The session's cwd, when it is below `workspace` (a monorepo's package,
   * sandboxWorkspaceOf): project settings are held read-only in every dir
   * from it up to the workspace (projectDirsOf).
   */
  workdir?: string;
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
  /**
   * The session's worktree folder name (worktrees.ts `sessionFolderName`):
   * its folder in each worktree location is writable (GitWorkspaceOptions).
   * Absent: none is (a check, the git shim).
   */
  worktreeFolder?: string;
  /**
   * The repository's worktree entries the session made itself (its record:
   * worktree-entries.ts `WorktreeEntryGuard.ownEntries`): left writable; every
   * other entry there is held. Absent: an entry checked out in the session's
   * folder is its own (worktrees.ts `isOwnWorktree`).
   */
  ownWorktreeEntries?: readonly string[];
  /**
   * Let commands reach the host's container runtime sockets
   * (`sandbox.docker.socket`, opt-in: root-equivalent; dockerSocketPaths).
   */
  dockerSocket?: boolean;
  /**
   * Hide the host's local service sockets (databases that let a connection in
   * by who the user is: {@link localServiceSocketPaths}). Default: when the
   * network isn't on. A session passes its own network's, not a handle's (a
   * process backend's handle has the network on to reach its model).
   */
  hideLocalServices?: boolean;
  /**
   * The session's project roots, resolved (project-roots.ts
   * `resolveProjectRoots`): readable whole, read-only, what the hidden list
   * hides in them hidden again, and the credential files anywhere in them
   * (`projectRootSecrets`); one too big to look through isn't shown.
   */
  projectRoots?: readonly string[];
  /**
   * Directories the session writes besides its workspace, validated
   * (project-roots.ts `addedDirProblem`), each kept by its real path: each
   * as a workspace is, its git structure and project settings held, and
   * every repository and settings dir inside it (`nestedControl`), its
   * repository's worktree folder writable; left out when it no longer is a
   * directory at that path, or is too big to look through.
   * `ownWorktreeEntries`: as {@link ownWorktreeEntries}, for its repository.
   */
  addedDirs?: readonly { dir: string; ownWorktreeEntries?: readonly string[] }[];
  /** How many directories a root's or an added dir's look goes through (project-roots.ts; default theirs): tests. */
  scanLimit?: number;
}

/** The home a spec hides: absolute, and not `/` (nothing is left to show then). */
function hiddenHome(home: string): string | null {
  const h = resolve(home);
  return isAbsolute(home) && h !== "/" ? h : null;
}

/** `sandbox.hiddenPaths`, absolute (`~` expanded). */
export function userHiddenPaths(config: Pick<CodeoidConfig, "sandbox"> | undefined, home: string = process.env.HOME ?? homedir()): string[] {
  return sandboxConfigOf(config).hiddenPaths.map((p) => resolve(expandHome(p, home))).filter(isAbsolute);
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
  /** The session's own folder in each worktree location (worktrees.ts): writable, where a command checks a new worktree out. */
  folders: string[];
  /** The locations those folders are in: shown read-only (worktrees.ts `WorktreeFolders.locations`). */
  locations: string[];
  /** Why a worktree location gives the session no folder (a root refused or missing). */
  problems: string[];
}

/** What {@link gitWorkspacePaths} is told of the session's own worktrees. */
export interface GitWorkspaceOptions {
  /** `sandbox.worktreeRoots`: more worktree locations (worktrees.ts `worktreeLocationDirs`). */
  worktreeRoots?: readonly string[];
  /**
   * The session's worktree folder name: its folder in each location is
   * writable, and a worktree checked out there is its own, left writable
   * whole (worktrees.ts `isOwnWorktree`). Absent: no folder, every existing
   * worktree held.
   */
  worktreeFolder?: string;
  /** The entries the session made itself (SpecInputs.ownWorktreeEntries): the others are held. */
  ownEntries?: readonly string[];
  /** codeoid's config dir: no worktree root is in it or holds it. */
  configDir?: string;
}

/**
 * In a git dir, what decides which config, hooks and git dirs git uses:
 * held read-only from inside. `commondir` (in any git dir) names the
 * repository git reads its config and hooks from; `config.worktree` is read
 * where the config turns it on; `info/` holds attributes and sparse rules,
 * `modules/` the submodules' git dirs (each with its own config and hooks),
 * `remotes/` and `branches/` remotes defined as files, `worktrees/` the
 * linked worktrees' git dirs (each naming its repository in `commondir`):
 * `worktrees/` itself is writable (a command may add a worktree), each
 * existing worktree's git dir in it held (gitWorkspacePaths).
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
 * The sandbox's workspace for a session working in `workdir` (#448 round
 * 9): the top of the git working tree the workdir is in, when that isn't the
 * workdir itself (a monorepo's package: its sibling packages, the root's
 * `package.json` and `tsconfig`, and git work as without a sandbox, git's
 * own discovery included, which a mount at the package would stop), else the
 * workdir. Only a repository {@link gitLayoutOf} finds and git's own records
 * vouch for (a plain `.git`, a linked worktree, a submodule): below the home,
 * never the home's own, `/`, a temp root or a dir holding the home. The
 * session's cwd stays the workdir.
 */
export function sandboxWorkspaceOf(workdir: string, home: string = process.env.HOME ?? homedir()): string {
  const ws = resolve(workdir);
  const layout = gitLayoutOf(ws, home);
  if (!layout || layout.kind === "unknown") return ws;
  const top = dirname(layout.dotgit);
  if (top === ws || !within(ws, top) || top === "/" || within(resolve(home), top)) return ws;
  if ([tmpdir(), "/tmp", "/var/tmp"].some((t) => resolve(t) === top || realOr(resolve(t)) === realOr(top))) return ws;
  return top;
}

/**
 * Every dir from `workdir` up to `workspace` (both included), where the
 * agent CLIs look for project settings: Claude's in its cwd, opencode's
 * `opencode.json` and `.opencode/` from its cwd up to the worktree's top,
 * Codex's, Gemini's and Qwen's alike. Just the workspace when the workdir
 * isn't inside it.
 */
export function projectDirsOf(workdir: string, workspace: string): string[] {
  const ws = resolve(workspace);
  const out: string[] = [];
  for (let dir = resolve(workdir); within(dir, ws); dir = dirname(dir)) {
    out.push(dir);
    if (dir === ws || dirname(dir) === dir) break;
  }
  return out.length > 0 && out[out.length - 1] === ws ? out : [ws];
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
 *     `commondir`, `hooks/`, `info/`, `modules/`, `remotes/` and
 *     `branches/` ({@link GIT_CONTROL});
 *   - `worktrees/` is writable, bound at its own path (a command adds a
 *     worktree there: worktrees.ts), but every worktree's admin dir in it
 *     that isn't the session's own is read-only whole, with its checkout's
 *     `.git` file, and its whole checkout when that is in a worktree
 *     location; the workspace's own: `commondir`, `gitdir`,
 *     `config.worktree`;
 *   - the workspace's `.git` file, and the `.git` file of every submodule
 *     checked out inside the workspace;
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
export function gitWorkspacePaths(workspace: string, home: string = process.env.HOME ?? homedir(), opts: GitWorkspaceOptions = {}): GitPaths {
  const out: GitPaths = { writable: [], readOnly: [], gitDirs: [], folders: [], locations: [], problems: [] };
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
  const all = worktreeAdminsOf(common);
  for (const a of all) makeIfMissing(join(a.dir, "config.worktree"), "");
  if (own) makeIfMissing(join(own, "config.worktree"), "");
  const admins = all.filter((a) => !own || resolve(a.dir) !== resolve(own));
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
  // `worktrees/` writable, so a command can add a worktree (git makes its admin dir there), and bound at its own
  // path so it can't be renamed away and rebuilt with an admin dir a checkout of the user's would follow.
  out.writable.push(worktrees);
  // This worktree's own git dir, bound at its own path, its control read-only again.
  if (own) out.writable.push(own);
  out.readOnly.push(...control.filter((p) => p !== worktrees));
  if (dotgitFile) out.readOnly.push(dotgit);
  // Where a command checks a new worktree out: the session's own folder in each location (worktrees.ts). The rest
  // of a location isn't writable at all, but for one inside the workspace, which is held read-only whole.
  if (opts.worktreeFolder) {
    const f = worktreeFoldersOf(layout, opts.worktreeFolder, { home, workspace: ws, ...(opts.worktreeRoots ? { roots: opts.worktreeRoots } : {}), ...(opts.configDir ? { configDir: opts.configDir } : {}) });
    out.folders.push(...f.folders);
    out.locations.push(...f.locations);
    out.readOnly.push(...f.held);
    out.problems.push(...f.problems);
  }
  // Every other worktree there now, unless the session made it: its admin dir read-only whole (not rewritten,
  // renamed, removed or pruned), and its `.git` file when that is in the workspace. One made later is in the
  // writable `worktrees/` until the spec is next built: its integrity is checked instead (worktree-entries.ts).
  const ownEntries = opts.ownEntries ? new Set(opts.ownEntries.map((e) => resolve(e))) : null;
  for (const a of admins) {
    if (ownEntries ? ownEntries.has(resolve(a.dir)) : isOwnWorktree(a, out.folders)) continue;
    if (!isLink(a.dir)) out.readOnly.push(a.dir);
    if (a.dotgit && a.dotgit !== dotgit && within(realOr(a.dotgit), realOr(ws)) && lexists(a.dotgit) && !isLink(a.dotgit)) out.readOnly.push(a.dotgit);
  }
  // Submodules checked out inside the workspace: their `.git` files too.
  for (const f of submoduleCheckouts(join(common, "modules"))) {
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
export function protectedWriteTargets(workdir: string, home: string = process.env.HOME ?? homedir(), addedDirs: readonly string[] = []): HeldPath[] {
  const ws = sandboxWorkspaceOf(workdir, home);
  const out: HeldPath[] = [];
  // The workspace, and each dir the session was given to write (SpecInputs.addedDirs), as the spec holds them:
  // with every repository in it, and its settings dirs and bare repositories wherever they are.
  const nested = addedDirs.map((d) => ({ dir: resolve(d), control: nestedControlCached(resolve(d)) }));
  for (const n of nested) {
    for (const at of n.control.settings) out.push({ at, whole: true, what: "settings" });
    for (const at of n.control.gitDirs) out.push({ at, whole: true, what: "git" });
  }
  const tops = [[ws, projectDirsOf(workdir, ws)] as const, ...nested.flatMap((n) => [n.dir, ...nestedRepos(n.dir, n.control)].map((d) => [d, [d]] as const))];
  for (const [top, dirs] of tops) {
    const layout = gitLayoutOf(top, home);
    if (layout) {
      for (const p of [layout.dotgit, layout.common, layout.own, layout.named]) if (p) out.push({ at: p, whole: true, what: "git" });
      if (layout.common) {
        const others = listDirs(join(layout.common, "worktrees")).map((n) => gitdirTarget(join(layout.common as string, "worktrees", n)));
        for (const f of [...others, ...submoduleCheckouts(join(layout.common, "modules"))]) if (f && within(f, top)) out.push({ at: f, whole: true, what: "git" });
      }
    }
    // Each dir from the workdir up to the workspace's top: where the CLIs look for project settings.
    for (const dir of dirs) {
      for (const d of PROJECT_CONFIG_DIRS) out.push({ at: join(dir, d), whole: true, what: "settings" });
      for (const f of PROJECT_CONFIG_FILES) out.push({ at: join(dir, f), whole: false, what: "settings" });
    }
  }
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
export function gitDirShape(dir: string): boolean {
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
  const sandboxCfg = sandboxConfigOf(inputs.config);
  const configDir = inputs.hidden?.configDir ?? getConfigDir();
  // Each added dir as a workspace of its own (never one inside the workspace: it is writable already), and only
  // while it still is what was granted: a directory at its real path, no git or settings dir, every repository and
  // settings dir in it found (project-roots.ts; Session says when one is dropped).
  const added = (inputs.addedDirs ?? [])
    .map((a) => ({ ...a, dir: resolve(a.dir) }))
    .filter((a, i, all) => !within(a.dir, workspace) && all.findIndex((b) => b.dir === a.dir) === i)
    .filter((a) => stillRealDir(a.dir) && controlDirProblem(a.dir, home) === null)
    .map((a) => ({ ...a, nested: nestedControl(a.dir, inputs.scanLimit) }))
    .filter((a) => a.nested.complete);
  const gitOf = (dir: string, ownEntries: readonly string[] | undefined): GitPaths =>
    gitWorkspacePaths(dir, home, {
      worktreeRoots: sandboxCfg.worktreeRoots,
      configDir,
      ...(inputs.worktreeFolder ? { worktreeFolder: inputs.worktreeFolder } : {}),
      ...(ownEntries ? { ownEntries } : {}),
    });
  const git: GitPaths = inputs.git === false ? { writable: [], readOnly: [], gitDirs: [], folders: [], locations: [], problems: [] } : gitOf(workspace, inputs.ownWorktreeEntries);
  if (inputs.git !== false) {
    // An added dir's own worktree git dir stays its own, even where the workspace's look holds it (another worktree of the same repository).
    const addedOwn = new Set<string>();
    for (const a of added) {
      const g = gitOf(a.dir, a.ownWorktreeEntries);
      const own = gitLayoutOf(a.dir, home)?.own;
      if (own) addedOwn.add(resolve(own));
      for (const k of ["writable", "readOnly", "gitDirs", "folders", "locations", "problems"] as const) for (const p of g[k]) if (!git[k].includes(p)) git[k].push(p);
    }
    // The repositories inside an added dir (a folder of them): their git structure read-only, as the workspace's.
    for (const top of added.flatMap((a) => nestedRepos(a.dir, a.nested))) {
      const g = gitWorkspacePaths(top, home, { worktreeRoots: sandboxCfg.worktreeRoots, configDir });
      for (const p of g.readOnly) if (!git.readOnly.includes(p)) git.readOnly.push(p);
      for (const p of g.problems) if (!git.problems.includes(p)) git.problems.push(p);
    }
    // Never the workspace's own worktree git dir, wherever a look holds the rest of `worktrees/`.
    const wsOwn = gitLayoutOf(workspace, home)?.own;
    if (wsOwn && added.length > 0) addedOwn.add(resolve(wsOwn));
    if (addedOwn.size > 0) git.readOnly = git.readOnly.filter((p) => !addedOwn.has(resolve(p)));
  }
  const projectConfig =
    inputs.projectConfig === false
      ? []
      : [
          ...[...projectDirsOf(inputs.workdir ?? workspace, workspace), ...added.map((a) => a.dir), ...added.flatMap((a) => nestedRepos(a.dir, a.nested))].flatMap((dir) => projectConfigPaths(dir, home)),
          // Settings dirs and files anywhere else in an added dir, and bare repositories there: held as they are.
          ...added.flatMap((a) => [...a.nested.settings, ...a.nested.gitDirs]).filter((p) => lexists(p) && !isLink(p)),
        ].filter((p, i, all) => all.indexOf(p) === i);
  const cache = inputs.cache === false ? null : sandboxCacheDir(home, env);
  const own = [...(inputs.backendState ?? []).map((p) => resolve(p)), ...git.writable, ...(cache ? [cache] : [])];
  const ownReal = own.map(realOr);
  // Made now if it wasn't: what the daemon puts there later is hidden too.
  const root = sandboxRootOrNull();
  const tempDir = resolve(inputs.tempDir);
  // A workspace that is the home itself: the home is what the session works on (the hidden list still applies in it).
  const homeHidden = hiddenHome(home) === workspace ? null : hiddenHome(home);
  const userHidden = userHiddenPaths(inputs.config, home);
  const allowed = homeHidden ? homeReadablePaths(inputs.config, homeHidden).filter((r) => !userHidden.some((u) => within(r, u))) : [];
  const baseHidden = hiddenPathsFor(inputs.config, inputs.hidden);
  // What the hidden list hides, the home aside: no root or added dir is inside it (validated; again here).
  const inHidden = (p: string) => [...baseHidden, ...(root ? [root] : [])].some((h) => within(p, h) || within(realOr(p), realOr(h)));
  const addedDirs = added.map((a) => a.dir).filter((d) => !inHidden(d) && !userHidden.some((u) => within(d, u)));
  const writableDirs = [workspace, ...addedDirs];
  // The credential files anywhere in a root (not the session's own: its workspace, its added dirs); a root too big
  // to look through whole isn't shown at all (fail closed: resolveSandbox says so).
  const rootCandidates = (inputs.projectRoots ?? []).map((r) => resolve(r)).filter((r, i, all) => all.indexOf(r) === i && !userHidden.some((u) => within(r, u)) && !inHidden(r));
  const rootSecrets = projectRootSecrets(rootCandidates, writableDirs, inputs.scanLimit);
  const roots = rootCandidates.filter((r) => !rootSecrets.over.includes(r));
  // The worktree locations shown (other sessions' checkouts of this repository, their copied `.env`s): the same.
  const locationSecrets = projectRootSecrets(git.locations, [...writableDirs, ...git.folders]);
  // A link in the allowlist leads only where the allowlist (or what is outside the home) shows: what it
  // leads to elsewhere in the home stays hidden (a project of yours, with its `.env`), and the link dangles.
  const reexposed = [
    ...(inputs.backendReadable ?? []).map((p) => resolve(p)),
    // The allowlist, less what `sandbox.hiddenPaths` hides: an explicit hide wins.
    ...allowed,
    // The worktree locations holding the session's folders, read-only: a worktree added elsewhere in one fails
    // (it isn't hidden away into a scratch dir), and the repository's other worktrees there are readable.
    ...git.locations.filter((l) => !userHidden.some((u) => within(l, u)) && !locationSecrets.over.includes(l)),
    // The project roots: other repositories, read-only.
    ...roots,
  ];
  const hiddenAll = [
    ...(homeHidden ? [homeHidden] : []),
    ...baseHidden,
    ...homeCredentialFilesIn(reexposed),
    // The credential files under a root and in the worktree locations shown.
    ...rootSecrets.hidden,
    ...locationSecrets.hidden,
    ...(root ? [root] : []),
  ];
  // The session's worktree folders: writable, but never inside something hidden (a root configured in a hidden
  // path), and, unlike the backend's own state, never taking a hidden path inside them out of the hidden list.
  const locations = git.folders.filter((l) => !hiddenAll.some((h) => h !== homeHidden && (within(l, h) || within(l, realOr(h)))));
  // What stays visible inside the hidden home: a hidden path there matters only inside one of these.
  const shown = [workspace, tempDir, ...own, ...ownReal, ...locations, ...addedDirs, ...addedDirs.map(realOr), ...reexposed, ...reexposed.map(realOr)];
  const hidden = hiddenAll.filter(
    (h, i, all) =>
      all.indexOf(h) === i &&
      // The backend's own state stays reachable by it; nothing it holds is taken out otherwise.
      ![...own, ...ownReal].some((o) => within(h, o)) &&
      // Inside the hidden home, only what is inside something shown needs hiding again.
      (!homeHidden || h === homeHidden || !within(h, homeHidden) || shown.some((x) => within(h, x))),
  );
  // The container runtime's sockets, when the owner opted in: reachable at their own paths, `DOCKER_HOST` the first.
  const sockets = inputs.dockerSocket ? dockerSocketPaths(home, env) : [];
  const exposed = new Set(sockets.flatMap((s) => [s, realOr(s)]));
  const spec: SandboxSpec = {
    sessionId: inputs.sessionId,
    workspace,
    tempDir,
    writable: [...own, ...addedDirs, ...locations],
    hidden,
    readOnly: [...git.readOnly, ...projectConfig],
    gitDirs: git.gitDirs,
    ...(locations.length > 0 ? { worktreeFolders: locations } : {}),
    ...(roots.length > 0 ? { projectRoots: roots } : {}),
    ...(addedDirs.length > 0 ? { addedDirs } : {}),
    ...(cache || sockets.length > 0 ? { env: { ...(cache ? toolchainCacheEnv(cache, home, env) : {}), ...(sockets[0] ? { DOCKER_HOST: `unix://${sockets[0]}` } : {}) } } : {}),
    pinned: protectedAncestors(hidden, [workspace, tempDir, ...own, ...addedDirs, ...locations]),
    reexposed,
    containerSockets: containerSocketPaths(home, env).filter((p) => !exposed.has(p) && !exposed.has(realOr(p))),
    ...((inputs.hideLocalServices ?? inputs.network.mode !== "on") ? { serviceSockets: localServiceSocketPaths() } : {}),
    ...(sockets.length > 0 ? { dockerSockets: sockets } : {}),
    network: inputs.network,
    unsetEnv: sockets.length > 0 ? SANDBOX_UNSET_ENV.filter((n) => n !== "DOCKER_HOST") : SANDBOX_UNSET_ENV,
  };
  return spec;
}

/** nestedControl, looked again at most every few seconds: the gate asks it of every file tool call. */
const nestedCache = new Map<string, { at: number; control: NestedControl }>();
function nestedControlCached(dir: string): NestedControl {
  const hit = nestedCache.get(dir);
  if (hit && Date.now() - hit.at < 5_000) return hit.control;
  const control = nestedControl(dir);
  if (nestedCache.size > 64) nestedCache.clear();
  nestedCache.set(dir, { at: Date.now(), control });
  return control;
}

/** The repositories inside an added dir `dir` (nestedControl), but its own: each held as a workspace's is. */
function nestedRepos(dir: string, nested: NestedControl): string[] {
  return nested.repos.filter((r) => resolve(r) !== resolve(dir));
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
