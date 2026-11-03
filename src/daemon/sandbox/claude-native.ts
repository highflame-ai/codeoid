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
 *   - filesystem: the workspace and the session's temp dir writable, every
 *     hidden path and container socket unreadable;
 *   - network: `on` leaves hosts to the CLI's ask, which codeoid's gate
 *     allows; `off` denies every host; `allowlist` allows only those hosts,
 *     without asking;
 *   - credentials: the credential variables the CLI runs with are denied to
 *     its commands.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type { SandboxSettings } from "@anthropic-ai/claude-agent-sdk";
import type { SandboxRuntime } from "./session-sandbox.js";

/** A variable whose value is a credential (by name). */
const CREDENTIAL_NAME = /(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|COOKIE|AUTH)(?:_|$)/i;

/** The variables of the CLI's environment its commands must not see. */
export function credentialEnvNames(env: Record<string, string | undefined>, unset: readonly string[] = []): string[] {
  const names = Object.keys(env).filter((k) => CREDENTIAL_NAME.test(k) || unset.includes(k));
  return [...new Set(names)].sort();
}

/** The SDK's `sandbox` option for a session whose sandbox is on and native. */
export function claudeSandboxSettings(rt: Pick<SandboxRuntime, "spec" | "config">, env: Record<string, string | undefined>): SandboxSettings {
  const spec = rt.spec;
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
    filesystem: {
      allowWrite: [spec.workspace, spec.tempDir, ...spec.writable],
      // The CLI's own settings: a hook or an excluded command written there
      // would run outside the sandbox from the CLI's next start. And every dir
      // between the workspace and a hidden path in it (nothing renames it away).
      denyWrite: [...new Set([...claudeSettingsPaths(spec.workspace, env), ...(spec.readOnly ?? [])])],
      denyRead: [...new Set([...spec.hidden, ...spec.containerSockets])],
    },
    network,
    ...(envVars.length > 0 ? { credentials: { envVars } } : {}),
    ...(rt.config.bwrapPath ? { bwrapPath: rt.config.bwrapPath } : {}),
  };
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
