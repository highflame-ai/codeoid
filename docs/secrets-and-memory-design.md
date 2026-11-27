# Secrets, memory facts, saved approvals and atuin

Status: agreed 2026-11-13. S1 built (§2.8). Four phases, one PR each, in order:
S1 secret references, S2 memory facts, S3 saved approvals, S4 atuin as a source.
The pure state machine for the turn loop is on the backlog (§7).

This came out of reading atuin (`/Workspace/atuin`), which captures shell history, command output and
every coding agent's sessions into one store. It is ahead of codeoid on keeping secrets out of what it
stores and on the facts it keeps about each command. Codeoid is ahead on running agents safely
(risk classifier, OS sandbox, checkpoints) and on recall. The parts below take atuin's ideas where they
fit codeoid, not its code.

## 1. The gap

Codeoid stores everything a session does, verbatim:

- the transcript (`<id>.jsonl`) and the canonical history (`<id>.canonical.jsonl`), which forks, backend
  switches and stateless backends are seeded from;
- the scrollback ring, replayed to every client that attaches, delegated watchers included;
- memory episodes (`memory/store.ts`), which are embedded, recalled across sessions and workstreams,
  shown to the conductor, and later sent between machines (federation);
- share bundles (`share/pack.ts`), built from the transcript.

Nothing scrubs any of them. `evidence/redact.ts` masks credentials in check output only, and
`mcp/redact.ts` only what the settings screens show. So `gh auth token`, `cat .env`, `printenv`, a
`curl -H "Authorization: Bearer …"`, or a token pasted into a prompt end up in every one of those
places, in plain text, for good.

Codeoid also knows less about each command than it could: episodes have no exit code, working
directory or duration, and don't say which backend or model did the work or whether the turn was the
user's or a delegated worker's. `get_episode` pages by characters, so an agent can't ask for the last
80 lines, where the error is. And every medium-risk shell command asks again in guarded mode, every
time: `npm test` forty times a day.

## 2. S1 — secrets become references

### 2.1 The rule

What codeoid stores never holds a secret's value. Where one appears it is replaced by a reference:

- `‹credential:<id>›` for a value codeoid already knows (§2.2): the reference names it, and its value
  stays where it already lives;
- `‹secret:<kind>:<fingerprint>›` for one the detector finds (§2.3): the kind (`github-token`,
  `aws-key`, `jwt`, `password`, …) and a keyed hash of the value, so the same secret seen in three
  sessions has the same reference, and nothing about the value can be learned from it.

The value of a detected secret is dropped by default. A workstream can keep it instead
(`captureSecrets: "vault"`, §2.5), so a person can still get it back later.

### 2.2 Secrets codeoid already knows

Most secrets that show up in a session are ones codeoid put there: a workstream's env credential the
agent echoed, an MCP server's bearer token in an error, the backend key. Codeoid knows these values
exactly, so they are replaced by exact match, with no guessing and no false positives. `KnownSecrets`
(new, `secrets/known.ts`) gathers them from every source, each under a label:

| Source | Reference |
| --- | --- |
| `credentials[]` values in the secret store (W1) | `‹credential:<id>›` |
| MCP OAuth access and refresh tokens, client secrets (`mcp_oauth_credentials`) | `‹credential:oauth:<credential or server>›` |
| Backend accounts' tokens, headers and env (`accounts.ts`) | `‹credential:account:<backend>:<name>›` |
| OpenAI-compatible endpoints' keys and headers (`openai-endpoints.ts`) | `‹credential:endpoint:<name>›` |
| The daemon's own keys in its environment (`CODEOID_*`, `*_API_KEY`, `*_TOKEN`, `*_SECRET`, `*_PASSWORD`, …) | `‹credential:daemon:<name>›` |
| The conductor's key (`conductor_identity`), the MCP relay's live per-session tokens | `‹credential:daemon:…›` |

ZeroID tokens minted for agents are JWTs, and codeoid's own MCP tokens (`bbt_`, `mmt_`, `sbt_`,
`rt_`) have formats of their own: both are found by shape (§2.3).

Each value is matched as written, URL-encoded, and base64 as `user:value` (Basic auth). Values shorter
than 8 characters aren't matched (they would match ordinary text). The set is rebuilt when a source
changes (a credential edited, an OAuth refresh) and cached by a version number; a scan is a single
multi-pattern search over the text.

### 2.3 Secrets codeoid doesn't know

A detector finds the rest by shape. It starts from `evidence/redact.ts`, widened toward atuin's
coverage (`atuin-common/src/secrets.rs`, `vendors.rs`, `structural.rs`): vendor token formats (GitHub,
GitLab, Slack, AWS, Google, Stripe, OpenAI, Anthropic, npm, PyPI, Hugging Face, ZeroID, …), JWTs, PEM
blocks, `scheme://user:password@host`, `Authorization:` headers, and values bound to keys that name a
secret (`*_PASSWORD=`, `"api_key": …`). The rules follow evidence's: only known shapes and values bound
to secret-named keys, never "looks random", so hashes and ids survive. The name or flag is kept and
only the value replaced (`DB_PASSWORD=‹secret:password:9c2e41aa›`).

The fingerprint is HMAC-SHA256 of the value under a key made once per daemon
(`<config dir>/secrets/fingerprint.key`, 0600, hidden from every sandbox), truncated to 8 hex
characters. Without the key a fingerprint can't be checked against a guess.

Scanning has a time budget (atuin's: 250 ms). Text that can't be scanned within it isn't stored; a
placeholder says so. This keeps a pathological input from stalling the daemon or slipping through.

### 2.4 Tool calls whose output is the secret

Some commands exist to print a credential: `gh auth token`, `printenv`, `env`, `aws configure get`,
`op read`, `security find-generic-password -w`, `cat .env`, `kubectl get secret -o yaml`, and any read
of a path `secret-paths.ts` knows as a credential file. Scrubbing their output by shape would miss
whatever has no known shape. So each tool call gets a verdict before it is stored (atuin's
`session_capture/policy.rs`):

- **keep**: stored, scrubbed (the default);
- **withhold output**: the call is stored, its output replaced by `‹output withheld: it prints credentials›`;
- **withhold written**: a write of a credential file (`.env`, `~/.netrc`, …) is stored without the
  content written;
- **drop**: the call isn't stored at all (a command the user listed in `secrets.dropCommands`).

The verdict reads the command with codeoid's shell parser (`shell/parse.ts`), so `bash -c 'gh auth
token'` and `x=$(gh auth token)` are caught as the plain form is.

### 2.5 Keeping a detected secret (opt-in)

`workstreams.items[].captureSecrets: "drop" | "vault"`, default `drop`; and the same at the top level
for sessions with no workstream. With `vault`, a detected secret's value is kept in the
`CapturedSecretVault`: a table in the database (`captured_secrets`: workstream, fingerprint, kind,
first and last seen, session, value encrypted with AES-256-GCM under a key in a separate 0600 file), so
a copy of the database alone doesn't hold the values. Entries expire after `secrets.vaultDays` (30)
unless promoted.

A kept secret can be:

- **revealed** by the session's owner, with an undelegated token, in the web UI or
  `codeoid secret reveal <fingerprint>`, audited;
- **promoted** to a declared credential (it gets an id and a place in the secret store, and from then
  on is matched exactly, §2.2);
- **forgotten**.

A reference made in one workstream resolves only there: a closed workstream's secrets are never shown
from another.

Why drop is the default: kept by default, the vault would gather every secret that ever scrolled past
(a customer's key in a log, a colleague's token in an error, a production key printed by accident) and
become the most valuable thing on the machine, holding values that mostly go stale when they are
rotated.

### 2.6 Where it applies

One scrubber (`secrets/scrub.ts`, behind `SecretService`, made by `codeoid start` only: tests and
embedders get none) at every place codeoid stores or sends on a conversation:

| Where | How |
| --- | --- |
| Tool output, in the `tool_complete` seam (`session.ts`) | before the `tool_result` hooks run, so canonical history, scrollback and transcript all get the scrubbed text. Not marked `redacted` as a hook's change is: the backend saw the same, so forking its own session adds no exposure, and marking it would cost every session that ever printed a secret its native forks |
| Tool input, at `tool_start` | the recorded copy only; the call runs as the backend made it |
| User prompts and assistant and thinking text | at the message's commit (`#commitStreamed`, `#persistAndBuffer`) |
| Live deltas to attached clients | `StreamScrubber`: a line is held from where a credential may start (a secret-named key and its separator, `Bearer`, a URL's userinfo, a JWT, a private key's armour) to its end, judged with what was already sent of the line; otherwise the trailing run of non-space characters, and never inside a known value with spaces; everything held goes out before a tool call. The committed message is scrubbed whole and replaces what streamed |
| Every message the session buffers, writes or sends (`#persistAndBuffer`, `#commitStreamed`, a fork's copy of its parent's rows, a settled approval's input) | `Session#scrubMessage`: text, parts, tool input and state, metadata |
| The canonical history | `CanonicalHistoryAccumulator.scrubTurn` on each turn as it is committed, so no backend is seeded with a value codeoid wouldn't store |
| `MemoryEngine.ingest` | so anything that ingests (S4's imports included) is scrubbed |
| `share/pack.ts` | transcripts written before S1 are scrubbed as they are packed |
| Dispatch digests, routine and loop results | built from scrubbed messages; a settled dispatch task's prompt, digest and error are scrubbed in the database (`Store.scrubText`; until it settles the prompt is what its worker is sent), a routine run's check output, summary and reason as they are written (not its payload, which the run reads back as its data); a session's last error is scrubbed when set |
| The turn index (`<id>.turns.jsonl`) | the prompt's first line, scrubbed before it is cut |
| MCP results through the relay (CLI backends' own MCP clients) | `McpHub.scrubRelayed`, as through the hub |
| Push notifications | carry ids only, no text |

A one-time `codeoid secret scrub [--dry-run]` rewrites what was stored before S1 (transcripts, canonical
histories, episodes, their FTS rows) with known values and detected secrets, and reports what it changed.
It is a command, not automatic: it rewrites history, so you run it when you choose.

### 2.7 What S1 doesn't fix

A stateless backend (OpenAI-compatible, Gemini, llama.cpp) is sent its working context from the
canonical history on every turn, and that history is scrubbed: from the next turn on, such a model
sees a secret it read earlier as its reference. The prompt of the turn it is answering goes as the
user wrote it (`Session#historyForTurn`).

A value found only by the name it sits under (`DB_PASSWORD=…`, `password: …`) is replaced there but
not remembered: the same word is too often ordinary text elsewhere. In code (`name = value`, spaced)
a value that is another name (`self.token`, `api_key`, `idToken`) is taken for code; in a `.env` or a
shell (`NAME=value`) it is a password like any other.

Known values are matched as whole tokens, and a value from the daemon's environment only when it
looks like a secret (12 characters or more, not a plain word): a dev default (`postgres`,
`development`) stays the ordinary word it is.

Memory, the routine and dispatch stores, and the hub scrub without a tenant: values are replaced
there as anywhere, but nothing is remembered or kept in the vault from them. A routine's output is
cut to its limit before it is stored, so a token at the cut can lose its end. A command's raw
output spill file (the compressor) is kept until it is taken into memory or pruned (a day), and is
removed at once when the call's output is withheld. A value of a distinct format (a
vendor's token, a JWT, a bearer token, a key) is remembered for the rest of the daemon's run, per
tenant, and replaced bare wherever it shows up again.

The backend has already seen the value by the time codeoid stores the result, and so has the model. A
CLI backend keeps its own copy (Claude Code's `~/.claude/projects/…/*.jsonl`, Codex's rollout files).
Codeoid can change what the model sees only where the output passes through it before the model:

- the tool loops codeoid runs itself (OpenAI-compatible, Gemini, llama.cpp);
- MCP servers reached through codeoid's hub: under `isolateGlobalServers`, every server on Claude and
  the credentialed HTTP ones on CLI backends.

S1 scrubs MCP results in the hub (`McpHub.setResultScrub`, `secrets.beforeModel`, on by default), which
the tool loops codeoid runs reach their MCP servers through too. Claude's Bash output passes through
codeoid only when the compressor wraps the command, in a separate process without the known values:
not scrubbed there yet. Elsewhere the backend's own copy is the exposure left, and
the docs say so plainly rather than implying more.

A secret with no known shape that isn't a value codeoid knows, in a command not on the verdict list,
still gets through. The detector reduces this; it can't end it.

### 2.8 S1 as built

- `secrets/`: `detect.ts` (the patterns), `known.ts` (`KnownSecrets`), `fingerprint.ts` (keys in
  `<config dir>/secrets/`, registered with the secret-path gate), `scrub.ts` (`Scrubber`,
  `StreamScrubber`), `verdict.ts` and `files.ts` (§2.4), `vault.ts` (`captured_secrets`, AES-256-GCM
  bound to tenant, workstream and fingerprint), `service.ts` (`SecretService`,
  `addDaemonKnownSources`), `scrub-stored.ts` (`codeoid secret scrub`).
- Known values: declared credentials, the daemon's environment (`CODEOID_*` and secret-named
  variables), every backend's accounts, OpenAI-compatible endpoints, MCP OAuth tokens and client
  secrets, the conductor's key. Rebuilt on a change, and at least every minute (a token refresh).
- Matching: known and remembered values in one pass (Aho-Corasick), never inside a reference
  already written; remembered ones as whole tokens. Detection is linear: private keys and curl's
  `-u` are found in code, the time budget is checked inside each pattern's matches too.
- Streaming: see §2.6. A piece is judged with the last 512 characters of its line already sent.
- Remembered values: indexed by their first characters, matched where a token starts: learning
  one costs nothing, and 2,000 remembered values cost a scan no slower than none.
- Verdicts also withhold: `export -p` / `declare -x` / a bare `export`, `env` with options only,
  `echo $SOME_TOKEN`, `cat .env*`, `git show/diff/log` of a credential file, `dd if=`, and what
  `ssh host …`, `docker exec … ` and `kubectl exec … --` run; and every backend's file tools'
  writes of a credential file (`writeTargets`, a patch's `*** Add File:`).
- `codeoid secret scrub` takes no time budget, remembers nothing across texts, leaves a text it
  can't check as it is (and says how many), includes rotated transcript segments, and rebuilds
  each database it changed (FTS optimize, WAL checkpoint, VACUUM) so replaced text is gone from
  disk.
- Protocol: `secret.list` (settings:read), `secret.reveal`, `secret.forget` (settings:write, the
  caller's own token, audited without the value). CLI: `codeoid secret ls | reveal | forget | promote |
  scrub [--dry-run]`; `promote` reveals, declares an env credential, sets its value and forgets the
  kept copy. `scrub` takes the daemon's data locks, so it refuses while the daemon runs.
- Config: `secrets.enabled`, `beforeModel`, `captureSecrets` (sessions with no workstream),
  `vaultDays`, `dropCommands`, `credentialFiles`; `workstreams.items[].captureSecrets`.

### 2.9 Using a secret without seeing it (S1b, after S4)

"Recall it if required" means an agent can use a secret without seeing it. An agent writes
`‹credential:gh-highflame›` in a command; codeoid's gate puts the value in as an environment variable
for that one command (`CODEOID_REF_1`, the reference rewritten to `"$CODEOID_REF_1"`) where the backend
lets the gate rewrite the call, and the output is scrubbed again on the way back. The model never gets
the value in its context, where it would land in the transcript again. This is per backend (Claude's
PreToolUse rewrite, the tool loops codeoid runs, opencode's shell shim), so it comes after S4.

## 3. S2 — memory facts

- **On shell episodes:** exit code (from the backend when it reports one: Codex, opencode, the tool
  loops codeoid runs; else the `Exit code N` line Claude's Bash result carries; null when unknown),
  working directory (the `shellCwd` the gate already has), and duration (`tool_start` to
  `tool_complete`). Unknown is null; a failure with no code is -1.
- **On every episode:** backend, model, and the turn's origin (`user`, `delegated`, `agent` from
  `turn-origin.ts` — `agent` also for background work outside a turn — and `dispatch` for a
  dispatched worker, loop attempts included), as they were when the call opened.
- **Recall filters:** `only_failed`, `backend`, `origin`, `cwd` (a repo root or folder), next to the
  existing `tool`, `filePaths`, `before`/`after`. On `recall` and the conductor's `fleet_recall`
  (`only_failed`, `backend`, `origin`); `timeline` stays a plain newest-first list.
- **Tail first:** `get_episode` takes `lines: [[start, end], …]`, negative counting from the end, and
  returns numbered lines with a `[… N lines skipped …]` marker and the total line count. The tool
  description says to ask for `[[-80, -1]]` first.
- **Exact first:** when a query is quoted, or looks like a command or an identifier, episodes holding
  it exactly come first, then the hybrid ranking fills the page under a separator line. When nothing
  matches, the reply says which filter to loosen.
- **Instructions:** the memory system-prompt text (`MEMORY_SYSTEM_PROMPT_APPEND`) gains one line:
  before re-running a command to find out what failed, recall it. The memory MCP server
  (`memory/mcp.ts`, `memory/mcp-http.ts`) carries the same text as its MCP `instructions`, for backends
  and outside agents that don't get the system prompt.

Old episodes keep null for the new fields; nothing is backfilled.

### 3.1 S2 as built

- A completed tool call had not reached memory since its completion moved to its own write path
  (the chunker saw only its start, and stored it as "unfinished" when the next call began; the
  reply after a call never became an episode). The tool_complete seam now hands the completed
  message to the chunker, which tracks every open call by its message id (parallel calls) and
  closes a refused one when it is refused.
- Text is held until it is known what it is: the reasoning of the call that opens after it, or
  the turn's answer, stored with its prompt when the turn ends (or the next prompt comes). The
  prompt goes with every call of its turn. A call still running when its turn ends (background
  work) stays open until its result comes, bounded (an hour, 64 open); when the session is
  destroyed or the daemon stops (`Session.flushMemory`), every open call is stored as
  unfinished. An interrupted call says so.
- Facts: `Session#toolFacts` records a shell call's directory (the backend's `shellCwd`, else the
  `cwd` its input names, joined to the workdir, else the workdir) and when it started running (at
  tool_start when it runs unasked, else at its approval); at completion its duration (the
  backend's, Codex's `durationMs`, else measured) and exit code (`memory/facts.ts` `exitCodeOf`:
  the backend's field (Codex, opencode); else 0 when the backend says it succeeded, whatever its
  output prints; else the code its result names (Claude's `Exit code N`, pi's `Command exited
  with code N`), never 0 for a failure; else -1, failed with no code, shown as "failed"). Every
  episode takes the backend, the model (the session's, else the backend's `runningModel`; none
  for Claude's default) and the turn's origin, and a call its workstream, as they were when it
  opened. Columns `exit_code`, `cwd`, `duration_ms`, `backend`, `model`, `origin` on `episodes`.
- Recall: `RecallQuery.onlyFailed` / `backend` / `origin` / `cwd`, applied in `matchesQuery`; a
  query with one also takes `recentMatching` (the newest 200 by the columns, scoped in SQL) as
  candidates. `exactQueryText` (quoted; or a path, a file name, a flag, an assignment, a
  snake_case or camelCase identifier; or a command with a flag that isn't a question) takes
  `containing` (an FTS phrase search, scoped in SQL, then checked; over the indexed view of a huge
  output, so a command deep in a long log isn't an exact match) first, marked `exact`.
  `fleet_recall`'s filters apply to a larger text search (it has no fact channel of its own).
- Tools: the recall tool's new arguments, a `facts:` line per hit, a divider after the exact ones,
  "Try loosening: …" when filters leave nothing; `get_episode` `lines` (1-based, negative from
  the end, merged, `[… N lines skipped …]`, at most 2,000 lines and the page size, a cut line
  saying the offset to read it from); `MEMORY_INSTRUCTIONS` as the memory MCP server's
  `instructions`, and two lines more in the sessions' memory prompt.
- A raw output a spill brings back is scrubbed by the session (its tenant) before it is stored,
  and taken away when a `tool_result` hook changed what the agent saw. Its exit code is read from
  what the agent saw (a compressed output may have lost the line).

## 4. S3 — saved approvals

In guarded mode every shell command that isn't low asks, every time. S3 lets the owner answer once for
a scope:

- **Allow once** (as today).
- **For this session**, for `approvals.sessionGrantHours` (8).
- **In this repository**: kept by codeoid, keyed by the repository's real top-level path, never read
  from a file in the repository (an agent could write one).
- **In this workstream**, or **everywhere**: from the settings screen.

A rule is a program and an argument prefix, in Claude's form (`Bash(npm test:*)`, `Bash(make lint)`),
plus MCP tools by name (`mcp__linear__list_issues`) and web fetches by domain (`WebFetch(domain:docs.rs)`).

The rules that keep it safe:

- Only **medium** commands can be saved, and only medium commands run on a rule. A high, not-understood
  or credential-touching command is judged again every time and always asks, whatever rules exist.
- A line runs on rules only when **every** simple command in it matches an allow rule
  (`npm test && rm -rf build` needs both); one deny rule matching **any** of them refuses it.
- The program is a literal word. No bare `Bash` or `Bash(*)`, no rule for a shell (`bash`, `sh -c`),
  `eval`, `sudo`, or a wrapper that runs another command; the program after a wrapper is what must
  match.
- Saving needs the owner's own token; a delegated one can only allow once.
- Interactive mode ignores rules (it asks about every call). Autonomous mode doesn't need them.
- Every saved rule is listed in Settings → Approvals, shows where it applied, and can be removed. Every
  use is audited (`session.rule_allow rule=… scope=…`).

Claude's own `permissions.allow` rules keep working on Claude as today. Codeoid's rules work on every
backend.

### 4.1 S3 in detail

**A rule** has a tool, a pattern, an effect (allow or deny), a scope and an owner:

| Form | Matches |
| --- | --- |
| `Bash(npm test)` | exactly `npm test` |
| `Bash(npm test:*)` | `npm test`, and `npm test` followed by any words |
| `mcp__linear__list_issues` | that MCP tool |
| `WebFetch(domain:docs.rs)` | allow: an http(s) fetch of exactly that host on its default port; deny: the host and its subdomains |

A rule belongs to the user who saved it, in their tenant, and applies only to that user's sessions.

- Allow rules run only in sessions a person made with their own token. A session a delegated or automation
  token made gets none, and neither does a dispatched worker, which the conductor's identity makes.
- Those sessions' cards offer no save.
- This is kept in the meta (`TranscriptMeta.madeByAgent`, written true or false), since a resumed session's
  auth doesn't carry it. A meta from before it counts as a person's, unless its owner is the conductor's identity.
- Deny rules apply to every session made with the owner's identity.

The scope is one of:

- `session`: that session, until `approvals.sessionGrantHours` (8) have passed, or the session is destroyed.
- `repository`: every session of that user in the repository, its worktrees included. The key is the session's
  `workspaceId`, the same one memory uses: a hash of git's common dir, or of the folder outside a repository.
- `workstream`: every session homed in that workstream.
- `everywhere`.

**A shell line runs on allow rules** only in guarded mode, and only when all of these hold:

- The line is fully understood (no problems, not unreadable).
- It has no loop, `case`, function, `declare`, `[[ … ]]` or `(( … ))`.
- It has no variable assignment (`X=1 npm test` sets the program's environment) and no arithmetic.
- Its level is low or medium, and it names no credential file.
- The backend said where its shell is (a `null` shell cwd means it may have moved).
- Every simple command is covered, by being one of these:
  - a plain read, as low's allow-list judges one command (`tail -50` after `npm test 2>&1 |`, a read in `$(…)`);
  - a `cd` / `pushd` / `popd` to a literal directory inside the workspace;
  - a match for an allow rule, run plainly:
    - no wrapper, script or input it runs for others, and nothing fed on its input (a pipe, here-document, `<`);
    - only reading redirects;
    - in the workspace, links followed;
    - every word known before it runs (no variable, substitution, glob or brace expansion);
    - every path its words name inside the workspace, links followed: an option's value (`-C..`, `--x=y`), each
      part of `a=b,c`, an `@file`. A URL or a `file:`, `data:` or `npm:` specifier counts as outside;
    - no option that makes a build or test tool run code it is handed, or read instructions from elsewhere
      (`CODE_OPTIONS`: `make --eval`, `VAR=value`, `go -exec/-toolexec` with one or two dashes, `cargo --config`,
      `npm --node-options/--script-shell/--prefix`, `docker --output/--network/--allow`, …). A long option is
      also refused shortened, where the tool accepts that (make, npm, pnpm, yarn). A `-f`/`-C` to a file or folder
      inside the workspace is fine: the outside-path check covers the rest;
    - no word naming something to fetch (a URL, `npm:`/`jsr:`/`file:`, `github.com/…`, `git@host:…`);
    - every word that names something existing where it runs (a bare `out`), and every path read with `<`,
      judged as a path; `..` read both as text and as the kernel reads it;
    - the rule's words literal and equal to its own (an exact rule also needs the same number of words).
- A `cd` is followed only when it is certain: one in a subshell, `$(…)` or behind `&&`/`||`, or to a folder
  that doesn't exist, leaves every later command in no known place.
- A command inside `$(…)` is a simple command of its own, so it must be covered too.
- On Codex, which hands commands over as `bash -lc '<script>'`, the script is what allow rules read; deny rules
  read both.

**What can't be an allow rule:**

- A shell, `eval`, a wrapper or privilege program.
- A builtin that changes what later words run or prints the environment (`hash`, `enable`, `shopt`, `set`,
  `export`, `printenv`).
- A wildcard right after the program (`Bash(git:*)`).
- An interpreter or runner (including versioned ones such as `python3.12`) with no named script or subcommand.
- A runner's `run`/`exec`/`dlx`/`x` with nothing named after it (`Bash(bun run:*)`).
- A local or IP host (`localhost`, a single-label name, `127.0.0.1`).

No rule word may hold a space, quote, shell character, control or invisible character. **Deny rules may name any
program.** A stored allow rule that the rules have since come to refuse is dropped when read; a deny rule never
is.

**Deny rules** match a command's program by name, ignoring case, however it is run (`sudo /bin/npm`). They also
match it named after a runner, a wrapper or a runner's `run`/`exec` (`npx npm …`, `uv run git push`). The rule's
other words must appear in order after it, with anything between or after: an exact deny rule matches as a
prefix one does.

- A line that can't be read in full (a script piped to a shell, problems, too long to read) is refused when its
  text names the rule's words in order.
- A fetch whose host can't be read is refused while any fetch deny rule exists.
- Deny rules are a best effort over what the line shows (an alias or a variable program escapes them). The OS
  sandbox is the boundary.
- They are checked at the gate in every mode, and in Claude's PreToolUse hook before the CLI's own allow rules
  (`ProviderSessionInit.approvalRuleRefusal`).
- Calls a backend runs without asking can't be refused: Codex in autonomous mode and its own safe commands in
  guarded mode, Qwen's read-only commands.
- A fetch deny rule covers a tool named `WebFetch`. A sandboxed `curl` to the host is the sandbox network's to
  stop.
- When the saved rules can't be read, every command, fetch and MCP call is refused (fail closed).

**The card offers** "Allow once", "Allow for this session" and "Allow in this repository":

- The two save buttons appear only in guarded mode, on a call a rule could run, in a session a person made.
- The card names the rules a save would add, one per simple command not yet covered:
  - `program verb:*` for building and checking (`test`, `build`, `lint`, `check`, `typecheck`, `fmt`, `format`,
    `clippy`, `vet`, `bench`, `compile`);
  - `runner run verb:*` for such a package script (`npm run lint:*`);
  - otherwise the exact command, so approving a read never saves a rule that writes;
  - nothing when more than 20 rules would be offered.
- The daemon works the rules out again from the call's own input when the answer arrives.
- The client must send back the rules its card showed (`session.approve` `rules`). A save that would now keep a
  rule the card didn't show is refused. Fewer than it showed (another save covers part of it now) stands.
- Saving needs the session owner's own, undelegated token. Any other approver's save is refused and the card stays
  open; a delegated approver can still allow once.
- A call that a rule saved since already covers saves nothing and is approved.

**Settings → Approvals and `codeoid approvals ls | add | rm`** list a user's rules:

- Each row shows its scope, when it was last used and how many times.
- The user adds rules there for a repository, a workstream or everywhere (the CLI also adds them for a session),
  and deny rules too.
- The user removes them there.
- Adding needs `settings:write` and an undelegated token. Listing and removing cover only the user's own rules.

**Where rules apply:** in the session's gate, on every backend. They apply after every refusal (credential paths,
the workstream fence, pinned paths, held writes, autonomous refusals).

- Allow rules never run a call that always asks: high, not understood, a credential search, an unsandboxed
  request, a held or Claude-settings write. Deny rules do refuse those.
- Neither touches a fleet dispatch, a question, an unresolved path or a directory request.
- **Interactive mode** ignores allow rules. **Autonomous mode** doesn't need them.
- **MCP allow rules** hold only in a session whose MCP servers codeoid manages, and while no project file declares
  a server (#395). They don't run Codex's MCP calls, whose tool codeoid reads from Codex's message.

**Audit:**

- `approval_rule.add` (only for a new rule) and `approval_rule.remove` record changes to the rules.
- `approval_rule.save_refused` records a refused save.
- `session.rule_allow rule=<id> scope=<kind> tool=…` records each call a rule ran.
- `session.rule_deny` records each call a rule refused, with `at=hook` when Claude's hook refused it.

## 5. S4 — atuin as a source

Atuin already captures the user's own shell history, command output, and every coding agent's
sessions, including ones codeoid didn't start. S4 brings that into codeoid's memory, read-only, rather
than building a terminal proxy:

- **What:** atuin's history (command, cwd, exit code, duration, author), the output it captured for
  failed commands, and its threads (Claude Code, Codex, opencode, … sessions).
- **How:** codeoid runs `atuin mcp` as an MCP client (its tools `atuin_history`, `atuin_output`,
  `atuin_threads_list`, `atuin_threads_read`) on a schedule and when the conductor asks, and ingests what
  is new as episodes (`source: "atuin"`, the thread's agent as the backend). A per-source watermark plus
  a stable id per item (atuin's history id, a thread's message id) keeps re-reads from duplicating.
- **Workstreams:** each item is homed by its cwd (§5 of workstreams-design.md), so a closed
  workstream's commands are withheld from the conductor as its sessions are. An item whose folder has
  no home stays out under isolation.
- **Secrets:** everything goes through `MemoryEngine.ingest`, so S1 scrubs it.
- **Off by default** (`integrations.atuin.enabled`). Codeoid works the same without atuin installed.

Open before S4 starts: whether atuin's MCP output is stable enough to parse, or whether its CLI's
`--format json` is the better interface; and whether threads are read whole or only what changed.

## 6. Testing

Every phase: unit tests for the pure parts (the scrubber and the verdicts against a table of real
command lines and outputs; the rule matcher against compound lines), session tests through a mock
backend (a secret printed by a tool never reaches the transcript, the canonical log, the scrollback, an
episode or a bundle), an e2e journey on a real daemon, and two audit rounds before each PR.

## 7. Backlog

- **The turn loop as a pure state machine** (atuin's `atuin-ai/src/fsm`): events in, effects out, no
  I/O, so cancellation, late results and timeouts are tested synchronously. Start with the approval
  lifecycle.
- Retention: a disk budget for episodes, with a head-and-tail cap on large tool output.
- Capturing the native session files of agents codeoid didn't start without atuin (Claude and Codex
  JSONL), if atuin isn't installed.
