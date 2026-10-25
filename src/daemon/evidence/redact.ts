/**
 * Redact credentials from a check's captured output before it is stored as an
 * excerpt or shown to a model. Test output echoes tokens more often than one
 * would like: `set -x`, a failing HTTP fixture, a connection string in an error.
 *
 * These rules are written for logs, not configuration. Test output is mostly
 * file paths, test names, hashes, and exit codes, and a worker repairing a
 * failure needs all of them, so nothing is masked for merely looking random:
 * only known credential shapes and values bound to keys that name a secret.
 * The whole text is scanned at once (every pattern is linear), so a PEM block
 * or a long line is never split between two scans.
 */

const MASK = "…[redacted]";

/** Key names whose values are secrets, in `key=value` / `key: value` form. */
const SECRET_KEY =
  "(?:[A-Za-z0-9_.-]{0,40}[_.-])?(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|auth[_-]?token|credentials?|session[_-]?key)";

const RULES: ReadonlyArray<[RegExp, string | ((...m: string[]) => string)]> = [
  // PEM blocks, terminated or cut off by the excerpt.
  [/-----BEGIN [A-Z0-9 ]{1,40}-----[\s\S]*?(?:-----END [A-Z0-9 ]{1,40}-----|$)/g, MASK],
  // JWTs.
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]*)?/g, MASK],
  // scheme://user:password@host — keep the scheme and host.
  [/\b([a-z][a-z0-9+.-]{0,20}:\/\/)[^/\s:@]{0,200}:[^/\s@]{1,500}@/gi, `$1${MASK}@`],
  // Authorization headers and schemes.
  [/\b(authorization|proxy-authorization)(\s*[:=]\s*)(?:(bearer|basic|token|digest)\s+)?[^\s"',;]{4,}/gi, (_m, k, sep, scheme) => `${k}${sep}${scheme ? `${scheme} ` : ""}${MASK}`],
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${MASK}`],
  // Well-known token formats.
  [/\b(?:sk|pk|rk)-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}/g, MASK],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, MASK],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, MASK],
  [/\bglpat-[A-Za-z0-9_-]{16,}/g, MASK],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, MASK],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, MASK],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, MASK],
  [/\b(?:zid_sk|hf_sk|npm)_[A-Za-z0-9_-]{16,}/g, MASK],
  // key=value, key: value, "key": "value" — only for keys that name a secret.
  [
    new RegExp(`(^|[^A-Za-z0-9])(${SECRET_KEY})(["']?\\s*[:=]\\s*)("[^"\\n]{1,500}"|'[^'\\n]{1,500}'|[^\\s"',;)}\\]]{1,500})`, "gim"),
    (_m, pre, key, sep) => `${pre}${key}${sep}${MASK}`,
  ],
];

export function redactOutput(text: string): string {
  if (!text) return text;
  let out = text;
  for (const [pattern, replacement] of RULES) {
    out = out.replace(pattern, replacement as string);
  }
  return out;
}
