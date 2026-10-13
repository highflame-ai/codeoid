/**
 * Consistent compressed-output footer. Every compressed result ends with a
 * single-line marker so Claude learns to look for it and knows the raw
 * output is recoverable via codeoid memory.
 *
 * Shape chosen to be (a) machine-parseable by frontends that want to render
 * a "view raw" button, (b) cheap for Claude to parse textually.
 */

import type { CompressionResult } from "./types.js";

/** Tag prefix used so we can detect/strip these from memory recalls. */
export const HINT_PREFIX = "[codeoid:";

/**
 * Build the default hint. Rules can override via CompressionResult.hint.
 * Format, when the raw output was spilled for memory (see spill.ts):
 *   [codeoid: compressed <PCT>% via <rule>; full output in memory (raw=<id>) — recall("<cmd>", include_current_session=true), then get_episode]
 * and without a spill (it couldn't be written), an honest statement that the
 * raw output is gone.
 */
export function formatHint(
  result: CompressionResult,
  command: string,
  rawId?: string | null,
): string {
  const compressedBytes = Buffer.byteLength(result.compressed, "utf8");
  const pct = result.originalBytes > 0
    ? Math.round(
        (1 - compressedBytes / result.originalBytes) * 100,
      )
    : 0;
  const shortCmd = shortenCommand(command);
  if (!rawId) {
    return `${HINT_PREFIX} compressed ${pct}% via ${result.ruleName}; the uncompressed output was not kept — rerun "${shortCmd}" if you need it]`;
  }
  return `${HINT_PREFIX} compressed ${pct}% via ${result.ruleName}; full output in memory (raw=${rawId}) — recall("${shortCmd}", include_current_session=true), then get_episode]`;
}

/** Trim a command to a safe length for embedding in the hint line. */
function shortenCommand(cmd: string): string {
  const trimmed = cmd.trim();
  if (trimmed.length <= 80) return trimmed;
  return `${trimmed.slice(0, 77)}…`;
}
