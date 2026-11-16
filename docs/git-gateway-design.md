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

  These are whole URLs, never prefixes, so they outrank an owner's shorter rewrite. The agent may unset this, but that only takes its own access away.
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
   - The decision is tied to the agent's connection. If it closes (a tool's time limit, an interrupt) or the session closes, the owner's card closes and nothing is pushed.
   - In guarded mode, the owner is asked on a card first: the branch, commit, URL and the agent's reason. A role whose network isn't `true`, or is read-only, is refused.
   - Then the hook pushes the checked commits upstream (`git push --atomic --porcelain <upstream> <new>:<ref>` with the quarantine's object env and the gateway's upstream env). The agent's push is accepted only if upstream took them. Upstream's own messages, redacted, are relayed as the hook's output.
4. **Audit:** every request, refusal, answer and result goes to the audit log and the transcript (`session.git_*`).

### 3.4 Upstream access with the owner's credentials

- Every upstream git runs with `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`, the hardened env from `git-env.ts`, and no askpass. The only config is what codeoid sets.
- **ssh:** `core.sshCommand` is the absolute system `ssh` (judged by `hostPathProblem`) with `-o BatchMode=yes -o ConnectTimeout=20`. ssh reads the owner's own `~/.ssh/config` and agent (per-host keys keep working); no sandbox can see or write those.
- **https:** at connect time, and only then, the owner's credential is read once with `git credential fill`, run from `/` with a minimal environment, so only their global and system helpers answer. It's kept in a 0600 file in the gateway's dir, which is a refused secret path for host-side file tools, together with their `http.sslCAInfo` for the URL.
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
- Cache disk use: one bare mirror per connected remote, pruned when its connection is removed.

## 10. Toward a library

The gateway has three seams, each meant to be extractable:

- the **transport** (a per-session socket and a launcher);
- **adapters** (git now; forge APIs, registries and model APIs later, each with its own checks);
- **policy and decisions** (allow, deny, or ask the owner, with audit).

Once the git adapter has held up in codeoid on every backend, the core can move to its own open-source package, with codeoid as the reference integration. Agent identity (ZeroID) plugs in as the "who is asking".
