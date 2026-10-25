# Loops

A loop pursues one objective until the daemon's own checks pass, then hands you the result as a commit on its own branch.
The worker agent never decides that it is done: it can only ask for verification, and the daemon runs the checks itself and records what they did.

Design and roadmap: [loop-engineering-design.md](loop-engineering-design.md).
This page covers what ships today: the **repair** recipe, started by hand or by a [watch](#watches) when CI fails or a reviewer asks.
A [routine](routines.md#routines-that-start-a-loop) can start one too, on a schedule or an API call, after its gate says there is work; its runs show `started by your routine <name>` and are listed with every other run.

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
What bounds it is the [trust rule](#who-a-watch-trusts): a head starts a run only when it was pushed by you, or by someone you named, or merged by one of you with every change to the branch since a trusted head also a merge by one of you (an auto-merged or queued pull request also needs its own head pushed or signed by one of you), or every commit on it is signed by one of you and verified.
A trusted head is one of those, or one you [vouched for](#vouching-for-a-branchs-head) with `--trust-head`.

```bash
codeoid loop watch add --workdir ~/src/shop --my-prs \
  --ci "test (*): bun test" --test \
  --ci "typecheck: bun run typecheck" \
  --review
codeoid loop watch ls
codeoid loop watch show <id>          # its rules, last poll, and the events it acted on
codeoid loop watch poll <id>          # poll now instead of waiting
codeoid loop watch pause <id>         # stop polling; runs it started carry on
codeoid loop watch resume <id>        # --trust-head: vouch for its branches' heads as they are now
codeoid loop watch update <id> --trust <login> --trust-head
codeoid loop watch update <id> --trust-head main=<sha>   # only while main's head is still that commit
codeoid loop watch update <id> --trust-none              # trust no one but you
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
A merge vouches for what it merged, not for what was already on the branch beneath it.
A collaborator you don't trust can push straight to the branch, and your pull request merging on top of that push doesn't make their code yours.
So a head that a merge put on its branch is trusted only when every change to the branch since a trusted head was a trusted merge.
The watch follows the branch's activity back from the merge, one change at a time, each to the change that left the branch where the last one began.
It stops, trusted, at the first of these:

- a push by a trusted login (a trusted push vouches for everything beneath it);
- the head this watch last judged trusted on that branch, or the head you vouched for there with `--trust-head`;
- nothing at all (the branch's first change).

Every change it passes on the way must be a trusted merge.
Anything else on the way, and the merge vouches for nothing: a push by someone you don't trust, a merge that isn't trusted, any other kind of change, a head the watch already recorded untrusted, more than 30 changes, a merge that put more than 20 commits on the branch or more than 60 commits in all, or a head GitHub's activity has no record of.
The watch reads the newest 300 entries of the branch's activity (three pages), and GitHub's activity also has holes: a merge whose record is missing, though older entries are there.
A head with no record is crossed only when it is the merge commit of exactly one pull request that was merged into that branch itself, with the button (never auto-merged or through a merge queue, which GitHub records as someone else's act), by a login GitHub records as having merged it and that you trust; the walk then goes on from what that merge commit was made on.
A pull request merged into another branch put its commit somewhere else, so it never bridges a hole in this one.
Nor is a hole crossed when the branch's own activity that the crossing skips has a deletion or a creation of the branch: what is beneath it may be another branch that had the same name.
At most three such holes are crossed in one chain.
Otherwise the head is untrusted, with why, for example "GitHub's activity has no record of how 4078425 came to be on trunk, and pull request #14720, merged as it, was auto-merged"; the reason says "the newest 300 entries read" only when the missing record would be past what was read.
Only branches of the watched repository itself are followed this way: a merge on a fork's branch names no pull request of the watched repository.
Then the head falls to the signature rule below, which the default branch itself never passes.

A merge is trusted when every commit it put on the branch is the merge commit of exactly one merged pull request in the watched repository, and each of those pull requests is trusted.
A commit that two merged pull requests both name as their merge commit vouches for nothing, since which of them put it there can't be told.
A stack merged at once puts one commit per pull request on the branch, and a merge queue batch one per queued pull request: each pull request is judged, not only the one at the head.
A rebase merge puts one commit per commit of the pull request on the branch, and GitHub names the pull request only at the last; the commits beneath it are taken as its own, as many as it had, only when they are what a rebase makes.
The merge commit must have one parent, and it and each commit beneath it taken this way must have one parent and the message and author date of the pull request's commit at that place, in order.
A squash or a merge commit puts no such commits on the branch, so anything beneath it with no pull request of its own was already there, and is judged as such.
A pull request's own base branch isn't compared to the branch: in a stack most pull requests are based on another one's branch.

A pull request merged with the button is trusted when the login that pressed it is trusted, and GitHub records that same login as having merged it.
An auto-merged one isn't by that alone: GitHub records whoever turned auto-merge on as the merger, and anyone with write access can push commits after that, which GitHub then merges.
A merge through the merge queue isn't either: GitHub records its bot as the actor of every merge queue merge, and the pull request names who queued it.
So an auto-merged or queued pull request is trusted only when a trusted login turned auto-merge on or queued it, and its final head commit is itself trusted: pushed onto its branch by a trusted login, or every commit on it signed and verified by one (a merge one level further down doesn't count).
An auto-merged one (not queued) is also trusted when GitHub's activity records the push of its final head as earlier than the last time auto-merge was turned on, a trusted login turned it on then, and that push is the newest change to its branch (or lies just beneath the branch's deletion at that head, as a merged pull request's branch usually ends).
That change must be a push (or a force-push, or the push that created the branch), and the pull request's timeline must record no force-push of its head branch since auto-merge was last turned on; a timeline that doesn't say counts as one that does.
Whoever turned it on had that head in front of them: a later push by someone with write access would be recorded later, and GitHub turns auto-merge off when someone without write access pushes.
The push must be the newest because a writer could push the head, push another, and force-push the first back after auto-merge was on: until GitHub's activity lists that last push, the older push of the same commit is the newest that names it.
GitHub doesn't record which head auto-merge was turned on at, only when, and whether it checks the head then isn't something the watch can rely on (`gh pr merge --auto` sends the head only with `--match-head-commit`; what the web button sends isn't documented), so that is a limit of this rule.
Otherwise the head is untrusted, with why, for example "auto-merged; its last commit was pushed by @someone".
When GitHub doesn't say whether auto-merge was ever on for a pull request, it is judged as auto-merged.
GitHub can take a moment to link a merge commit to its pull request, or to list the push of the pull request's head: like a push it doesn't list yet, the head is judged again for ten minutes.
The same holds for a hole in the activity whose commit GitHub names no pull request for yet: it is judged again for ten minutes before it is refused.

What this means for a branch other people also merge to, such as a team's default branch:

- List everyone who merges to it with `--trust`.
  Otherwise each merge by someone not listed leaves every later head on that branch untrusted, until a trusted login pushes to it, the chain reaches the head the watch last trusted, or you vouch for its head with `--trust-head`.
- Every poll judges a watched branch's head when it has moved, and remembers it when it is trusted, so the remembered head keeps up with the branch and a later merge's chain is a step or two long.
  A head already remembered, or already judged untrusted, costs no calls beyond reading the branch's head; a moved head costs its activity page and, for a merge, two calls per pull request it landed.
  A moved head that isn't trusted is recorded untrusted, event or not (`show` lists it as a `head` ignored, with why), and also costs the read of its signatures.
  Only the newest three such `head` records are kept per branch; an older one is dropped as a newer one is recorded, and a chain stops at the newest it meets anyway.
  Every head after it then stops its chain there: once something untrusted has landed on the branch, each later head costs the same few calls, not more with every change, until a trusted push or `--trust-head` gives the branch a trusted head again.
  When you make or resume a watch, or change its trust list, its next poll does the same for every head it watches, the heads of your pull requests too; being made trusts nothing by itself.
- If the branch's chain can't reach a trusted head (it is long, or begins with a push by someone you don't trust), vouch for its head as it is now with `--trust-head`, below.
- Turn on branch protection for the branch, so changes to it come through reviewed pull requests rather than direct pushes.
- `--my-prs` is unaffected: your pull requests' heads are judged by who pushed them, and a trusted push vouches for everything beneath it.

A trusted push vouches for every commit beneath the head too, including commits someone else wrote that you pulled and pushed on: pushing a branch is how you say its code is yours to run.
The names on a commit vouch for nothing by themselves: GitHub ties a commit to an account by its email, which anyone can write into a commit.
So when the push wasn't by a trusted login, or GitHub has no record of it, the head is trusted only if it has commits past the default branch (at most 250) and every one is signed, verified by GitHub, and committed by a trusted login.
A head with no commits past the default branch — the default branch itself, or a head it already contains — has no signature to vouch for it, so only a trusted push or merge does.
A commit committed by `web-flow` never counts: GitHub signs those for its web buttons (merge, rebase, update branch) whatever author the commit names, and the author is the commit's own say-so; what vouches for a button press is the activity record of who pressed it.
GitHub's activity can lag a push by a few minutes: a head it doesn't list yet is judged again on each poll for ten minutes before it is recorded untrusted, and a comment on it waits to retry meanwhile.
The activity only reaches back to 2023, and the watch reads the newest 100 entries for the branch to find who pushed a head (300 to follow a merge's chain), so a head pushed before that falls to the signature rule.
Anything else and the head is ignored for good: `show` lists it as ignored, "not pushed by someone you trust", with why, and a later poll doesn't ask again.
Changing a watch's trust list (`codeoid loop watch update --trust`, `loop.watch.update`) judges its ignored heads again.
A list that only adds logins trusts everyone the old one did, so the heads the watch judged trusted, and the heads you vouched for, are kept.
A list that drops anyone forgets them, and they are judged again under the new list.
`--trust-none` empties the list, so the watch trusts only you (`loop.watch.update` with `spec.trust: []`).
Each remembered head carries the trust list it was judged under, and counts for nothing under another; a list that only adds logins carries them over to itself.
A poll that was under way when the watch changed records nothing it judged: neither a head trusted nor one untrusted under the rules it read.

GraphQL names a bot by its app's name alone (`renovate`), where the activity and REST say `renovate[bot]`; the watch reads each login's type, so a bot is never taken for the person who has its name.
Any other kind of account GraphQL names, such as a `Mannequin` an import left behind or an `EnterpriseUserAccount`, is nobody to the watch: it is never trusted, and its comments never count as an allowed author's.

### Vouching for a branch's head

`--trust-head` (on `loop watch add`, `update`, and `resume`, for `--branch` watches) is you vouching for each watched branch as it is now.
The watch reads each branch's current head from GitHub and remembers it as trusted under the watch's trust list: that head is trusted, so are the commits beneath it, and a later merge's chain of trusted merges ends at it.
It is recorded in the watch's history, which `show` lists as "you vouched for main at abc123… (put there by a push by @someone)", and in the audit log.
`show` always lists the newest of these for each branch, however many events came after it.
The command prints that line, so you see which commit you vouched for and who put it on the branch.
Given alone it vouches for whatever the head is when the daemon reads it, which may be a commit pushed after you last looked.
`--trust-head <branch>=<sha>` (repeatable) closes that gap: it vouches for that branch only, and only while its head is still that commit.
The commit is named by its full id (40 hex characters, or 64 in a SHA-256 repository; `git rev-parse <commit>` prints it), and a prefix is refused, however long: a prefix could match a commit pushed later that you never looked at.
If any named head moved, nothing is vouched for and nothing else in the request changes; the refusal names the head's full id now, so look at that commit and vouch again with it.
Over the protocol, `trustHead` is `true` or an object of branch to full commit id (`{ "main": "<40 hex characters>" }`), and the moved-head refusal carries `detail` `{ "kind": "head_moved", "branch", "head", "pinned" }` with `head` the full id, so a client re-pins without reading the words.
The web UI always vouches pinned like this, to the full id; it has no unpinned vouch, not even when making a watch.
Making a branch watch there vouches for nothing; once it exists, the watch offers the vouch dialog.
The dialog fills nothing in: a head you vouched for before, or one a failing check ran on, is offered as "Use <id> (view)", with its commit on GitHub, and an untrusted head is not offered at all.
If a head moved, the dialog shows its full id now with its link, and vouching for it takes ticking "I've looked at this commit" first.
It is never implied: making, resuming, or changing a watch without it vouches for nothing.
It also forgets that head's untrusted record, if the watch had one.
A trust list that only adds logins afterwards keeps it, like any remembered head.
One that drops anyone forgets it; give `--trust-head` again with the new list (`update --trust … --trust-head`).
In the web UI a narrowing save vouches for nothing; afterwards it offers the vouch dialog, pinned to the commits you look at.
`--trust-head` alone and `--trust-head <branch>=<sha>` can't be given in one command.
Given alone, it takes the word after it as its value, so put the watch id before it (`resume <watchId> --trust-head`).

Use it for a branch that changes only through reviewed, protected merges, such as a team's default branch, when the watch can't otherwise reach a head it trusts: its history begins with someone else's push, or reaches back further than the watch reads.
Vouch only for a head you would run yourself: everything on the branch at that moment is treated as yours, including commits you didn't review.
From then on, every poll moves the remembered head along with the branch as long as each change is a trusted merge, so you shouldn't need to vouch again unless something untrusted lands.

What follows from trusting by who pushed:

- `gh pr merge` without `--match-head-commit <sha>` merges whatever the pull request's head is when GitHub gets the request, and a collaborator can push to it just before; GitHub records you as having merged it either way, and doesn't say whether the head moved.
  Pass `--match-head-commit` with the head you reviewed, so a head that moved makes the merge fail instead.
- A push you make through GitHub's web UI is your push, and vouches for everything beneath it like any other: "Update branch" on a pull request, committing a review suggestion, editing a file on github.com, and creating a branch there.
  "Update branch" merges or rebases the base branch into the pull request's branch, so pressing it vouches for whatever is on the base at that moment.
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
  A comment on a pull request whose head is untrusted starts nothing while it is, and isn't lost.
  That pull request's comments aren't read while its head is refused, and it keeps its own floor: where the watch read comments from when its head was first refused.
  Once the head is vouched for (a trusted login pushes on top, or the trust list comes to include whoever pushed it), its comments are read once from that floor, so what was asked meanwhile runs on that head, and then it reads from the watch's floor like the others.
  A floor held more than seven days reads back seven days only, and the poll says so.
  The watch's other pull requests aren't held back by it.
  A held pull request that drops out of the newest 30 a poll looks at keeps its floor until it is looked at again; one that closes forgets it.

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
  Comments are read from ten minutes before the last complete poll, not from the beginning each time; from further back only while a comment waits to retry, and for a pull request whose head was refused, from its own floor once (above).
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
