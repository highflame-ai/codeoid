/**
 * Terminal rendering for Claude accounts (protocol: claude-accounts.ts).
 * Pure — no I/O — so it is testable.
 */

import type { ClaudeAccountInfo } from "../protocol/types.js";

const KIND_LABEL: Record<ClaudeAccountInfo["kind"], string> = {
  subscription: "subscription",
  gateway: "gateway",
  "api-key": "API key",
};

/** The account list, the default marked. The built-in `default` is always listed first. */
export function formatClaudeAccounts(accounts: readonly ClaudeAccountInfo[], defaultAccount: string): string {
  const mark = (name: string) => (name === defaultAccount ? "*" : " ");
  const lines = [
    "",
    "  Claude accounts (* = daemon default):",
    "",
    `  ${mark("default")} ${"default".padEnd(22)} the daemon's own environment / claude login`,
  ];
  for (const a of accounts) {
    const detail =
      a.kind === "gateway"
        ? `${a.baseUrl ?? ""}${a.headerNames?.length ? ` (headers: ${a.headerNames.join(", ")})` : ""}`
        : "";
    lines.push(`  ${mark(a.name)} ${a.name.padEnd(22)} ${KIND_LABEL[a.kind].padEnd(13)} ${detail}`.trimEnd());
  }
  lines.push("");
  return lines.join("\n");
}

/** Parse a repeatable `--header "Name: value"` flag. Throws on a malformed one. */
export function parseHeaderFlags(flags: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of flags) {
    const sep = f.indexOf(":");
    const name = sep > 0 ? f.slice(0, sep).trim() : "";
    if (!name) throw new Error(`--header takes "Name: value", got ${JSON.stringify(f)}`);
    out[name] = f.slice(sep + 1).trim();
  }
  return out;
}
