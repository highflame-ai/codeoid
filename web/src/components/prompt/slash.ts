/**
 * Re-export shim — the slash-command parser/dispatcher lives in
 * `@highflame/codeoid-core` (SlashContext is dependency-injected, so the logic is
 * frontend-agnostic).
 */
export { dispatchSlash, parseSlash } from "@highflame/codeoid-core";
export type { SlashCommand, SlashContext } from "@highflame/codeoid-core";
