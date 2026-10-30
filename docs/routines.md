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
| Loop | `--loop`, `--verify`, `--test`, `--attempts`, `--attempt-minutes`, `--run-minutes`, `--budget` | off | Start a verified loop run instead of a session ([below](#routines-that-start-a-loop)). |

`codeoid routine edit <name>` takes the same flags and changes only the ones you pass.
`--no-schedule`, `--no-check`, `--no-worktree`, `--no-catch-up`, `--no-api` and `--no-loop` remove a setting.
`codeoid routine pause`, `resume` and `rm` do what they say.

### Schedules

```bash
--cron "0 9 * * 1-5" --tz Europe/London   # standard 5-field cron, in an IANA timezone
--every 15m                               # 90s, 15m, 1h30m, 2d, …
--at 2026-10-20T07:00:00Z                 # once, ISO 8601 with a zone; unscheduled afterwards
```

Cron without `--tz` uses the daemon machine's zone (on `edit`, the routine keeps the zone it had), and daylight-saving changes are handled the way the zone defines them.
A one-off `--at` must be a future ISO 8601 time with an explicit zone (`Z` or `+08:00`), so it can't be misread.
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
- **Exit 0 with output:** the agent starts, and the output reaches it as `{{check}}` (up to 64 KB; anything past that is cut, and the agent is told so).
- **Non-zero exit or timeout:** the run `failed`, with the first 4,000 characters of the check's output kept for you to read. A timed-out check is killed along with everything it started.

The check sees `CODEOID_ROUTINE`, `CODEOID_ROUTINE_ID`, `CODEOID_ROUTINE_TRIGGER` and `CODEOID_ROUTINE_SINCE`, so it can ask "anything new?":

```bash
--check 'gh issue list --search "created:>=${CODEOID_ROUTINE_SINCE:-1970-01-01}" --json number,title --jq ".[]"'
```

`CODEOID_ROUTINE_SINCE` is when the last run that dealt with its input (one that `succeeded` or was `silent`) *started*, and empty before the first.
So nothing created while that run was working falls in a gap, and whatever a failed, cancelled or still-parked run found comes round again rather than being lost.

The check does not get the daemon's environment, which holds codeoid's own secrets.
It gets the basics (`PATH`, `HOME`, locale, proxy settings), the `XDG_*` directories, and `GH_CONFIG_DIR`, `GH_HOST` and `KUBECONFIG`, so tools find their own logins.
Pass anything else it needs by name with `CODEOID_AGENT_ENV_ALLOW=NAME1,NAME2`, the same switch the agent backends use.
This keeps secrets out of the check's environment, not out of reach: the check runs as the daemon's user, which can read the daemon's own process environment, as the agent backends can.

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
| `needs_attention` | The agent is waiting on you for a tool approval (including one an exhausted tool budget raised). The session stays parked so you can answer it. On a [loop routine](#routines-that-start-a-loop) it means the loop tried and ended blocked, and there it counts toward the failure pause. |
| `failed` | The check failed, the agent errored, or the session went away. Counts toward the failure pause. |
| `timed_out` | It ran past `--max-minutes` and was interrupted. Counts toward the failure pause. |
| `over_budget` | It crossed `--max-cost` and was stopped. Counts toward the failure pause. |
| `skipped` | It didn't run: the last run was still going (`--overlap skip`), a run was already queued behind it (`--overlap queue`), a persistent routine's session was busy, waiting on you, or had your background work going, the daily spend cap was reached, the routine was paused before it started, or the fire was missed during downtime. |
| `cancelled` | You cancelled it (`codeoid routine cancel <runId>`). |
| `interrupted` | The daemon stopped while it was in flight. |

A `needs_attention` run keeps tracking its session after it ends.
When you approve and the agent finishes, the run's cost and summary are updated, so the spend counts toward the daily cap and the history shows what was actually done.
It waits on that one request. Approve it (or answer the agent's question) yourself and the turn is yours from then, along with what the run had running when it parked. Deny it, or let anyone but you answer it, and the run is over: its turn and the background tasks it started stop there. Waiting is all it may do: if it spends or starts anything new while it waits, it is stopped, and the run's cost becomes unknown.

The summary is the agent's final message, not the commentary it wrote between tool calls.
A routine's last outcome is its newest run that ended `succeeded`, `silent`, `needs_attention`, `failed`, `timed_out` or `over_budget`, by when it ended; `skipped`, `cancelled` and `interrupted` runs, and runs still going, are not outcomes.
`codeoid routine ls`, the web UI's routine list and detail, its tab alert and the "Needs you" inbox read the last outcome (`lastOutcome` on the wire), so a loop routine's blocked loop isn't hidden behind the fires skipped while it ran.
Each routine keeps its newest 500 runs, plus every run from today (the daily cap sums them) and the runs later runs read (the last summary, the last run that dealt with its input, and the last outcome).
Retention (`--keep`) removes old run sessions, but never one that is parked on you, still working, or that someone has open.

## Routines that start a loop

A routine can start a [loop](loops.md) instead of a session.
A loop is a verified repair: it works in its own worktree, and its result counts only when checks the daemon runs itself pass.
So the routine decides *when* to try, and the loop decides whether the work is done.

```bash
# Every night at 2, if the test suite has a flaky failure, try to fix it — verified, on its own branch.
codeoid routine add flaky-repair -w ~/src/shop --cron "0 2 * * *" \
  --check 'bun test 2>&1 | grep -E "^\(fail\)" | head -20 || true' \
  --loop \
  --prompt 'Fix the flaky test failures the check found. Make the tests deterministic; do not skip or delete them.' \
  --verify 'unit: bun test' --test \
  --attempts 3 --run-minutes 45 --daily-cost 5

codeoid routine run flaky-repair --wait   # fire it now; waits for the loop run to end
codeoid loop ls                           # the run it started, with every other loop run
```

Two flags look alike and do different jobs:

- `--check <cmd>` is the routine's **gate**, the same as for any routine. It runs first; no output means nothing to do, and no loop starts.
- `--verify "id: cmd"` is the loop's **acceptance check**, as `codeoid loop start --check` takes it (repeatable; `--test` marks them as test runs). The loop is done only when every one passes on its work.

When the routine fires and the gate finds work, it starts a loop run as you, the routine's owner, in your tenant.
The prompt is the loop's objective, as saved: placeholders aren't expanded (a prompt with `{{…}}` is refused), and it may be at most 8,000 characters.
What the gate printed, and any payload sent with an API or manual fire, reach the worker as quoted data, never as instructions.
They are two separate blocks, labelled `routine check` and `routine payload`, and each keeps its own first 4,000 characters, so a long gate output never crowds out the payload.
A loop routine's prompt has no `{{payload}}`: the payload reaches the worker on its own.
The run is an ordinary loop run: `codeoid loop ls`, `show`, `cancel` and the web UI's loops panel show it, with `started by your routine <name>`.

The routine's run follows the loop run, and `routine runs` and `routine show` name it (`loop <id> <status>`).
It stays `running` while the loop is in progress, and ends with the loop's outcome:

| Loop run | Routine run |
| --- | --- |
| `completed` | `succeeded`: the summary names the verified commit and its branch. Nothing is pushed. |
| `blocked` before any attempt (the checks already pass) | `silent`: nothing to repair. |
| `blocked` otherwise | `needs_attention` ("loop blocked"): the worker reported a conflict, or made no progress. Counts toward the failure pause. |
| `budget_exhausted` | `failed` (counts toward the failure pause). |
| `failed` | `failed` (counts toward the failure pause). |
| `cancelled` | `cancelled`. |

The run's cost is the loop's, including the attempt in flight when a loop is cancelled.
A cancel stops the worker first and waits, up to five seconds, for the interrupted turn to report its spend, so that spend is on the loop run and the routine run before either is told it ended.
A turn that reports nothing in that time is charged what it had reported so far.
A loop that waits on you (an approval, a question), or that you paused, keeps the routine run `running`, and no later fire starts until the loop ends.
The web UI's "Needs you" inbox lists the routine as waiting on its loop, unless the loop already has its own row there (its question, or its worker's approval), so one wait isn't listed twice.
A routine that paused itself is listed with its pause either way.
A loop run cancelled directly (`codeoid loop cancel`) ends its routine run as `cancelled` at once.
A routine run is marked `running` before its loop starts, so if the daemon stops between starting the loop and recording it, the run picks the loop up again on restart rather than ending `interrupted` or starting a second loop.
Only a loop of the same owner whose trigger names this routine and this run is picked up.
If loops are no longer available on the daemon (turned off before a restart), a run still following one ends `failed`, saying so.

**One at a time.**
A fire while the loop run its last fire started is still in progress is `skipped`, naming the loop run and its status.
The loop's state is read again first, so a loop that has just ended doesn't hold the fire back.
A fire when you already have three loop runs in progress (the loop limit per owner) is `skipped` too, and doesn't count as a failure.
A loop routine's run doesn't take one of the two routine run slots while its loop works: the loop has its own bounds.

**Budgets.**
The loop's own limits bound the run: `--attempts` (default 3), `--attempt-minutes` (10), `--run-minutes` (30), and `--budget`, its tool calls per attempt (60).
`--daily-cost` still applies, against what the routine's loop runs spent that UTC day.
The settings that shape a session run don't apply to a loop routine: the daemon refuses `toolBudget`, `maxMinutes` and `keepSessions` (`--tool-budget`, `--max-minutes`, `--keep`) on a routine that starts a loop, or that an edit turns into one, so no client can set one that would be silently ignored.
Those that would promise something a loop can't keep are refused: `--guarded` (a loop's worker runs autonomously within its budget), `--persistent`, `--worktree` (a loop always has its own), `--max-cost` (a loop has no per-run spend ceiling), and `--overlap queue`.
Loops run on the Claude backend for now, so `--provider` must be `claude` (or left to a Claude default).

**Editing.**
`routine edit <name> --loop --verify "…"` makes a routine start a loop, and `--no-loop` makes it run a session again.
On a loop routine, `--verify` replaces its checks and `--attempts`, `--budget` and the other limits change only themselves.

**Pausing and cancelling.**
Pausing a loop routine stops its fires; it doesn't stop a loop run it already started, which carries on to its end.
To stop that loop, cancel the routine's run (`codeoid routine cancel <runId>`), or the loop run itself.

**Notifications.**
A loop a routine started follows the routine's notify policy.
Its end is pushed by the routine run, which ends with it, per the policy as for any routine; the push opens the loop's worker session.
A loop waiting on you pushes as any loop does, unless the routine's policy is `never`.

**Who can do what.**
Saving, changing, firing, re-tokening or resuming a loop routine needs what `codeoid loop start` needs (`session:create`, `session:send` and `session:approve`), and a delegated token can't do any of it.
Cancelling its run (`codeoid routine cancel <runId>`) cancels the loop run, and deleting the routine cancels a loop run still in progress (no `routine_end` fires for a routine being deleted).
While a delete is cancelling that loop, every fire of the routine (its schedule, Run now, the API) is refused, so no loop run outlives the routine.
As for every routine, your scopes are checked when you save or change it, not each time it fires (see [A routine outlives the token that created it](#who-can-do-what)).
Nothing is checked at fire time: a loop routine keeps starting autonomous loop runs as you after your credential is revoked or loses `session:approve`, until you pause or delete it.
So pause or delete it when access should end.

## Triggers

**Schedule.** As above.

**Manual.** `codeoid routine run <name> [--payload "…"] [--wait]`.
`--wait` polls until the run reaches an outcome and prints it.
A manual fire works on a paused routine too (the web UI's Run now included): it runs once, and the routine stays paused.

**API.** Turn it on with `--api` (on `add` or `edit`), and codeoid prints a token once:

```bash
curl -X POST http://127.0.0.1:7400/routines/<routine-id>/fire \
  -H "Authorization: Bearer rt_…" \
  -H "Content-Type: application/json" \
  -d '{"text": "checkout p99 latency is 4.1s (threshold 2s)"}'
# → 202 {"runId":"…","status":"queued"}
```

A fire that didn't go ahead says so in general terms (`{"runId":"…","status":"skipped","reason":"this fire was skipped: the routine is busy or at one of its limits"}`), naming no run.
The run's own reason, which can name the loop run it waited behind, is yours to read: `codeoid routine runs` and the web UI show it.
The body becomes the payload: JSON `{"text": "…"}`, any other JSON (passed through as text), or a plain-text body.
A session routine's prompt gets it as `{{payload}}`; a loop routine hands it to the loop's worker as data.
`codeoid routine token <name>` mints a new token and the old one stops working at once; `--no-api` revokes it.
Each routine accepts 30 API fires an hour by default (`routines.apiFiresPerHour`); past that the endpoint answers `429` with `Retry-After`.

This is what monitors, deploy scripts and CI steps should call.
The token can fire this one routine and nothing else.
The web UI shows a new token once, to the identity that asked for it: it stays through a reconnect, and goes when you sign out or sign in as someone else.
A token that comes back after the identity changed isn't shown at all; rotate again to get one.

## Notifications and hooks

With the default `on_change` policy, codeoid pushes a notification to your registered devices for every outcome except `silent`, `skipped` and `cancelled`.
`always` includes those; `never` turns pushes off.
An auto-pause after repeated failures always notifies, unless the policy is `never`.
The push carries no content: it says a routine has something for you and opens the run's session.
A push needs a session to open, so a run that never started an agent (a failed check, a skip, or the auto-pause a failing check causes) reaches you through the hook and `codeoid routine ls` instead.

For automation, the `routine_end` [hook](hooks.md) fires after **every** run, whatever the notify policy, including runs that were skipped or never started.
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

- **Approvals.** A guarded routine parks every non-read tool call on your approval, exactly like an interactive session. An autonomous one runs within a tool-call budget and reverts to guarded when it is spent. Either way nobody answers the agent's questions for it: a question the agent asks parks the run on you like an approval, and a backend's own prompt (a login, a confirmation) is answered as cancelled.
- **Time.** Past `--max-minutes` the agent is interrupted.
- **Money.** On the Claude backend, a fresh run's `--max-cost` is handed to the agent itself, which stops at the ceiling; it is metered per model response, so a run can overshoot by the cost of the response that crossed it. codeoid also checks the run's spend whenever the session reports it, and stops and records `over_budget` past the ceiling. `--daily-cost` is checked before each run starts, against everything the routine's runs spent that UTC day.
  Every backend counts: where a backend reports tokens but no cost (Codex, OpenAI-compatible endpoints, Gemini, Qwen), codeoid prices the tokens at the model's list price (see [Model prices](CONFIGURATION.md#model-prices)); a model on your own machine (llama-server on a loopback host, or wherever `providers.llamacpp.free` says) costs nothing.
  On those backends the spend is known when a turn ends, so `--max-cost` is checked then, not mid-turn: a single long turn can go past it, and `--max-minutes` is what bounds a turn.
  A run isn't over while a background agent it started still works: that spend is the run's. A background shell or watcher doesn't hold it (it makes no model calls), and a run doesn't park on an approval while its background agents still work.
  A run stopped with background agents still working (at its limit, or cancelled) stops them too, and its cost is unknown: what they spent isn't counted against the run reliably yet, so the daily cap treats the day as uncountable rather than under-counting it.
  When a run ends, it stops the background tasks it started (shells and watchers too, since they would wake the agent after the run is recorded), and only those.
  A turn the backend starts on its own as the run stops (answering a task that just finished) is stopped too, and makes the run's cost unknown; a message you send at that moment is yours, and is left alone.
  A run stopped at its limit, over its cap or by a cancel also stops the messages in its session still waiting for their turn, yours included; your background work keeps running.
  Everything a routine's session spends counts against the routine: what happens there after a run ends (the work you approved on a parked run, a turn the backend starts on its own, or you carrying the conversation on) is added to that run, and what any run spends after midnight UTC counts toward the new day's `--daily-cost`.
  After a run ends, nothing runs in its session but you: a turn the agent starts on its own, or one sent for someone else (a delegated token, a conductor dispatch, MCP control), is stopped as it starts, and so is a background task that wasn't started in one of your own turns.
  A turn you send or join with your own login is never stopped, and what it starts is yours (someone else's login isn't yours, even in your account and project: their turns and their answers count as someone else's), including the turn that carries on with its results when they come back. A turn someone else joins as well is no longer only yours. A watcher the backend runs for itself is left alone.
  A turn that won't stop is ended by restarting the session's backend, and the run's cost becomes unknown.
  A run whose session is destroyed while it runs keeps what it was last seen to spend, and its cost is unknown: the turn in flight then was never recorded.
  This is counted while the daemon runs: spend after a daemon restart isn't added to the run before it.
  When a turn's cost can't be known (no price for the model, the Gemini CLI, which reports no token counts, or a server that sent no usage), a run with either cap ends as `failed` after that turn, saying so, and a routine with `--daily-cost` starts no more runs that UTC day. Give the model a price in `pricing.models`, or drop the cap.
  A loop routine's `--daily-cost` counts its loops' priced turns; a loop turn of unknown cost isn't counted yet (#440).
  What the caps can't see: spend through the agent's own tools (a shell running `curl` with an API key, or another agent CLI) and a backend CLI's retries inside one request (Claude's and Codex's). Give an unattended routine `--guarded` if its agent shouldn't run commands unasked.
- **Failure.** After three failed runs in a row (`--failure-pause`) the routine pauses itself and tells you. `resume` clears the streak.
- **Concurrency.** At most two runs execute at once across all routines (`routines.maxConcurrentRuns`), and a routine never runs twice in parallel.
- **Isolation.** `--worktree` runs each fresh session in its own git worktree, so an autonomous run never edits your checkout.
- **Untrusted input.** Check output, API payloads and earlier summaries reach the agent as delimited data with an instruction not to follow them. That lowers the risk of prompt injection, but no prompt can rule it out, so a routine that reads text from strangers (issues, emails, alerts) should be `--guarded` or run in a `--worktree` with a tool budget you are comfortable losing.

### Who can do what

A routine belongs to the identity that created it, inside the tenant (account and project) it was created in.
Nobody else sees the routine itself, by name or by id: a teammate in the same tenant can't read, change, fire, re-token or delete it, and can use the same name for a routine of their own.
That matters because a routine's runs act as its owner.

**Its runs are ordinary sessions.**
Like any session you start, a run's session is visible to your tenant under codeoid's usual session scopes: someone holding `session:watch` can read its transcript, which includes the prompt with the check output and payload, and someone holding `session:send` can prompt it.
So don't put in a check's output, or a payload, what your tenant's watchers shouldn't read.
Autonomy belongs to the run, not the session: the moment a run ends or stops to wait on you, its session steps down from autonomous to guarded, so what runs after your answer, and whoever prompts the session later, gets no pre-approved tool calls.

Two consequences of runs being ordinary sessions are worth knowing when your tenant includes tokens that can send but not approve (an MCP `operate` token, say):

- While an autonomous run is going, a message from anyone holding `session:send` joins it and is auto-approved like the run's own work, as it would be in any autonomous session.
- In a persistent autonomous routine, anything said in its session between runs becomes context for the next autonomous run. Don't make a routine both `--persistent` and autonomous where send-only tokens can reach it; use `--fresh`, or `--guarded`.

Routines have no scope of their own; they use the ones you already hold.
A routine creates sessions and prompts them, so every routine command needs `session:create` and `session:send`, reading included: a routine's definition and run history are not for read-only watchers.
Only `routine preview`, which saves nothing, needs just `session:list`.
A routine that is autonomous, that has a check, or that starts a loop also needs `session:approve` to save, run by hand, re-token or resume (pausing never does: it is a safety stop): an autonomous run approves its own tool calls, and a check is a shell command that runs on the daemon's host without asking anyone, so only someone who could approve that command interactively may set it going.
A delegated token can list routines but not create, change, fire or delete them: a routine is standing authority, and delegation is meant to be narrow.
That covers a teammate's share token (it arrives delegated, whatever scopes it carries) and an agent acting for someone, so a teammate you share a session with cannot schedule work on your machine.

**A routine outlives the token that created it.**
Scopes are checked when a routine is created or changed, not on every run, so revoking the owner's token or narrowing their scopes does not stop a routine they already saved, and an API token never expires on its own.
To stop one, pause or delete it, revoke its API token with `--no-api`, or turn routines off for the daemon with `routines.enabled: false`.

**Ownership follows the credential's identity.**
On the ZeroID path a routine's owner is the identity in the token that created it, which for a `codeoid login` key is that key's agent identity.
A different key, or the web UI's sign-in, is a different identity and won't see those routines.
If you retire the identity a routine belongs to, stop the routine first; afterwards only `routines.enabled: false` reaches it.

Runs act as the routine's owner; in the transcript their messages are attributed to `routine:<name>`, delegated by that owner, so you can always tell your typing from the routine's.
The audit log records each create, change (naming the fields that changed, with old and new values for approvals, workdir, provider and the API trigger), delete, token rotation, fire, run queued, skipped, started, cancelled and finished, and auto-pause; a run's own events are recorded under `routine:<id>`.
A check command is recorded by digest and length, never its text, so a secret in it doesn't outlive the edit that removed it; better still, keep secrets out of check commands and pass them by name with `CODEOID_AGENT_ENV_ALLOW`.

The API endpoint authenticates with the routine's own token, not a ZeroID JWT.
Tokens are stored as SHA-256 hashes and compared in constant time.
An unknown routine, a routine with its API off, and a wrong token all get the same `401`, so the endpoint never reveals which routines exist.
Requests that carry a browser `Origin` header are refused, so a web page can't fire a routine on a loopback daemon.
Request bodies are capped at 64 KB, and the payload itself at 16,000 characters (the same limit as `routine run --payload`); a longer one gets `400`. A paused routine answers `409`.

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
- **No event triggers yet.** For GitHub CI failures and review comments, use a loop watch ([loops.md](loops.md#watches)).
  For Slack and other sources, point their webhooks at a small relay that calls the API trigger, or poll from a check.
- **The qwen backend runs read-only shell commands without asking**, even in a guarded routine (a property of qwen-code itself, described under "Qwen backend" in the repository's CLAUDE.md), so an unattended qwen routine fed outside text could be steered to read any file the daemon user can. codeoid refuses an API trigger on a routine that runs on qwen, whether named or as the daemon's default backend, and fails an API run if the default has since become qwen; a qwen routine whose check reads untrusted text (issues, emails) carries the same risk, so prefer another backend there.
- **Routines are tied to the identity that made them** (see [Who can do what](#who-can-do-what)): another key or the web UI's sign-in won't see them.
- **A kept run session keeps the run's spend ceiling.** If you continue a fresh run's session yourself on Claude, its turns stop at that run's `--max-cost`; start a new session for open-ended work.
- **The hard spend cap is Claude-only, and fresh-session-only.** Other backends, and persistent sessions, report spend when a turn ends, and a run is usually one turn, so there `--max-cost` marks the run `over_budget` (and counts toward the failure pause) rather than stopping it part-way. Backends on a subscription may report no cost at all. On those, `--max-minutes` and `--tool-budget` are the limits that actually bound a run.
- **Account-wide connectors.** On the Claude backend, a run inherits your Claude account's connectors. The run's instructions tell the agent to leave unneeded ones out of its summary, but it is a model following an instruction, not a filter.
