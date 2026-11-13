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
  `tool_complete`).
- **On every episode:** backend, model, and the turn's origin (`user`, `agent`, `delegated`, from
  `turn-origin.ts`; plus `routine`, `loop` and `dispatch` for unattended runs).
- **Recall filters:** `only_failed`, `backend`, `origin`, `cwd` (a repo root or folder), next to the
  existing `tool`, `filePaths`, `before`/`after`. On `recall`, `timeline` and the conductor's
  `fleet_recall`.
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
  message to the chunker, which tracks every open call by its message id (parallel calls), closes
  a denied one when it is refused, and at the turn's end closes what never got a result and keeps
  the reply that came while a call ran.
- Facts: `Session#toolFacts` records a shell call's cwd (the backend's `shellCwd`, else the
  workdir) and when it started running (at tool_start when it runs unasked, else at its
  approval); at completion its duration and exit code (`memory/facts.ts` `exitCodeOf`: the code a
  result names near its start or end, else 0 when the backend says it succeeded). Every episode
  takes the session's backend, model and the turn's origin (`turnOrigin`, `dispatch` for a
  worker). Columns `exit_code`, `cwd`, `duration_ms`, `backend`, `model`, `origin` on `episodes`.
- Recall: `RecallQuery.onlyFailed` / `backend` / `origin` / `cwd`, applied in `matchesQuery`; a
  query with one also takes `recentMatching` (the newest 200 by the columns) as candidates.
  `exactQueryText` (quoted, or a token with a path, flag, dot or `CONST`, or words with a flag)
  takes `containing` (an FTS phrase search, then checked) first, marked `exact`.
- Tools: the recall tool's new arguments, a `facts:` line per hit, a divider after the exact ones,
  "Try loosening: …" when filters leave nothing; `get_episode` `lines` (1-based, negative from
  the end, merged, `[… N lines skipped …]`, at most 2,000 lines); `MEMORY_INSTRUCTIONS` as the
  memory MCP server's `instructions`, and two lines more in the sessions' memory prompt;
  `fleet_recall` `only_failed` / `backend` / `origin`.

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
