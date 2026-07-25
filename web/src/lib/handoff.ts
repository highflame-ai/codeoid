/**
 * URL-hash credential handoff for embed SSO.
 *
 * An embedding parent (e.g. Highflame Studio) can pre-authenticate this
 * embedded UI by handing a SHORT-LIVED credential in the URL *hash* — never
 * the query string. The hash is not sent to any server, does not appear in the
 * `Referer` header, and is not logged by intermediaries, so it is the safe
 * channel for a bearer credential the parent already holds.
 *
 * ── Trusted-framing-origin gate (login-CSRF / session-fixation defense) ──
 * Reading a credential out of `location.hash` unconditionally is credential
 * *injection*: an attacker can lure a victim to `…/ui/#codeoid_token=<attacker
 * JWT>` (top-level navigation) or frame this app from an attacker page and
 * silently sign the victim into the ATTACKER's account. Stripping the hash on
 * consume and never sending it to the server defend *leakage* — they do
 * nothing against injection. So we consume a hash-delivered credential ONLY
 * when this page is EMBEDDED by an allowlisted parent origin, and we fail
 * CLOSED on any uncertainty:
 *   1. Not framed (`window.top === window.self`) ⇒ ignore the hash. This kills
 *      the top-level-navigation login-CSRF outright.
 *   2. Framing origin (`location.ancestorOrigins[0]`) absent (e.g. Firefox has
 *      no `ancestorOrigins`) ⇒ ignore. We do NOT fall back to
 *      `document.referrer`, which an embedding page can strip or forge.
 *   3. Framing origin not in the configured allowlist ⇒ ignore.
 * Only when ALL pass do we consume + persist + strip. An ungated call never
 * writes to storage, so it can never clobber an existing valid session; a
 * gated call was authorized by a trusted parent, so replacing the stored
 * credential within the gate is intended.
 *
 * The daemon publishes the allowlist to the client as the synchronous global
 * `window.__CODEOID_EMBED_ORIGINS__` (injected into the served index.html —
 * see src/frontends/web-ui/index.ts). Empty/absent ⇒ NO origin is trusted ⇒
 * the hash handoff is effectively disabled (the safe default).
 *
 * On a passing gate we CONSUME it: read the two known keys, persist them
 * exactly like the normal sign-in flows (into the same localStorage slots),
 * and immediately strip them from the URL via `history.replaceState` so the
 * credential does not linger in the address bar or browser history. The daemon
 * still verifies the token on the WS handshake and fails closed — this only
 * changes how the browser OBTAINS a token, not the security gate.
 *
 * Accepted hash params (ONLY these two — anything else is ignored/preserved):
 *   #codeoid_token=<JWT>       → persisted as the OAuth JWT (codeoid.token)
 *   #codeoid_key=<zid_sk_...>  → persisted as the API key   (codeoid.apiKey)
 *
 * SECURITY: only the two known keys are accepted; the credential value is never
 * logged; and it is stripped from the URL on the same tick it is read. The
 * parent is expected to hand a SHORT-LIVED token for this to be a safe SSO
 * bridge — a long-lived secret in a hash is a durable-credential leak.
 */

import { STORAGE_KEY_API_KEY, STORAGE_KEY_REFRESH_TOKEN, STORAGE_KEY_TOKEN } from "./auth";

const HANDOFF_TOKEN_PARAM = "codeoid_token";
const HANDOFF_KEY_PARAM = "codeoid_key";
// The rotating refresh token handed off alongside the access token so the
// embedded UI can renew its own session (self-reliant refresh) without the host
// re-minting. Persisted like the others and stripped from the URL on consume.
const HANDOFF_REFRESH_PARAM = "codeoid_refresh";

/** Global the daemon injects into index.html carrying the embed allowlist. */
declare global {
  interface Window {
    /** Embed-SSO trusted framing origins, published by the daemon. */
    __CODEOID_EMBED_ORIGINS__?: unknown;
  }
}

export interface HandoffCredential {
  /** Pre-issued daemon JWT handed in via `#codeoid_token=`. */
  token?: string;
  /** ZeroID API key (`zid_sk_...`) handed in via `#codeoid_key=`. */
  apiKey?: string;
  /** Rotating refresh token handed in via `#codeoid_refresh=`. */
  refreshToken?: string;
}

export interface HandoffOptions {
  /**
   * Origins allowed to frame this UI and hand it a credential. Each is an exact
   * origin (`scheme://host[:port]`); matching is case-insensitive. Empty or
   * absent ⇒ NO origin is trusted ⇒ the hash handoff is disabled (safe default).
   */
  allowedOrigins?: readonly string[];
}

/** decodeURIComponent that never throws — falls back to the raw value. */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Read the embed allowlist the daemon published on `window`. Returns [] for any
 * shape other than an array of non-empty strings — so a missing or malformed
 * global fails closed to "no trusted origin". App.tsx passes this into
 * `consumeHandoffCredential`; tests pass an explicit allowlist instead.
 */
export function readEmbedAllowedOrigins(): string[] {
  if (typeof window === "undefined") return [];
  const raw = window.__CODEOID_EMBED_ORIGINS__;
  if (!Array.isArray(raw)) return [];
  return raw.filter((o): o is string => typeof o === "string" && o.trim().length > 0);
}

/**
 * Fail-closed check: is this page embedded by an allowlisted parent origin?
 * Returns false (ignore any hash credential) on ANY uncertainty — see the
 * module doc for the three fail-closed conditions.
 */
function isTrustedFramingOrigin(allowedOrigins?: readonly string[]): boolean {
  // 1. Must be embedded. A top-level page can be driven to
  //    …/#codeoid_token=… by attacker-controlled navigation — the login-CSRF
  //    we're closing. Only a framed context exposes a verifiable parent origin.
  //    (`===` identity is always allowed cross-origin and never throws.)
  if (window.top === window.self) return false;

  // 2. Empty allowlist ⇒ nothing is trusted ⇒ handoff disabled (safe default).
  if (!allowedOrigins || allowedOrigins.length === 0) return false;

  // 3. Immediate framing origin. `ancestorOrigins[0]` is set by the BROWSER,
  //    not the embedding script, so it is unspoofable by the parent. Absent
  //    (Firefox has no `ancestorOrigins`) ⇒ FAIL CLOSED — do NOT fall back to
  //    `document.referrer`, which the parent can strip or forge.
  // lib.dom types `ancestorOrigins` as always-present, but it genuinely is
  // absent in Firefox — reflect that with the cast so the fail-closed branch is
  // real, not dead code.
  const ancestors = window.location.ancestorOrigins as DOMStringList | undefined;
  const parentOrigin =
    ancestors && ancestors.length > 0 ? ancestors[0] : undefined;
  if (!parentOrigin) return false;

  // 4. Case-insensitive exact ORIGIN match against the allowlist.
  const parent = parentOrigin.trim().toLowerCase();
  if (parent.length === 0) return false;
  return allowedOrigins.some((o) => o.trim().toLowerCase() === parent);
}

/**
 * Read a credential handed in via the URL hash, persist it like a remembered
 * credential, and strip the handoff params from the URL (preserving any other
 * hash content). Returns what was consumed so the caller can give a
 * freshly-handed-in credential precedence over a stale stored one.
 *
 * Consumes ONLY when the trusted-framing-origin gate passes (see the module
 * doc). On a failing gate — not framed, unknown/absent framing origin, or an
 * origin not in `opts.allowedOrigins` — it returns `{}` and leaves the URL and
 * storage untouched, so a stray or attacker-supplied hash can never inject a
 * credential.
 *
 * Defensive by contract: never throws on load, and ignores malformed or empty
 * values (a `#codeoid_token=` with no value is treated as absent, but is still
 * stripped from the URL once the gate has passed).
 */
export function consumeHandoffCredential(opts: HandoffOptions = {}): HandoffCredential {
  try {
    // Guard for non-browser contexts (SSR / tests without a DOM).
    if (typeof window === "undefined" || !window.location) return {};

    // Fail-closed gate FIRST: an untrusted framing context must never lead to a
    // storage write, so we bail before parsing/persisting the hash. Leaving the
    // (unconsumed) hash in the URL is harmless — it's never sent to a server.
    if (!isTrustedFramingOrigin(opts.allowedOrigins)) return {};

    const rawHash = window.location.hash.startsWith("#")
      ? window.location.hash.slice(1)
      : window.location.hash;
    if (!rawHash) return {};

    // Split the hash into "&"-separated segments and filter out only the two
    // known handoff params, keeping every other segment verbatim. This avoids
    // the re-encoding surprises a URLSearchParams round-trip would inflict on
    // non-`key=value` hash content (e.g. anchors / client routes).
    let token: string | undefined;
    let apiKey: string | undefined;
    let refreshToken: string | undefined;
    const kept: string[] = [];
    let consumedAny = false;

    for (const segment of rawHash.split("&")) {
      const eq = segment.indexOf("=");
      const key = eq === -1 ? segment : segment.slice(0, eq);
      const value = eq === -1 ? "" : segment.slice(eq + 1);

      if (key === HANDOFF_TOKEN_PARAM) {
        consumedAny = true; // drop from `kept` even if the value is empty
        token = safeDecode(value).trim() || undefined;
        continue;
      }
      if (key === HANDOFF_KEY_PARAM) {
        consumedAny = true;
        apiKey = safeDecode(value).trim() || undefined;
        continue;
      }
      if (key === HANDOFF_REFRESH_PARAM) {
        consumedAny = true;
        refreshToken = safeDecode(value).trim() || undefined;
        continue;
      }
      kept.push(segment);
    }

    // No handoff params at all → leave the URL untouched.
    if (!consumedAny) return {};

    const result: HandoffCredential = {};

    // Persist exactly like the existing flows so a handed-in credential behaves
    // like a remembered one on subsequent reloads. NEVER log the value. Safe to
    // overwrite here: the gate proved a trusted parent set this hash.
    if (token) {
      localStorage.setItem(STORAGE_KEY_TOKEN, token);
      result.token = token;
    }
    if (apiKey) {
      localStorage.setItem(STORAGE_KEY_API_KEY, apiKey);
      result.apiKey = apiKey;
    }
    if (refreshToken) {
      localStorage.setItem(STORAGE_KEY_REFRESH_TOKEN, refreshToken);
      result.refreshToken = refreshToken;
    }

    // Strip the handoff params from the URL (preserving any other hash content)
    // so the credential is not persisted in the address bar or history.
    const newHash = kept.length > 0 ? `#${kept.join("&")}` : "";
    const { pathname, search } = window.location;
    history.replaceState(null, "", `${pathname}${search}${newHash}`);

    return result;
  } catch {
    // Never break app boot on a malformed hash — degrade to "no handoff".
    return {};
  }
}
