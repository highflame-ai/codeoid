/**
 * GitHub as a source of loop triggers, read through the `gh` CLI the owner is
 * already signed in to. Nothing here decides anything: it turns `gh` output
 * into typed records and leaves dedupe, coalescing, and authorization to the
 * watch service.
 *
 * `gh` runs with a minimal environment — PATH, HOME, and gh's own config
 * location — never the daemon's, which holds codeoid's and ZeroID's
 * credentials. Every call has a timeout, and everything it returns is data.
 */

import { execFile } from "node:child_process";
import { tmpdir } from "node:os";

export interface GhResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run `gh` with these arguments. The seam tests replace. */
export type GhExec = (args: string[], opts: { timeoutMs: number }) => Promise<GhResult>;

export class GhError extends Error {
  /** GitHub refused for rate (HTTP 403/429, or a rate-limit message): back off. */
  readonly rateLimited: boolean;
  constructor(message: string, rateLimited = false) {
    super(message);
    this.rateLimited = rateLimited;
  }
}

const RATE_LIMITED = /HTTP 403|HTTP 429|rate limit/i;

const GH_TIMEOUT_MS = 30_000;

/** Environment `gh` gets: enough to find itself and its login, nothing else. */
export function ghEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {
    PATH: source.PATH ?? "/usr/bin:/bin",
    LANG: "C",
    NO_COLOR: "1",
    GH_PROMPT_DISABLED: "1",
    GH_NO_UPDATE_NOTIFIER: "1",
  };
  for (const k of ["HOME", "GH_CONFIG_DIR", "XDG_CONFIG_HOME"] as const) {
    const v = source[k];
    if (v) env[k] = v;
  }
  return env;
}

export const defaultGhExec: GhExec = (args, opts) =>
  new Promise((resolve) => {
    execFile(
      "gh",
      args,
      // Not the repository: gh is told the repo explicitly, so nothing in the
      // checkout's git config is read.
      { cwd: tmpdir(), env: ghEnv(), timeout: opts.timeoutMs, maxBuffer: 32 * 1024 * 1024, encoding: "utf8" },
      (err, stdout, stderr) => {
        if (!err) return resolve({ code: 0, stdout, stderr });
        const e = err as NodeJS.ErrnoException & { code?: number | string; killed?: boolean };
        if (e.code === "ENOENT") return resolve({ code: 127, stdout: "", stderr: "the gh CLI is not installed (https://cli.github.com)" });
        resolve({ code: typeof e.code === "number" ? e.code : 1, stdout: stdout ?? "", stderr: e.killed ? `gh timed out after ${opts.timeoutMs}ms` : (stderr || e.message) });
      },
    );
  });

// ── Parsing helpers ──────────────────────────────────────────────────────────

/** `owner/name`: a GitHub account (letters, digits, hyphens) and a repository name that isn't `.` or `..`. */
const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/(?!\.\.?$)[A-Za-z0-9_.-]{1,100}$/;

/** `owner/name` from a github.com remote URL (https, ssh, scp-style); null otherwise. */
export function parseGithubRemote(url: string): string | null {
  const u = url.trim();
  const m =
    /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|ssh:\/\/(?:[^@/]+@)?github\.com(?::\d+)?\/|[^@\s/]+@github\.com:)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(u);
  if (!m) return null;
  const repo = `${m[1]}/${m[2]}`;
  return REPO_RE.test(repo) ? repo : null;
}

export function isRepo(repo: string): boolean {
  return REPO_RE.test(repo);
}

/** Exact match, or a glob where `*` is any run of characters and `?` one. */
export function globMatch(pattern: string, name: string): boolean {
  if (!/[*?]/.test(pattern)) return pattern === name;
  const re = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${re}$`, "s").test(name);
}

/**
 * What the comment's author wrote themselves: quoted lines (`>`), fenced and
 * inline code, and HTML comments removed. A reply that quotes an allowed
 * author's `@codeoid …` must not count as that author asking, and code or a
 * hidden comment is not an address to codeoid.
 */
export function unquoted(body: string): string {
  const out: string[] = [];
  let fence: string | null = null;
  // A line right after a quoted one belongs to the quote (Markdown's lazy
  // continuation) until a blank line ends it.
  let quoted = false;
  for (const line of body.replace(/\r\n?/g, "\n").replace(/<!--[\s\S]*?(?:-->|$)/g, "").split("\n")) {
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (f && f[0] === fence[0] && f.length >= fence.length && line.trim() === f) fence = null;
      continue;
    }
    if (f) {
      fence = f;
      continue;
    }
    if (/^\s*>/.test(line) || (quoted && line.trim() !== "")) {
      quoted = true;
      continue;
    }
    quoted = false;
    out.push(line.replace(/(`+)[\s\S]*?\1/g, ""));
  }
  return out.join("\n").trim();
}

/** Whether `body` addresses `token` (`@codeoid`, not `@codeoid-bot`). Give it {@link unquoted} text. */
export function mentions(body: string, token: string): boolean {
  const esc = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\w-])${esc}(?![\\w-])`, "i").test(body);
}

/**
 * How the daemon fetches a commit a watch reported: from github.com by URL,
 * never through the checkout's `origin` (whose URL, helper, and transport the
 * repository's config decides), and into a repository the daemon made for the
 * fetch, never yours (loops/host.ts ensureCommit). Overrides close every way
 * config can make this fetch run a command or go elsewhere: no global or
 * system config, no ssh command or proxy command, https only, and gh as the
 * only credential helper — git runs it with gh's own minimal environment, so
 * a private repository works with the login the watch already reads through.
 * `remote` replaces the URL in tests (a local repository, over file://).
 */
export function githubFetch(
  repo: string,
  ref: string,
  remote?: string,
): { args: string[]; env: Record<string, string>; protocol: "https" | "file" } {
  if (!isRepo(repo)) throw new GhError(`not a GitHub repository name: ${repo}`);
  const url = remote ?? `https://github.com/${repo}.git`;
  const protocol = url.startsWith("https://") ? "https" : url.startsWith("file://") ? "file" : null;
  if (!protocol) throw new GhError(`not an https or file URL: ${url}`);
  return {
    args: [
      "-c", "core.sshCommand=false",
      "-c", "core.gitProxy=",
      "-c", "core.askPass=",
      "-c", "credential.helper=",
      "-c", "credential.helper=!gh auth git-credential",
      "-c", "protocol.allow=never",
      "-c", `protocol.${protocol}.allow=always`,
      "-c", "fetch.recurseSubmodules=false",
      // Kept as a pack however few objects come, so it can be indexed into yours.
      "-c", "fetch.unpackLimit=1",
      "fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "--no-recurse-submodules",
      url, "--end-of-options", ref,
    ],
    env: { ...ghEnv(), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", SSH_ASKPASS: "" },
    protocol,
  };
}

/**
 * Parse `gh api --paginate` output: one JSON value per page, concatenated.
 * Split at top-level boundaries, honouring strings, so text inside a comment
 * body can't be mistaken for one.
 */
export function parseJsonStream(text: string): unknown[] {
  const out: unknown[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      if (depth === 0) throw new GhError("unexpected gh output");
    } else if (c === "[" || c === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (c === "]" || c === "}") {
      depth--;
      if (depth === 0) {
        out.push(JSON.parse(text.slice(start, i + 1)));
        start = -1;
      } else if (depth < 0) {
        throw new GhError("unexpected gh output");
      }
    }
  }
  if (depth !== 0) throw new GhError("truncated gh output");
  return out;
}

// ── GitHub records ───────────────────────────────────────────────────────────

export interface PullRequest {
  number: number;
  headRefName: string;
  headRefOid: string;
  url: string;
}

export interface CheckRunRecord {
  id: number;
  name: string;
  /** The GitHub App that reported it (`github-actions`): a name alone can be posed by any app with checks access. */
  app: string;
  status: string;
  conclusion: string | null;
  url: string | null;
  /** 1 unless the details URL names a re-run attempt. */
  attempt: number;
  title: string;
  summary: string;
  text: string;
}

export interface CommentRecord {
  id: number;
  /** A comment on a line, on the conversation, or a review's own body. */
  kind: "review" | "issue" | "review_body";
  author: string;
  body: string;
  url: string | null;
  createdAt: number;
  /** Review comments: the file and line it is on. */
  path?: string;
  line?: number;
}

/** Who wrote a commit and who committed it, as GitHub accounts (null: no account matches the email). */
export interface CommitPeople {
  sha: string;
  author: string | null;
  committer: string | null;
}

/** Commits read to judge a head; more than this and it is not trusted. */
export const COMMITS_MAX = 250;

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const login = (v: unknown): string | null => str((v as { login?: unknown } | null | undefined)?.login) || null;

/** One repository, read through gh. */
export class GitHubSource {
  readonly #gh: GhExec;
  readonly repo: string;

  constructor(gh: GhExec, repo: string) {
    if (!isRepo(repo)) throw new GhError(`not a GitHub repository name: ${repo}`);
    this.#gh = gh;
    this.repo = repo;
  }

  /** `what` names the call in an error: the endpoint, never gh's flags. */
  async #run(args: string[], what: string): Promise<string> {
    const r = await this.#gh(args, { timeoutMs: GH_TIMEOUT_MS });
    if (r.code !== 0) {
      const why = r.stderr.trim().split("\n")[0]?.slice(0, 300) || `exit ${r.code}`;
      throw new GhError(`${what} failed: ${why}`, RATE_LIMITED.test(r.stderr));
    }
    return r.stdout;
  }

  async #api(path: string, paginate = false): Promise<unknown[]> {
    const out = await this.#run(["api", "-H", "Accept: application/vnd.github+json", ...(paginate ? ["--paginate"] : []), path], `GitHub ${path.split("?")[0]}`);
    return parseJsonStream(out);
  }

  /** The login gh is signed in as. */
  static async me(gh: GhExec): Promise<string> {
    const r = await gh(["api", "user"], { timeoutMs: GH_TIMEOUT_MS });
    if (r.code !== 0) throw new GhError(`gh could not say who you are: ${r.stderr.trim().split("\n")[0]?.slice(0, 300) || `exit ${r.code}`}`, RATE_LIMITED.test(r.stderr));
    const login = str((parseJsonStream(r.stdout)[0] as { login?: unknown } | undefined)?.login);
    if (!login) throw new GhError("gh did not report a login");
    return login;
  }

  /** The signed-in user's open pull requests in this repository, newest first. */
  async myOpenPrs(): Promise<PullRequest[]> {
    const out = await this.#run(
      [
        "pr", "list", "--repo", this.repo, "--author", "@me", "--state", "open",
        "--json", "number,headRefName,headRefOid,url", "--limit", "100",
      ],
      `GitHub pull requests of ${this.repo}`,
    );
    const [list] = parseJsonStream(out);
    if (!Array.isArray(list)) throw new GhError("gh pr list returned no list");
    return list.flatMap((p: Record<string, unknown>) =>
      typeof p.number === "number" && str(p.headRefName) && str(p.headRefOid)
        ? [{ number: p.number, headRefName: str(p.headRefName), headRefOid: str(p.headRefOid), url: str(p.url) }]
        : [],
    );
  }

  async branchHead(branch: string): Promise<string> {
    const [b] = await this.#api(`repos/${this.repo}/branches/${encodeURIComponent(branch).replace(/%2F/g, "/")}`);
    const sha = str((b as { commit?: { sha?: unknown } } | undefined)?.commit?.sha);
    if (!sha) throw new GhError(`branch ${branch} has no head on GitHub`);
    return sha;
  }

  async defaultBranch(): Promise<string> {
    const [r] = await this.#api(`repos/${this.repo}`);
    const name = str((r as { default_branch?: unknown } | undefined)?.default_branch);
    if (!name) throw new GhError(`GitHub did not report ${this.repo}'s default branch`);
    return name;
  }

  /**
   * Every commit in `merge-base(base, head)..head` with the accounts that
   * wrote and committed it; null when there are more than {@link COMMITS_MAX}.
   * Pages are read one by one, never more than the bound needs.
   */
  async commitsBetween(base: string, head: string): Promise<CommitPeople[] | null> {
    const out: CommitPeople[] = [];
    const per = 100;
    for (let page = 1; ; page++) {
      const [r] = await this.#api(`repos/${this.repo}/compare/${encodeURIComponent(base).replace(/%2F/g, "/")}...${head}?per_page=${per}&page=${page}`);
      const body = (r ?? {}) as { total_commits?: unknown; commits?: unknown };
      const total = typeof body.total_commits === "number" ? body.total_commits : Number.NaN;
      if (!Number.isFinite(total)) throw new GhError("GitHub's compare returned no commit count");
      if (total > COMMITS_MAX) return null;
      const commits = Array.isArray(body.commits) ? body.commits : [];
      for (const c of commits as Array<Record<string, unknown>>) {
        out.push({ sha: str(c.sha), author: login(c.author), committer: login(c.committer) });
      }
      if (out.length >= total || commits.length < per) break;
      if (page * per >= COMMITS_MAX) return null;
    }
    return out;
  }

  async checkRuns(sha: string): Promise<CheckRunRecord[]> {
    const pages = await this.#api(`repos/${this.repo}/commits/${sha}/check-runs?per_page=100`, true);
    return pages.flatMap((page) => {
      const runs = (page as { check_runs?: unknown }).check_runs;
      return Array.isArray(runs) ? runs : [];
    }).flatMap((c: Record<string, unknown>) => {
      if (typeof c.id !== "number") return [];
      const output = (c.output ?? {}) as Record<string, unknown>;
      const details = str(c.details_url);
      const attempt = Number(/\/attempts\/(\d+)/.exec(details)?.[1] ?? 1);
      return [{
        id: c.id,
        name: str(c.name),
        app: str((c.app as { slug?: unknown } | undefined)?.slug),
        status: str(c.status),
        conclusion: typeof c.conclusion === "string" ? c.conclusion : null,
        url: str(c.html_url) || details || null,
        attempt: Number.isFinite(attempt) && attempt > 0 ? attempt : 1,
        title: str(output.title),
        summary: str(output.summary),
        text: str(output.text),
      }];
    });
  }

  async commitMessage(sha: string): Promise<string> {
    const [c] = await this.#api(`repos/${this.repo}/git/commits/${sha}`);
    return str((c as { message?: unknown } | undefined)?.message);
  }

  /**
   * Review comments, conversation comments, and review bodies on a pull
   * request. `since` narrows the two comment lists by when they were last
   * updated (the reviews list has no such filter); callers still judge each by
   * when it was made.
   */
  async prComments(pr: number, since: number): Promise<CommentRecord[]> {
    const iso = new Date(since).toISOString();
    const records = (kind: CommentRecord["kind"], pages: unknown[], at: string): CommentRecord[] =>
      pages
        .flatMap((page) => (Array.isArray(page) ? page : []))
        .flatMap((c: Record<string, unknown>) => {
          if (typeof c.id !== "number") return [];
          const created = Date.parse(str(c[at]));
          return [{
            id: c.id,
            kind,
            author: str((c.user as { login?: unknown } | undefined)?.login),
            body: str(c.body),
            url: str(c.html_url) || null,
            createdAt: Number.isFinite(created) ? created : 0,
            ...(str(c.path) ? { path: str(c.path) } : {}),
            ...(typeof c.line === "number" ? { line: c.line } : {}),
          }];
        });
    const [review, issue, reviews] = await Promise.all([
      this.#api(`repos/${this.repo}/pulls/${pr}/comments?per_page=100&since=${iso}`, true),
      this.#api(`repos/${this.repo}/issues/${pr}/comments?per_page=100&since=${iso}`, true),
      this.#api(`repos/${this.repo}/pulls/${pr}/reviews?per_page=100`, true),
    ]);
    return [
      ...records("review", review, "created_at"),
      ...records("issue", issue, "created_at"),
      ...records("review_body", reviews, "submitted_at").filter((r) => r.body.trim() !== ""),
    ].sort((a, b) => a.createdAt - b.createdAt || a.id - b.id);
  }
}
