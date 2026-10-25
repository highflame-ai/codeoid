/**
 * Terminal helpers for OpenAI-compatible endpoints (protocol: endpoints.ts):
 * rendering, `--model` flag parsing, and importing pi's `models.json`.
 * Pure — no I/O beyond what the caller passes in — so it is testable.
 */

import type { EndpointInfo, EndpointModel, EndpointsSetMsg } from "../protocol/types.js";

/** The endpoint list for `codeoid endpoint ls`. */
export function formatEndpoints(endpoints: readonly EndpointInfo[]): string {
  if (endpoints.length === 0) {
    return "\n  No endpoints. Add one with: codeoid endpoint add <name> --base-url <url>\n";
  }
  const lines = ["", "  OpenAI-compatible endpoints (use as provider oai:<name>):", ""];
  for (const e of endpoints) {
    const title = e.displayName !== e.name ? `${e.name} (${e.displayName})` : e.name;
    lines.push(`  ${title}`);
    lines.push(`      ${e.baseUrl}  [${e.flavor}]  key: ${e.hasApiKey ? "set" : "none"}${e.headerNames.length ? `  headers: ${e.headerNames.join(", ")}` : ""}`);
    const models = e.models.length
      ? e.models.map((m) => `${m.id}${m.contextWindow ? ` (${formatTokens(m.contextWindow)})` : ""}`).join(", ")
      : "whatever the server lists";
    lines.push(`      models: ${models}${e.defaultModel ? `  default: ${e.defaultModel}` : ""}`);
    const mcp = e.mcpServers === "all" ? "all" : e.mcpServers.length ? e.mcpServers.join(", ") : "none";
    lines.push(`      MCP servers: ${mcp}${e.contextWindow ? `  context: ${formatTokens(e.contextWindow)}` : ""}`);
  }
  lines.push("");
  return lines.join("\n");
}

function formatTokens(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

/**
 * Parse a repeatable `--model id[:contextWindow[:maxTokens]]`. The context
 * window takes a `k` suffix (`qwen3-coder:128k`). A model id may itself hold
 * colons (`llama3.1:8b` in Ollama), so the optional numbers are read from the
 * END: only trailing all-numeric segments count.
 */
export function parseModelFlags(flags: readonly string[]): EndpointModel[] {
  return flags.map((raw) => {
    const parts = raw.split(":");
    const nums: number[] = [];
    while (parts.length > 1 && nums.length < 2 && /^\d+k?$/i.test(parts[parts.length - 1]!)) {
      nums.unshift(parseTokens(parts.pop()!));
    }
    const id = parts.join(":");
    if (!id) throw new Error(`--model takes id[:contextWindow[:maxTokens]], got ${JSON.stringify(raw)}`);
    return {
      id,
      ...(nums[0] !== undefined ? { contextWindow: nums[0] } : {}),
      ...(nums[1] !== undefined ? { maxTokens: nums[1] } : {}),
    };
  });
}

/** `128k` → 128000 (tokens, decimal k as model cards use). */
export function parseTokens(s: string): number {
  const m = /^(\d+)(k?)$/i.exec(s.trim());
  if (!m) throw new Error(`not a token count: ${JSON.stringify(s)}`);
  return Number(m[1]) * (m[2] ? 1000 : 1);
}

// ── pi models.json import ─────────────────────────────────────────────────────

/** One endpoint read from pi's `models.json`, ready to send, plus what didn't carry over. */
export interface PiImportEntry {
  endpoint: Omit<EndpointsSetMsg, "type" | "id">;
  warnings: string[];
}

export interface PiImportResult {
  entries: PiImportEntry[];
  /** Providers left out entirely, with why. */
  skipped: Array<{ provider: string; reason: string }>;
}

interface PiProvider {
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  api?: string;
  headers?: Record<string, string>;
  compat?: { supportsUsageInStreaming?: boolean; maxTokensField?: string };
  models?: Array<{ id?: string; name?: string; contextWindow?: number; maxTokens?: number; api?: string }>;
}

/**
 * Resolve a pi config value: `$VAR` / `${VAR}` interpolate the environment
 * (pi's rule, also inside larger strings), `$$` is a literal `$`, anything
 * else is a literal. A `!command` value is NOT run — importing must not
 * execute commands from a config file — and is reported instead.
 */
export function resolvePiValue(
  value: string,
  env: Record<string, string | undefined>,
): { value?: string; problem?: string } {
  if (value.startsWith("!")) return { problem: "is a shell command (!…), which codeoid doesn't run — set it by hand" };
  let missing: string | undefined;
  const out = value.replace(/\$\$|\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (m, braced?: string, bare?: string) => {
    if (m === "$$") return "$";
    const name = braced ?? bare!;
    const v = env[name];
    if (v === undefined) missing ??= name;
    return v ?? "";
  });
  if (missing) return { problem: `uses $${missing}, which isn't set in this shell` };
  return { value: out };
}

/** A pi provider key as an endpoint name: lowercase, dashes, ≤40 chars. */
export function piNameToEndpointName(key: string): string {
  return key
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "pi";
}

/**
 * The OpenAI-compatible providers in a pi `models.json`, as endpoints. Only
 * `api: "openai-completions"` providers (or ones whose models all are) carry
 * over — codeoid's endpoint backend speaks Chat Completions; Responses,
 * Anthropic and Google providers are reported as skipped.
 */
export function importPiModels(json: unknown, env: Record<string, string | undefined>): PiImportResult {
  const result: PiImportResult = { entries: [], skipped: [] };
  const providers = (json as { providers?: Record<string, PiProvider> } | null)?.providers;
  if (!providers || typeof providers !== "object") return result;
  for (const [key, p] of Object.entries(providers)) {
    if (!p || typeof p !== "object") continue;
    const modelApis = (p.models ?? []).map((m) => m.api ?? p.api);
    const api = p.api ?? modelApis[0];
    if (api !== "openai-completions" || modelApis.some((a) => a !== undefined && a !== "openai-completions")) {
      result.skipped.push({ provider: key, reason: `api ${JSON.stringify(api ?? "unset")} — only openai-completions providers carry over` });
      continue;
    }
    if (!p.baseUrl) {
      result.skipped.push({ provider: key, reason: "no baseUrl (a built-in provider override)" });
      continue;
    }
    const name = piNameToEndpointName(key);
    // Two pi providers can map to one endpoint name ("My GPU" / "my-gpu"):
    // the second would silently overwrite the first.
    const clash = result.entries.find((e) => e.endpoint.name === name);
    if (clash) {
      result.skipped.push({ provider: key, reason: `its endpoint name "${name}" is already taken by another provider in this file` });
      continue;
    }
    const warnings: string[] = [];
    // Explicit: null = no key, {} = no headers, so `--replace` replaces them
    // too. Left out only when pi's value didn't resolve (then a stored one is
    // kept — on the same server only, which the daemon enforces).
    let apiKey: string | null | undefined = null;
    if (p.apiKey) {
      const r = resolvePiValue(p.apiKey, env);
      if (r.problem) {
        warnings.push(`apiKey ${r.problem}`);
        apiKey = undefined;
      } else apiKey = r.value || null;
    }
    let headers: Record<string, string> | undefined = {};
    for (const [h, v] of Object.entries(p.headers ?? {})) {
      const r = resolvePiValue(String(v), env);
      if (r.problem) warnings.push(`header ${h} ${r.problem}`);
      else if (headers) headers[h] = r.value!;
      if (r.problem) headers = undefined;
    }
    const models: EndpointModel[] = [];
    for (const m of p.models ?? []) {
      if (!m?.id) continue;
      models.push({
        id: m.id,
        ...(m.name && m.name !== m.id ? { name: m.name } : {}),
        ...(typeof m.contextWindow === "number" && m.contextWindow > 0 ? { contextWindow: Math.round(m.contextWindow) } : {}),
        ...(typeof m.maxTokens === "number" && m.maxTokens > 0 ? { maxTokens: Math.round(m.maxTokens) } : {}),
      });
    }
    result.entries.push({
      endpoint: {
        name,
        ...(p.name || key !== name ? { displayName: p.name || key } : {}),
        baseUrl: p.baseUrl,
        // A keyless local server in pi still carries a dummy key; harmless here.
        ...(apiKey !== undefined ? { apiKey } : {}),
        ...(headers !== undefined ? { headers } : {}),
        models,
        ...(p.compat?.supportsUsageInStreaming === false ? { streamUsage: false } : {}),
        ...(p.compat?.maxTokensField === "max_completion_tokens" || p.compat?.maxTokensField === "max_tokens"
          ? { maxTokensField: p.compat.maxTokensField }
          : {}),
      },
      warnings,
    });
  }
  return result;
}
