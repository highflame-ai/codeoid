/**
 * What codeoid shows about an MCP server or a hook from a Claude config
 * (#394), and how backend MCP error text is cleaned.
 *
 * A config keeps credentials in a server's args, URL and command, and in hook
 * commands, as often as in env and headers. Redacting them out of arbitrary
 * shell text never closed (flags, quoting, `sh -c` bodies, heredocs…), so
 * commands and args aren't shown at all: a server shows its program's name
 * and how many args it has, a hook its program's name, and a URL its scheme,
 * host and the shape of its path. The file a row came from is shown; the
 * full text is there.
 *
 * Every input is bounded before a pattern runs: it comes from files a cloned
 * repo controls, and these run on the daemon's event loop.
 */

/** Longest text any rule here scans; past it, the rest is cut. */
const SCAN_CHARS = 2_000;

/** Words that name a credential — in a flag, a key=value key, a header. */
const SECRET_WORDS =
  "token|secret|password|passwd|pwd|pw|pass|passphrase|api[_-]?key|apikey|key|pat|auth|credentials?|creds?|sig|signature|session(?:_?id)?|cookie|code|bearer|basic|private[_-]?key|jwt|otp|sas|license";

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
    .replace(/[\p{Cf}\u180e\u2028\u2029]|\u034f|\p{Variation_Selector}/gu, "")
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
 * The program a command runs, by its name only: env assignments before it
 * skipped, quotes and directories dropped (`/usr/bin/node` → `node`,
 * `"C:\Program Files\srv.exe"` → `srv.exe`). A name that isn't a plain file
 * name, or reads as a credential, is "(command)".
 */
export function programName(command: string): string {
  // \S and \s don't overlap, so this is one linear pass.
  const rest = command.slice(0, SCAN_CHARS).trimStart().replace(/^(?:[A-Za-z_]\w*=\S*\s+)*/, "");
  const quoted = /^(["'])(.*?)\1/.exec(rest);
  const first = quoted ? quoted[2] : (rest.split(/\s/)[0] ?? "");
  const base = first.split(/[\\/]/).pop() ?? "";
  return /^[\w.+-]{1,64}$/.test(base) && redactSecretText(base) === base ? base : "(command)";
}

/** A hook's command as shown: its program, and "…" for the rest. */
export function commandSummary(command: string): string {
  if (!command.trim()) return "";
  const program = programName(command);
  return /\s/.test(command.trim()) ? `${program} …` : program;
}
