# Routines: agents that run on their own

A routine is a saved agent task that codeoid runs for you on a schedule, when something calls its API, or when you ask.
"Every weekday at 9, triage new issues."
"Every 15 minutes, if CI on main is red, find out why."
"When the deploy script finishes, check the error rate and tell me if it moved."

Each run is an ordinary codeoid session, so you can open it from the terminal, the web UI, or your phone and see exactly what the agent read, ran and wrote.
If it stopped on a tool call that needs your approval, approve it there and the work carries on.

Routines are built around one idea: **most scheduled runs should cost nothing.**
A routine can carry a *check*, a plain shell command that runs before any agent starts.
If the check prints nothing, there is nothing to do: the run ends as `silent`, no model is called, and nothing is spent.
Only when the check finds something does the agent start, and it gets the check's output to work from.

## Quick start

```bash
# A routine that looks at CI every 15 minutes and only wakes an agent when main is red.
codeoid routine add ci-watch \
  --workdir ~/src/myrepo \
  --every 15m \
  --check 'gh run list --branch main --limit 1 --json conclusion,databaseId,displayTitle --jq ".[] | select(.conclusion==\"failure\")"' \
  --prompt 'CI on main is failing. Find the cause from the run logs and summarise it in three lines. Do not push anything.

{{check}}' \
  --guarded --max-cost 1

codeoid routine ls                  # every routine, its next fire, its last outcome
codeoid routine run ci-watch --wait # run it now and wait for the outcome
codeoid routine show ci-watch       # the full definition and recent runs
codeoid routine runs ci-watch       # run history
```

`--guarded` means the agent can read freely, but every edit or command waits for you.
Leave it off and the routine runs autonomously within a tool-call budget (50 by default, `--tool-budget`).

## What a routine is made of

| Part | Flag | Default | What it does |
| --- | --- | --- | --- |
| Prompt | `--prompt`, `--prompt-file` | required | What the agent should do. May use the [placeholders](#the-prompt) below. |
| Workdir | `-w, --workdir` | current dir | Where the agent works. |
| Schedule | `--cron` + `--tz`, `--every`, `--at` | none (on demand) | When it fires on its own. |
| Check | `--check`, `--check-timeout` | none | A shell gate. Empty output means nothing to do. |
| Backend | `--provider`, `--model` | daemon default | Any codeoid backend: Claude, Codex, Gemini, Qwen, … |
| Approvals | `--guarded` / `--autonomous` | autonomous | Who approves tool calls. |
| Tool budget | `--tool-budget` | 50 | Autonomous tool calls per run before it reverts to guarded. |
| Time limit | `--max-minutes` | 15 | Wall-clock limit per run; the agent is interrupted past it. |
| Spend limits | `--max-cost`, `--daily-cost` | none | USD per run and per UTC day. |
| Session | `--fresh` / `--persistent` | fresh | A new session per run, or one conversation that carries across runs. |
| Worktree | `--worktree` | off | Each run gets its own git worktree, so runs never touch your checkout. |
| Overlap | `--overlap skip\|queue` | skip | What happens when a fire lands while the last run is still going. |
| Catch-up | `--catch-up` | off | After downtime, run once for the fires that were missed. |
| Jitter | `--jitter <s>` | 0 | Spread the start by up to this many seconds (stable per routine). |
| Notify | `--notify on_change\|always\|never` | on_change | When to push a notification to your devices. |
| Retention | `--keep <n>` | 5 | Run sessions kept around for you to open; older ones are cleaned up. |
| API trigger | `--api` | off | Lets something outside codeoid fire this routine with its own token. |
| Failure pause | `--failure-pause <n>` | 3 | Pause the routine after N failed runs in a row (0 = never). |

`codeoid routine edit <name>` takes the same flags and changes only the ones you pass.
`--no-schedule`, `--no-check`, `--no-worktree`, `--no-catch-up` and `--no-api` remove a setting.
`codeoid routine pause`, `resume` and `rm` do what they say.

### Schedules

```bash
--cron "0 9 * * 1-5" --tz Europe/London   # standard 5-field cron, in an IANA timezone
--every 15m                               # 90s, 15m, 1h30m, 2d, …
--at 2026-10-20T07:00:00Z                 # once; the routine is unscheduled afterwards
```

Cron without `--tz` uses the daemon machine's zone, and daylight-saving changes are handled the way the zone defines them.
`--every` fires stay on their original phase: a 15-minute routine created at 10:07 fires at :07, :22, :37 and :52, however long each run takes.
The shortest allowed interval is 60 seconds (`routines.minIntervalSeconds`), and a cron pattern that never matches, or fires more often than that, is rejected when you save it.

Check a schedule before you commit to it:

```bash
codeoid routine preview --cron "0 9 * * 1-5" --tz America/New_York
```

Fires that land while the daemon is down are not replayed one by one.
By default they are recorded as `skipped` (missed); with `--catch-up` the routine runs once when the daemon comes back.

### The check

The check is the cheapest part of a routine and usually the most useful.
It runs with `/bin/sh -c` in the workdir before any agent starts:

- **Exit 0 and no output:** the run ends as `silent`. No agent, no cost.
- **Exit 0 with output:** the agent starts, and the output reaches it as `{{check}}`.
- **Non-zero exit or timeout:** the run `failed`, with the check's output kept for you to read. A timed-out check is killed along with everything it started.

The check sees `CODEOID_ROUTINE`, `CODEOID_ROUTINE_ID`, `CODEOID_ROUTINE_TRIGGER` and `CODEOID_ROUTINE_LAST_RUN_AT`, so it can ask "anything new since the last run?":

```bash
--check 'gh issue list --search "created:>${CODEOID_ROUTINE_LAST_RUN_AT:-1970-01-01}" --json number,title --jq ".[]"'
```

Good checks are cheap and print nothing when all is well: `git status --porcelain`, `gh pr list --search "review-requested:@me"`, `curl -fsS …/health || echo down`.

### The prompt

The prompt can use these placeholders:

| Placeholder | Becomes |
| --- | --- |
| `{{check}}` | The check's output. |
| `{{payload}}` | The text sent with an API or manual fire. |
| `{{last_summary}}` | What the previous successful run reported, so a routine can say what changed. |
| `{{trigger}}` | `schedule`, `catchup`, `api` or `manual`. |
| `{{now}}` | The run's start time, ISO 8601. |
| `{{routine}}` | The routine's name. |

Check output, payloads and last summaries are inserted as delimited `<routine-data>` blocks that the agent is told to treat as data, never as instructions.
If your prompt doesn't place `{{check}}` or `{{payload}}` itself, they're appended anyway, so the agent always sees what triggered it.

Every run's prompt ends with a short contract: the agent is told it is running unattended, and that if there is nothing worth reporting it should reply `[SILENT]`.
A `[SILENT]` reply ends the run as `silent`, and with the default notify policy you hear nothing.
So a routine that asks "is anything wrong?" stays quiet on the days when nothing is.

## Outcomes

| Status | Meaning |
| --- | --- |
| `succeeded` | The agent finished and reported something. Its summary is the run's headline. |
| `silent` | Nothing to do: the check printed nothing, or the agent replied `[SILENT]`. |
| `needs_attention` | The agent is waiting on you: an approval, or a question it asked. The session stays parked so you can answer it. |
| `failed` | The check failed, the agent errored, or the session went away. Counts toward the failure pause. |
| `timed_out` | It ran past `--max-minutes` and was interrupted. Counts toward the failure pause. |
| `over_budget` | It crossed `--max-cost` and was stopped. Counts toward the failure pause. |
| `skipped` | It didn't run: the last run was still going (`--overlap skip`), the daily spend cap was reached, or the fire was missed during downtime. |
| `cancelled` | You cancelled it (`codeoid routine cancel <runId>`). |
| `interrupted` | The daemon stopped while it was in flight. |

A `needs_attention` run keeps tracking its session after it ends.
When you approve and the agent finishes, the run's cost and summary are updated, so the spend counts toward the daily cap and the history shows what was actually done.

## Triggers

**Schedule.** As above.

**Manual.** `codeoid routine run <name> [--payload "…"] [--wait]`.
`--wait` polls until the run reaches an outcome and prints it.

**API.** Turn it on with `--api` (on `add` or `edit`), and codeoid prints a token once:

```bash
curl -X POST http://127.0.0.1:7400/routines/<routine-id>/fire \
  -H "Authorization: Bearer rt_…" \
  -H "Content-Type: application/json" \
  -d '{"text": "checkout p99 latency is 4.1s (threshold 2s)"}'
# → 202 {"runId":"…","status":"queued"}
```

The body becomes `{{payload}}`: JSON `{"text": "…"}`, any other JSON (passed through as text), or a plain-text body.
`codeoid routine token <name>` mints a new token and the old one stops working at once; `--no-api` revokes it.
Each routine accepts 30 API fires an hour by default (`routines.apiFiresPerHour`); past that the endpoint answers `429` with `Retry-After`.

This is what monitors, deploy scripts and CI steps should call.
The token can fire this one routine and nothing else.

## Notifications and hooks

With the default `on_change` policy, codeoid pushes a notification to your registered devices for every outcome except `silent`, `skipped` and `cancelled`.
`always` includes those; `never` turns pushes off.
An auto-pause after repeated failures always notifies, unless the policy is `never`.
The push carries no content: it says a routine has something for you and opens the run's session.

For automation, the `routine_end` [hook](hooks.md) fires after **every** run, whatever the notify policy.
Its payload carries the routine, the full run (status, reason, summary, cost, tokens, session id), whether this run paused the routine, and `notify`: whether the policy would push for it.
That is the place to post to Slack, open a ticket, or page someone:

```json
{
  "hooks": {
    "entries": [
      { "event": "routine_end", "type": "command", "command": "jq -c 'select(.notify)' | ~/bin/post-to-slack" }
    ]
  }
}
```

## Safety model

A routine runs an agent with nobody watching, on a machine that holds your code and credentials, so every limit is enforced by the daemon rather than requested of the model.

- **Approvals.** A guarded routine parks every non-read tool call on your approval, exactly like an interactive session. An autonomous one runs within a tool-call budget and reverts to guarded when it is spent. Either way nobody answers the agent's questions for it: a question it asks in an unattended run is answered as cancelled, and it carries on without one.
- **Time.** Past `--max-minutes` the agent is interrupted.
- **Money.** On the Claude backend, `--max-cost` is handed to the agent itself, which stops at the ceiling; it is metered per model response, so a run can overshoot by the cost of the response that crossed it. codeoid also checks the run's spend whenever the session reports it, and stops and records `over_budget` past the ceiling. `--daily-cost` is checked before each run starts, against everything the routine's runs spent that UTC day.
- **Failure.** After three failed runs in a row (`--failure-pause`) the routine pauses itself and tells you. `resume` clears the streak.
- **Concurrency.** At most two runs execute at once across all routines (`routines.maxConcurrentRuns`), and a routine never runs twice in parallel.
- **Isolation.** `--worktree` runs each fresh session in its own git worktree, so an autonomous run never edits your checkout.
- **Untrusted input.** Check output, API payloads and earlier summaries reach the agent as delimited data with an instruction not to follow them. That lowers the risk of prompt injection, but no prompt can rule it out, so a routine that reads text from strangers (issues, emails, alerts) should be `--guarded` or run in a `--worktree` with a tool budget you are comfortable losing.

### Who can do what

Routines are owner-level.
Reading them (`ls`, `show`, `runs`, `preview`) needs `session:list`.
Creating, changing, firing and deleting them needs the `routine:manage` scope **and** `session:create` and `session:send`, because a routine creates sessions and prompts them.
A routine that is autonomous, or that has a check, also needs `session:approve`: an autonomous run approves its own tool calls, and a check is a shell command that runs on the daemon's host without asking anyone, so only someone who could approve that command interactively may save it.
`routine:manage` is not in the operator share-token preset, so a teammate you share a session with cannot schedule work on your machine.

Routines belong to the tenant (account and project) they were created in.
Runs execute as the routine's owner; in the transcript and the audit log their messages are attributed to `routine:<name>`, delegated by that owner, so you can always tell your typing from the routine's.
Every create, change, fire, run start, run outcome and auto-pause is in the audit log.

The API endpoint authenticates with the routine's own token, not a ZeroID JWT.
Tokens are stored as SHA-256 hashes and compared in constant time.
An unknown routine, a routine with its API off, and a wrong token all get the same `401`, so the endpoint never reveals which routines exist.
Requests that carry a browser `Origin` header are refused, so a web page can't fire a routine on a loopback daemon.
Bodies are capped at 64 KB.

## Configuration

In `~/.codeoid/config.json` (the Settings screen also has a Routines group):

| Key | Default | Meaning |
| --- | --- | --- |
| `routines.enabled` | `true` | Run the scheduler and accept routine commands. `CODEOID_ROUTINES_ENABLED`. |
| `routines.maxConcurrentRuns` | `2` | Runs executing at once, across all routines. `CODEOID_ROUTINES_MAX_CONCURRENT`. |
| `routines.minIntervalSeconds` | `60` | Shortest allowed interval or cron gap. |
| `routines.apiFiresPerHour` | `30` | API fires accepted per routine per hour. |
| `routines.missedGraceSeconds` | `120` | A scheduled fire later than this counts as missed. |
| `routines.tickMs` | `1000` | Scheduler cadence. |

## Recipes

**Morning PR digest.**

```bash
codeoid routine add pr-digest -w ~/src/myrepo --cron "30 8 * * 1-5" \
  --check 'gh pr list --search "review-requested:@me" --json number,title,author,updatedAt --jq ".[]"' \
  --prompt 'These PRs are waiting on my review. For each, read the diff and tell me in one line what it does and whether it looks risky. {{check}}' \
  --guarded --max-cost 2
```

**What changed since yesterday.** `{{last_summary}}` gives a persistent memory without a persistent session:

```bash
codeoid routine add deps -w ~/src/myrepo --cron "0 7 * * 1" \
  --prompt 'Run `bun outdated`. Compare with last week: {{last_summary}}. Report only what is new; if nothing is, reply [SILENT].' \
  --autonomous --tool-budget 5
```

**Alert triage from a monitor.**

```bash
codeoid routine add alert-triage -w ~/src/service --api --guarded --max-minutes 10 \
  --prompt 'An alert fired: {{payload}}. Look at the recent commits and logs and say what most likely caused it.'
```

**An autonomous fixer that can't touch your checkout.**

```bash
codeoid routine add lint-fix -w ~/src/myrepo --cron "0 2 * * *" --worktree \
  --check 'bun run lint 2>&1 | tail -50 | grep -E "error|✖" || true' \
  --prompt 'Fix these lint errors and commit on the worktree branch. Do not push. {{check}}' \
  --autonomous --tool-budget 40 --max-cost 3
```

## How it compares

As of October 2026, from each product's public documentation; — means we found nothing documented either way.

| | Claude Code routines | Cursor Automations | Codex automations | **codeoid routines** |
| --- | --- | --- | --- | --- |
| Where it runs | Anthropic's cloud | Cursor's cloud | the Codex app | your daemon: your machine, your repos, your credentials |
| Backends | Claude | Cursor's models | Codex | any codeoid backend (Claude, Codex, Gemini, Qwen, local models, …) |
| Shortest interval | 1 hour | — | — | 60 seconds |
| Skip runs with nothing to do | — | — | archives empty results after the run | a shell check gates the agent: no output, no model call, $0 |
| "Nothing to report" | — | — | — | `[SILENT]` reply ends quietly |
| Tool approvals in an unattended run | none | — | — | guarded or autonomous with a tool budget; a parked run waits for you on any device |
| Spend limits | — | — | — | per run (a hard stop on Claude) and per day |
| Time limit, failure auto-pause, overlap policy, catch-up | — | — | — | yes |
| API trigger | yes | webhooks | — | per-routine revocable token, rate-limited |
| GitHub / Slack triggers | GitHub | GitHub, Slack, Linear, PagerDuty, … | — | not yet (planned) |
| Inspect a run | — | — | inbox | the run *is* a session: open it, continue it, fork it |
| Audit | — | — | — | every fire and outcome, attributed to `routine:<name>` under its owner |

## Known limits

- **The scheduler lives in the daemon.** No daemon, no fires; missed fires are skipped or caught up once, as configured.
- **No event triggers yet.** GitHub, Slack and similar sources are planned; until then, point their webhooks at a small relay that calls the API trigger, or poll from a check.
- **CLI only for now.** The web UI shows a routine's run sessions (marked as routine-managed) but has no routine screen yet.
- **The hard spend cap is Claude-only, and fresh-session-only.** Other backends, and persistent sessions, report spend when a turn ends, and a run is usually one turn, so there `--max-cost` marks the run `over_budget` (and counts toward the failure pause) rather than stopping it part-way. Backends on a subscription may report no cost at all. On those, `--max-minutes` and `--tool-budget` are the limits that actually bound a run.
- **Account-wide connectors can add noise.** On the Claude backend, a run inherits your Claude account's connectors; if one needs signing in, the agent may mention it in its summary.
