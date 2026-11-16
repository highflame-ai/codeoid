/**
 * What the git gateway says (docs/git-gateway-design.md §5): every text the agent, the transcript, the audit or
 * a card reads is redacted here, and a remote URL is judged before it is shown or used.
 */
import { redactMcpUrl } from "../mcp/redact.js";

/** `ssh://…`, `git@host:path` (scp-like) or `https://…`: the protocols the push may use. */
export function remoteUrlProblem(url: string): string | null {
  if (/[\x00-\x20\x7f]/.test(url)) return "it holds spaces or control characters";
  // Shown to the owner as is: nothing invisible or reordering in it.
  if (/[\p{Cf}\p{Cc}\p{Zl}\p{Zp}\p{Co}\p{Cn}\u0085\u00a0]/u.test(url)) return "it holds invisible or reordering characters";
  if (url.startsWith("-")) return "it starts with -";
  const scheme = /^(https|ssh):\/\/([^/]*)/i.exec(url);
  if (scheme) {
    // The authority as git and curl read it (user info to the last @, then host[:port]) must be what a URL parser
    // reads, which is what the card shows: `https://github.com\@elsewhere/` is github.com to one, elsewhere to the other.
    const authority = scheme[2] ?? "";
    if (/[\\?#%]/.test(authority) || (authority.match(/@/g)?.length ?? 0) > 1) return "its host part has characters git and the card would read differently";
    const hostPort = authority.slice(authority.lastIndexOf("@") + 1);
    const host = hostPort.startsWith("[") ? hostPort.slice(0, hostPort.indexOf("]") + 1) : (hostPort.split(":")[0] ?? "");
    let parsed: string;
    try {
      parsed = new URL(url).hostname;
    } catch {
      return "it isn't a URL";
    }
    if (!host || host.toLowerCase() !== parsed.toLowerCase()) return "its host isn't what the card would show";
    return null;
  }
  // scp-like: [user@]host:path, no scheme, the host before the first colon has no slash.
  if (/^(?:[A-Za-z0-9._~-]+@)?[A-Za-z0-9.-]+:(?!\/\/)[^\s]+$/.test(url)) return null;
  return "only ssh and https remotes are reached for agents";
}

/**
 * Text that may name a config key or value (a refusal, a shown setting), with no credential in it: a URL's user
 * info (to its last `@`, a password may hold one), `user:pass@host` without a scheme, and a URL's query. Everything
 * the agent, the transcript, the audit or a card reads goes through it.
 */
export function redactCredentials(text: string): string {
  return text
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/]*@/gi, "$1…@")
    .replace(/(^|[\s=,(`'"])[^\s/@`'"=,()]*:[^\s/]*@/g, "$1…@")
    .replace(/(\/\/[^\s`'"]*?)\?[^\s`'"]*/g, "$1?…");
}

/** A name as the owner's line shows it: an invisible or reordering character written as its code. */
export function shownName(name: string): string {
  return name.replace(/[\p{Cf}\p{Cc}\p{Zl}\p{Zp}\p{Co}\p{Cn}]/gu, (c) => `\\u{${(c.codePointAt(0) ?? 0).toString(16)}}`);
}

/** A remote's URL, safe to show. scp-like ones have no credentials to hide but a user name, which stays. */
export function shownUrl(url: string): string {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? redactMcpUrl(url) : url;
}

/** Remote output can name URLs with tokens in them, and control sequences: shown redacted, plain, capped. */
export function shownOutput(text: string): string {
  const plain = text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
  const redacted = plain.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"<>]+/gi, (u) => redactMcpUrl(u));
  const trimmed = redacted.trim();
  return trimmed.length > 3000 ? `${trimmed.slice(0, 3000)}\n…` : trimmed;
}
