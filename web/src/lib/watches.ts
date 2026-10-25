/**
 * Loop watches (docs/loops.md "Watches") — the words for a watch's state and
 * the events it acted on, the create form's validation, the trust list's
 * diff (and what narrowing it forgets), and the vouch flow's compare-and-set.
 * Pure, so the decisions are tested without a reactive root.
 */

import { optionalInt } from "./automation";
import type {
  LoopRunWire,
  LoopWatchCreateMsg,
  LoopWatchSpecWire,
  LoopWatchTriggerWire,
  LoopWatchWire,
} from "../protocol/types";

// ── State ────────────────────────────────────────────────────────────────────

export type WatchHealthKind = "ok" | "pending" | "problem" | "backoff" | "paused" | "self_paused";

export interface WatchHealth {
  kind: WatchHealthKind;
  label: string;
  cls: string;
  /** What it means, for a title or a callout. */
  meaning: string;
}

/** GitHub rate-limited the watch's login: every watch on it backs off together. */
export function isRateLimited(lastError: string | null): boolean {
  return !!lastError && /rate[- ]?limit/i.test(lastError);
}

/** The watch paused itself (gh is signed in as someone else, docs "Limits of a watch's authority"). */
export function isSelfPaused(w: Pick<LoopWatchWire, "enabled" | "lastError">): boolean {
  return !w.enabled && !!w.lastError && /paused itself/i.test(w.lastError);
}

export function watchHealth(w: Pick<LoopWatchWire, "enabled" | "lastError" | "lastPolledAt">): WatchHealth {
  if (isSelfPaused(w)) {
    return {
      kind: "self_paused",
      label: "paused itself",
      cls: "border-danger/60 bg-danger/15 text-danger",
      meaning: w.lastError ?? "",
    };
  }
  if (!w.enabled) {
    return {
      kind: "paused",
      label: "paused",
      cls: "border-border bg-bg/40 text-fg-muted",
      meaning: "Paused: it doesn't poll. Runs it already started carry on.",
    };
  }
  if (isRateLimited(w.lastError)) {
    return {
      kind: "backoff",
      label: "backing off",
      cls: "border-warn/60 bg-warn/15 text-warn",
      meaning:
        "GitHub is rate-limiting this login. Every watch acting as it backs off together: two poll intervals, then four, doubling up to six hours.",
    };
  }
  if (w.lastError) {
    return {
      kind: "problem",
      label: "needs a look",
      cls: "border-danger/40 bg-danger/5 text-danger",
      meaning: "The last poll couldn't finish, or had to skip something. The next poll tries again.",
    };
  }
  if (!w.lastPolledAt) {
    return { kind: "pending", label: "first poll soon", cls: "border-accent/50 bg-accent/10 text-accent", meaning: "It polls a few seconds after it is made or resumed." };
  }
  return { kind: "ok", label: "watching", cls: "border-success/50 bg-success/10 text-success", meaning: "Polling GitHub on schedule." };
}

/** What a watch watches, in words. */
export function watchTargetText(w: Pick<LoopWatchWire, "myPrs" | "branches">): string {
  if (w.myPrs) return "your open pull requests";
  return w.branches.join(", ");
}

/** The loop runs (among the ones this client has listed) a watch started. */
export function runsStartedBy(watchId: string, runs: readonly LoopRunWire[]): LoopRunWire[] {
  return runs.filter((r) => r.trigger?.watchId === watchId);
}

/** A CI mapping as the CLI writes it: `test (*)@circleci-checks → bun test`. */
export function ciMappingText(c: { ciName: string; app?: string; command: string }): { check: string; command: string } {
  const app = c.app && c.app !== DEFAULT_CI_APP ? `@${c.app}` : "";
  return { check: `${c.ciName}${app}`, command: c.command };
}

// ── History ──────────────────────────────────────────────────────────────────

export const TRIGGER_KIND: Record<LoopWatchTriggerWire["kind"], { label: string; meaning: string }> = {
  ci_failure: { label: "failing check", meaning: "A mapped CI check failed on a watched head." },
  review_comment: { label: "review comment", meaning: "A comment addressed to codeoid on your pull request." },
  trust_anchor: { label: "you vouched", meaning: "You vouched for this branch's head: it and everything beneath it are trusted." },
  head: { label: "untrusted head", meaning: "A watched head the watch judged untrusted, with no event on it." },
};

export const TRIGGER_OUTCOME: Record<LoopWatchTriggerWire["outcome"], { label: string; cls: string; meaning: string }> = {
  run: { label: "started a run", cls: "border-accent/50 bg-accent/10 text-accent", meaning: "It started a repair run." },
  ignored: {
    label: "ignored",
    cls: "border-border bg-bg/40 text-fg-muted",
    meaning: "Ignored for good: a later poll doesn't ask again (changing the trust list judges ignored heads again).",
  },
  retry: {
    label: "will retry",
    cls: "border-warn/50 bg-warn/10 text-warn",
    meaning: "Skipped for now (a run still going, a limit, a workspace that couldn't be prepared); a later poll tries again.",
  },
  vouched: { label: "vouched", cls: "border-success/50 bg-success/10 text-success", meaning: "A head you vouched for." },
};

export interface KnownHead {
  sha: string;
  /** Where the watch saw it. */
  source: "untrusted head" | "failing check" | "your last vouch";
  at: string;
}

/**
 * The newest head the watch's history names for each branch. The wire has no
 * "current head" read, so this is the best this client knows — the vouch
 * dialog pins to it and the daemon's compare-and-set says if it moved.
 *
 * Keys (src/daemon/loops): `untrusted:<watch>:<sha>:<headRepo>:<branch>`,
 * `vouch:<watch>:<repo>:<branch>:<sha>`, `ci:<repo>:<sha>:<checkRun>:<suite>`.
 * Git refnames can't hold ':', so splitting on it is safe.
 */
export function knownHeads(triggers: readonly LoopWatchTriggerWire[]): Record<string, KnownHead> {
  const out: Record<string, KnownHead> = {};
  const seen = (branch: string, h: KnownHead) => {
    const prev = out[branch];
    if (!prev || Date.parse(h.at) > Date.parse(prev.at)) out[branch] = h;
  };
  for (const t of triggers) {
    const parts = t.key.split(":");
    let sha: string | undefined;
    let source: KnownHead["source"] | undefined;
    if (parts[0] === "untrusted" && parts.length >= 5) {
      // A fork's head (headRepo set) isn't the branch's head in this repository.
      if (parts[3]) continue;
      sha = parts[2];
      source = "untrusted head";
    } else if (parts[0] === "vouch" && parts.length >= 5) {
      sha = parts[parts.length - 1];
      source = "your last vouch";
    } else if (parts[0] === "ci" && parts.length >= 5) {
      sha = parts[2];
      source = "failing check";
    }
    if (sha && source && /^[0-9a-f]{12,40}$/i.test(sha)) seen(t.branch, { sha: sha.toLowerCase(), source, at: t.createdAt });
  }
  return out;
}

/** The daemon's compare-and-set refusal: `main's head is <sha> now, not <pinned>: it moved, …`. */
export function parseMovedHead(error: string): { branch: string; now: string; pinned: string } | null {
  const m = /^(.+?)'s head is ([0-9a-f]{7,40}) now, not ([0-9a-f]{7,40}): it moved/i.exec(error.trim());
  return m ? { branch: m[1]!, now: m[2]!.toLowerCase(), pinned: m[3]!.toLowerCase() } : null;
}

export const SHA_RE = /^[0-9a-f]{12,40}$/i;

/**
 * The `trustHead` to send for a vouch: `true` (whatever each head is when the
 * daemon reads it) or a branch → commit record (compare-and-set: nothing is
 * vouched for if any named head moved).
 */
export function buildTrustHead(
  pinned: boolean,
  picks: readonly { branch: string; on: boolean; sha: string }[],
): { trustHead: true | Record<string, string> } | { error: string } {
  const chosen = picks.filter((p) => p.on);
  if (chosen.length === 0) return { error: "Choose at least one branch to vouch for" };
  if (!pinned) {
    // `true` vouches for every watched branch; a subset needs the record.
    if (chosen.length !== picks.length) return { error: "Vouching for some branches only needs each one pinned to its commit" };
    return { trustHead: true };
  }
  const rec: Record<string, string> = {};
  for (const p of chosen) {
    const sha = p.sha.trim();
    if (!SHA_RE.test(sha)) return { error: `${p.branch}: give at least 12 hex characters of the commit you looked at` };
    rec[p.branch] = sha.toLowerCase();
  }
  return { trustHead: rec };
}

// ── Trust list ───────────────────────────────────────────────────────────────

/** GitHub commits, merges and pushes as these for everyone with write access (docs "Who a watch trusts"). */
export const REFUSED_TRUST = ["web-flow", "github-merge-queue[bot]", "github-actions[bot]"] as const;
export const TRUST_MAX = 20;

const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const BOT_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,33})\[bot\]$/;

/** A login the trust list (or the review allow list) may hold, or why not. */
export function checkLogin(raw: string, opts: { bots: boolean }): { login: string } | { error: string } {
  const login = raw.trim().replace(/^@/, "");
  if (!login) return { error: "Give a GitHub login" };
  if (REFUSED_TRUST.some((r) => r.toLowerCase() === login.toLowerCase())) {
    return {
      error: `${login} can't be trusted: GitHub acts as it for everyone with write access, so trusting it would trust everyone`,
    };
  }
  if (BOT_RE.test(login)) {
    return opts.bots ? { login } : { error: `${login} is a bot; only people can be allowed here` };
  }
  if (!LOGIN_RE.test(login)) return { error: `"${login}" isn't a GitHub login` };
  return { login };
}

/** Logins from a comma/space separated field, each checked. */
export function parseLogins(raw: string, opts: { bots: boolean; max: number; what: string }): { logins: string[] } | { error: string } {
  const out: string[] = [];
  for (const part of raw.split(/[\s,]+/).filter(Boolean)) {
    const c = checkLogin(part, opts);
    if ("error" in c) return c;
    if (!out.some((l) => l.toLowerCase() === c.login.toLowerCase())) out.push(c.login);
  }
  if (out.length > opts.max) return { error: `At most ${opts.max} ${opts.what}` };
  return { logins: out };
}

export interface TrustDiff {
  added: string[];
  removed: string[];
  /** Narrowing: every remembered and vouched-for head is forgotten. */
  forgets: boolean;
  /** What saving does, in docs/loops.md's terms. */
  explanation: string;
}

/** What changing the trust list from `before` to `after` does. Logins compare case-insensitively. */
export function trustDiff(before: readonly string[], after: readonly string[]): TrustDiff {
  const lower = (xs: readonly string[]) => new Set(xs.map((x) => x.toLowerCase()));
  const b = lower(before);
  const a = lower(after);
  const added = after.filter((x) => !b.has(x.toLowerCase()));
  const removed = before.filter((x) => !a.has(x.toLowerCase()));
  const forgets = removed.length > 0;
  let explanation: string;
  if (!forgets && added.length === 0) explanation = "No change.";
  else if (!forgets) {
    explanation =
      "Only adds logins: everyone trusted before still is, so the heads the watch judged trusted and the heads you vouched for are kept. Heads it ignored as untrusted are judged again under the new list.";
  } else {
    explanation = `Drops ${removed.join(", ")}: the watch forgets every head it judged trusted and every head you vouched for, and judges them again under the new list. A branch whose chain can't reach a trusted head stays untrusted until a trusted login pushes to it or you vouch for its head again.`;
  }
  return { added, removed, forgets, explanation };
}

// ── Create form ──────────────────────────────────────────────────────────────

export const DEFAULT_CI_APP = "github-actions";
export const WATCH_DEFAULTS = { maxRunsPerHour: 6, mention: "@codeoid" } as const;
const CI_MAX = 10;
const APP_RE = /^[a-z0-9][a-z0-9-]{0,99}$/;

export interface CiRow {
  ciName: string;
  /** Blank = github-actions. */
  app: string;
  command: string;
  timeoutSec: string;
  expectTests: boolean;
}

export interface WatchForm {
  workdir: string;
  target: "branches" | "my_prs";
  /** Comma or space separated. */
  branches: string;
  ci: CiRow[];
  review: boolean;
  /** Comma or space separated; blank = you. */
  allow: string;
  mention: string;
  /** Comma or space separated. */
  trust: string;
  maxRunsPerHour: string;
  /** Vouch for the branches' heads as they are when the daemon reads them. */
  trustHead: boolean;
  provider: string;
  model: string;
}

export function emptyCiRow(): CiRow {
  return { ciName: "", app: "", command: "", timeoutSec: "", expectTests: false };
}

export function emptyWatchForm(): WatchForm {
  return {
    workdir: "",
    target: "my_prs",
    branches: "",
    ci: [emptyCiRow()],
    review: false,
    allow: "",
    mention: "",
    trust: "",
    maxRunsPerHour: "",
    trustHead: false,
    provider: "",
    model: "",
  };
}

export function parseBranches(raw: string): string[] {
  return [...new Set(raw.split(/[\s,]+/).map((b) => b.trim()).filter(Boolean))];
}

/** The `loop.watch.create` body for a filled form (without the request id), or the first thing wrong. */
export function buildWatchCreate(form: WatchForm): { msg: Omit<LoopWatchCreateMsg, "id"> } | { error: string; field: string } {
  const workdir = form.workdir.trim();
  if (!workdir) return { error: "Choose the repository: its origin must be on github.com", field: "workdir" };
  const branches = form.target === "branches" ? parseBranches(form.branches) : [];
  if (form.target === "branches") {
    if (branches.length === 0) return { error: "Name at least one branch, or watch your pull requests instead", field: "branches" };
    if (branches.length > 20) return { error: "At most 20 branches", field: "branches" };
    const bad = branches.find((b) => b.length > 200 || /[:\s~^?*[\\]/.test(b));
    if (bad) return { error: `"${bad}" isn't a branch name`, field: "branches" };
  }
  const rows = form.ci.filter((c) => c.ciName.trim() || c.command.trim() || c.app.trim() || c.timeoutSec.trim());
  if (rows.length === 0) {
    return { error: "Map at least one CI check to the local command that reproduces it: those commands are the run's checks", field: "ci" };
  }
  if (rows.length > CI_MAX) return { error: `At most ${CI_MAX} CI mappings`, field: "ci" };
  const ci: LoopWatchSpecWire["ci"] = [];
  for (const [i, c] of rows.entries()) {
    const ciName = c.ciName.trim();
    const command = c.command.trim();
    if (!ciName) return { error: `Mapping ${i + 1} has no check name (exact, or a glob with * and ?)`, field: "ci" };
    if (!command) return { error: `Mapping ${i + 1} has no local command`, field: "ci" };
    const app = c.app.trim().toLowerCase();
    if (app && !APP_RE.test(app)) return { error: `Mapping ${i + 1}: "${c.app.trim()}" isn't a GitHub App slug`, field: "ci" };
    const timeout = optionalInt(c.timeoutSec, `Mapping ${i + 1}'s timeout`);
    if (typeof timeout === "object") return { ...timeout, field: "ci" };
    ci.push({
      ciName,
      command,
      ...(app && app !== DEFAULT_CI_APP ? { app } : {}),
      ...(timeout !== undefined ? { timeoutSec: timeout } : {}),
      ...(c.expectTests ? { expectTests: true } : {}),
    });
  }
  const allow = parseLogins(form.allow, { bots: false, max: 20, what: "allowed authors" });
  if ("error" in allow) return { ...allow, field: "allow" };
  const mention = form.mention.trim();
  if (mention && (mention.length < 2 || mention.length > 64)) return { error: "The mention is 2–64 characters", field: "mention" };
  const trust = parseLogins(form.trust, { bots: true, max: TRUST_MAX, what: "trusted logins" });
  if ("error" in trust) return { ...trust, field: "trust" };
  const perHour = optionalInt(form.maxRunsPerHour, "Runs per hour");
  if (typeof perHour === "object") return { ...perHour, field: "maxRunsPerHour" };
  if (perHour !== undefined && perHour > 60) return { error: "Runs per hour must be at most 60", field: "maxRunsPerHour" };
  const spec: LoopWatchSpecWire = {
    workdir,
    ...(form.target === "branches" ? { branches } : { myPrs: true }),
    ci,
    ...(form.review
      ? { review: { enabled: true, ...(allow.logins.length ? { allow: allow.logins } : {}), ...(mention ? { mention } : {}) } }
      : {}),
    ...(trust.logins.length ? { trust: trust.logins } : {}),
    ...(perHour !== undefined ? { maxRunsPerHour: perHour } : {}),
    ...(form.provider.trim() ? { provider: form.provider.trim() } : {}),
    ...(form.model.trim() ? { model: form.model.trim() } : {}),
  };
  return {
    msg: {
      type: "loop.watch.create",
      spec,
      ...(form.target === "branches" && form.trustHead ? { trustHead: true } : {}),
    },
  };
}
