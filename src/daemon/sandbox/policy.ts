/**
 * What a session's sandbox hides, makes writable and lets through (#448):
 * the workspace-write policy, as a {@link SandboxSpec}.
 *
 *   - writable: the workspace, a private temp dir, and (only when a backend's
 *     whole process is inside) that backend's own state dir;
 *   - hidden: codeoid's config dir and every data dir it owns (database,
 *     transcripts, opencode's, memory's, the lock files), the agent CLIs'
 *     logins and what backends registered as credentials (secret-paths.ts),
 *     the usual credential stores (SSH, cloud CLIs, kube, docker, gnupg, gh,
 *     netrc, git credentials, keyrings), the daemon's own temp dir, the
 *     desktop session's runtime dir, plus `sandbox.hiddenPaths`;
 *   - container runtime sockets: never reachable;
 *   - network per policy.
 */

import { existsSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { CodeoidConfig } from "../../config.js";
import { getConfigDir } from "../../config.js";
import { daemonOwnedDirs } from "../data-lock.js";
import { cliCredentialFiles, registeredSecretLocations } from "../secret-paths.js";
import type { NetworkMode, NetworkPolicy, SandboxSpec } from "./types.js";

/** `sandbox.*` in the config (config.ts `SandboxSchema`). */
export interface SandboxConfig {
  /** `auto` (bwrap on Linux, Seatbelt on macOS), `off`, or a provider id. */
  provider: string;
  network: NetworkMode;
  /** Hosts a command may reach with `network: allowlist`. */
  allowedHosts: string[];
  /** More paths to hide, on top of the built-in list (`~` expands). */
  hiddenPaths: string[];
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
   * (its home: login, settings, sessions). Taken out of the hidden list and
   * made writable. Empty when only commands run inside.
   */
  backendState?: readonly string[];
  /** Read-only locations the backend's process needs inside a hidden one. */
  backendReadable?: readonly string[];
  hidden?: HiddenPathInputs;
}

/** The spec for one session. */
export function buildSandboxSpec(inputs: SpecInputs): SandboxSpec {
  const env = inputs.hidden?.env ?? process.env;
  const home = inputs.hidden?.home ?? env.HOME ?? homedir();
  const own = (inputs.backendState ?? []).map((p) => resolve(p));
  const ownReal = own.map((p) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  });
  const workspace = resolve(inputs.workspace);
  const hidden = hiddenPathsFor(inputs.config, inputs.hidden).filter(
    // The backend's own state stays reachable by it; nothing it holds is taken out otherwise.
    (h) => ![...own, ...ownReal].some((o) => within(h, o)),
  );
  return {
    sessionId: inputs.sessionId,
    workspace,
    tempDir: resolve(inputs.tempDir),
    writable: own,
    hidden,
    reexposed: (inputs.backendReadable ?? []).map((p) => resolve(p)),
    containerSockets: containerSocketPaths(home, env),
    network: inputs.network,
    unsetEnv: SANDBOX_UNSET_ENV,
  };
}

/** The network policy a session asks for: its own, else the config's. */
export function networkPolicyOf(config: SandboxConfig, override?: { mode?: NetworkMode; allow?: readonly string[] }): NetworkPolicy {
  const mode = override?.mode ?? config.network;
  const allow = override?.allow ?? config.allowedHosts;
  return mode === "allowlist" ? { mode, allow: [...allow] } : { mode };
}

/** A host an allowlist may name: a domain, a `*.` wildcard of one, or `localhost`. */
export function validAllowedHost(h: string): boolean {
  return /^(\*\.)?[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?)*$/.test(h) && h.length <= 253;
}
