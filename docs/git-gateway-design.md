# Git gateway: agents fetch and push without holding a credential

Status: design, implemented in PR #477 (replacing the `push` tool that PR first had).

## 1. The problem, and what others do

A sandboxed command can't `git push` or `git fetch` to the git host:

- **No network:** with the network off the sandbox has no route out; Claude's sandbox lets commands out only through its HTTP proxy.
- **No credentials:** ssh keys, the ssh agent, credential helpers and stores, the keychain and `gh`/`glab` logins are all hidden.

Opening either one up defeats the sandbox, because the owner's credentials reach every repository they can, and the agent could then send code anywhere. The `push` tool this PR first had (the daemon runs `git push` on the host with the owner's whole git setup) took 14 audit rounds. Almost every finding came from running the owner's git config, `includeIf` files, ssh, credential helpers, askpass and PATH on the host for an agent.

A survey of other projects (PR #477 discussion) found four patterns:

| Pattern | Who | Credential |
|---|---|---|
| A credential-injecting proxy outside the sandbox checks each git request and adds the real token | Claude Code on the web (session repositories, the configured branch, no deletes or tags), Docker Sandboxes | real token outside, placeholder or scoped one inside |
| The platform pushes for the agent | GitHub Copilot's cloud agent (its own tool, `copilot/*` branches), GitHub Agentic Workflows "safe outputs" | outside |
| A scoped token inside, with an egress allowlist | Codex cloud, Cursor and Devin (GitHub Apps scoped to repositories), OpenHands | inside, scoped |
| The owner's ssh agent forwarded in | Docker Sandboxes (named as a risk) | the owner's own |

Nobody runs the owner's ambient git setup on the host for an agent. codeoid takes the first pattern, fitted to a local daemon.

## 2. Goals

- **Plain git:** the agent's own `git push` and `git fetch` work unchanged, on every backend (Claude, Codex, opencode, pi, the Gemini CLI, Qwen, the native loop). It works at the network layer, so no backend has to support a tool.
- **No credential inside:** no owner credential, and nothing that stands in for one, ever enters the sandbox.
- **Zero setup by default:** the owner's existing credentials (ssh key and agent, or a git credential for https) are used, with consent once per remote. A dedicated per-repository token is an opt-in.
- **Owner-decided scope:** only remotes the owner connected; only branches the policy allows; no deletes, tags, force pushes, protected branches or the remote's default branch.
- **The owner's git config never decides a push or fetch the gateway makes:** no `includeIf`, helpers, hooks, drivers or rewrites.
- **Terminal parity:** everything is reachable from the CLI, not just the web UI.

Non-goals for now: forge APIs (opening a PR), registries and other services. The design leaves room for them as adapters (§10). Docker sandboxes come later (§7).

## 3. Architecture

```
sandbox (any provider)                     daemon (host)
─────────────────────────                  ──────────────────────────────────────────────────────────
agent: git push origin feature/x
  │ url."codeoid::<url>".insteadOf <url>    per-session gateway socket (unix; only this session's
  ▼                                          sandbox sees it, so the socket says who is asking)
git-remote-codeoid (remote helper) ───────▶  gateway
  "connect git-receive-pack"                  ├─ the remote: connected by this session's owner?
  then raw pack protocol                      ├─ cache: a daemon-private bare mirror of the remote,
                                              │   refreshed from upstream before every request
                                              ├─ serves git-upload-pack / git-receive-pack on the cache
                                              │   (git's own server; hardened, fsck on)
                                              ├─ pre-receive policy hook: refs, ancestry, owner's answer,
                                              │   then pushes the checked commits upstream (atomic); the
                                              │   agent's push succeeds only if upstream took them
                                              └─ upstream git: clean config (no global or system config),
                                                  the owner's credential: ssh (system ssh, their key and
                                                  agent) or https (a token captured at connect, from the vault)
```

### 3.1 Sandbox side

- Only for an owner who connected a remote. The spec's environment adds, as `GIT_CONFIG_PARAMETERS` (a backend that drops variables named like `*KEY*`, as Codex does, keeps it), `url."ext::<launcher> %S <url>".insteadOf <url>` and `pushInsteadOf` for:
  - each remote the owner connected;
  - the workspace repository's ssh remotes;
  - its https remotes, when the network isn't on.

  These are whole URLs, never prefixes, so they outrank an owner's shorter rewrite. It uses the old `'key=value'` form, which every git parses; a URL with `=` is left out. `protocol.ext.allow=user`, so a submodule's `ext::` URL runs nothing. The agent may unset this, but that only takes its own access away.
- A connection change marks the owner's sessions' sandboxes for re-resolution between turns. A session made with a delegated token gets no gateway access.
- The launcher (`codeoid-git-ext`, `exec <runtime> ext.js`) is in the gateway's `bin/`, re-exposed read-only with codeoid's runtime. git's `ext::` transport runs it with the service name.
- It opens the session's socket and sends one header line (`{"service":"git-receive-pack","url":"…"}`). On `ok` it relays:
  - git's output in length-prefixed frames, with a 0 length when git is done writing (never a socket half-close);
  - the gateway's answer as a plain stream.

  A refusal is printed as git's own error. It exits when git, or git's remote-ext helper, goes, so the gateway sees the connection close.

### 3.2 Transport: a unix socket per session

- With the network off, bwrap unshares the network, so TCP is out, but a bound unix socket still connects.
- Each session gets `<daemon-private>/gw/<session>/git.sock`, bound into that session's sandbox only. A connection on it is that session's, so no token is needed and there is none to leak.
- Per provider:

| Provider | How the socket is reached |
|---|---|
| bwrap | `--bind` of the socket's dir |
| Seatbelt | `network-outbound` to that path |
| Claude's sandbox | `allowUnixSockets` (macOS), or `allowAllUnixSockets` (Linux) with the filesystem deciding reach, as for `dockerSockets` |
| Process backends | the same bwrap spec |

### 3.3 The gateway is a git server on a cache

The daemon doesn't parse or relay the pack protocol itself. It runs git's own server on a daemon-private bare mirror of the remote (`<configDir>/git-gateway/cache/<hash(owner,url)>.git`):

1. **Refresh:** `git fetch` from upstream (heads and tags, with prune) into the cache, under the cache's lock (held for the refresh only, never across serving or a card). Then record the remote's `HEAD` and its symref branches (`ls-remote --symref`).
2. **Serve:** `git upload-pack` (fetch) or `git receive-pack` (push) on the cache, with stdio relayed to the socket.
   - Hardened: `transfer.fsckObjects`, no `uploadpack.allowAnySHA1InWant`, the hooks path set to codeoid's own hook, and none of the owner's git config (`GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`).
3. **Pre-receive (push only):** codeoid's hook gets `old new ref` per update, with the pushed objects in git's quarantine.
   - It refuses, naming the reason the agent reads:
     - a ref that isn't `refs/heads/*`, or `HEAD`;
     - a delete (new is zero);
     - a protected branch (`sandbox.push.protectedBranches`; `main` and `master` by default, case-insensitive);
     - the remote's default branch, or any push when the remote couldn't say what that is;
     - a branch the remote has as a symref;
     - an existing branch no agent made through the gateway (`git_agent_branches`, per owner and URL);
     - a non-fast-forward (`merge-base --is-ancestor old new`, against the refreshed cache);
     - anything to an empty remote.

     Several refs are taken when every one passes, and they are pushed upstream atomically.
   - Each update's `old` is taken from the refreshed cache, never from the client. A different claim is refused, and the upstream push carries `--force-with-lease=<ref>:<that old>` (empty for a new branch).
   - The decision is tied to the agent's connection. If it closes (a tool's time limit, an interrupt) or the session closes, the owner's card closes and nothing is pushed.
   - In guarded mode, the owner is asked on a card first: the branch, commit and URL (a `git push` carries no reason). A role whose network isn't `true`, or is read-only, is refused.
   - Then the hook pushes the checked commits upstream (`git push --atomic --porcelain <upstream> <new>:<ref>` with the quarantine's object env and the gateway's upstream env). The agent's push is accepted only if upstream took them. Upstream's own messages, redacted, are relayed as the hook's output.
4. **Audit:** every request, refusal, answer and result goes to the audit log and the transcript (`session.git_*`).

### 3.4 Upstream access with the owner's credentials

- Every upstream git runs with `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`, the hardened env from `git-env.ts`, and no askpass. The only config is what codeoid sets.
- **Data, never programs (round 7).** Earlier rounds judged the owner's config files (links, includes, globs) before running what they named; each round found another form the judge missed. Now the gateway never runs a program the owner's config names: it takes data from it, once, at connect.
- **ssh (round 9):** resolution is OpenSSH's own. Rounds 7 and 8 showed a re-implementation of readconf.c keeps diverging (keyword spellings, `IdentitiesOnly true`, CanonicalizeHostname, quoting). At connect, `scanSshConfig` reads every file the config can read: every `Include` in any block, any spelling of the keyword, regular files only, opened non-blocking, at most 16 deep and 256 files. It refuses any `Match` (whose `exec` `ssh -G` would run). Since round 10 it refuses any Include argument it can't read exactly as `argv_split` does: a quote that isn't at a word's edges, whitespace other than space or tab, anything but printable ASCII, `%`, `$`, a backtick, a backslash, `[`, `=` (ssh skips one `=` after the keyword; round 11), `~user/`, or a `.` or `..` component. It also refuses a glob over a name that isn't valid UTF-8 or holds a control character, a regular file it couldn't read whole (over 1 MiB), and a non-regular file. **Backstop (round 10):** ssh runs a `Match exec` as `$SHELL -c`, so `ssh -G` runs with `SHELL` set to a trusted `/bin/false` and `PATH=/nonexistent`. A `Match` the scan missed is then false and runs nothing (tested); the scan only decides what is refused and held. Every source is judged. Then `ssh -G -F ~/.ssh/config [-p port] [-l user] -- host` (the system ssh from `/`, with a minimal env and a timeout; no system config) prints the resolution. The snapshot takes HostName, User, Port, IdentityFile, CertificateFile, IdentitiesOnly, IdentityAgent, User/GlobalKnownHostsFile, HostKeyAlias and ProxyJump, with each jump host resolved the same way (three levels). It marks ProxyCommand, KnownHostsCommand and CanonicalizeHostname unsupported. `snapshotProblem` refuses unsupported settings, values that aren't plain data, file values with tokens, variables or relative paths, and any file (as named and as resolved) or source in what a session may write. The agent-triggered card resolves first and shows `sshSnapshotLine`, and the snapshot shown is the one stored. The snapshot is stored with the connection (`git_connections.ssh`). Each run writes it as a 0600 config in the gateway's run dir, ending `Host *` with BatchMode, ConnectTimeout, `PermitLocalCommand no`, `ForwardAgent no`, `ClearAllForwardings yes`, `ProxyCommand none` and `ControlMaster no`/`ControlPath none`. `core.sshCommand` is the absolute system `ssh` with `-F` on it. With a ProxyJump, that path must be plain, because ssh splices it unquoted into a shell. The scan's sources also feed `ownerConfigFiles`, from the passwd home (`sshHome()`). A connection without a snapshot is refused until it is connected again.
- **https:** at connect time, and only then, the owner's credential is read once with `git credential fill`, run from `/` with a minimal environment and a generated global config holding only helper lines codeoid writes (`safeHelper`) for the owner's helpers that are on an allowlist: a platform helper by name, `cache [--timeout N]`, or `store [--file '<plain absolute path>']` (judged, quoted by codeoid; git runs a helper through the shell). PATH is filtered to dirs no session may write. `credential.<url>.helper` applies as git's urlmatch decides (`credentialUrlMatches`). A `cache` helper is refused when its socket dir is session-writable. `ownerConfigFiles` also lists every `include.path` and `includeIf.*.path` target, active or not and there or not. Any other helper is refused, pointing at `--token`. The CA path is judged the same way. It's kept in a 0600 file in the gateway's dir, which is a refused secret path for host-side file tools, together with their `http.sslCAInfo` for the URL.
  - Each upstream git gets it through a URL-scoped credential helper of codeoid's, which reads a per-run 0600 file there, removed after. It is never in an environment or on argv.
  - `http.followRedirects=false`.
- **Dedicated token (opt-in):** `codeoid sandbox git connect --url <u> --token` stores a per-repository token instead (a Bitbucket repository access token, a GitHub fine-grained token). That's for shared daemons and sensitive organisations.

### 3.5 Owner consent

- `codeoid sandbox git connect [dir] [--remote origin | --url u] [--token] [--yes]` (protocol `sandbox.git_connect`; needs `settings:write`, refused for delegated tokens):
  - from a repository: resolves the URL its config names, shows it and asks;
  - proves the credential works with `git ls-remote` (upstream env);
  - records `(owner, url, kind, auth)`.
- `codeoid sandbox git disconnect` and `codeoid sandbox git ls`.
- In guarded mode, an unconnected remote's first request raises a card ("Let agents fetch and push to `<url>` with your existing <ssh key | git credential>, only their own branches, no force, no deletes?"). Autonomous mode refuses with the command to run.
- A connection is per owner and per URL. It decides only that owner's sessions.

## 4. What this removes from #477

The `push` MCP tool and its wiring are removed:

- `request-directory` push, the providers' `push` init, `isPushTool`, the prompt line, the trust card;
- the host-side bundle and staging push;
- reading and judging the owner's git config (`readPushTarget`, `includeIf` comparisons, `RUNS_PROGRAM`, `commandProblem`, the PATH filter);
- the writable-dirs history and `forget-writable`;
- `push_trust`.

What stays, reused: `redactCredentials`, `hostPathProblem` (for git, ssh and the runtime binary), the protected-branch settings, and the role check.

## 5. Security properties

- **No credential in the sandbox:** the socket carries the pack protocol only; the credential lives in the daemon.
- **Scope is the owner's:** only connected URLs, only allowed refs, fast-forward only. The cache is refreshed from upstream just before checking ancestry.
- **Untrusted packs go to git's own server:** `receive-pack` with fsck, in a daemon-private repository. That's what every git host does with untrusted clients.
- **No owner config runs:** the gateway's git uses no global or system config, so no helper, `includeIf`, rewrite or driver. The only host programs are codeoid's git, the system ssh and codeoid's runtime, each judged by place, owner and mode.
- **Per-session identity:** the socket is bound into one session's sandbox, so a connection is that session's.
- **Redaction:** every text the agent, the transcript and the audit read goes through `redactCredentials`.
- **Residual risks:**
  - The owner's credential is broad, so the gateway's checks are the scope (the same trust model as Claude Code on the web); dedicated tokens narrow it.
  - A pushed branch runs the repository's CI with its secrets (said at connect, on the card and in the docs).
  - Server-side branch protection remains the backstop.

## 6. Configuration and terminal parity

- `sandbox.git.enabled` (default on; `CODEOID_SANDBOX_GIT`).
- `sandbox.push.enabled` (pushes; fetch stays) and `sandbox.push.protectedBranches` (`CODEOID_SANDBOX_PUSH`, `CODEOID_SANDBOX_PUSH_PROTECTED`).
- CLI: `codeoid sandbox git connect|disconnect|ls`. Settings → Sandbox shows the settings. The web UI doesn't list connections yet.

## 7. Providers and backends

- bwrap, Seatbelt and Claude's sandbox: supported (§3.2).
- Docker: later. The container has no codeoid runtime for the helper, so a static helper is needed. Until then git there behaves as today.
- Claude's sandbox on Linux can't allow a single unix socket. With the gateway, every unix socket a command can see becomes connectable, as with Docker access. Local service sockets are hidden whenever the gateway is in the spec, and the host's `/tmp` is denied.
- Codex's own network-off sandbox (seccomp) may also refuse a unix socket `connect`. That's not verified yet.
- In-daemon backends (OpenAI, endpoints, the Gemini API) run no commands, so there's nothing to do for them.

## 8. Testing

- **Unit:** the policy (refs, deletes, tags, protected and default branches, non-fast-forward, atomic) and redaction.
- **Real git end to end:** the helper and socket, the cache, `receive-pack`, the hook, and a bare "upstream" over `file://`, a test-only allowance.
- **Real bwrap:** a sandboxed `git push origin feature/x` reaches the upstream with the network off; a force push, a delete and a push to `main` are refused with readable reasons; nothing in the sandbox holds a credential.
- **Manager-level:** connect, guarded card, autonomous refusal, roles, audits.
- Then the three-lane audit rounds, as before.

## 9. Open questions

- Other forge APIs (open a PR) need an API credential an ssh key can't give: an Atlassian or GitHub token captured at connect, through a later HTTP adapter.
- Cache disk use: one bare mirror per connected remote, removed when its connection is (`GitGateway.forget`). Objects the remote deleted stay in it until then, never served (v0 only, `allowAnySHA1InWant=false`) and never pushed: the hook's `objectsNotSent` makes every object a push's new tips need past the cache's refs come from the push's own quarantine, or be reachable from the cache's refs (round 13: receive-pack keeps the whole pack, `receive.unpackLimit=1`, and a candidate missing from the quarantine is looked for in `rev-list --objects --all` before refusal, so a revert or a bitmap client's push goes). Round 14: a thin pack's delta bases are copied into the quarantine from the cache (`--fix-thin`), so the quarantine's own objects are judged too: every object the push would publish or brought along that the cache's own store already holds must be reachable from the cache's refs (`--use-bitmap-index --all`, walked only when there is such an object). A push built on a deleted object, or re-sending one, is refused; the owner reconnects the remote to start a clean cache. Round 15/16: the cache no longer keeps what the remote deleted. Every ref id the cache has had since its last prune is recorded on disk (`codeoid-refs-seen`, written before each fetch can drop one), so however a refresh ends (a fetch that prunes and then fails, an agent gone mid-way, a restart) the next request judges `cacheDirty`: an id it had that no ref names now, still present, reaching an object no ref reaches (`rev-list --objects <dropped> ^<now>`); a missing record counts as dirty. A dirty cache is, under its lock, once what is served on it is done (fetches are stopped; pushes, counted until their upstream push ends, are waited for up to 3 min; new requests wait on the lock), repacked with its `.keep` files removed (`repack -a -d -b`) and pruned (`prune --expire=now`; the commit graph and multi-pack index removed). A dirty cache that can't be pruned serves nothing ("try again"). This closes the fetch side (a `shallow` line, a `sparse:oid` filter, a `have`, fsck or delta errors naming a deleted object: there is none); `uploadpackfilter.sparse:oid.allow=false` as well. Just before the upstream push the hook asks the remote its branches and tags (`ls-remote`), fetches the ones the cache doesn't have into a private namespace (`refs/codeoid-check/<id>/`, removed after, remembered as seen), and runs `objectsNotSent` again against all of them, so a connection held open over a purge, or a late card, can't republish it, and a branch that moved on meanwhile doesn't refuse an ordinary push. A disconnect is checked again after it. Round 17: check refs are hidden from upload-pack and receive-pack (`hideRefs`), and every refresh sweeps the ones no running check owns (a daemon stopped mid-check), so what only they reached is judged and pruned. Every operation that stores objects (a refresh fetch, a check fetch) writes a mark with the cache's packs before it and removes it once what it stored is recorded (fetches keep their pack: `fetch.unpackLimit=1`); a mark left by one not running, with a pack it brought, makes the cache dirty. The seen record is written to a temp file and renamed. Round 18: the guarantee on the fetch side no longer rests on the cache being clean. `upload-filter.ts` reads a fetch's lines before upload-pack does: only protocol v0's own (`want`, `shallow`, `deepen`, `deepen-since`, `deepen-not` of an advertised branch or tag, by its full name or a short one resolved as git does and passed on in full; then `have` and `done`) pass, and a `shallow` or `have` id that the cache's branches and tags don't reach (`reachedFromRefs`) is dropped, as upload-pack would treat an object it lacks; anything else ends the request with an `ERR` line the agent's git prints, recorded for the owner. A request is bounded (100k lines held, 64 MiB). Round 19: no filters at all (`uploadpack.allowFilter=false`): a partial clone's lazy fetches want objects by id, which this server never serves, so a client asking for one is told filtering isn't supported and clones whole. A push's refusal names no object (it would tell an agent which guessed content the cache held), and a throw in its checks is a refusal said and recorded. Round 20: receive-pack's input has backpressure (the agent's socket is paused while git hasn't read what it was given); the workstream fence is judged on every spelling of the requested URL and on the connection's own, and a remote two workstreams tie for is foreign to a session homed in neither; a fenced session's sandbox names only the connections it may fetch; a card for a connect is withdrawn when the agent's git goes; a remote that timed out is told as such for a minute instead of each request waiting it out; `--atomic` only with more than one branch. Round 21: no route for a `.git`-less form (git's prefix match would rewrite other repositories' URLs); the CLI never passes `--token` to a push URL's connect (it may be another host, or ssh), and says how to connect it with its own; receive-pack's input has backpressure (the socket paused while git hasn't read what it has), and once the push's hook starts (receive-pack has the whole pack) the socket is read again, so an agent's git that goes is seen while the owner is asked, and anything but the end of its input ends the request (round 22: a 16 MiB hold cut off large pushes; and every relayed chunk is copied before it is queued, on both sides; round 23: git's stdin isn't ended when the client's input ends at all, since neither service needs an EOF (a pack says where it ends; a fetch ends at `done` or a flush) and on Bun 1.3 an end right after a write can drop its last bytes, cutting a large pack short, "early EOF"; it closes when git exits. The launcher has no backpressure of its own (pausing its stdin broke large pushes on Bun 1.3): a large push's backlog may sit in the agent's own launcher process, inside its sandbox, never the daemon's. A push whose commands came but whose check never ran (git refused its pack) is recorded; an explicit `pushurl` gets the owner's insteadOf, not pushInsteadOf; the agent's prompt says fetches work when pushes are refused); a session has at most 8 connections at once; a URL the workstream rules can't read is refused to a fenced session. Known: connecting from a repository reads its `remote.<name>.pushurl` too (round 22); a connect or disconnect re-resolves every session of the owner, which says so ("directories applied"), cosmetic; a public repository whose URL extends a connected one's (`…/app.git` and `…/app.git-mirror`) is caught by git's prefix match and refused as not connected. Known: submodules don't go through the gateway (`protocol.ext.allow=user` is refused for them, which is what keeps a `.gitmodules` from naming an `ext::` command). Accepted: while the cache still holds something the remote deleted (between a deletion and the refresh that prunes it, or a gap the prune misses), a push of guessed content can tell, by being refused, that the cache holds it. The prune stays as hygiene (and for the push side, which `objectsNotSent` guards). Refresh marks are unique per refresh, marks count loose objects too (a dumb-HTTP fetch), record updates are serialized per cache and a clean judgement forgets only the ids it judged, a throw in the locked refresh is answered, and a push may carry only objects its branches use. Autonomy set at creation counts as the owner's only where the creation says so (`autonomousByOwner: true`: a loop, an autonomous routine, a fork of an owner-autonomous session); collaboration children and dispatch workers ask. Autonomous mode counts for a push only when the owner set it with an undelegated token (`#autonomousByOwner`); a dispatch worker's pushes always ask, after a restart and a re-arm too (`fleetAutonomy` in its meta). An upstream push in flight when the daemon stops is ended and recorded as of unknown outcome. Upstream transfers end when slower than 1 KB/s for a minute (https) or after four missed ssh keepalives. A disconnect bumps the cache's generation (requests granted before it are refused), stops a first clone and removes the cache in the background; temp clones a stopped daemon left are swept at start, and a queued request whose agent is gone starts no clone.

## 10. Toward a library

The gateway has three seams, each meant to be extractable:

- the **transport** (a per-session socket and a launcher);
- **adapters** (git now; forge APIs, registries and model APIs later, each with its own checks);
- **policy and decisions** (allow, deny, or ask the owner, with audit).

Once the git adapter has held up in codeoid on every backend, the core can move to its own open-source package, with codeoid as the reference integration. Agent identity (ZeroID) plugs in as the "who is asking".
