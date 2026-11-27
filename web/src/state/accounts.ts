/**
 * Accounts for every backend — client half (protocol: accounts.ts,
 * docs/backend-accounts-design.md).
 *
 * The daemon holds named credentials per backend (Claude subscriptions, a
 * second Codex sign-in, a team Qwen key, extra headers for an endpoint…);
 * this module lists them, changes them, puts a session on one, and runs the
 * brokered sign-in for the kinds that have one. Every list-changing call
 * answers with the full `accounts.result` for every backend, which simply
 * replaces the state — so there is one list, fetched whole.
 *
 * What a backend accepts comes from the daemon (`kinds`), so nothing here or
 * in the panels knows about a particular backend.
 *
 * Tokens only ever travel client → daemon (a typed key, a sign-in code);
 * nothing here stores one, and the daemon never sends one back.
 */

import { createSignal } from "solid-js";

import { connectionStatus, getClient, newRequestId, request, send } from "./connection";
import { mergeFullSessionInfo } from "./sessions";
import type {
  AccountInfo,
  AccountKind,
  AccountKindInfo,
  AccountsResultMsg,
  BackendAccountsInfo,
  BackendLoginStartResultMsg,
  BackendLoginSubmitResultMsg,
  BackendLoginWaitResultMsg,
  ClientMessage,
  LoginBackend,
  PendingBackendLogin,
  SessionInfo,
} from "../protocol/types";

/** The built-in account every backend has: the daemon's own environment or login. */
export const DEFAULT_ACCOUNT = "default";

interface State {
  loaded: boolean;
  loading: boolean;
  /** Every backend that takes accounts, in the daemon's order. */
  backends: BackendAccountsInfo[];
  /** Last list failure, for the panel. */
  error: string | null;
}

const EMPTY: State = { loaded: false, loading: false, backends: [], error: null };
const [state, setState] = createSignal<State>(EMPTY);

export const accountsState = state;

export function _resetAccountsForTest(): void {
  setState(EMPTY);
  inflight = null;
  refetch = null;
  attempt++;
  setLogin(LOGIN_EMPTY);
  resumeAccountLogin();
}

/** Test-only: seed the list without a daemon. */
export function _setAccountsForTest(backends: BackendAccountsInfo[]): void {
  setState({ loaded: true, loading: false, backends, error: null });
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function apply(res: AccountsResultMsg): void {
  setState({ loaded: true, loading: false, backends: res.backends, error: null });
}

/** One backend's accounts, kinds and default — undefined before the list loads, or for a backend without accounts. */
export function backendAccounts(backend: string | undefined): BackendAccountsInfo | undefined {
  if (!backend) return undefined;
  return state().backends.find((b) => b.backend === backend);
}

/**
 * Is there anything to choose for a session on `backend`: a named account, or
 * a kind the user can sign in to from here? A backend with neither has only
 * its built-in account, so a picker would offer nothing.
 */
export function backendOffersAccounts(backend: string | undefined): boolean {
  const b = backendAccounts(backend);
  return !!b && (b.accounts.length > 0 || b.kinds.some((k) => k.login));
}

/** Send an account message whose answer is the full list. Throws with the daemon's message. */
async function accountsCall(build: (id: string) => ClientMessage): Promise<void> {
  const id = newRequestId();
  const res = await getClient().request<AccountsResultMsg>(build(id), {
    waitForResult: (m) => (m.type === "accounts.result" && m.requestId === id ? m : undefined),
  });
  apply(res);
}

/** The list request in flight, and a forced refetch queued behind it. */
let inflight: Promise<void> | null = null;
let refetch: Promise<void> | null = null;

/**
 * Fetch every backend's accounts (settings:read). A token without the scope
 * gets an error, which the pickers treat as "nothing to choose" — they stay
 * hidden. A failure leaves the list unloaded, so the next caller (or a
 * reconnect) tries again.
 *
 * One request at a time. A plain fetch during a load waits for it; a forced
 * one (after a sign-in, say) wants a list newer than the one in flight, so it
 * runs once that settles — several forced calls share that one refetch.
 */
export function fetchAccounts(force = false): Promise<void> {
  if (inflight) {
    if (!force) return inflight;
    refetch ??= inflight.then(() => {
      refetch = null;
      return fetchAccounts(true);
    });
    return refetch;
  }
  if (state().loaded && !force) return Promise.resolve();
  setState((s) => ({ ...s, loading: true }));
  inflight = (async () => {
    try {
      await accountsCall((id) => ({ type: "accounts.list", id }));
    } catch (e) {
      setState((s) => ({ ...s, loading: false, error: errText(e) }));
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/**
 * On (re)connect, or when the backend list changes (an endpoint added or
 * removed): refetch a list someone has already asked for — accounts may have
 * changed while we were away, and a fetch that failed with the socket
 * deserves another try. Nothing asked yet = nothing to do.
 */
export function refreshAccounts(): void {
  const s = state();
  if (s.loaded || s.error) void fetchAccounts(true);
}

/**
 * Add an account, or replace one with `replace` (the daemon refuses a taken
 * name otherwise). Empty headers / keys are left out rather than sent empty.
 */
export async function saveAccount(input: {
  backend: string;
  name: string;
  kind: AccountKind;
  token?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  replace?: boolean;
}): Promise<void> {
  const nonEmpty = (r?: Record<string, string>) => (r && Object.keys(r).length > 0 ? r : undefined);
  const headers = nonEmpty(input.headers);
  const env = nonEmpty(input.env);
  await accountsCall((id) => ({
    type: "accounts.set",
    id,
    backend: input.backend,
    name: input.name,
    kind: input.kind,
    ...(input.token ? { token: input.token } : {}),
    ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
    ...(headers ? { headers } : {}),
    ...(env ? { env } : {}),
    ...(input.replace ? { replace: true } : {}),
  }));
}

export async function removeAccount(backend: string, name: string): Promise<void> {
  await accountsCall((id) => ({ type: "accounts.remove", id, backend, name }));
}

export async function setDefaultAccount(backend: string, name: string): Promise<void> {
  await accountsCall((id) => ({ type: "accounts.set_default", id, backend, name }));
}

/**
 * Put a session on an account of `backend`: a name, `default` (pin the
 * built-in), or null (follow the daemon default). The backend is sent
 * explicitly, so a choice made from one backend's list can't land on another
 * the session has just switched to. Resolves with the updated session,
 * already merged into the store.
 */
export async function setSessionAccount(sessionId: string, backend: string, account: string | null): Promise<SessionInfo | undefined> {
  const res = await request({ type: "session.set_account", id: newRequestId(), sessionId, backend, account });
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

/** Is `name` an account of `backend` already? Adding under it replaces the whole account. */
export function accountNameTaken(backend: string, name: string): boolean {
  return backendAccounts(backend)?.accounts.some((a) => a.name === name) ?? false;
}

/**
 * `accountNameProblem`, plus: a taken name needs `replace`. The daemon swaps
 * the whole credential under that name, moving every session on it — right
 * for renewing an expired sign-in, never as a silent side effect of a name.
 */
export function newAccountNameProblem(backend: string, name: string, replace = false): string | null {
  const p = accountNameProblem(name);
  if (p) return p;
  if (!replace && accountNameTaken(backend, name)) return `an account named "${name}" already exists — tick "Replace" to overwrite it`;
  return null;
}

/** An effective-account label the daemon marks as missing (`<name> (missing)`). */
export function isMissingAccount(effective: string | undefined): boolean {
  return !!effective && effective.endsWith(" (missing)");
}

/** A kind's label as the daemon describes it for `backend`, else the raw kind. */
export function kindLabel(backend: string, kind: AccountKind): string {
  return backendAccounts(backend)?.kinds.find((k) => k.kind === kind)?.label ?? kind;
}

/** What a kind calls its variables, lower-cased for a detail line ("keys" unless it says). */
function envLabel(backend: string, kind: AccountKind): string {
  return (backendAccounts(backend)?.kinds.find((k) => k.kind === kind)?.env?.label ?? "keys").toLowerCase();
}

/** One line of non-secret detail for an account: its kind, and the URL / header / key names it carries. */
export function accountDetail(a: AccountInfo): string {
  return [
    kindLabel(a.backend, a.kind),
    a.baseUrl,
    a.headerNames?.length ? `headers: ${a.headerNames.join(", ")}` : undefined,
    a.envNames?.length ? `${envLabel(a.backend, a.kind)}: ${a.envNames.join(", ")}` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Can a kind's credential be typed in (as opposed to only signed in)? */
export function kindTakesInput(k: AccountKindInfo): boolean {
  return !!(k.token || k.baseUrl || k.headers || k.env);
}

// ── Sign-in for a named account ──────────────────────────────────────────────

/**
 * `awaiting_code`: a `code` login shows its link and takes the pasted code.
 * `waiting`: a `device` login shows its link and one-time code, and waits for
 * the user to approve on the vendor's page.
 */
export type AccountLoginPhase = "idle" | "starting" | "awaiting_code" | "submitting" | "waiting";

interface LoginState {
  backend: LoginBackend | null;
  account: string | null;
  phase: AccountLoginPhase;
  login: PendingBackendLogin | null;
  error: string | null;
  /**
   * `waiting` only: the connection dropped mid-wait. The daemon's attempt
   * carries on regardless; the wait is sent again once the socket is back.
   */
  reconnecting: boolean;
}

const LOGIN_EMPTY: LoginState = { backend: null, account: null, phase: "idle", login: null, error: null, reconnecting: false };
const [login, setLogin] = createSignal<LoginState>(LOGIN_EMPTY);
/**
 * Bumped by every start, cancel and dismiss: a reply that lands after its
 * attempt was abandoned (Cancel during "Starting…", or a wait the user
 * cancelled) must not bring it back.
 */
let attempt = 0;

export const accountLoginState = login;

/**
 * How long the daemon keeps a finished `device` login's outcome for a client
 * that re-sends its wait (backend-login.ts). Past the attempt's expiry plus
 * this, a wait can only answer "unknown login", so the client stops asking.
 */
const OUTCOME_KEPT_MS = 10 * 60_000;

/**
 * The transport failed, as opposed to the daemon answering: the socket was
 * down or dropped, or no answer came in time. These are the core client's own
 * messages (CodeoidClient.request); a daemon refusal carries the daemon's text.
 */
export function isConnectionError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /^(cannot request while |connection lost|connection reset|client shutdown|request \S+ timed out)/.test(msg);
}

/** A device wait parked until the socket is back; woken by {@link resumeAccountLogin}. */
let wakeParkedWait: (() => void) | null = null;

/**
 * The socket is back (connection.ts calls this on every `connected`): a
 * device sign-in whose wait was cut off sends it again. Also wakes a parked
 * wait whose attempt was abandoned, so it can end.
 */
export function resumeAccountLogin(): void {
  const wake = wakeParkedWait;
  wakeParkedWait = null;
  wake?.();
}

/**
 * Start `backend`'s sign-in for account `name` — isolated on the daemon, so
 * it never touches the machine's own login. A `code` login resolves once
 * there is a link to show; a `device` login then waits for the approval on its
 * own and resolves when that ends. True only for a finished sign-in.
 */
export async function startAccountLogin(backend: LoginBackend, name: string, replace = false): Promise<boolean> {
  const mine = ++attempt;
  codeSentBlind = false;
  resumeAccountLogin();
  setLogin({ ...LOGIN_EMPTY, backend, account: name, phase: "starting" });
  let pending: PendingBackendLogin;
  try {
    const id = newRequestId();
    const res = await getClient().request<BackendLoginStartResultMsg>(
      { type: "backend.login.start", id, backend, account: name, ...(replace ? { replace: true } : {}) },
      {
        waitForResult: (m) => (m.type === "backend.login.start.result" && m.requestId === id ? m : undefined),
        timeoutMs: 60_000,
      },
    );
    pending = res.login;
  } catch (e) {
    if (mine === attempt) setLogin({ ...LOGIN_EMPTY, backend, account: name, error: errText(e) });
    return false;
  }
  if (mine !== attempt) {
    // Cancelled while starting: the daemon's attempt is live, so end it.
    void sendLoginCancel(pending.loginId);
    return false;
  }
  if (pending.mode === "device") {
    setLogin({ ...LOGIN_EMPTY, backend, account: name, phase: "waiting", login: pending });
    return waitAccountLogin(mine, pending);
  }
  setLogin({ ...LOGIN_EMPTY, backend, account: name, phase: "awaiting_code", login: pending });
  return false;
}

/** Signed in: back to idle (the next sign-in starts from a fresh form), and show the new account. */
async function finished(): Promise<void> {
  attempt++;
  setLogin(LOGIN_EMPTY);
  await fetchAccounts(true);
}

/**
 * Long-poll a `device` login until the user approves, it fails, or it
 * expires. Terminal either way: a failure means starting again.
 *
 * Losing the connection is not a failure: the daemon's attempt goes on, and
 * the user may be approving it right now. The wait is safe to send again — the
 * daemon answers a repeat with the same outcome — so a dropped socket parks
 * the wait until it is back, and a timeout simply asks again.
 */
/** A code was sent and the connection dropped before its answer: whether it arrived is unknown. */
let codeSentBlind = false;

async function waitAccountLogin(mine: number, pending: PendingBackendLogin): Promise<boolean> {
  // On this browser's clock: the daemon's duration when it sends one (its
  // absolute `expiresAt` is on the daemon's clock, which may disagree).
  const expiresAt = Date.now() + (pending.expiresInMs ?? Math.max(pending.expiresAt - Date.now(), 0));
  const tooLate = () => {
    // Past the attempt and the daemon's memory of how it ended (a laptop that
    // slept): asking again would only hear "no longer open". If it went
    // through, the list shows it.
    setLogin((s) => ({
      ...s,
      phase: "idle",
      login: null,
      reconnecting: false,
      error: "Lost the connection during the sign-in. If you approved it, the account is listed; otherwise start again.",
    }));
    void fetchAccounts(true);
    return false;
  };
  for (;;) {
    if (Date.now() > expiresAt + OUTCOME_KEPT_MS) return tooLate();
    let res: BackendLoginWaitResultMsg;
    try {
      const id = newRequestId();
      res = await getClient().request<BackendLoginWaitResultMsg>(
        { type: "backend.login.wait", id, loginId: pending.loginId },
        {
          waitForResult: (m) => (m.type === "backend.login.wait.result" && m.requestId === id ? m : undefined),
          // The daemon answers by the attempt's expiry at the latest; a margin
          // for the command's clean exit and the round trip.
          timeoutMs: Math.max(expiresAt - Date.now(), 0) + 30_000,
        },
      );
    } catch (e) {
      if (mine !== attempt) return false;
      if (!isConnectionError(e)) {
        setLogin((s) => ({ ...s, phase: "idle", login: null, reconnecting: false, error: errText(e) }));
        return false;
      }
      if (Date.now() > expiresAt + OUTCOME_KEPT_MS) return tooLate();
      if (connectionStatus().kind !== "connected") {
        setLogin((s) => ({ ...s, reconnecting: true }));
        await new Promise<void>((wake) => (wakeParkedWait = wake));
        if (mine !== attempt) return false;
        setLogin((s) => ({ ...s, reconnecting: false }));
      }
      continue;
    }
    if (mine !== attempt) return false;
    if (!res.ok) {
      setLogin((s) => ({ ...s, phase: "idle", login: null, reconnecting: false, error: res.error ?? "Sign-in failed." }));
      return false;
    }
    await finished();
    return true;
  }
}

/** Hand the vendor's code to the daemon (`code` logins). The code is never kept here. */
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
    const resent = codeSentBlind;
    codeSentBlind = false;
    if (!res.ok) {
      let error = res.error ?? "Sign-in failed.";
      // The code went out before the connection dropped: that first exchange
      // may have succeeded, which is why this one finds the attempt over.
      if (resent && !res.retryable) {
        error = `${error} If the first try went through before the connection dropped, the account is listed.`;
        void fetchAccounts(true);
      }
      // Only a code refused before it reached the command leaves the daemon's
      // attempt open; anything else ended it, so the form starts over.
      if (res.retryable) setLogin((s) => ({ ...s, phase: "awaiting_code", error }));
      else setLogin((s) => ({ ...s, phase: "idle", login: null, error }));
      return false;
    }
    await finished();
    return true;
  } catch (e) {
    if (mine !== attempt) return false;
    // The connection failed: whether the code arrived is unknown, so keep the
    // attempt and let the user send it again — the daemon says if it's over.
    // A daemon refusal (an unknown or expired attempt) ends it.
    if (isConnectionError(e)) {
      codeSentBlind = true;
      setLogin((s) => ({ ...s, phase: "awaiting_code", error: errText(e) }));
    }
    else setLogin((s) => ({ ...s, phase: "idle", login: null, error: errText(e) }));
    return false;
  }
}

export async function cancelAccountLogin(): Promise<void> {
  const cur = login();
  attempt++;
  codeSentBlind = false;
  // Offline, the cancel waits for the connection — by then an approval the
  // user already gave may have finished, so don't promise it was undone.
  const offline = cur.login !== null && connectionStatus().kind !== "connected";
  setLogin(
    offline
      ? { ...LOGIN_EMPTY, error: "Not connected — the cancel is sent when the connection is back. If you'd already approved, the account may still be added." }
      : LOGIN_EMPTY,
  );
  resumeAccountLogin();
  if (cur.login) await sendLoginCancel(cur.login.loginId);
}

/**
 * End the daemon's attempt. Without a connection the cancel is queued for the
 * reconnect: an attempt left running could still finish the sign-in the user
 * walked away from, and store its credential.
 */
async function sendLoginCancel(loginId: string): Promise<void> {
  try {
    const id = newRequestId();
    await getClient().request(
      { type: "backend.login.cancel", id, loginId },
      { waitForResult: (m) => (m.type === "backend.login.cancel.result" && m.requestId === id ? m : undefined) },
    );
  } catch (e) {
    if (!isConnectionError(e)) return;
    try {
      send({ type: "backend.login.cancel", id: newRequestId(), loginId });
    } catch {
      /* no client at all (signed out): the attempt expires on its own */
    }
  }
}

export function dismissAccountLogin(): void {
  attempt++;
  setLogin(LOGIN_EMPTY);
  resumeAccountLogin();
}
