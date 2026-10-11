/**
 * ZeroID JWT verification for Codeoid connections — the primary auth path.
 *
 * Every WebSocket connection and every Telegram message must present a valid
 * ZeroID JWT. The token is verified locally against the JWKS endpoint (no
 * round-trip to ZeroID on the hot path). Scopes in the token are mapped to
 * Codeoid permission scopes and enforced per-message by the daemon.
 *
 * `ZeroIdVerifier` at the bottom of this file is the `TokenVerifier`
 * (./verifier.ts) implementation of this path — a thin wrapper carrying no
 * behaviour of its own, so that swapping the *issuer* (see ./local-auth.ts)
 * never touches what happens after a token becomes an `AuthContext`.
 */

import { ZeroIDClient } from "@highflame/sdk";
import type { AuthContext } from "../protocol/types.js";
import type { Scope } from "../protocol/scopes.js";
import type { AuthMode, TokenVerifier } from "./verifier.js";

export interface AuthConfig {
  /** ZeroID base URL, e.g. "http://localhost:8899" */
  baseUrl: string;
  /**
   * Unused: the ZeroID SDK always verifies against
   * `${baseUrl}/.well-known/jwks.json`, and so does ZeroIdVerifier's key-id
   * inventory, so the two can never disagree. Kept for config compatibility.
   */
  jwksUrl?: string;
  /** Expected issuer claim */
  issuer?: string;
  /** Expected audience claim */
  audience?: string;
}

// Lazily initialised ZeroID clients, keyed by base URL. A daemon has a single
// issuer in production (one entry), but keying by URL keeps each client bound
// to its own JWKS endpoint — so two issuers (or two JWKS servers in tests)
// never collide on a shared singleton pinned to whichever URL was seen first.
const _zeroidClients = new Map<string, ZeroIDClient>();

function getClient(config: AuthConfig): ZeroIDClient {
  let client = _zeroidClients.get(config.baseUrl);
  if (!client) {
    client = new ZeroIDClient({ baseUrl: config.baseUrl });
    _zeroidClients.set(config.baseUrl, client);
  }
  return client;
}

/**
 * Verify a bearer token and return the Codeoid auth context.
 *
 * @throws {Error} if the token is invalid, expired, or missing required fields.
 */
export async function verifyToken(
  token: string,
  config: AuthConfig,
): Promise<AuthContext> {
  const client = getClient(config);
  // Pass the configured audience so the SDK enforces `aud` too (no-op when
  // unset). We keep the explicit check below as defense-in-depth.
  const identity = await client.tokens.verify(token, config.audience);

  if (config.issuer && identity.iss !== config.issuer) {
    throw new Error(`Token issuer mismatch: expected "${config.issuer}", got "${identity.iss}"`);
  }

  if (config.audience && !identity.aud.includes(config.audience)) {
    throw new Error(`Token audience mismatch: expected "${config.audience}"`);
  }

  // Defend locally: the SDK only rejects expiry when `exp` is present, so a
  // signed token that omits `exp` would never expire. Require a numeric,
  // not-yet-expired exp. (A 60s skew allowance covers minor clock drift.)
  const nowSec = Math.floor(Date.now() / 1000);
  if (typeof identity.exp !== "number" || identity.exp <= 0) {
    throw new Error("Token missing exp claim");
  }
  if (identity.exp <= nowSec - 60) {
    throw new Error("Token expired");
  }

  // Reject empty-tenancy tokens. The SDK coerces a missing account_id/
  // project_id claim to "", which would otherwise become a usable principal
  // sharing a ""/"" bucket with any other claimless token. Every session is
  // scoped to (account, project), so both are required.
  if (!identity.account_id || !identity.project_id) {
    throw new Error("Token missing account_id/project_id claim");
  }

  return identityToAuthContext(identity);
}

// Use Awaited<ReturnType<...>> to get the identity type without importing the non-exported type.
type VerifiedIdentity = Awaited<ReturnType<ZeroIDClient["tokens"]["verify"]>>;

function identityToAuthContext(identity: VerifiedIdentity): AuthContext {
  return {
    sub: identity.sub,
    name: identity.name,
    scopes: (identity.scopes ?? []) as Scope[],
    delegationDepth: identity.delegation_depth ?? 0,
    delegatedBy: identity.act?.sub,
    accountId: identity.account_id,
    projectId: identity.project_id,
    exp: identity.exp,
  };
}

/** Minimum spacing between the verifier's own reads of the issuer's key ids. */
export const UNKNOWN_KID_COOLDOWN_MS = 10_000;
const JWKS_FETCH_TIMEOUT_MS = 5_000;
/** After a FAILED inventory read, the next one may happen this soon. */
export const FAILED_FETCH_RETRY_MS = 1_000;

/**
 * Decode a JWT segment EXACTLY as the ZeroID SDK does (base64url → atob →
 * TextDecoder). It has to be the same decoder, not merely an equivalent one:
 * the gate below is only sound if it sees the header the SDK will see. Node's
 * `Buffer` base64url + utf8 keeps a leading BOM that TextDecoder strips, so a
 * BOM-prefixed header parsed as garbage here and as a valid `kid` there.
 */
function decodeLikeSdk(segment: string): string {
  const padded = segment.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/**
 * What a JWT header says about its signing key, as the SDK will read it:
 * - `none` — no truthy `kid`; the SDK selects by `alg` and never refetches;
 * - a string `kid` — the SDK refetches its JWKS when it hasn't cached it;
 * - `invalid` — undecodable, or a truthy `kid` that is not a non-empty string.
 *   The SDK would still refetch for a truthy non-string (`kid: 1`), so these
 *   are refused outright rather than let past the gate.
 */
export type JwtKeyRef = { kind: "none" } | { kind: "kid"; kid: string } | { kind: "invalid" };

export function jwtKeyRef(token: string): JwtKeyRef {
  const segment = token.split(".")[0];
  if (!segment) return { kind: "invalid" };
  let header: unknown;
  try {
    header = JSON.parse(decodeLikeSdk(segment));
  } catch {
    return { kind: "invalid" };
  }
  if (header === null || typeof header !== "object" || Array.isArray(header)) return { kind: "invalid" };
  const kid = (header as { kid?: unknown }).kid;
  if (!kid) return { kind: "none" }; // absent, "", 0, false, null — the SDK's `kid ?` is falsy too
  return typeof kid === "string" ? { kind: "kid", kid } : { kind: "invalid" };
}

/** The `kid` a JWT's header names, or undefined. */
export function jwtKid(token: string): string | undefined {
  const ref = jwtKeyRef(token);
  return ref.kind === "kid" ? ref.kid : undefined;
}

/** The key ids an issuer publishes at its JWKS endpoint. */
async function fetchJwksKids(url: string): Promise<Set<string>> {
  const res = await fetch(url, { signal: AbortSignal.timeout(JWKS_FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`JWKS ${res.status}`);
  const body = (await res.json()) as { keys?: Array<{ kid?: unknown }> };
  return new Set((body.keys ?? []).map((k) => k.kid).filter((k): k is string => typeof k === "string"));
}

/**
 * The primary path as a `TokenVerifier`.
 *
 * Every guarantee of the ZeroID path — signature verification, issuer
 * pinning, audience checks, mandatory `exp`, mandatory tenancy claims — lives
 * in `verifyToken` above and is reached identically through this class.
 *
 * The one thing this class adds is a bound on what verifying a FORGED token
 * costs. The SDK refetches the issuer's JWKS whenever a token names a `kid` it
 * has not cached, so a stream of tokens with random `kid`s — over the
 * WebSocket handshake or `/mcp/control`, both unauthenticated — would turn the
 * daemon into a fetch loop against ZeroID.
 *
 * So a token naming a `kid` this verifier has not seen is checked first
 * against an inventory of the key ids the issuer publishes, refreshed at most
 * once per cooldown. A `kid` the issuer does not publish is refused without
 * reaching the SDK. Keys that have verified before skip all of this. A newly
 * rotated key cannot be starved: the inventory refresh is spaced by time, not
 * reset by failures, so the new key is in it within one cooldown however many
 * forged tokens arrive meanwhile — at most one issuer read per window.
 */
export class ZeroIdVerifier implements TokenVerifier {
  readonly mode: AuthMode = "zeroid";

  readonly #config: AuthConfig;
  readonly #verify: (token: string, config: AuthConfig) => Promise<AuthContext>;
  readonly #fetchKids: () => Promise<Set<string>>;
  readonly #now: () => number;
  /** Signing keys that have verified a token — never gated. */
  readonly #knownKids = new Set<string>();
  /** Key ids the issuer published at the last inventory read. */
  #published = new Set<string>();
  #publishedAt = Number.NEGATIVE_INFINITY;
  #refreshing: Promise<void> | null = null;

  constructor(
    config: AuthConfig,
    /** Test seams only. */
    deps: {
      verify?: (token: string, config: AuthConfig) => Promise<AuthContext>;
      fetchKids?: () => Promise<Set<string>>;
      now?: () => number;
    } = {},
  ) {
    this.#config = config;
    this.#verify = deps.verify ?? verifyToken;
    // The SAME URL the SDK fetches (it always derives it from baseUrl and
    // ignores `jwksUrl`), so the inventory describes the keys it will use.
    const jwksUrl = `${config.baseUrl.replace(/\/+$/, "")}/.well-known/jwks.json`;
    this.#fetchKids = deps.fetchKids ?? (() => fetchJwksKids(jwksUrl));
    this.#now = deps.now ?? Date.now;
  }

  /** The issuer this verifier trusts — used for operator-facing logging. */
  get issuer(): string {
    return this.#config.issuer ?? this.#config.baseUrl;
  }

  async verify(token: string): Promise<AuthContext> {
    const ref = jwtKeyRef(token);
    // Fail closed on anything the gate can't reason about: an undecodable
    // header, or a truthy `kid` that isn't a string (which the SDK would
    // still refetch for — `kid: 1` bypassed an earlier version of this gate).
    if (ref.kind === "invalid") throw new Error("Malformed token header");
    if (ref.kind === "kid" && !this.#knownKids.has(ref.kid) && !(await this.#publishes(ref.kid))) {
      throw new Error("Token signed by an unknown key");
    }
    const ctx = await this.#verify(token, this.#config);
    if (ref.kind === "kid") this.#knownKids.add(ref.kid);
    return ctx;
  }

  /** Whether the issuer publishes `kid`, reading its key ids at most once per cooldown. */
  async #publishes(kid: string): Promise<boolean> {
    if (this.#published.has(kid)) return true;
    if (this.#now() - this.#publishedAt >= UNKNOWN_KID_COOLDOWN_MS) {
      this.#refreshing ??= (async () => {
        // Stamp before the read so a slow or failing issuer is not hammered
        // by the requests that arrive while it is in flight.
        this.#publishedAt = this.#now();
        try {
          this.#published = await this.#fetchKids();
        } catch {
          // Keep the last inventory; an unreachable issuer would fail the SDK
          // path anyway. Retry sooner than a full window, though: right after
          // boot nothing is known yet, and one blip must not refuse every
          // client for 10 s once ZeroID is back.
          this.#publishedAt = this.#now() - UNKNOWN_KID_COOLDOWN_MS + FAILED_FETCH_RETRY_MS;
        } finally {
          this.#refreshing = null;
        }
      })();
    }
    if (this.#refreshing) await this.#refreshing;
    return this.#published.has(kid);
  }
}

/**
 * Extract bearer token from an Authorization header value.
 * Returns undefined if the header is missing or malformed.
 */
export function extractBearerToken(
  authHeader: string | undefined,
): string | undefined {
  if (!authHeader) return undefined;
  const match = authHeader.match(/^Bearer\s+(\S+)$/i);
  return match?.[1];
}
