/**
 * PreToolUse rewrite helper — turns a Bash tool invocation into a wrapped
 * call through our compressor CLI so the agent sees compressed output.
 *
 * Wire:
 *   Bash({ command: "git diff HEAD~5" })
 *     → rewriteBashToolInput(...)
 *     → Bash({ command: "bun <wrapper> --b64 <b64> --cwd <workdir>" })
 *
 * The hook is a no-op unless:
 *   - tool name is exactly "Bash"
 *   - config.compress.enabled is true
 *   - the command is a non-empty string
 *   - the registry considers the command eligible (shouldCompress)
 *   - the command doesn't already reference our wrapper (idempotent)
 *
 * Base64 transport avoids every shell-escaping pothole — quoting nested
 * single quotes, here-docs, backslash continuations, $variables, etc.
 * The wrapper decodes argv and executes via /bin/sh -c itself.
 */

import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { CodeoidConfig } from "../../config.js";
import type { CompressionRegistry } from "./registry.js";

/** Absolute path to the wrapper CLI resolved against this module. */
export function resolveWrapperPath(): string {
  // __dirname equivalent for ESM/bun:
  const here = fileURLToPath(new URL(".", import.meta.url));
  return join(here, "wrapper-cli.ts");
}

/** Marker so our rewritten commands are idempotent on re-entry. */
const REWRITE_MARKER = "wrapper-cli.ts --b64";

export interface RewriteInput {
  toolName: string;
  toolInput: Record<string, unknown>;
  config: CodeoidConfig;
  registry: CompressionRegistry;
  workdir: string;
  /** Override wrapper path (tests); defaults to resolveWrapperPath(). */
  wrapperPath?: string;
}

/**
 * Return a new `tool_input` when the command should be compressed, or
 * `null` when the hook should pass through unchanged.
 */
export function rewriteBashToolInput(
  input: RewriteInput,
): Record<string, unknown> | null {
  if (input.toolName !== "Bash") return null;
  if (!input.config.compress.enabled) return null;

  const original = input.toolInput.command;
  if (typeof original !== "string" || original.length === 0) return null;

  // Idempotency: if we already rewrote, don't wrap again.
  if (original.includes(REWRITE_MARKER)) return null;

  if (!input.registry.shouldCompress(original)) return null;

  const wrapper = input.wrapperPath ?? resolveWrapperPath();
  const b64 = Buffer.from(original, "utf8").toString("base64");
  const newCommand = `bun ${shellQuote(wrapper)} --b64 ${b64} --cwd ${shellQuote(input.workdir)}`;

  // Return a shallow copy so the caller can safely merge into the SDK's
  // updatedInput slot without aliasing.
  return { ...input.toolInput, command: newCommand };
}

/**
 * The command a rewritten call really runs, and the directory it runs in
 * (#431): the approval gate judges that, not the wrapper. Only a line exactly
 * as rewriteBashToolInput writes it is seen through: codeoid's own wrapper,
 * a canonical payload and one quoted `--cwd`, nothing before or after. The
 * agent can write that prefix itself, so anything else (a look-alike path,
 * a second command after it, another argument the wrapper would take
 * instead) is judged as the line it is.
 */
export function decodeCompressedCommand(command: string, wrapperPath: string = resolveWrapperPath()): { command: string; cwd: string } | null {
  const prefix = `bun ${shellQuote(wrapperPath)} --b64 `;
  if (!command.startsWith(prefix)) return null;
  const m = /^([A-Za-z0-9+/]+={0,2}) --cwd ([A-Za-z0-9_./@:+=-]+|'(?:[^']|'\\'')*')$/.exec(command.slice(prefix.length));
  if (!m) return null;
  const decoded = Buffer.from(m[1]!, "base64").toString("utf8");
  // Base64 decoding is lenient; a payload that doesn't round-trip isn't ours.
  if (Buffer.from(decoded, "utf8").toString("base64") !== m[1]) return null;
  const quoted = m[2]!;
  const cwd = quoted.startsWith("'") ? quoted.slice(1, -1).replace(/'\\''/g, "'") : quoted;
  if (shellQuote(cwd) !== quoted) return null;
  return { command: decoded, cwd };
}

/**
 * Minimal single-quote shell escape. We only need it for paths which shouldn't
 * normally contain quotes, but belt-and-suspenders.
 */
function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_./@:+=-]+$/.test(s)) return s; // safe already
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
