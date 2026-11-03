/**
 * Claude Code's own sandbox, given codeoid's policy (#448). On Linux it is
 * bubblewrap, on macOS Seatbelt, with a proxy for the network, so a host
 * allowlist can be enforced here (no other local provider can).
 *
 *   - `failIfUnavailable`: a CLI that can't build its sandbox fails the
 *     query rather than run commands unsandboxed;
 *   - `autoAllowBashIfSandboxed: false`: a sandboxed command is still asked
 *     about by codeoid's gate, as every command is;
 *   - `allowUnsandboxedCommands: true` with codeoid deciding: a command the
 *     model asks to run outside (`dangerouslyDisableSandbox`) is routed to
 *     the gate by the PreToolUse hook past any allow rule, and asked about
 *     in every mode (Session#unsandboxedRequest);
 *   - filesystem: the home denied whole and its allowlist allowed back
 *     (`denyRead` / `allowRead`, which the CLI enforces as a tmpfs home with
 *     binds: a credential made or replaced later isn't there), the workspace
 *     and the session's command temp dir writable, every hidden path and
 *     container socket unreadable, a repository's hooks and config and every
 *     pinned dir not writable (the CLI's `denyWrite` takes a dir's subtree
 *     with it: what is in a pinned dir is read-only too);
 *   - temp: the CLI's `TMPDIR` is a dir of the session's whose
 *     `claude-<uid>` (where the CLI points its commands' `TMPDIR`) is the
 *     only part writable, and `CLAUDE_CODE_TMPDIR` another, so the CLI's own
 *     transient files (its settings, sockets) are out of the commands'
 *     reach and no session shares a temp dir with another ({@link claudeTempEnv});
 *   - network: `on` leaves hosts to the CLI's ask, which codeoid's gate
 *     allows; `off` denies every host; `allowlist` allows only those hosts,
 *     without asking;
 *   - credentials: the credential variables the CLI runs with are denied to
 *     its commands.
 */

import { realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { SandboxSettings } from "@anthropic-ai/claude-agent-sdk";
import type { SandboxRuntime } from "./session-sandbox.js";
import type { SandboxSpec } from "./types.js";

/** A variable whose value is a credential (by name). */
const CREDENTIAL_NAME = /(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|COOKIE|AUTH)(?:_|$)/i;

/** The variables of the CLI's environment its commands must not see. */
export function credentialEnvNames(env: Record<string, string | undefined>, unset: readonly string[] = []): string[] {
  const names = Object.keys(env).filter((k) => CREDENTIAL_NAME.test(k) || unset.includes(k));
  return [...new Set(names)].sort();
}

/** Where a native session's CLI keeps its temp files, and its commands theirs (SandboxRuntime.claudeTemp). */
export interface ClaudeTempDirs {
  /** `CLAUDE_CODE_TMPDIR`: the CLI's own (its settings file, sockets). Not writable by commands. */
  cli: string;
  /** The CLI's `TMPDIR`: it puts its commands in `<this>/claude-<uid>`. */
  root: string;
  /** `<root>/claude-<uid>`: the commands' `TMPDIR`, the only part of these they may write. */
  commands: string;
}

/** The CLI's environment for {@link ClaudeTempDirs}. */
export function claudeTempEnv(t: ClaudeTempDirs): Record<string, string> {
  return { TMPDIR: t.root, CLAUDE_CODE_TMPDIR: t.cli };
}

/** POSIX shell single-quoting. */
function shQuote(v: string): string {
  return `'${v.replace(/'/g, `'\\''`)}'`;
}

/**
 * The CLI's environment for a native session: its temp dirs
 * ({@link claudeTempEnv}), and the toolchains' cache variables
 * (SandboxSpec.env) for its sandboxed commands only. The cache dir is
 * writable by every sandboxed command, and a cache is code to the toolchain
 * reading it (`CARGO_HOME`'s `config.toml` and `bin/`, a module in
 * `GOMODCACHE`, an install in npx's cache), so nothing that runs outside a
 * sandbox may get them: not the CLI, nor what it starts with its own
 * environment (stdio MCP servers, hooks, a command the owner let run outside
 * the sandbox). So they aren't in the CLI's environment at all: the CLI
 * sources `CLAUDE_ENV_FILE` into every Bash command, and the file codeoid
 * writes (in the CLI's own temp dir, which no command can write) exports
 * them only where the CLI's sandbox marks the command as inside it
 * (`SANDBOX_RUNTIME=1`, which the CLI sets for its sandboxed commands and
 * codeoid takes out of the CLI's own environment). A `CLAUDE_ENV_FILE` of
 * the caller's is sourced after it.
 */
export function claudeNativeEnv(spec: Pick<SandboxSpec, "env">, temp: ClaudeTempDirs, env: Record<string, string | undefined>): Record<string, string | undefined> {
  const { SANDBOX_RUNTIME: _marker, ...rest } = env;
  const exports = Object.entries(spec.env ?? {})
    .filter(([k]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k))
    .map(([k, v]) => `  export ${k}=${shQuote(v)}`);
  const own = env.CLAUDE_ENV_FILE;
  const lines = [
    "# codeoid (#448): the toolchains' caches, for commands inside the sandbox only.",
    ...(exports.length > 0 ? ['if [ "${SANDBOX_RUNTIME-}" = 1 ]; then', ...exports, "fi"] : []),
    ...(own ? [`[ -r ${shQuote(own)} ] && . ${shQuote(own)}`] : []),
    "",
  ];
  const file = join(temp.cli, "command-env.sh");
  const part = `${file}.${process.pid}.part`;
  writeFileSync(part, lines.join("\n"), { mode: 0o600 });
  renameSync(part, file);
  return { ...rest, ...claudeTempEnv(temp), CLAUDE_ENV_FILE: file };
}

/** The SDK's `sandbox` option for a session whose sandbox is on and native. */
export function claudeSandboxSettings(rt: Pick<SandboxRuntime, "spec" | "config">, env: Record<string, string | undefined>, temp?: ClaudeTempDirs): SandboxSettings {
  const spec = rt.spec;
  const tempDir = temp?.commands ?? spec.tempDir;
  const network: NonNullable<SandboxSettings["network"]> =
    spec.network.mode === "off"
      ? { allowedDomains: [], deniedDomains: ["*"], strictAllowlist: true }
      : spec.network.mode === "allowlist"
        ? { allowedDomains: [...(spec.network.allow ?? [])], strictAllowlist: true }
        : {};
  const envVars = credentialEnvNames(env, spec.unsetEnv).map((name) => ({ name, mode: "deny" as const }));
  return {
    enabled: true,
    failIfUnavailable: true,
    autoAllowBashIfSandboxed: false,
    allowUnsandboxedCommands: true,
    // Every path physical (physicalOf): the CLI's bubblewrap can't lay a
    // mount through a symlinked dir (`/var/run` → `/run` made every command
    // fail where `/var/run/docker.sock` exists).
    filesystem: {
      allowWrite: physical([spec.workspace, tempDir, ...spec.writable]),
      // The CLI's own settings: a hook or an excluded command written there
      // would run outside the sandbox from the CLI's next start. A
      // repository's hooks and config, for the same reason. And every dir
      // between the workspace and a hidden path in it (nothing renames it away).
      denyWrite: physical([...claudeSettingsPaths(spec.workspace, env), ...(spec.readOnly ?? []), ...(spec.pinned ?? [])]),
      denyRead: physical([...spec.hidden, ...spec.containerSockets]),
      // Inside the denied home: the allowlist, and what is written (a workspace in it).
      allowRead: physical([spec.workspace, tempDir, ...spec.writable, ...spec.reexposed]),
    },
    network,
    ...(envVars.length > 0 ? { credentials: { envVars } } : {}),
    ...(rt.config.bwrapPath ? { bwrapPath: rt.config.bwrapPath } : {}),
  };
}

/**
 * `p` with no symlink in it: the real path of its longest existing part,
 * with the rest (what doesn't exist yet) appended.
 */
export function physicalOf(p: string): string {
  const missing: string[] = [];
  for (let at = resolve(p); ; at = dirname(at)) {
    try {
      return join(realpathSync(at), ...missing.reverse());
    } catch {
      if (dirname(at) === at) return resolve(p);
      missing.push(basename(at));
    }
  }
}

function physical(paths: readonly string[]): string[] {
  return [...new Set(paths.map(physicalOf))];
}

/** Whether a tool call asks to run outside the sandbox (Claude's Bash `dangerouslyDisableSandbox`). */
export function asksUnsandboxed(input: unknown): boolean {
  return !!input && typeof input === "object" && (input as Record<string, unknown>).dangerouslyDisableSandbox === true;
}

/**
 * Where the Claude CLI reads settings that can run code or loosen its
 * sandbox (hooks, `sandbox.excludedCommands`, permissions): the project's
 * `.claude` dir in the workspace, and the user's config dir. A command must
 * not write them; the CLI itself still can (it runs outside its sandbox).
 */
export function claudeSettingsPaths(workspace: string, env: Record<string, string | undefined>): string[] {
  const home = env.HOME || homedir();
  return [join(workspace, ".claude"), env.CLAUDE_CONFIG_DIR || join(home, ".claude")];
}
