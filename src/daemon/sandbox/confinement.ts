/**
 * How each backend is put inside a sandbox provider (#448): a backend
 * capability, chosen per (backend, provider).
 *
 *   - `native`: the backend's own sandbox, given codeoid's policy. Claude
 *     Code on a local OS provider (its sandbox is bubblewrap / Seatbelt, with
 *     a proxy that can enforce a host allowlist). Codex on Linux runs its own
 *     workspace-write sandbox AND has its app-server process wrapped by
 *     codeoid's provider, since codex's own leaves credentials readable.
 *   - `process`: the backend's whole process starts inside (pi, the Gemini
 *     CLI, Qwen; Claude and Codex under Docker; Codex under Seatbelt, which
 *     doesn't nest). It runs in a private copy of its home (backend-home.ts),
 *     its login a private copy written back and its conversations its own, so nothing its
 *     commands write there runs later outside a sandbox; it needs the network
 *     to reach its model, so the network can't be turned off for its commands.
 *   - `command`: each shell command starts inside (opencode: one server
 *     serves every session, so its shell is a codeoid shim that runs each
 *     line in the session's sandbox). File tools run in the server, outside,
 *     held to the sandbox's own policy at codeoid's gate in autonomous mode
 *     (host-file-tools.ts).
 *   - `no-shell`: the backend runs no commands (HTTP model APIs).
 */

import type { NetworkMode, SandboxProvider } from "./types.js";

export type ConfinementKind = "native" | "process" | "command" | "no-shell";

export interface ConfinementPlan {
  kind: ConfinementKind;
  /** How, in words, for the session header. */
  via: string;
  /** Network modes commands can be held to this way. */
  network: readonly NetworkMode[];
  /**
   * Whether the backend's file tools (read, edit, write) run inside too. When
   * they don't, codeoid's gate holds them to the sandbox's own policy
   * (host-file-tools.ts).
   */
  fileTools: boolean;
  /** Whether codeoid opens a handle around the backend's process (process kind, Codex's outer wrap). */
  wrapsBackend: boolean;
  /** What isn't confined this way. */
  limits: string[];
}

export type ConfinementResult = { ok: true; plan: ConfinementPlan } | { ok: false; reason: string };

/** Backends that call a model over HTTP and run no commands themselves. */
const HTTP_BACKENDS = new Set(["openai", "gemini", "llamacpp"]);
/** Backends that run no commands at all (test doubles). */
const NO_COMMAND_BACKENDS = new Set(["scripted", "mock"]);

const PROCESS_LIMITS = (backend: string) => [
  `${backend}'s login is readable by its commands (a private copy, a refresh written back); its settings are a private copy, made afresh at each start`,
  `${backend} needs the network to reach its model, so its commands have the network too`,
];

/** True for a backend id whose tools never run a command. */
export function runsNoCommands(backendId: string): boolean {
  return HTTP_BACKENDS.has(backendId) || NO_COMMAND_BACKENDS.has(backendId) || backendId.startsWith("oai:");
}

function localOs(p: SandboxProvider): boolean {
  return p.capabilities.placement === "local" && p.capabilities.wrapsArgv && p.capabilities.workspace === "mount";
}

/** What the host offers a plan (tests replace it). */
export interface ConfinementHost {
  platform: NodeJS.Platform;
  /** A program on PATH, or null. */
  which(name: string): string | null;
}

const realHost: ConfinementHost = { platform: process.platform, which: (name) => Bun.which(name) ?? null };

/**
 * Why Claude Code's own sandbox can't start here, or null. On Linux it is
 * bubblewrap plus `socat` (its network proxy's bridge into the sandbox);
 * without socat the CLI refuses every query (`failIfUnavailable`), so the
 * session says it isn't sandboxed instead (interactive runs, unattended is
 * refused).
 */
export function claudeNativeProblem(host: ConfinementHost = realHost): string | null {
  if (host.platform === "linux" && !host.which("socat")) {
    return "Claude Code's sandbox needs socat on Linux, and it isn't installed — install the `socat` package";
  }
  return null;
}

/**
 * The plan for `backendId` under `provider`, or why it can't be sandboxed
 * that way. `provider` null: only a no-command backend has a plan.
 */
export function confinementFor(backendId: string, provider: SandboxProvider | null, host: ConfinementHost = realHost): ConfinementResult {
  if (runsNoCommands(backendId)) {
    return { ok: true, plan: { kind: "no-shell", via: "runs no commands", network: ["on", "off", "allowlist"], fileTools: true, wrapsBackend: false, limits: [] } };
  }
  if (!provider) return { ok: false, reason: "no sandbox provider" };
  const caps = provider.capabilities;
  const name = provider.displayName;
  switch (backendId) {
    case "claude": {
      // Claude Code's own sandbox is bubblewrap on Linux and Seatbelt on macOS.
      if (localOs(provider) && caps.isolation === "os" && (provider.id === "bwrap" || provider.id === "seatbelt")) {
        const missing = claudeNativeProblem(host);
        if (missing) return { ok: false, reason: missing };
        return {
          ok: true,
          plan: {
            kind: "native",
            via: `Claude Code's sandbox (${name}) with codeoid's policy`,
            network: ["on", "off", "allowlist"],
            fileTools: false,
            wrapsBackend: false,
            limits: [
              "Claude's file tools (Read, Edit, Write, Glob, Grep, LSP) run in the CLI, outside the sandbox: in autonomous mode they are held to the sandbox's own policy at codeoid's gate (a read of what it hides, or a write outside what it lets commands write, is refused; the CLI's own memory, plans and task output stay its own); guarded and interactive mode ask as without a sandbox, the card saying a call is outside its bounds",
            ],
          },
        };
      }
      if (caps.stdioProcess && caps.wrapsArgv) {
        return { ok: true, plan: { kind: "process", via: `the Claude CLI runs inside ${name}`, network: ["on"], fileTools: true, wrapsBackend: true, limits: PROCESS_LIMITS("the Claude CLI") } };
      }
      return { ok: false, reason: `${name} can't run the Claude CLI (it needs a process with piped stdio)` };
    }
    case "codex": {
      if (provider.id === "bwrap") {
        return {
          ok: true,
          plan: {
            kind: "native",
            via: `codex's workspace-write sandbox, inside ${name}`,
            network: ["on", "off"],
            fileTools: true,
            wrapsBackend: true,
            limits: ["codex's login is readable by its commands (a private copy, a refresh written back); its settings are a private copy, made afresh at each start"],
          },
        };
      }
      if (caps.stdioProcess && caps.wrapsArgv) {
        return { ok: true, plan: { kind: "process", via: `codex runs inside ${name}`, network: ["on"], fileTools: true, wrapsBackend: true, limits: PROCESS_LIMITS("codex") } };
      }
      return { ok: false, reason: `${name} can't run codex (it needs a process with piped stdio)` };
    }
    case "opencode": {
      if (caps.wrapsArgv && caps.commands) {
        return {
          ok: true,
          plan: {
            kind: "command",
            via: `each shell command runs inside ${name}`,
            network: caps.network,
            fileTools: false,
            wrapsBackend: false,
            limits: [
              "opencode's file tools run in its shared server, outside the sandbox: in autonomous mode they are held to the sandbox's own policy at codeoid's gate (a read of what it hides, or a write outside what it lets commands write, is refused; its scratch dir stays its own); guarded and interactive mode ask as without a sandbox, the card saying a call is outside its bounds",
            ],
          },
        };
      }
      return { ok: false, reason: `${name} can't run opencode's shell commands (it needs to start a local program per command)` };
    }
    case "pi":
    case "gemini-cli":
    case "qwen": {
      if (caps.stdioProcess && caps.wrapsArgv) {
        return { ok: true, plan: { kind: "process", via: `${backendId} runs inside ${name}`, network: ["on"], fileTools: true, wrapsBackend: true, limits: PROCESS_LIMITS(backendId) } };
      }
      return { ok: false, reason: `${name} can't run ${backendId} (it needs a local process with piped stdio)` };
    }
    default:
      return { ok: false, reason: `codeoid doesn't know how to sandbox the ${backendId} backend` };
  }
}

/**
 * A tool call that asks to run outside the session's sandbox, or to widen
 * it: Claude's Bash with `dangerouslyDisableSandbox`, Codex asking for more
 * permissions than its sandbox gives (`codex_permissions`, an
 * `item/permissions/requestApproval`). Asked in guarded and interactive
 * mode, refused in autonomous mode (Session#autonomousRefusal).
 */
export function asksOutsideSandbox(toolName: string, input: unknown): boolean {
  if (toolName === "codex_permissions") return true;
  return !!input && typeof input === "object" && (input as Record<string, unknown>).dangerouslyDisableSandbox === true;
}
