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
  /** ZeroID JWKS URL — derived from baseUrl if not set */
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

/**
 * The primary path as a `TokenVerifier`.
 *
 * Deliberately behaviour-free: it holds the `AuthConfig` and delegates to
 * `verifyToken` above, unchanged. Every guarantee of the ZeroID path —
 * signature verification, issuer pinning, audience checks, mandatory `exp`,
 * mandatory tenancy claims — lives in that function and is reached identically
 * whether the caller went through this class or called it directly.
 */
export class ZeroIdVerifier implements TokenVerifier {
  readonly mode: AuthMode = "zeroid";

  readonly #config: AuthConfig;

  constructor(config: AuthConfig) {
    this.#config = config;
  }

  /** The issuer this verifier trusts — used for operator-facing logging. */
  get issuer(): string {
    return this.#config.issuer ?? this.#config.baseUrl;
  }

  verify(token: string): Promise<AuthContext> {
    return verifyToken(token, this.#config);
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
