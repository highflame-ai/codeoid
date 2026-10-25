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
What bounds it is the [trust rule](#who-a-watch-trusts): a head starts a run only when it was pushed by you, or by someone you named, or merged into its branch by one of you on top of code one of you vouched for (an auto-merged or queued pull request also needs its own head pushed or signed by one of you), or every commit on it is signed by one of you and verified.

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
It also takes a GitHub App's bot login, such as `dependabot[bot]`, which trusts anyone who can make that bot push.
`web-flow`, `github-merge-queue[bot]`, and `github-actions[bot]` are refused: GitHub commits, merges, and pushes as them for everyone with write access (any workflow pushes as `github-actions[bot]`, so anyone who can make one run can make it push), so trusting any of them would trust everyone.

Before a run starts, the watch asks GitHub who made the push that put the head on its branch, from the repository's activity (for a pull request from a fork, the fork's).
GitHub records the account that authenticated, so a push by a trusted login vouches for the head, whatever its commits say.
A merge puts the pull request's merge commit at the head of the branch it merged into, and the watch finds that pull request: the one GitHub merged as that commit.
The activity already says which branch the merge landed on, so the pull request's own base isn't compared to it.
That is what makes stacked pull requests work: GitHub merges each one in a stack onto its parent's branch and then fast-forwards the default branch, so the pull request named at the default branch's head has its parent's branch as its base.
A pull request a trusted login merged with the button vouches for the head, like a trusted push.
An auto-merged one doesn't by that alone: GitHub records whoever turned auto-merge on as the merger, and anyone with write access can push commits after that, which GitHub then merges.
A merge through the merge queue doesn't either: GitHub records its bot as the actor of every merge queue merge, and the pull request names who queued it.
So an auto-merged or queued pull request vouches for the head only when a trusted login turned auto-merge on or queued it, and its final head commit is itself trusted: pushed onto its branch by a trusted login, or every commit on it signed and verified by one (a merge one level further down doesn't count).
Otherwise the head is untrusted, with why, for example "auto-merged; its last commit was pushed by @someone".
When GitHub doesn't say whether auto-merge was ever on for a pull request, it is judged as auto-merged.
GitHub can take a moment to link a merge commit to its pull request, or to list the push of the pull request's head: like a push it doesn't list yet, the head is judged again for ten minutes.

A merge vouches for what it merged, not for what was already on the branch beneath it.
A collaborator you don't trust can push straight to the branch, and your pull request merging on top of that push doesn't make their code yours.
So a merge vouches for the head only when what it landed on (the branch's head just before it, which GitHub's activity records) is itself vouched for, one level down: the branch had nothing before (its first push), or this watch already judged that head trusted, or the newest activity that put it on the branch is a push by a trusted login or a pull request a trusted login merged with the button (not auto-merged or queued).
That one level isn't followed any further.
When none of those holds, the merge vouches for nothing and the head falls to the signature rule below, which the default branch itself never passes.
A merge queue merge can land a batch of pull requests at once, and GitHub names only the last as the one merged at the head; when that one is vouched for, the rest of the batch is trusted with it, but what's beneath the batch (the branch's head before the queue merged it) must itself be vouched for, as beneath any merge.
A trusted push vouches for every commit beneath the head too, including commits someone else wrote that you pulled and pushed on: pushing a branch is how you say its code is yours to run.
The names on a commit vouch for nothing by themselves: GitHub ties a commit to an account by its email, which anyone can write into a commit.
So when the push wasn't by a trusted login, or GitHub has no record of it, the head is trusted only if it has commits past the default branch (at most 250) and every one is signed, verified by GitHub, and committed by a trusted login.
A head with no commits past the default branch — the default branch itself, or a head it already contains — has no signature to vouch for it, so only a trusted push or merge does.
A commit committed by `web-flow` never counts: GitHub signs those for its web buttons (merge, rebase, update branch) whatever author the commit names, and the author is the commit's own say-so; what vouches for a button press is the activity record of who pressed it.
GitHub's activity can lag a push by a few minutes: a head it doesn't list yet is judged again on each poll for ten minutes before it is recorded untrusted, and a comment on it waits to retry meanwhile.
The activity only reaches back to 2023, and the watch reads its newest 100 entries for the branch, so a head pushed before that falls to the signature rule, and what a merge landed on that far back is vouched for only when the watch already judged it trusted.
Anything else and the head is ignored for good: `show` lists it as ignored, "not pushed by someone you trust", with why, and a later poll doesn't ask again.
Changing a watch's trust list (`loop.watch.update`) judges its ignored heads again, and forgets the heads it judged trusted.

What follows from trusting by who pushed:

- `gh pr merge` without `--match-head-commit <sha>` merges whatever the pull request's head is when GitHub gets the request, and a collaborator can push to it just before; GitHub records you as having merged it either way, and doesn't say whether the head moved.
  Pass `--match-head-commit` with the head you reviewed, so a head that moved makes the merge fail instead.
- Anything that holds your `gh` login or a personal access token of yours pushes as you, and so is trusted as you: a script, a CI job, a tool or another agent you gave the token to.
  Keep such tokens out of automation you wouldn't let run code on your machine.
- A push by a bot or app (a CI autofix, a formatter bot, Dependabot) is not a push by you: its head is untrusted unless every commit on it is signed by a trusted login, which a bot's commits aren't.
  Push on top of it yourself, or name the bot's login with `--trust` (`--trust "dependabot[bot]"`) if you trust what it pushes: that trusts anyone who can make that bot push.

### What starts a run

- **A failing check.** A check run on a watched branch's head that completed as `failure` or `timed_out` and matches a mapping.
  The watch waits until every mapped check run on that head has finished, then starts one run for the head.
  Its checks are every mapped command whose check ran on the head: the failing ones are what it repairs, the passing ones what it must keep passing.
  A check already failing when you add the watch counts: the branch is red now.
- **A review comment** (with `--review`). A comment on one of your open pull requests — on a line, on the conversation, or a review's own text — that contains `@codeoid` (`--mention` to change it), is by an allowed author, and was made after the watch was created or last resumed.
  Comments made while a watch was paused don't start runs when you resume it.
  Up to two minutes of clock difference between GitHub and your machine is allowed on that comparison.
  Allowed authors default to the account `gh` is signed in as; `--allow <login>` names others.
  An allowed author's comment is an instruction to the agent, on code that a trusted login pushed: allow only people you would let ask for a change.
  Only what the author wrote themselves counts, and only that reaches the run: quoted lines (`>`), code, and HTML comments are left out, so quoting someone else's `@codeoid …` asks for nothing.
  A line comment you drafted into a review counts from when the review was submitted, not from when you drafted it; nothing in a review still pending counts.
  A comment GitHub records as edited is ignored for good, however soon after it was made (`show` lists it as "edited after it was made"): anyone with write access to the repository can edit someone else's comment, so its text may no longer be the author's.
  That holds for one already waiting to retry, too.

### What a triggered run works on

- Its worktree is a clean checkout of the branch head the event happened on, never your current checkout and never your uncommitted changes.
- A head that isn't in your repository is fetched from `https://github.com/<repo>.git` by URL, not through `origin`, and not in your repository at all: into one the daemon makes for the fetch under its own directory, which borrows your repository's objects and tells GitHub it has the remote-tracking branches of your remotes that are `github.com/<repo>` (and that no `url.*.insteadOf` rewrites), so only what's missing is downloaded.
  Your repository's configuration, which an agent can write, has no say over where the fetch goes or what it presents (no url rewrite, proxy, TLS setting, or credential helper in it applies), and no git runs in your repository during the fetch.
  The fetch's own configuration is the only one: no global or system config, https only, no redirects, no ssh command, and `gh auth git-credential` as the only credential helper, so private repositories work with the login the watch already uses.
  A proxy set in the daemon's own environment (`HTTPS_PROXY`) still applies, as it does to the daemon's other connections.
  This is the only git the daemon runs with the network on; every object it receives is checked, and what it fetched (at most 2 GiB) is then added to your repository's objects offline, by the same hardened git as every other loop step, and checked again.
  git has no setting that caps a fetch's size while it downloads, so the 2 GiB bound is checked once the download has finished; during it, what bounds the download is its five-minute timeout, and what it wrote is removed either way.
  A failed fetch says why in the run's reason.
  A run whose workspace couldn't be prepared gives its event back, and the watch tries it again on later polls, three times in all.
- A shallow or partial clone can't take a fetched head yet: a run that would need one fails at once, saying so, and its event isn't tried again (`git fetch --unshallow`, or clone the repository whole).
- The delivered commit sits on the run's own `codeoid/loop-…` branch, on top of that head; push it to the pull request yourself.
- A repository's [setup recipe](CONFIGURATION.md) copies its files (such as `.env`) into the worktree, because the head passed the trust rule.
  Its trusted setup command does not run on a commit that isn't on your checkout's history, such as most pull request heads; the run's history says so, and the checks then run without what that command would have installed.
- `codeoid loop show` names what started a run, with a link to the check or the comment.
- A review comment's run whose worker changed nothing ends `blocked` and says so.

### How a watch stays bounded

- Each event starts at most one run, across all of your watches: its key (the commit, the check run and its suite, or the comment and its kind) is recorded with the run it started, and stays recorded when the watch is deleted.
- One repair at a time per branch, across all of your watches on the repository; an event on a branch whose run is still going is skipped and picked up by the first poll after that run ends.
- A watch starts at most 6 runs an hour (`--per-hour`), and its runs count against your limit of three runs in progress; an event skipped for either is tried again on a later poll.
- A skipped comment is kept waiting to retry (`show` lists it as `retry`), and the watch reads comments far enough back to find it until it gets its run.
  One still waiting when its pull request closes, or after a week, is dropped.
- A failure on a commit a loop delivered (its subject starts with `codeoid loop:`) is ignored for good, so a loop can't keep repairing its own output.
- Check output and comment text are task data: a run's objective is fixed text, and the event's text reaches the worker only inside a quoted data block, truncated to 4,000 characters.
  The terminal prints it with escape sequences and control characters removed, and links only to github.com.
- A branch that can't be read (deleted, renamed) is a problem for that branch alone; the watch's other branches are still polled.
- You can have 10 watches.
  Comments are read from ten minutes before the last complete poll, not from the beginning each time.
  When GitHub rate-limits a watch (HTTP 429, or a 403 that says a rate limit is spent), every watch acting as that `gh` login backs off together: two poll intervals, then four, doubling up to six hours, until a poll isn't rate-limited (the doubling starts over even if that poll had other errors).
  Any other refusal (a 403 for missing access) is an error the watch records, with GitHub's message.
- `gh` runs with only `PATH`, `HOME`, and its config location in its environment, never the daemon's credentials, and with a timeout; a failed poll is recorded on the watch (`show` displays it, naming the GitHub endpoint) and the next poll tries again.

Watches poll every `loops.watchPollSeconds` seconds (default 300, at least 60), and a few seconds after the daemon starts or a watch is made or resumed.
They cost nothing between polls.
Making, changing, resuming, or polling a watch needs the same scopes as starting a loop and can't be done with a delegated token; pausing and deleting it are safety stops that can.

### Limits of a watch's authority

- **One person per daemon.**
  A watch reads and fetches from GitHub as the daemon's `gh` login, so watches belong to one person.
  Once someone has a watch, nobody else can make one on that daemon until theirs are gone.
  Every poll asks `gh` who it is signed in as; if that is no longer the login the watch was made with, the watch pauses itself and says why.
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
