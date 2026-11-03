# The OS sandbox (#448)

Every shell command an agent runs, on every backend that can be sandboxed,
runs inside an operating-system sandbox. The workspace and a private temp
directory are writable; everything else is read-only; credential stores are
not there at all; container runtime sockets can't be reached; the network is a
per-session setting.

The approval gate's risk levels (#431, [approvals.md](approvals.md)) read a
command's text. They are guidance: three audit rounds showed that reading bash
can't be made complete. The sandbox is the boundary — a sandboxed command
can't read a key it can't see, or delete a home directory it can't write,
however the command is spelled.

It is **on by default**, everywhere it can run.

## What is protected

With the default policy (workspace-write):

| | |
|---|---|
| **Your home: hidden whole** | the sandbox starts from an empty, read-only home. A credential that isn't on any list, one created after the session started (`aws configure`, `gh auth login`), or one a program replaces by writing a new file and renaming it over the old one, is simply not there. What is shown again, read-only: the **allowlist** `sandbox.homeReadable` (below), and what the backend itself needs (its program; its private home, below). The workspace, when it is in your home, is shown writable. |
| **Home allowlist** (`sandbox.homeReadable`, read-only) | by default toolchains and tool settings that hold no secret: `~/.bun`, `~/.cargo/bin`, `~/.cargo/registry`, `~/.cargo/git`, `~/.rustup`, `~/.nvm`, `~/.npm`, `~/.local/bin`, `~/.local/lib` (pip `--user` packages), `~/.local/share/pnpm`, `~/.local/share/uv`, `~/.local/share/pipx`, `~/.local/share/mise`, `~/.local/share/claude/versions` (the Claude installer's binaries), `~/.pyenv`, `~/go/pkg`, `~/go/bin`, `~/.gitconfig`, `~/.config/git/config`, `~/.config/git/ignore`, `~/.config/git/attributes`. Not listed, so hidden: `~/.npmrc`, `~/.bunfig.toml`, `~/.yarnrc.yml`, `~/.pypirc`, `~/.cargo/credentials.toml`, `~/.git-credentials`, `~/.config/git/credentials`, `~/.gradle`, `~/.m2` and everything else. A global npmrc inside an nvm install (`~/.nvm/versions/node/*/etc/npmrc`) and uv's credential store (`~/.local/share/uv/credentials`) are hidden again. A link inside a listed dir (`~/.local/bin/x`) works only where it leads into the list itself (a pipx or `uv tool` venv, the Claude installer's versions) or outside the home: what it leads to elsewhere in the home (a project of yours, with its `.env`) stays hidden, and the link dangles. List the target's dir in `sandbox.homeReadable` to show it. A link in the list (`~/.gitconfig` into a dotfiles repository) is shown at its own path and where it leads. A token written into `~/.gitconfig` itself (a URL carrying one, an `http.extraHeader`) would show: keep it in a credential helper. |
| **Writable** | the session's working directory (its worktree), a private temp dir made for the session (`$TMPDIR`, and the sandbox's `/tmp` under bubblewrap and Docker), and what a commit in the workspace's **git repository** writes: its git dir, a linked worktree's own git dir and its repository's (objects, refs, logs, the index, `HEAD`, `packed-refs` and the lock files beside them), wherever they are, a repository under the host's `/tmp` included. Nothing else. |
| **Read-only** | everything else on the machine. `rm -rf ~` fails with "Read-only file system". Inside the writable, **a repository's structure**: everything that decides which config, hooks or git dir git uses, since a hook, `core.hooksPath` or `core.fsmonitor` planted there (or a config git is pointed at) would run outside the sandbox at your next `git status`. That is, in the repository's git dir: `config`, `config.worktree`, `commondir`, `hooks/`, `info/`, `modules/` (a submodule's git dir carries hooks and config of its own), `remotes/`, `branches/` and `worktrees/` whole (every worktree's git dir, one added after the session started included; the workspace's own worktree git dir is writable over it); in a linked worktree's own git dir: `commondir`, `gitdir`, `config.worktree`; the worktree's `.git` file, and the `.git` file of every other worktree or submodule checked out inside the workspace. A **submodule checkout** as the workspace (its `.git` a file naming `<super>/.git/modules/<name>`, whose `core.worktree` names it back) is held the same way, its git dir being the repository's. Any other `.git` file (a `--separate-git-dir` checkout, which git's records don't name back) is held read-only, with what it names when that is inside the workspace: nothing commits from inside, and the session's sandbox limits say so. The git dirs themselves are bound at their own paths, so none can be renamed away and rebuilt (`mv .git .git-old` fails), the workspace's `.git` dir included. A plain repository at the top of the workspace gets an empty `HEAD/` dir beside its `.git`, held read-only (git doesn't see an empty dir): a `.git` made invalid (its `HEAD` garbled, `refs/` removed) would otherwise have git take the workspace's top for a bare repository planted there, with its own config. What of these isn't there yet is made first, so there is something to hold: empty `hooks/`, `info/`, `modules/`, `remotes/`, `branches/`, `worktrees/`, an empty `config.worktree` in every git dir of the repository, and a `commondir` in the repository's git dir holding `.` (git, libgit2 and gitoxide read it as that git dir itself; see Limits). An entry that would have to be held but is a link (a bind can't hold one) makes the git dir read-only whole: commits from inside then fail. And **the project settings agent CLIs run code from** (below). |
| **Project settings** (read-only) | `.claude/`, `.gemini/`, `.qwen/`, `.codex/`, `.pi/`, `.opencode/` in the workspace, whole (made empty first where missing: git doesn't see an empty dir; not in a workspace that is your home or holds it, a temp root or `/`, where they would be the CLIs' own config dirs: there only those that exist are held), and `.mcp.json`, `opencode.json`, `opencode.jsonc` at its top, made first where missing (in the same places) holding an empty config (`{"mcpServers":{}}`, `{}`: what the CLIs read as none; your own `opencode` loads a project `opencode.json`'s MCP servers and plugins at its start) and, in a git repository, listed in its `.git/info/exclude` so `git status` and `git add -A` don't see them (an existing file is held as it is). A Claude hook, an MCP server, a pi or opencode plugin written there by one backend's command would run on the host in a later session of another, or in your own CLI. Changing them needs the sandbox lifted for that command: Claude's `dangerouslyDisableSandbox` and Codex's permission request are asked about in every mode (below); on other backends edit them yourself, or turn the session's sandbox off. A file tool that runs in the backend's own process, outside the sandbox (Claude's Write, Edit, MultiEdit and NotebookEdit, opencode's write, edit and patch, every backend's file tools), writing there **or into the repository's git structure** (anything in its git dir or a linked worktree's, the `.git` file, another checkout's `.git` file in the workspace) is asked about in every mode while the sandbox is on, autonomous included, the card saying why (audited `session.project_settings_write_ask` / `session.git_structure_write_ask`); on Claude the PreToolUse hook routes it to the gate past any allow rule. |
| **Hidden besides** (not readable at all) | outside the home, or in a workspace that holds it: codeoid's config dir (`~/.codeoid`: keys, accounts, endpoints, the local token) and every data dir it owns wherever it is configured (the database, transcripts and checkpoints, opencode's database and data dirs, memory's; their lock files); the agent CLIs' logins (`~/.claude/.credentials.json`, `~/.codex/auth.json`, `~/.qwen/oauth_creds.json`, `~/.gemini/oauth_creds.json` …, pi's `auth.json`) and what backends registered as credentials (opencode's key files); `~/.ssh`, `~/.aws`, `~/.azure`, `~/.config/gcloud`, `~/.kube`, `~/.docker`, `~/.gnupg`, `~/.config/gh`, `~/.config/hub`, `~/.config/glab-cli`, `~/.netrc`, `~/.git-credentials`, `~/.config/git/credentials`, `~/.local/share/keyrings`, `~/.password-store`, `~/.config/op`, `~/.vault-token`, `~/.pypirc`, `~/.cargo/credentials(.toml)`, `~/.terraform.d/credentials.tfrc.json`, `~/.claude.json` (MCP tokens), `~/.local/share/opencode/auth.json` and `mcp-auth.json`, `~/.config/github-copilot`, `~/.pgpass`, `~/.config/rclone`, `~/.s3cfg`, `~/.boto`, `~/.pulumi/credentials.json`, `~/.config/doctl`, `~/.fly`, `~/.npmrc`, `~/.bunfig.toml`, `~/.yarnrc.yml`, `~/.gradle/gradle.properties`, `~/.m2/settings.xml`, `~/Library/Keychains`; the desktop session's runtime dir (`$XDG_RUNTIME_DIR`: keyring, D-Bus, agent sockets) and `$SSH_AUTH_SOCK`'s dir; the daemon's own temp dir when it isn't `/tmp`, and always the daemon's private dir in it (`codeoid-sandbox-*`, made at its start, 0700), where it makes every temp entry of its own: sign-in homes, a check's artifacts, a loop's index, pi's bridge, the sessions' temp dirs and launchers — so one made while a session runs is hidden from it too, on Claude's own sandbox (which keeps the host's `/tmp`) as well; plus `sandbox.hiddenPaths` (which also beats the allowlist). |
| **The daemon's own git** | every git codeoid runs in a repository an agent can write (a fork's worktree made and removed, a destroyed session's work snapshotted, a worktree's setup, the branch and status the UI shows, loops) runs nothing that repository's config names, sandbox or not: no hook (the hooks dir's or one defined in config, `hook.<name>.command`), fsmonitor, alternates' ref command (`core.alternateRefsCommand`), external diff, signing or signature check (gpg's and ssh's programs, `gpg.ssh.defaultKeyCommand`), editor or pager, git-protocol proxy or auto gc, `core.sshCommand` is `ssh`, and every filter, diff or merge driver and credential helper defined in the repository's own config (local or worktree, includes too) is reset, your own global or system definition put back (git lfs installed globally keeps working; a repository redefining it doesn't). Reaching a remote (a base branch fetched for a fork, a partial clone's objects) is https or ssh only. Loops' repositories are stricter still: every driver off, no system config. Checkpoints run in codeoid's own shadow repository, whose config is codeoid's. |
| **Never reachable** | container runtime sockets: `/run/docker.sock`, `/var/run/docker.sock`, containerd, podman, CRI-O, buildkit, k3s, the user's rootless sockets, Docker Desktop / Colima / Lima / Rancher / OrbStack, `$DOCKER_HOST`. A container socket is root on the machine. |
| **Toolchain caches** | the home is read-only, so the caches are pointed at the sandbox's own cache dir, `${XDG_CACHE_HOME:-~/.cache}/codeoid-sandbox` (one per user, writable inside, read by none of your own tools): `XDG_CACHE_HOME` (pip, uv, Go's build cache and what else follows XDG), `GOCACHE`, `GOMODCACHE`, `BUN_INSTALL_CACHE_DIR`, `npm_config_cache`, `UV_CACHE_DIR`, `PIP_CACHE_DIR`, `CARGO_HOME` (cargo's registry cache; your `~/.cargo/config.toml` is still read from above a workspace in your home, not from `CARGO_HOME`). Go modules you already downloaded are read from your own module cache first, as a file proxy (`GOPROXY=file://~/go/pkg/mod/cache/download,<yours>`), so `go build` works with the network off. `go build`/`go test`, `bun install`, `npm install`, `uv` and `pip` work inside. The sandboxed sessions share this dir: what one downloads or builds, another reuses (and could have tampered with: a build cache is trust among your sandboxed sessions). A cache is code to the toolchain that reads it (`CARGO_HOME`'s `config.toml` and `bin/`, a module in `GOMODCACHE`, an install in npx's cache), so **these variables are set only for what runs inside a sandbox**, never for anything outside one: on Claude's own sandbox they aren't in the CLI's environment (nor, so, its MCP servers', its hooks', or a command you let run outside the sandbox); the CLI sources a file of codeoid's (`CLAUDE_ENV_FILE`, in the CLI's own temp dir) into each command, which sets them only where the CLI marks the command as sandboxed (`SANDBOX_RUNTIME=1`). |
| **Environment** | `SSH_AUTH_SOCK`, `SSH_AGENT_PID`, `GPG_AGENT_INFO`, `DBUS_SESSION_BUS_ADDRESS`, `DOCKER_HOST`, `CONTAINER_HOST`, `KUBECONFIG` are unset inside. On Claude, every credential-named variable the CLI runs with is denied to its commands. |
| **Network** | `on` (default), `off`, or `allowlist` (hosts in `sandbox.allowedHosts`), per session and in config. |
| **Processes** | no new privileges; under bubblewrap a pid namespace (the sandbox sees only its own processes, so not the daemon's or the CLI's environment) and processes die with the sandbox they run in (see Limits for opencode). |
| **Hidden stays hidden** | every directory between the workspace and a hidden path inside it (a workspace of `/home` holding your home, a `sandbox.hiddenPaths` entry inside the project) is pinned: it can't be renamed or removed, so the hidden path can't be moved out from under its rule; what is in it stays writable (on Claude's own sandbox the whole dir is read-only: see Limits). The daemon's own sandbox dir (each session's temp dir, private homes, the launchers, sign-in homes) is hidden from every session, a session whose workspace is `/tmp` included. |
| **Loop checks** | a loop's acceptance checks judge agent-written code, so they run in the loop's sandbox too (the check's checkout writable, credentials hidden), recorded `isolation: "sandbox"`; one whose sandbox can't run is an `error`, not a pass. |

A workspace of `/` can't be sandboxed (the whole filesystem would be writable,
the sandbox's own `/proc`, `/dev` and `/tmp` covered): such a session is "not
sandboxed" (interactive runs and says so, unattended is refused), and a check
there is refused.

A command that needs more fails inside the sandbox and the agent sees why
(`Read-only file system`, `No such file or directory`, a refused connection;
Claude adds a `<sandbox_violations>` note). Running one command outside the
sandbox is its own approval, asked in every mode (see below).

## Choosing a sandbox

`sandbox.provider` (config, `CODEOID_SANDBOX`, the **Sandbox** tab in the web
UI's settings and `/settings`) is the default for new sessions:

| Value | |
|---|---|
| `auto` (default) | bubblewrap on Linux, Seatbelt on macOS |
| `bwrap` | [bubblewrap](https://github.com/containers/bubblewrap) (Linux; `apt install bubblewrap`). Claude Code's own sandbox also needs `socat` (`apt install socat`); without it a Claude session is "not sandboxed", with that reason. |
| `seatbelt` | macOS `sandbox-exec` |
| `docker` | a container of `sandbox.docker.image` (default `node:22-bookworm-slim`; it must carry what the backend runs). `sandbox.docker.runtime: runsc` runs it on gVisor, a separate kernel. Never chosen by `auto`. |
| `off` | no sandbox: commands run with your full rights |

`sandbox.network` (`CODEOID_SANDBOX_NETWORK`): `on` | `off` | `allowlist`,
with `sandbox.allowedHosts` (`CODEOID_SANDBOX_ALLOWED_HOSTS`, `example.com`,
`*.example.com`, `localhost`; anything else fails the config's load).
`sandbox.hiddenPaths` (`CODEOID_SANDBOX_HIDDEN_PATHS`) adds paths to hide (`~`
expands). `sandbox.homeReadable` (`CODEOID_SANDBOX_HOME_READABLE`, comma
separated) replaces the home allowlist: add what your tools need that holds no
secret (`~/.volta`, `~/.sdkman/candidates`, `~/.config/starship.toml`), never a
file with a token. `sandbox.bwrapPath` picks the bwrap binary.

Changing any `sandbox.*` setting daemon-wide (`settings.set`, the Sandbox tab)
needs `settings:write` from an undelegated token, and is audited old → new
(`settings.set.sandbox`; a refusal `settings.set.denied`).

Per session:

- at creation: `codeoid new <name> <dir> --sandbox bwrap|seatbelt|docker|auto|off [--network on|off|allowlist] [--allow-host h …]`,
  the web UI's new-session dialog ("Sandbox: the daemon's default. change"), or
  `session.create`'s `sandbox: { provider?, network?, allowedHosts? }`;
- later, by the session's owner: `codeoid sandbox set <session> <provider> [--network …]`,
  `/sandbox <auto|off|id> [on|off|allow:host,…]`, or `session.set_sandbox`.
  A change is made only while the session is idle: no turn running, no
  approval or dialog waiting, no background work (a dev server, a subagent).
  Otherwise it is refused, saying why ("the session is busy", "has background
  work running") — what runs must match what the session reports, and a
  backend running in the old sandbox is restarted to take the new one, never
  in the middle of work. Narrowing (on, the network off) is applied without
  asking. **Widening — turning it off, a wider network, another provider — is
  a confirm shown on the session, answered only by its owner with their own
  token (another member's or a delegated token's answer is refused, audited
  `session.ui_response_refused`), in every mode, and audited**
  (`session.sandbox_widen_ask`, `…_denied`, `session.set_sandbox` naming who
  confirmed); it never lands on an unattended turn, a delegated token can't ask
  for it, and one answered after the session got busy isn't applied (it says
  so). Once applied, a backend process that ran (Claude, Codex, pi, the Gemini
  CLI, Qwen) is stopped at once and starts in the new sandbox with the next
  message; until it has been, a turn that needs the sandbox is refused
  (opencode takes it at its next turn, Claude native at its next query).
- **The same authority for a wider sandbox anywhere**: creating a session (or
  starting a loop) whose sandbox is off or wider than the daemon's default —
  `off`, a wider network, another provider, hosts the default doesn't allow —
  needs `session:approve` and an undelegated token (audited
  `session.sandbox_wider_refused` when refused). A fork or a compare of a
  session with such a sandbox is made only by its owner, undelegated (anyone
  in the tenant may fork one whose sandbox is the daemon's or narrower). A
  session whose sandbox is off is switched to autonomous only by its owner's
  own token. A routine whose runs' sandbox is off or wider than the daemon's
  (the same rule) needs `session:approve` (routine changes are refused to
  delegated tokens). A provider named explicitly that
  can't run here is refused (choose another, or `off`);
- routines (`codeoid routine add … --sandbox …`, the spec's `sandbox`) and loops
  (`codeoid loop start … --sandbox …`, `loop.start`'s `sandbox`) take one too.
- A fork, and a collaboration's children, keep their parent's setting (a
  collaboration's lead is created by the same request, under the rule above).

`codeoid sandbox providers` (`sandbox.providers`) lists what the daemon has and
whether each runs here, and why not.

## When it can't run

Where the chosen sandbox can't run — bubblewrap missing, unprivileged user
namespaces forbidden, Claude Code's own sandbox without `socat` on Linux (its
network proxy's bridge: without it the CLI would refuse every query, so the
session says "not sandboxed: Claude Code's sandbox needs socat on Linux …"
instead), a workspace of `/`, a backend that provider can't hold — or can't enforce
what was asked (a backend that must keep the network to reach its model, with
the network asked off):

- **autonomous sessions, routines, loops, dispatch workers refuse to start**:
  `session.set_mode autonomous` is refused, a loop start is refused, an
  autonomous or unattended turn fails before anything is recorded
  (`Not started: not sandboxed: <why>`, audited `session.sandbox_refused`), and
  an autonomous session can't be switched to such a backend;
- **interactive sessions run**, and say so plainly: the session header's chip
  ("not sandboxed", amber, with the reason), `codeoid ls`, and **every approval
  card** ("⚠️ not sandboxed: bubblewrap (bwrap) is not installed").

A sandbox the owner turned `off` is their choice: such a session runs in every
mode, and every card says "not sandboxed: the sandbox is off".

An allowlist a provider can't enforce by host runs with the network **off**
(narrowed, never widened) and the session says so; the network stays **on**
only for a backend that needs it to reach its model, and then the session is
not `enforced` and nothing unattended starts on it.

## Per backend

How a backend is put inside is the backend's (`src/daemon/sandbox/confinement.ts`):

| Backend | bubblewrap (Linux) | Seatbelt (macOS) | Docker |
|---|---|---|---|
| **Claude** | Claude Code's own sandbox with codeoid's policy (Agent SDK `sandbox`): commands only; network on/off/**allowlist** via its proxy | the same, on Seatbelt | the whole CLI in the container (`spawnClaudeCodeProcess`); network on only |
| **Codex** | codex's own `workspace-write` (the workspace, `/tmp`, the repository's git dirs and the sandbox's cache dir writable, network per session) **inside** codeoid's bubblewrap around the app-server, which holds the repository's structure read-only; network on/off | the whole app-server under Seatbelt, full access inside it (Seatbelt doesn't nest); network on only | the whole app-server in the container; network on only |
| **opencode** | each shell line in the session's bubblewrap (the shared server's `SHELL` is codeoid's shim); network on/off | each line under Seatbelt | each line in its own container |
| **pi, Gemini CLI, Qwen Code** | the whole process inside; network on only | the same | the same |
| **OpenAI, Gemini API, llama.cpp, `oai:*` endpoints** | run no commands: "no shell", never refused | | |

What each leaves open:

- **Claude (native)**: its file tools (Read, Edit, Write, Grep, Glob) run in the
  CLI, outside the sandbox — codeoid's gate judges them (credential paths are
  refused, writes outside the workspace ask in autonomous mode, a write to
  `.claude/settings*.json` or any other project setting above asks in every
  mode: a hook or an excluded command there would run outside the sandbox).
  Its commands can't write the project's `.claude/` or the user's Claude
  config dir at all. The home is denied whole
  (`denyRead`) and the allowlist allowed back (`allowRead`); verified with the
  real CLI that it enforces it as a fresh home, so a credential made or
  replaced while a command runs stays hidden. The CLI's own login and key are
  not visible to its commands (its credentials file is denied, its key
  variables are denied to commands, and it has its own pid namespace). Its
  `TMPDIR` is a dir of the session's whose `claude-<uid>` (where it points its
  commands' `TMPDIR`) is the commands' only writable temp dir, and its own
  transient files (its settings file, sockets) are under
  `CLAUDE_CODE_TMPDIR`, another dir of the session's, out of the commands'
  reach: no session shares a temp dir with another or with your own Claude
  Code. Every path is handed to the CLI physically resolved (its bubblewrap
  can't mount through a linked dir such as `/var/run`). Network `on` means
  hosts the CLI's proxy asks about are allowed by codeoid's gate
  (`SandboxNetworkAccess`). Hooks and MCP servers already in the project's
  settings run in the CLI, outside the sandbox, as they always did (#395
  approves a project's MCP servers).
- **Codex (bubblewrap)**: the app-server runs in a private copy of its home
  (below): its `auth.json` (a private copy) stays readable by its commands
  (codex's sandbox doesn't hide reads), and nothing of the real `CODEX_HOME`
  can be written (a refreshed login is written back by the daemon, below). Everything else is hidden by codeoid's
  bubblewrap. The network `off` is codex's own sandbox's (codeoid's bubblewrap
  keeps it on for the app-server): in guarded or interactive mode, a command
  codex asks to rerun outside its sandbox arrives as an ordinary command
  approval and, approved, runs with the network inside codeoid's bubblewrap
  (in autonomous mode codex asks nothing and nothing leaves its sandbox).
- **Process backends (pi, the Gemini CLI, Qwen; Claude and Codex under Docker,
  Codex under Seatbelt)**: the backend runs in a **private copy of its home**,
  made afresh at each start (`src/daemon/sandbox/backend-home.ts`) and pointed
  at by the variable it reads (`PI_CODING_AGENT_DIR`, `GEMINI_CLI_HOME`,
  `QWEN_HOME`, `CODEX_HOME`, `CLAUDE_CONFIG_DIR`): its login a private copy
  (the credential file it refreshes; its other login files, an `.env` or an
  account list, linked read-only), its conversations (`sessions/`, `projects/`, the Gemini CLI's
  `tmp/` and `history/`, Qwen's `tmp/`) the **session's own**, kept in
  `<transcriptDir>/sandbox-state/<session>/<backend>/` across restarts and
  removed when the session is destroyed — never the real dirs, which hold
  every project's transcripts and what later runs load (Claude's project
  memory, the Gemini CLI's checkpoint repository, whose git config and hooks
  run), so a sandboxed session reads no other session's or project's, and
  writes nothing an unsandboxed run loads. The code it loads (plugins,
  extensions, skills, commands) is shown read-only, its other small files
  (settings, model lists) copied, its other dirs empty.
  Nothing its commands write there (a hook, an MCP server, an extension,
  `config.toml`) reaches the real home, where your own CLI, or a session with
  the sandbox off, would run it. Its login is readable by its commands, the
  API key in its environment is visible to them (`env`, `/proc/<backend>/environ`
  in the same sandbox), and they have the network (the backend needs it).
  **A login the backend refreshes** (an OAuth token, whose refresh token the
  provider may rotate) is saved to its private copy, however the CLI writes
  it, and written back to the real file by the daemon when the backend's
  process ends (or its query is replaced): only that file (Claude's
  `.credentials.json`, Codex's and pi's `auth.json`, the Gemini CLI's and
  Qwen's `oauth_creds.json`), and of it **only the token fields a refresh
  writes** (the access and refresh tokens, their expiry and scope; pi's only
  in its `oauth` entries), put into the real file's own content. A copy
  changed anywhere else is not written back, your real login is kept, and the
  session says so: an entry added or removed, an api key (pi runs one that
  starts with `!` as a command), an account id, a URL a token is sent to
  (Qwen's `resource_url`, an MCP server's `serverUrl`), or a token field
  holding anything but a plain token. Only when the real file is still what
  was copied (your own CLI's refresh meanwhile isn't overwritten),
  atomically (a temp file renamed over it). A command can still put another
  account's tokens of the same backend in those fields, which would then be
  written back: the token was already readable to it. Not verified with the real vendor CLIs here
  (no network): a fake that rotates its refresh token, saving it in place
  and by a rename, is.
- **Conversations across a sandbox change.** A process backend's native
  conversation lives in the session's own dir while sandboxed and in your real
  home while not: switching a session's sandbox off or on, a fork, and a
  backend switch continue from codeoid's own history (the transcript seed),
  not the backend's native copy. A session that ran sandboxed under an
  earlier build kept its conversation in the real dir; it resumes from
  codeoid's history the same way.
- **opencode**: its file tools run in its shared server, outside the sandbox,
  under codeoid's gate. A subagent created in a feed gap, before codeoid set its
  shell environment, runs nothing.
- **MCP servers** a backend mounts (stdio servers from config, a project's
  `.mcp.json`) and the workdir's own hooks run as the backend starts them:
  inside the sandbox for process backends, outside it for Claude (native),
  Codex's own MCP servers inside codeoid's bubblewrap.
- A backend installed under the home (an npm-global `pi`, a CLI whose `#!`
  names `node` from nvm) is shown read-only inside: its dir, the package it
  belongs to, and its interpreter's install (`programLocations`), never the
  home itself.

## Running one command outside the sandbox

- **Claude**: `allowUnsandboxedCommands` is on, so the model may retry a command
  with `dangerouslyDisableSandbox: true`. Codeoid's PreToolUse hook sends it to
  the gate past any allow rule, and the gate **asks in every mode** (no
  autonomous budget spent; an unattended run parks on it), audited
  `session.unsandboxed_ask` / `session.unsandboxed_approve`. The card says
  "asks to run outside the sandbox". Verified against the real CLI: approved, it
  runs with your full rights; denied, it never runs.
- **Codex**: a request to widen its sandbox (`item/permissions/requestApproval`,
  `codex_permissions`) is asked the same way. (In autonomous mode codex asks
  nothing, #442: its sandbox is the boundary.) Under codeoid's bubblewrap a
  command codex runs unsandboxed is still inside codeoid's.

## Approval cards

Every card carries `sandboxed` and `sandboxNote` (web, TUI/CLI, Telegram,
`session.approvals`): "🛡 sandboxed: bubblewrap, network on", "⚠️ runs in the
backend's own process, outside the sandbox" (a Claude or opencode file tool),
"⚠️ not sandboxed: …", "⚠️ asks to run outside the sandbox". The risk level is
still shown: inside the sandbox it is guidance about what the command would do
to the workspace.

## Limits

- **Network `on` shares the host's network.** A sandboxed command can reach
  services listening on localhost (they still need their own credentials:
  codeoid's port needs a token, which is hidden) and, under bubblewrap and
  Seatbelt, abstract Unix sockets (an X11 or D-Bus abstract address). With the
  network `off` under bubblewrap it has its own loopback and none of these.
- **Allowlists** are enforced by Claude's sandbox only (its proxy). bubblewrap,
  Seatbelt and Docker run an allowlist with the network off.
- **Seatbelt has no pid namespace**: a sandboxed command can list other
  processes (verify on a Mac whether it can read their environment, below).
  And its profile allows by default what it doesn't name: the keychain service
  (`securityd`) stays reachable, so `~/Library/Keychains` being unreadable
  doesn't stop the Security framework (`git credential-osxkeychain`) from
  handing out items a prompt-free ACL allows.
- **A routine's gate check** (`--check`) runs your command as before, outside
  the sandbox: gates usually need your credentials (`gh run list`). So do a
  pipeline gate's probes (the project's build, test and lint commands). If it runs a
  script from the workdir, an earlier run's agent may have changed it — keep the
  gate to commands you trust, or run with `--worktree`.
- Credentials in **project files** (`.env` in the workspace) are the workspace's:
  add them to `sandbox.hiddenPaths` or keep them out of the workdir. A
  workspace that is your home itself shows the home (the hidden list still
  applies in it); one that holds it (`/home`) hides it.
- **The home is read-only and mostly empty inside.** The usual caches are
  pointed at the sandbox's cache dir (above); a tool that writes other state in
  the home fails there (`pip install --user`, `go install` into `~/go/bin`,
  `cargo install`): use a virtualenv or the workspace, or run it yourself. A
  tool installed elsewhere in the home (`~/.volta`, `~/.sdkman`) needs adding to
  `sandbox.homeReadable`. Under bubblewrap the home's tmpfs is read-only too.
- **Within a dir that is shown** (the workspace, an allowlisted dir), a hidden
  file is still laid over at the start (bubblewrap, Docker): replaced by a
  rename, or created later there, it shows to a sandbox already running. The
  home's own files can't do that (the home isn't shown).
- **Git**: with a repository's structure read-only, `git config …` (writing
  the repository's config), installing a hook, `git submodule update --init`,
  `git worktree add`/`remove`, `git sparse-checkout` and editing
  `.git/info/exclude` fail inside; run them yourself. A repository whose `.git`
  names a git dir git's own records don't name back (`--separate-git-dir`)
  is read-only inside: commits there fail. The placeholders (`commondir`
  holding `.`, the empty `remotes/`, `branches/`, `worktrees/` in the git
  dir, the empty `HEAD/` at the top of the workspace) are what let bubblewrap
  and Docker hold these read-only (a mount needs something to mount on, and a
  git dir must stay writable for git's lock files); they stay after the
  session (`git worktree prune` removes an empty `worktrees/`; it is made
  again). A `.git` that is a symlink can't be held. A top-level `HEAD` that
  is already a file or a non-empty dir of the project isn't held (on a
  case-insensitive disk, a `head` too). On Claude's own sandbox, whose
  `denyWrite` wins over `allowWrite` wherever they overlap, a linked
  worktree's `worktrees/` is held entry by entry around its own git dir, so a
  worktree added while its query runs isn't held there (the end-of-session
  check below sees its `commondir` change); a plain repository's
  `worktrees/` is held whole there too. Not held,
  because they are the workspace's own content: a repository planted in a
  subdirectory of the workspace (a `.git` made in a directory that had none,
  an uninitialised submodule's path included) is used by your git there, and
  by your `git status` in the superproject for a submodule path. A rebase or
  cherry-pick in progress (`rebase-merge/`, `sequencer/`) can carry `exec`
  lines written inside: look before `git rebase --continue` on a state you
  didn't start.
- **Claude's own sandbox** puts placeholder files in the workspace while a
  command runs (`.bashrc`, `.gitconfig`, `.gitmodules`, `.idea`, `.mcp.json`
  …, its mandatory denies), so `git add -A` / `git add .` fails there
  ("can only add regular files"): add paths explicitly. They don't persist; no
  CLI setting turns them off (checked on Agent SDK 0.3.281). Its `denyWrite`
  takes a whole subtree, so a pinned dir (between the workspace and a hidden
  path in it) is read-only with everything in it, not only unrenamable as
  under bubblewrap, Seatbelt and Docker. Its commands' `/tmp` is the host's,
  read-only (`$TMPDIR` is theirs): codeoid's own entries there are hidden
  (above), but other programs' files in the host's `/tmp` (a Kerberos ticket
  cache at `/tmp/krb5cc_<uid>`) are readable; add them to
  `sandbox.hiddenPaths`.
- **opencode under bubblewrap: a background job dies with its line.** Each
  shell line runs in its own sandbox, and what it leaves running in the
  background (`npm run dev &`, `nohup … &`) is ended when the line ends (the
  sandbox's pid namespace goes with its first process). Run a long-lived
  server as its own call that keeps running (opencode's background shell), or
  from a backend that runs a whole process inside (decided for this round:
  documented, not changed; keeping one sandbox per session alive and entering
  it per line needs `nsenter` into an unprivileged user namespace, left for a
  later change).
- A sandbox session's private temp dir lives under the daemon's temp dir; one
  left by a daemon that was killed outright stays until the OS cleans it.

## Verified here, and what isn't

On Linux with real bubblewrap 0.6.1 (these run in `bun run test` where bwrap
works, and skip where it doesn't):

- `src/tests/sandbox-bwrap-real.test.ts`: a planted credential (in a hidden dir
  and in a fake home's `~/.ssh`, `~/.aws`, `~/.netrc`, `~/.codeoid`) is
  unreadable; `rm -rf` of a planted dir outside the workspace fails ("Read-only
  file system") and it survives; the workspace and the private `/tmp` are
  writable; with the network off a server on the host's loopback can't be
  reached (on: it can); a planted listening socket named as a container socket
  can't be connected to, even with the network on; the daemon's processes aren't
  in the sandbox's `/proc`; closing the handle ends what runs inside. With the
  workspace a fake home: renaming `~/.config` (or `~/.config/gh`) away fails and
  the planted token stays hidden in the next sandbox; with the workspace `/tmp`,
  another session's launcher is neither listed nor writable; a loop check
  reading a planted credential runs sandboxed and gets nothing.
- `src/tests/sandbox-claude-real.test.ts`: the Agent SDK's real CLI, driven by a
  localhost stand-in for the Messages API (no model): with codeoid's policy a
  planted credential is unreadable, `rm -rf` outside fails, the workspace and
  temp dir are writable, `ANTHROPIC_API_KEY` is empty in the command, network
  off is refused by its proxy, and a `dangerouslyDisableSandbox` retry reaches
  the gate and, denied, never runs. (Manually also: network on reaches a host;
  the command sees 5 processes and no environment carrying the key; a command
  can't create `.claude/settings.json` in the workspace.)
- `src/tests/sandbox-codex.test.ts`: the app-server started inside real
  bubblewrap can't read a planted credential and can read its own home; codex's
  own sandbox (0.166) works nested inside codeoid's bubblewrap; with the real
  `codex sandbox` and the writable roots codeoid gives it, nested in real
  bubblewrap, a plain repository and a linked worktree commit while
  `.git/config`, `core.fsmonitor` and renaming `.git` are refused.
- `src/tests/sandbox-process-backends.test.ts`: pi's and the Gemini CLI's
  processes (fake agents) inside real bubblewrap can't read a planted credential
  and can read their own login; Qwen Code's real bundled CLI starts through its
  launcher inside bubblewrap.
- Round 1 of the audit, real bubblewrap (`sandbox-bwrap-real.test.ts`, "round
  1"): with a fake home holding planted credentials on no list
  (`~/.local/share/opencode/auth.json`, `~/.pgpass`, `~/.npmrc`, copilot's,
  an unlisted file), none is readable, nor one the host replaces by a rename
  or creates (`~/.aws/credentials`) while the sandbox runs; the allowlisted
  `~/.gitconfig` and a tool in `~/.bun/bin` are there; the home is read-only.
  A linked worktree (its repository under the home, and under the host's
  `/tmp`) commits from inside with git saying nothing went wrong, while its
  repository's hooks and config can't be written; a plain repository the
  same; a forged `.git` file naming `~/.ssh` gets nothing. A file inside a
  pinned dir is writable while the dir can't be renamed. pi's, the Gemini
  CLI's and codex's processes can read their login but can't write it, their
  real settings, or their real home (`sandbox-process-backends`,
  `sandbox-codex`).
- Round 1, the real Claude CLI (`sandbox-claude-real.test.ts`): with codeoid's
  own spec for a fake home, a credential on no list, one replaced by a rename
  and one created while the command runs are all unreadable; the allowlist is
  there; `$TMPDIR` is the session's `claude-<uid>` and the CLI's own temp dir
  can't be written; a linked worktree commits and its repository's hooks stay
  read-only. Container sockets behind a linked dir (`/var/run`) are handed
  physically (before, the CLI's bubblewrap failed every command where
  `/var/run/docker.sock` existed).
- Round 2 of the audit, real bubblewrap (`sandbox-bwrap-real.test.ts`, "round
  2 (git)"): each way of changing which config the user's next git reads is
  refused — the worktree's `.git` file pointed at a git dir built in the
  workspace (A), its own or another worktree's `commondir` rewritten (B), a
  plain repository's `.git` renamed and rebuilt (C), a `config.worktree`
  planted where the config turns it on (D), a `commondir` made in the
  repository's git dir (E) — and afterwards your `git status` (run outside
  the session's sandbox) runs nothing planted; commits, branches and a branch
  deletion still work from inside, in a plain repository and a worktree.
- Round 2, toolchain caches (real bubblewrap, network off): `go build` of a
  module depending on one in the user's own module cache works, the module
  extracted into the sandbox's cache, never the user's; `bun install` of a
  local dependency works with bun's own cache in the home read-only.
- Round 2, the real Claude CLI: a sign-in home the daemon makes while the
  session runs (in its private dir) is unreadable and unlisted in Claude's own
  sandbox; one in the host's `/tmp`, as sign-ins were made before, was read.
- Round 2, conversations (real bubblewrap): pi can't read another project's
  transcript in the real `sessions/`, the Gemini CLI can't read the real
  checkpoint repository's config, and what each writes there lands in the
  session's own state, which is there again after a restart and gone with the
  session. (The bundled Gemini CLI 0.50.0 runs ripgrep from its own package
  or a trusted system path, not from `~/.gemini/tmp/bin`.)
- `src/tests/provider-opencode.integration.test.ts` I69 (real opencode 2.2.5,
  scripted local model, `CODEOID_OPENCODE_INTEGRATION=1`): a session's shell
  lines run inside its bubblewrap; a session whose sandbox is off runs bash as
  before.

**To verify on a real Mac** (Seatbelt; profile generation is unit-tested only):

1. `sandbox-exec` loads the generated profile (`(param "Pn")` inside `subpath`
   and `literal`, the device regexes, `(remote unix-socket (path-literal …))`).
2. A command can't read a hidden dir or file, can't write outside the
   workspace and temp dir, can write in both; `TMPDIR` is the session's.
3. Network off denies TCP and DNS; an allowlist runs with the network off.
4. Connecting to `/var/run/docker.sock` (Docker Desktop's link included) fails.
5. Whether a sandboxed command can read another process's environment
   (`ps eww`, `sysctl KERN_PROCARGS2`); if it can, add a `process-info` denial.
   Likewise whether it can get keychain items (`security find-generic-password`,
   `git credential-osxkeychain get`); if so, deny the `securityd` mach lookup.
   And that `mv` of a pinned dir (`pinned`, a `literal` write denial) is
   refused while a file inside it can still be written; that the home denial
   with the allowlist allowed back (`subpath` deny, then `literal`/`subpath`
   allows) leaves the workspace in the home usable.
6. Claude's native Seatbelt sandbox with codeoid's settings (the
   `sandbox-claude-real` probe with Seatbelt).
7. Codex's app-server, pi, the Gemini CLI and Qwen launched under `sandbox-exec`
   (node writes caches under `~/Library`: add writable state if they fail).
8. opencode's shell shim through a Seatbelt launcher.

**Docker** (no Docker daemon was reachable here): `CODEOID_TEST_DOCKER=1 bun test
src/tests/sandbox-docker.test.ts` runs the container checks. Also to check: the
Claude CLI in the default image (it needs glibc), codex's app-server in a
container, opencode's per-line latency, and a rootless Docker's `DOCKER_HOST`
reaching the client from a launcher (opencode, Qwen).

## How it is built

- `src/daemon/sandbox/types.ts` — the `SandboxProvider` contract;
  [sandbox-providers.md](sandbox-providers.md) describes it and how to add one.
- `registry.ts` — `auto | off | <id>`, cached probes.
- `policy.ts` — the hidden home and its allowlist (`home-readable.ts`), the
  hidden-path list, the workspace's git repository, and the spec.
- `backend-home.ts` — a process backend's private home.
- `bwrap.ts`, `seatbelt.ts`, `docker.ts` — the providers.
- `confinement.ts` — per (backend, provider), how it is put inside.
- `session-sandbox.ts` — a session's setting, resolution, temp dir, handles and
  launchers; `claude-native.ts` — the Agent SDK option.
