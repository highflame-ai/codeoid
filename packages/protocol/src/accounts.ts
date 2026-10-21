/**
 * Accounts for every backend: several named credentials per backend, a daemon
 * default per backend, and a per-session choice, switchable mid-session
 * (docs/backend-accounts-design.md).
 *
 * WHY. A session can already move between backends and keep its conversation;
 * this lets it move between CREDENTIALS of one backend the same way — two
 * ChatGPT accounts on Codex, a team and a personal Qwen key, a second key for
 * a local endpoint — and lets two sessions run on two accounts at once.
 *
 * WHAT AN ACCOUNT IS. Only the credential. The vendor's config, MCP servers,
 * skills and native transcripts stay shared, so a switched session resumes the
 * same conversation. An account belongs to exactly one backend: a credential
 * entered for Codex is never offered to, or sent by, another backend.
 *
 * Supersedes the Claude-only accounts (claude-accounts.ts), whose messages
 * remain as the `claude` backend's view.
 *
 * SECRETS. Tokens, key variables and header values are write-only: stored by
 * the daemon (0600), never sent to a client, logged or audited.
 */

/**
 * The built-in account every backend has: the daemon's own environment or
 * login — what ran before accounts existed. Not stored, not removable.
 */
export const DEFAULT_ACCOUNT = "default";

/**
 * Every kind of credential, across backends. Which kinds a backend accepts is
 * {@link accountKindsFor}.
 *
 * - `subscription` (claude): a Pro/Max token (`claude setup-token`).
 * - `gateway` (claude): an Anthropic-compatible gateway — base URL, token, headers.
 * - `api-key`: the backend's API key (and, for an endpoint, optional headers).
 * - `chatgpt-login` (codex): a ChatGPT sign-in, kept in the account's own Codex home.
 * - `api-keys` (pi): a set of model-provider key variables pi reads.
 * - `bedrock` (claude): Amazon Bedrock with a bearer token — AWS directly, or
 *   a Bedrock-compatible endpoint — plus the model mappings and settings that
 *   go with it.
 */
export type AccountKind = "subscription" | "gateway" | "api-key" | "chatgpt-login" | "api-keys" | "bedrock";

/** How a kind's credential is obtained when it isn't typed in. */
export type AccountLoginMode =
  /** Open a link, approve, paste back the code the page shows. */
  | "code"
  /** Open a link, enter the one-time code codeoid shows; the login finishes on its own. */
  | "device";

/** What a client needs to render the form for one kind — no per-backend code. */
export interface AccountKindInfo {
  kind: AccountKind;
  label: string;
  /** One line under the form. */
  hint?: string;
  /** The secret value field, when the kind takes one typed in. */
  token?: { label: string; required: boolean };
  /** A base URL field. `presets` are named shorthands the daemon expands. */
  baseUrl?: { label: string; required: boolean; presets?: Array<{ value: string; label: string }> };
  /** Extra request headers (values secret). */
  headers?: boolean;
  /**
   * Named variables, from this allowlist. `label`: what a form calls them
   * (default "Keys"). `required`: at least one must be set (default true).
   * `secret`: the names whose values are secrets (default: all); the rest are
   * plain settings a form may show as text.
   */
  env?: { names: string[]; label?: string; required?: boolean; secret?: string[] };
  /** Obtained by a brokered sign-in (`backend.login.*`) instead of typed in. */
  login?: AccountLoginMode;
}

/** What a client may see of an account — never a token, key or header value. */
export interface AccountInfo {
  backend: string;
  name: string;
  kind: AccountKind;
  /** Gateway / Qwen base URL, as entered (it is shown, so it never carries a credential). */
  baseUrl?: string;
  /** Names of the extra headers sent. */
  headerNames?: string[];
  /** Names of the key variables set (`api-keys`). */
  envNames?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface BackendAccountsInfo {
  backend: string;
  displayName: string;
  /** The daemon default's name — `default` when none is set. */
  defaultAccount: string;
  accounts: AccountInfo[];
  kinds: AccountKindInfo[];
}

// ── Kinds per backend ─────────────────────────────────────────────────────────

/** Qwen base URL presets (the daemon expands them; see the qwen provider). */
const QWEN_PRESETS = [
  { value: "dashscope-intl", label: "Model Studio (international)" },
  { value: "dashscope-cn", label: "Model Studio (China)" },
  { value: "bailian-plan-intl", label: "Coding Plan key (sk-sp-…)" },
];

/**
 * Settings a Bedrock account may carry beside its token: the region, the
 * Bedrock model IDs the Claude aliases map to (with their names, descriptions
 * and capabilities), the region prefix and service tier, the context window,
 * whether to skip AWS auth on an endpoint that wants it, and where telemetry
 * goes. Nothing that selects another credential.
 */
export const BEDROCK_SETTINGS = [
  "AWS_REGION",
  "ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION",
  "ANTHROPIC_BEDROCK_REGION_PREFIX",
  "ANTHROPIC_BEDROCK_SERVICE_TIER",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME",
  "ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION",
  "ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME",
  "ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION",
  "ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL_NAME",
  "ANTHROPIC_DEFAULT_FABLE_MODEL_DESCRIPTION",
  "ANTHROPIC_DEFAULT_FABLE_MODEL_SUPPORTED_CAPABILITIES",
  "CLAUDE_CODE_SKIP_BEDROCK_AUTH",
  "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
  "CLAUDE_CODE_ENABLE_TELEMETRY",
  "OTEL_METRICS_EXPORTER",
  "OTEL_LOGS_EXPORTER",
  "OTEL_EXPORTER_OTLP_PROTOCOL",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_HEADERS",
] as const;

/** Key variables a pi account may set — the model providers pi reads keys for. */
export const PI_KEY_VARIABLES = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "OPENROUTER_API_KEY",
  "GROQ_API_KEY",
  "XAI_API_KEY",
  "MISTRAL_API_KEY",
  "CEREBRAS_API_KEY",
  "DEEPSEEK_API_KEY",
  "ZAI_API_KEY",
] as const;

const KINDS: Record<string, AccountKindInfo[]> = {
  claude: [
    {
      kind: "subscription",
      label: "Pro/Max subscription",
      hint: "Sign in, or paste a token from `claude setup-token`.",
      token: { label: "Token (sk-ant-oat01-…)", required: true },
      login: "code",
    },
    {
      kind: "gateway",
      label: "Anthropic-compatible gateway",
      token: { label: "Gateway token", required: true },
      baseUrl: { label: "Base URL", required: true },
      headers: true,
    },
    { kind: "api-key", label: "Anthropic API key", token: { label: "API key", required: true } },
    {
      kind: "bedrock",
      label: "Amazon Bedrock",
      hint: "A Bedrock bearer token, for AWS directly or a Bedrock-compatible endpoint. Map the model aliases to the Bedrock model IDs it serves.",
      token: { label: "Bedrock bearer token (AWS_BEARER_TOKEN_BEDROCK)", required: true },
      baseUrl: { label: "Bedrock endpoint (blank = AWS)", required: false },
      env: { names: [...BEDROCK_SETTINGS], label: "Settings", required: false, secret: ["OTEL_EXPORTER_OTLP_HEADERS"] },
    },
  ],
  openai: [{ kind: "api-key", label: "OpenAI API key", token: { label: "API key", required: true } }],
  llamacpp: [{ kind: "api-key", label: "llama-server API key", token: { label: "API key", required: true } }],
  gemini: [{ kind: "api-key", label: "Gemini API key", token: { label: "API key", required: true } }],
  // API keys only: a consumer Google (AI Pro/Ultra) subscription can't be
  // used with codeoid (#192), so there is no Google sign-in kind.
  "gemini-cli": [{ kind: "api-key", label: "Gemini API key", token: { label: "API key", required: true } }],
  codex: [
    {
      kind: "chatgpt-login",
      label: "ChatGPT sign-in",
      hint: "Signs in with ChatGPT into this account only; enter the code shown here on the page.",
      login: "device",
    },
    { kind: "api-key", label: "OpenAI API key", token: { label: "API key", required: true } },
  ],
  qwen: [
    {
      kind: "api-key",
      label: "API key",
      hint: "A Model Studio / DashScope key, or a Coding Plan key (sk-sp-…) with its preset.",
      token: { label: "API key", required: true },
      baseUrl: { label: "Endpoint", required: true, presets: QWEN_PRESETS },
    },
  ],
  pi: [
    {
      kind: "api-keys",
      label: "Provider keys",
      hint: "The keys pi uses for its model providers; pi's own stored logins are not used for this account.",
      env: { names: [...PI_KEY_VARIABLES] },
    },
  ],
};

/** An OpenAI-compatible endpoint's accounts: another key and/or headers for the same server. */
const ENDPOINT_KINDS: AccountKindInfo[] = [
  {
    kind: "api-key",
    label: "Key and headers",
    hint: "Sent to this endpoint's server only; re-enter it if the endpoint moves to another server.",
    token: { label: "API key", required: false },
    headers: true,
  },
];

/** The kinds `backend` accepts; empty = the backend has no accounts. */
export function accountKindsFor(backend: string): AccountKindInfo[] {
  if (backend.startsWith("oai:")) return ENDPOINT_KINDS;
  return KINDS[backend] ?? [];
}

/** Does `backend` take accounts at all? */
export function backendHasAccounts(backend: string): boolean {
  return accountKindsFor(backend).length > 0;
}

// ── Messages (client → daemon) ────────────────────────────────────────────────

/** List accounts — one backend, or every backend that takes accounts. Scope: `settings:read`. */
export interface AccountsListMsg {
  type: "accounts.list";
  id: string;
  backend?: string;
}

/**
 * Add an account, or replace one with `replace: true` — an existing name is
 * refused otherwise, so a typo can't silently move every session on that
 * account to another credential. Scope: `settings:write`, undelegated.
 *
 * A login kind (`chatgpt-login`) comes from `backend.login.start`
 * with `account`; a `subscription` may also be pasted as `token`.
 */
export interface AccountsSetMsg {
  type: "accounts.set";
  id: string;
  backend: string;
  name: string;
  kind: AccountKind;
  token?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  replace?: boolean;
}

/** Remove an account (and its home). Sessions on it then refuse to run until switched. Scope: `settings:write`, undelegated. */
export interface AccountsRemoveMsg {
  type: "accounts.remove";
  id: string;
  backend: string;
  name: string;
}

/** Set `backend`'s daemon default — from their next turn for every session following it. Scope: `settings:write`, undelegated. */
export interface AccountsSetDefaultMsg {
  type: "accounts.set_default";
  id: string;
  backend: string;
  name: string;
}

/**
 * Choose the account a session runs on for `backend` (default: its current
 * backend), from its next turn; `null` follows that backend's daemon default,
 * a literal `default` pins the built-in one. The conversation continues.
 * Scope: `settings:write`, undelegated.
 */
export interface SessionSetAccountMsg {
  type: "session.set_account";
  id: string;
  sessionId: string;
  account: string | null;
  backend?: string;
}

// ── Messages (daemon → client) ────────────────────────────────────────────────

/**
 * Pushed when `backend`'s accounts or default changed (by any client, a
 * sign-in, or a hand edit of accounts.json), to every client that subscribed
 * to the backend list (`providers.list`). Names the backend only — a client
 * that may read accounts refetches them.
 */
export interface AccountsChangedMsg {
  type: "accounts.changed";
  backend: string;
}

export interface AccountsResultMsg {
  type: "accounts.result";
  requestId: string;
  backends: BackendAccountsInfo[];
}
