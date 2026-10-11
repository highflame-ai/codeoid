/**
 * `codeoid mcp headers` / `codeoid mcp config` — hand an external MCP client
 * (Claude Code, Cursor, a CI job) what it needs to drive this daemon through
 * `/mcp/control` (docs/mcp-control.md).
 *
 * `headers` is shaped for Claude Code's `headersHelper`: it prints a JSON
 * object of headers on stdout, and the client re-runs it on every connection
 * and after a 401 — which is what keeps a short-lived ZeroID JWT working in a
 * long-lived mount without pasting a token anywhere.
 */

import type { CodeoidConfig } from "../config.js";
import { acquireToken, controlUrl, isPreset, resolveMcpScopes, type AcquiredToken } from "./token.js";

export interface HeadersResult {
  /** The single JSON line for stdout. */
  stdout: string;
  /** Notes for stderr — never mixed into the JSON a helper parses. */
  warnings: string[];
}

export async function mcpHeaders(
  config: Pick<CodeoidConfig, "daemonUrl" | "apiKey" | "zeroidUrl">,
  scopes: string,
  acquire: typeof acquireToken = acquireToken,
): Promise<HeadersResult> {
  const scope = resolveMcpScopes(scopes);
  const t: AcquiredToken = await acquire(config, { scope });
  const warnings: string[] = [];
  if (t.source === "local") {
    warnings.push(
      "codeoid: local-mode token — it carries every scope; --scopes cannot narrow it. Use a ZeroID key for an attenuated token.",
    );
  } else if (t.source === "configured") {
    warnings.push("codeoid: using the configured token as-is — --scopes applies only when exchanging a zid_sk_ key.");
  }
  return { stdout: JSON.stringify({ Authorization: `Bearer ${t.token}` }), warnings };
}

/**
 * A ready MCP-client entry for this daemon. The helper command is rebuilt from
 * the validated scope list, so nothing user-typed is interpolated into the
 * shell command a client will run.
 */
export function mcpConfig(
  config: Pick<CodeoidConfig, "daemonUrl">,
  opts: { name: string; scopes: string },
): Record<string, unknown> {
  const scopeArg = isPreset(opts.scopes) ? opts.scopes : resolveMcpScopes(opts.scopes).split(" ").join(",");
  if (!/^[a-z:,]+$/.test(scopeArg)) throw new Error(`unexpected scope argument: ${scopeArg}`);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(opts.name)) {
    throw new Error("--name must be 1-64 letters, digits, '-' or '_'");
  }
  return {
    mcpServers: {
      [opts.name]: {
        type: "http",
        url: controlUrl(config.daemonUrl),
        headersHelper: `codeoid mcp headers --scopes ${scopeArg}`,
      },
    },
  };
}
