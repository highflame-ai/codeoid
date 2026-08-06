// Re-export shim. The canonical protocol now lives in the @highflame/codeoid-protocol
// package (packages/protocol) so the daemon, web UI, and mobile client share
// one source of truth. Kept so existing "../protocol/…" imports keep resolving;
// new code should import from "@highflame/codeoid-protocol" directly.
export * from "@highflame/codeoid-protocol";
