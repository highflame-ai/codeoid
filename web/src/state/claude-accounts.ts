/**
 * Claude accounts — client half (protocol: claude-accounts.ts).
 *
 * The daemon holds several Claude credentials (subscriptions, gateway tokens,
 * API keys); this module lists them, changes them, puts a session on one, and
 * runs the sign-in for a named subscription. Every list-changing call answers
 * with the full `claude.accounts.result`, which simply replaces the state.
 *
 * Tokens only ever travel client → daemon (a typed token, a sign-in code);
 * nothing here stores one, and the daemon never sends one back.
 */

import { createSignal } from "solid-js";

import { getClient, newRequestId, request } from "./connection";
import { mergeFullSessionInfo } from "./sessions";
import type {
  BackendLoginStartResultMsg,
  BackendLoginSubmitResultMsg,
  ClaudeAccountInfo,
  ClaudeAccountKind,
  ClaudeAccountsResultMsg,
  ClientMessage,
  PendingBackendLogin,
  SessionInfo,
} from "../protocol/types";

/** The built-in account: the daemon's own environment / `claude login`. */
export const DEFAULT_ACCOUNT = "default";

interface State {
  loaded: boolean;
  loading: boolean;
  accounts: ClaudeAccountInfo[];
  defaultAccount: string;
  /** Last list/change failure, for the panel. */
  error: string | null;
}

const EMPTY: State = { loaded: false, loading: false, accounts: [], defaultAccount: DEFAULT_ACCOUNT, error: null };
const [state, setState] = createSignal<State>(EMPTY);

export const claudeAccountsState = state;

export function _resetClaudeAccountsForTest(): void {
  setState(EMPTY);
  attempt++;
  setLogin(LOGIN_EMPTY);
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function apply(res: ClaudeAccountsResultMsg): void {
  setState({ loaded: true, loading: false, accounts: res.accounts, defaultAccount: res.defaultAccount, error: null });
}

/** Send an account message whose answer is the full list. Throws with the daemon's message. */
async function accountsCall(build: (id: string) => ClientMessage): Promise<void> {
  const id = newRequestId();
  const res = await getClient().request<ClaudeAccountsResultMsg>(build(id), {
    waitForResult: (m) => (m.type === "claude.accounts.result" && m.requestId === id ? m : undefined),
  });
  apply(res);
}

/**
 * Fetch the list (settings:read). A token without the scope gets an error,
 * which the pickers treat as "no named accounts" — they stay hidden. A failure
 * leaves the list unloaded, so the next caller (or a reconnect) tries again.
 */
export async function fetchClaudeAccounts(force = false): Promise<void> {
  if (state().loading || (state().loaded && !force)) return;
  setState((s) => ({ ...s, loading: true }));
  try {
    await accountsCall((id) => ({ type: "claude.accounts.list", id }));
  } catch (e) {
    setState((s) => ({ ...s, loading: false, error: errText(e) }));
  }
}

/**
 * On (re)connect: refetch a list someone has already asked for — accounts
 * may have changed while we were away, and a fetch that failed with the
 * socket deserves another try. Nothing asked yet = nothing to do.
 */
export function refreshClaudeAccountsOnConnect(): void {
  const s = state();
  if (s.loaded || s.error) void fetchClaudeAccounts(true);
}

export async function addGatewayAccount(input: {
  name: string;
  token: string;
  baseUrl: string;
  headers?: Record<string, string>;
}): Promise<void> {
  await accountsCall((id) => ({
    type: "claude.accounts.set",
    id,
    name: input.name,
    kind: "gateway",
    token: input.token,
    baseUrl: input.baseUrl,
    ...(input.headers && Object.keys(input.headers).length > 0 ? { headers: input.headers } : {}),
  }));
}

export async function addTokenAccount(input: { name: string; token: string; kind: Exclude<ClaudeAccountKind, "gateway"> }): Promise<void> {
  await accountsCall((id) => ({ type: "claude.accounts.set", id, name: input.name, kind: input.kind, token: input.token }));
}

export async function removeClaudeAccount(name: string): Promise<void> {
  await accountsCall((id) => ({ type: "claude.accounts.remove", id, name }));
}

export async function setDefaultClaudeAccount(name: string): Promise<void> {
  await accountsCall((id) => ({ type: "claude.accounts.set_default", id, name }));
}

/**
 * Put a session on an account: a name, `default` (pin the built-in), or null
 * (follow the daemon default). Resolves with the updated session, already
 * merged into the store.
 */
export async function setSessionClaudeAccount(sessionId: string, account: string | null): Promise<SessionInfo | undefined> {
  const res = await request({ type: "session.set_claude_account", id: newRequestId(), sessionId, account });
  const info = (res as { data?: SessionInfo }).data;
  if (info) mergeFullSessionInfo(info);
  return info;
}

/** Same rule the daemon enforces — checked client-side for an immediate message. */
export function accountNameProblem(name: string): string | null {
  if (!name) return "a name is required";
  if (name === DEFAULT_ACCOUNT) return '"default" is the built-in account';
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(name)) return "1–40 lowercase letters, digits and dashes, starting with a letter or digit";
  return null;
}

/** Is `name` an account already in the list? Adding under it replaces the whole account. */
export function accountNameTaken(name: string): boolean {
  return state().accounts.some((a) => a.name === name);
}

/**
 * `accountNameProblem`, plus: a taken name needs `replace`. The daemon swaps
 * the whole credential under that name, moving every session on it — right
 * for renewing an expired sign-in, never as a silent side effect of a name.
 */
export function newAccountNameProblem(name: string, replace = false): string | null {
  const p = accountNameProblem(name);
  if (p) return p;
  if (!replace && accountNameTaken(name)) return `an account named "${name}" already exists — tick "Replace" to overwrite it`;
  return null;
}

/** An effective-account label the daemon marks as missing (`<name> (missing)`). */
export function isMissingAccount(effective: string | undefined): boolean {
  return !!effective && effective.endsWith(" (missing)");
}

// ── Sign-in for a named subscription ─────────────────────────────────────────

export type AccountLoginPhase = "idle" | "starting" | "awaiting_code" | "submitting";

interface LoginState {
  account: string | null;
  phase: AccountLoginPhase;
  login: PendingBackendLogin | null;
  error: string | null;
}

const LOGIN_EMPTY: LoginState = { account: null, phase: "idle", login: null, error: null };
const [login, setLogin] = createSignal<LoginState>(LOGIN_EMPTY);
/**
 * Bumped by every start, cancel and dismiss: a reply that lands after its
 * attempt was abandoned (Cancel during "Starting…") must not bring it back.
 */
let attempt = 0;

export const accountLoginState = login;

/**
 * Start `claude setup-token` for account `name` — isolated on the daemon, so
 * it never touches the machine's own `claude login`. Resolves once there is a
 * URL to show.
 */
export async function startAccountLogin(name: string): Promise<void> {
  const mine = ++attempt;
  setLogin({ account: name, phase: "starting", login: null, error: null });
  try {
    const id = newRequestId();
    const res = await getClient().request<BackendLoginStartResultMsg>(
      { type: "backend.login.start", id, backend: "claude", account: name },
      {
        waitForResult: (m) => (m.type === "backend.login.start.result" && m.requestId === id ? m : undefined),
        timeoutMs: 60_000,
      },
    );
    if (mine !== attempt) {
      // Cancelled while starting: the daemon's attempt is live, so end it.
      void sendLoginCancel(res.login.loginId);
      return;
    }
    setLogin({ account: name, phase: "awaiting_code", login: res.login, error: null });
  } catch (e) {
    if (mine === attempt) setLogin({ account: name, phase: "idle", login: null, error: errText(e) });
  }
}

/** Hand the vendor's code to the daemon. The code is never kept here. */
export async function submitAccountLoginCode(code: string): Promise<boolean> {
  const cur = login();
  if (!cur.login) return false;
  const loginId = cur.login.loginId;
  const mine = attempt;
  setLogin((s) => ({ ...s, phase: "submitting", error: null }));
  try {
    const id = newRequestId();
    const res = await getClient().request<BackendLoginSubmitResultMsg>(
      { type: "backend.login.submit", id, loginId, code },
      {
        waitForResult: (m) => (m.type === "backend.login.submit.result" && m.requestId === id ? m : undefined),
        timeoutMs: 120_000,
      },
    );
    if (mine !== attempt) return res.ok;
    if (!res.ok) {
      // A malformed code leaves the daemon's attempt open: let the user retry.
      setLogin((s) => ({ ...s, phase: "awaiting_code", error: res.error ?? "Sign-in failed." }));
      return false;
    }
    // Back to idle, so the next sign-in starts from a fresh form.
    attempt++;
    setLogin(LOGIN_EMPTY);
    await fetchClaudeAccounts(true);
    return true;
  } catch (e) {
    if (mine === attempt) setLogin((s) => ({ ...s, phase: "awaiting_code", error: errText(e) }));
    return false;
  }
}

export async function cancelAccountLogin(): Promise<void> {
  const cur = login();
  attempt++;
  setLogin(LOGIN_EMPTY);
  if (cur.login) await sendLoginCancel(cur.login.loginId);
}

async function sendLoginCancel(loginId: string): Promise<void> {
  try {
    const id = newRequestId();
    await getClient().request(
      { type: "backend.login.cancel", id, loginId },
      { waitForResult: (m) => (m.type === "backend.login.cancel.result" && m.requestId === id ? m : undefined) },
    );
  } catch {
    /* the attempt expires on its own */
  }
}

export function dismissAccountLogin(): void {
  attempt++;
  setLogin(LOGIN_EMPTY);
}
