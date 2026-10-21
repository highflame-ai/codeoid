/**
 * Interactive backend sign-in — the wire contract for logging a backend in from
 * a codeoid client, instead of pasting a provider API key.
 *
 * WHY THIS EXISTS. Every backend codeoid runs already has a first-party login
 * that mints a subscription credential — `claude setup-token`, `codex login`,
 * qwen's OAuth. Each one is an interactive terminal command, so using it meant
 * having a shell on the machine the daemon runs on. When codeoid IS the whole
 * surface (a hosted sandbox, a phone), nobody does, and an API key was the only
 * way in. That is the gap: not that login is impossible, but that it was
 * unreachable from the only UI the user has.
 *
 * The daemon BROKERS the vendor's own command; it never reimplements the
 * vendor's OAuth. That distinction is the whole design. Scraping a client id out
 * of someone else's CLI and driving their token endpoint ourselves would work
 * right up until they change it, and would put us in the business of
 * maintaining another company's auth. Running the command they ship means their
 * flow changes under us and keeps working.
 *
 * Two steps, because that is the shape the vendors' commands already use:
 *
 *   1. `backend.login.start` — the daemon runs the login command and returns the
 *      authorize URL it prints. The user opens that URL in THEIR browser; the
 *      daemon never needs one, which is what makes this work headless.
 *   2. `backend.login.submit` — the vendor's callback page displays a code. The
 *      user pastes it back, the daemon hands it to the still-waiting command,
 *      and the credential the command produces is stored exactly like any other
 *      secret (`~/.codeoid/.env`, 0600) so the rest of codeoid needs no
 *      special case for it.
 *
 * A submitted code and the resulting credential are never echoed back to a
 * client and never logged.
 */

import type { SettingsSnapshot } from "./settings.js";

/**
 * Backends with an interactive login wired end to end.
 *
 * Deliberately narrower than the backend catalog: a backend appears here only
 * once its login command is driven and tested, so a client can offer "Sign in"
 * without first asking the daemon whether it would work. Adding one is an entry
 * here plus a flow in the daemon's broker.
 */
export type LoginBackend = "claude" | "codex";

/** Runtime companion to {@link LoginBackend} — what a client renders a button for. */
export const LOGIN_CAPABLE_BACKENDS: readonly LoginBackend[] = ["claude", "codex"] as const;

/**
 * Backends whose sign-in only creates a NAMED account (accounts.ts) — there is
 * no daemon-wide login of theirs to replace. A client offers their sign-in
 * under Accounts, never as the daemon's own login.
 */
export const LOGIN_ACCOUNT_ONLY_BACKENDS: readonly LoginBackend[] = ["codex"] as const;

/** A login the daemon has started and is holding open, waiting for a code. */
export interface PendingBackendLogin {
  /** Opaque handle for the in-flight attempt; required to submit or cancel. */
  loginId: string;
  backend: LoginBackend;
  /** The vendor URL the user opens in their OWN browser to approve. */
  verificationUrl: string;
  /** Epoch ms after which the daemon abandons the attempt and kills the command. */
  expiresAt: number;
  /** One line naming what the user does next — wording is vendor-specific. */
  codeHint: string;
  /**
   * `code` (default when absent): the vendor's page shows a code the user
   * pastes back with `backend.login.submit`. `device`: the user enters
   * {@link userCode} on the vendor's page and the login finishes on its own —
   * the client calls `backend.login.wait`.
   */
  mode?: "code" | "device";
  /** `device` only: the one-time code to enter on the vendor's page. Not a credential. */
  userCode?: string;
}

// ── Messages (client → daemon) ────────────────────────────────────────────────

/**
 * Begin an interactive login. Resolves only once the vendor command has printed
 * its authorize URL, so a client gets a URL or an error — never a handle to an
 * attempt it cannot show the user. Starting a login supersedes any attempt
 * already in flight for that backend (a reloaded page must not be locked out by
 * its own abandoned attempt).
 */
export interface BackendLoginStartMsg {
  type: "backend.login.start";
  id: string;
  backend: LoginBackend;
  /**
   * Store the resulting credential as this named account of `backend`
   * (accounts.ts) instead of the daemon's own login. The login runs against a
   * staging home so it can never replace the machine's own login. Required
   * for every backend but `claude`.
   */
  account?: string;
  /** Replace an existing account of that name (refused otherwise). */
  replace?: boolean;
}

/**
 * Hand the vendor's code to the waiting command and wait for the exchange.
 * Terminal either way: on failure the attempt is finished and the client must
 * start a new one, because the command's own retry loop is not reachable
 * through this protocol.
 */
export interface BackendLoginSubmitMsg {
  type: "backend.login.submit";
  id: string;
  loginId: string;
  /** The code the vendor's callback page displayed. Never logged or echoed. */
  code: string;
}

/**
 * Wait for a `device` login to finish (the user approved on the vendor's
 * page) or fail. Terminal either way, like `submit`. Safe to send again — a
 * client that lost its connection while waiting re-sends it and gets the same
 * outcome (for a while after it finished), never a second sign-in.
 */
export interface BackendLoginWaitMsg {
  type: "backend.login.wait";
  id: string;
  loginId: string;
}

/** Abandon an in-flight attempt and kill the command. Idempotent. */
export interface BackendLoginCancelMsg {
  type: "backend.login.cancel";
  id: string;
  loginId: string;
}

// ── Messages (daemon → client) ────────────────────────────────────────────────

export interface BackendLoginStartResultMsg {
  type: "backend.login.start.result";
  requestId: string;
  login: PendingBackendLogin;
}

export interface BackendLoginSubmitResultMsg {
  type: "backend.login.submit.result";
  requestId: string;
  ok: boolean;
  /**
   * Why it failed, safe to display — the vendor's own rejection, with anything
   * credential-shaped stripped. Absent when `ok`.
   */
  error?: string;
  /**
   * The attempt is still open: the code was refused before it reached the
   * command (malformed), so a corrected code can be submitted to it. Any
   * other failure ends the attempt — start again.
   */
  retryable?: boolean;
  /**
   * Settings AFTER the write, so the drawer reflects the new credential without
   * a second round trip. The stored secret shows as set; its value never moves.
   */
  snapshot: SettingsSnapshot;
}

/** Same outcome as a submit, for a `device` login. */
export interface BackendLoginWaitResultMsg extends Omit<BackendLoginSubmitResultMsg, "type"> {
  type: "backend.login.wait.result";
}

export interface BackendLoginCancelResultMsg {
  type: "backend.login.cancel.result";
  requestId: string;
  ok: boolean;
}
