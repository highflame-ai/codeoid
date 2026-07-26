/**
 * The auth seam.
 *
 * Codeoid's connection auth is structurally a single function that converts a
 * bearer token into an `AuthContext`; everything downstream (scope checks,
 * audit subjects, rate-limit keys, tenant scoping) consumes that data and
 * never re-inspects the token. This file declares that one function as an
 * interface so the daemon can be handed a *different issuer* without any
 * enforcement site knowing which one it got.
 *
 * Two implementations exist:
 *   - `ZeroIdVerifier` (./auth.ts)       — the primary path: RS256 JWT verified
 *                                          against the issuer's JWKS.
 *   - `LocalVerifier`   (./local-auth.ts) — the deliberate degraded path: one
 *                                          process-lifetime token, no network.
 *
 * REVIEW INVARIANT — the two postures stay separated *here*, at the verifier.
 * Never add a `if (localMode) …` branch inside `hasScope`, the handshake, an
 * audit write, or any other enforcement site. The moment local mode becomes a
 * conditional inside the verified path, it stops being an isolated second
 * posture and becomes a hole in the first one.
 *
 * This module deliberately imports nothing but protocol types — it is the
 * shared seam, so a local-mode daemon must be able to reach it without
 * pulling in the ZeroID SDK. `src/tests/local-auth.test.ts` enforces that by
 * walking the import graph.
 */

import type { AuthContext } from "@codeoid/protocol";

/**
 * Which issuer authenticated this daemon's connections.
 *
 * - `zeroid` — every token is a ZeroID-issued JWT, verified cryptographically.
 *   Identities are real, attributable, delegatable, and revocable.
 * - `local`  — one locally-minted token stands in for a single self-asserted
 *   operator. No accounts, no login, no network. Everything that depends on a
 *   *verified* principal (per-agent identity, delegation, cascading
 *   revocation, cryptographic attribution) is unavailable by construction.
 */
export type AuthMode = "zeroid" | "local";

/** Converts a presented bearer token into the connection's auth context. */
export interface TokenVerifier {
  /** Which posture this verifier implements — surfaced to clients on `auth.ok`. */
  readonly mode: AuthMode;
  /**
   * Verify a bearer token.
   *
   * @throws {Error} if the token is invalid, expired, or missing required
   * claims. Callers treat *any* throw as "fail closed" — both implementations
   * must therefore reject rather than return a degraded context.
   */
  verify(token: string): Promise<AuthContext>;
}
