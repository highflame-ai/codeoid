/**
 * Loop runs for the terminal (`codeoid loop …`). Pure: returns lines, so it
 * is tested without a daemon.
 */

import type {
  LoopAttemptWire,
  LoopEventWire,
  LoopRunWire,
  LoopWatchTriggerWire,
  LoopWatchWire,
} from "../protocol/types.js";
import { InvalidArgumentError, Option } from "commander";
import { sanitizeTerminalOutput } from "../tui/ansi/codes.js";

/**
 * Text that came from GitHub, a check, or a worker, made safe to print: no
 * escape sequence but colour (not even a hyperlink: its target is the
 * sender's), and no carriage return or other control character that could
 * rewrite what the line shows.
 */
const S = (s: string | null | undefined): string =>
  sanitizeTerminalOutput(
    (s ?? "").replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, ""),
  )
    .replace(/\x1b(?!\[)|[\x00-\x08\x0b-\x1a\x1c-\x1f\x7f]/g, "");

/** Only a github.com link is printed: the URL came from an API response. */
const githubUrl = (url: string | undefined): string | null => (url && /^https:\/\/github\.com\/[^\s]*$/.test(url) ? S(url) : null);

const MARK: Record<LoopRunWire["status"], string> = {
  running: "▶",
  verifying: "⋯",
  waiting: "⏸",
  paused: "⏸",
  completed: "✓",
  budget_exhausted: "✗",
  blocked: "!",
  failed: "✗",
  cancelled: "■",
};

/**
 * How a run ended, in docs/loops.md's words. Only `completed` was verified;
 * the others must not read like it.
 */
export const LOOP_OUTCOME: Partial<Record<LoopRunWire["status"], string>> = {
  completed: "Verified: every check passed on the delivered commit.",
  budget_exhausted: "Out of budget: the attempts or time ran out without every check passing. Nothing was delivered; the worktree holds the last attempt.",
  blocked: "Blocked: the run can't make progress without you.",
  failed: "Failed: something outside the work went wrong.",
  cancelled: "Cancelled by you.",
};

/** The `waitingOn` of a run whose worker session waits on an approval (src/daemon/loops/service.ts). */
export const LOOP_APPROVAL_WAIT = "an approval in the worker session";

/**
 * A run's text is partly the worker's (its reports, notes quoting paths it
 * chose) and must not drive the terminal: every control character goes,
 * escape introducers and carriage returns included, so no sequence or
 * overwrite survives. Lines stay one line.
 */
const CONTROL = /[\x00-\x08\x0a-\x1f\x7f-\x9f]/g;
const plain = (line: string): string => line.replace(CONTROL, "");

function minutes(ms: number): string {
  return ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${(ms / 60_000).toFixed(1)}m`;
}

export function formatLoopRow(r: LoopRunWire): string {
  const objective = r.objective.split("\n")[0]!.slice(0, 60);
  return plain(`${MARK[r.status]} ${r.id.slice(0, 13)}  ${r.status.padEnd(16)} ${r.attempts}/${r.limits.attempts}  ${objective}`);
}

export function formatLoop(r: LoopRunWire, attempts: LoopAttemptWire[], events?: LoopEventWire[]): string[] {
  const lines = [
    `${MARK[r.status]} ${r.id}  ${r.status}`,
    `  objective  ${r.objective.split("\n")[0]}`,
    `  why        ${S(r.reason)}`,
  ];
  if (r.waitingOn) lines.push(`  waiting on ${r.waitingOn}`);
  if (r.trigger) lines.push(`  started by ${startedBy(r)}`);
  lines.push(
    `  repo       ${r.workdir}`,
    `  branch     ${r.branch ?? "(not created yet)"}${r.baseRevision ? ` from ${r.baseRevision.slice(0, 12)}` : ""}`,
    `  checks     ${r.checks.map((c) => `${c.id}: ${c.command}`).join(" · ")}`,
    `  budget     ${r.attempts}/${r.limits.attempts} attempts · ${minutes(r.activeMs)} of ${r.limits.runMinutes}m · $${r.costUsd.toFixed(2)}`,
  );
  if (r.deliveredCommit) lines.push(`  delivered  ${r.deliveredCommit.slice(0, 12)} on ${r.branch}  (git log ${r.branch})`);
  if (r.workerSessionId) lines.push(`  worker     ${r.workerSessionId.slice(0, 8)}  (codeoid attach ${r.workerSessionId.slice(0, 8)} — what you type there steers the run)`);
  for (const a of attempts) {
    const took = a.startedAt && a.endedAt ? ` ${minutes(Date.parse(a.endedAt) - Date.parse(a.startedAt))}` : "";
    lines.push(`  #${a.ordinal} ${a.result ?? a.status}${took}${a.note ? ` — ${S(a.note)}` : ""}`);
    if (a.report) lines.push(`      worker: ${a.report.outcome} — ${S(a.report.summary.split("\n")[0]!.slice(0, 120))}`);
    if (a.evidenceIds.length > 0) lines.push(`      evidence: ${a.evidenceIds.join(" ")}  (codeoid evidence <id>)`);
  }
  if (events && events.length > 0) {
    lines.push("", "  history:");
    for (const e of events) lines.push(`    ${e.at.slice(11, 19)} ${e.type}${e.detail ? ` — ${S(e.detail.split("\n")[0]!.slice(0, 100))}` : ""}`);
  }
  return lines;
}

/** "started by" for a triggered run: the event, where it is, the watch, and the event's first line. */
export function startedBy(r: LoopRunWire): string {
  const t = r.trigger;
  if (!t) return "you";
  if (t.kind === "routine") {
    return `your routine ${S(t.routineName ?? t.routineId ?? "?")}${t.routineRunId ? ` (run ${t.routineRunId.slice(0, 8)}; codeoid routine runs ${S(t.routineName ?? t.routineId ?? "")})` : ""}`;
  }
  const what = t.kind === "ci_failure" ? "a failing CI check" : "a review comment";
  const on = r.baseRef?.branch ? ` on ${S(r.baseRef.branch)}` : "";
  const url = githubUrl(t.url);
  const first = S(t.summary.split("\n").find((l) => l.trim() && !/^(Comment|Review) by @/.test(l))?.trim().slice(0, 100));
  return `${what}${on}${t.watchId ? ` (watch ${t.watchId.slice(0, 11)})` : ""}${url ? ` — ${url}` : ""}${first ? `\n             “${first}”` : ""}`;
}

export function formatWatchRow(w: LoopWatchWire): string {
  const what = w.myPrs ? "my open PRs" : w.branches.join(", ");
  const review = w.review.enabled ? ` · review ${w.review.mention}` : "";
  return `${w.enabled ? "▶" : "⏸"} ${w.id.slice(0, 11)}  ${w.repo}  ${what}  ci: ${w.ci.map((c) => c.ciName).join(", ")}${review}`;
}

export function formatWatch(w: LoopWatchWire, triggers: LoopWatchTriggerWire[] = []): string[] {
  const lines = [
    `${w.enabled ? "▶" : "⏸"} ${w.id}  ${w.enabled ? "watching" : "paused"}`,
    `  repo       ${w.repo}  (${w.workdir})`,
    `  branches   ${w.myPrs ? "the heads of your open pull requests" : w.branches.join(", ")}`,
    ...w.ci.map((c) => `  ci         ${c.ciName}${c.app && c.app !== "github-actions" ? ` @${c.app}` : ""} → ${c.command}${c.expectTests ? " (tests)" : ""}`),
    `  review     ${w.review.enabled ? `comments containing ${w.review.mention} from ${w.review.allow.join(", ")}` : "off"}`,
    `  trusts     ${[w.ghLogin ? `@${w.ghLogin} (you)` : null, ...w.trust.map((l) => `@${l}`)].filter(Boolean).join(", ") || "nobody"} — only heads whose every commit is theirs start runs`,
    `  bound      ${w.maxRunsPerHour} run(s) per hour, one at a time per branch`,
    `  polled     ${w.lastPolledAt ?? "not yet"}`,
  ];
  if (w.lastError) lines.push(`  last poll  ${S(w.lastError)}`);
  if (triggers.length > 0) {
    lines.push("", "  events:");
    for (const t of triggers) {
      const what =
        t.outcome === "run"
          ? (t.runId ?? "starting")
          : t.outcome === "retry"
            ? `to retry — ${S(t.note)}`
            : t.outcome === "vouched"
              ? S(t.note)
              : `ignored — ${S(t.note)}`;
      const kind = t.kind === "ci_failure" ? "ci    " : t.kind === "trust_anchor" ? "vouch " : t.kind === "head" ? "head  " : "review";
      lines.push(`    ${t.createdAt.slice(0, 19).replace("T", " ")} ${kind} ${S(t.branch)}  ${what}`);
    }
  }
  // `why` and notes can run over lines; the first stays, the rest is in `show --events`.
  return lines.map((l) => plain(l.split("\n")[0]!));
}

/**
 * Parse `--ci` values: `<check name>: <command>`, split at the first `: `.
 * The name may be a glob (`test (*)`), and may end in `@<app>` to name the
 * GitHub App that reports the check (`lint@circleci-checks: …`); without one
 * it is GitHub Actions.
 */
export function parseCiFlag(raw: string): { ciName: string; app?: string; command: string } | null {
  const i = raw.indexOf(": ");
  if (i <= 0) return null;
  let ciName = raw.slice(0, i).trim();
  const command = raw.slice(i + 2).trim();
  const app = /^(.*?)\s*@([a-z0-9][a-z0-9-]{0,99})$/.exec(ciName);
  if (app) ciName = app[1]!.trim();
  return ciName && command ? { ciName, ...(app ? { app: app[2]! } : {}), command } : null;
}

/** What `--trust-head` collects when it is given alone: commander would otherwise overwrite the pins collected before it with `true`. */
export const TRUST_HEAD_ALONE = "\u0000alone";

/**
 * Collect one `--trust-head`: alone, or a `<branch>=<sha>`. A value without
 * `=` is refused here, before commander checks the command's arguments: it
 * is most likely the watch id, taken as the option's value.
 */
export function collectTrustHead(v: string, prev: unknown): string[] {
  if (v !== TRUST_HEAD_ALONE && !v.includes("=")) {
    throw new InvalidArgumentError(
      `${JSON.stringify(v)} isn't <branch>=<sha>. Given alone, --trust-head takes the word after it as its value: put the watch id before --trust-head, or another option after it.`,
    );
  }
  return [...(Array.isArray(prev) ? (prev as string[]) : []), v];
}

/** `--trust-head [branch=sha]`, repeatable, alone or pinned (see {@link parseTrustHeadFlag}). */
export function trustHeadOption(description: string): Option {
  return new Option("--trust-head [branch=sha]", description).preset(TRUST_HEAD_ALONE).argParser(collectTrustHead);
}

/**
 * Parse `--trust-head`: given alone (`true`, or only {@link TRUST_HEAD_ALONE}),
 * you vouch for each watched branch's head as it is when the daemon reads it;
 * given `<branch>=<sha>` (repeatable), only for those branches, and only while
 * each head is still the commit you name, by its full id (a prefix could name
 * a commit you never looked at) — otherwise nothing is vouched for. Both in
 * one command is refused. A string is what is wrong with it.
 */
export function parseTrustHeadFlag(v: true | string[] | undefined): true | Record<string, string> | undefined | string {
  if (v === undefined || v === true) return v;
  const alone = v.filter((x) => x === TRUST_HEAD_ALONE).length;
  if (alone > 0 && alone === v.length) return true;
  if (alone > 0) return "Give --trust-head alone (every watched branch's head as it is) or as <branch>=<sha>, not both.";
  const out: Record<string, string> = {};
  for (const raw of v) {
    const i = raw.lastIndexOf("=");
    const branch = i > 0 ? raw.slice(0, i).trim() : "";
    const sha = i > 0 ? raw.slice(i + 1).trim().toLowerCase() : "";
    if (!branch || !sha) return `--trust-head ${JSON.stringify(raw)}: expected <branch>=<sha>, with the commit's full id.`;
    if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(sha)) {
      return `--trust-head ${JSON.stringify(raw)}: give the commit's full id (40 hex characters, or 64 for a SHA-256 repository), not a prefix — \`git rev-parse <commit>\` prints it.`;
    }
    if (out[branch] !== undefined && out[branch] !== sha) return `--trust-head names two commits for ${branch}.`;
    out[branch] = sha;
  }
  return out;
}

/**
 * Parse `--check` values: `cmd`, or `id: cmd` to name the check. A colon and a
 * space, not `=`: `NODE_ENV=test bun test` is a command, not a named check.
 */
export function parseCheckFlag(raw: string): { id?: string; command: string } {
  const m = /^([A-Za-z0-9._-]{1,40}):\s+(.+)$/s.exec(raw);
  return m ? { id: m[1], command: m[2]! } : { command: raw };
}
