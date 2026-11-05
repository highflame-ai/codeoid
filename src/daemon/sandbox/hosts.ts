/**
 * Host names a sandbox's network allowlist may name (#448). Its own module,
 * with no imports, so the config schema (config.ts) validates the same way a
 * session's setting is validated (policy.ts, session-sandbox.ts).
 */

/** A host an allowlist may name: a domain, a `*.` wildcard of one, or `localhost`. */
export function validAllowedHost(h: string): boolean {
  return /^(\*\.)?[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?)*$/.test(h) && h.length <= 253;
}
