/**
 * Credentials found by shape (docs/secrets-and-memory-design.md §2.3): a
 * service's token format, a private key's armour, a URL's password, an
 * `Authorization` header, a value assigned to a name like `DB_PASSWORD` or
 * `"api_key"`.
 *
 * The tables follow atuin's (`atuin-common/src/secrets.rs`, `vendors.rs`,
 * `structural.rs`; MIT), which follow gitleaks' (MIT) where a format has a
 * prefix of its own. Only known shapes and values bound to secret-named keys
 * are found, never "looks random", so hashes, ids and paths survive. Each
 * pattern's `secret` group is the part replaced; a name or flag around it is
 * kept (`DB_PASSWORD=‹secret:password:9c2e41aa›`).
 *
 * Every pattern is linear (no nested quantifiers), and each match is bounded,
 * so a scan is proportional to the text.
 */

export interface SecretSpan {
  start: number;
  end: number;
  /** A slug for the reference: `github-token`, `password`, `private-key`, … */
  kind: string;
}

interface Pattern {
  kind: string;
  re: RegExp;
  /** A structural or named value that is plainly not a credential is left as it is. */
  check?: "placeholder" | "word";
}

/** Not inside a longer token: no letter, digit or `_` just before. */
const B = "(?<![A-Za-z0-9_])";
/** Nor just after. */
const E = "(?![A-Za-z0-9_])";

const vendor = (kind: string, body: string): Pattern => ({ kind, re: new RegExp(`${B}(?<secret>${body})${E}`, "g") });

/** Formats with a prefix of their own: they can't be mistaken for anything else. */
const VENDOR: Pattern[] = [
  vendor("anthropic-key", "sk-ant-(?:api|admin|oat|ort)[0-9]{2}-[A-Za-z0-9_-]{60,300}"),
  vendor("openai-key", "sk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,300}|sk-[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20}"),
  vendor("openrouter-key", "sk-or-v1-[a-f0-9]{64}"),
  vendor("groq-key", "gsk_[A-Za-z0-9]{52}"),
  vendor("xai-key", "xai-[A-Za-z0-9]{60,200}"),
  vendor("perplexity-key", "pplx-[A-Za-z0-9]{48}"),
  vendor("pinecone-key", "pcsk_[A-Za-z0-9_]{50,200}"),
  vendor("langsmith-key", "lsv2_(?:pt|sk)_[a-f0-9]{32}_[a-f0-9]{10}"),
  vendor("google-key", "AIza[0-9A-Za-z_-]{35}"),
  vendor("huggingface-token", "hf_[A-Za-z]{34}|api_org_[A-Za-z]{34}"),
  vendor("digitalocean-token", "do[opr]_v1_[a-f0-9]{64}"),
  vendor("sendgrid-key", "SG\\.[A-Za-z0-9_-]{22}\\.[A-Za-z0-9_-]{43}"),
  vendor("brevo-key", "xkeysib-[a-f0-9]{64}-[A-Za-z0-9]{16}"),
  vendor("linear-key", "lin_api_[A-Za-z0-9]{40}"),
  vendor("doppler-token", "dp\\.(?:pt|st|ct|sa|scim|audit)\\.[A-Za-z0-9]{40,44}"),
  vendor("shopify-token", "shp(?:at|ca|pa|ss)_[a-fA-F0-9]{32}"),
  vendor("databricks-token", "dapi[a-f0-9]{32}(?:-[0-9])?"),
  vendor("pypi-token", "pypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{50,300}"),
  vendor("rubygems-key", "rubygems_[a-f0-9]{48}"),
  vendor("notion-token", "ntn_[0-9]{11}[A-Za-z0-9]{35}"),
  vendor("atlassian-token", "ATATT3[A-Za-z0-9_=-]{60,300}"),
  vendor("age-key", "AGE-SECRET-KEY-1[QPZRY9X8GF2TVDW0S3JN54KHCE6MUA7L]{58}"),
  vendor("onepassword-token", "ops_eyJ[A-Za-z0-9+/]{60,2000}={0,3}"),
  vendor(
    "slack-token",
    "xox[bpe](?:-[0-9]{10,13}){2,3}-[A-Za-z0-9-]{24,34}|xapp-[0-9]-[A-Z0-9]{1,20}-[0-9]{1,20}-[a-z0-9]{1,100}|xoxe(?:\\.xox[bp])?-[0-9]-[A-Za-z0-9]{60,300}|xox[ar]-(?:[0-9]-)?[0-9a-zA-Z]{8,48}|xox[os]-[0-9]{1,20}-[0-9]{1,20}-[0-9]{1,20}-[a-fA-F0-9]{1,100}",
  ),
  vendor("slack-webhook", "T[A-Za-z0-9_]{8}/B[A-Za-z0-9_]{8}/[A-Za-z0-9_]{24}"),
  vendor(
    "gitlab-token",
    "glpat-[A-Za-z0-9_-]{20,100}(?:\\.[0-9a-z]{9})?|glptt-[0-9a-f]{40}|glrt-[A-Za-z0-9_-]{20,100}(?:\\.[0-9a-z]{9})?|gl(?:dt|ft|soat|ffct)-[A-Za-z0-9_-]{20}|glcbt-[A-Za-z0-9]{1,5}_[A-Za-z0-9_-]{20}|glagent-[A-Za-z0-9_-]{50}|glimt-[A-Za-z0-9_-]{25}|gloas-[A-Za-z0-9_-]{64}|GR1348941[A-Za-z0-9_-]{20}",
  ),
  vendor("grafana-token", "glc_[A-Za-z0-9+/]{32,400}={0,3}|glsa_[A-Za-z0-9]{32}_[A-Fa-f0-9]{8}|eyJrIjoi[A-Za-z0-9]{60,400}={0,3}"),
  vendor("sentry-token", "sntryu_[a-f0-9]{64}|sntrys_eyJ[A-Za-z0-9+/=_]{40,400}"),
  vendor("vault-token", "hvs\\.[A-Za-z0-9_-]{60,300}|hvb\\.[A-Za-z0-9_-]{60,300}"),
  vendor("terraform-token", "[A-Za-z0-9]{14}\\.atlasv1\\.[A-Za-z0-9_=-]{60,70}"),
  vendor("planetscale-token", "pscale_(?:tkn|oauth|pw)_[A-Za-z0-9_=.-]{32,64}"),
  vendor("postman-key", "PMAK-[a-fA-F0-9]{24}-[a-fA-F0-9]{34}"),
  vendor("readme-key", "rdme_[a-z0-9]{70}"),
  vendor("prefect-key", "pnu_[A-Za-z0-9]{36}"),
  vendor("heroku-key", "HRKU-AA[A-Za-z0-9_-]{58}"),
  vendor("supabase-key", "sb_secret_[A-Za-z0-9_-]{31,100}|sbp_[a-f0-9]{40}"),
  vendor("artifactory-key", "AKCp[A-Za-z0-9]{69}"),
  vendor("bedrock-key", "ABSK[A-Za-z0-9+/]{60,400}={0,2}"),
  vendor("flyio-token", "fo1_[A-Za-z0-9_-]{43}|fm[12][ar]?_[A-Za-z0-9+/]{60,1000}={0,3}"),
  vendor("dynatrace-token", "dt0c01\\.[A-Za-z0-9]{24}\\.[A-Za-z0-9]{64}"),
  vendor("square-token", "sq0atp-[A-Za-z0-9_-]{22,60}|sq0csp-[A-Za-z0-9_-]{43}"),
  vendor("stripe-key", "(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{24,200}|sk_prod_[A-Za-z0-9]{24,200}"),
  vendor("dockerhub-token", "dckr_pat_[A-Za-z0-9_-]{27}"),
  vendor("tailscale-key", "tskey-(?:api|auth|client|scim|webhook)-[A-Za-z0-9]{8,40}-[A-Za-z0-9]{20,100}"),
  vendor("azure-secret", "[A-Za-z0-9_~.]{3}[0-9]Q~[A-Za-z0-9_~.-]{31,34}"),
  vendor("telegram-token", "[0-9]{8,10}:AA[A-Za-z0-9_-]{33}"),
  vendor("discord-webhook", "https://(?:ptb\\.|canary\\.)?discord(?:app)?\\.com/api/webhooks/[0-9]{1,30}/[A-Za-z0-9_-]{60,100}"),
  vendor("openshift-token", "sha256~[A-Za-z0-9_-]{43}"),
  vendor("aws-key-id", "A[KS]IA[0-9A-Z]{16}"),
  vendor("github-token", "gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255}"),
  vendor("netlify-token", "nf[pcoub]_[0-9a-zA-Z]{36}"),
  vendor("npm-token", "npm_[A-Za-z0-9]{36}"),
  vendor("pulumi-token", "pul-[0-9a-f]{40}"),
  vendor("zeroid-key", "zid_sk_[A-Za-z0-9_-]{16,200}"),
  vendor("highflame-key", "hf_sk_[A-Za-z0-9_-]{16,200}"),
];

/** Credentials recognised by where they sit. */
const STRUCTURAL: Pattern[] = [
  {
    kind: "private-key",
    re: /-----BEGIN[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----(?<secret>[\s\S]{1,20000}?)(?:-----END[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----|$)/g,
  },
  { kind: "jwt", re: new RegExp(`(?:${B}|(?<=\\\\[nrt]))(?<secret>eyJ[A-Za-z0-9_-]{10,4000}\\.eyJ[A-Za-z0-9_-]{10,8000}\\.[A-Za-z0-9_-]{10,2000})`, "g") },
  { kind: "bearer-token", re: /(?<![A-Za-z0-9_])bearer[ \t]+(?<secret>[A-Za-z0-9._~+/-]{16,4000}=*)/gi, check: "placeholder" },
  { kind: "authorization", re: /(?<![A-Za-z0-9_])authorization["']?[ \t]*[:=][ \t]*["']?(?:basic|token)[ \t]+(?<secret>[A-Za-z0-9._~+/-]{8,4000}=*)/gi, check: "placeholder" },
  { kind: "password", re: /(?<![A-Za-z0-9_])curl\b[^\n]{0,2000}?[ \t](?:-u|--user)(?:=|[ \t]+)["']?[^:\s"']{0,200}:(?<secret>[^\s"']{1,500})/g, check: "placeholder" },
  { kind: "password", re: /(?<![A-Za-z0-9_])[a-z][a-z0-9+.-]{1,31}:\/\/[^\s/?#@"'`<>:]{0,200}:(?<secret>[^\s/?#@"'`<>]{1,500})@/gi, check: "placeholder" },
  { kind: "password", re: /(?:^|[?&;\s-])(?:password|pwd)=(?<secret>"[^"\n]{0,500}"|'[^'\n]{0,500}'|[^&;\s"'`]{0,500}[^&;\s"'`,])/gim, check: "placeholder" },
  { kind: "aws-secret", re: /aws_secret_access_key["']?(?:[ \t]*[:=][ \t]*|[ \t]+)["']?(?<secret>[A-Za-z0-9/+]{40,100})/gi },
  { kind: "twilio-key", re: new RegExp(`${B}(?<secret>SK[0-9a-fA-F]{32})${E}`, "g") },
];

/** The words an environment variable's name ends with when it holds a credential. */
const ENV_NAME = "(?<![A-Za-z0-9_])[A-Z0-9_]{0,100}(?:SECRET|TOKEN|PASSWORD|PASSWD|PASSPHRASE|_PWD|API_?KEY|APIKEY|PRIVATE_KEY|ACCESS_KEY|SECRET_KEY|CREDENTIALS?|AUTH)S?(?![A-Za-z0-9_])";
/** The same as code, JSON and config files spell them; not `auth` alone, nor `tokens` (`max_tokens`). */
const CODE_NAME =
  "[\\w.-]{0,100}?(?:passw(?:or)?d|passphrase|secret|api[_-]?key|private[_-]?key|access[_-]?key|(?:auth|access|refresh|bearer|id|session)[_-]?token|token)";
const SEPARATOR = `["'\\]]?[ \\t]*(?::=|=>|\\?=|[=:])[ \\t]*`;
const QUOTED = `"(?:[^"\\\\\\n]|\\\\.){6,1000}"|'[^'\\n]{6,1000}'`;

/** Values assigned to a name a credential is kept under. */
const NAMED: Pattern[] = [
  { kind: "credential", re: new RegExp(`${ENV_NAME}${SEPARATOR}(?<secret>${QUOTED}|[^\\s"'\`,;)\\]}{(<>]{6,1000})`, "g"), check: "word" },
  { kind: "credential", re: new RegExp(`(?:^|[^A-Za-z0-9_.-])["']?${CODE_NAME}${SEPARATOR}(?<secret>${QUOTED})`, "gi"), check: "word" },
  {
    kind: "password",
    re: /(?:^|[ \t])--passw(?:or)?d[ \t]+(?<secret>"(?:[^"\\\n]|\\.){1,500}"|'[^'\n]{1,500}'|(?:[^\s"'\\<>[{()|&;`-][^\s"'\\|&;<>()`]{0,500}?)?[^A-Za-z\s"'\\.,:;()[\]{}<>|&`-][^\s"'\\|&;<>()`]{0,500})(?=[\s"';&|)\\]|$)/g,
    check: "placeholder",
  },
  {
    kind: "credential",
    re: new RegExp(`^\\+?[ \\t]*(?:-[ \\t]+)?["']?${CODE_NAME}["']?[ \\t]*[:=][ \\t]*(?<secret>[^\\s"'#|>&*!{}\\[\\],=][^\\n#="]{0,1000}?)[ \\t]*$`, "gim"),
    check: "word",
  },
];

/** With indices (`d`), so the `secret` group's position is exact. */
const PATTERNS: readonly Pattern[] = [...VENDOR, ...STRUCTURAL, ...NAMED].map((p) => ({ ...p, re: new RegExp(p.re.source, p.re.flags.includes("d") ? p.re.flags : `${p.re.flags}d`) }));

/** The references codeoid writes itself: never taken for a secret again. */
const OWN_REFERENCE = /^‹(?:credential|secret|output withheld|not stored)[:\s›]/;

const STAND_INS = new Set([
  "changeme", "change_me", "change-me", "example", "password", "passwd", "secret", "token", "your_password", "your-password",
  "yourpassword", "your_token", "your_api_key", "redacted", "placeholder", "dummy", "undefined", "required", "optional",
]);
const TYPES = new Set(["str", "string", "bool", "boolean", "int", "integer", "number", "float", "any", "object", "bytes", "char", "none", "null", "nil", "true", "false"]);

/** A value that plainly isn't a credential: a reference to one (`$TOKEN`, `${{ secrets.X }}`), a stand-in, a run of one character. */
export function isPlaceholder(raw: string): boolean {
  const value = raw.trim().replace(/^["'\\]+|["'\\]+$/g, "").trim();
  if (value.length === 0) return true;
  if (OWN_REFERENCE.test(value)) return true;
  const lower = value.toLowerCase();
  if (["$", "%", "{{", "os.environ", "process.env", "env.", "env(", "env[", "getenv"].some((r) => lower.startsWith(r))) return true;
  if (value.length > 2 && value.startsWith("<") && value.endsWith(">") && /^[A-Za-z_\- ]+$/.test(value.slice(1, -1))) return true;
  const first = value[0]!;
  if (value.length >= 3 && "*x.-•".includes(first) && [...value].every((c) => c === first)) return true;
  return STAND_INS.has(lower);
}

/** {@link isPlaceholder}, or, unquoted, a type or code: what a name's value in code is far more often than a credential. */
function isWord(raw: string): boolean {
  const value = raw.trim();
  if (isPlaceholder(value)) return true;
  if (value.startsWith('"') || value.startsWith("'") || /[0-9]/.test(value)) return false;
  return /[<>[\]&:(){},;]/.test(value) || TYPES.has(value.toLowerCase());
}

/**
 * Every credential found in `text`, by position, overlaps merged (the
 * earliest start wins, and a span reaches as far as any overlapping one).
 * `deadline` (a `performance.now()` value) is checked between patterns:
 * past it, null — the caller must not store what couldn't be checked.
 */
export function findSecrets(text: string, deadline = Number.POSITIVE_INFINITY): SecretSpan[] | null {
  const spans: SecretSpan[] = [];
  for (const p of PATTERNS) {
    if (performance.now() > deadline) return null;
    p.re.lastIndex = 0;
    for (const m of text.matchAll(p.re)) {
      const secret = m.groups?.secret;
      const at = m.indices?.groups?.secret;
      if (secret === undefined || secret.length === 0 || !at) continue;
      if (p.check === "placeholder" && isPlaceholder(secret)) continue;
      if (p.check === "word" && isWord(secret)) continue;
      // A quoted value keeps its quotes: `"api_key": "‹secret:…›"` still reads as JSON.
      const quoted = secret.length >= 2 && (secret[0] === '"' || secret[0] === "'") && secret.at(-1) === secret[0];
      spans.push({ start: at[0] + (quoted ? 1 : 0), end: at[1] - (quoted ? 1 : 0), kind: p.kind });
    }
  }
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: SecretSpan[] = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && s.start < last.end) last.end = Math.max(last.end, s.end);
    else merged.push({ ...s });
  }
  return merged;
}
