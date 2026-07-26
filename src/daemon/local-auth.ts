/**
 * Local mode — the deliberate no-ZeroID posture (`codeoid start --local`).
 *
 * Purpose: let someone install codeoid and have an agent session running in
 * seconds, with no account, no login, and no ZeroID reachable. This is a
 * *degraded* mode, stated as such everywhere it is visible, and it exists
 * strictly as a second implementation of the `TokenVerifier` seam — the
 * primary ZeroID path is untouched by it.
 *
 * ## What this is NOT
 *
 * It is not "auth off". The daemon runs coding agents with shell and
 * file-write authority, so a token-less socket on a port is a remote-code-
 * execution surface for any other local process (and any LAN peer, if bound
 * wide). Local mode therefore follows the Jupyter model:
 *
 *   1. mint a random 256-bit token at startup,
 *   2. hand it to local clients through a 0600 file in the config dir,
 *   3. bind loopback only — a non-loopback bind is refused unless the
 *      operator passes an explicit second flag.
 *
 * Time-to-first-session is unchanged by all three: nothing is typed, nothing
 * is registered, nothing is fetched.
 *
 * ## What local mode gives up
 *
 * Everything that needs a *verified* principal: per-agent and per-sub-agent
 * ZeroID identity, delegated sub-agent tokens, scope attenuation, cascading
 * revocation, cryptographic attribution, and multi-user sharing. The audit log
 * still records every action, but its subject is self-asserted — which is why
 * it is written under the existing `anonymous:` prefix (see
 * `agent-identity.ts`, which already degrades to `anonymous:session:*` when
 * registration is unavailable, and `session.ts`, which already suppresses
 * `anonymous:`-prefixed subjects from the WIMSE display path). An audit export
 * can separate self-asserted from verified principals on that prefix alone.
 *
 * ## Dependency invariant
 *
 * This module must never import `@highflame/sdk` — directly or transitively.
 * That is what makes local mode genuinely offline-capable, and it is the
 * regression most likely to creep back in silently, so
 * `src/tests/local-auth.test.ts` walks the import graph and fails on it.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { ALL_SCOPES, type AuthContext } from "@codeoid/protocol";
import type { AuthMode, TokenVerifier } from "./verifier.js";

/**
 * Audit subject for the local operator.
 *
 * `audit_log.subject` is one string column shared with real WIMSE URIs, so a
 * self-asserted principal must be unmistakable: never `spiffe://`-shaped, and
 * carrying the `anonymous:` prefix the codebase already treats as
 * "not a verified identity". Stable across restarts on purpose — session
 * ownership and rate-limit accounting key off it.
 */
export const LOCAL_SUBJECT = "anonymous:operator";

/** Display name shown by clients for the local operator. */
export const LOCAL_NAME = "local operator";

/**
 * Reserved tenant for local mode.
 *
 * `verifyToken` rejects empty `account_id` / `project_id` precisely so that
 * claimless tokens can't share a `""`/`""` bucket, and local mode must not
 * undo that — it gets its own explicit, reserved bucket instead.
 *
 * Consequence, and it is a one-way door worth stating in the quickstart:
 * sessions and memory created in local mode live in a DIFFERENT tenant than
 * the same person's later ZeroID sessions, so they won't be listed after a
 * `codeoid login`. That is correct isolation, but it reads as data loss.
 */
export const LOCAL_ACCOUNT_ID = "local";
/** @see LOCAL_ACCOUNT_ID */
export const LOCAL_PROJECT_ID = "local";

/**
 * Prefix on every minted local token. Not a security property — it exists so
 * a token is recognizable on sight (in a client's credential box, in a shell
 * history, in a bug report) and can never be mistaken for a ZeroID key
 * (`zid_sk_…`) or a JWT.
 */
export const LOCAL_TOKEN_PREFIX = "codeoid_local_";

/** Env var that supplies (daemon) or presents (client) the local-mode token. */
export const LOCAL_TOKEN_ENV = "CODEOID_LOCAL_TOKEN";

/** Basename of the 0600 token file dropped in the config dir while running. */
export const LOCAL_TOKEN_FILENAME = "local-token";

/**
 * Mint a local-mode token: 256 bits of CSPRNG entropy, base64url-encoded.
 *
 * Fresh per daemon boot (the file is removed on shutdown), so a leaked token
 * dies with the process rather than persisting as a durable credential.
 */
export function mintLocalToken(): string {
  return `${LOCAL_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
}

/** True when `token` looks like a codeoid local-mode token (shape only). */
export function isLocalToken(token: string): boolean {
  return token.startsWith(LOCAL_TOKEN_PREFIX);
}

/**
 * The single-token verifier.
 *
 * Fails closed on anything but an exact match, compared in constant time. The
 * returned context is frozen and shared: it is a fixed value, and freezing it
 * means one connection can never mutate the scopes another connection sees.
 */
export class LocalVerifier implements TokenVerifier {
  readonly mode: AuthMode = "local";

  readonly #expected: Buffer;
  readonly #context: AuthContext;

  constructor(token: string) {
    if (!token) throw new Error("LocalVerifier requires a non-empty token");
    this.#expected = Buffer.from(token, "utf8");
    this.#context = Object.freeze({
      sub: LOCAL_SUBJECT,
      name: LOCAL_NAME,
      // Full scope set, deliberately (design decision, not convenience): a
      // local operator on their own machine already has ambient authority over
      // everything the daemon can do, and granting everything keeps the
      // enforcement path IDENTICAL to the ZeroID path rather than creating a
      // second, less-exercised branch. The mechanism stays live; only the
      // issuer changed.
      scopes: ALL_SCOPES,
      delegationDepth: 0,
      // No `delegatedBy`: nothing delegated this, and claiming otherwise would
      // fabricate a chain.
      accountId: LOCAL_ACCOUNT_ID,
      projectId: LOCAL_PROJECT_ID,
      // No `exp`. The token's lifetime IS the daemon process — it is minted at
      // boot and its file is removed at shutdown. Setting an expiry would make
      // long-running local sessions drop for no security gain (there is no
      // refresh path to re-mint against). The daemon's per-message expiry check
      // is skipped for an absent `exp`, which is the same behaviour a ZeroID
      // token without `exp` would get — except ZeroID tokens are *required* to
      // carry one, so that path never sees this.
    } satisfies AuthContext);
  }

  /**
   * Verification is synchronous (a constant-time byte compare), but the
   * contract is async because the ZeroID path is — returning a rejected/
   * resolved promise keeps both implementations interchangeable at the seam.
   */
  verify(token: string): Promise<AuthContext> {
    if (!this.#matches(token)) {
      return Promise.reject(
        new Error(
          "Invalid local-mode token (the daemon is running with --local; present the token from its startup banner)",
        ),
      );
    }
    return Promise.resolve(this.#context);
  }

  /** Constant-time compare. Length is checked first — it is public anyway. */
  #matches(presented: string): boolean {
    const got = Buffer.from(presented ?? "", "utf8");
    if (got.length !== this.#expected.length) return false;
    return timingSafeEqual(got, this.#expected);
  }
}

// ── Bind safety ─────────────────────────────────────────────────────────────

/**
 * Is `host` a loopback address?
 *
 * Fails closed: anything not positively recognized as loopback (including an
 * empty string, a hostname, `0.0.0.0`, and `::`) is treated as remote.
 */
export function isLoopbackHost(host: string): boolean {
  const raw = host.trim().toLowerCase();
  if (raw.length === 0) return false;
  // Strip brackets from a bracketed IPv6 literal, and any :port suffix that
  // came along for the ride.
  const bare = raw.startsWith("[")
    ? (raw.match(/^\[([^\]]*)\]/)?.[1] ?? "")
    : raw;
  if (bare === "localhost" || bare === "localhost.localdomain") return true;
  if (bare === "::1" || bare === "0:0:0:0:0:0:0:1") return true;
  // IPv4-mapped IPv6 loopback (::ffff:127.0.0.1).
  const v4 = bare.startsWith("::ffff:") ? bare.slice("::ffff:".length) : bare;
  const octets = v4.split(".");
  if (octets.length !== 4) return false;
  if (octets.some((o) => !/^\d{1,3}$/.test(o) || Number(o) > 255)) return false;
  // The whole 127.0.0.0/8 block, not just 127.0.0.1 (Debian uses 127.0.1.1).
  return octets[0] === "127";
}

/**
 * Refuse a local-mode daemon on a non-loopback bind unless explicitly allowed.
 *
 * "No login" must not silently mean "reachable by the network". On a wide bind
 * the minted token is the *only* thing between a LAN peer and an agent with
 * shell access, so that has to be a deliberate, typed decision.
 *
 * @throws {Error} with operator-facing guidance when the bind is unsafe.
 */
export function assertLocalBindAllowed(host: string, allowRemote: boolean): void {
  if (isLoopbackHost(host)) return;
  if (allowRemote) return;
  throw new Error(
    [
      `--local refuses to bind ${host}: local mode has no ZeroID identity, so a non-loopback bind`,
      "exposes an agent with shell and file-write access to anything that can reach this port.",
      "  • keep it local:   drop --host (defaults to 127.0.0.1)",
      "  • need it remote:  use ZeroID auth (codeoid login) — real identities, revocable tokens",
      "  • accept the risk: add --local-allow-remote (the minted token becomes the only guard)",
    ].join("\n"),
  );
}

// ── Token file (the handoff channel to local clients) ───────────────────────

/**
 * Publish the token for clients on this machine.
 *
 * This is what makes `codeoid start --local` in one terminal and `codeoid tui`
 * in another work with zero copy-paste. 0600, in the config dir, removed on
 * shutdown — so its presence means "a local-mode daemon is running here",
 * which is exactly the signal clients need to prefer it over a stored ZeroID
 * key.
 */
export function writeLocalTokenFile(path: string, token: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  // writeFileSync's `mode` only applies when it CREATES the file; an existing
  // file keeps its old (possibly wider) mode. Tighten unconditionally.
  try {
    chmodSync(path, 0o600);
  } catch {
    /* best effort — a filesystem without POSIX modes is not a reason to fail */
  }
}

/** Read a published local token, or null when no local daemon is running. */
export function readLocalTokenFile(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    const token = readFileSync(path, "utf8").trim();
    return token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

/** Remove the published token (daemon shutdown). Never throws. */
export function removeLocalTokenFile(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    /* best effort — a stale file fails closed at the verifier anyway */
  }
}
