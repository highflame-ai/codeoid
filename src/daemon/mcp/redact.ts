/**
 * Credentials out of anything codeoid shows about an MCP server (#394): a
 * Claude config keeps them in a server's args and URL as often as in its
 * env and headers (whose values are never read out at all). The same rules
 * clean a backend's MCP error text.
 *
 * What identifies a server stays: the command and its flags, the host, the
 * path's shape. What's hidden becomes "…".
 */

/**
 * Credentials redacted wherever they commonly sit in text: URL userinfo,
 * query strings and fragments, token-like path segments, PEM blocks, JWTs,
 * auth schemes, key=value / "key": "value" pairs (the key may carry a
 * prefix: access_token, client_secret, x-api-key), well-known key formats,
 * and — as a backstop for what those don't know — a long run of token
 * characters mixing letters and digits.
 */
export function redactSecretText(text: string): string {
  return (
    text
      // scheme://user:pass@ — any scheme, a password with a raw @ included
      .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s]*@/gi, "$1…@")
      // PEM blocks, JWTs
      .replace(/-----BEGIN [A-Z ]+-----[\s\S]*?(?:-----END [A-Z ]+-----|$)/g, "…")
      .replace(/\beyJ[\w-]+\.[\w-]+(?:\.[\w-]*)?/g, "…")
      // Authorization schemes
      .replace(/\b(digest)\s+[^\r\n]*/gi, "$1 …")
      // "Bearer x", "token: x" — the "=" forms are key=value below, which keeps the "="
      .replace(/\b(bearer|basic|token)(?:\s*:\s*|\s+)(?!=)[^\s"',;)]+/gi, "$1 …")
      .replace(
        /(^|[^a-z0-9])([\w-]*(?:token|secret|password|passwd|pwd|api[_-]?key|apikey|key|pat|auth|credentials?|sig|signature|session(?:_?id)?|cookie|code|bearer))(["']?\s*(?:=>|[=:]|%3[dD])\s*)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[{[][^}\]]{0,200}[}\]]?|[^\s"',;)}]+)/gi,
        "$1$2$3…",
      )
      // well-known key formats (codeoid's own ZeroID keys first)
      .replace(
        /\b(?:zid_sk_\w{8,}|hf_(?:sk_)?\w{8,}|sk-[\w-]{8,}|sk_[a-z]+_\w{8,}|gh[pousr]_\w{8,}|github_pat_\w{8,}|glpat-[\w-]{16,}|npm_\w{30,}|xox[abprs]-[\w-]{8,}|AKIA[0-9A-Z]{16}|AIza[\w-]{20,})/g,
        "…",
      )
      // long token-like path segments, then query strings and fragments
      .replace(/(?<![/:])\/[A-Za-z0-9_.~+%-]{24,}(?=[/\s?#"'),;\]>:]|$)/g, "/…")
      .replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s?#"']+)[?#][^\s"'),;\]>]*/gi, "$1?…")
      // Hostnames (dotted) and words are left alone.
      .replace(/[A-Za-z0-9+=_-]{20,}/g, (run) => (/[A-Za-z]/.test(run) && /\d/.test(run) ? "…" : run))
  );
}

/** A server's URL as shown: the address without the credentials it may carry. */
export function redactMcpUrl(url: string): string {
  return redactSecretText(url);
}

/** A flag whose value is a credential: `--api-key VALUE`, `--token VALUE`, `-auth VALUE`. */
const SECRET_FLAG = /^--?[\w.-]*(?:token|secret|password|passwd|pwd|api[_-]?key|apikey|key|auth|credentials?|bearer|cookie|session)[\w.-]*$/i;

/** A server's args as shown: a credential flag's value (the next argument, or
 *  after "="), and credentials inside any argument, hidden. */
export function redactMcpArgs(args: readonly string[]): string[] {
  const out: string[] = [];
  let valueIsSecret = false;
  for (const arg of args) {
    if (valueIsSecret && !arg.startsWith("-")) {
      out.push("…");
      valueIsSecret = false;
      continue;
    }
    valueIsSecret = SECRET_FLAG.test(arg);
    out.push(valueIsSecret ? arg : redactSecretText(arg));
  }
  return out;
}
