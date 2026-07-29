/**
 * Re-export shim. The wire protocol now comes from the shared
 * `@highflame/codeoid-protocol` package (../../packages/protocol) — the same source of
 * truth the daemon uses — instead of the hand-maintained mirror that lived
 * here ("keep them in sync" is finally nobody's job). Kept so the existing
 * `../protocol/types` imports across web/src resolve unchanged; new code may
 * import from `@highflame/codeoid-protocol` directly.
 *
 * NOTE (bun `file:` semantics): the dependency is COPIED into node_modules at
 * install time, not symlinked. After editing `packages/protocol`, run
 * `bun install` in `web/` to refresh the copy. CI installs fresh every run.
 */
export * from "@highflame/codeoid-protocol";
