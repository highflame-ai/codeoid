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
  /** GitHub refused for rate (HTTP 429, or GitHub saying a rate limit is spent): back off. */
  readonly rateLimited: boolean;
  /** The HTTP status gh reported, when it did. */
  readonly status: number | null;
  constructor(message: string, rateLimited = false, status: number | null = null) {
    super(message);
    this.rateLimited = rateLimited;
    this.status = status;
  }
}

/**
 * GitHub saying a rate limit is spent: HTTP 429, the primary limit's "API rate
 * limit exceeded", the secondary limit's message, or a remaining count of 0.
 * Any other 403 (no access, a blocked token) is an error with its own message,
 * never a reason to wait.
 */
const RATE_LIMITED = /HTTP 429|\bAPI rate limit (?:already )?exceeded|secondary rate limit|x-ratelimit-remaining:\s*0(?!\d)/i;

/** A gh failure as a GhError: its first line, whether it is a rate limit, and its HTTP status. */
function ghFailure(what: string, r: GhResult): GhError {
  const why = r.stderr.trim().split("\n")[0]?.slice(0, 300) || `exit ${r.code}`;
  const status = /\bHTTP (\d{3})\b/.exec(r.stderr)?.[1];
  return new GhError(`${what}: ${why}`, RATE_LIMITED.test(r.stderr), status ? Number(status) : null);
}

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
 * system config, no ssh command, https only, no redirects, gh as the only
 * credential helper — git runs it with gh's own minimal environment, so a
 * private repository works with the login the watch already reads through —
 * and no command run in the repository whose objects it borrows (its refs are
 * not read through `core.alternateRefsCommand`, and nothing missing is
 * fetched lazily). Nothing it receives is kept unchecked (`fetch.fsckObjects`),
 * and no maintenance or gc runs after it. A proxy set in the daemon's own
 * environment (`HTTPS_PROXY`) still applies, as it does to the daemon's other
 * connections; none in any git config does.
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
      "-c", "http.followRedirects=false",
      // The borrowed repository's refs would be listed by git run there, under its config.
      "-c", "core.alternateRefsCommand=true",
      "-c", "fetch.fsckObjects=true",
      "-c", "maintenance.auto=false",
      "-c", "gc.auto=0",
      "-c", "fetch.recurseSubmodules=false",
      // Kept as a pack however few objects come, so it can be indexed into yours.
      "-c", "fetch.unpackLimit=1",
      "fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "--no-recurse-submodules",
      url, "--end-of-options", ref,
    ],
    env: { ...ghEnv(), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", SSH_ASKPASS: "", GIT_NO_LAZY_FETCH: "1" },
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
  /** `owner/name` of the repository the head branch is in (a fork's, for a fork's pull request); null when GitHub doesn't say (a deleted fork). */
  headRepo: string | null;
}

export interface CheckRunRecord {
  id: number;
  name: string;
  /** The GitHub App that reported it (`github-actions`): a name alone can be posed by any app with checks access. */
  app: string;
  status: string;
  conclusion: string | null;
  url: string | null;
  /** The check suite it belongs to; with the run's id, what tells one attempt from another. */
  suiteId: number | null;
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
  /** When it was last edited; `createdAt` when it never was. */
  updatedAt: number;
  /** Review comments: the file and line it is on. */
  path?: string;
  line?: number;
}

/**
 * Who wrote a commit and who committed it, as GitHub accounts (null: no
 * account matches the email). GitHub ties a login to a commit by its email
 * alone, which anyone can write, so a login means something only when the
 * commit is `verified`: signed by a key that account registered.
 */
export interface CommitPeople {
  sha: string;
  author: string | null;
  committer: string | null;
  verified: boolean;
}

/** Who made the push that put a commit at a branch's head. */
export interface PushRecord {
  actor: string | null;
  /** `push`, `force_push`, `branch_creation`, … (GitHub's activity types). */
  type: string;
}

/** Commits read to judge a head; more than this and it is not trusted. */
export const COMMITS_MAX = 250;

/** Open pull requests one listing reads. */
export const PRS_MAX = 100;

/** A pull request's reviews, with when each was last edited (REST doesn't say). */
const REVIEWS_QUERY = `query($owner: String!, $name: String!, $number: Int!, $endCursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviews(first: 100, after: $endCursor) {
        pageInfo { hasNextPage endCursor }
        nodes { databaseId body url submittedAt lastEditedAt author { login } }
      }
    }
  }
}`;

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
    if (r.code !== 0) throw ghFailure(`${what} failed`, r);
    return r.stdout;
  }

  async #api(path: string, paginate = false): Promise<unknown[]> {
    const out = await this.#run(["api", "-H", "Accept: application/vnd.github+json", ...(paginate ? ["--paginate"] : []), path], `GitHub ${path.split("?")[0]}`);
    return parseJsonStream(out);
  }

  /** The login gh is signed in as. */
  static async me(gh: GhExec): Promise<string> {
    const r = await gh(["api", "user"], { timeoutMs: GH_TIMEOUT_MS });
    if (r.code !== 0) throw ghFailure("gh could not say who you are", r);
    const login = str((parseJsonStream(r.stdout)[0] as { login?: unknown } | undefined)?.login);
    if (!login) throw new GhError("gh did not report a login");
    return login;
  }

  /** The signed-in user's open pull requests in this repository, newest first. */
  async myOpenPrs(): Promise<PullRequest[]> {
    const out = await this.#run(
      [
        "pr", "list", "--repo", this.repo, "--author", "@me", "--state", "open",
        "--json", "number,headRefName,headRefOid,url,headRepository,headRepositoryOwner", "--limit", String(PRS_MAX),
      ],
      `GitHub pull requests of ${this.repo}`,
    );
    const [list] = parseJsonStream(out);
    if (!Array.isArray(list)) throw new GhError("gh pr list returned no list");
    return list.flatMap((p: Record<string, unknown>) => {
      if (typeof p.number !== "number" || !str(p.headRefName) || !str(p.headRefOid)) return [];
      const head = `${login(p.headRepositoryOwner) ?? ""}/${str((p.headRepository as { name?: unknown } | null | undefined)?.name)}`;
      return [{ number: p.number, headRefName: str(p.headRefName), headRefOid: str(p.headRefOid), url: str(p.url), headRepo: isRepo(head) ? head : null }];
    });
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
   * The newest push to `repo`'s `branch` that left it at `sha`, from GitHub's
   * record of the repository's activity, or null when the newest page has
   * none (or GitHub keeps no activity for the repository). GitHub records the
   * account that pushed — the one that authenticated — not anything a commit
   * says about itself.
   */
  async pushOf(repo: string, branch: string, sha: string): Promise<PushRecord | null> {
    if (!isRepo(repo)) throw new GhError(`not a GitHub repository name: ${repo}`);
    let page: unknown;
    try {
      [page] = await this.#api(`repos/${repo}/activity?ref=${encodeURIComponent(`refs/heads/${branch}`)}&per_page=100`);
    } catch (err) {
      if (err instanceof GhError && err.status === 404) return null;
      throw err;
    }
    if (!Array.isArray(page)) throw new GhError("GitHub's activity list is not a list");
    // Newest first, as GitHub returns it.
    for (const a of page as Array<Record<string, unknown>>) {
      if (str(a.after) === sha) return { actor: login(a.actor), type: str(a.activity_type) };
    }
    return null;
  }

  /**
   * Every commit in `merge-base(base, head)..head` with the accounts that
   * wrote and committed it, and whether GitHub verified its signature; null
   * when there are more than {@link COMMITS_MAX}, or GitHub returned fewer
   * than it counted. Pages are read one by one, never more than the bound
   * needs.
   */
  async commitsBetween(base: string, head: string): Promise<CommitPeople[] | null> {
    const out: CommitPeople[] = [];
    const per = 100;
    let total = 0;
    for (let page = 1; ; page++) {
      const [r] = await this.#api(`repos/${this.repo}/compare/${encodeURIComponent(base).replace(/%2F/g, "/")}...${head}?per_page=${per}&page=${page}`);
      const body = (r ?? {}) as { total_commits?: unknown; commits?: unknown };
      total = typeof body.total_commits === "number" ? body.total_commits : Number.NaN;
      if (!Number.isFinite(total)) throw new GhError("GitHub's compare returned no commit count");
      if (total > COMMITS_MAX) return null;
      const commits = Array.isArray(body.commits) ? body.commits : [];
      for (const c of commits as Array<Record<string, unknown>>) {
        const verification = (c.commit as { verification?: { verified?: unknown } } | undefined)?.verification;
        out.push({ sha: str(c.sha), author: login(c.author), committer: login(c.committer), verified: verification?.verified === true });
      }
      if (out.length >= total || commits.length < per) break;
      if (page * per >= COMMITS_MAX) return null;
    }
    // Anything short of every commit is not a judgment of every commit.
    return out.length === total ? out : null;
  }

  async checkRuns(sha: string): Promise<CheckRunRecord[]> {
    const pages = await this.#api(`repos/${this.repo}/commits/${sha}/check-runs?per_page=100`, true);
    return pages.flatMap((page) => {
      const runs = (page as { check_runs?: unknown }).check_runs;
      return Array.isArray(runs) ? runs : [];
    }).flatMap((c: Record<string, unknown>) => {
      if (typeof c.id !== "number") return [];
      const output = (c.output ?? {}) as Record<string, unknown>;
      const suite = (c.check_suite as { id?: unknown } | null | undefined)?.id;
      return [{
        id: c.id,
        name: str(c.name),
        app: str((c.app as { slug?: unknown } | undefined)?.slug),
        status: str(c.status),
        conclusion: typeof c.conclusion === "string" ? c.conclusion : null,
        url: str(c.html_url) || str(c.details_url) || null,
        suiteId: typeof suite === "number" ? suite : null,
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
   * request, each with when it was made and last edited. `since` narrows the
   * two comment lists by when they were last updated (the reviews list has no
   * such filter); callers still judge each by when it was made.
   */
  async prComments(pr: number, since: number): Promise<CommentRecord[]> {
    const iso = new Date(since).toISOString();
    const time = (v: unknown): number | null => {
      const t = Date.parse(str(v));
      return Number.isFinite(t) ? t : null;
    };
    const records = (kind: "review" | "issue", pages: unknown[]): CommentRecord[] =>
      pages
        .flatMap((page) => (Array.isArray(page) ? page : []))
        .flatMap((c: Record<string, unknown>) => {
          if (typeof c.id !== "number") return [];
          const created = time(c.created_at) ?? 0;
          return [{
            id: c.id,
            kind,
            author: str((c.user as { login?: unknown } | undefined)?.login),
            body: str(c.body),
            url: str(c.html_url) || null,
            createdAt: created,
            // Unknown is not "never": judged as edited.
            updatedAt: time(c.updated_at) ?? Number.POSITIVE_INFINITY,
            ...(str(c.path) ? { path: str(c.path) } : {}),
            ...(typeof c.line === "number" ? { line: c.line } : {}),
          }];
        });
    const [owner, name] = this.repo.split("/") as [string, string];
    const [review, issue, reviewPages] = await Promise.all([
      this.#api(`repos/${this.repo}/pulls/${pr}/comments?per_page=100&since=${iso}`, true),
      this.#api(`repos/${this.repo}/issues/${pr}/comments?per_page=100&since=${iso}`, true),
      this.#run(
        ["api", "graphql", "--paginate", "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `number=${pr}`, "-f", `query=${REVIEWS_QUERY}`],
        `GitHub reviews of pull request #${pr}`,
      ).then(parseJsonStream),
    ]);
    const reviews = reviewPages.flatMap((page): CommentRecord[] => {
      const conn = (page as { data?: { repository?: { pullRequest?: { reviews?: { nodes?: unknown } } } } } | null)?.data?.repository?.pullRequest?.reviews;
      if (!conn || !Array.isArray(conn.nodes)) throw new GhError(`GitHub returned no reviews of pull request #${pr}`);
      return (conn.nodes as Array<Record<string, unknown> | null>).flatMap((r) => {
        if (!r || typeof r.databaseId !== "number" || str(r.body).trim() === "") return [];
        const created = time(r.submittedAt) ?? 0;
        return [{
          id: r.databaseId,
          kind: "review_body" as const,
          author: login(r.author) ?? "",
          body: str(r.body),
          url: str(r.url) || null,
          createdAt: created,
          updatedAt: r.lastEditedAt === null ? created : (time(r.lastEditedAt) ?? Number.POSITIVE_INFINITY),
        }];
      });
    });
    return [...records("review", review), ...records("issue", issue), ...reviews].sort((a, b) => a.createdAt - b.createdAt || a.id - b.id);
  }
}
