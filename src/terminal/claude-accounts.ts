/**
 * Terminal rendering for Claude accounts (protocol: claude-accounts.ts).
 * Pure — no I/O — so it is testable.
 */

import { accountKindsFor, BEDROCK_SETTINGS, type AccountInfo, type BackendAccountsInfo, type ClaudeAccountInfo } from "../protocol/types.js";

const KIND_LABEL: Record<ClaudeAccountInfo["kind"], string> = {
  subscription: "subscription",
  gateway: "gateway",
  "api-key": "API key",
  bedrock: "Bedrock",
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
        : a.kind === "bedrock"
          ? (a.baseUrl ?? "AWS")
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

/** Bedrock settings whose values are secrets (the kind descriptor's `secret`). */
const BEDROCK_SECRET: readonly string[] = accountKindsFor("claude").find((k) => k.kind === "bedrock")?.env?.secret ?? [];

/**
 * Parse a repeatable `--set` flag for a Bedrock account: `NAME=value`, or a
 * bare `NAME` whose value is then asked for without echo (a telemetry header
 * usually carries a key). Throws on a name a Bedrock account doesn't take.
 */
export function parseSettingFlags(flags: readonly string[]): { env: Record<string, string>; ask: string[] } {
  const env: Record<string, string> = {};
  const ask: string[] = [];
  for (const f of flags) {
    const sep = f.indexOf("=");
    const name = (sep >= 0 ? f.slice(0, sep) : f).trim();
    if (!(BEDROCK_SETTINGS as readonly string[]).includes(name)) {
      // The name only: the value may be a key.
      throw new Error(`--set takes NAME=value or NAME, with NAME one of ${BEDROCK_SETTINGS.join(", ")}; got ${JSON.stringify(name)}`);
    }
    if (sep < 0) ask.push(name);
    else if (BEDROCK_SECRET.includes(name)) {
      // On the command line it would land in shell history and `ps`.
      throw new Error(`${name} holds a key: pass --set ${name} alone and it is asked for without echo`);
    } else env[name] = f.slice(sep + 1).trim();
  }
  return { env, ask };
}

/**
 * A Bedrock account from a Claude settings file's `env` block — the setup
 * Claude Code reads from `~/.claude/settings.json`, moved into an account.
 * `ignored` names what the account doesn't take (the caller says so).
 * Throws when the file doesn't describe Bedrock.
 */
export function bedrockFromSettings(parsed: unknown): {
  token?: string;
  baseUrl?: string;
  env: Record<string, string>;
  ignored: string[];
} {
  const raw = parsed && typeof parsed === "object" ? (parsed as { env?: unknown }).env : undefined;
  if (!raw || typeof raw !== "object") throw new Error("the settings file has no env block");
  const out: { token?: string; baseUrl?: string; env: Record<string, string>; ignored: string[] } = { env: {}, ignored: [] };
  const use = (raw as Record<string, unknown>).CLAUDE_CODE_USE_BEDROCK;
  if (use !== undefined && !["1", "true", "yes", "on"].includes(String(use).trim().toLowerCase())) {
    throw new Error("the settings file turns Bedrock off (CLAUDE_CODE_USE_BEDROCK)");
  }
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (k === "CLAUDE_CODE_USE_BEDROCK") continue; // what the account kind means
    if (v === "" || v === null) continue;
    // Claude Code reads env values as strings; a number or boolean here is a
    // setting codeoid won't guess the text of — name it instead.
    if (typeof v !== "string") {
      out.ignored.push(k);
      continue;
    }
    if (k === "AWS_BEARER_TOKEN_BEDROCK") out.token = v;
    else if (k === "ANTHROPIC_BEDROCK_BASE_URL") out.baseUrl = v;
    else if ((BEDROCK_SETTINGS as readonly string[]).includes(k)) out.env[k] = v;
    else out.ignored.push(k);
  }
  if (out.token === undefined && out.baseUrl === undefined && !Object.hasOwn(raw, "CLAUDE_CODE_USE_BEDROCK")) {
    throw new Error("the settings file doesn't set up Bedrock (no CLAUDE_CODE_USE_BEDROCK, AWS_BEARER_TOKEN_BEDROCK or ANTHROPIC_BEDROCK_BASE_URL)");
  }
  return out;
}

const ANY_KIND_LABEL: Record<AccountInfo["kind"], string> = {
  subscription: "subscription",
  gateway: "gateway",
  "api-key": "API key",
  "chatgpt-login": "ChatGPT sign-in",
  "api-keys": "provider keys",
  bedrock: "Amazon Bedrock",
};

/** What the built-in `default` account is, per backend. */
function builtInDetail(backend: string): string {
  if (backend === "claude") return "the daemon's own environment / claude login";
  if (backend.startsWith("oai:")) return "the endpoint's own key and headers";
  return "the daemon's own environment / login";
}

/** Every backend's accounts (protocol: accounts.ts), defaults marked. */
export function formatAccounts(backends: readonly BackendAccountsInfo[]): string {
  const lines = [""];
  for (const b of backends) {
    const mark = (name: string) => (name === b.defaultAccount ? "*" : " ");
    lines.push(`  ${b.displayName}${b.displayName === b.backend ? "" : ` (${b.backend})`} — * = default:`, "");
    lines.push(`  ${mark("default")} ${"default".padEnd(22)} ${builtInDetail(b.backend)}`);
    for (const a of b.accounts) {
      const detail = [
        a.baseUrl ?? (a.kind === "bedrock" ? "AWS" : ""),
        a.headerNames?.length ? `headers: ${a.headerNames.join(", ")}` : "",
        a.envNames?.length ? `${a.kind === "bedrock" ? "settings" : "keys"}: ${a.envNames.join(", ")}` : "",
      ]
        .filter(Boolean)
        .join("  ");
      lines.push(`  ${mark(a.name)} ${a.name.padEnd(22)} ${ANY_KIND_LABEL[a.kind].padEnd(16)} ${detail}`.trimEnd());
    }
    lines.push("");
  }
  return lines.join("\n");
}
