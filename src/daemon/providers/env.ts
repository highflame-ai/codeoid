/**
 * Subprocess environment allowlists (GHSA-38vh vector 3).
 *
 * The daemon's own environment carries codeoid secrets — the ZeroID root
 * key, OAuth HMAC, Telegram bot token — that an agent subprocess (which
 * runs model-directed code by design) must never see. Every provider
 * subprocess therefore gets a BUILT environment: shared safe basics plus a
 * provider-specific policy for its credentials, never a blanket inherit.
 *
 * Escape hatch: `CODEOID_AGENT_ENV_ALLOW=NAME1,NAME2` passes extra exact
 * names through to any provider subprocess (documented per provider).
 */

/**
 * The daemon's OWN namespaces — denied even when a policy's prefix/suffix
 * pattern would match (e.g. `CODEOID_API_KEY`, the ZeroID root key, ends in
 * `_API_KEY` and must never ride pi's credential-suffix rule). Only the
 * explicit `CODEOID_AGENT_ENV_ALLOW` escape hatch overrides this — leaking
 * the root key must require a deliberate operator action, never a pattern
 * accident.
 */
const DENY_PREFIXES = ["CODEOID_", "ZEROID_", "TELEGRAM_"] as const;

/** Safe basics every agent subprocess needs — nothing secret-bearing. */
const SHARED_EXACT = [
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "PWD", "LANG", "LANGUAGE",
  "TZ", "TERM", "TMPDIR", "TEMP", "TMP", "COLORTERM",
  // Proxy + TLS trust — needed to reach provider APIs through a corporate
  // proxy / custom CA. Not secrets.
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
  "http_proxy", "https_proxy", "all_proxy", "no_proxy",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
] as const;

export interface SubprocessEnvPolicy {
  /** Exact names to pass through (in addition to the shared basics). */
  exact?: readonly string[];
  /** Name prefixes to pass through (e.g. "ANTHROPIC_"). */
  prefixes?: readonly string[];
  /** Name suffixes to pass through (e.g. "_API_KEY"). */
  suffixes?: readonly string[];
}

/**
 * Build a subprocess environment from `base` (default `process.env`)
 * according to `policy` + the shared basics + the
 * `CODEOID_AGENT_ENV_ALLOW` escape hatch.
 */
export function buildSubprocessEnv(
  policy: SubprocessEnvPolicy,
  base: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const exact = new Set<string>([...SHARED_EXACT, ...(policy.exact ?? [])]);
  const prefixes = policy.prefixes ?? [];
  const suffixes = policy.suffixes ?? [];
  const operatorAllowed = new Set<string>();
  for (const name of (base.CODEOID_AGENT_ENV_ALLOW ?? "").split(",")) {
    const trimmed = name.trim();
    if (trimmed.length > 0) operatorAllowed.add(trimmed);
  }

  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    // Explicit operator opt-in wins over everything.
    if (operatorAllowed.has(k)) {
      out[k] = v;
      continue;
    }
    // Daemon-owned namespaces are denied even when a pattern matches.
    if (DENY_PREFIXES.some((p) => k.startsWith(p))) continue;
    if (
      exact.has(k) ||
      prefixes.some((p) => k.startsWith(p)) ||
      suffixes.some((s) => k.endsWith(s))
    ) {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Environment for the `pi --mode rpc` subprocess.
 *
 * pi's primary credential store is `~/.pi/agent/auth.json` (HOME is in the
 * shared basics), but its ~60 providers also read env keys. Enumerating
 * every provider's variable is unmaintainable, so the policy is:
 * conventional credential shapes (`*_API_KEY` / `*_API_TOKEN`), the major
 * provider namespaces, pi's own namespace, and POSIX locale categories.
 * Anything else (e.g. `AWS_*` for Bedrock) goes through
 * `CODEOID_AGENT_ENV_ALLOW`.
 */
export function buildPiEnv(
  base: Record<string, string | undefined> = process.env,
): Record<string, string> {
  return buildSubprocessEnv(
    {
      prefixes: ["PI_", "LC_", "ANTHROPIC_", "OPENAI_", "GOOGLE_", "GEMINI_"],
      suffixes: ["_API_KEY", "_API_TOKEN"],
    },
    base,
  );
}

/**
 * Environment for the `codex app-server` subprocess.
 *
 * codex's primary credential store is `~/.codex/auth.json` (HOME is in the
 * shared basics — ChatGPT-subscription tokens never transit codeoid), with
 * env-key fallbacks for API-key users. Same posture as pi: conventional
 * credential shapes plus codex's own namespace; anything exotic goes
 * through `CODEOID_AGENT_ENV_ALLOW`.
 */
export function buildCodexEnv(
  base: Record<string, string | undefined> = process.env,
): Record<string, string> {
  return buildSubprocessEnv(
    {
      prefixes: ["CODEX_", "OPENAI_", "LC_"],
      suffixes: ["_API_KEY"],
    },
    base,
  );
}

/**
 * Environment for the `gemini --acp` subprocess.
 *
 * gemini-cli's primary credential store is `~/.gemini` (HOME is in the
 * shared basics — Google-account OAuth never transits codeoid), with env
 * fallbacks for API-key users (GEMINI_API_KEY / GOOGLE_* for Vertex).
 */
export function buildGeminiCliEnv(
  base: Record<string, string | undefined> = process.env,
): Record<string, string> {
  return buildSubprocessEnv(
    {
      prefixes: ["GEMINI_", "GOOGLE_", "LC_"],
      suffixes: ["_API_KEY"],
    },
    base,
  );
}

/** The qwen-code allowlist policy — shared by the builder and its tests. */
const QWEN_ENV_POLICY: SubprocessEnvPolicy = {
  // The CLI's own namespaces: OPENAI_* is its OpenAI-compatible auth path
  // (key + base URL + model), QWEN_* its own config/runtime namespace,
  // DASHSCOPE_* the Alibaba Model Studio key. Plus POSIX locale categories.
  prefixes: ["OPENAI_", "QWEN_", "DASHSCOPE_", "LC_"],
  suffixes: ["_API_KEY"],
};

/**
 * Environment for the qwen-code CLI the `@qwen-code/sdk` spawns.
 *
 * qwen-code's subscription credential store is `~/.qwen/oauth_creds.json`
 * (HOME is in the shared basics — qwen.ai OAuth never transits codeoid),
 * with env fallbacks for the API-key path (`OPENAI_API_KEY` +
 * `OPENAI_BASE_URL` + `OPENAI_MODEL`, or `DASHSCOPE_API_KEY`).
 *
 * SECURITY — why this returns MORE than an allowlist. Unlike the Claude
 * Agent SDK (which replaces the child env outright), `@qwen-code/sdk` spawns
 * with `{ ...process.env, ...options.env }`. A plain allowlist would
 * therefore be a no-op: everything we left out is still inherited, including
 * the secrets `loadDotEnv` puts in the daemon's env (`CODEOID_API_KEY` = the
 * root ZeroID key, `TELEGRAM_BOT_TOKEN`, provider keys). Since a merge can
 * only add or override keys — never delete them — we explicitly map every
 * non-allowlisted name in `base` to the empty string. After the SDK's merge
 * the child sees exactly the allowlist, and every daemon secret reads as
 * empty rather than leaking to the agent's Bash tool or stdio MCP servers.
 *
 * Pure + exported for unit testing.
 */
export function buildQwenEnv(
  base: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const allowed = buildSubprocessEnv(QWEN_ENV_POLICY, base);
  const out: Record<string, string> = { ...allowed };
  for (const name of Object.keys(base)) {
    if (!(name in allowed)) out[name] = "";
  }
  return out;
}
