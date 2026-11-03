/**
 * `codeoid ui`: the web UI's address, and on a local-mode daemon a one-time
 * link that signs a browser in (#448 round 4). The daemon never hands its
 * token to a page for being on the loopback; this asks it for a code with the
 * token read from its file (hidden from every sandbox), and the page
 * exchanges the code once.
 */

import { resolveLocalToken } from "../config.js";
import { UI_LINK_TTL_MS, uiLinkUrl } from "../daemon/local-auth.js";

/** The daemon's HTTP base for its `ws://` URL. */
export function httpBaseOf(daemonUrl: string): string {
  return daemonUrl.replace(/^ws/, "http").replace(/\/+$/, "");
}

export type UiLink = { url: string; signsIn: boolean; expiresInMs?: number } | { error: string };

/**
 * The URL to open: a sign-in link when a local token for this daemon is at
 * hand (`CODEOID_LOCAL_TOKEN`, or the daemon's token file), else the plain
 * `/ui/` (a ZeroID daemon: sign in there).
 */
export async function webUiLink(
  daemonUrl: string,
  env: Record<string, string | undefined> = process.env,
  fetchFn: typeof fetch = fetch,
): Promise<UiLink> {
  const base = httpBaseOf(daemonUrl);
  const token = resolveLocalToken(daemonUrl, env);
  if (!token) return { url: `${base}/ui/`, signsIn: false };
  let res: Response;
  try {
    res = await fetchFn(`${base}/ui/local-link`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
  } catch (err) {
    return { error: `the daemon at ${base} didn't answer (${err instanceof Error ? err.message : String(err)}) — is it running?` };
  }
  let body: { code?: unknown; expiresInMs?: unknown; error?: unknown } = {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    /* no JSON: said below */
  }
  if (res.ok && typeof body.code === "string" && body.code) {
    return { url: uiLinkUrl(base, body.code), signsIn: true, expiresInMs: typeof body.expiresInMs === "number" ? body.expiresInMs : UI_LINK_TTL_MS };
  }
  if (res.status === 404) return { error: `the daemon at ${base} gives no sign-in links: it isn't in local mode on a loopback address, or its web UI is off — open ${base}/ui/ and sign in` };
  return { error: `the daemon at ${base} refused a sign-in link (${res.status}${typeof body.error === "string" ? `: ${body.error}` : ""})` };
}
