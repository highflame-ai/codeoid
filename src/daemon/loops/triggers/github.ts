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
  /**
   * When it was published: when its review was submitted, for a comment on a
   * line drafted into a review (drafting it doesn't publish it).
   */
  createdAt: number;
  /** GitHub records an edit of it (or doesn't say that it doesn't). */
  edited: boolean;
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

/** Who made the push (or the merge) that put a commit at a branch's head. */
export interface PushRecord {
  actor: string | null;
  /** `push`, `force_push`, `branch_creation`, `pr_merge`, `merge_queue_merge`, … (GitHub's activity types). */
  type: string;
  /** The branch's head before it: {@link NO_COMMIT} for the branch's first push; "" when GitHub doesn't say. */
  before: string;
}

/** What GitHub's activity writes as `before` for a branch's first push: nothing was there. */
export const NO_COMMIT = "0".repeat(40);

/** What GitHub's activity says about a head: the push that made it, if listed, and whether GitHub keeps activity for the repository at all. */
export interface PushLookup {
  push: PushRecord | null;
  /** False when GitHub keeps no activity for the repository (404): no record will come. */
  kept: boolean;
}

/** One entry of a branch's activity: who moved the branch, how, and from what head to what head. */
export interface ActivityEntry extends PushRecord {
  /** The branch's head after it. */
  after: string;
}

/** Pages of a branch's activity (100 entries each) one judgment reads, at most. */
export const ACTIVITY_PAGES_MAX = 3;
const ACTIVITY_PER_PAGE = 100;
/** The opaque cursor GitHub's activity pages by (`after=` in its `Link` header). */
const CURSOR_RE = /^[A-Za-z0-9_=+/-]{1,500}$/;

/**
 * A branch's activity, newest first, read a page at a time and never more
 * than {@link ACTIVITY_PAGES_MAX} pages. GitHub pages it by cursor only (its
 * `page` parameter is ignored), so the next page is the one its `Link` header
 * names.
 */
export class BranchActivity {
  readonly entries: ActivityEntry[] = [];
  /** False when GitHub keeps no activity for the repository (404): no record will come. */
  kept = true;
  #pages = 0;
  #next: string | null = null;
  readonly #read: (cursor: string | null) => Promise<{ list: unknown[]; next: string | null } | null>;

  constructor(read: (cursor: string | null) => Promise<{ list: unknown[]; next: string | null } | null>) {
    this.#read = read;
  }

  /** Whether there was more activity than the pages read hold. */
  get truncated(): boolean {
    return this.#pages >= ACTIVITY_PAGES_MAX && this.#next !== null;
  }

  /** Read the next page; false when there is none, or the bound is reached. */
  async more(): Promise<boolean> {
    if (!this.kept || this.#pages >= ACTIVITY_PAGES_MAX || (this.#pages > 0 && this.#next === null)) return false;
    const page = await this.#read(this.#pages === 0 ? null : this.#next);
    this.#pages++;
    if (!page) {
      this.kept = false;
      this.#next = null;
      return false;
    }
    for (const a of page.list as Array<Record<string, unknown>>) {
      const before = str(a?.before);
      const after = str(a?.after);
      this.entries.push({ actor: login(a?.actor), type: str(a?.activity_type), before: SHA_RE.test(before) ? before : "", after: SHA_RE.test(after) ? after : "" });
    }
    this.#next = page.next;
    return page.list.length > 0;
  }

  /**
   * The index of the newest entry older than `entries[from]` that left the
   * branch at `sha`, reading further pages as needed; -1 when none of the
   * pages that may be read has one.
   */
  async olderTo(from: number, sha: string): Promise<number> {
    for (let i = from + 1; ; i++) {
      while (i >= this.entries.length) if (!(await this.more())) return -1;
      if (this.entries[i]!.after === sha) return i;
    }
  }
}

/** The pull request GitHub merged as a commit, as far as judging that merge needs. */
export interface MergedPull {
  number: number;
  /** Who GitHub records as having merged it — for the merge queue, who queued it; null when it doesn't say. */
  mergedBy: string | null;
  /** Auto-merge was turned on for it at some point; true when GitHub doesn't say either way. */
  autoMerged: boolean;
  /** `owner/name` of the repository its head branch is in; null when GitHub doesn't say (a deleted fork). */
  headRepo: string | null;
  headRef: string;
  /** Its final head commit; "" when GitHub doesn't give one. */
  headSha: string;
  /** The merge commit's first parent: what it was made on; "" when GitHub doesn't say. */
  parent: string;
  /** How many commits the pull request had (a rebase merge puts that many on the branch); 0 when GitHub doesn't say. */
  commits: number;
}

/**
 * The merged pull requests in a repository whose merge commit is a given
 * commit: none, one, or (which vouches for nothing) several.
 */
export type MergedAs = { kind: "none" } | { kind: "one"; pull: MergedPull } | { kind: "many"; numbers: number[] };

/** Commits read to judge a head; more than this and it is not trusted. */
export const COMMITS_MAX = 250;

/** Open pull requests one listing reads. */
export const PRS_MAX = 100;

/** A pull request's reviews, with when each was published and whether it was edited (REST says neither). */
const REVIEWS_QUERY = `query($owner: String!, $name: String!, $number: Int!, $endCursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviews(first: 100, after: $endCursor) {
        pageInfo { hasNextPage endCursor }
        nodes { databaseId body url state publishedAt lastEditedAt author { login } }
      }
    }
  }
}`;

/**
 * Comments REST listed, read again by their node ids: when each was published
 * and whether it was edited, which REST doesn't say (its `created_at` on a
 * line comment is when it was drafted, and its `updated_at` moves when the
 * review is submitted), with the text read in the same response.
 */
const COMMENT_NODES_QUERY = `query($ids: [ID!]!) {
  nodes(ids: $ids) {
    __typename
    ... on IssueComment { databaseId body url publishedAt lastEditedAt author { login } pullRequest { number } repository { nameWithOwner } }
    ... on PullRequestReviewComment { databaseId body url state publishedAt lastEditedAt path line author { login } pullRequest { number } repository { nameWithOwner } }
  }
}`;

/**
 * What judging a merge needs from its pull request beyond REST: who GitHub
 * records as having merged it (for the merge queue, who queued it), and
 * whether auto-merge was on — now (`autoMergeRequest`, null once it merged
 * by hand) or ever (an enable event in its timeline, kept after a disable);
 * and what its merge commit was made on and how many commits it had, which
 * tell which commits beneath the merge commit it put on the branch.
 */
const MERGED_PULL_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      merged mergedBy { login } mergeCommit { oid parents(first: 1) { nodes { oid } } }
      commits { totalCount }
      autoMergeRequest { enabledAt }
      timelineItems(itemTypes: [AUTO_MERGE_ENABLED_EVENT, AUTO_REBASE_ENABLED_EVENT, AUTO_SQUASH_ENABLED_EVENT], first: 1) { nodes { __typename } }
    }
  }
}`;

/** Node ids one GraphQL `nodes` query reads (GitHub's limit). */
const NODES_PER_QUERY = 100;
/** A GraphQL node id as GitHub writes them (`IC_kwDO…`, `PRRC_kwDO…`, or the legacy base64 form). */
const NODE_ID_RE = /^[A-Za-z0-9_=+/-]{1,200}$/;

const SHA_RE = /^[0-9a-f]{40}$/;
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

  /**
   * A GraphQL read whose nodes may be gone: gh exits 1 when any node id
   * resolves to nothing (deleted since it was listed), with the data still on
   * stdout and each missing node null in it. That answer is used when every
   * error in it is NOT_FOUND; any other error fails the read.
   */
  async #graphqlNodes(args: string[], what: string): Promise<unknown> {
    const r = await this.#gh(args, { timeoutMs: GH_TIMEOUT_MS });
    if (r.code === 0) return parseJsonStream(r.stdout)[0];
    let page: { data?: unknown; errors?: unknown } | undefined;
    try {
      page = parseJsonStream(r.stdout)[0] as typeof page;
    } catch {
      page = undefined;
    }
    const errors = page?.errors;
    const onlyMissing =
      Array.isArray(errors) && errors.length > 0 && errors.every((e) => (e as { type?: unknown } | null)?.type === "NOT_FOUND") && page?.data != null;
    if (!onlyMissing) throw ghFailure(`${what} failed`, r);
    return page;
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
   * `repo`'s `branch`'s activity from GitHub's record of the repository's
   * activity, its newest page read (more on {@link BranchActivity.more}).
   * GitHub records the account that authenticated — who pushed, or who
   * pressed the merge button — not anything a commit says about itself.
   */
  async activity(repo: string, branch: string): Promise<BranchActivity> {
    if (!isRepo(repo)) throw new GhError(`not a GitHub repository name: ${repo}`);
    const path = `repos/${repo}/activity?ref=${encodeURIComponent(`refs/heads/${branch}`)}&per_page=${ACTIVITY_PER_PAGE}`;
    const log = new BranchActivity(async (cursor) => {
      let out: string;
      try {
        // With the response's headers (`-i`): the next page is named in its `Link` header.
        out = await this.#run(
          ["api", "-i", "-H", "Accept: application/vnd.github+json", cursor ? `${path}&after=${encodeURIComponent(cursor)}` : path],
          `GitHub repos/${repo}/activity`,
        );
      } catch (err) {
        if (err instanceof GhError && err.status === 404) return null;
        throw err;
      }
      const gap = /\r?\n\r?\n/.exec(out);
      const headers = gap ? out.slice(0, gap.index) : "";
      const [list] = parseJsonStream(gap ? out.slice(gap.index + gap[0].length) : out);
      if (!Array.isArray(list)) throw new GhError("GitHub's activity list is not a list");
      const url = /<([^>]+)>\s*;\s*rel="next"/.exec(/^link:(.*)$/im.exec(headers)?.[1] ?? "")?.[1];
      let next: string | null = null;
      try {
        const c = url ? new URL(url).searchParams.get("after") : null;
        if (c && CURSOR_RE.test(c)) next = c;
      } catch {
        next = null;
      }
      return { list, next };
    });
    await log.more();
    return log;
  }

  /** The newest push (or merge) to `repo`'s `branch` that left it at `sha`, on the newest page of its activity. */
  async pushOf(repo: string, branch: string, sha: string): Promise<PushLookup> {
    const log = await this.activity(repo, branch);
    return { push: log.entries.find((a) => a.after === sha) ?? null, kept: log.kept };
  }

  /** The first parent of `sha` in this repository; "" for a root commit. */
  async firstParent(sha: string): Promise<string> {
    const [c] = await this.#api(`repos/${this.repo}/git/commits/${sha}`);
    const parents = (c as { parents?: unknown } | undefined)?.parents;
    const first = str((Array.isArray(parents) ? (parents[0] as { sha?: unknown } | undefined) : undefined)?.sha);
    return SHA_RE.test(first) ? first : "";
  }

  /**
   * The merged pull requests of `repo` whose merge commit is `sha`: the ones
   * REST lists for the commit, based in that repository, with that merge
   * commit. More than one vouches for nothing, since which of them put the
   * commit there can't be told. For exactly one, its merger, auto-merge, merge
   * commit's parent and commit count come from GraphQL
   * ({@link MERGED_PULL_QUERY}), and GraphQL disagreeing makes it none.
   *
   * Its base branch isn't matched: GitHub's stacked pull requests merge each
   * onto its parent's branch and then move the default branch, so most in a
   * stack have another pull request's branch as their base. What pins the
   * branch is the activity that put the commit on it, which the caller read.
   */
  async mergedAs(repo: string, sha: string): Promise<MergedAs> {
    if (!isRepo(repo)) throw new GhError(`not a GitHub repository name: ${repo}`);
    const pages = await this.#api(`repos/${repo}/commits/${sha}/pulls?per_page=100`, true);
    const matches = pages
      .flatMap((page) => (Array.isArray(page) ? page : []))
      .filter((x: Record<string, unknown>) => {
        const base = (x.base ?? {}) as { repo?: { full_name?: unknown } | null };
        return (
          typeof x.number === "number" &&
          str(x.merge_commit_sha) === sha &&
          str(x.merged_at) !== "" &&
          str(base.repo?.full_name).toLowerCase() === repo.toLowerCase()
        );
      }) as Array<Record<string, unknown>>;
    const numbers = [...new Set(matches.map((x) => x.number as number))];
    if (numbers.length === 0) return { kind: "none" };
    if (numbers.length > 1) return { kind: "many", numbers };
    const p = matches[0]!;
    const number = p.number as number;
    const [owner, name] = repo.split("/") as [string, string];
    const [page] = parseJsonStream(
      await this.#run(
        ["api", "graphql", "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `number=${number}`, "-f", `query=${MERGED_PULL_QUERY}`],
        `GitHub pull request #${number} of ${repo}`,
      ),
    );
    const q = (page as { data?: { repository?: { pullRequest?: Record<string, unknown> | null } | null } } | null)?.data?.repository?.pullRequest;
    const mergeCommit = q?.mergeCommit as { oid?: unknown; parents?: { nodes?: unknown } | null } | null | undefined;
    if (!q || q.merged !== true || str(mergeCommit?.oid) !== sha) return { kind: "none" };
    const events = (q.timelineItems as { nodes?: unknown } | null | undefined)?.nodes;
    const head = (p.head ?? {}) as { ref?: unknown; sha?: unknown; repo?: { full_name?: unknown } | null };
    const headRepo = str(head.repo?.full_name);
    const headSha = str(head.sha);
    const parents = mergeCommit?.parents?.nodes;
    const parent = str((Array.isArray(parents) ? (parents[0] as { oid?: unknown } | null | undefined) : undefined)?.oid);
    const count = (q.commits as { totalCount?: unknown } | null | undefined)?.totalCount;
    return {
      kind: "one",
      pull: {
        number,
        mergedBy: login(q.mergedBy),
        // Not knowing is judged as auto-merged: the stricter rule.
        autoMerged: p.auto_merge !== null || q.autoMergeRequest !== null || !Array.isArray(events) || events.length > 0,
        headRepo: isRepo(headRepo) ? headRepo : null,
        headRef: str(head.ref),
        headSha: SHA_RE.test(headSha) ? headSha : "",
        parent: SHA_RE.test(parent) ? parent : "",
        commits: typeof count === "number" && Number.isInteger(count) && count > 0 ? count : 0,
      },
    };
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
   * request, each with when it was published and whether it was edited, read
   * through GraphQL; nothing still pending (a draft, an unsubmitted review).
   * `since` narrows the two comment lists by when they were last updated
   * (REST lists them, then GraphQL reads each; the reviews list has no such
   * filter); callers still judge each by when it was published.
   */
  async prComments(pr: number, since: number): Promise<CommentRecord[]> {
    const iso = new Date(since).toISOString();
    const time = (v: unknown): number | null => {
      const t = Date.parse(str(v));
      return Number.isFinite(t) ? t : null;
    };
    // Unknown is not "never": judged as edited.
    const edited = (v: unknown): boolean => v !== null;
    const nodeIds = (pages: unknown[]): string[] =>
      pages
        .flatMap((page) => (Array.isArray(page) ? page : []))
        .flatMap((c: Record<string, unknown>) => (typeof c.id === "number" && NODE_ID_RE.test(str(c.node_id)) ? [str(c.node_id)] : []));
    const [owner, name] = this.repo.split("/") as [string, string];
    const [review, issue, reviewPages] = await Promise.all([
      this.#api(`repos/${this.repo}/pulls/${pr}/comments?per_page=100&since=${iso}`, true),
      this.#api(`repos/${this.repo}/issues/${pr}/comments?per_page=100&since=${iso}`, true),
      this.#run(
        ["api", "graphql", "--paginate", "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `number=${pr}`, "-f", `query=${REVIEWS_QUERY}`],
        `GitHub reviews of pull request #${pr}`,
      ).then(parseJsonStream),
    ]);
    const ids = [...new Set([...nodeIds(review), ...nodeIds(issue)])];
    const comments: CommentRecord[] = [];
    for (let i = 0; i < ids.length; i += NODES_PER_QUERY) {
      const chunk = ids.slice(i, i + NODES_PER_QUERY);
      const page = await this.#graphqlNodes(
        ["api", "graphql", ...chunk.flatMap((id) => ["-f", `ids[]=${id}`]), "-f", `query=${COMMENT_NODES_QUERY}`],
        `GitHub comments on pull request #${pr}`,
      );
      const nodes = (page as { data?: { nodes?: unknown } } | null)?.data?.nodes;
      if (!Array.isArray(nodes)) throw new GhError(`GitHub returned no comments on pull request #${pr}`);
      for (const c of nodes as Array<Record<string, unknown> | null>) {
        // Null: deleted since it was listed (GitHub's NOT_FOUND for its id).
        if (!c || typeof c.databaseId !== "number") continue;
        const kind = c.__typename === "PullRequestReviewComment" ? "review" : c.__typename === "IssueComment" ? "issue" : null;
        if (!kind || (c.pullRequest as { number?: unknown } | null | undefined)?.number !== pr) continue;
        // On this repository's pull request, not one of the same number elsewhere.
        if (str((c.repository as { nameWithOwner?: unknown } | null | undefined)?.nameWithOwner).toLowerCase() !== this.repo.toLowerCase()) continue;
        // A line comment in a review not yet submitted isn't published: no one but its author sees it.
        const published = time(c.publishedAt);
        if (published === null || (kind === "review" && str(c.state) !== "SUBMITTED")) continue;
        comments.push({
          id: c.databaseId,
          kind,
          author: login(c.author) ?? "",
          body: str(c.body),
          url: str(c.url) || null,
          createdAt: published,
          edited: edited(c.lastEditedAt),
          ...(str(c.path) ? { path: str(c.path) } : {}),
          ...(typeof c.line === "number" ? { line: c.line } : {}),
        });
      }
    }
    const reviews = reviewPages.flatMap((page): CommentRecord[] => {
      const conn = (page as { data?: { repository?: { pullRequest?: { reviews?: { nodes?: unknown } } } } } | null)?.data?.repository?.pullRequest?.reviews;
      if (!conn || !Array.isArray(conn.nodes)) throw new GhError(`GitHub returned no reviews of pull request #${pr}`);
      return (conn.nodes as Array<Record<string, unknown> | null>).flatMap((r) => {
        if (!r || typeof r.databaseId !== "number" || str(r.body).trim() === "") return [];
        const published = time(r.publishedAt);
        if (published === null || str(r.state) === "PENDING") return [];
        return [{
          id: r.databaseId,
          kind: "review_body" as const,
          author: login(r.author) ?? "",
          body: str(r.body),
          url: str(r.url) || null,
          createdAt: published,
          edited: edited(r.lastEditedAt),
        }];
      });
    });
    return [...comments, ...reviews].sort((a, b) => a.createdAt - b.createdAt || a.id - b.id);
  }
}
