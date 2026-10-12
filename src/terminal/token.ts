/**
 * Obtain a bearer token for this daemon — shared by the terminal client and
 * `codeoid mcp headers`, so both resolve credentials the same way.
 *
 * Precedence: a local-mode token for the daemon's port (a `--local` daemon is
 * listening there right now), then the configured API key — exchanged at
 * ZeroID for a short-lived JWT when it is a `zid_sk_` key, used as-is
 * otherwise (an operator who already holds a JWT).
 */

import { isLoopbackUrl, resolveLocalToken, type CodeoidConfig } from "../config.js";
import { CONTROL_MCP_PATH } from "../daemon/mcp/control-path.js";
import { ALL_SCOPES_STRING, SCOPES, type Scope } from "../protocol/scopes.js";

/** Why no token could be had — `lines` are the operator-facing explanation. */
export class TokenError extends Error {
  constructor(readonly lines: string[]) {
    super(lines[0] ?? "token unavailable");
  }
}

export interface AcquiredToken {
  token: string;
  /** `local` tokens carry every scope; a requested narrowing cannot apply. */
  source: "local" | "zeroid" | "configured";
}

export async function acquireToken(
  config: Pick<CodeoidConfig, "daemonUrl" | "apiKey" | "zeroidUrl">,
  opts: { scope?: string; fetchImpl?: typeof fetch } = {},
): Promise<AcquiredToken> {
  const localToken = resolveLocalToken(config.daemonUrl);
  if (localToken) return { token: localToken, source: "local" };

  const key = config.apiKey;
  if (!key) {
    throw new TokenError([
      "No API key configured.",
      "",
      "  Set CODEOID_API_KEY environment variable",
      "  Or add apiKey to ~/.codeoid/config.json",
      "  Or run: codeoid login",
      "  Or, to try codeoid with no account at all: codeoid start --local",
    ]);
  }
  if (!key.startsWith("zid_sk_")) return { token: key, source: "configured" };

  const doFetch = opts.fetchImpl ?? fetch;
  let resp: Response;
  try {
    resp = await doFetch(`${config.zeroidUrl}/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ grant_type: "api_key", api_key: key, scope: opts.scope ?? ALL_SCOPES_STRING }),
    });
  } catch {
    throw new TokenError([
      `Cannot reach ZeroID at ${config.zeroidUrl}`,
      `  Is ZeroID running? Try: curl ${config.zeroidUrl}/health`,
    ]);
  }
  if (!resp.ok) {
    const body = (await resp.json().catch(() => ({}))) as { error?: string; error_description?: string };
    if (resp.status === 400 || resp.status === 401) {
      throw new TokenError([
        "Authentication failed — API key is invalid or expired.",
        ...(body.error_description ? [`  ${body.error_description}`] : []),
        "  Re-register your agent in ZeroID or check CODEOID_API_KEY",
      ]);
    }
    throw new TokenError([`Token exchange failed (${resp.status}): ${body.error_description ?? body.error ?? "unknown"}`]);
  }
  const data = (await resp.json()) as { access_token: string };
  return { token: data.access_token, source: "zeroid" };
}

// ── /mcp/control helpers ────────────────────────────────────────────────────

/**
 * Scope presets for a token handed to an external MCP client. Least privilege
 * by default: an outside agent should be able to do what its job needs and no
 * more, and the narrowing happens at ZeroID, in the token itself.
 */
export const MCP_SCOPE_PRESETS: Record<string, readonly Scope[]> = {
  observe: [SCOPES.SESSION_LIST, SCOPES.SESSION_WATCH],
  operate: [SCOPES.SESSION_LIST, SCOPES.SESSION_WATCH, SCOPES.SESSION_CREATE, SCOPES.SESSION_SEND, SCOPES.SESSION_INTERRUPT],
  full: [
    SCOPES.SESSION_LIST,
    SCOPES.SESSION_WATCH,
    SCOPES.SESSION_CREATE,
    SCOPES.SESSION_SEND,
    SCOPES.SESSION_INTERRUPT,
    SCOPES.SESSION_DESTROY,
  ],
};

/** Own-property check, so `constructor` or `__proto__` is never a "preset". */
export function isPreset(spec: string): boolean {
  return Object.hasOwn(MCP_SCOPE_PRESETS, spec);
}

/** A preset name, or a comma/space-separated scope list, as a scope string. */
export function resolveMcpScopes(spec: string): string {
  if (isPreset(spec)) return MCP_SCOPE_PRESETS[spec]!.join(" ");
  const known = new Set<string>(Object.values(SCOPES));
  const parts = spec.split(/[\s,]+/).filter(Boolean);
  const unknown = parts.filter((p) => !known.has(p));
  if (parts.length === 0 || unknown.length > 0) {
    throw new TokenError([
      `Unknown scope${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ") || "(none)"}`,
      `  Use a preset (${Object.keys(MCP_SCOPE_PRESETS).join(", ")}) or a list of: ${[...known].join(", ")}`,
    ]);
  }
  return parts.join(" ");
}

/** The daemon's `/mcp/control` URL, from its WebSocket URL. */
export function controlUrl(daemonUrl: string): string {
  const u = new URL(daemonUrl);
  u.protocol = u.protocol === "wss:" ? "https:" : "http:";
  u.pathname = CONTROL_MCP_PATH;
  u.search = "";
  u.hash = "";
  return u.toString();
}

/** True when the URL would carry the bearer token in cleartext off this machine. */
export function cleartextOffHost(url: string): boolean {
  return new URL(url).protocol === "http:" && !isLoopbackUrl(url);
}
