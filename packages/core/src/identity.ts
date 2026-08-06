/**
 * Identity helpers — surface ZeroID provenance everywhere, identically in
 * every frontend. Every message carries a `MessageIdentity { sub, name?,
 * type }`; clients render the *real* label (name or short sub), never a
 * generic "you" / "agent", with the full WIMSE URI available on demand as
 * proof of provenance. Colour mapping stays in each frontend.
 */

import type { MessageIdentity, SessionInfo } from "@highflame/codeoid-protocol";

/**
 * Last path segment of a SPIFFE / WIMSE URI.
 *
 *   spiffe://highflame.ai/acct/proj/agent/codeoid-session-abc → codeoid-session-abc
 *   anonymous:session:abc → abc
 *   you@example.com       → you@example.com (passthrough)
 */
export function shortSub(uri: string | null | undefined): string {
  if (!uri) return "—";
  // Anonymous markers: anonymous:<kind>:<id>
  if (uri.startsWith("anonymous:")) {
    const tail = uri.split(":").pop();
    return tail || uri;
  }
  // SPIFFE / WIMSE: take everything after the last "/".
  const slashIdx = uri.lastIndexOf("/");
  if (slashIdx >= 0 && slashIdx < uri.length - 1) {
    return uri.slice(slashIdx + 1);
  }
  return uri;
}

/** Display label for an identity — name when present, else short sub. */
export function identityLabel(id: MessageIdentity | null | undefined): string {
  if (!id) return "—";
  if (id.name && id.name.trim().length > 0) return id.name.trim();
  return shortSub(id.sub);
}

/**
 * Truncate a WIMSE URI for inline display while keeping the head + tail
 * visible — e.g. `spiffe://highflame.ai/.../agent/codeoid-session-abc`.
 * The full URI stays available via the title attribute / hover popover.
 */
export function truncateWimseUri(uri: string, headChars = 24, tailChars = 28): string {
  if (uri.length <= headChars + tailChars + 3) return uri;
  return `${uri.slice(0, headChars)}…${uri.slice(-tailChars)}`;
}

/**
 * One-liner provenance for a session — agent URI when registered, else
 * a clearly-marked "anonymous". Used by session headers.
 */
export function sessionAgentLabel(s: SessionInfo): string {
  if (!s.agentUri) return "anonymous session";
  if (s.agentUri.startsWith("anonymous:")) return "anonymous session";
  return shortSub(s.agentUri);
}
