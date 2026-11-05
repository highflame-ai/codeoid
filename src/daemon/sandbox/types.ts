/**
 * OS sandboxing for what agents run (#448): the provider contract.
 *
 * #431's risk levels read shell text, which can't
 * be made complete. The boundary is the operating system: a command run inside
 * a sandbox can't read what it can't see, or write what is read-only, however
 * it is spelled.
 *
 * A {@link SandboxProvider} is one way of building that boundary (bubblewrap,
 * Seatbelt, a Docker container; later a remote VM). It declares what it can
 * do ({@link SandboxCapabilities}) and, per session, opens a
 * {@link SandboxHandle} from a {@link SandboxSpec}: the workspace and a private
 * temp dir writable, credential locations hidden, the network per policy.
 *
 * How a backend is put inside a handle is the backend's business
 * (confinement.ts): Claude and Codex use their own sandboxes with codeoid's
 * policy, pi / the Gemini CLI / Qwen have their whole process launched inside,
 * opencode's shared server runs each shell line inside the session's.
 */

import type { ChildProcessWithoutNullStreams } from "node:child_process";

/** How strong the boundary is: OS namespaces/profiles, a separate kernel (gVisor), a VM. */
export type IsolationTier = "os" | "kernel" | "hardware";
/** Where the sandbox runs: this machine, or another one (Forge). */
export type SandboxPlacement = "local" | "remote";
/** How the workspace gets in: mounted in place, or copied in and the changes copied back. */
export type WorkspaceMode = "mount" | "sync";
/** What a sandboxed command may reach on the network. */
export type NetworkMode = "on" | "off" | "allowlist";

export const NETWORK_MODES: readonly NetworkMode[] = ["on", "off", "allowlist"];

export interface NetworkPolicy {
  mode: NetworkMode;
  /** Hosts allowed with `allowlist` (`example.com`, `*.example.com`). */
  allow?: readonly string[];
}

/** What a provider can do, declared up front so the registry can refuse what it can't. */
export interface SandboxCapabilities {
  isolation: IsolationTier;
  placement: SandboxPlacement;
  workspace: WorkspaceMode;
  /** Can run a long-lived process with piped stdin/stdout (a whole backend CLI). */
  stdioProcess: boolean;
  /** Can run one command and return its output. */
  commands: boolean;
  /**
   * Can hand back an argv that runs a program inside when spawned on this
   * machine ({@link SandboxHandle.wrap}): what a backend that spawns its own
   * processes (a CLI's shell, an SDK's child) is given. Local providers only.
   */
  wrapsArgv: boolean;
  /** Network modes it enforces. Anything else asked of it is reported as not enforced, never widened silently. */
  network: readonly NetworkMode[];
  /** Platforms it runs on. */
  platforms: readonly NodeJS.Platform[];
}

/** Whether a provider can run on this machine now, and why not. */
export type SandboxProbe = { available: true; detail?: string } | { available: false; reason: string };

/**
 * What one session's sandbox must be. Paths are absolute. Built by
 * policy.ts from the config, the session and its backend.
 */
export interface SandboxSpec {
  sessionId: string;
  /** The session's working directory: writable. */
  workspace: string;
  /** A private temp dir for this session: writable, and the sandbox's `/tmp` where the provider can place it there. */
  tempDir: string;
  /**
   * Each program started gets a fresh, empty temp dir of its own, gone when
   * it exits, never {@link tempDir} itself: nothing written there outlives
   * it (a tmpfs `/tmp` under bubblewrap and Docker; under Seatbelt, a dir
   * made in {@link tempDir} by the wrapper, the only part of it writable, and
   * removed when the program exits). The git shim's (git-shim.ts).
   */
  privateTemp?: boolean;
  /** Other writable locations (a backend's own state dir when its whole process is inside). */
  writable: readonly string[];
  /** Locations that must not be readable at all (directories and files). */
  hidden: readonly string[];
  /**
   * Locations inside a hidden one that stay readable: the home allowlist
   * (`sandbox.homeReadable`), the backend's own program and login when its
   * whole process is inside, a git worktree's common dir.
   */
  reexposed: readonly string[];
  /**
   * Locations inside a writable one that stay read-only, with everything in
   * them: what of a repository decides which config, hooks and git dir git
   * uses (a hook planted there would run outside the sandbox at the user's
   * next commit), and the project settings agent CLIs run code from
   * (`.claude/`, `.mcp.json`, …). Each exists (made first where missing).
   */
  readOnly?: readonly string[];
  /**
   * The git dirs a commit in the workspace writes (writable, in
   * {@link writable}, their structure in {@link readOnly}): what a backend's
   * own sandbox must let it write too (Codex's writable roots).
   */
  gitDirs?: readonly string[];
  /**
   * Variables set for what runs inside: toolchain caches pointed at the
   * sandbox's writable cache dir (the home is read-only).
   */
  env?: Readonly<Record<string, string>>;
  /**
   * Directories inside a writable location that must not be renamed or
   * removed, while what is in them stays writable: each one between a
   * writable root and a hidden path inside it. A mount point (or a denied
   * path) can't be renamed, so `mv ~/.config ~/c` can't move a hidden
   * `~/.config/gh` out from under the rule that hides it.
   */
  pinned?: readonly string[];
  /** Container runtime sockets (and their dirs): never reachable, they are root-equivalent. */
  containerSockets: readonly string[];
  network: NetworkPolicy;
  /** Environment variables removed from what runs inside (an agent socket, a desktop bus). */
  unsetEnv: readonly string[];
}

export interface SandboxSpawnOptions {
  cwd: string;
  env: Record<string, string>;
}

export interface SandboxExecOptions extends SandboxSpawnOptions {
  /** Written to the command's stdin, then closed. */
  stdin?: string;
  /** Killed after this long (ms). */
  timeoutMs?: number;
}

export interface SandboxExecResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
}

/** One session's open sandbox. */
export interface SandboxHandle {
  readonly providerId: string;
  readonly spec: SandboxSpec;
  /**
   * A program started inside with piped stdio (a backend CLI, a per-command
   * shell). Throws when the provider has no such process ({@link SandboxCapabilities.stdioProcess}).
   */
  spawn(command: string, args: readonly string[], opts: SandboxSpawnOptions): ChildProcessWithoutNullStreams;
  /** Run one command inside and collect its output. */
  exec(argv: readonly string[], opts: SandboxExecOptions): Promise<SandboxExecResult>;
  /**
   * The argv (and env) that runs `argv` inside when spawned on this machine.
   * Present only when the provider {@link SandboxCapabilities.wrapsArgv}.
   */
  wrap?(argv: readonly string[], opts: SandboxSpawnOptions): { argv: string[]; env: Record<string, string> };
  /** Release what was opened for the session (idempotent). Processes still running inside are ended. */
  close(): Promise<void>;
}

export interface SandboxProvider {
  /** Stable id: `bwrap`, `seatbelt`, `docker`, later `forge`, `firecracker`. */
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: SandboxCapabilities;
  /** Whether it can run here now (binary present, kernel allows it, daemon reachable). */
  probe(): Promise<SandboxProbe>;
  open(spec: SandboxSpec): Promise<SandboxHandle>;
  /** {@link open} for a caller that can't wait (a spawn callback). Local providers whose open does no I/O. */
  openSync?(spec: SandboxSpec): SandboxHandle;
}

/** A sandbox setting's value: a provider id, `auto` (the platform's own), or `off`. */
export type SandboxChoice = string;
export const SANDBOX_AUTO = "auto";
export const SANDBOX_OFF = "off";
