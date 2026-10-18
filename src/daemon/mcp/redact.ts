/**
 * Credentials out of anything codeoid shows about an MCP server or a hook
 * (#394): a Claude config keeps them in a server's args, URL and command, and
 * in hook commands, as often as in env and headers (whose values are never
 * read out at all). The same rules clean a backend's MCP error text.
 *
 * What identifies a server stays: the command and its flags, the host (never
 * redacted — it's the address the user is shown and may consent to), the
 * path's shape. What's hidden becomes "…".
 *
 * Every input is bounded before a pattern runs: args and URLs come from files
 * a cloned repo controls (a `.mcp.json`), and these run on the daemon's event
 * loop.
 */

/** Longest text any rule here scans; past it, the rest is cut. */
const SCAN_CHARS = 2_000;

/** Words that name a credential — in a flag, a key=value key, a header. */
const SECRET_WORDS =
  "token|secret|password|passwd|pwd|pass|passphrase|api[_-]?key|apikey|key|pat|auth|credentials?|sig|signature|session(?:_?id)?|cookie|code|bearer|basic|private[_-]?key";

/**
 * Credentials redacted wherever they commonly sit in text: URL userinfo,
 * query strings and fragments, token-like path segments, PEM blocks, JWTs,
 * auth schemes, key=value / "key": "value" pairs (the key may carry a
 * prefix: access_token, client_secret, x-api-key), well-known key formats,
 * and — as a backstop for what those don't know — a long run of token
 * characters mixing letters and digits. Bounded.
 */
export function redactSecretText(text: string): string {
  const cut = text.length > SCAN_CHARS;
  const s = (cut ? text.slice(0, SCAN_CHARS) : text)
    // scheme://user:pass@ — any scheme, a password with a raw @ included
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s?#\\]*@/gi, "$1…@")
    // PEM blocks, JWTs
    .replace(/-----BEGIN [A-Z ]+-----[\s\S]*?(?:-----END [A-Z ]+-----|$)/g, "…")
    .replace(/\beyJ[\w-]+\.[\w-]+(?:\.[\w-]*)?/g, "…")
    // Authorization schemes: "Bearer x", "token: x" — the "=" forms are
    // key=value below, which keeps the "="
    .replace(/\b(digest)\s+[^\r\n]*/gi, "$1 …")
    .replace(/\b(bearer|basic|token)(?:\s*:\s*|\s+)(?!=)[^\s"',;)]+/gi, "$1 …")
    // key=value, key: value, "key": "value", "key" => {…}. The key's prefix
    // is bounded, so a long run of word characters can't make this quadratic.
    .replace(
      new RegExp(
        `(^|[^a-z0-9])([\\w-]{0,40}(?:${SECRET_WORDS}))(["']?\\s*(?:=>|[=:]|%3[dD])\\s*)("(?:[^"\\\\]|\\\\.){0,500}"|'(?:[^'\\\\]|\\\\.){0,500}'|[{[][^}\\]]{0,200}[}\\]]?|[^\\s"',;)}]+)`,
        "gi",
      ),
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
    // Backstop for what the rules above don't know: a long run of token
    // characters mixing letters and digits is a credential more often than a
    // diagnostic. (Words without digits are left alone.)
    .replace(/[A-Za-z0-9+=_-]{20,}/g, (run) => (/[A-Za-z]/.test(run) && /\d/.test(run) ? "…" : run));
  return cut ? `${s}…` : s;
}

/** A path segment that reads as a credential (or an account id). */
function secretSegment(seg: string): boolean {
  return seg.length >= 24 || (seg.length >= 20 && /[A-Za-z]/.test(seg) && /\d/.test(seg)) || redactSecretText(seg) !== seg;
}

/**
 * A server's URL as shown, built from the URL parser's own reading: the
 * scheme and host exactly as the URL resolves (never redacted — the user may
 * be consenting to that address, and a "…@" or a hidden label could make one
 * host read as another), userinfo dropped to "…@", token-like path segments
 * hidden, any query or fragment as "?…" / "#…". Not parseable: the text rules.
 */
export function redactMcpUrl(url: string): string {
  if (url.length > SCAN_CHARS) return "…";
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return redactSecretText(url);
  }
  const userinfo = u.username || u.password ? "…@" : "";
  const path = u.pathname
    .split("/")
    .map((seg) => (seg && secretSegment(seg) ? "…" : seg))
    .join("/");
  return `${u.protocol}//${userinfo}${u.host}${path}${u.search ? "?…" : ""}${u.hash ? "#…" : ""}`;
}

/** A flag naming a credential, by its words: `--api-key`, `--github-pat`, `--client-secret`. Not `--no-auth` (a switch). */
function secretFlag(arg: string): boolean {
  const m = /^--?([A-Za-z][\w.-]*)$/.exec(arg);
  if (!m) return false;
  const words = m[1]!.toLowerCase().split(/[-_.]/);
  if (words[0] === "no") return false;
  const joined = words.join("_");
  return new RegExp(`(^|_)(?:${SECRET_WORDS})(_|$)`).test(joined) || /(^|_)(?:access|private|client)_?(?:token|key|secret)(_|$)/.test(joined);
}

/** A header whose value is a credential. */
const SECRET_HEADER = /^(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|private-token|[\w-]*-(?:token|key|secret))$/i;

/** Plainly another flag (lowercase words), not a value that happens to start with "-". */
const PLAIN_FLAG = /^--?[a-z][a-z-]*$/;

/**
 * A server's args as shown: a credential flag's value (the next argument, or
 * after "="), a credential header's value (`-H Authorization <value>`, or
 * "Authorization: <value>" in one argument), and credentials inside any
 * argument, hidden.
 */
export function redactMcpArgs(args: readonly string[]): string[] {
  const out: string[] = [];
  let nextIsSecret = false;
  let prev = "";
  for (const raw of args) {
    const arg = raw.length > SCAN_CHARS ? "…" : raw;
    if (nextIsSecret && !PLAIN_FLAG.test(arg)) {
      out.push("…");
      nextIsSecret = false;
      prev = arg;
      continue;
    }
    // -H Authorization <value>: the header's name, then its value.
    const headerName = (prev === "-H" || prev === "--header") && SECRET_HEADER.test(arg);
    nextIsSecret = secretFlag(arg) || headerName;
    // "Authorization: <value>" in one argument.
    const oneArgHeader = /^([\w-]+)\s*:\s*(.+)$/.exec(arg);
    if (oneArgHeader && SECRET_HEADER.test(oneArgHeader[1]!)) out.push(`${oneArgHeader[1]}: …`);
    else out.push(nextIsSecret ? arg : redactSecretText(arg));
    prev = arg;
  }
  return out;
}
