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

/**
 * Parse a repeatable `--header` flag: `"Name: value"`, or a bare `Name` whose
 * value is then asked for without echo — a workspace key on the command line
 * would land in shell history and in `ps` for every local user. Throws on a
 * malformed one.
 */
export function parseHeaderFlags(flags: readonly string[]): { headers: Record<string, string>; ask: string[] } {
  const headers: Record<string, string> = {};
  const ask: string[] = [];
  for (const f of flags) {
    const sep = f.indexOf(":");
    const name = (sep >= 0 ? f.slice(0, sep) : f).trim();
    if (!name) throw new Error(`--header takes "Name: value" or "Name", got ${JSON.stringify(f)}`);
    if (sep < 0) ask.push(name);
    else headers[name] = f.slice(sep + 1).trim();
  }
  return { headers, ask };
}
