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
 *     doesn't nest). Its own state stays reachable by it, so by its commands
 *     too; it needs the network to reach its model, so the network can't be
 *     turned off for its commands.
 *   - `command`: each shell command starts inside (opencode: one server
 *     serves every session, so its shell is a codeoid shim that runs each
 *     line in the session's sandbox). File tools run in the server, outside,
 *     under codeoid's gate.
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
  /** Whether the backend's file tools (edit, write) run inside too. */
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
  `${backend}'s own state (its login and settings) stays reachable by its commands`,
  `${backend} needs the network to reach its model, so its commands have the network too`,
];

/** True for a backend id whose tools never run a command. */
export function runsNoCommands(backendId: string): boolean {
  return HTTP_BACKENDS.has(backendId) || NO_COMMAND_BACKENDS.has(backendId) || backendId.startsWith("oai:");
}

function localOs(p: SandboxProvider): boolean {
  return p.capabilities.placement === "local" && p.capabilities.wrapsArgv && p.capabilities.workspace === "mount";
}

/**
 * The plan for `backendId` under `provider`, or why it can't be sandboxed
 * that way. `provider` null: only a no-command backend has a plan.
 */
export function confinementFor(backendId: string, provider: SandboxProvider | null): ConfinementResult {
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
        return {
          ok: true,
          plan: {
            kind: "native",
            via: `Claude Code's sandbox (${name}) with codeoid's policy`,
            network: ["on", "off", "allowlist"],
            fileTools: false,
            wrapsBackend: false,
            limits: ["Claude's file tools (Read, Edit, Write) run in the CLI, outside the sandbox: codeoid's gate judges them (credential paths, writes outside the workspace)"],
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
            limits: ["codex's own home (CODEX_HOME, with its login) stays reachable by its commands"],
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
            limits: ["opencode's file tools run in its shared server, outside the sandbox: codeoid's gate judges them (credential paths, writes outside the workspace)"],
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
 * `item/permissions/requestApproval`). Asked in every mode (Session).
 */
export function asksOutsideSandbox(toolName: string, input: unknown): boolean {
  if (toolName === "codex_permissions") return true;
  return !!input && typeof input === "object" && (input as Record<string, unknown>).dangerouslyDisableSandbox === true;
}
