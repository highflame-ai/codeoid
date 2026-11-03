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
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { CodeoidConfig } from "../../config.js";
import { getConfigDir } from "../../config.js";
import { daemonOwnedDirs } from "../data-lock.js";
import { cliCredentialFiles, registeredSecretLocations } from "../secret-paths.js";
import { DEFAULT_HOME_READABLE } from "./home-readable.js";
import { validAllowedHost } from "./hosts.js";
import { sandboxRootIfMade } from "./root.js";
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
  /** Writable: the repository's git dir (a linked worktree's common dir), when outside the workspace. */
  writable: string[];
  /** Read-only even where the rest is writable: the repository's hooks, config and submodules' git dirs. */
  readOnly: string[];
}

function readGitFile(dotgit: string): string | null {
  try {
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotgit, "utf8"));
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * The workspace's git repository, found as git finds it (the nearest `.git`
 * at or above the workspace, below the home): a linked worktree (`.git` a
 * file naming its git dir) or a plain repository. Committing writes the
 * worktree's git dir and the repository's objects, refs, logs and
 * `packed-refs.lock` (git takes it beside `packed-refs` on a ref update),
 * so the repository's git dir is writable wherever it is. What git runs
 * from it stays read-only: `hooks/`, `config` (`core.hooksPath`,
 * `core.fsmonitor`, a filter), `config.worktree`, and `modules/` (a
 * submodule's git dir, with hooks and config of its own), since anything
 * planted there would run outside the sandbox at the user's next git
 * command. Those are made when missing (an empty dir, an empty
 * `config.worktree` where the config turns them on), so there is something
 * to hold read-only.
 *
 * A worktree's `.git` file is the agent's to write, so what it names is
 * believed only in git's own layout: `<common>/worktrees/<name>`, whose
 * `gitdir` file (outside the workspace) names this `.git` back, in a
 * repository with `objects/` and `HEAD`. Anything else gets nothing.
 */
export function gitWorkspacePaths(workspace: string, home: string = process.env.HOME ?? homedir()): GitPaths {
  const out: GitPaths = { writable: [], readOnly: [] };
  const ws = resolve(workspace);
  const stop = resolve(home);
  let dotgit: string | null = null;
  for (let dir = ws; ; dir = dirname(dir)) {
    // Never the home's own (a dotfiles repository) or the root's: no workspace commits there.
    if (dir === stop || dir === "/") break;
    try {
      lstatSync(join(dir, ".git"));
      dotgit = join(dir, ".git");
      break;
    } catch {
      /* not here */
    }
    if (dirname(dir) === dir) break;
  }
  if (!dotgit) return out;
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(dotgit);
  } catch {
    return out;
  }
  let common: string;
  if (st.isDirectory()) {
    common = dotgit;
  } else if (st.isFile()) {
    const named = readGitFile(dotgit);
    if (!named) return out;
    const gitDir = resolve(dirname(dotgit), named);
    common = dirname(dirname(gitDir));
    if (basename(dirname(gitDir)) !== "worktrees" || !validWorktree(gitDir, common, dotgit)) return out;
    out.readOnly.push(join(gitDir, "config.worktree"));
  } else {
    return out;
  }
  // Writable already when inside the workspace.
  if (!within(common, ws)) out.writable.push(common);
  for (const dir of ["hooks", "modules"]) {
    try {
      mkdirSync(join(common, dir), { mode: 0o755 });
    } catch {
      /* there already, or a repository codeoid can't write either */
    }
  }
  try {
    // Read where the config turns it on: there must be one to hold read-only.
    if (/worktreeconfig\s*=\s*true/i.test(readFileSync(join(common, "config"), "utf8"))) writeFileSync(join(common, "config.worktree"), "", { flag: "a" });
  } catch {
    /* no config to read, or none codeoid can write */
  }
  out.readOnly.push(join(common, "hooks"), join(common, "config"), join(common, "config.worktree"), join(common, "modules"));
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

/** The spec for one session. */
export function buildSandboxSpec(inputs: SpecInputs): SandboxSpec {
  const env = inputs.hidden?.env ?? process.env;
  const home = inputs.hidden?.home ?? env.HOME ?? homedir();
  const workspace = resolve(inputs.workspace);
  const git = inputs.git === false ? { writable: [], readOnly: [] } : gitWorkspacePaths(workspace, home);
  const own = [...(inputs.backendState ?? []).map((p) => resolve(p)), ...git.writable];
  const ownReal = own.map(realOr);
  const root = sandboxRootIfMade();
  const tempDir = resolve(inputs.tempDir);
  // A workspace that is the home itself: the home is what the session works on (the hidden list still applies in it).
  const homeHidden = hiddenHome(home) === workspace ? null : hiddenHome(home);
  const userHidden = sandboxConfigOf(inputs.config).hiddenPaths.map((p) => resolve(expandHome(p, home))).filter(isAbsolute);
  const reexposed = [
    ...(inputs.backendReadable ?? []).map((p) => resolve(p)),
    // The allowlist, less what `sandbox.hiddenPaths` hides: an explicit hide wins.
    ...(homeHidden ? homeReadablePaths(inputs.config, homeHidden).filter((r) => !userHidden.some((u) => within(r, u))) : []),
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
    readOnly: git.readOnly,
    pinned: protectedAncestors(hidden, [workspace, tempDir, ...own]),
    reexposed,
    containerSockets: containerSocketPaths(home, env),
    network: inputs.network,
    unsetEnv: SANDBOX_UNSET_ENV,
  };
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
  const out = new Set<string>();
  for (const h of hidden) {
    const at = realOr(h);
    if (!exists(at)) continue;
    for (const w of roots) {
      if (at === w || !within(at, w)) continue;
      for (let a = dirname(at); a !== w && within(a, w); a = dirname(a)) out.add(a);
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
