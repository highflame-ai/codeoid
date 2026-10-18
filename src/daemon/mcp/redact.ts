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
  "token|secret|password|passwd|pwd|pass|passphrase|api[_-]?key|apikey|key|pat|auth|credentials?|creds?|sig|signature|session(?:_?id)?|cookie|code|bearer|basic|private[_-]?key|jwt|otp|sas|license";

/** Longest URL parsed at all (the parser is native and linear); past it, nothing is shown. */
const URL_CHARS = 65_536;

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
    // Invisible characters go (so they can't split a token past the rules
    // below, nor reorder what's displayed); control characters become spaces.
    .replace(/[\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]+/g, "")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]+/g, " ")
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

/**
 * A path segment that reads as a credential or an account id: a UUID, a
 * long hex string, a run of 16+ letters and digits mixing both, or a known
 * key format. Not one that's just long — `my-company-mcp-server-v2` stays.
 */
function secretSegment(seg: string): boolean {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg) || /^[0-9a-f]{32,}$/i.test(seg)) return true;
  if ((seg.match(/[A-Za-z0-9]{16,}/g) ?? []).some((run) => /[A-Za-z]/.test(run) && /\d/.test(run))) return true;
  return /^(?:zid_sk_|hf_|sk-|sk_|gh[pousr]_|github_pat_|glpat-|npm_|xox[abprs]-|AKIA|AIza|eyJ)/.test(seg);
}

/**
 * A server's URL as shown, built from the URL parser's own reading: the
 * scheme and host exactly as the URL resolves (never redacted — the user may
 * be consenting to that address, and a "…@" or a hidden label could make one
 * host read as another), userinfo dropped to "…@", token-like path segments
 * hidden, any query or fragment as "?…" / "#…". Not parseable: the text rules.
 */
export function redactMcpUrl(url: string): string {
  if (url.length > URL_CHARS) return "…";
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return redactSecretText(url);
  }
  const userinfo = u.username || u.password ? "…@" : "";
  // The host is always shown, however long the rest; a path too long to
  // scan is shown as "/…".
  const path =
    u.pathname.length > SCAN_CHARS
      ? "/…"
      : u.pathname
          .split("/")
          .map((seg) => (seg && secretSegment(seg) ? "…" : seg))
          .join("/");
  return `${u.protocol}//${userinfo}${u.host}${path}${u.search ? "?…" : ""}${u.hash ? "#…" : ""}`;
}

/**
 * A flag naming a credential, by its words: `--api-key`, `--github-pat`,
 * `--client-secret`, `--apiToken`. Not `--no-auth` (a switch), nor one naming
 * where a credential is, rather than what it is (`--key-file`, `--auth-type`).
 */
function secretFlag(arg: string): boolean {
  const m = /^--?([A-Za-z][\w.-]*)$/.exec(arg);
  if (!m) return false;
  // camelCase splits like kebab-case: --apiToken reads as api, token.
  const words = m[1]!.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().split(/[-_.]/);
  if (words[0] === "no") return false;
  if (/^(?:file|path|dir|name|type|jar|mode|chain|store|ring|url|host|port)$/.test(words.at(-1)!)) return false;
  // Run together: --authtoken, --secretkey, --apitoken.
  if (words.some((w) => /(?:token|secret|password|passwd|key|creds?)$/.test(w))) return true;
  const joined = words.join("_");
  return new RegExp(`(^|_)(?:${SECRET_WORDS})(_|$)`).test(joined) || /(^|_)(?:access|private|client)_?(?:token|key|secret)(_|$)/.test(joined);
}

/** A header whose value is a credential. */
const SECRET_HEADER = new RegExp(`^(?:authorization|proxy-authorization|set-cookie|[\\w-]*(?:${SECRET_WORDS})[\\w-]*):?$`, "i");

/** A user:password pair: curl's -u / --user takes one. */
const USER_FLAG = /^(?:-u|--user|--proxy-user)$/;

/** Plainly another flag (lowercase words), not a value that happens to start with "-". */
const PLAIN_FLAG = /^--?[a-z][a-z-]*$/;

/**
 * A server's args as shown: a credential flag's value (the next argument, or
 * after "="), a credential header's value (`-H Authorization <value>`, or
 * "Authorization: <value>" in one argument), and credentials inside any
 * argument, hidden.
 */
/**
 * A shell command line as shown (a hook's, a server's): split into words
 * (honouring quotes), each redacted as an argument is, and joined back —
 * so `--api-key VALUE` in a command hides VALUE as it would in args.
 */
export function redactShellCommand(command: string): string {
  if (command.length > SCAN_CHARS) return redactSecretText(command);
  const words: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  for (let m = re.exec(command); m; m = re.exec(command)) words.push(m[1] ?? m[2] ?? m[3] ?? "");
  // A quoted word that is itself a command (`sh -c "…"`) is redacted as one.
  const shown = redactMcpArgs(words).map((w, i) => (w === words[i] && /\s/.test(w) ? redactShellCommand(w) : w));
  // Single-quote a word with spaces or quotes so the line reads as it would run.
  return shown
    .map((w) => (/^[^\s'"]*$/.test(w) ? w : `'${w.replace(/'/g, "'\\''")}'`))
    .join(" ");
}

/** Most args shown per server; the rest are one "…". */
const MAX_ARGS = 64;

export function redactMcpArgs(allArgs: readonly string[]): string[] {
  const args = allArgs.length > MAX_ARGS ? allArgs.slice(0, MAX_ARGS) : allArgs;
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
    // -u user:password
    if (USER_FLAG.test(prev) && arg.includes(":")) {
      out.push(`${arg.slice(0, arg.indexOf(":"))}:…`);
      nextIsSecret = false;
      prev = arg;
      continue;
    }
    nextIsSecret = secretFlag(arg) || headerName;
    // "Authorization: <value>" in one argument.
    const oneArgHeader = /^([\w-]+)\s*:\s*(.+)$/.exec(arg);
    if (oneArgHeader && SECRET_HEADER.test(oneArgHeader[1]!)) out.push(`${oneArgHeader[1]}: …`);
    else if (nextIsSecret) out.push(arg);
    // A URL argument is shown as a URL is: from the parser, host intact.
    else if (/^https?:\/\//i.test(arg)) out.push(redactMcpUrl(arg));
    else out.push(redactSecretText(arg));
    prev = arg;
  }
  if (allArgs.length > MAX_ARGS) out.push("…");
  return out;
}
