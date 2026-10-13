/**
 * Public API for the compressor subsystem.
 *
 * The shape mirrors memory/index.ts: factory + registry + runner exports.
 * Downstream code should import from here, not the individual files.
 */

import type { CodeoidConfig } from "../../config.js";
import { CompressionRegistry } from "./registry.js";
import { BUILTIN_RULES } from "./rules/index.js";

export { CompressionRegistry, extractLeadingTokens } from "./registry.js";
export { runCompressed, hasShellPipe, MAX_RAW_BYTES } from "./runner.js";
export { rewriteBashToolInput, resolveWrapperPath } from "./prehook.js";
export { formatHint, HINT_PREFIX } from "./hint.js";
export { defaultSpillDir, pruneSpill, takeSpill, writeSpill } from "./spill.js";
export {
  BUILTIN_RULES,
  genericTruncateRule,
  gitDiffRule,
  gitStatusRule,
  gitLogRule,
  lsRule,
  catRule,
  findTreeRule,
  searchRule,
  testRunnerRule,
} from "./rules/index.js";
export type {
  CompressionContext,
  CompressionOutcome,
  CompressionResult,
  CompressionRule,
  RuleName,
} from "./types.js";

/**
 * Build the default registry from a parsed CodeoidConfig. Pulls the
 * user's exclusion list + pattern list and locks rules into priority order.
 */
export function createRegistry(
  config: CodeoidConfig,
): CompressionRegistry {
  return new CompressionRegistry({
    rules: BUILTIN_RULES,
    excludeCommands: config.compress.excludeCommands,
    excludePatterns: config.compress.excludePatterns.map(
      (p) => new RegExp(p),
    ),
  });
}
