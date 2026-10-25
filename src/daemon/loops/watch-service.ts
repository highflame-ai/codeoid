/**
 * WatchService — loop watches (docs/loops.md "Watches"; design §4, §10).
 *
 * A watch is an owner's opt-in rule that turns repository events into
 * ordinary repair runs:
 *
 *   - a CI check that failed on a watched branch's head, when its name (and
 *     the app that reported it) maps to a local command — the run repairs that
 *     branch until the command passes;
 *   - a comment on the owner's pull request that addresses codeoid (default
 *     `@codeoid`) from an allowed author — the run makes the change while the
 *     mapped commands keep passing.
 *
 * The watch is an adapter, not a second controller: it decides whether to
 * start a run and LoopService does everything else, under the owner's
 * identity and the owner's run cap. What it guards:
 *
 *   - Trust: a run executes the code at the head it works on (its checks run
 *     it). The logins the owner trusts are gh's own login, plus the watch's
 *     `trust` list. A head fires only when GitHub records that a trusted
 *     login pushed it onto its branch; or a merge put it there and every
 *     change to the branch since a trusted head (a trusted push, the branch's
 *     first, or the head the watch last trusted) is a trusted merge — each
 *     pull request it landed merged with the button by a trusted login, or
 *     auto-merged or queued by one with its final head itself trusted; or
 *     when it has commits past the default branch and every one is signed,
 *     verified, and committed by a trusted login — never by `web-flow`, whose
 *     signature is GitHub's, for whoever the commit names.
 *     The author and committer logins of an unsigned commit are only its
 *     email matched to an account, which anyone can write, so they vouch for
 *     nothing. A head GitHub's activity doesn't list yet is judged again for
 *     a while (the list lags a push); anything else is ignored for that head.
 *   - Dedupe: every event has a key (`ci:<repo>:<sha>:<checkRunId>:<suiteId>`,
 *     `review:<repo>:<kind>:<id>`) recorded per owner in `loop_triggers` with
 *     the run it started, so an event seen on every poll, by any of the
 *     owner's watches, starts one run.
 *   - Coalescing: at most one active run per (owner, repository, branch), and
 *     a head's CI is acted on once every mapped check on it has finished. A
 *     later CI failure on a busy branch is skipped without being recorded, and
 *     is picked up by the first poll after the run ends; a comment is kept
 *     waiting to retry, so the comments are read far enough back to find it.
 *   - Edits: a comment GitHub records an edit of is ignored — anyone with
 *     write access can edit someone else's comment, so its text is no longer
 *     the allowed author's.
 *   - Bounds: at most `maxRunsPerHour` runs per watch, the owner's active-run
 *     cap, 30 pull requests per poll, 10 watches per owner, and backing off —
 *     every watch acting as that gh login together — when GitHub rate-limits.
 *     A watch whose gh login changed under it pauses itself.
 *   - Cycles: a failure on a commit a loop delivered (`codeoid loop:` subject)
 *     is ignored for good, so a loop can't keep repairing its own output.
 *   - Authority: event text (a check's output, a comment) is task data. The
 *     run's objective is a fixed template; the text only reaches the worker
 *     inside a delimited data block.
 *
 * Sleeping between polls costs nothing: no model is called until an event
 * passes every rule above.
 */

import type { LoopOwner, LoopStartInput } from "./service.js";
import { LoopError, SAFE_BRANCH_RE } from "./service.js";
import type { LoopTenant } from "./store.js";
import {
  COMMITS_MAX,
  PRS_MAX,
  ACTIVITY_PAGES_MAX,
  type ActivityEntry,
  type BranchActivity,
  type CheckRunRecord,
  type CommentRecord,
  type GhExec,
  GhError,
  GitHubSource,
  type MergedPull,
  NO_COMMIT,
  globMatch,
  mentions,
  parseGithubRemote,
  unquoted,
} from "./triggers/github.js";
import { LOOP_DEFAULTS, LOOP_LIMITS, type LoopRunRow, type LoopTrigger } from "./types.js";
import type { TriggerKind, WatchCiMapping, WatchRow, WatchSpec, WatchStore } from "./watch-store.js";

/** Subject prefix of the commits loops deliver (LoopService #deliver). */
export const DELIVERY_SUBJECT_PREFIX = "codeoid loop:";

export const WATCH_DEFAULTS = {
  pollSeconds: 300,
  minPollSeconds: 60,
  maxRunsPerHour: 6,
  mention: "@codeoid",
  /** The app whose check runs a mapping matches unless it names another. */
  ciApp: "github-actions",
  /** The first poll after the daemon starts or a watch is made or resumed. */
  firstPollMs: 5_000,
} as const;

export const WATCH_LIMITS = {
  BRANCHES_MAX: 20,
  CI_MAX: 10,
  ALLOW_MAX: 20,
  TRUST_MAX: 20,
  RUNS_PER_HOUR_MAX: 60,
  WATCHES_PER_OWNER: 10,
  /** Pull requests one poll looks at (the newest). */
  PR_TARGETS_MAX: 30,
  /** Tries for an event whose run's workspace couldn't be prepared. */
  SETUP_TRIES: 3,
  /** Event text carried into a run. */
  EVENT_TEXT_MAX: LOOP_LIMITS.TRIGGER_SUMMARY_MAX,
} as const;

export const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
/** A GitHub App's bot account (`dependabot[bot]`): `--trust` takes one, `--allow` doesn't. */
const BOT_LOGIN_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\[bot\]$/;
/**
 * Bots that act for everyone, refused in `trust`: the merge queue's (GitHub
 * records it as the actor of every merge queue merge, whoever queued what),
 * and GitHub Actions' (a workflow pushes as it, and anyone who can make a
 * workflow run can make it push).
 */
const EVERYONES_BOTS: Record<string, string> = {
  "github-merge-queue[bot]": "it merges whatever anyone with write access queues",
  "github-actions[bot]": "every workflow pushes as it, so anyone who can run one pushes as it",
};
const APP_RE = /^[a-z0-9][a-z0-9-]{0,99}$/;
const FAILED = new Set(["failure", "timed_out"]);
const HOUR_MS = 60 * 60 * 1000;
/** Comments are read from this long before the last complete poll, so one that lands mid-poll isn't missed. */
const SINCE_SKEW_MS = 10 * 60 * 1000;
/** Clock skew allowed between GitHub and the daemon on when a comment was made. */
const CREATED_SKEW_MS = 2 * 60 * 1000;
const BACKOFF_MAX_MS = 6 * HOUR_MS;
/** The account GitHub commits as when its web UI merges, rebases, or updates a branch: its signature is GitHub's, for whoever the commit names. */
const WEB_FLOW = "web-flow";
/** An event waiting to retry this long without a run is dropped. */
const RETRY_MAX_AGE_MS = 7 * 24 * HOUR_MS;
/** Activity that puts a commit at a branch's head as the account recorded as its actor (GitHub's activity types). */
const PUSHES = new Set(["push", "force_push", "branch_creation"]);
/**
 * Activity that puts a pull request's merge at the head. Its actor is who
 * pressed the merge button, who turned auto-merge on (`pr_merge`), or the
 * merge queue's bot (`merge_queue_merge`): only the first vouches for the
 * code merged, so the others are judged by the pull request's head as well.
 */
const MERGES = new Set(["pr_merge", "merge_queue_merge"]);
/** GitHub's activity list lags a push: a head it doesn't list yet is judged again on later polls for this long. */
const ACTIVITY_LAG_MS = 10 * 60 * 1000;
/** Changes to a branch a merged head's chain is followed back through, at most, looking for a trusted head. */
const CHAIN_MAX = 30;
/** Commits one merge may put on a branch and still be judged. */
const MERGE_COMMITS_MAX = 20;
/** Commits judged along one chain, at most: what bounds its calls. */
const CHAIN_COMMITS_MAX = 60;

export interface WatchHost {
  gh: GhExec;
  /** Validate and normalize a repository path; null when unusable. */
  normalizeWorkdir(path: string): string | null;
  /** The URL of `workdir`'s `origin` remote, or null. */
  originUrl(workdir: string): Promise<string | null>;
  /** Start an ordinary run as its owner; throws LoopError (e.g. the owner's cap). */
  startRun(input: LoopStartInput, owner: LoopOwner): LoopRunRow;
  /** The run is still in progress. */
  runActive(runId: string): boolean;
  /** Why the run ended before it had a workspace (the fetch or setup failed), and whether another try could help; or null. */
  runSetupFailure(runId: string): { reason: string; retry: boolean } | null;
  audit(subject: string, action: string, detail: string): void;
}

/** A watch as an owner gives it (the wire spec). */
export interface WatchSpecInput {
  branches?: string[];
  myPrs?: boolean;
  ci?: Array<{ ciName: string; app?: string; command: string; timeoutSec?: number; expectTests?: boolean }>;
  review?: { enabled: boolean; allow?: string[]; mention?: string };
  trust?: string[];
  provider?: string;
  model?: string;
  toolBudget?: number;
  limits?: { attempts?: number; attemptMinutes?: number; runMinutes?: number };
  maxRunsPerHour?: number;
}

export interface PollResult {
  started: string[];
  skipped: string[];
}

/** One place an event can happen: a branch head, and its pull request if it has one. */
interface Target {
  branch: string;
  sha: string;
  /** The repository the branch is in (a fork's, for a fork's pull request); null when GitHub doesn't say. */
  headRepo: string | null;
  pr?: { number: number; url: string };
}

/** Something the watch would start a run for. */
interface Candidate {
  kind: TriggerKind;
  target: Target;
  keys: string[];
  input: LoopStartInput;
}

/** Why a head isn't vouched for; `transient` when GitHub's activity may not list its push yet. */
interface Untrusted {
  why: string;
  transient: boolean;
}

export class WatchService {
  readonly #store: WatchStore;
  readonly #host: WatchHost;
  readonly #pollMs: number;
  readonly #firstPollMs: number;
  readonly #now: () => number;
  #timer: ReturnType<typeof setInterval> | null = null;
  readonly #soon = new Set<ReturnType<typeof setTimeout>>();
  #ticking = false;
  #stopped = false;
  /** One poll per watch at a time: a manual poll joins a running tick's. */
  readonly #inflight = new Map<string, Promise<PollResult>>();
  /**
   * gh logins GitHub rate-limited: no watch acting as one polls before
   * `until`; `n` doubles the wait. A rate limit is the account's, so every
   * watch through that login waits together.
   */
  readonly #backoff = new Map<string, { until: number; n: number }>();
  /**
   * Heads judged while GitHub's activity didn't list their push, and when one
   * first was: each is judged again until {@link ACTIVITY_LAG_MS} has passed.
   * Not kept across a restart, which only gives a head that long again.
   */
  readonly #unlisted = new Map<string, number>();
  /**
   * Watches made, resumed, or given a new trust list since they last polled:
   * their next poll judges every head it watches, and remembers the ones
   * vouched for, so a later merge's chain has a trusted head to end at.
   * Being made is not itself a reason to trust a head.
   */
  readonly #baseline = new Set<string>();

  constructor(store: WatchStore, host: WatchHost, opts: { pollSeconds?: number; firstPollMs?: number; now?: () => number } = {}) {
    this.#store = store;
    this.#host = host;
    this.#pollMs = Math.max(WATCH_DEFAULTS.minPollSeconds, opts.pollSeconds ?? WATCH_DEFAULTS.pollSeconds) * 1000;
    this.#firstPollMs = opts.firstPollMs ?? WATCH_DEFAULTS.firstPollMs;
    this.#now = opts.now ?? Date.now;
  }

  get store(): WatchStore {
    return this.#store;
  }

  start(): void {
    if (this.#timer) return;
    this.#stopped = false;
    this.#timer = setInterval(() => void this.tick(), this.#pollMs);
    this.#timer.unref?.();
    // Not a full interval after the daemon starts: shortly.
    this.#later(() => this.tick());
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    for (const t of this.#soon) clearTimeout(t);
    this.#soon.clear();
  }

  /** Poll every enabled watch, one after another. A failure stays with its watch. */
  async tick(): Promise<void> {
    if (this.#ticking || this.#stopped) return;
    this.#ticking = true;
    try {
      for (const w of this.#store.listEnabled()) {
        if (this.#stopped) break;
        if ((this.#backoff.get(backoffKey(w))?.until ?? 0) > this.#now()) continue;
        try {
          await this.#pollOnce(w.id);
        } catch (err) {
          console.error(`[codeoid/loops] watch ${w.id} poll failed: ${errText(err)}`);
        }
      }
    } finally {
      this.#ticking = false;
    }
  }

  /** Run `fn` shortly, when the service is running. */
  #later(fn: () => Promise<unknown>): void {
    if (!this.#timer || this.#stopped) return;
    const t = setTimeout(() => {
      this.#soon.delete(t);
      fn().catch((err) => console.error(`[codeoid/loops] watch poll failed: ${errText(err)}`));
    }, this.#firstPollMs);
    t.unref?.();
    this.#soon.add(t);
  }

  // ── Management (authorized by SessionManager, owner-scoped here) ──────────

  async create(input: WatchSpecInput & { workdir: string }, owner: LoopOwner): Promise<WatchRow> {
    this.#admit(owner);
    const workdir = this.#host.normalizeWorkdir(input.workdir);
    if (!workdir) throw new LoopError(`workdir not usable: ${input.workdir}`, "invalid_request");
    const origin = await this.#host.originUrl(workdir);
    if (!origin) throw new LoopError("the repository has no `origin` remote; a watch reads events from origin on github.com", "invalid_request");
    const repo = parseGithubRemote(origin);
    if (!repo) throw new LoopError(`origin is not a github.com repository (${redactUrl(origin)})`, "invalid_request");
    const spec = await this.#resolveSpec(input);
    // Again after the awaits: two creates racing must not both pass the bound.
    this.#admit(owner);
    const w = this.#store.create({
      tenant: tenantOf(owner),
      ownerSub: owner.sub,
      ...(owner.name ? { ownerName: owner.name } : {}),
      workdir,
      repo,
      spec,
      at: this.#now(),
    });
    this.#host.audit(owner.sub, "loop.watch.create", `${w.id} ${repo} as @${spec.ghLogin}`);
    this.#baseline.add(w.id);
    this.#later(() => this.#pollOnce(w.id));
    return w;
  }

  /**
   * Watches act through the daemon's one gh login, so they are one person's:
   * whoever has them. Someone else on a shared daemon is refused rather than
   * reading and acting on GitHub as that person.
   */
  #admit(owner: LoopOwner): void {
    if (this.#store.hasOtherOwners(tenantOf(owner), owner.sub)) {
      throw new LoopError("Another user has loop watches on this daemon; watches act through the daemon's gh login, so they belong to one person", "forbidden");
    }
    if (this.#store.listOwned(tenantOf(owner), owner.sub).length >= WATCH_LIMITS.WATCHES_PER_OWNER) {
      throw new LoopError(`You already have ${WATCH_LIMITS.WATCHES_PER_OWNER} loop watches; remove one first`, "conflict");
    }
  }

  get(id: string, owner: LoopOwner): WatchRow {
    const w = this.#store.getOwned(id, tenantOf(owner), owner.sub);
    if (!w) throw new LoopError("Loop watch not found", "not_found");
    return w;
  }

  list(owner: LoopOwner): WatchRow[] {
    return this.#store.listOwned(tenantOf(owner), owner.sub);
  }

  async update(id: string, patch: { enabled?: boolean; spec?: WatchSpecInput }, owner: LoopOwner): Promise<WatchRow> {
    const w = this.get(id, owner);
    const spec = patch.spec ? await this.#resolveSpec(patch.spec, w.spec) : undefined;
    // Resuming sets the floor for comments: what was said while it was paused isn't an event.
    const resumed = patch.enabled === true && !w.enabled;
    const next = this.#store.update(id, {
      ...(spec ? { spec } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(resumed ? { resumedAt: this.#now() } : {}),
    });
    if (!next) throw new LoopError("Loop watch not found", "not_found");
    // A different trust list judges the heads it refused, and the ones it trusted, again.
    if (spec && !sameSet(spec.trust ?? [], w.spec.trust ?? [])) {
      this.#store.forgetUntrusted(next);
      this.#store.forgetTrusted(next);
      this.#baseline.add(id);
    }
    if (resumed) this.#baseline.add(id);
    this.#host.audit(owner.sub, "loop.watch.update", `${id}${patch.enabled !== undefined ? ` enabled=${patch.enabled}` : ""}${spec ? " spec" : ""}`);
    if (resumed) this.#later(() => this.#pollOnce(id));
    return next;
  }

  delete(id: string, owner: LoopOwner): void {
    this.get(id, owner);
    this.#store.delete(id);
    this.#baseline.delete(id);
    this.#host.audit(owner.sub, "loop.watch.delete", id);
  }

  /** Poll one watch now (`codeoid loop watch poll`). */
  async poll(id: string, owner: LoopOwner): Promise<PollResult> {
    const w = this.get(id, owner);
    if (!w.enabled) throw new LoopError("The watch is paused; resume it first", "conflict");
    return this.#pollOnce(id);
  }

  async #resolveSpec(input: WatchSpecInput, current?: WatchSpec): Promise<WatchSpec> {
    const bad = (m: string): never => {
      throw new LoopError(m, "invalid_request");
    };
    const branchesIn = input.branches ?? (input.myPrs === true ? [] : current?.branches ?? []);
    const myPrs = input.myPrs ?? (input.branches !== undefined ? false : current?.myPrs ?? false);
    const branches = [...new Set(branchesIn.map((b) => b.trim()).filter(Boolean))];
    if (myPrs && branches.length > 0) bad("Watch either explicit branches or your open pull requests, not both");
    if (!myPrs && branches.length === 0) bad("Give the branches to watch, or watch your open pull requests");
    if (branches.length > WATCH_LIMITS.BRANCHES_MAX) bad(`At most ${WATCH_LIMITS.BRANCHES_MAX} branches`);
    for (const b of branches) if (!SAFE_BRANCH_RE.test(b)) bad(`Not a usable branch name: ${JSON.stringify(b)}`);

    const ciIn = input.ci ?? current?.ci;
    if (!ciIn?.length) bad("A watch needs at least one CI mapping: the check name and the local command that reproduces it");
    if (ciIn!.length > WATCH_LIMITS.CI_MAX) bad(`At most ${WATCH_LIMITS.CI_MAX} CI mappings`);
    const ci: WatchCiMapping[] = ciIn!.map((c, i) => {
      const ciName = c.ciName?.trim() ?? "";
      const command = c.command?.trim() ?? "";
      const app = (c.app ?? WATCH_DEFAULTS.ciApp).trim().toLowerCase();
      if (!ciName || ciName.length > 200) bad(`CI mapping ${i + 1} needs a check name (at most 200 characters)`);
      if (!command || command.length > LOOP_LIMITS.CHECK_COMMAND_MAX) bad(`CI mapping ${i + 1} needs a command`);
      if (!APP_RE.test(app)) bad(`CI mapping "${ciName}" names an app that isn't a GitHub App slug: ${JSON.stringify(c.app)}`);
      const timeoutSec = c.timeoutSec ?? LOOP_DEFAULTS.checkTimeoutSec;
      if (!Number.isInteger(timeoutSec) || timeoutSec < 1 || timeoutSec > LOOP_LIMITS.CHECK_TIMEOUT_MAX_S) {
        bad(`CI mapping "${ciName}" timeout must be 1–${LOOP_LIMITS.CHECK_TIMEOUT_MAX_S}s`);
      }
      return { ciName, app, command, timeoutSec, ...(c.expectTests ? { expectTests: true } : {}) };
    });

    const logins = (list: string[], max: number, what: string, bots = false): string[] => {
      const out = [...new Set(list.map((l) => l.trim()).filter(Boolean))];
      if (out.length > max) bad(`At most ${max} ${what}`);
      for (const l of out) if (!LOGIN_RE.test(l) && !(bots && BOT_LOGIN_RE.test(l))) bad(`Not a GitHub login: ${JSON.stringify(l)}`);
      return out;
    };
    // The owner as GitHub knows them: trusted for commits, and the default
    // comment author. Read once, when the watch is made.
    let ghLogin = current?.ghLogin;
    if (!ghLogin) {
      try {
        ghLogin = await GitHubSource.me(this.#host.gh);
      } catch (err) {
        bad(`${errText(err)}; a watch reads GitHub as you, through gh`);
      }
    }
    // A bot is trusted as whoever can make it push; these act for everyone.
    const trust = logins(input.trust ?? current?.trust ?? [], WATCH_LIMITS.TRUST_MAX, "trusted logins", true);
    if (trust.some((l) => l.toLowerCase() === WEB_FLOW)) bad("web-flow can't be trusted: GitHub signs its commits for whoever they name");
    for (const l of trust) {
      const why = EVERYONES_BOTS[l.toLowerCase()];
      if (why) bad(`${l.toLowerCase()} can't be trusted: ${why}`);
    }

    const reviewIn = input.review ?? current?.review ?? { enabled: false };
    const mention = (reviewIn.mention ?? current?.review.mention ?? WATCH_DEFAULTS.mention).trim();
    if (!/^\S{2,64}$/.test(mention)) bad("The mention token must be 2–64 characters without spaces");
    let allow = logins(reviewIn.allow ?? current?.review.allow ?? [], WATCH_LIMITS.ALLOW_MAX, "allowed authors");
    // The default: only the person gh is signed in as — the owner.
    if (reviewIn.enabled && allow.length === 0) allow = [ghLogin!];

    const maxRunsPerHour = input.maxRunsPerHour ?? current?.maxRunsPerHour ?? WATCH_DEFAULTS.maxRunsPerHour;
    if (!Number.isInteger(maxRunsPerHour) || maxRunsPerHour < 1 || maxRunsPerHour > WATCH_LIMITS.RUNS_PER_HOUR_MAX) {
      bad(`maxRunsPerHour must be 1–${WATCH_LIMITS.RUNS_PER_HOUR_MAX}`);
    }
    const provider = input.provider ?? current?.provider;
    const model = input.model ?? current?.model;
    const toolBudget = input.toolBudget ?? current?.toolBudget;
    const limits = input.limits ?? current?.limits;
    return {
      branches,
      myPrs,
      ci,
      review: { enabled: reviewIn.enabled, allow, mention },
      ghLogin: ghLogin!,
      trust,
      ...(provider ? { provider } : {}),
      ...(model ? { model } : {}),
      ...(toolBudget !== undefined ? { toolBudget } : {}),
      ...(limits ? { limits } : {}),
      maxRunsPerHour,
    };
  }

  // ── Polling ───────────────────────────────────────────────────────────────

  #pollOnce(id: string): Promise<PollResult> {
    const running = this.#inflight.get(id);
    if (running) return running;
    const p = this.#poll(id).finally(() => this.#inflight.delete(id));
    this.#inflight.set(id, p);
    return p;
  }

  async #poll(id: string): Promise<PollResult> {
    const result: PollResult = { started: [], skipped: [] };
    const w = this.#store.get(id);
    if (!w || !w.enabled) return result;
    const now = this.#now();
    const limiter = backoffKey(w);
    const backoff = this.#backoff.get(limiter);
    if (backoff && backoff.until > now) {
      result.skipped.push(`GitHub is rate-limiting @${w.spec.ghLogin}; this watch polls again after ${new Date(backoff.until).toISOString()}`);
      return result;
    }
    const problems: string[] = [];
    let rateLimited = false;
    // Set when the poll stopped before it acted on everything it read: the
    // next poll reads comments from where this one did.
    let incomplete = false;
    const problem = (where: string, err: unknown): void => {
      if (err instanceof GhError && err.rateLimited) rateLimited = true;
      problems.push(`${where}: ${errText(err)}`);
    };
    const finish = (): PollResult => {
      const note = [...problems, ...result.skipped.filter((s) => !s.includes("picked up after it ends") && !s.includes("still running"))].join("; ");
      this.#store.markPolled(id, now, note || null, problems.length === 0 && !incomplete);
      if (rateLimited) {
        const n = (this.#backoff.get(limiter)?.n ?? 0) + 1;
        this.#backoff.set(limiter, { n, until: now + Math.min(this.#pollMs * 2 ** n, BACKOFF_MAX_MS) });
      } else {
        // Not a rate limit this time: the doubling starts over.
        this.#backoff.delete(limiter);
      }
      return { started: result.started, skipped: [...problems, ...result.skipped] };
    };

    // The watch reads and acts as the login it was made with, and as no one else.
    let login: string;
    try {
      login = await GitHubSource.me(this.#host.gh);
    } catch (err) {
      problem("asking gh who it is signed in as", err);
      return finish();
    }
    if (w.spec.ghLogin && login.toLowerCase() !== w.spec.ghLogin.toLowerCase()) {
      const why = `gh is now signed in as @${login}, but this watch acts as @${w.spec.ghLogin}, so it paused itself; sign gh in as @${w.spec.ghLogin} and resume it, or make a new watch`;
      this.#store.update(id, { enabled: false });
      this.#store.markPolled(id, now, why, false);
      this.#host.audit(w.ownerSub, "loop.watch.pause", `${id} gh login changed to @${login}`);
      return { started: [], skipped: [why] };
    }

    const gh = new GitHubSource(this.#host.gh, w.repo);
    this.#settle(w, result);

    let targets: Target[];
    let openPrs: Set<number> | null;
    try {
      ({ targets, openPrs } = await this.#targets(w, gh, result, problem));
    } catch (err) {
      problem("listing what to watch", err);
      return finish();
    }
    // Events left waiting on a pull request that closed, or for a week, are dropped.
    const expired = this.#store.expireRetries(w, now - RETRY_MAX_AGE_MS, openPrs);
    if (expired > 0) result.skipped.push(`${expired} event(s) waiting to retry expired (their pull request closed, or they waited a week)`);

    // Each head is judged once a poll, however many events are on it.
    const trust = new Map<string, Promise<Untrusted | null>>();
    let defaultBranch: Promise<string> | null = null;
    const judge = (t: Target): Promise<Untrusted | null> => {
      const at = `${t.headRepo ?? ""}:${t.branch}:${t.sha}`;
      let p = trust.get(at);
      if (!p) {
        defaultBranch ??= gh.defaultBranch();
        p = defaultBranch.then((base) => this.#untrusted(w, gh, base, t));
        // A failure is judged again by whoever asks next.
        p.catch(() => trust.delete(at));
        trust.set(at, p);
      }
      return p;
    };

    // A new baseline: the heads vouched for now are what later merges' chains end at.
    if (this.#baseline.has(id)) {
      let judged = true;
      for (const t of targets) {
        if (!t.headRepo || this.#store.seen(w, [untrustedKey(w, t)]).size > 0) continue;
        try {
          if ((await judge(t)) === null) this.#store.rememberTrusted(w, t.headRepo, t.branch, t.sha, now);
        } catch (err) {
          judged = false;
          problem(`${t.branch}: judging its head`, err);
        }
      }
      if (judged) this.#baseline.delete(id);
    }

    const candidates: Candidate[] = [];
    for (const t of targets) {
      // A head already judged untrusted costs no more calls.
      if (this.#store.seen(w, [untrustedKey(w, t)]).size > 0) continue;
      try {
        const ci = await this.#ciCandidate(w, gh, t, now);
        if (typeof ci === "string") result.skipped.push(ci);
        else if (ci) candidates.push(ci);
      } catch (err) {
        problem(t.branch, err);
      }
      if (!w.spec.review.enabled || !t.pr) continue;
      try {
        candidates.push(...(await this.#reviewCandidates(w, gh, t, now)));
      } catch (err) {
        problem(`${t.branch} #${t.pr.number}`, err);
      }
    }

    // Heads no longer polled are forgotten; a day outlasts the longest back-off.
    for (const [k, first] of this.#unlisted) if (first < now - 24 * HOUR_MS) this.#unlisted.delete(k);
    // Per branch, CI comes first: a red branch is repaired before it's changed.
    const busy = new Set<string>();
    for (const c of candidates) {
      if (this.#stopped) {
        incomplete = true;
        break;
      }
      const label = `${c.kind === "ci_failure" ? "CI failure" : "review comment"} on ${c.target.branch}`;
      // A comment is read again only while it waits to retry: one skipped
      // now is kept waiting, so it isn't lost when the comments are next read
      // from a later point. A CI failure is seen again on every poll anyway.
      const skip = (why: string, waitingSince: number | null = null): void => {
        result.skipped.push(why);
        if (c.kind !== "review_comment") return;
        for (const k of c.keys) this.#store.defer(w, k, c.kind, c.target.branch, c.target.pr?.number ?? null, why, waitingSince ?? now);
      };
      const blocked = (): string | null => {
        if (busy.has(c.target.branch) || this.#store.runsOnBranch(w, c.target.branch).some((r) => this.#host.runActive(r))) {
          busy.add(c.target.branch);
          return `${label}: a run is already active on the branch (picked up after it ends)`;
        }
        if (this.#store.runsSince(w.id, now - HOUR_MS) >= w.spec.maxRunsPerHour) {
          return `${label}: the watch started ${w.spec.maxRunsPerHour} runs in the last hour (its bound)`;
        }
        return null;
      };
      const first = blocked();
      if (first) {
        skip(first);
        continue;
      }
      // The run will execute this head's code: its push, or every commit on it, must be vouched for.
      let untrusted: Untrusted | null;
      try {
        untrusted = await judge(c.target);
      } catch (err) {
        problem(`${c.target.branch}: judging who pushed it`, err);
        continue;
      }
      const headKey = untrustedKey(w, c.target);
      if (untrusted?.transient) {
        const first = this.#unlisted.get(headKey) ?? now;
        this.#unlisted.set(headKey, first);
        if (now - first < ACTIVITY_LAG_MS) {
          skip(`${label}: not vouched for yet (${untrusted.why}); judged again on the next poll`);
          continue;
        }
      }
      this.#unlisted.delete(headKey);
      if (untrusted) {
        this.#store.ignore(w, headKey, c.kind, c.target.branch, `not pushed by someone you trust: ${untrusted.why}`, now);
        result.skipped.push(`${label}: not pushed by someone you trust (${untrusted.why})`);
        continue;
      }
      // A later merge's chain on this branch ends at this head.
      if (c.target.headRepo) this.#store.rememberTrusted(w, c.target.headRepo, c.target.branch, c.target.sha, now);
      // From here until the run has started nothing awaits, so a pause, a
      // delete, a change, or another poll can't slip in between the checks
      // and the claim.
      if (this.#stopped) {
        incomplete = true;
        break;
      }
      const cur = this.#store.get(w.id);
      if (!cur?.enabled) {
        result.skipped.push(`${label}: the watch was paused or deleted`);
        incomplete = true;
        break;
      }
      if (cur.updatedAt !== w.updatedAt) {
        result.skipped.push(`${label}: the watch changed while it polled; the next poll uses its new rules`);
        incomplete = true;
        break;
      }
      const again = blocked();
      if (again) {
        skip(again);
        continue;
      }
      const waitingSince = c.kind === "review_comment" ? this.#store.waitingSince(w, c.keys[0]!) : null;
      if (!this.#store.claim(w, c.keys, c.kind, c.target.branch, now, c.target.pr?.number ?? null)) continue;
      let run: LoopRunRow;
      try {
        run = this.#host.startRun(c.input, ownerOf(w));
      } catch (err) {
        this.#store.release(w, c.keys);
        skip(`${label}: ${errText(err)}`, waitingSince);
        continue;
      }
      try {
        this.#store.bind(w, c.keys, run.id);
      } catch (err) {
        // Unbound, the claim would hold the event with no run: give it back.
        this.#store.release(w, c.keys);
        problem(`${label}: recording run ${run.id}`, err);
        continue;
      }
      busy.add(c.target.branch);
      result.started.push(run.id);
      this.#host.audit(w.ownerSub, "loop.watch.trigger", `${w.id} ${c.keys[0]} → ${run.id}`);
    }
    return finish();
  }

  /**
   * Look at the runs this watch started that haven't been seen to end. One
   * that ended without a workspace (its commit couldn't be fetched, its setup
   * failed) gives its event back for another try, up to a bound — unless
   * trying again can't help (a shallow clone), when the event is dropped now.
   */
  #settle(w: WatchRow, result: PollResult): void {
    for (const u of this.#store.unsettled(w)) {
      if (this.#host.runActive(u.runId)) continue;
      const failed = this.#host.runSetupFailure(u.runId);
      if (failed === null) {
        this.#store.settle(w, u.runId);
        continue;
      }
      const gaveUp = this.#store.retryOrGiveUp(w, u, failed.reason, WATCH_LIMITS.SETUP_TRIES, failed.retry);
      result.skipped.push(
        !failed.retry
          ? `run ${u.runId.slice(0, 13)} can't prepare its workspace; its event is dropped: ${failed.reason}`
          : gaveUp
            ? `run ${u.runId.slice(0, 13)} couldn't prepare its workspace ${WATCH_LIMITS.SETUP_TRIES} times; its event is dropped: ${failed.reason}`
            : `run ${u.runId.slice(0, 13)} couldn't prepare its workspace; its event is tried again: ${failed.reason}`,
      );
    }
  }

  /**
   * Why the head at `t` isn't vouched for, or null when it is. Vouched for:
   * GitHub records that a trusted login made the push that put it on its
   * branch (in the repository the branch is in — a fork's, for a fork's pull
   * request); or a merge put it there and {@link #chainUntrusted} vouches for
   * every change to the branch since a head that is vouched for; or it has
   * commits `base..head` and every one is signed, verified by GitHub, and
   * committed by a trusted login. The logins on an unsigned commit are only
   * its emails matched to accounts, which anyone can write; a `web-flow`
   * commit is signed by GitHub for whoever it names; and a head with no
   * commits past `base` has no signature at all. Transient when GitHub's
   * activity may not list the head's push yet.
   */
  async #untrusted(w: WatchRow, gh: GitHubSource, base: string, t: Target): Promise<Untrusted | null> {
    const trusted = new Set([w.spec.ghLogin, ...(w.spec.trust ?? [])].filter((l): l is string => !!l).map((l) => l.toLowerCase()));
    if (trusted.size === 0) return { why: "the watch knows no GitHub login to trust", transient: false };
    const who = (l: string | null) => (l ? `@${l}` : "an account GitHub doesn't name");
    let pushed: string;
    let transient = false;
    const log = t.headRepo ? await gh.activity(t.headRepo, t.branch) : null;
    const at = log ? log.entries.findIndex((a) => a.after === t.sha) : -1;
    const push = at >= 0 ? log!.entries[at]! : null;
    if (!push) {
      pushed = !log ? "GitHub doesn't say which repository the head is in" : log.kept ? "GitHub's activity has no record of the push that made this head" : "GitHub keeps no activity for this repository";
      transient = log?.kept === true;
    } else if (MERGES.has(push.type)) {
      const chain = await this.#chainUntrusted(w, gh, t, log!, at, trusted, who);
      if (!chain) return null;
      pushed = chain.why;
      transient = chain.transient;
    } else if (!PUSHES.has(push.type)) {
      pushed = `this head came from a ${push.type || "change"}, not a push or a merge`;
    } else if (push.actor && trusted.has(push.actor.toLowerCase())) {
      return null;
    } else {
      pushed = `pushed by ${who(push.actor)}`;
    }
    // Not pushed by anyone trusted: every commit must be signed by one.
    const unsigned = await this.#unsigned(gh, base, t.sha, `past ${base}`, trusted, who);
    return unsigned ? { why: `${pushed}, and ${unsigned}`, transient } : null;
  }

  /**
   * Why the merge that put `t`'s head on its branch (`log.entries[at]`)
   * doesn't vouch for it, or null when it does. A merge vouches for what it
   * merged, not for what was already on the branch beneath it, so the
   * branch's activity is followed back from it: each step is to the newest
   * older change that left the branch at the head the last one began from
   * (its `before`). The walk ends, vouched for, at a head that is: nothing
   * (the branch's first change began from nothing), the head this watch last
   * judged trusted on the branch, or a push by a trusted login (a trusted push
   * vouches for everything beneath it). Every change on the way must be a
   * merge {@link #mergeUntrusted} vouches for. Anything else on the way — an
   * untrusted push or merge, a change of another kind, a head this watch
   * recorded untrusted, more than {@link CHAIN_MAX} changes, or a step past
   * the activity pages read — and the merge vouches for nothing.
   *
   * Only the watched repository's own branches are followed: a merge names
   * its pull requests there.
   */
  async #chainUntrusted(
    w: WatchRow,
    gh: GitHubSource,
    t: Target,
    log: BranchActivity,
    at: number,
    trusted: Set<string>,
    who: (l: string | null) => string,
  ): Promise<Untrusted | null> {
    const repo = t.headRepo!;
    if (repo.toLowerCase() !== w.repo.toLowerCase()) return { why: `merged into ${repo}, not the watched repository`, transient: false };
    const remembered = this.#store.lastTrusted(w, repo, t.branch);
    if (remembered === t.sha) return null;
    const isTrusted = (l: string | null) => !!l && trusted.has(l.toLowerCase());
    const budget = { commits: CHAIN_COMMITS_MAX };
    for (let i = at, step = 0; ; step++) {
      const cur = log.entries[i]!;
      // The head's own change speaks for the head; one beneath it is named.
      const beneath = step === 0 ? "" : `${cur.after.slice(0, 12)}, beneath it, `;
      if (step >= CHAIN_MAX) return { why: `more than ${CHAIN_MAX} changes to ${t.branch} since a head that is vouched for`, transient: false };
      if (step > 0 && this.#store.seen(w, [untrustedKey(w, { branch: t.branch, sha: cur.after, headRepo: repo })]).size > 0) {
        return { why: `${beneath}was judged untrusted`, transient: false };
      }
      if (PUSHES.has(cur.type)) return isTrusted(cur.actor) ? null : { why: `${beneath}was pushed by ${who(cur.actor)}`, transient: false };
      if (!MERGES.has(cur.type)) return { why: `${beneath}came from a ${cur.type || "change"}, not a push or a merge`, transient: false };
      const merge = await this.#mergeUntrusted(gh, repo, t.branch, cur, trusted, who, budget);
      if (merge) return step === 0 ? merge : { why: `${beneath}${merge.why}`, transient: merge.transient };
      if (cur.before === NO_COMMIT || cur.before === remembered) return null;
      const next = await log.olderTo(i, cur.before);
      if (next < 0) {
        const read = log.truncated ? ` (the newest ${ACTIVITY_PAGES_MAX * 100} entries read)` : "";
        return { why: `GitHub's activity${read} has no record of how ${cur.before.slice(0, 12)} came to be on ${t.branch}`, transient: false };
      }
      i = next;
    }
  }

  /**
   * Why the merge `entry` isn't vouched for, or null when it is. What it put
   * on `branch` are the commits from its `after` down first parents to its
   * `before`, at most {@link MERGE_COMMITS_MAX}: one for a merge commit or a
   * squash, one per pull request for a stack or a merge queue batch, one per
   * commit for a rebase. Each must be the merge commit of exactly one merged
   * pull request of `repo` that {@link #pullUntrusted} vouches for — except,
   * directly beneath a pull request's merge commit, commits with none of
   * their own, as many as that pull request had beyond one: a rebase merge,
   * which GitHub names its pull request at only for the last commit.
   * `budget.commits` bounds the commits judged along the whole chain.
   * Transient when GitHub may not have linked a commit to its pull request
   * yet, or listed the push of a pull request's head.
   */
  async #mergeUntrusted(
    gh: GitHubSource,
    repo: string,
    branch: string,
    entry: ActivityEntry,
    trusted: Set<string>,
    who: (l: string | null) => string,
    budget: { commits: number },
  ): Promise<Untrusted | null> {
    if (!entry.before || !entry.after) return { why: `merged by ${who(entry.actor)}, but GitHub doesn't say what it moved ${branch} from and to`, transient: false };
    let sha = entry.after;
    let rebased = 0;
    for (let n = 0; sha !== entry.before; n++) {
      const id = sha.slice(0, 12);
      if (n >= MERGE_COMMITS_MAX) return { why: `merged by ${who(entry.actor)}, putting more than ${MERGE_COMMITS_MAX} commits on ${branch}`, transient: false };
      if (--budget.commits < 0) return { why: `more than ${CHAIN_COMMITS_MAX} commits were merged onto ${branch} since a head that is vouched for`, transient: false };
      const found = await gh.mergedAs(repo, sha);
      if (found.kind === "many") {
        const prs = found.numbers.map((p) => `#${p}`).join(", ");
        return { why: `${id} is the merge commit of ${found.numbers.length} pull requests (${prs}), so none of them vouches for it`, transient: false };
      }
      let parent: string;
      if (found.kind === "one") {
        const bad = await this.#pullUntrusted(gh, entry, found.pull, sha, trusted, who);
        if (bad) return bad;
        rebased = Math.max(0, found.pull.commits - 1);
        parent = found.pull.parent;
      } else if (rebased > 0) {
        rebased--;
        parent = await gh.firstParent(sha);
      } else {
        const what = n === 0 ? "this commit" : id;
        return { why: `merged by ${who(entry.actor)}, but GitHub names no pull request it merged as ${what}`, transient: true };
      }
      // A merge onto nothing (the branch's first change) reaches the root.
      if (!parent) return entry.before === NO_COMMIT ? null : { why: `GitHub doesn't say what ${id} was made on`, transient: false };
      sha = parent;
    }
    return null;
  }

  /**
   * Why `pull`, merged as `sha` by the change `entry`, isn't vouched for, or
   * null when it is. Merged with the button, it is vouched for by who pressed
   * it: the change's actor, whom GitHub must also record as having merged
   * it, and who must be trusted. Auto-merged, or through the merge queue, the
   * change's actor didn't merge what was there at the end: auto-merge merges
   * commits anyone with write access pushed after it was turned on, and the
   * merge queue's bot is the actor of every queued merge. Then it is vouched
   * for only when trusted logins merged it (turned auto-merge on: the
   * change's actor, and whom GitHub records as having merged it; or queued
   * it) and its final head is itself trusted: pushed by a trusted login, or
   * every commit on it signed by one — never through another merge.
   */
  async #pullUntrusted(
    gh: GitHubSource,
    entry: ActivityEntry,
    pull: MergedPull,
    sha: string,
    trusted: Set<string>,
    who: (l: string | null) => string,
  ): Promise<Untrusted | null> {
    const isTrusted = (l: string | null) => !!l && trusted.has(l.toLowerCase());
    const queued = entry.type === "merge_queue_merge";
    if (!queued && !pull.autoMerged) {
      if (!isTrusted(entry.actor)) return { why: `merged by ${who(entry.actor)}`, transient: false };
      if (pull.mergedBy?.toLowerCase() !== entry.actor!.toLowerCase()) {
        return { why: `merged by ${who(entry.actor)}, but GitHub records pull request #${pull.number} as merged by ${who(pull.mergedBy)}`, transient: false };
      }
      return null;
    }
    const how = `pull request #${pull.number}, ${queued ? "merged by the merge queue" : "auto-merged"}`;
    const merger = queued || isTrusted(entry.actor) ? pull.mergedBy : entry.actor;
    if (!isTrusted(merger)) return { why: `${how}, ${queued ? "queued" : "with auto-merge turned on"} by ${who(merger)}`, transient: false };
    if (!pull.headRepo || !pull.headSha) return { why: `${how}, from a head GitHub no longer names`, transient: false };
    const head = await gh.pushOf(pull.headRepo, pull.headRef, pull.headSha);
    let last: string;
    if (!head.push) {
      last = head.kept ? "GitHub's activity has no record of the push of its last commit" : "GitHub keeps no activity for the repository its last commit is in";
    } else if (!PUSHES.has(head.push.type)) {
      last = `its last commit came from a ${head.push.type || "change"}, not a push`;
    } else if (isTrusted(head.push.actor)) {
      return null;
    } else {
      last = `its last commit was pushed by ${who(head.push.actor)}`;
    }
    // What it merged: its commits. The merge commit's first parent is the
    // branch before a merge or a squash, and the commit before it for a
    // rebase merge; either way, compare lists the pull request's own.
    const unsigned = await this.#unsigned(gh, `${sha}^1`, pull.headSha, "of its own", trusted, who);
    return unsigned ? { why: `${how}; ${last}, and ${unsigned}`, transient: !head.push && head.kept } : null;
  }

  /**
   * Why the commits `base..head` don't vouch for `head`, or null when every
   * one is signed by a trusted login. `scope` says which commits they are in
   * the reason ("past main", "of its own").
   */
  async #unsigned(gh: GitHubSource, base: string, head: string, scope: string, trusted: Set<string>, who: (l: string | null) => string): Promise<string | null> {
    const commits = await gh.commitsBetween(base, head);
    if (!commits) return `it has more than ${COMMITS_MAX} commits ${scope} (or GitHub listed fewer than it counted)`;
    if (commits.length === 0) return `it has no commits ${scope}, so no signature vouches for it`;
    for (const c of commits) {
      const id = c.sha.slice(0, 12);
      if (!c.verified) return `${id} isn't signed and verified`;
      const committer = c.committer?.toLowerCase() ?? null;
      // GitHub's buttons commit as web-flow and sign for whoever the commit names, which the commit says itself.
      if (committer === WEB_FLOW) return `${id} was committed on GitHub by web-flow, whose signature vouches for no one`;
      if (!committer || !trusted.has(committer)) return `${id} is signed by ${who(c.committer)}`;
    }
    return null;
  }

  /**
   * The branch heads this watch looks at, and the numbers of the owner's open
   * pull requests (null when there may be more than were listed). A branch
   * that can't be read is a problem for that branch only.
   */
  async #targets(
    w: WatchRow,
    gh: GitHubSource,
    result: PollResult,
    problem: (where: string, err: unknown) => void,
  ): Promise<{ targets: Target[]; openPrs: Set<number> | null }> {
    const wantPrs = w.spec.myPrs || w.spec.review.enabled;
    const prs = wantPrs ? await gh.myOpenPrs() : [];
    const openPrs = wantPrs && prs.length < PRS_MAX ? new Set(prs.map((p) => p.number)) : null;
    const usable = prs.filter((p) => SAFE_BRANCH_RE.test(p.headRefName) && /^[0-9a-f]{40}$/.test(p.headRefOid));
    if (w.spec.myPrs) {
      if (usable.length > WATCH_LIMITS.PR_TARGETS_MAX) {
        result.skipped.push(`watching the newest ${WATCH_LIMITS.PR_TARGETS_MAX} of your ${usable.length} open pull requests`);
      }
      const targets = usable
        .slice(0, WATCH_LIMITS.PR_TARGETS_MAX)
        .map((p) => ({ branch: p.headRefName, sha: p.headRefOid, headRepo: p.headRepo, pr: { number: p.number, url: p.url } }));
      return { targets, openPrs };
    }
    const out: Target[] = [];
    for (const branch of w.spec.branches) {
      // A watched branch is this repository's: a fork's branch of the same name is someone else's.
      const pr = usable.find((p) => p.headRefName === branch && p.headRepo !== null && p.headRepo.toLowerCase() === w.repo.toLowerCase());
      let sha: string;
      try {
        sha = pr?.headRefOid ?? (await gh.branchHead(branch));
      } catch (err) {
        problem(branch, err);
        continue;
      }
      if (!/^[0-9a-f]{40}$/.test(sha)) continue;
      out.push({ branch, sha, headRepo: w.repo, ...(pr ? { pr: { number: pr.number, url: pr.url } } : {}) });
    }
    return { targets: out, openPrs };
  }

  /**
   * Failed checks on the target's head that map to a command: one run for all
   * of them, once every mapped check on the head has finished. Its checks are
   * every mapped command with a check run on the head — the failing ones are
   * what it repairs, the passing ones what it must keep passing. A string is
   * why it waits.
   */
  async #ciCandidate(w: WatchRow, gh: GitHubSource, t: Target, now: number): Promise<Candidate | string | null> {
    const runs = await gh.checkRuns(t.sha);
    const mapped = runs
      .map((r) => ({ run: r, maps: w.spec.ci.filter((m) => ciMatches(m, r)) }))
      .filter((f) => f.maps.length > 0);
    const failing = mapped
      .filter((f) => f.run.status === "completed" && f.run.conclusion !== null && FAILED.has(f.run.conclusion))
      // The check run's own id, and its suite's: a re-run is a new check run.
      .map((f) => ({ ...f, key: `ci:${w.repo}:${t.sha}:${f.run.id}:${f.run.suiteId ?? 0}` }));
    const seen = this.#store.seen(w, failing.map((f) => f.key));
    const fresh = failing.filter((f) => !seen.has(f.key));
    if (fresh.length === 0) return null;
    const pending = mapped.filter((f) => f.run.status !== "completed").length;
    if (pending > 0) return `CI failure on ${t.branch}: ${pending} mapped check(s) still running on its head (one run once they finish)`;
    // A loop's own delivery, pushed by the owner and failing again, is not
    // repaired by another loop: that is how a trigger cycle starts.
    const subject = (await gh.commitMessage(t.sha)).split("\n")[0] ?? "";
    if (subject.startsWith(DELIVERY_SUBJECT_PREFIX)) {
      for (const f of fresh) this.#store.ignore(w, f.key, "ci_failure", t.branch, "the commit is a loop's own delivery", now);
      return null;
    }
    const first = fresh[0]!;
    const trigger: LoopTrigger = {
      kind: "ci_failure",
      key: first.key,
      watchId: w.id,
      ...(first.run.url ? { url: first.run.url } : {}),
      summary: ciSummary(fresh.map((f) => f.run)),
    };
    return {
      kind: "ci_failure",
      target: t,
      keys: fresh.map((f) => f.key),
      input: this.#runInput(w, t, mapped.flatMap((f) => f.maps), trigger, ciObjective(t, fresh.length)),
    };
  }

  /**
   * Comments addressed to codeoid by an allowed author, in their own words
   * (not a quote of someone else's), published since the watch was created or
   * last resumed, and never edited: anyone with write access to the
   * repository can edit an allowed author's comment, and an edited one is
   * ignored for good.
   */
  async #reviewCandidates(w: WatchRow, gh: GitHubSource, t: Target, now: number): Promise<Candidate[]> {
    const allow = new Set(w.spec.review.allow.map((l) => l.toLowerCase()));
    const floor = Math.max(w.createdAt, w.resumedAt ?? 0) - CREATED_SKEW_MS;
    // Read from shortly before the last complete poll — unless an event waits
    // to retry, which may be older than that.
    const since = w.lastOkAt !== null && !this.#store.hasRetries(w, "review_comment") ? Math.max(floor, w.lastOkAt - SINCE_SKEW_MS) : floor;
    const comments = (await gh.prComments(t.pr!.number, since))
      .filter((c) => c.createdAt >= floor && allow.has(c.author.toLowerCase()))
      .map((c) => ({ ...c, own: unquoted(c.body) }))
      .filter((c) => mentions(c.own, w.spec.review.mention));
    const keyed = comments.map((c) => ({ c, key: `review:${w.repo}:${c.kind}:${c.id}` }));
    const seen = this.#store.seen(w, keyed.map((k) => k.key));
    const fresh = keyed.filter((k) => !seen.has(k.key));
    // One waiting to retry is ignored too: its retry row is overwritten.
    for (const { c, key } of fresh) if (c.edited) this.#store.ignore(w, key, "review_comment", t.branch, "edited after it was made", now);
    return fresh
      .filter(({ c }) => !c.edited)
      .map(({ c, key }) => ({
        kind: "review_comment" as const,
        target: t,
        keys: [key],
        input: this.#runInput(
          w,
          t,
          w.spec.ci,
          { kind: "review_comment", key, watchId: w.id, ...(c.url ? { url: c.url } : {}), summary: commentSummary(c, c.own) },
          reviewObjective(t),
        ),
      }));
  }

  #runInput(w: WatchRow, t: Target, maps: WatchCiMapping[], trigger: LoopTrigger, objective: string): LoopStartInput {
    return {
      objective,
      workdir: w.workdir,
      checks: checksOf(dedupeMappings(maps)),
      ...(w.spec.provider ? { provider: w.spec.provider } : {}),
      ...(w.spec.model ? { model: w.spec.model } : {}),
      ...(w.spec.toolBudget !== undefined ? { toolBudget: w.spec.toolBudget } : {}),
      ...(w.spec.limits ? { limits: w.spec.limits } : {}),
      // Only a head a trusted login pushed or merged into, or whose every commit one signed, gets here.
      baseRef: {
        sha: t.sha,
        branch: t.branch,
        repo: w.repo,
        fetchRef: t.pr ? `refs/pull/${t.pr.number}/head` : `refs/heads/${t.branch}`,
        trusted: true,
      },
      trigger,
    };
  }
}

// ── Templates ────────────────────────────────────────────────────────────────
// The objective is fixed text plus values the daemon validated (a branch name,
// a commit id, a number). Everything GitHub users wrote goes in the trigger's
// summary, which the worker sees only as data.

function ciObjective(t: Target, n: number): string {
  return [
    `Repair the CI failure${n > 1 ? "s" : ""} on branch \`${t.branch}\` at commit ${t.sha.slice(0, 12)}${t.pr ? ` (pull request #${t.pr.number})` : ""}.`,
    "Make the checks below pass on this branch's code. The CI report that started this run is quoted separately, as data.",
  ].join("\n");
}

function reviewObjective(t: Target): string {
  return [
    `Address the review comment on pull request #${t.pr!.number} (branch \`${t.branch}\`, commit ${t.sha.slice(0, 12)}).`,
    "The comment is quoted separately, as data. Make the change it asks for in this code, keep the checks below passing, and report `needs_input` if it is unclear or asks for something outside this repository.",
  ].join("\n");
}

function ciSummary(runs: CheckRunRecord[]): string {
  const per = Math.max(500, Math.floor(WATCH_LIMITS.EVENT_TEXT_MAX / runs.length));
  return runs
    .map((r) => {
      const body = [r.title, r.summary, r.text].map((s) => s.trim()).filter(Boolean).join("\n\n");
      return `Check "${r.name}" concluded ${r.conclusion}.${body ? `\n${body}` : ""}`.slice(0, per);
    })
    .join("\n\n")
    .slice(0, WATCH_LIMITS.EVENT_TEXT_MAX);
}

/** The comment in its author's own words: quotes of others and code left out. */
function commentSummary(c: CommentRecord, own: string): string {
  const where = c.path ? ` on ${c.path}${c.line ? `:${c.line}` : ""}` : "";
  const what = c.kind === "review_body" ? "Review" : "Comment";
  return `${what} by @${c.author}${where}:\n${own}`.slice(0, WATCH_LIMITS.EVENT_TEXT_MAX);
}

function ciMatches(m: WatchCiMapping, r: CheckRunRecord): boolean {
  return r.app.toLowerCase() === (m.app ?? WATCH_DEFAULTS.ciApp) && globMatch(m.ciName, r.name);
}

/** The ledger key that marks a head this watch won't act on: who pushed it is a fact about the branch, so the branch is in it. */
function untrustedKey(w: WatchRow, t: Target): string {
  return `untrusted:${w.id}:${t.sha}:${t.headRepo ?? ""}:${t.branch}`;
}

/** Watches acting as one gh login share its rate limit. */
function backoffKey(w: WatchRow): string {
  return (w.spec.ghLogin ?? `watch:${w.id}`).toLowerCase();
}

function sameSet(a: string[], b: string[]): boolean {
  const x = new Set(a.map((l) => l.toLowerCase()));
  const y = new Set(b.map((l) => l.toLowerCase()));
  return x.size === y.size && [...x].every((l) => y.has(l));
}

function dedupeMappings(maps: WatchCiMapping[]): WatchCiMapping[] {
  const seen = new Set<string>();
  return maps.filter((m) => {
    if (seen.has(m.command)) return false;
    seen.add(m.command);
    return true;
  });
}

/** A check per mapping, with ids from the mapping's name. */
function checksOf(maps: WatchCiMapping[]): LoopStartInput["checks"] {
  const used = new Set<string>();
  return maps.map((m) => {
    const base = m.ciName.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 36) || "ci";
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
    used.add(id);
    return { id, command: m.command, timeoutSec: m.timeoutSec, ...(m.expectTests ? { expectTests: true } : {}) };
  });
}

function ownerOf(w: WatchRow): LoopOwner {
  return { sub: w.ownerSub, ...(w.ownerName ? { name: w.ownerName } : {}), accountId: w.accountId, projectId: w.projectId };
}

function tenantOf(owner: LoopOwner): LoopTenant {
  return { accountId: owner.accountId, projectId: owner.projectId };
}

/** A remote URL without any credentials in it. */
function redactUrl(url: string): string {
  return url.replace(/\/\/[^@/]+@/, "//");
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
