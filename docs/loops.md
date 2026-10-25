# Loops

A loop pursues one objective until the daemon's own checks pass, then hands you the result as a commit on its own branch.
The worker agent never decides that it is done: it can only ask for verification, and the daemon runs the checks itself and records what they did.

Design and roadmap: [loop-engineering-design.md](loop-engineering-design.md).
This page covers what ships today: the **repair** recipe, started by hand or by a [watch](#watches) when CI fails or a reviewer asks.

## Start a repair

```bash
codeoid loop start "Fix the failing checkout test" \
  --workdir ~/src/shop \
  --check "bun test src/checkout" --test \
  --wait
```

What happens:

1. The run gets its own git worktree of `--workdir` on a new `codeoid/loop-…` branch.
   Your checkout is never modified.
   Uncommitted changes in your checkout are carried into the worktree, so the run repairs what you have.
   If the setup command changes tracked files (an install rewriting a lockfile, generated code), they are put back, and the run's history says so: only the worker's changes are the run's work.
   Files it creates that git would otherwise add are its own too, and stay out of the candidate — a directory it creates whole, including what the worker later adds there.
   A repository's [setup recipe](CONFIGURATION.md) prepares the worktree: it copies the files it lists and runs a trusted setup command.
   Its shared directories are not linked into a loop's worktree — a shared directory is a writable link into your checkout, and the worker could change what the checks run without it showing in the diff — so install dependencies with the setup command instead.
2. The daemon runs the checks on the unmodified code.
   If they already pass, the run stops `blocked`: there is nothing to repair, and it is never reported as a repair, and its worktree and branch are removed.
3. A worker session runs the first attempt autonomously, within a tool budget and a time limit.
   It is told the objective, the checks, the failing output, and the rules: never edit the checks to make them pass, report `cannot_satisfy` when the objective conflicts with them, and ask (`needs_input`) instead of guessing.
4. When the attempt ends, the daemon stops the worker's processes and snapshots the worktree into a git tree: the run's base with the worktree's files laid over it.
   Files that look like secrets (`.env`, keys, credential files) keep their content at the base, or stay out if they had none.
5. The daemon writes that tree out into a fresh directory of its own and runs every check there.
   The setup recipe prepares the directory from the run's base, committed content only, before the candidate's files are laid over it, so its trusted command never runs on what the worker wrote (it does get your checkout's path, as `CODEOID_PRIMARY_CHECKOUT`).
   The files it copies are the ones it copied when the run began, not whatever your checkout holds by then.
   The checks see the candidate and nothing else: not the worker's ignored or untracked files, not a withheld secret.
   A symlink in the candidate may not lead out of the repository, alone or through other links; a candidate with one is never checked.
   A committed link that leads out (`vendor -> /opt/shared`) may stay as it is, unless it climbs out through `..`: in the check directory that would land in the daemon's own directory, so such a repository can't be checked yet.
   Setup runs once, and what it prepared is sealed: every check runs in a fresh copy of it (copy-on-write where the filesystem supports it) at the same path, so absolute paths setup wrote (a virtualenv's scripts, an editable install) lead into that check's own copy.
   No check — nor code it runs — can change what another sees: not a tracked file, not an installed tool, not a file it planted, not the check directory's own git repository; a check that writes into the sealed original makes the candidate unchecked (before the first attempt, the run fails).
   A check's processes carry a marker, and when it ends any still running — a build daemon, a process that left its process group — are killed before the next check's copy is made (Linux; not a sandbox: a process that clears its environment or rewrites its process title — gunicorn, celery, postgres — and leaves the directory, or makes itself unreadable, isn't found, nor is a container a check starts).
   What the setup command leaves running is stopped the same way, before the worker starts and before the checks' copies are made.
   That includes daemons a check starts (a build server, a database for the next check): each check starts from what setup prepared, and so does what it needs running.
   The sealed original is a private copy, so files setup hard-linked from a shared cache (uv, pnpm, bun) can't change under it when the cache is used elsewhere.
   The copy is made as `cp -a` makes one: symlinks, modes and timestamps kept, so timestamp-based caches stay warm.
   The result is stored as evidence: command, exit status, output, and the git tree it judged.
6. If every check passes, that exact tree is committed on the run's base as the branch's one commit, and the run is `completed`.
   Otherwise the next attempt starts with the failing output, until the attempt or time budget is spent.

Because the checks run in a fresh checkout, they get only what the setup recipe provides.
A repository with no setup command (or one you haven't trusted with `codeoid worktree trust`) has no installed dependencies there: install them in the check itself, e.g. `--check "bun install && bun test"`.
The setup command runs on the base, so a dependency the worker adds is installed only by a check that installs it; the worker is told so.

`--check` takes a command, or `id: command` to name it, and repeats for several checks.
`--test` marks the checks as test runs, so a run that selects no tests does not pass.

| Option | Default | Meaning |
| --- | --- | --- |
| `--attempts` | 3 | Worker attempts, including the first. A question answered by you doesn't count. |
| `--attempt-minutes` | 10 | Wall time per attempt; past it the attempt is stopped and its workspace is checked as it stands. |
| `--run-minutes` | 30 | Active time across the whole run. |
| `--budget` | 60 | Autonomous tool calls per attempt. |
| `--provider`, `--model` | daemon default | The worker's backend. Loops run on Claude today. |

Starting a loop needs the `session:create`, `session:send`, and `session:approve` scopes, and can't be done with a delegated token.
You can have three runs in progress at once.

## Follow, steer, stop

```bash
codeoid loop ls                       # your runs
codeoid loop show <id> --events       # contract, attempts, evidence, history
codeoid evidence <evidence-id>        # one check: what ran, on which tree, its output
codeoid loop steer <id> "Keep the v1 API"   # guidance for the next attempt, or an answer
codeoid loop pause <id>               # stop at the next attempt boundary
codeoid loop resume <id>
codeoid loop cancel <id>              # stop now
```

A run id can be shortened to any unambiguous prefix.

The worker is an ordinary session you can attach to and watch.
It has one driver, its run: anything you type into it becomes steering for the run instead of a second conversation.
While the run is in progress its mode, model, backend, account and effort can't be changed, and it can't be rewound, rotated or destroyed; that holds while the run is paused too, and ends when the run ends (cancel it to end it now).
Approving a tool call in it works as usual, but not with a delegated token; while an approval waits, the run is `waiting` and its attempt clock is stopped.
Once the run ends the worker becomes an ordinary session again; destroying it removes the run's worktree without committing what's left in it (the branch stays).
After a daemon restart the run continues with a new worker session, which is told the objective and the rules again; the old one is kept but can't remove the worktree while the run is in progress.

## How a run ends

| Status | Meaning |
| --- | --- |
| `completed` | Every check passed on the delivered commit, the branch's one commit on its base (commits the worker made itself are not on it). Merge it like any branch. |
| `budget_exhausted` | The attempts or time ran out without every check passing. Nothing was delivered; the worktree holds the last attempt. |
| `blocked` | The run can't make progress without you: the checks already passed, two attempts in a row changed nothing, the checks passed with the tracked files unchanged, or the worker reported that the objective conflicts with the checks (with the conflict). |
| `failed` | Something outside the work went wrong: the worktree couldn't be prepared, a check couldn't run on the unmodified code, or the result couldn't be committed. |
| `cancelled` | You stopped it. |

## Watches

A watch starts repair runs for you from repository events: a CI check that failed on a branch you watch, or a pull request comment that asks codeoid for a change.
It is opt-in, yours alone, and reads GitHub through the `gh` CLI you are already signed in to.

**A watch runs the code at your branch heads, unattended.**
A run's checks execute that code, and so does the worker.
What bounds it is the [trust rule](#who-a-watch-trusts): a head starts a run only when every commit on it past the default branch was written by you, or by someone you named.

```bash
codeoid loop watch add --workdir ~/src/shop --my-prs \
  --ci "test (*): bun test" --test \
  --ci "typecheck: bun run typecheck" \
  --review
codeoid loop watch ls
codeoid loop watch show <id>          # its rules, last poll, and the events it acted on
codeoid loop watch poll <id>          # poll now instead of waiting
codeoid loop watch pause <id>         # stop polling; runs it started carry on
codeoid loop watch resume <id>
codeoid loop watch rm <id>
```

The repository is read from the workdir's `origin` remote when the watch is made, and must be on github.com.
`--branch <b>` (repeatable) watches named branches; `--my-prs` watches the heads of your open pull requests instead, the newest 30 on each poll.
`--ci "<check name>: <command>"` maps a check's name on GitHub, exact or a glob with `*` and `?`, to the local command that reproduces it; a failing check with no mapping starts nothing.
A mapping matches only check runs that GitHub Actions reported: any GitHub App with checks access can post a check run under any name, so the name alone isn't enough.
For a check another app reports, name the app's slug after the check name: `--ci "lint@circleci-checks: bun run lint"`.
Every watch needs at least one mapping, because the mapped commands are the run's checks.
Commit statuses (the older API some CI systems still use) are not read; only check runs are.

### Who a watch trusts

When you make a watch it reads the login `gh` is signed in as, and keeps it: that is you.
`--trust <login>` (repeatable, at most 20) names other people whose commits a head may carry.

Before a run starts, the watch reads every commit between the default branch and the head (at most 250).
Each must be authored by a trusted login and committed by one.
A commit committed by `web-flow` counts when its author is trusted: that is GitHub's merge and update-branch buttons.
A commit GitHub can't tie to an account, more than 250 commits, or anyone else, and the head is ignored for good: `show` lists it as ignored, "commits by someone you don't trust", and a later poll doesn't ask again.
Changing a watch's trust list (`loop.watch.update`) judges its ignored heads again.

### What starts a run

- **A failing check.** A check run on a watched branch's head that completed as `failure` or `timed_out` and matches a mapping.
  The watch waits until every mapped check run on that head has finished, then starts one run for the head.
  Its checks are every mapped command whose check ran on the head: the failing ones are what it repairs, the passing ones what it must keep passing.
  A check already failing when you add the watch counts: the branch is red now.
- **A review comment** (with `--review`). A comment on one of your open pull requests — on a line, on the conversation, or a review's own text — that contains `@codeoid` (`--mention` to change it), is by an allowed author, and was made after the watch was created or last resumed.
  Comments made while a watch was paused don't start runs when you resume it.
  Up to two minutes of clock difference between GitHub and your machine is allowed on that comparison.
  Allowed authors default to the account `gh` is signed in as; `--allow <login>` names others.
  Only what the author wrote themselves counts, and only that reaches the run: quoted lines (`>`), code, and HTML comments are left out, so quoting someone else's `@codeoid …` asks for nothing.

### What a triggered run works on

- Its worktree is a clean checkout of the branch head the event happened on, never your current checkout and never your uncommitted changes.
- A head that isn't in your repository is fetched from `https://github.com/<repo>.git` by URL, not through `origin`, and not in your repository at all: into one the daemon makes for the fetch under its own directory, which borrows your repository's objects so only what's missing is downloaded.
  Your repository's configuration, which an agent can write, has no say over where the fetch goes or what it presents (no url rewrite, proxy, TLS setting, or credential helper of yours applies).
  The fetch's own configuration is the only one: no global or system config, https only, no ssh or proxy command, and `gh auth git-credential` as the only credential helper, so private repositories work with the login the watch already uses.
  This is the only git the daemon runs with the network on; what it fetched is then added to your repository's objects offline, by the same hardened git as every other loop step.
  A failed fetch says why in the run's reason.
  A run whose workspace couldn't be prepared gives its event back, and the watch tries it again on later polls, three times in all.
- The delivered commit sits on the run's own `codeoid/loop-…` branch, on top of that head; push it to the pull request yourself.
- A repository's [setup recipe](CONFIGURATION.md) copies its files (such as `.env`) into the worktree, because the head passed the trust rule.
  Its trusted setup command does not run on a commit that isn't on your checkout's history, such as most pull request heads; the run's history says so, and the checks then run without what that command would have installed.
- `codeoid loop show` names what started a run, with a link to the check or the comment.
- A review comment's run whose worker changed nothing ends `blocked` and says so.

### How a watch stays bounded

- Each event starts at most one run, across all of your watches: its key (the commit and check run, or the comment and its kind) is recorded with the run it started, and stays recorded when the watch is deleted.
- One repair at a time per branch, across all of your watches on the repository; an event on a branch whose run is still going is skipped and picked up by the first poll after that run ends.
- A watch starts at most 6 runs an hour (`--per-hour`), and its runs count against your limit of three runs in progress; an event skipped for either is tried again on a later poll.
- A failure on a commit a loop delivered (its subject starts with `codeoid loop:`) is ignored for good, so a loop can't keep repairing its own output.
- Check output and comment text are task data: a run's objective is fixed text, and the event's text reaches the worker only inside a quoted data block, truncated to 4,000 characters.
  The terminal prints it with escape sequences and control characters removed, and links only to github.com.
- A branch that can't be read (deleted, renamed) is a problem for that branch alone; the watch's other branches are still polled.
- You can have 10 watches.
  Comments are read from ten minutes before the last complete poll, not from the beginning each time.
  When GitHub rate-limits a watch (HTTP 403 or 429), it backs off: two poll intervals, then four, doubling up to six hours, until a poll gets through.
- `gh` runs with only `PATH`, `HOME`, and its config location in its environment, never the daemon's credentials, and with a timeout; a failed poll is recorded on the watch (`show` displays it, naming the GitHub endpoint) and the next poll tries again.

Watches poll every `loops.watchPollSeconds` seconds (default 300, at least 60), and a few seconds after the daemon starts or a watch is made or resumed.
They cost nothing between polls.
Making, changing, resuming, or polling a watch needs the same scopes as starting a loop and can't be done with a delegated token; pausing and deleting it are safety stops that can.

### Limits of a watch's authority

- **One person per daemon.**
  A watch reads and fetches from GitHub as the daemon's `gh` login, so watches belong to one person.
  Once someone has a watch, nobody else can make one on that daemon until theirs are gone.
- **A watch keeps acting after your credential is revoked.**
  Your scopes are checked when you make, change, resume, or poll a watch, not each time it starts a run, the same as for [routines](routines.md).
  The daemon has no way to ask ZeroID whether a credential it saw earlier is still valid, so revoking your token does not stop a watch.
  Pause or delete it (any credential that can see it may) when access should end.

## What is and isn't enforced yet

- The worker cannot mark a run done: completion requires every check to pass on the snapshot the daemon took.
- The checks run in a fresh checkout of the candidate as ordinary processes, with the same stripped environment as an agent's commands.
  A worker that edits a test file to make it pass is not yet detected; protected inputs and hidden checks are the next milestone.
- The daemon's git commands for a run are pinned to its worktree and repository, with hooks, filter drivers, fsmonitor and replace refs off.
  The checked files are written by the daemon from the repository's objects, each checked against its id, so neither git's checkout nor an altered object store decides what the checks see, and delivery checks the objects again.
- The worker runs as you, unsandboxed, and so do the checks: a process the worker or a check leaves running can still reach your machine, the check directory included, while the checks run.
  So "verified" means verified against a worker that didn't tamper with your machine outside its worktree (your git config, tools on your `PATH`, caches); a sandboxed worker is on the roadmap.
- Repositories with files stored through a configured git filter (Git LFS, git-crypt, a clean filter such as nbstripout) are refused when a run starts; system, global and `info/attributes` settings count, as they do for git, and so do attributes your uncommitted changes add.
  Checkout conversions (`eol=crlf`, `working-tree-encoding`, `ident` in `.gitattributes`) aren't applied in the check directory: the checks see every file as git stores it, which can differ from the worker's worktree.
- A candidate holds at most 500,000 files and 512 MiB per file, and the prepared check directory (with what setup installed) at most 1,000,000 entries and 8 GiB on disk; submodules are empty directories in it.
  On a filesystem that folds case or Unicode forms (macOS, Windows), a tree with two names that fold to one file can't be checked.
- On a filesystem whose timestamps are coarse (whole seconds), the daemon can't tell an untouched file from one changed within the same second, so it hashes every file of the same size before each check: correct, slower.
- Object ids are checked with plain SHA-1 in a SHA-1 repository (git's own reads add collision detection); a SHA-256 repository gets SHA-256.
- Each attempt's tool budget and wall time are enforced, and the run's active time (attempts, minus approval waits, plus checks) caps the next attempt; dollar spend is reported per attempt, not capped.
- A daemon restart resumes runs: an attempt caught mid-flight comes back from the dispatcher as lost and counts as an attempt (one that hadn't started yet doesn't), and the next attempt starts with a new worker; a run caught verifying verifies again, and a verification stopped part-way is never judged.
  Time the daemon was down isn't charged to the run.
- What is delivered is the tree that was verified, built by the daemon with git's hooks and filter drivers off and none of its credentials in reach.
- Every git command the daemon runs in a repository an agent can write gets an agent's environment, never the daemon's (forks of ordinary sessions too).
  git that reaches a remote (forks, pack updates) also keeps how you connect: `GIT_SSH_COMMAND`, askpass, TLS trust and Kerberos variables pass.
  A credential helper that reads a token from the environment (`GH_TOKEN`, `GCM_*`) needs it named in `CODEOID_AGENT_ENV_ALLOW`.
