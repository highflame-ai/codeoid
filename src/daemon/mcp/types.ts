/**
 * Canonical MCP registry types (see docs/provider-mcp-registry-design.md).
 *
 * A single transport-neutral `McpServerSpec` is the one description of a server;
 * per-backend mounters translate it into that backend's native mount, and the
 * daemon-owned client (`McpHub`, S2) speaks the transport. Tools are keyed by
 * ONE canonical name across every backend so isSafeTool / canUseTool stay a
 * single gate.
 */

/** `readonly` → auto-approve on every backend (like the memory tools);
 *  `prompt` → always route through the approval gate. */
export type McpTrust = "readonly" | "prompt";

/** Tenant binding passed to a tool call. `session` scopes to {workspace,session}
 *  (what codeoid_memory mints per session); `workspace`/`global` widen it. */
export type McpScope = "global" | "workspace" | "session";

/** Launch a local subprocess speaking JSON-RPC over stdio. */
export interface McpStdioTransport {
  kind: "stdio";
  command: string;
  args: string[];
  /** Literal subprocess env. A `${VAR}` value is resolved from the daemon's own
   *  environment at mount time so secrets never live in the config file. */
  env: Record<string, string>;
}

/** POST JSON-RPC to a streamable-HTTP endpoint. */
export interface McpHttpTransport {
  kind: "http";
  url: string;
  headers: Record<string, string>;
  /** Env-var NAME the daemon reads the bearer token from (never inline/argv). */
  bearerTokenEnv?: string;
  /** OAuth per the MCP authorization spec; the daemon holds the token. */
  oauth?: McpOAuthConfig;
}

/** A remote server's OAuth settings. Everything is optional: with none, the
 *  client discovers the authorization server and registers dynamically. */
export interface McpOAuthConfig {
  /** Pre-registered client id, for servers without dynamic registration. */
  clientId?: string;
  /** Env-var NAME holding that client's secret (never inline). */
  clientSecretEnv?: string;
  /** Scopes to request; omitted, the server's advertised scopes apply. */
  scopes?: string[];
}

/** codeoid's own in-daemon server (codeoid_memory) — tools run in-process
 *  against the live engine; no subprocess or socket. */
export interface McpInProcessTransport {
  kind: "in-process";
}

export type McpTransport = McpStdioTransport | McpHttpTransport | McpInProcessTransport;

/** Normalized, transport-neutral description of one MCP server. */
export interface McpServerSpec {
  /** Server name; tools become `mcp__<name>__<tool>`. */
  name: string;
  transport: McpTransport;
  trust: McpTrust;
  scope: McpScope;
  /** Allowlist of tool names surfaced to the model; undefined = all. */
  toolAllowlist?: string[];
  /** Restrict to these backend ids (e.g. ["claude","codex"]); undefined = all. */
  backends?: string[];
  enabled: boolean;
  /** Escape hatch: sync into the backend's OWN native config instead of
   *  proxying through the daemon (Model-A backends only). */
  native: boolean;
  /** Built-in (codeoid_memory) — not user-declarable; always readonly+session. */
  builtin: boolean;
}

/** The one namespaced tool name used across ALL backends, so isSafeTool /
 *  canUseTool key off a single form. Matches the claude in-process convention
 *  and the codex normalization (see the mcpServer/elicitation/request fix). */
export function canonicalToolName(server: string, tool: string): string {
  return `mcp__${server}__${tool}`;
}

/** True when `spec` should be delivered by codeoid owning the client (Model B
 *  + the default for Model A), vs synced into the backend's native config. */
/** True when a server is configured for OAuth. */
export function isOAuthServer(spec: McpServerSpec): boolean {
  return spec.transport.kind === "http" && spec.transport.oauth !== undefined;
}

/**
 * Backends that mount registry servers natively (their own MCP client, headers
 * fixed at start). They cannot carry a refreshing OAuth token, so they do not
 * mount OAuth servers; those reach only the daemon-owned client for now
 * (docs/mcp-oauth-design.md §5).
 */
export const NATIVE_MOUNT_BACKENDS: readonly string[] = ["claude", "codex", "gemini-cli", "qwen"];

export function isProxied(spec: McpServerSpec): boolean {
  return !spec.native;
}

/** Resolve a `${VAR}` env reference against the daemon env so secrets stay out
 *  of the config file; a literal (no `${...}`) passes through unchanged. */
export function resolveEnvValue(value: string, env: Record<string, string | undefined>): string {
  const m = /^\$\{(\w+)\}$/.exec(value);
  return m ? (env[m[1]] ?? "") : value;
}

/** Resolve every value in an env map via {@link resolveEnvValue}. */
export function resolveEnvMap(
  map: Record<string, string>,
  env: Record<string, string | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) out[k] = resolveEnvValue(v, env);
  return out;
}
