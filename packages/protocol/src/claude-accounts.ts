/**
 * Claude accounts: several Claude credentials on one daemon — a personal
 * Pro/Max subscription, a company one, a company gateway per workspace — with
 * a daemon default and a per-session choice, switchable mid-session.
 *
 * WHY. Every Claude session used whatever single credential the daemon had
 * (`claude login`, or `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` in
 * `~/.codeoid/.env`). Someone with a personal and a company subscription, or a
 * gateway token per workspace, had to edit the daemon's environment and
 * restart it to move between them, and could not run two sessions on two
 * accounts at once.
 *
 * HOW IT STAYS ONE CONVERSATION. An account is only the credential a session's
 * Claude subprocess is started with. Claude keeps its session transcripts as
 * local files in one config directory, not per account, so switching a
 * session's account restarts its query with the new credential and RESUMES the
 * same Claude session — the conversation continues. (The first turn after a
 * switch re-reads the context at full price: prompt caching is per
 * organization.)
 *
 * SECRETS. Tokens are stored by the daemon (0600) and never sent to a client;
 * a client sees names, kinds, and a gateway's URL and header names only.
 */

// ── Shared types ─────────────────────────────────────────────────────────────

/**
 * - `subscription`: a Claude Pro/Max subscription token (`claude setup-token`,
 *   `sk-ant-oat01-…`), run as `CLAUDE_CODE_OAUTH_TOKEN`.
 * - `gateway`: an Anthropic-compatible gateway — a base URL plus its token
 *   (`ANTHROPIC_AUTH_TOKEN`), optionally extra headers (a workspace header).
 * - `api-key`: an Anthropic API key (`ANTHROPIC_API_KEY`).
 */
export type ClaudeAccountKind = "subscription" | "gateway" | "api-key";

/** The built-in account: the daemon's own environment / `claude login`. Not stored, not removable. */
export const CLAUDE_DEFAULT_ACCOUNT = "default";

/** What a client may see of an account — never its token or header values. */
export interface ClaudeAccountInfo {
  name: string;
  kind: ClaudeAccountKind;
  /** Gateway only. */
  baseUrl?: string;
  /** Gateway only: names of the extra headers sent (values are secret). */
  headerNames?: string[];
  createdAt: string;
  updatedAt: string;
}

// ── Messages (client → daemon) ────────────────────────────────────────────────

/** List accounts and the daemon default. Scope: `settings:read`. */
export interface ClaudeAccountsListMsg {
  type: "claude.accounts.list";
  id: string;
}

/**
 * Add or replace a named account. Scope: `settings:write`. `token` is
 * required; a `subscription` token comes more safely from
 * `backend.login.start` with `account` set (the daemon runs `claude
 * setup-token` and stores what it mints).
 */
export interface ClaudeAccountsSetMsg {
  type: "claude.accounts.set";
  id: string;
  name: string;
  kind: ClaudeAccountKind;
  token: string;
  /** Required for `gateway`; rejected otherwise. */
  baseUrl?: string;
  /** `gateway` only: extra request headers, e.g. a workspace id header. */
  headers?: Record<string, string>;
}

/** Remove a named account. Scope: `settings:write`. Sessions using it then refuse to run until switched. */
export interface ClaudeAccountsRemoveMsg {
  type: "claude.accounts.remove";
  id: string;
  name: string;
}

/**
 * Set the daemon default — the account every session that hasn't chosen its
 * own runs on, from its next turn. `default` returns to the daemon's own
 * environment. Scope: `settings:write`.
 */
export interface ClaudeAccountsSetDefaultMsg {
  type: "claude.accounts.set_default";
  id: string;
  name: string;
}

/**
 * Choose the account a session runs on, from its next turn; `null` follows
 * the daemon default, a literal `default` pins the built-in account. The
 * session's conversation is resumed, not restarted. Scope: `settings:write` —
 * it decides whose credential the agent runs on, bills, and is sent the
 * conversation. (So does `claudeAccount` on `session.create`, and forking a
 * session that has an account of its own.)
 */
export interface SessionSetClaudeAccountMsg {
  type: "session.set_claude_account";
  id: string;
  sessionId: string;
  account: string | null;
}

// ── Messages (daemon → client) ────────────────────────────────────────────────

export interface ClaudeAccountsResultMsg {
  type: "claude.accounts.result";
  requestId: string;
  accounts: ClaudeAccountInfo[];
  /** The daemon default's name — `default` when none is set. */
  defaultAccount: string;
}
