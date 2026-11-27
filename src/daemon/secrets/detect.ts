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
  /**
   * A format that can't be mistaken for anything else (a vendor's token, a JWT, a key): safe to
   * remember and match bare from then on. A value found only by the name it sits under
   * (`password: …`) isn't: the same word is often ordinary text elsewhere.
   */
  distinct: boolean;
}

interface Pattern {
  kind: string;
  re: RegExp;
  /**
   * A value that is plainly not a credential is left as it is: a placeholder; a "word" (a type,
   * code: another name, a call); an "env" value (as a word, but a snake_case or camelCase value
   * of an environment variable is a password like any other).
   */
  check?: "placeholder" | "word" | "env" | "opaque";
  /** See {@link SecretSpan.distinct}. */
  distinct?: boolean;
  /** Only where the match's line also matches this (checked after the match, so the pattern stays linear). */
  line?: RegExp;
  /**
   * What comes before the match, checked in code rather than by a leading lookbehind or class
   * (which an engine tries at every position: twenty times slower on Bun 1.3): the match may
   * reach back over up to `max` of `chars` (a name's start), and the character before that must
   * match `before` (or be the text's start).
   */
  back?: { chars?: RegExp; max?: number; before: RegExp; escapes?: boolean };
  /** The value's length, when the pattern's runs leave it unbounded: outside it, not a value this pattern finds. */
  length?: [number, number];
  /**
   * The value, matched (sticky) just after `re`, which then finds only what comes before it: one
   * regex with both runs uncompiled on Bun 1.3, two hundred times slower over the whole text.
   */
  value?: RegExp;
}

/** Not inside a longer token. */
const WORD_BOUNDARY = { before: /[^A-Za-z0-9_]/ };

/** Nor just after. */
const E = "(?![A-Za-z0-9_])";

const vendor = (kind: string, body: string): Pattern => ({ kind, re: new RegExp(`(?<secret>${body})${E}`, "g"), distinct: true, back: WORD_BOUNDARY });

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
  // codeoid's own: the blackboard, memory and sandbox MCP tokens, a routine's API token.
  vendor("codeoid-token", "(?:bbt|mmt|sbt)_[0-9a-f]{32}|rt_[0-9a-f]{12}_[A-Za-z0-9_-]{32}"),
  vendor("highflame-key", "hf_sk_[A-Za-z0-9_-]{16,200}"),
];

/** Credentials recognised by where they sit. */
const STRUCTURAL: Pattern[] = [
  { kind: "bearer-token", re: /bearer[ \t]+(?<secret>[A-Za-z0-9._~+/-]{16,4000}=*)/gi, check: "placeholder", distinct: true, back: WORD_BOUNDARY },
  { kind: "authorization", re: /authorization["']?[ \t]*[:=][ \t]*["']?(?:basic|token)[ \t]+(?<secret>[A-Za-z0-9._~+/-]{8,4000}=*)/gi, check: "placeholder", distinct: true, back: WORD_BOUNDARY },
  // curl's `-u user:password`: the line must run curl (checked in findSecrets: `line: /\bcurl\b/`).
  { kind: "password", re: /(?:^|[ \t])(?:-u|--user)(?:=|[ \t]+)["']?[^:\s"']{0,200}:(?<secret>[^\s"']{1,500})/gm, check: "placeholder", line: /\bcurl\b/ },
  // A .netrc entry's password.
  { kind: "password", re: /(?:^|\s)machine\s+\S{1,253}\s+(?:login\s+\S{1,200}\s+)?password\s+(?<secret>\S{1,500})/g, check: "placeholder" },
  { kind: "password", re: /^[ \t]*password[ \t]+(?<secret>\S{1,500})[ \t]*$/gm, check: "placeholder" },
  // A URL's userinfo password, found from its `://` (the scheme before it, whatever it is).
  { kind: "password", re: /:\/\/[^\s/?#@"'`<>:]{0,200}:(?<secret>[^\s/?#@"'`<>]{1,500})@/g, check: "placeholder", back: { chars: /[a-z0-9+.-]/i, max: 32, before: /[^A-Za-z0-9_]/ } },
  { kind: "password", re: /(?:^|[?&;\s-])(?:password|pwd)=(?<secret>"[^"\n]{0,500}"|'[^'\n]{0,500}'|[^&;\s"'`]{0,500}[^&;\s"'`,])/gim, check: "placeholder" },
  { kind: "aws-secret", re: /aws_secret_access_key["']?(?:[ \t]*[:=][ \t]*|[ \t]+)["']?(?<secret>[A-Za-z0-9/+]{40,100})/gi, distinct: true },
  { kind: "twilio-key", re: new RegExp(`(?<secret>SK[0-9a-fA-F]{32})${E}`, "g"), distinct: true, back: WORD_BOUNDARY },
];

/** The words an environment variable's name ends with when it holds a credential. */
/** The word an environment variable's name ends with; its start is found in code (`ENV_BACK`). */
const ENV_NAME = "(?:SECRET|TOKEN|PASSWORD|PASSWD|PASSPHRASE|_PWD|API_?KEY|APIKEY|PRIVATE_KEY|ACCESS_KEY|SECRET_KEY|CREDENTIALS?|AUTH)(?![A-Za-z0-9_])";
const ENV_BACK = { chars: /[A-Z0-9_]/, max: 100, before: /[^A-Za-z0-9_]/ };
/** A code name's start: any word characters, dots and dashes, after something that isn't one (a quote, a space). */
const CODE_BACK = { chars: /[A-Za-z0-9_.-]/, max: 100, before: /[^A-Za-z0-9_.-]/ };
/** The same as code, JSON and config files spell them; not `auth` alone, nor `tokens` (`max_tokens`). */
const CODE_WORD = "(?:passw(?:or)?d|passphrase|secret|api[_-]?key|private[_-]?key|access[_-]?key|(?:auth|access|refresh|bearer|id|session)[_-]?token|token)";
/** One character of an unquoted value: not one that ends it, a `&` unless another `name=` follows, a `\` unless an escape does. */
// Runs of plain characters, not one alternation per character (twenty times slower on Bun 1.3);
// the value's length is bounded in code (`length`).
const VALUE_RUN = `(?:[^\\s"'\`,;)\\]}{(<>&\\\\]+|&(?![A-Za-z_][\\w.-]*=)|\\\\(?![nrt"\\\\]))+`;
const DOTENV_RUN = `(?:[^\\s#"&\\\\]+|&(?![A-Za-z_][\\w.-]*=)|\\\\(?![nrt"\\\\]))*`;
/** In a line-anchored pattern (tried only at line starts): the name's start written out. */
const CODE_NAME = `[\\w.-]{0,100}?${CODE_WORD}`;
const SEPARATOR = `["'\\]]?[ \\t]*(?::=|=>|\\?=|[=:])[ \\t]*`;
const QUOTED = `"(?:[^"\\\\\\n]|\\\\.){6,1000}"|'[^'\\n]{6,1000}'`;

/** Values assigned to a name a credential is kept under. */
const NAMED: Pattern[] = [
  // An environment variable's value: stops at a `&` that starts another `name=` (a query string),
  // and at an escape in JSON text (`\n`); a password may hold `&` or `\` otherwise.
  {
    kind: "credential",
    re: new RegExp(`${ENV_NAME}${SEPARATOR}`, "g"),
    value: new RegExp(`${QUOTED}|${VALUE_RUN}`, "y"),
    check: "env",
    back: ENV_BACK,
    length: [6, 1000],
  },
  // An HTTP header named for a credential, unquoted (`-H "X-Api-Key: abc…"`, `api-key: …`).
  {
    kind: "credential",
    re: /(?:api-?key|auth-?token|access-?token|secret|password|token)[ \t]*:[ \t]*(?<secret>[^\s"',;!][^\s"',;]{5,1000})/gi,
    check: "opaque",
    back: { chars: /[A-Za-z0-9-]/, max: 64, before: /[\s"']/ },
  },
  // A URL's query value named for a credential (`?api_key=…`, `&access_token=…`).
  {
    kind: "credential",
    re: /[?&](?:api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|token|client[_-]?secret|secret|password|pwd|sig|signature|x-amz-signature|x-amz-credential|x-amz-security-token|x-goog-signature)=(?<secret>[^&#\s"'<>]{6,1000})/gi,
    check: "opaque",
  },
  // A client's password flag glued to its value (`mysql -pHunter2`), or apart (`sshpass -p …`, `docker login -p …`).
  // The client is the program run (not a word elsewhere: `mysql:8` as an image), its -p among its own options.
  { kind: "password", re: /(?:mysql|mysqldump|mysqladmin|mariadb)[ \t](?:[^\n|;&-]|-[^p\n|;&]){0,300}?-p(?<secret>[^\s"'-][^\s"']{0,200})/g, check: "placeholder", back: { before: /[\s;&|(]/ } },
  { kind: "password", re: /sshpass[ \t]+-p[ \t]*(?<secret>[^\s"'-][^\s"']{0,200})/g, check: "placeholder", back: { before: /[\s;&|(]/ } },
  { kind: "password", re: /(?:docker|podman|nerdctl|helm)[ \t]+(?:registry[ \t]+)?login\b[^\n|;&]{0,300}?[ \t]-p[ \t]+(?<secret>[^\s"'-][^\s"']{0,200})/g, check: "placeholder", back: { before: /[\s;&|(]/ } },
  { kind: "credential", re: new RegExp(`${CODE_WORD}${SEPARATOR}(?<secret>${QUOTED})`, "gi"), check: "word", back: CODE_BACK },
  {
    kind: "password",
    re: /(?:^|[ \t])--passw(?:or)?d[ \t]+(?<secret>"(?:[^"\\\n]|\\.){1,500}"|'[^'\n]{1,500}'|(?:[^\s"'\\<>[{()|&;`-][^\s"'\\|&;<>()`]{0,500}?)?[^A-Za-z\s"'\\.,:;()[\]{}<>|&`-][^\s"'\\|&;<>()`]{0,500})(?=[\s"';&|)\\]|$)/g,
    check: "placeholder",
  },
  // YAML-like `name: value`: the value runs to the end of the line (`password: correct horse`).
  {
    kind: "credential",
    // A trailing comment isn't part of it; `=` inside is (base64).
    re: new RegExp(`^\\+?[ \\t]*(?:-[ \\t]+)?["']?${CODE_NAME}["']?[ \\t]*:[ \\t]*(?<secret>[^\\s"'#|>&*!{}\\[\\],=][^\\n#"]{0,1000})(?:#[^\\n]*)?$`, "gim"),
    check: "word",
  },
  // `.env`/INI-like `name=value`: up to the first space (`PGPASSWORD=x psql -h db` is a command).
  {
    kind: "credential",
    re: new RegExp(`^\\+?[ \\t]*["']?${CODE_NAME}["']?[ \\t]*=[ \\t]*(?<secret>[^\\s"'#|>&*!{}\\[\\],=]${DOTENV_RUN})`, "gim"),
    length: [1, 1001],
    check: "env",
  },
];

/** With indices (`d`), so the `secret` group's position is exact. */
const PATTERNS: readonly Pattern[] = [...VENDOR, ...STRUCTURAL, ...NAMED].map((p) => ({ ...p, re: new RegExp(p.re.source, p.re.flags.includes("d") ? p.re.flags : `${p.re.flags}d`) }));

const KEY_HEADER = /-----BEGIN[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----/y;
const KEY_FOOTER = /^-----END[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----/;
/** What a key's armour holds: base64 lines, PEM headers (`Proc-Type: 4,ENCRYPTED`), escaped newlines in JSON. */
const KEY_BODY = /^[A-Za-z0-9+/=\s:,.\\-]{16,64000}$/;
const MAX_KEY_BODY = 64_000;

/**
 * Private keys, by their armour: the body between a BEGIN line and its END
 * line (or the end of the text, for clipped output), when it is what armour
 * holds — so a header string in source code never swallows the code after
 * it. Found with indexOf, one forward pass: a text of repeated headers costs
 * no more than its length.
 */
function privateKeySpans(text: string): SecretSpan[] {
  const out: SecretSpan[] = [];
  let from = 0;
  let nextEnd = -2;
  while (true) {
    const begin = text.indexOf("-----BEGIN", from);
    if (begin < 0) break;
    from = begin + 10;
    KEY_HEADER.lastIndex = begin;
    const header = KEY_HEADER.exec(text);
    if (!header) continue;
    const bodyStart = begin + header[0].length;
    if (nextEnd !== -1 && nextEnd < bodyStart) nextEnd = text.indexOf("-----END", bodyStart);
    let bodyEnd: number;
    if (nextEnd >= 0 && nextEnd - bodyStart <= MAX_KEY_BODY && KEY_FOOTER.test(text.slice(nextEnd, nextEnd + 140))) bodyEnd = nextEnd;
    else if (text.length - bodyStart <= MAX_KEY_BODY) bodyEnd = text.length;
    else continue;
    if (!KEY_BODY.test(text.slice(bodyStart, bodyEnd))) continue;
    out.push({ start: bodyStart, end: bodyEnd, kind: "private-key", distinct: true });
    from = bodyEnd;
  }
  return out;
}

const JWT_CHAR = /[A-Za-z0-9_-]/;

/** Where the run of base64url characters starting at `i` ends. */
function runEnd(text: string, i: number): number {
  let q = i;
  while (q < text.length && JWT_CHAR.test(text[q]!)) q++;
  return q;
}

/**
 * JSON web tokens: `eyJ…` header, `.`, `eyJ…` payload, `.`, a signature, each
 * part its run of base64url characters and of bounded length, after a
 * non-word character or an escaped newline or tab in JSON text. Found in one
 * forward pass: a `eyJ` inside a run already looked at shares its end, so a
 * text of repeated `eyJ` costs no more than its length (the regex rescanned
 * each one: seconds on Bun 1.3).
 */
function jwtSpans(text: string): SecretSpan[] {
  const out: SecretSpan[] = [];
  let from = 0;
  let known = -1;
  let knownEnd = -1;
  while (true) {
    const i = text.indexOf("eyJ", from);
    if (i < 0) break;
    from = i + 3;
    if (i > 0) {
      const prev = text[i - 1]!;
      const escaped = i > 1 && text[i - 2] === "\\" && "nrt".includes(prev);
      if (!escaped && JWT_CHAR.test(prev)) continue;
    }
    // A start inside a run already measured ends where it ends.
    const headEnd = i < knownEnd && i > known ? knownEnd : runEnd(text, i);
    known = i;
    knownEnd = headEnd;
    if (headEnd - i < 13 || headEnd - i > 4003 || text[headEnd] !== ".") {
      from = Math.max(from, headEnd);
      continue;
    }
    const p = headEnd + 1;
    if (!text.startsWith("eyJ", p)) continue;
    const payloadEnd = runEnd(text, p);
    if (payloadEnd - p < 13 || payloadEnd - p > 8003 || text[payloadEnd] !== ".") continue;
    const sigEnd = runEnd(text, payloadEnd + 1);
    const sig = sigEnd - payloadEnd - 1;
    if (sig < 10 || sig > 2000) continue;
    out.push({ start: i, end: sigEnd, kind: "jwt", distinct: true });
    from = sigEnd;
  }
  return out;
}

/** The references codeoid writes itself: never taken for a secret again. */
const OWN_REFERENCE = /^‹(?:credential|secret|output withheld|not stored)[:\s›]/;

const STAND_INS = new Set([
  "changeme", "change_me", "change-me", "example", "password", "passwd", "secret", "token", "your_password", "your-password",
  "yourpassword", "your_token", "your_api_key", "redacted", "placeholder", "dummy", "undefined", "required", "optional",
  "enabled", "disabled", "on", "off", "yes", "no", "bearer", "basic", "auto", "none", "default", "test", "local", "localhost",
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
/** A quoted value that is shell code, not a value: a command's quoted pattern (`='^KEY=' .env | cut …`). */
function isQuotedCode(value: string): boolean {
  return /^["']/.test(value) && /\s/.test(value) && /\s\|\s|\$\(|\s>|;\s|&&|\|\||\s-[A-Za-z]\b/.test(value);
}

function isWord(raw: string, identifiers = true): boolean {
  const value = raw.trim();
  if (isPlaceholder(value)) return true;
  if (isQuotedCode(value)) return true;
  if (value.startsWith('"') || value.startsWith("'")) return false;
  // Code, not a value: another name — a dotted path or a call (`self.token`, `config.apiKey`,
  // `getToken()`), a snake_case or camelCase identifier (`api_key`, `idToken`). A plain word
  // (`Violetmeadow`, `postgres`) can be a password, and stays one.
  const bare = value.replace(/[,;)]+$/, "");
  if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+(?:\(\))?$/.test(bare) || /^[A-Za-z_$][\w$]*\(\)$/.test(bare)) return true;
  if (identifiers && /^[A-Za-z_$][\w$]*$/.test(bare) && (bare.includes("_") || /[a-z][A-Z]/.test(bare)) && !/[0-9]/.test(bare)) return true;
  if (/[0-9]/.test(value)) return false;
  return /[<>[\]&:(){},;]/.test(value) || TYPES.has(value.toLowerCase());
}

/**
 * Every credential found in `text`, by position, overlaps merged (the
 * earliest start wins, and a span reaches as far as any overlapping one).
 * `deadline` (a `performance.now()` value) is checked between patterns:
 * past it, null — the caller must not store what couldn't be checked.
 */
export function findSecrets(text: string, deadline = Number.POSITIVE_INFINITY): SecretSpan[] | null {
  const spans: SecretSpan[] = [...privateKeySpans(text), ...jwtSpans(text)];
  for (const p of PATTERNS) {
    if (performance.now() > deadline) return null;
    p.re.lastIndex = 0;
    let n = 0;
    /** Per pattern: each line's `line` test, once. */
    const lineCache = new Map<number, boolean>();
    for (const m of text.matchAll(p.re)) {
      if (++n % 256 === 0 && performance.now() > deadline) return null;
      let raw = m.groups?.secret;
      let at = m.indices?.groups?.secret;
      if (p.value) {
        p.value.lastIndex = m.index! + m[0].length;
        const v = p.value.exec(text);
        if (!v) continue;
        raw = v[0];
        at = [v.index, v.index + v[0].length];
      }
      if (raw === undefined || raw.length === 0 || !at) continue;
      // A value to the end of its line loses the spaces after it.
      const secret = raw.replace(/[ \t]+$/, "");
      if (secret.length === 0) continue;
      if (p.length && (secret.length < p.length[0] || secret.length > p.length[1])) continue;
      if (p.check === "placeholder" && isPlaceholder(secret)) continue;
      if (p.check === "word" && isWord(secret)) continue;
      // `NAME=value` (a .env file, a shell) holds a value whatever it looks like; `name = value`,
      // spaced, is code, where another name is more likely than a password.
      if (p.check === "env" && isWord(secret, /[ \t]/.test(text[at[0] - 1] ?? ""))) continue;
      // An unquoted header or query value: only one that looks like a key (a digit, or both cases),
      // not a status word (`token: refreshed`, `?token=nextpage`).
      if (p.check === "opaque" && (isWord(secret) || !(/[0-9]/.test(secret) && /[A-Za-z]/.test(secret)) && !(/[a-z]/.test(secret) && /[A-Z]/.test(secret)))) continue;
      if (p.back) {
        let i = m.index!;
        for (let k = 0; p.back.chars && k < (p.back.max ?? 0) && i > 0 && p.back.chars.test(text[i - 1]!); k++) i--;
        if (i > 0) {
          const prev = text[i - 1]!;
          // `escapes`: also after an escaped newline or tab in JSON text.
          const escaped = p.back.escapes === true && i > 1 && text[i - 2] === "\\" && "nrt".includes(prev);
          if (!escaped && !p.back.before.test(prev)) continue;
        }
      }
      if (p.line) {
        const lineStart = text.lastIndexOf("\n", at[0]) + 1;
        let ok = lineCache.get(lineStart);
        if (ok === undefined) {
          const lineEnd = text.indexOf("\n", at[0]);
          ok = p.line.test(text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd));
          lineCache.set(lineStart, ok);
        }
        if (!ok) continue;
      }
      // A quoted value keeps its quotes: `"api_key": "‹secret:…›"` still reads as JSON.
      const quoted = secret.length >= 2 && (secret[0] === '"' || secret[0] === "'") && secret.at(-1) === secret[0];
      spans.push({ start: at[0] + (quoted ? 1 : 0), end: at[0] + secret.length - (quoted ? 1 : 0), kind: p.kind, distinct: p.distinct === true });
    }
  }
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: SecretSpan[] = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && s.start < last.end) {
      last.end = Math.max(last.end, s.end);
      last.distinct = last.distinct && s.distinct;
    }
    else merged.push({ ...s });
  }
  return merged;
}
