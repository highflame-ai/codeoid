# The OS sandbox (#448)

Every shell command an agent runs, on every backend that can be sandboxed,
runs inside an operating-system sandbox. The workspace and a private temp
directory are writable (and, so an agent can branch in a worktree of its own,
the session's own [worktree folder](#git-worktrees-inside-the-sandbox));
the session's [project roots](#working-across-repositories) (by default the
parent of its repository: the repositories beside it) are readable, and the
directories it was [given](#added-directories-other-repositories-writable)
writable; everything else is read-only; credential stores are not there at all;
container runtime sockets can't be reached unless the owner turns on
[Docker access](#docker-access); the network is a per-session setting.

The approval gate's risk levels (#431, [approvals.md](approvals.md)) read a
command's text. They are guidance: three audit rounds showed that reading bash
can't be made complete. The sandbox is the boundary — a sandboxed command
can't read a key it can't see, or delete a home directory it can't write,
however the command is spelled.

It is **on by default**, everywhere it can run.

**Autonomous mode relies on it and never waits on a person**
([approvals.md](approvals.md#autonomous-mode)): there a command of any risk
level runs, while what the sandbox can't be left to hold — a command asking
to run outside it, a file tool writing the repository's git dir — is refused
at once with its reason. File tools that run outside the sandbox, in the
backend's own process (Claude's, opencode's), are held to the sandbox's own
policy at codeoid's gate there; guarded and interactive mode ask about them as
without a sandbox ([below](#file-tools-that-run-outside-the-sandbox)). That is why an autonomous session, routine, loop or dispatched worker
doesn't start without a sandbox that runs (below).

## What it guarantees, and what it doesn't

The sandbox's hard guarantees, on every provider that runs here:

1. **Credentials and the hidden home are unreadable** inside it.
2. **Nothing outside the workspace, the session's temp dir and codeoid's
   sandbox caches is writable** (plus, for a backend whose whole process is
   inside, its private home).
3. **Nothing a sandboxed command writes is run outside a sandbox by codeoid
   itself, by a backend CLI, or by anything codeoid starts**: not the
   toolchain caches (their variables are set only inside), not a backend's
   login written back (only its token fields), not the daemon's own git
   (every program a repository's config names is turned off), not the git a
   backend CLI runs for itself outside the sandbox (its `git` is codeoid's
   shim: [A backend CLI's own git](#a-backend-clis-own-git)).

It does **not** guarantee that the workspace is safe to run after the agent
touched it. The workspace is the agent's output, and it is code:
`package.json` scripts, a Makefile, test files, husky hooks kept in the tree
(`core.hooksPath=.husky/_`), a build plugin. Review it as you review any
agent's output before you run it.

The protection of a repository's git structure (below) is **defence in
depth** against what you wouldn't see in `git status` or a diff — a hook,
`core.fsmonitor`, a filter in the repository's config, a git dir git is
pointed at — and is best effort: its known limits are listed under
[Limits](#limits) rather than chased one by one. As a cheap, visible signal,
**a session says when the repository's git settings changed while it ran**:
at the end of each turn and when it is destroyed, if the repository's
config, hooks (the hooks dir's, or `core.hooksPath`'s when it points into
the repository), attributes (`.gitattributes`, `info/attributes`) or what
names its git dirs (`commondir`, a worktree's `gitdir`, the `.git` file)
changed, a warning line names them (event `sandbox.git_changed`, audited
`session.git_control_changed`). Look before you run git there. It also
says when **a commit made while it ran changed project settings an agent
CLI runs code from** ([below](#committed-project-settings)).

## What is protected

With the default policy (workspace-write):

| | |
|---|---|
| **Your home: hidden whole** | the sandbox starts from an empty, read-only home. A credential that isn't on any list, one created after the session started (`aws configure`, `gh auth login`), or one a program replaces by writing a new file and renaming it over the old one, is simply not there. What is shown again, read-only: the **allowlist** `sandbox.homeReadable` (below), and what the backend itself needs (its program; its private home, below). The workspace, when it is in your home, is shown writable. |
| **Home allowlist** (`sandbox.homeReadable`, read-only) | by default toolchains and tool settings that hold no secret: `~/.bun`, `~/.cargo/bin`, `~/.cargo/registry`, `~/.cargo/git`, `~/.rustup`, `~/.nvm`, `~/.npm`, `~/.local/bin`, `~/.local/lib` (pip `--user` packages), `~/.local/share/pnpm`, `~/.local/share/uv`, `~/.local/share/pipx`, `~/.local/share/mise`, `~/.local/share/claude/versions` (the Claude installer's binaries), `~/.pyenv`, `~/go/pkg`, `~/go/bin`, `~/.gitconfig`, `~/.config/git/config`, `~/.config/git/ignore`, `~/.config/git/attributes`, `~/.claude/plugins` and `~/.claude/skills` (installed plugins and user skills, so a skill's script run as a command can read its own files; the CLI's settings, credentials and hooks stay hidden), and `~/.claude/projects` (every Claude session's transcript and memory, read-only, so an agent can look up what another session did; a secret once pasted into a session is in its transcript, so remove it from the list to hide them). Not listed, so hidden: `~/.npmrc`, `~/.bunfig.toml`, `~/.yarnrc.yml`, `~/.pypirc`, `~/.cargo/credentials.toml`, `~/.git-credentials`, `~/.config/git/credentials`, `~/.gradle`, `~/.m2` and everything else. A global npmrc inside an nvm install (`~/.nvm/versions/node/*/etc/npmrc`) and uv's credential store (`~/.local/share/uv/credentials`) are hidden again. A link inside a listed dir (`~/.local/bin/x`) works only where it leads into the list itself (a pipx or `uv tool` venv, the Claude installer's versions) or outside the home: what it leads to elsewhere in the home (a project of yours, with its `.env`) stays hidden, and the link dangles. List the target's dir in `sandbox.homeReadable` to show it. A link in the list (`~/.gitconfig` into a dotfiles repository) is shown at its own path and where it leads. A token written into `~/.gitconfig` itself (a URL carrying one, an `http.extraHeader`) would show: keep it in a credential helper. |
| **Writable** | the session's working directory (its worktree), a private temp dir made for the session (`$TMPDIR`, and the sandbox's `/tmp` under bubblewrap and Docker), what a commit in the workspace's **git repository** writes: its git dir, a linked worktree's own git dir and its repository's (objects, refs, logs, the index, `HEAD`, `packed-refs` and the lock files beside them), wherever they are, a repository under the host's `/tmp` included; and, so a command can add a worktree, the repository's `worktrees/` (where git makes a new worktree's git dir) and the session's own **worktree folder** in each worktree location: `<repo>-worktrees/<folder>/` and `<root>/<repo>/<folder>/` for `sandbox.worktreeRoots` ([below](#git-worktrees-inside-the-sandbox)). Nothing else. |
| **Read-only** | everything else on the machine. `rm -rf ~` fails with "Read-only file system". Inside the writable, **a repository's structure**: everything that decides which config, hooks or git dir git uses, since a hook, `core.hooksPath` or `core.fsmonitor` planted there (or a config git is pointed at) would run outside the sandbox at your next `git status`. That is, in the repository's git dir: `config`, `config.worktree`, `commondir`, `hooks/`, `info/`, `modules/` (a submodule's git dir carries hooks and config of its own), `remotes/`, `branches/`; in `worktrees/` (itself writable, so a command can add a worktree, but bound at its own path: it can't be renamed away and rebuilt), **every worktree's git dir there when the sandbox is built that the session didn't make, whole** (its `commondir`, `gitdir`, `config.worktree`, HEAD and index: it can't be rewritten, renamed, removed or pruned), with its checkout's `.git` file when that is in the workspace; one made later is checked against git's own layout at every turn's end and restored ([below](#git-worktrees-inside-the-sandbox)); the rest of every worktree location, and a `.worktrees/` you have in the main checkout, whole, for a session working there ([below](#git-worktrees-inside-the-sandbox)); in a linked worktree's own git dir: `commondir`, `gitdir`, `config.worktree`; the worktree's `.git` file, and the `.git` file of every submodule checked out inside the workspace. A **submodule checkout** as the workspace (its `.git` a file naming `<super>/.git/modules/<name>`, whose `core.worktree` names it back) is held the same way, its git dir being the repository's. Any other `.git` file (a `--separate-git-dir` checkout, which git's records don't name back) is held read-only, with what it names when that is inside the workspace: nothing commits from inside, and the session's sandbox limits say so. The git dirs themselves are bound at their own paths, so none can be renamed away and rebuilt (`mv .git .git-old` fails), the workspace's `.git` dir included. A plain repository at the top of the workspace gets an empty `HEAD/` dir beside its `.git`, held read-only (git doesn't see an empty dir): a `.git` made invalid (its `HEAD` garbled, `refs/` removed) would otherwise have git take the workspace's top for a bare repository planted there, with its own config. What of these isn't there yet is made first, so there is something to hold: empty `hooks/`, `info/`, `modules/`, `remotes/`, `branches/`, `worktrees/`, an empty `config.worktree` in every git dir of the repository, and a `commondir` in the repository's git dir holding `.` (git, libgit2 and gitoxide read it as that git dir itself; see Limits). An entry that would have to be held but is a link (a bind can't hold one) makes the git dir read-only whole: commits from inside then fail. And **the project settings agent CLIs run code from** (below). |
| **Project settings** (read-only) | `.claude/`, `.gemini/`, `.qwen/`, `.codex/`, `.pi/`, `.opencode/` in the workspace (and, for a session in a monorepo's package, in every dir from the package up to the repository's top: where the CLIs look), whole (made empty first where missing: git doesn't see an empty dir; not in a workspace that is your home or holds it, a temp root or `/`, where they would be the CLIs' own config dirs: there only those that exist are held), and `.mcp.json`, `opencode.json`, `opencode.jsonc` at its top, made first where missing (in the same places) holding an empty config (`{"mcpServers":{}}`, `{}`: what the CLIs read as none; your own `opencode` loads a project `opencode.json`'s MCP servers and plugins at its start) and, in a git repository, listed in its `.git/info/exclude` so `git status` and `git add -A` don't see them (an existing file is held as it is). A Claude hook, an MCP server, a pi or opencode plugin written there by one backend's command would run on the host in a later session of another, or in your own CLI. Changing them needs the sandbox lifted for that command: Claude's `dangerouslyDisableSandbox` and Codex's permission request are asked about in guarded and interactive mode and refused in autonomous mode (below); on other backends edit them yourself, or turn the session's sandbox off. A file tool that runs in the backend's own process, outside the sandbox (Claude's Write, Edit, MultiEdit and NotebookEdit, opencode's write, edit and patch) is held to the same rules at codeoid's gate in autonomous mode ([below](#file-tools-that-run-outside-the-sandbox)): writing what the sandbox holds read-only is refused there, and asked about in guarded and interactive mode. Writing the rest of **the repository's git dir** (its objects and refs, which a sandboxed commit writes, a linked worktree's, the `.git` file, another checkout's `.git` file in the workspace), or a file with more than one hard link, is asked about in guarded and interactive mode while the sandbox is on, the card saying why (audited `session.git_structure_write_ask` / `session.project_settings_write_ask`), and refused at once in autonomous mode (audited `session.autonomous_refuse`, kind `held_write`); on Claude the PreToolUse hook routes it to the gate past any allow rule. A backend whose file tools run inside the sandbox (Codex, pi, the Gemini CLI, Qwen; Claude under Docker) is held by the sandbox itself: nothing of this applies to it, a hard-linked file in `node_modules` included. |
| **Hidden besides** (not readable at all) | outside the home, or in a workspace that holds it: codeoid's config dir (`~/.codeoid`: keys, accounts, endpoints, the local token) and every data dir it owns wherever it is configured (the database, transcripts and checkpoints, opencode's database and data dirs, memory's; their lock files); the agent CLIs' logins (`~/.claude/.credentials.json`, `~/.codex/auth.json`, `~/.qwen/oauth_creds.json`, `~/.gemini/oauth_creds.json` …, pi's `auth.json`) and what backends registered as credentials (opencode's key files); `~/.ssh`, `~/.aws`, `~/.azure`, `~/.config/gcloud`, `~/.kube`, `~/.docker`, `~/.gnupg`, `~/.config/gh`, `~/.config/hub`, `~/.config/glab-cli`, `~/.netrc`, `~/.git-credentials`, `~/.config/git/credentials`, `~/.local/share/keyrings`, `~/.password-store`, `~/.config/op`, `~/.vault-token`, `~/.pypirc`, `~/.cargo/credentials(.toml)`, `~/.terraform.d/credentials.tfrc.json`, `~/.claude.json` (MCP tokens), `~/.local/share/opencode/auth.json` and `mcp-auth.json`, `~/.config/github-copilot`, `~/.pgpass`, `~/.config/rclone`, `~/.s3cfg`, `~/.boto`, `~/.pulumi/credentials.json`, `~/.config/doctl`, `~/.fly`, `~/.npmrc`, `~/.bunfig.toml`, `~/.yarnrc.yml`, `~/.gradle/gradle.properties`, `~/.m2/settings.xml`, `~/Library/Keychains`; the desktop session's runtime dir (`$XDG_RUNTIME_DIR`: keyring, D-Bus, agent sockets) and `$SSH_AUTH_SOCK`'s dir; the daemon's own temp dir when it isn't `/tmp`, and always the daemon's private dir in it (`codeoid-sandbox-*`, made at its start, 0700), where it makes every temp entry of its own: sign-in homes, a check's artifacts, a loop's index, pi's bridge, the sessions' temp dirs and launchers — so one made while a session runs is hidden from it too, on Claude's own sandbox (which keeps the host's `/tmp`) as well; plus `sandbox.hiddenPaths` (which also beats the allowlist). |
| **The daemon's own git** | every git codeoid runs in a repository an agent can write (a fork's worktree made and removed, a destroyed session's work snapshotted, a worktree's setup, the branch and status the UI shows, loops) runs nothing that repository's config names, sandbox or not: no hook (the hooks dir's or one defined in config, `hook.<name>.command`), fsmonitor, alternates' ref command (`core.alternateRefsCommand`), external diff, signing or signature check (gpg's and ssh's programs, `gpg.ssh.defaultKeyCommand`), editor or pager, git-protocol proxy or auto gc, `core.sshCommand` is `ssh`, and every filter, diff or merge driver and credential helper defined in the repository's own config (local or worktree, includes too) is reset, your own global or system definition put back (git lfs installed globally keeps working; a repository redefining it doesn't). Reaching a remote (a base branch fetched for a fork, a partial clone's objects) is https or ssh only. Loops' repositories are stricter still: every driver off, no system config. Checkpoints run in codeoid's own shadow repository, whose config is codeoid's. |
| **Never reachable** | container and VM runtime sockets: `/run/docker.sock`, `/var/run/docker.sock`, dockerd's `/run/docker/`, cri-dockerd, containerd, podman, CRI-O, buildkit, k3s, k0s, microk8s, firecracker-containerd, balena, **libvirt** (`/run/libvirt/`, `$XDG_RUNTIME_DIR/libvirt/`: a VM with the host's disk), **LXD** (`/var/snap/lxd/common/lxd/`, `/var/lib/lxd/`) and **Incus** (`/var/lib/incus/`, `/run/incus/`: a privileged container), the user's rootless sockets, Docker Desktop / Colima / Lima / Rancher / OrbStack, `$DOCKER_HOST`. A runtime socket is root on the machine. The one exception is the owner's: [Docker access](#docker-access), off by default, which shows only Docker's (or Podman's) own. Hidden too, in every sandbox: the system D-Bus (`/run/dbus/`: polkit lets a desktop user mount drives, change the network, power off) and screen's sessions (`/run/screen/`), as the desktop session's runtime dir is (its bus, keyring and agents). **With the network `off` or an `allowlist`, local services' sockets** too, since a filesystem socket isn't the network and a connection to one gets in by who you are, no password asked (Postgres's peer auth, MySQL and MariaDB's `unix_socket`, a Redis without auth): `/run/postgresql/`, `/var/run/postgresql/`, `/run/mysqld/`, `/var/run/mysqld/`, `/run/mariadb/`, `/var/lib/mysql/mysql.sock`, `/run/redis/`, `/run/redis-server/`, `/run/valkey/`, `/run/memcached/`, `/run/mongodb/`, `/run/pgbouncer/` (and their `/var/run/` forms), and those found in `/tmp`, `/private/tmp` and `/var/tmp` by name (`.s.PGSQL.*`, `mysql.sock`, `mysqlx.sock`, `redis.sock`, `mongodb-*.sock`, … : Homebrew's and source builds' defaults). It follows the network the session asked for, so a backend that keeps the network on to reach its model (pi, the Gemini CLI, Qwen) still hides them. With the network `on` they are reachable as before (a command can reach the host's loopback then anyway); hide one more with `sandbox.hiddenPaths`. |
| **Toolchain caches** | the home is read-only, so the caches are pointed at the sandbox's own cache dir, `${XDG_CACHE_HOME:-~/.cache}/codeoid-sandbox` (one per user, writable inside, read by none of your own tools): `XDG_CACHE_HOME` (pip, uv, Go's build cache and what else follows XDG), `GOCACHE`, `GOMODCACHE`, `BUN_INSTALL_CACHE_DIR`, `npm_config_cache`, `UV_CACHE_DIR`, `PIP_CACHE_DIR`, `CARGO_HOME` (cargo's registry cache; your `~/.cargo/config.toml` is still read from above a workspace in your home, not from `CARGO_HOME`). Go modules you already downloaded are read from your own module cache first, as a file proxy (`GOPROXY=file://~/go/pkg/mod/cache/download,<yours>`), so `go build` works with the network off. `go build`/`go test`, `bun install`, `npm install`, `uv` and `pip` work inside. The sandboxed sessions share this dir: what one downloads or builds, another reuses (and could have tampered with: a build cache is trust among your sandboxed sessions). A cache is code to the toolchain that reads it (`CARGO_HOME`'s `config.toml` and `bin/`, a module in `GOMODCACHE`, an install in npx's cache), so **these variables are set only for what runs inside a sandbox**, never for anything outside one: on Claude's own sandbox they aren't in the CLI's environment (nor, so, its MCP servers', its hooks', or a command you let run outside the sandbox); the CLI sources a file of codeoid's (`CLAUDE_ENV_FILE`, in the CLI's own temp dir) into each command, which sets them only where the CLI marks the command as sandboxed (`SANDBOX_RUNTIME=1`). |
| **Environment** | `SSH_AUTH_SOCK`, `SSH_AGENT_PID`, `GPG_AGENT_INFO`, `DBUS_SESSION_BUS_ADDRESS`, `DOCKER_HOST`, `CONTAINER_HOST`, `KUBECONFIG` are unset inside. On Claude, every credential-named variable the CLI runs with is denied to its commands. |
| **Network** | `on` (default), `off`, or `allowlist` (hosts in `sandbox.allowedHosts`), per session and in config. |
| **Processes** | no new privileges; under bubblewrap a pid namespace (the sandbox sees only its own processes, so not the daemon's or the CLI's environment) and processes die with the sandbox they run in (see Limits for opencode). |
| **Hidden stays hidden** | every directory between the workspace and a hidden path inside it (a workspace of `/home` holding your home, a `sandbox.hiddenPaths` entry inside the project) is pinned: it can't be renamed or removed, so the hidden path can't be moved out from under its rule; what is in it stays writable (on Claude's own sandbox the whole dir is read-only: see Limits). The daemon's own sandbox dir (each session's temp dir, private homes, the launchers, sign-in homes) is hidden from every session, a session whose workspace is `/tmp` included. |
| **Loop checks** | a loop's acceptance checks judge agent-written code, so they run in the loop's sandbox too (the check's checkout writable, credentials hidden), recorded `isolation: "sandbox"`; one whose sandbox can't run is an `error`, not a pass. |

**A session in a subdirectory of its repository** (a monorepo's package,
`codeoid new web ~/src/mono/packages/web`): the sandbox's workspace is the
repository's top (`sandboxWorkspaceOf`), writable, with its git structure and
project settings held as for any repository, and the session's cwd stays the
package. So git works (its discovery isn't stopped at a mount, and a commit
sees the whole tree, never the rest of the repository as deleted), the root's
`package.json` and `tsconfig.base.json` and the sibling packages are readable
and writable, and nothing above the repository is. The gate's host-side bounds
are the same. Only a repository git's own records vouch for (a plain `.git`, a
linked worktree, a submodule) is taken, below the home: never the home's own
(a dotfiles repository), `/`, a temp root or a dir holding the home; there the
workspace stays the workdir. The session's sandbox limits say when it is
widened.

A workspace of `/` can't be sandboxed (the whole filesystem would be writable,
the sandbox's own `/proc`, `/dev` and `/tmp` covered): such a session is "not
sandboxed" (interactive runs and says so, unattended is refused), and a check
there is refused.

A command that needs more fails inside the sandbox and the agent sees why
(`Read-only file system`, `No such file or directory`, a refused connection;
Claude adds a `<sandbox_violations>` note). Running one command outside the
sandbox is its own approval in guarded and interactive mode; autonomous mode
refuses it (see below).

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
expands). `sandbox.worktreeRoots` (`CODEOID_SANDBOX_WORKTREE_ROOTS`, Settings >
Sandbox > More worktree locations) adds places a session may check a worktree
out, `<root>/<repo>/<folder>/`; a root where tools load programs or settings
from (`~/.config`, `~/.local`, `~/Library`, …), the home or `/` fails the
config's load ([below](#git-worktrees-inside-the-sandbox)). `sandbox.docker.socket`
(`CODEOID_SANDBOX_DOCKER_SOCKET`, Settings > Sandbox > Docker access, default
`false`) gives every new session [Docker access](#docker-access). `sandbox.homeReadable` (`CODEOID_SANDBOX_HOME_READABLE`, comma
separated) replaces the home allowlist: add what your tools need that holds no
secret (`~/.volta`, `~/.sdkman/candidates`, `~/.config/starship.toml`), never a
file with a token. `sandbox.bwrapPath` picks the bwrap binary.

Changing any `sandbox.*` setting daemon-wide (`settings.set`, the Sandbox tab)
needs `settings:write` from an undelegated token, and is audited old → new
(`settings.set.sandbox`; a refusal `settings.set.denied`).

Per session:

- at creation: `codeoid new <name> <dir> --sandbox bwrap|seatbelt|docker|auto|off [--network on|off|allowlist] [--allow-host h …] [--docker-socket]`,
  the web UI's new-session dialog ("Sandbox: the daemon's default. change",
  with a "Docker access" box), or `session.create`'s
  `sandbox: { provider?, network?, allowedHosts?, dockerSocket? }`;
- later, by the session's owner: `codeoid sandbox set <session> [provider] [--network …] [--docker-socket | --no-docker-socket]`,
  `/sandbox <auto|off|id> [on|off|allow:host,…] [docker|nodocker]` (`docker`
  after a provider is Docker access; alone it is the provider), or
  `session.set_sandbox`.
  A change is made only while the session is idle: no turn running, no
  approval or dialog waiting, no background work (a dev server, a subagent).
  Otherwise it is refused, saying why ("the session is busy", "has background
  work running") — what runs must match what the session reports, and a
  backend running in the old sandbox is restarted to take the new one, never
  in the middle of work. Narrowing (on, the network off) is applied without
  asking. **Widening — turning it off, a wider network, another provider,
  Docker access — is a confirm shown on the session, answered only by its owner with their own
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
  `session.sandbox_wider_refused` when refused). Docker access counts as
  wider whenever the daemon's default doesn't give it. A fork or a compare of a
  session with such a sandbox is made only by its owner, undelegated (anyone
  in the tenant may fork one whose sandbox is the daemon's or narrower). A
  session whose sandbox is off, or has Docker access, is switched to
  autonomous only by its owner's own token. A routine whose runs' sandbox is off or wider than the daemon's
  (the same rule) needs `session:approve` (routine changes are refused to
  delegated tokens). A provider named explicitly that
  can't run here is refused (choose another, or `off`);
- routines (`codeoid routine add … --sandbox … [--docker-socket]`, the spec's
  `sandbox`) and loops (`codeoid loop start … --sandbox … [--docker-socket]`,
  `loop.start`'s `sandbox`) take one too; a loop's acceptance checks get
  Docker access when its sandbox has it.
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

- **Claude (native)**: its file tools (Read, Edit, Write, Grep, Glob, LSP) run
  in the CLI, outside the sandbox — in autonomous mode codeoid's gate holds them
  to the sandbox's own policy ([below](#file-tools-that-run-outside-the-sandbox)):
  a read of what it hides, or a write outside what it lets commands write (the
  project's `.claude/` and other project settings, the user's `~/.claude` but
  for the CLI's own memory, plans and task output, the rest of the home), is
  refused: a hook or an excluded command written there would run outside the
  sandbox. In guarded and interactive mode such a write is asked about, the
  card saying it is outside the sandbox's bounds.
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
  held to the sandbox's own policy at codeoid's gate in autonomous mode
  ([below](#file-tools-that-run-outside-the-sandbox)); under bubblewrap the
  host's `/tmp` is out of bounds to them too, since its commands see the
  session's temp dir there. A subagent created in a feed gap, before codeoid set its
  shell environment, runs nothing.
- **MCP servers** a backend mounts (stdio servers from config, a project's
  `.mcp.json`) and the workdir's own hooks run as the backend starts them:
  inside the sandbox for process backends, outside it for Claude (native),
  Codex's own MCP servers inside codeoid's bubblewrap.
- A backend installed under the home (an npm-global `pi`, a CLI whose `#!`
  names `node` from nvm) is shown read-only inside: its dir, the package it
  belongs to, and its interpreter's install (`programLocations`), never the
  home itself.

## A backend CLI's own git

A backend whose CLI runs outside the sandbox runs git there too, for itself:
the Claude CLI (under its own sandbox) runs `git status`, `git log`,
`git remote` and `git config` in the workspace at every start, and
opencode's shared server runs git for its project and snapshots. A
sandboxed command can make a repository in the workspace (`git init` in a
workspace with no `.git` of its own: a new project, or a package of a
monorepo), name a program of its own as a filter driver in its config and
apply it in `.gitattributes`; a git started outside would run that program
with your rights at the CLI's next start, with no command of yours.

So that CLI finds codeoid's `git` first on its `PATH`
(`src/daemon/sandbox/git-shim.ts`): a script in a dir of the daemon's own
(the session's launcher dir for Claude, `<providers.opencode.dataDir>/git-bin`
for opencode), hidden from every sandbox and never in the workspace or the
caches, so nothing inside can rewrite it (opencode's file tools are refused
it, as its shell shim's `bin/`).

- **Claude (native)**: the shim runs the real git **inside the session's
  sandbox** — the same provider (bubblewrap, Seatbelt), the session's command
  sandbox (the workspace writable, its git structure and project settings held
  read-only, the home and every hidden path hidden), no network, and a fresh,
  empty `/tmp` for each git, gone when it exits (a tmpfs under bubblewrap; under
  Seatbelt a dir of its own made in a daemon-private dir, the only part of it
  writable, removed when git exits), never the session's temp dir — with the
  CLI's stdio, exit code, working directory and arguments. A driver a planted
  config names runs there, contained: it can do what a sandboxed command can
  and no more, and nothing it writes outlives it outside the workspace. So the
  CLI's own writing git works: its commits, and a sub-agent's worktree
  isolation (`git worktree add`, `git worktree remove`), for which the
  repository's `worktrees/` and the workspace's `.claude/worktrees` are
  writable too (only to the CLI's git, never to a command; only when they are
  real dirs, never in a git dir held read-only whole). Its
  `git fetch origin <base>` before a worktree fails (no network), and the CLI
  bases the worktree on the local branch instead, with a warning. The CLI's
  `EnterWorktree` and `ExitWorktree` are refused in a sandboxed session
  ([below](#the-claude-clis-own-worktrees)).
  git gets **an environment of its own**, built from a short allowlist
  (`SHIM_ENV_NAMES`), never the CLI's: who you are, the locale, the terminal
  and clock, `PATH`'s absolute entries, `HOME` as the sandbox shows it
  (hidden, its allowlist such as `~/.gitconfig` shown), git's choice of
  repository, worktree, index, pathspec and identity (`GIT_DIR`,
  `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_AUTHOR_*`, …), and the CLI's own `-c`
  list (`GIT_CONFIG_COUNT`) less any entry with a value whose key can carry a
  credential (`http.*`, `credential.*`, `url.*`, `remote.*`, a token, a
  password) or whose value is a URL with a user in it. Never the CLI's API key,
  OAuth token or gateway credential, any `ANTHROPIC_*`/`CLAUDE_*`/codeoid
  variable, `GIT_ASKPASS`, `GIT_SSH*`, `GIT_EXEC_PATH`, `GIT_TEMPLATE_DIR` or
  `GIT_CONFIG_PARAMETERS`.
  The CLI's Bash commands get the CLI's `PATH` without the shim (its env file
  takes it off), so a command's git is the real one: inside the sandbox as
  before, and a command the owner let run outside (a `git push`) runs as it
  would. The CLI's `PATH` has only absolute entries: a relative one (`.`,
  `node_modules/.bin`) would find a program the CLI starts on the host in the
  workspace. What the CLI starts with its own environment finds the shim too:
  a hook or a stdio MCP server that runs git in the workspace runs it in the
  sandbox, offline, without its credentials; give it its own `PATH` in its
  config if it must push. The shim is checked at each query and written again
  when it is gone (a temp cleaner removing the daemon's dir); one removed while
  a query runs leaves that query's CLI the next `git` on its `PATH`.
- **When the shim can't sandbox** (its provider's program is gone), and for
  **opencode's server** (one server for every session, so no one session's
  sandbox fits; the git it runs is the one its `PATH` found): git runs with
  every program-running key turned off (the daemon's own list, `safeGitEnv`'s,
  appended to the caller's `GIT_CONFIG_COUNT`), every filter, diff and merge
  driver and credential helper a config other than your global and system
  one defines reset by name (read from the repository git will use: the
  caller's `-C`, `--git-dir` and `--work-tree` are followed), the working
  tree's attributes not read (`attr.tree` naming the empty tree, git 2.46+),
  no nested repository gone into (a gitlink's dirt, summary or diff would run
  a git inside it, with that repository's own config and `info/attributes`,
  whose drivers can't be reset by a name the shim never saw: submodules are
  ignored, `diff.ignoreSubmodules=all` and `submodule.<name>.ignore=all` for
  every name the repository's config and `.gitmodules` know, which outranks
  a `.gitmodules` `ignore = none`; no submodule summary, no recursing fetch or
  push), the same environment allowlist as above (with the caller's own
  `HOME` and `TMPDIR`: opencode's server's password never reaches git), and
  only https and ssh as protocols unless the caller's own list is narrower
  (opencode's is none). A submodule's changes therefore don't show in such a
  git's status.
  A config git can't read runs nothing; a diff through a textconv or
  external diff the repository names fails rather than run it. A shim on
  `PATH` covers git run as a program, not a git library inside a backend:
  opencode 2.2.5 bundles a file finder (`fff-core`) that reads git status
  itself; with a planted `* filter=…` in a repository's config and both
  attribute files, its glob, grep, write, edit and turns ran nothing
  (`provider-opencode.integration.test.ts` I58), and codeoid never calls its
  file picker.
- **Process-confined backends** (pi, the Gemini CLI, Qwen, Claude and Codex
  under Docker) and **Codex under bubblewrap** run their git inside the
  sandbox already, with everything else they do.

## File tools that run outside the sandbox

Claude's file tools under its native sandbox (Read, Write, Edit, MultiEdit,
NotebookEdit, Glob, Grep, LS, and LSP when the CLI turns it on) and
opencode's (read, write, edit, patch, glob, grep, list, and its
external-directory requests) run in the backend's own process, outside the
OS sandbox. **In autonomous mode**, where no one is asked, codeoid's gate holds
them to the sandbox's own policy (`src/daemon/sandbox/host-file-tools.ts`),
judged against the very spec the session's sandbox was built from, so the two
can't disagree: a call is allowed only where a sandboxed command could do the
same thing.

**In guarded and interactive mode** they are decided as without a sandbox
(#448 round 9): what asked there asks, what ran there runs. The owner decides,
and the approval card says the call is outside the sandbox's bounds
("outside the sandbox's bounds: a write to <path>; runs in the backend's own
process, outside the sandbox"). So a write to the project's `.claude/`,
`.mcp.json`, `.codex/` or `opencode.json`, or to `/tmp`, asks in guarded mode;
a read of `~/Downloads/…`, `~/Documents/…` or a sibling repository runs in
guarded mode and asks in interactive mode. The credential refusals stand in
every mode (`~/.codeoid/config.json`, the CLIs' logins: the
[secret-path rule](approvals.md)).

In autonomous mode:

- **A write** must land in what the sandbox makes writable: the workspace, the
  session's temp dir (on Claude's own sandbox, its commands' `TMPDIR`), the
  sandbox's caches, a git worktree's git dirs; never what it holds read-only
  there (the repository's git structure, the project settings) or hides. A
  write to `~/.bashrc`, `~/.gitconfig`, `~/.ssh/authorized_keys`,
  `~/.claude/settings.json`, `~/.config/systemd/…`, `~/.local/bin/…`, `/tmp`
  (on Claude) or another repository is refused, the reason naming where the
  agent may write instead: the working directory and the session's temp dir,
  by its path as written and its real path.
- **A read** must not reach what the sandbox hides: the home outside
  `sandbox.homeReadable` and the workspace, codeoid's config and data dirs,
  the CLIs' logins and the credential stores above, container sockets,
  `sandbox.hiddenPaths`. `Read ~/.ssh/id_ed25519` is refused; `~/.gitconfig`
  (on the allowlist) is read. The reason says what the owner can do: copy the
  file into the workspace, add its directory to `sandbox.homeReadable`, or
  switch the session to guarded mode.
- **A search** (Glob, Grep, LS) must not start in or above a hidden path: the
  tool would recurse into it, where a sandboxed `grep -r` sees nothing. A
  Glob pattern that is absolute or climbs out with `..` is judged from where
  it starts. Two exceptions, for a hidden path inside what the session sees
  (a `sandbox.hiddenPaths` entry in the workspace, or the home's credential
  dirs when the session works in the home itself):
  - **Claude** leaves it out of the search: an autonomous query carries a
    Read deny rule for each such path (`Read(//<path>)`, `Read(//<path>/**)`,
    `claudeSearchExclusions`), which the CLI's Grep and Glob honour (checked
    on the real CLI 2.1.281: the file, and a dir's contents, drop out of
    both). The rules are fixed when the query starts, so a switch to or
    from autonomous mode rebuilds the query at the next turn (the
    conversation resumes); until then a search past such a path is refused.
    A path a rule can't spell literally (one with `*`, `?`, brackets or
    braces) isn't excluded, and a search past it stays refused.
  - **opencode** can't be told to leave anything out (its ripgrep runs with
    `--no-config`, and only the workspace's own ignore files apply), so a
    search there runs and **can return the contents of the user's own
    `sandbox.hiddenPaths` entries inside the workspace**. Any other hidden
    path below the search's root still refuses it.

  A search reaching a credential location outside the workspace stays
  refused, and so does one the [secret-path rule](approvals.md) asks about
  (the home's top, in a session working in the home: search a dir below
  it). A search in the shell (`grep -rn`, `rg`, `find`) runs inside the
  sandbox, which shows a hidden path empty: it runs, on every backend.

Each path is resolved as the kernel resolves it (through every link, `..` the
parent of what the path so far really is) and also with `..` collapsed, as a
tool normalizing it reads it; either out of bounds counts, and a path that
can't be resolved for certain (`/proc`'s per-process links, `..` past a
missing directory, a relative path whose directory isn't known) is refused.

Such a call is refused, never asked: the agent reads "Refused: outside what
this session's sandbox allows: <path> (why). … <what to do instead>", the
card is cancelled with that reason, an info line says so (event
`sandbox.refused`) and the audit log records
`session.sandbox_bounds_refuse tool=… access=…`. On Claude the PreToolUse
hook routes such a call to the gate past any allow rule (the CLI allows a
read in the workdir or an added dir, and its own files, by itself), in
autonomous mode only. Within the bounds nothing changes. A session whose
sandbox is off (the owner's choice) keeps the gate as it was. Backends whose
file tools run inside the sandbox (Codex, pi, the Gemini CLI, Qwen; Claude
under Docker) are held by the OS and need no gate rule.

### What the backend's own file tools keep outside

What a backend's CLI keeps outside the sandbox and reads back as context,
never as code, stays its own file tools' in autonomous mode
(`SessionProvider.hostFiles`). Each location is the one the CLI uses itself,
read from the bundled Claude CLI 2.1.281 (its own allow rules: "auto memory
files are allowed for writing", "Plan files for current session are allowed
for writing", "User agents files are allowed for reading", …) and checked on
the real binary, and from opencode 2.2.5 (`providers/claude/host-files.ts`;
`<config>` is the CLI's config dir: `CLAUDE_CONFIG_DIR`, a named account's,
else `~/.claude`):

| Backend | Location | Its file tools may |
| --- | --- | --- |
| Claude | `<config>/projects/<project>/memory/` (auto-memory; `<project>` named after the repository's top, a linked worktree's main checkout's, or the cwd) | read; write `.md` files |
| Claude | `<config>/agent-memory/` (user-scope agent memory) | read; write `.md` files |
| Claude | `<config>/plans/` (plan files, its `plansDirectory` default) | read; write `.md` files |
| Claude | `$CLAUDE_CODE_TMPDIR/claude-<uid>/<cwd's name>/` (each session's background shells' and agents' output, `<session>/tasks/<id>.output`, and its scratchpad) | read, write |
| Claude | `<config>/tasks/`, `<config>/todos/` (task lists, todos) | read, write |
| Claude | `<config>/CLAUDE.md`, `<config>/agents/`, `commands/`, `rules/`, `output-styles/` | read |
| Claude | an installed plugin's `skills/` and `commands/` (an `installPath` in `<config>/plugins/installed_plugins.json` under `<config>/plugins/`); `$CLAUDE_CODE_TMPDIR/claude-<uid>/bundled-skills/` | read |
| Claude | its saved tool output for this session (`<config>/projects/<project>/<session>/tool-results`), its skills' own files (the user tier's, the session's plugins') | read |
| opencode | its scratch dir, `<dataDir>/tmp/opencode/` (its `Global.Path.tmp`, `paths.tmp` in `GET /api/info`; its image tool writes there) | read, write |
| opencode | its truncated tool and shell output (`<dataDir>/data/opencode/tool-output/`, `…/shell/`) | read |

Never: the CLI's credentials (`.credentials.json`, a keychain file), its
settings files (`settings.json`, `settings.local.json`: env secrets, hooks),
its hooks, MCP server configs, a plugin's hooks, `.mcp.json` or anything else
outside its `skills/` and `commands/`, the rest of its temp dir (its sockets,
its plugin-tool staging), and another project's memory. A write to the user
tier's `CLAUDE.md`, agents or commands stays refused (they are read every
session). A link in any of these is judged where it leads. Memory persists
across sessions, as it does without a sandbox: a note an injected prompt made
the agent write is read back by the next session. A custom
`autoMemoryDirectory` isn't followed (outside the workspace, its writes stay
refused in autonomous mode); the project-scope agent memory
(`.claude/agent-memory/`) is in the project settings, held read-only.

A search doesn't follow links below its root (ripgrep's default), so a link
in the workspace to a hidden dir shows only its name to a search; a Read
through it is judged where it leads.

## Running one command outside the sandbox

- **Claude**: `allowUnsandboxedCommands` is on, so the model may retry a command
  with `dangerouslyDisableSandbox: true`. Codeoid's PreToolUse hook sends it to
  the gate past any allow rule. In guarded and interactive mode the gate
  **asks**, audited `session.unsandboxed_ask` / `session.unsandboxed_approve`;
  the card says "asks to run outside the sandbox". Verified against the real
  CLI: approved, it runs with your full rights; denied, it never runs. In
  **autonomous mode it is refused at once**, never asked: the model is told
  the owner can run it, or switch the session to guarded mode; an info line
  and `session.autonomous_refuse` (kind `unsandboxed`) record it, and no
  budget is spent. So an unattended run never parks on one.
- **Codex**: a request to widen its sandbox (`item/permissions/requestApproval`,
  `codex_permissions`) is asked (or refused) the same way. (In autonomous mode codex asks
  nothing, #442: its sandbox is the boundary.) Under codeoid's bubblewrap a
  command codex runs unsandboxed is still inside codeoid's.

## The Claude CLI's own worktrees

In a sandboxed Claude session the CLI's own worktree tools, `EnterWorktree`
and `ExitWorktree`, are **refused** at codeoid's gate, saying "use codeoid's
--worktree; the CLI's own worktrees aren't sandboxed". For a session in a
worktree of its own, start it with `codeoid new … --worktree`: codeoid makes
the worktree and sandboxes the session there. The CLI runs `EnterWorktree`
without asking for permission (it never reaches `canUseTool`), so the refusal
is in codeoid's PreToolUse hook, which sees every call, and again in
`canUseTool`. `ExitWorktree` is refused too: it moves the session back to
where it was before it entered, which can itself be a worktree.

Why: `EnterWorktree` checks a worktree out from HEAD under
`.claude/worktrees/` and moves the session into it, and HEAD can carry project
settings an agent committed from inside the sandbox
([below](#committed-project-settings)). What the CLI does with them, checked
in its binary and against the real CLI (Agent SDK 0.3.281, Claude Code
2.1.281; `sandbox-claude-real.test.ts`): entering re-roots the CLI's project
settings at the worktree (its `originalCwd` becomes the worktree, and the
`projectSettings`/`localSettings` sources are read from there), but it doesn't
reload them. Run against a localhost stand-in for the API, with a
`.claude/settings.json` carrying a hook committed to HEAD and absent from the
working tree, the hook did not run after `EnterWorktree`: not in that query,
not after a settings file written in the worktree, not in a resumed query
(codeoid passes the workspace as `cwd`). It would run as soon as anything
made the CLI reload its settings in that query. codeoid refuses the tools
either way rather than depend on that. Not refused: a sub-agent's worktree
isolation (the `Agent` tool's `isolation: "worktree"`), whose sub-agent runs
in the CLI's process with the session's settings.

## Git worktrees inside the sandbox

Agents branch in a worktree of their own, never in a checkout others share:
`git worktree add <path> -b <branch>`, work and commit there, then
`git worktree remove`. Inside the sandbox that works, in every mode, **in the
session's own worktree folder** (`src/daemon/sandbox/worktrees.ts`):

- **Where**: each of the repository's **worktree locations** holds one folder
  per session, and only the session's own is writable to it:
  `<repo>-worktrees/<folder>/` (the sibling dir, codeoid's own convention for
  forks and loops) and `<root>/<repo>/<folder>/` for each
  `sandbox.worktreeRoots` entry (a root is shared by every repository, so each
  gets its own dir in it). **Nothing is made inside your checkout**: a
  `.worktrees/` is no location (one you already have is held read-only whole
  for a session working in that checkout). `<folder>` is the session's name
  made filesystem-safe and a short id (`fix-login-3f9a2c1d`): readable, never
  another session's, the same across a resume, a rename and a daemon restart
  (found again by its short id while it exists); a fork gets its own. A folder
  is made only for a session whose workspace is in a git repository, when its
  sandbox is built (a mount needs something there), and **removed while
  empty**, with `<repo>-worktrees/` when that is left empty too: at the end of
  a turn with nothing running in the sandbox (no background work; not for a
  backend whose whole process runs inside, pi, the Gemini CLI, Qwen, Codex,
  Claude under Docker, whose mounts were fixed at its start), and with the
  session. The next turn makes it again. Nothing with anything in it is ever
  removed: a worktree there is yours to keep.
- **The agent is told**: the session's system prompt (every backend: Claude's
  and Codex's instructions, the others' preamble) says "Create git worktrees
  under `<folder>/` … other locations are read-only in this sandbox". A
  `git worktree add` anywhere else fails with the OS's "Read-only file
  system" (git: "could not create leading directories"); the OS can't say
  why, the note and this page do.
- **Everything else in a location is read-only to the session**: the user's
  worktrees there, other sessions' folders, codeoid's own fork, loop and
  `--worktree` checkouts, and anything anyone makes there later (the session's
  writable set is its folder, fixed by name, so a later arrival is never in
  it). A `.worktrees/` you have in the main checkout is held read-only whole
  for a session working there (worktrees of yours, or other sessions' from
  before, may be in it), and gives no session a folder.
- **git's own records**: the repository's `worktrees/` is writable, so git can
  make the new worktree's admin dir, and the new branch's refs are written as
  any commit's. `worktrees/` is bound at its own path: it can't be renamed
  away and rebuilt. Every admin dir in it when the sandbox's spec is built
  that the session didn't make is held read-only whole (its `commondir`,
  `gitdir`, `config.worktree`: what decides where git looks; it can't be
  rewritten, renamed, removed or replaced by a planted one under its name,
  `git worktree prune` leaves it — it says it failed to delete it — and
  `git worktree remove` can't remove it), with its checkout's `.git` file
  when that is in the workspace. A worktree added or removed anywhere (by
  you, a fork, another session) **never rebuilds a session's sandbox**: that
  would rebuild a Claude query, killing its background tasks, or restart a
  process backend. The spec is built again only when it would be anyway (the
  session's sandbox setting changed, its backend restarted).
- **Every admin dir is checked against git's own layout** instead
  (`src/daemon/sandbox/worktree-entries.ts`), when the session's sandbox is
  built, at the end of every turn and at destroy: it is a dir, not a link;
  its `commondir` names the repository's git dir (`../..`, as git writes it);
  it holds no `config`, `hooks/` or `info/` (but a sparse worktree's
  `info/sparse-checkout`), which git never makes there; its `config.worktree`
  is empty, unless the repository has `extensions.worktreeConfig` and it was
  there when the session first looked (or copies the main worktree's, as
  `git worktree add` does); and its `gitdir` names a checkout's `.git` file
  that names it back, the one the session last saw it name where that one
  still does. **What fails is restored** to git's own form: `commondir` and
  `gitdir` written again, the `gitdir` from the back-link (the checkout's
  `.git` file, looked for in the worktree locations, beside the main
  checkout and where the session last saw it; never from the changed file),
  what git doesn't make moved aside into `.git/codeoid-held-worktrees/`
  (nothing is deleted), and so is an admin dir that appeared naming another
  worktree's checkout (a `git worktree repair` would point that checkout at
  it; one the repair already adopted is undone, the checkout's `.git`
  pointed back). **What can't be restored with certainty is said and left**:
  an admin dir replaced by a link (the link is removed, so git in its
  checkout stops with "not a git repository" instead of following it; look
  at where it led before putting anything back), one whose checkout nothing
  vouches for (run `git worktree repair <its checkout>`), one removed while
  its checkout still names it. Either way the session says so: a warning
  line naming the admin dir, what was found and what was done (event
  `sandbox.worktree_entry`), and the audit log (`session.worktree_entry_restored`,
  `session.worktree_entry_unrestored`).
- `git worktree add`, `list`, `remove`, `move` and `prune`, committing and
  rebasing in such a worktree, and in it in the session's next sandbox (a
  backend restarted, the next query, after a daemon restart: it is still in
  the session's folder), all work.
- **The session's own worktrees** are those it made: an admin dir first seen
  checked out in its folder, named by no other checkout. That is the
  session's record (for its life), never read again from the admin dir's
  `gitdir`, which a command can write: an admin dir someone else made never
  becomes the session's, and a name the session's own had, reused by
  another's, is looked at afresh. A worktree the agent creates is its own
  output, like the workspace (its files, its `.git` file, its HEAD and
  index), left writable in its next sandbox; its admin dir is still checked
  as above (a `commondir` or `config.worktree` there is read by your git in
  its checkout). Review it as you would the workspace.
- **The end-of-turn warning** ([above](#what-it-guarantees-and-what-it-doesnt))
  covers them: a checkout in the session's folder whose `.git` names anything
  but its own admin dir (a planted git dir with `core.fsmonitor` would run at
  your next `git status` there), or a `.git` dir planted in the folder, is
  named; so is an admin dir that was there and changed (its `commondir`,
  `gitdir` or `config.worktree`; for the session's own, a `gitdir` moved by
  `git worktree move` isn't news), and one that appeared naming another
  repository or carrying a config of its own. A worktree as `git worktree add`
  makes one appearing, or one removed, isn't news. Best effort: every
  worktree git records in the folder is looked at, and the folder's dirs to
  depth 3 (500 dirs) for anything planted besides.
- **A session started in a worktree** (its working directory) has it as its
  workspace, writable as any workspace: that is how to continue another
  session's worktree (`codeoid new <name> <that worktree>`).
- **Codeoid's own sessions and loops in a worktree it made** (`--worktree`, a
  fork, a loop run) are unaffected: codeoid makes those checkouts itself, its
  workspace's own git dir is held as before, and it gets a folder of its own.

`sandbox.worktreeRoots` (`CODEOID_SANDBOX_WORKTREE_ROOTS`, Settings > Sandbox
> More worktree locations): `~` expands; a relative one is the main
checkout's and climbs at most one level (`../wt`). Refused, at config load, in
a settings write and from the environment, with the reason: `/`, the home or a
dir holding it, anything in a hidden dir of the home (`~/.config`, `~/.local`,
`~/.ssh`, shell and systemd user dirs, the backends' and codeoid's own: tools
load programs and settings from there outside the sandbox), `~/Library`
(LaunchAgents), codeoid's config dir or a dir holding it, a system dir (`/usr`,
`/etc`, `/opt`, …), `.`, `..`; on macOS compared without regard to case, as
its filesystem does. A relative root is judged again, by the same list, where
it leads once resolved for the repository, links and all (`../.config` of a
repository at `~/proj` is `~/.config`: refused), and one inside the main
checkout is refused (nothing is made in your checkout). At a session's start,
also left out (and said on the sandbox's limits line): a root that is a link
or reached through one, one another user owns, one holding the repository or
its git dir, one inside a hidden path, a relative one refused where it leads;
and a root that doesn't exist, unless it is beside the repository (in the
main checkout's parent), where it is made: anywhere else codeoid never makes
it — create it to use it. The sibling location is made where its parent is
there; a submodule gets only the configured ones (its sibling would be made
inside its superproject).

Limits (defence in depth, as the rest of git's structure):

- **An admin dir someone else creates while the session's sandbox runs** (a
  worktree another session, codeoid or you add then) isn't held by that
  sandbox until its spec is next built (its setting changed, its backend
  restarted): it is in the writable `worktrees/`, so a command running then
  could change it (its `commondir`, `gitdir`, `config.worktree`, a link in
  its place); its checkout is never writable (it isn't in the session's
  folder). **The gap is from that change to the session's next check**, at
  the end of the turn it happened in (or at destroy; an admin dir that git
  may still be making, naming no checkout yet, is looked at again 2s later,
  never later however it is touched): in between, git in that checkout
  could follow what was planted (a `core.fsmonitor` in a planted git dir
  runs at its next `git status`). The check restores it at the turn's end
  and says so ([above](#git-worktrees-inside-the-sandbox)). Its HEAD and
  index aren't checked (they are the worktree's state, not where git
  looks): a command could rewrite them in that window, as it could commit
  there; and a `modules/` in it (a submodule's git dir of that worktree)
  isn't checked. One narrower case isn't caught: an admin dir of yours
  added at a path outside the worktree locations and not beside the main
  checkout, that a command points at a checkout planted in the session's own
  folder before the session's first look at it, is taken for the session's
  own (left writable to it, its HEAD and index the session's to change;
  still checked as above, so nothing of it runs). Add your worktrees beside
  the repository or in a worktree location, or while no session in that
  repository runs a turn.
- On **Claude's own sandbox**, a location inside your (hidden) home isn't
  shown: its CLI lays what is readable over what is writable, so showing it
  read-only would make the session's folder read-only too. There, a
  `git worktree add` elsewhere in such a location lands in the sandbox's
  scratch home, never on your disk, and leaves only a stale admin dir and its
  branch (`git worktree prune` removes the admin dir); other worktrees in the
  location aren't visible. Under bubblewrap, Seatbelt and Docker the locations
  are shown read-only and such an add fails.
- A checkout of yours **whose admin dir is already gone** (pruned while its
  disk was unmounted) isn't known to the sandbox: a command could make an
  admin dir under its name. git already treats such a checkout as broken
  ("not a git repository"); repair it (`git worktree repair`) before a session
  runs, or remove it.
- `git worktree add -b <branch> <path> origin/main` makes the worktree but
  can't record the upstream (`branch.<name>.merge` is in the repository's
  config, held read-only): git says "could not write config file". Pass
  `--no-track`, or set the upstream yourself.
- On Seatbelt `worktrees/` and each session folder are kept from being renamed
  by a `literal` write denial (not verified on a Mac: see below).

<a id="directories-bound-by-name-are-pinned"></a>

## Pinned paths

The sandbox lays each path it binds by name: the workspace (a monorepo's
repository top, when that is the workspace), the working directory, each
added directory, each project root, the session's worktree folders and
locations, the repository's git dirs and the session's other writable dirs,
its temp dir, every path it holds read-only, every directory it holds in
place. And the daemon works in a session's directories itself: its
snapshots, going back a turn, a fork's files. A path is only a name: a
command (another session's, or this one's from a directory it may write)
could move a directory aside and put a symbolic link (or another directory)
where it was, and the next use would lay, read or write where the link leads
(your home, writable; the daemon's private dir; a rewind writing into the
home). So every such path is **pinned** (#448 rounds 13 and 14), and goes
through one module, `src/daemon/sandbox/pinned.ts`:

- **Taken once**: by its real path, with its identity (device and inode) for
  a directory, when the session is created (the workspace, its repository top
  found then and kept, and the working directory), when a directory is
  granted, when a root is first resolved, and at each spec build for the rest.
  Kept with the session's setting (`pins`, never set by a client), so a
  restart keeps it; across a reboot only the inode is compared (device
  numbers are given out anew at boot). A held file (a repository's `config`,
  a project's `.mcp.json`) and what codeoid makes and removes itself (a
  worktree folder, a worktree location) are checked against links only.
- **Bound as pinned, never resolved again**: bubblewrap, Docker and Seatbelt
  name a pinned path as it was pinned, never by where it leads at a launch.
  Not pinned, by design: what is hidden (a link there hides more), the home's
  allowlist and a program's location (shown where a link leads), the owner's
  container sockets; none of them is where a sandbox writes.
- **Checked every time**: at every build of a sandbox, at every launch of a
  program inside one (the handle checks, and the argv it hands back checks
  again in the shell right before the program starts, with one `stat`, so a
  launcher written once — a process backend's, opencode's shell launcher,
  the git shim — checks at each run), when Claude's own sandbox is given its
  settings, and at the gate before every tool call. A path that is **reached
  through a symbolic link now, is another directory than the one pinned
  (moved aside and made again), or is gone** is never followed: the build or
  launch is refused ("codeoid sandbox: … is not the directory it was …: not
  run", exit 126), every tool call is refused with the same reason
  (`session.sandbox_pin_refuse`), and the session says what changed, once
  (event `sandbox.pin_changed`, audit `session.sandbox_pin_changed`) — a dir
  another session's command swapped included ("a directory held in place …
  is reached through a symbolic link now"), which is never re-pinned
  silently.
- **What happens next**: an added directory that changed is dropped at the
  session's next turn (said, as below); a root that changed isn't used, said
  ("…: not used — set the session's project roots again to use it as it is
  now"; setting them pins them anew); anything else bound is looked at again
  by the next turn's resolution. **A workspace or working directory that
  changed stops the session's commands** until it is the directory it was
  again: every call is refused, turn after turn; nothing is ever bound where
  the link leads.
- **No rename from inside**: a directory that holds something the sandbox
  shows or holds can't be moved aside by a command. On bubblewrap and Docker
  each is a mount point of its own (`mv`: "Device or resource busy"), on
  Seatbelt the directory itself isn't writable:
  - every directory between a writable directory and another one shown
    inside it (a workspace in an added dir: `b/vendor` between `b` and the
    workspace `b/vendor/lib`; a worktree folder in one);
  - every directory between a writable directory and a hidden path in it;
  - **the working directory and every directory between it and the
    workspace**, and every directory between a writable directory and a
    path held read-only in it (#448 round 14). A monorepo package session's
    package dir (`packages/app`) and `packages/` can't be moved aside to
    leave a planted `packages/app/.claude/settings.json` in their place, which
    a later Claude start there (a provider switch, a fork onto Claude, a new
    session) would load and run its hooks from on the host; neither can a
    repository inside an added directory (`b/lib`, its `.claude/` held), nor
    a submodule's git dir.

  On Claude's own sandbox such a directory isn't denied (its denial takes the
  subtree, which would make the workspace read-only): the CLI binds every
  directory from a writable root down to what it binds inside it, so each is
  a mount point there too. Checked on the real CLI
  (`sandbox-claude-real.test.ts`, "held in place"): moving a package dir, the
  dir above it, a repository inside an added dir, and the dir between a
  workspace and the added dir holding it all fail ("Device or resource
  busy"). The gate's check holds what the CLI doesn't.

### The daemon's own work in a session's directories

The daemon reads and writes the working directory itself, outside every
sandbox: the snapshot at each turn's start and end, going back a turn, a fork
from a turn (the worktree, the files it carries, the files it rolls back), a
fork's setup command, a client's file read, the project's MCP config, the
end-of-turn git looks. Each takes the working directory as pinned
(`PinnedDir`), checks it before and again after, and runs git with it as the
directory git starts in (`GIT_WORK_TREE=.`), so even a swap racing it can't
send the work elsewhere unnoticed. One that changed is refused, never
followed: "`<path>` changed under the session: it is reached through a
symbolic link now (…); going back a turn refused (never followed)", said on
the session once per change (event `workdir.changed`) and audited
(`session.workdir_changed`). Nothing of where the link leads is copied into
the session's snapshots, written or deleted. This holds for a session
without a sandbox too (its working directory is pinned at its first use).

What codeoid makes in a session's directories (the project settings'
placeholders, its entries in `info/exclude`, worktree folders, the CLI's
worktree dir) is made through the same module: in a directory checked before
and after, each directory on the way never a link, a file opened
`O_CREAT | O_EXCL | O_NOFOLLOW`, a file rewritten whole beside it and renamed
over it; an empty worktree folder is removed only where no part of its path
is a link. The look at the repository's worktree entries runs with the
repository's git dir pinned.

A static check (`src/tests/pinned-paths-static.test.ts`) fails when a direct
file-system use, a spawned program, a `cwd` or a `GIT_WORK_TREE` appears in
the sandbox, session or checkpoint modules without a `// paths:` comment
saying why it is safe (the daemon's own dir, the user's own config no sandbox
writes, a look, a path already checked through `pinned.ts`).

### An agent's own grant, shared later

A directory the agent added itself (an autonomous `request_directory`) is
never one another session writes (above). When another session comes to
work there afterwards (made in it, or given it), the next turn's resolution
lets the agent's grant go: said ("…, which the agent added, is no longer
writable: … is session "infra"'s workspace"), audited
(`session.sandbox_dir_dropped`). The owner can add it as theirs if both
should write it.

## Working across repositories

A session works in one directory, but work often spans several: a library
and the app that uses it, a fix in a client and its server, a look at what
another session did in its checkout. Two things open the sandbox up for
that, each as narrow as it can be.

### Project roots: other repositories, read-only

Everything under a **project root** is readable to the session's commands,
read-only, and to the backend's own file tools as the gate holds them
([below](#file-tools-that-run-outside-the-sandbox)). By default the root is
the **parent of the session's repository**: a session in `~/Workspace/codeoid`
reads `~/Workspace/*`, so `cat`, `grep`, `git log` and `git status` work in
the repositories beside it, and in the other sessions' checkouts there
(`~/Workspace/codeoid-worktrees/…`). For a linked worktree (a fork's) it is
the parent of the repository's main checkout. **A workspace that isn't in a
repository has no default root**, said on the session ("no project root: the
workspace isn't in a repository…"): a session in `~/Documents/notes` doesn't
read all of `~/Documents`. Name roots in `sandbox.projectRoots` for it.

- **Set it** daemon-wide with `sandbox.projectRoots`
  (`CODEOID_SANDBOX_PROJECT_ROOTS`, comma-separated; Settings > Sandbox >
  "Project roots"): a list of absolute dirs (`~` expands) and `@parent` (the
  default, the repository's parent). `[]` is none. Per session at create:
  `codeoid new … --project-root <dir>` (repeatable; replaces the daemon's
  list, `@parent` included only if you name it), `--no-project-roots`, the
  new-session dialog's "Readable project roots", or `session.create`'s
  `sandbox.projectRoots`. A root the daemon's default doesn't have is a
  widening (needs `session:approve` and an undelegated token, as below);
  fewer is narrower.
- **What stays hidden inside a root**: everything the sandbox hides anywhere
  — codeoid's config and data dirs, every agent CLI's login and the other
  [credential stores](#what-is-protected), `sandbox.hiddenPaths`, the
  desktop's runtime dir, container and (with the network off) local service
  sockets — and the **credential files anywhere in the root**, codeoid's own
  worktrees of the repositories there (`~/Workspace/b-worktrees/<fork>/.env`)
  included: `.env` and `.env.*` (not `.env.example`, `.env.sample`,
  `.env.template`), `.envrc`, `.npmrc`, `.pypirc`, `.netrc`,
  `.git-credentials`, `.vault-token`, `.pgpass`, `*.pem`, `*.key`, `*.p12`,
  `*.pfx`, `*.jks`, `*.keystore`, PuTTY's `*.ppk`, Apple's `*.p8`, private
  keys by their usual names (`id_*`, `*_rsa`, `*_ed25519`, `*_ecdsa`,
  `*_dsa`, `deploy_key`, `*_deploy_key`: with no extension or a key's or a
  backup's, never `.pub`; `id_generator.ts` or `crypto_rsa.go` is source,
  not a key), kubeconfigs (`kubeconfig*`, `*.kubeconfig`), Terraform state
  and variables (`*.tfstate*`, `*.tfvars`), `credentials` and
  `credentials.<json|yaml|toml|ini|…>`, `service-account*.json`,
  `secret(s).<json|yaml|toml|env|…>`, a project's
  `.claude/settings.local.json`, `.mcp.json` and `.docker/config.json`, and
  `.ssh/`, `.gnupg/`, `.aws/`, `.azure/`, `.gcloud/`, `.kube/`,
  `.password-store/` dirs whole; by what is in them, Yarn's `.yarnrc.yml`
  (`npmAuthToken`, `npmAuthIdent`) and `.yarnrc`, Composer's `auth.json`,
  and a Mercurial `.hg/hgrc` with an `[auth]` section or a password in a URL
  (a plain one stays readable). **Every git config git may read carrying a
  credential** is hidden too: a repository's `.git/config` and
  `config.worktree`, each worktree's `config.worktree` in `.git/worktrees/`,
  each submodule's config in `.git/modules/` (nested, a name with a slash
  too), a bare repository's or a mirror's (`mirror.git/config`), every file
  one of them includes inside the root (`include.path`, `includeIf.*.path`),
  a credential store one names in the root (`credential.helper = store
  --file=…`) and one by name in the git dir (`.git/credentials`). A config
  carries a credential when it has a URL with a user and a password (any
  scheme) or a user (https), a token in a URL's query (`?private_token=`,
  `access_token`, …), an `extraheader` in any syntax git reads (on its own
  line, after its section's header on the same line, under `[http
  "<url>"]`, any case), or a credential helper that is a shell snippet
  printing a password or token. This is said on the session: git in that
  repository then can't read its config from this session ("unable to access
  '.git/config'"). The session's own repository is its workspace, never a
  root's, so its git is unaffected (a fork's worktree uses its main
  checkout's git dir, which is its own too, and isn't said); the dirs its
  **owner** added are its to use as well; a dir the **agent** added itself
  keeps all this hiding ([below](#added-directories-other-repositories-writable)).
  They are looked for through the root's directories (not through links, not
  in `node_modules`, `.venv`, `__pycache__`, `.tox`, `.gradle`, `.next`,
  `.turbo`) when the session's sandbox is resolved, without holding up the
  daemon (the look lets other work run as it goes) and once per resolution:
  every sandbox built from it reuses it. One made later isn't hidden; add
  such paths to `sandbox.hiddenPaths`. **The look is bounded** (20000
  directories per root): a root with more to look through isn't used at all
  (fail closed), said on the session ("project root ~/src: more than 20000
  directories to look through…: not used — name narrower roots"); name the
  repositories you need instead of the folder holding them all. The default
  root says so plainly ("no project root: the default, the repository's
  parent (…), holds more than 20000 directories … (build outputs such as
  target/, build/, dist/ and vendor/ count; node_modules, .venv … don't): not
  used, so other repositories aren't readable — set sandbox.projectRoots …").
- **A root named through a link** (`~/code` → `~/Workspace`, or to
  `/data/code`) is used **where it really is**, said ("project root ~/code is
  /home/you/Workspace (where it really is): read there"): what is hidden in
  it is hidden there, and it is [pinned](#pinned-paths)
  there. (Named by the link, bubblewrap showed its credential files through
  the link's path, and Claude's sandbox made every command fail.)
- **Refused as a root**: `/`, your home or a dir holding it, anything in a
  hidden dir of your home (`~/.config`, `~/.local`, …: where tools load
  programs and settings from), `~/Library`, codeoid's config dir, a system
  dir (`/etc`, `/usr`, …), **the host's temp dir or anything in it**
  (`/tmp`, `/var/tmp`, the daemon's `TMPDIR`, macOS's `/private/tmp` and
  `/var/folders`: codeoid's private dir and every program's sockets and
  scratch files are there), a relative path. The config fails to load on
  one; a session's own is refused at create. A default in a temp dir (a
  repository at `/tmp/x/repo`) falls back to no root, said. **A default that
  would be your home**
  (a repository directly in it, `~/proj`) falls back to no root, said on the
  session ("no project root: the default, the repository's parent (…), is
  your home…"): set `sandbox.projectRoots` to read your other repositories.
- Writing there stays refused: "Read-only file system", as anywhere else
  outside the workspace.

### Added directories: other repositories, writable

A session can be given **more directories to write**, each treated as its
workspace is: writable, its repository's git structure (config, hooks,
`info/`, the other worktrees' admin dirs, …) and project settings
(`.claude/`, `.mcp.json`, …) held read-only and made first where missing,
and so are those of **every repository inside it** (a folder of
repositories: each one's git structure, its project settings at its top, and
every project settings dir or file and bare repository anywhere in the
folder, looked for when the sandbox is built, not in `node_modules` and the
like),
the session's own [worktree folder](#git-worktrees-inside-the-sandbox) in
its repository's locations (`~/Workspace/b-worktrees/<session folder>/`), a
host-side file tool writing its git structure or settings asked about
([held writes](#file-tools-that-run-outside-the-sandbox)), and the
end-of-turn look at its git settings and commits (`sandbox.git_changed`,
`sandbox.settings_committed`, naming the directory; each repository inside
it too). What the sandbox hides stays hidden inside one, and how much of the
rest is readable depends on who added it:

- **Added by the owner** (`/sandbox add`, `--add-dir`, the new-session
  dialog, `session.create`, or the owner saying yes to the agent's
  request): it is treated as a workspace, so its **credential files are
  readable** to the session's commands (its `.env`, its keys, a token in its
  git config), as the workspace's are. The owner's card says so ("…; its
  credential files (.env files, keys, a token in a git config) become
  readable to its commands, as the workspace's are").
- **Added by the agent itself** (an autonomous `request_directory`): it
  stays writable, but **a project root's credential hiding stays in it**,
  the same names, the same git configs (so git there can't read a config
  carrying a credential, said); a dir too big to look through for them isn't
  added (said). The agent is told ("Its credential files … stay hidden to
  you"). Kept with the session's setting (`agentDirs`, never set by a
  client), so a restart, a fork and a resume keep it. The owner can add it
  as theirs (`/sandbox add <dir>` again: asked on the session, with the card
  above), which makes its credentials readable.

**An added directory is the directory it was when it was granted.** What is
kept, and bound, is where the path really leads at that moment (its real
path): the owner's card names it, and the path asked for when that differs
("… (`<asked>` leads there)"). At every later build of the sandbox, a kept
directory that no longer is a directory at that real path, or is reached
through a link now (replaced by one, removed, moved), is **dropped**: not
writable, said on the session ("<dir> is no longer writable: …", event
`sandbox.dir_dropped`), audited (`session.sandbox_dir_dropped`) and taken
out of the setting; it is never followed to where a link there leads. Add it
again if it should be.

**Adding one is a widening**, so it is the owner's own decision:

- **By the owner**: `/sandbox add <dir>` and `/sandbox remove <dir>` (every
  frontend), `codeoid sandbox add|remove <session> <dir>`,
  `codeoid new … --add-dir <dir>` (repeatable), the new-session dialog's
  "Also writable", `session.create`'s `sandbox.addedDirs`, the
  `session.sandbox_dir` message. Adding needs `session:approve`, the
  session's owner and an undelegated token; on a running session it is a
  confirm on the session ("Let "<name>" write <dir>?") that only the owner's
  own token answers (`codeoid approve <session>`, or any frontend). Removing
  is narrowing: applied, by a delegated token too. Audited:
  `session.sandbox_dir_ask`, `_added` (`by=owner`), `_denied`, `_removed`.
- **Asked for by the agent**: codeoid's `request_directory` tool
  (`path`, `reason`). In **guarded and interactive mode** the owner gets a
  confirm card naming the directory and the agent's reason ("The agent asks
  to write <dir>"), answered by the owner's own token only; the agent reads
  the answer. In **autonomous mode** only **a repository, or a directory in
  one, strictly under one of the session's project roots, named by a path
  with no symbolic link in it** is added at once, unasked (audited: `by=agent
  a repository under a project root, autonomous`): judged where it really is,
  and never a root itself, a folder holding repositories, a git or settings
  dir. **Never another session's or codeoid's checkout either**: a dir that
  is, is inside or holds another session's workspace, worktree folder or
  added directory (their commands write it: what they put there, a link
  included, this session's next command would run against), a checkout in
  a worktree location (`<repo>-worktrees/<name>`, `<repo>/.worktrees/`,
  `sandbox.worktreeRoots`': forks, loops, `--worktree` sessions, other
  sessions' folders) but its own folder, a dir holding such a location, or
  another checkout of the session's own repository (its main checkout, seen
  from a fork's worktree). The owner may still add one: the card warns
  ("Warning: <dir> is session "x"'s workspace … — a change either session
  makes there … the other one runs against"). The added dir is the agent's
  own (above): its credentials stay hidden. Anything else is refused at once with a reason the agent reads ("…
  isn't in a repository …", "… goes through a symbolic link …", "… isn't
  under this session's project roots …; the owner can add it (`/sandbox add
  <dir>`)"). **An unattended run** (a routine's, a loop worker's, a
  dispatched worker's) follows its mode: in autonomous mode (routines'
  default, every loop worker) the autonomous rule above, so it can be given
  a repository under a project root unasked; in guarded or interactive mode
  it is never parked on the question: refused, said. The call returns "no answer
  yet" if the owner hasn't answered within 8 minutes (45 seconds on opencode,
  whose MCP client gives a call about a minute); the card stays open, a later
  yes still adds the directory, and asking again for the same one waits on
  that card rather than raising another. Audited:
  `session.sandbox_dir_request`, `_added` (`by=agent …`), `_refused`.
- **Refused as an added dir**: everything refused as a root (above; the
  host's temp dir itself, but a dir in it may be added), and a dir that
  isn't there, isn't a directory, isn't yours, is inside what the sandbox
  hides (codeoid's data dirs, a credential store, a `sandbox.hiddenPaths`
  entry, the daemon's private dir), holds a dir on the daemon's `PATH` (a
  program written there would run outside the sandbox at your next
  command), **is or is inside a project settings dir** (`.claude/`,
  `.codex/`, `.gemini/`, `.qwen/`, `.pi/`, `.opencode/`), **a `.git` or
  `.hg` dir, a git dir** (a bare repository, a worktree's admin dir) **or the
  repository's `core.hooksPath` dir** (git and the agent CLIs run what is
  there outside the sandbox), or holds more than 20000 directories to look
  through for the repositories and settings in it ("… couldn't all be
  protected — add the repositories you need one by one"). One inside the
  workspace, the session's own worktree folders or its temp dir, or an added
  dir, is writable already; adding a dir that holds an added one replaces
  it.
- **Kept**: in the session's sandbox setting, so a daemon restart and a
  resume keep them, and a fork, a compare and a collaboration's children
  inherit them (a fork carries them for the parent's owner only, undelegated,
  as any [wider sandbox](#choosing-a-sandbox)). A routine's added
  directories are checked when it is defined or edited, as a session's are
  when it is created (one that can't be added refuses the routine), and kept
  by their real path (`~/…` and a link-named one included); each run's
  session [pins](#pinned-paths) them when it starts.
  An added dir inside another isn't kept twice: the outer one holds it.

`request_directory`, per backend:

| Backend | How it's delivered |
| --- | --- |
| Claude | in-process MCP server (`mcp__codeoid_sandbox__request_directory`), pre-approved: the session decides it |
| Qwen Code | in-process MCP server, the same |
| pi | a tool in codeoid's bridge extension, as registry servers' are |
| Codex, Gemini CLI, opencode | the daemon's `/mcp/sandbox` endpoint (loopback only), a token of the session's own (Codex reads it from `CODEOID_SANDBOX_TOKEN`, kept out of its commands' environment by `CODEOID_*_TOKEN`); Codex's call timeout is raised past the 8-minute wait |
| OpenAI, Gemini, llama.cpp | none: these run no commands, so there is no sandbox to widen |

The gate never asks about the call itself (it is the ask); its card is the
session's own confirm.

### When a change takes effect

An added or removed directory takes effect **at the session's next turn that
starts with no turn, approval or background work running** — never in the
middle of work, which a rebuilt sandbox would end. The agent is told
("writable … from your next turn"); until then the session's info lists it
as pending (the chip: "from the next turn: +<dir>"), and an info line says
when it applied.

| Backend | What happens at that turn |
| --- | --- |
| Claude (its own sandbox) | its query is built again with the new directories (it resumes the same conversation) |
| Claude under Docker, Codex, pi, the Gemini CLI, Qwen Code | the backend's process is restarted in the new sandbox before the turn (the conversation resumes; the Gemini CLI is handed its history) |
| opencode | the session's shell lines run in the new sandbox (its launcher is written afresh each turn); its server keeps running |

With background work running (a Claude background agent, a background shell),
the change waits until it has ended; the confirm says so.

### A workspace that is your home

Starting a session in a parent directory makes that directory its workspace,
writable: start it where the work is. A session whose workspace is **your
home itself** is allowed, but then nothing of your home is hidden but what
the [hidden list](#what-is-protected) names: every project, dotfile and
setting in it is readable and writable to its commands. The chip says
**"sandboxed: workspace is your home — only credentials are protected"**, as
do `codeoid ls` and every approval card; project roots don't apply (all of the
home is the workspace).

### Limits

- On **Claude's own sandbox**, a root that holds what the session writes (the
  default does: it holds the workspace) is shown entry by entry around it:
  its CLI lays every readable bind after every writable one, so showing the
  root whole would make the workspace read-only (checked: every command then
  fails). A dir made in the root after the query started isn't shown until
  the next query.
- On **Claude's own sandbox**, a link in such a root is left out, not shown
  by where it leads (the CLI binds real paths: `~/Workspace/keys → ~/.ssh`
  would show `~/.ssh`), and so is an entry that is itself hidden (a `.env`
  at the root's top, codeoid's private dir, a `sandbox.hiddenPaths` entry):
  the CLI lets a readable path equal to a hidden one win. A hidden path
  deeper in a shown entry stays hidden (checked on the real CLI: it lays a
  hidden path inside a readable one after it). On bubblewrap a link in a
  root dangles where it leads into what is hidden.
- The credential files hidden in a root are those found when the sandbox is
  built, by name, outside dependency dirs (above); a file of credentials
  named otherwise (`notes.txt`) is readable. A root too big to look through
  isn't used.
- The default root shows **every repository beside yours**, read-only: their
  source, their git history, and any credential in a file not named above. Set
  `sandbox.projectRoots: []` (or `--no-project-roots`) where that is too
  much, and `sandbox.hiddenPaths` for what must stay out.
- An added directory that is **another worktree of the session's own
  repository** (the owner's to add; never added autonomously) is writable,
  and its own admin dir with it; the rest of the repository's structure
  stays held.
- [Pins](#pinned-paths) are checked right before a
  program starts, by path: a process **outside** this session's sandboxes
  that writes the parent of a bound directory (another session the owner let
  write the same tree, which its card warned of) and swaps it back and forth
  could still land a swap between the check and bubblewrap's bind; the same
  between the daemon's own check of the working directory and the start of
  the git it runs there (the check after it says so, but can't take back
  what that git did). Within the session's own sandboxes the parents, the
  working directory and the dirs on its way up can't be moved (mount
  points), and no autonomous grant overlaps another session's checkout (one
  that comes to, is let go at the next turn).
- A path held but **missing when the sandbox was built** (a worktree folder
  removed while empty, a location) is checked against links only, and only
  when it is there: one made between the launch's check and its bind isn't
  checked. Its location is read-only to every sandbox, so only a process
  outside them could make it.
- The credential files hidden in a root or an agent's own added directory
  are those **found when the sandbox was resolved** (each turn's start at
  most): one your own tools write there meanwhile (an `.env` an env pull
  makes, a token written into that repository's `.git/config`), or one
  another session renames within a directory it writes, is readable to the
  session's commands until its next resolution.
- The keys hidden in a root are found by name; a private key named
  otherwise (`notes.txt`) is readable.
- The repositories and settings dirs held inside an added directory are those
  found when the sandbox is built, outside `node_modules` and the like: one
  the agent makes there later (`git init`, a new `.claude/`) is its own work,
  as in the workspace (what runs after the agent touched it isn't vouched
  for).

## Docker access

Tests that start containers (testcontainers' MySQL or Postgres, `docker run`
in a script) need the container runtime's socket, which the sandbox hides on
purpose: **a container socket is root on the machine** (a command can start a
container that mounts `/` and read or change anything, your credentials
included). So it is an **opt-in, off by default**:

- daemon-wide: `sandbox.docker.socket` (`CODEOID_SANDBOX_DOCKER_SOCKET=true`,
  Settings > Sandbox > Docker access), which needs `settings:write` from an
  undelegated token, as every `sandbox.*` setting;
- per session: the setting's `dockerSocket: true` — `codeoid new … --docker-socket`,
  the new-session dialog's "Docker access" box, `/sandbox <provider> … docker`,
  `codeoid sandbox set <session> … --docker-socket` (`--no-docker-socket`,
  `/sandbox … nodocker` take it away); routines and loops `--docker-socket`.

Turning it on is a **widening**, under the same rules as turning the sandbox
off or widening the network: on a session, a confirm only its owner answers
with their own token, in every mode, audited (`session.sandbox_widen_ask` …
`session.set_sandbox`, "→ auto, network on, Docker access"); at create, fork,
compare, routine or loop start it needs `session:approve` and an undelegated
token when the daemon's default doesn't give it; a delegated token can't ask
for it. Turning it off is applied at once. A session with Docker access is
switched to autonomous only by its owner's own token; autonomous mode,
routines and loops then run on it (the owner chose it, as with `off`).

The session says so plainly: its chip reads **"sandboxed, Docker access"**
(amber; the tooltip: "Docker access can reach the whole machine (a container
can mount /)"), `codeoid ls` "sandbox: bubblewrap, network on, Docker access
(can reach the whole machine)", the sandbox's limits name the socket, and
**every approval card** reads "⚠️ sandboxed, Docker access: …" (a file tool's
card adds "(the sandbox has Docker access)").

What a command gets:

- **The host's runtime sockets that exist**, each at its own path: `$DOCKER_HOST`'s
  when it is a unix socket, Docker's `/var/run/docker.sock`, rootless Docker's
  `$XDG_RUNTIME_DIR/docker.sock`, Podman's (`$XDG_RUNTIME_DIR/podman/podman.sock`,
  `/run/podman/podman.sock`); on macOS Docker Desktop's
  `~/.docker/run/docker.sock` and `/var/run/docker.sock`, Colima's, OrbStack's,
  Rancher Desktop's. Nothing else of the dirs holding them: the rest of
  `$XDG_RUNTIME_DIR` (keyring, D-Bus, agent sockets) stays hidden, as do
  containerd's and the other runtimes' sockets.
- **`DOCKER_HOST`** naming the first of them (the docker CLI and testcontainers
  read it). Never the client's credentials: `~/.docker` (`config.json`, its
  registry logins and credential helpers) stays hidden, so pulling a private
  image fails inside — pull it yourself first. A docker context of yours isn't
  there either; `DOCKER_HOST` is.
- The network is still the session's: reaching a container's published port
  (`localhost:<port>`, how testcontainers connects) needs the network `on`
  (the default); with it `off` a command can start containers but not reach
  them over TCP.

Per provider:

- **bubblewrap**: each socket bound read-only at its own path (connecting
  needs no write to the mount; it can't be removed or replaced), over the
  hidden dir holding it; a pathname socket works across the sandbox's network
  namespace, so with the network off too.
- **Claude's own sandbox**: the socket allowed for reading (only) through the
  denied home and runtime dir; on macOS it is allowed by path
  (`allowUnixSockets`). On Linux its sandbox refuses to create any unix socket
  (checked on the real CLI: `socket(AF_UNIX)` fails with "Operation not
  permitted") unless all are allowed, so Docker access turns on its
  `allowAllUnixSockets`, and then **any unix socket a command can see is
  connectable**. So, with Docker access on, the host's `/tmp` and `/var/tmp`
  are denied as well (the CLI's sandbox otherwise keeps them: tmux's
  `/tmp/tmux-<uid>/`, X11's `/tmp/.X11-unix/`, an `ssh-agent`'s `/tmp/ssh-*/`,
  an IDE's sockets), only what the sandbox shows again in them (the session's
  temp dirs, a workspace there) remaining; every other runtime socket, the
  desktop's runtime dir (its bus, keyring, gpg and ssh agents), the system bus
  and screen's dir are hidden; its network namespace has none of the host's
  abstract sockets (checked on the real CLI: a tmux-style socket planted in
  the host's `/tmp` is out of reach, the runtime's is reached, the network
  proxy still works). **What stays reachable** there, said on the sandbox's
  limits line and in the confirm: a socket in the workspace or the session's
  worktree folders, in what your home shows (`sandbox.homeReadable`), or in a
  system dir open to every user outside the home and `/tmp` (systemd's
  journal, printing, snapd's; a local database's only with the network `on`,
  [above](#what-is-protected)). A runtime socket you can't connect to (not in
  its group) isn't counted: Docker access then says it found one you can't
  use, and nothing is opened up.
- **Seatbelt**: the socket's file (read, and written as data: never removed or
  renamed) and a connection to it allowed last, by its own path and where it
  leads, the network off too (not verified on a Mac).
- **Docker** (the provider): the runtime's socket mounted at
  `/var/run/docker.sock` in the container (Docker Desktop's own name for it on
  macOS), with its group added so the container's user can connect, and
  `DOCKER_HOST` naming it. A container started from there is a sibling on the
  host's runtime, not nested.
- **Codex** under bubblewrap: the socket is shown in codeoid's bubblewrap
  around the app-server; whether codex's own sandbox (nested in it) lets a
  command connect to it isn't verified here.

## Committed project settings

**Starting a Claude session in a repository trusts its committed project
settings**: `.claude/settings.json` (its hooks run on this machine, as the
CLI's own process, outside any sandbox), `.mcp.json`'s servers once
approved. That is Claude Code's own model, and every agent CLI has its
equivalent (opencode's `opencode.json` and `.opencode/` plugins, the Gemini
CLI's and Qwen's `settings.json`, Codex's `.codex/`, pi's `.pi/`). The sandbox
holds those files read-only in the working tree, but it can't vouch for what
an agent **committed**: git's object store and refs must stay writable for
commits, so an agent can commit a `.claude/settings.json` with hooks through
git plumbing (`hash-object`, `commit-tree`, `update-ref`) without it ever
being in the working tree. A worktree checked out from that commit, a clone,
or your own checkout after a merge then carries it, and the next session
started there runs its hooks.

That is why a session says so: at the end of each turn and when it is
destroyed, a commit that became reachable from any ref or HEAD since the
last look (HEAD moved, a branch or tag added or moved; counted from the
session's first turn) and that changes one of
`.claude/settings*.json`, `.claude/hooks/`, `.mcp.json`, `opencode.json`,
`opencode.jsonc`, `.opencode/`, `.gemini/settings.json`,
`.qwen/settings.json`, `.codex/`, `.pi/` (at any depth: a session may start
in a subdirectory; against each parent, a root commit against nothing) is
named in a warning line, with its files (event `sandbox.settings_committed`,
audited `session.settings_committed`). **Review those commits
(`git show <commit>`) before a session runs where they are checked out.**
The look runs the daemon's hardened git (nothing the repository's config
names runs; only names are compared) and reads at most 500 new commits per
look (the line says when there were more). A commit the session's agent
didn't make, if made in the same repository meanwhile (by you, or another
session there), is named too. A commit no ref or HEAD names isn't (nothing
checks it out). Best effort: when git can't say, the next look covers the
time since the last one that could.

## Approval cards

Every card carries `sandboxed` and `sandboxNote` (web, TUI/CLI, Telegram,
`session.approvals`): "🛡 sandboxed: bubblewrap, network on", "⚠️ runs in the
backend's own process, outside the sandbox" (a Claude or opencode file tool),
"⚠️ not sandboxed: …", "⚠️ asks to run outside the sandbox". The risk level is
still shown: inside the sandbox it is guidance about what the command would do
to the workspace. In autonomous mode it is information only (the audit log's
`session.auto_approve … risk=high`): a command of any level runs there.

## Limits

- **Network `on` shares the host's network.** A sandboxed command can reach
  every service listening on localhost: a database, a dev server, a local
  model server, an admin API, whatever you run there, with only that
  service's own authentication between them (and, under bubblewrap and
  Seatbelt, abstract Unix sockets: an X11 or D-Bus abstract address).
  codeoid's own port is one of them: nothing it answers without the token
  hands the token out or acts (the web UI is signed in by a one-time link,
  never by being on the loopback: docs/local-mode.md), and the token's file
  is hidden. For unattended work (routines, loops, autonomous sessions), or
  next to local services that trust the loopback, use `sandbox.network: off`
  (`CODEOID_SANDBOX_NETWORK=off`, or `--network off` per session) or an
  `allowlist` of the hosts the work needs (enforced on Claude's own
  sandbox; elsewhere an allowlist runs with the network off). With the
  network `off` under bubblewrap a command has its own loopback and none of
  these, and local services' unix sockets (a Postgres, MySQL or Redis that
  lets you in by who you are) are hidden too ([above](#what-is-protected));
  with the network `on` they are reachable.
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
  add them to `sandbox.hiddenPaths` or keep them out of the workdir. Those at
  the top of the other projects under a project root are hidden
  ([above](#project-roots-other-repositories-read-only)). A
  workspace that is your home itself shows the home (the hidden list still
  applies in it; [the chip says so](#a-workspace-that-is-your-home)); one
  that holds it (`/home`) hides it.
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
  `git sparse-checkout`, editing `.git/info/exclude`, and removing or changing
  a worktree the session didn't make fail inside a command; run them
  yourself. Adding, using and removing worktrees of its own in the worktree
  locations works ([above](#git-worktrees-inside-the-sandbox)). The Claude
  CLI's sub-agent worktree isolation works: its git may write `worktrees/`
  and `.claude/worktrees` ([above](#a-backend-clis-own-git)); its
  `EnterWorktree` is refused ([above](#the-claude-clis-own-worktrees)).
  A driver a planted config names, run by that git, may write them too: a
  worktree checked out or planted there is the agent's content like the rest
  of the workspace (its `.claude/` settings included), not something the
  sandbox vouches for. A repository whose `.git`
  names a git dir git's own records don't name back (`--separate-git-dir`)
  is read-only inside: commits there fail. The placeholders (`commondir`
  holding `.`, the empty `remotes/`, `branches/`, `worktrees/` in the git
  dir, the empty `HEAD/` at the top of the workspace) are what let bubblewrap
  and Docker hold these read-only (a mount needs something to mount on, and a
  git dir must stay writable for git's lock files); they stay after the
  session (`git worktree prune` can't remove `worktrees/`, which is bound
  while a sandbox runs; outside, it removes an empty one and it is made
  again). A `.git` that is a symlink can't be held. A top-level `HEAD` that
  is already a file or a non-empty dir of the project isn't held (on a
  case-insensitive disk, a `head` too). `worktrees/` is writable (a command
  may add a worktree), each worktree's git dir in it held but the session's
  own, so a worktree someone else adds while a sandbox runs isn't held by
  that sandbox; what a command changes in it is restored at the turn's end
  ([above](#git-worktrees-inside-the-sandbox)). Not held,
  because they are the workspace's own content: a repository planted in a
  subdirectory of the workspace (a `.git` made in a directory that had none,
  an uninitialised submodule's path included) is used by your git there, and
  by your `git status` in the superproject for a submodule path. A rebase or
  cherry-pick in progress (`rebase-merge/`, `sequencer/`) can carry `exec`
  lines written inside: look before `git rebase --continue` on a state you
  didn't start.
- **The workspace is code.** What a sandboxed command writes in the
  workspace runs the next time you build, test or commit there: a
  `package.json` script, a test, a Makefile target, and a hook in a
  `core.hooksPath` inside the repository (husky's `.husky/_`, often
  gitignored, so `git status` doesn't show a hook planted there). These are
  the workspace's own content, so they stay writable; the end-of-session
  warning (above) names a changed hooks path, and the rest is the review of
  the agent's output you'd do anyway.
- **Git's structure, known limits** (defence in depth, above): a repository
  planted in a subdirectory of the workspace (a `.git`, or a bare
  repository's `HEAD`/`objects/`/`refs/`, made where there was none) is used
  by your git started there (a session's workspace is its repository's top,
  so the session's own workdir is never such a directory, unless its
  repository is one codeoid doesn't widen to: above the home, a `.git` file
  git's records don't name back); a symlinked `.git`
  can't be held; a top-level `HEAD` that is already the project's isn't
  held; the admin dir of a worktree someone else adds while a sandbox runs
  isn't held by it until its spec is next built, only checked (and
  restored) at the turn's end, nor a checkout of yours whose admin dir is
  already gone; a
  worktree the agent made in its own folder has none of this protection (the
  end-of-turn warning names its `.git` pointed elsewhere); a `.git` file git's records don't name back is held but
  unverified. Your global `safe.bareRepository=explicit` closes the bare
  repository fallback entirely. None of these reach the git a backend CLI
  runs for itself, which is contained ([above](#a-backend-clis-own-git)):
  they are about git you, or another tool on the host, start there.
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
- Working across repositories, real bubblewrap
  (`src/tests/sandbox-project-roots-real.test.ts`): a session in
  `<root>/a` reads `<root>/b` (`cat`, `grep -r`, `git log`, `git status`)
  and can't write or commit there ("Read-only file system") while its own
  workspace stays writable; `b/.env` and `.env.local` are hidden, its
  `.env.example` readable, codeoid's config dir and a `sandbox.hiddenPaths`
  dir inside the root and the home's `~/.ssh` hidden, `grep -r` over the root
  finds none of them; added, `b` is written and committed in, its hooks,
  config and `.claude/` refused, a worktree added in its own folder of
  `b-worktrees/` and refused elsewhere there, the user's next git in `b`
  running nothing planted, its `.env` readable. The real Claude CLI
  (`sandbox-claude-real.test.ts`, "project roots and added dirs"): the root
  around the workspace is readable, the workspace writable, `b` read-only
  and its `.env` hidden; added, `b` writable; handing the CLI the root whole
  instead makes the workspace read-only (every command fails), which is why
  it is split. Round 12: real bubblewrap, an added dir swapped for a link
  after it was granted and a link kept as one aren't written through (the
  target untouched); a settings or git dir given as one is left out; a
  folder of repositories added writes their files but not a repository's
  hooks or config, its `.claude/` or a `.codex/` deeper; credential files
  anywhere in a root (a key, a `.pem`, a deep `.env`, a tfstate, `.aws/`,
  `.claude/settings.local.json`, a sibling worktree's `.env`, a `.git/config`
  with a token: git there then can't read its config) are hidden, `.pub`
  readable; a root past the look's bound isn't shown; a repository in the
  host's temp dir gets no default root. Round 13
  (`src/tests/sandbox-pins-real.test.ts`, real bubblewrap): the workspace, an
  added dir or a root swapped for a link to a planted home between two
  commands (or made anew) is refused, by the handle and by a launcher written
  before the swap (exit 126), and the planted key isn't read nor its
  `.bashrc` written; a workspace inside an added dir: the dir between them
  can't be moved aside ("Device or resource busy"); an agent's own added dir
  is written but its `.env`, `.aws/`, deploy key, a deep `.env` (its dirs
  moved aside too) and token-bearing `.git/config` aren't readable, the
  owner's are; a bare mirror's, a submodule's and a worktree's config, an
  included file, a store in the git dir, `github_ed25519`, `*.ppk`, `*.p8`,
  `id_work`, an `hgrc`, a `.yarnrc.yml` and an `auth.json` with credentials
  are unreadable through a root, `id_generator.ts` readable; a link-named
  root's `.env` is hidden by both paths. The real Claude CLI: a link-named
  root holding the workspace is read and its `.env` hidden, the workspace
  writable. The real Claude CLI: a project root
  shows no `.env` at its top, nothing a link in it leads to (`~/.ssh`,
  `~/Documents`, the home), no sign-in in codeoid's private dir inside it, no
  deeper key or sibling worktree's `.env`, while the rest of the root reads
  and the workspace writes. Round 14, real bubblewrap:
  `src/tests/sandbox-held-real.test.ts`: a monorepo package session can't
  move its package dir or `packages/` aside, nor put a link where its working
  directory was, nor write the package's `.claude/settings.json`, while it
  writes the package and runs git; a repository inside an added dir can't be
  moved aside; a working directory made anew refuses the build by its
  identity. `src/tests/sandbox-bound-pinned-real.test.ts`: a dir held in
  place in one session's spec (an agent dir's hidden `.env`'s dir) swapped by
  another session's command for a link to a planted daemon dir or another
  repository refuses the first session's next command, by the handle and by
  a launcher written before (exit 126), and nothing lands there; a held
  `.claude/` swapped for a link refuses too. The real Claude CLI: the same
  moves fail there ("Device or resource busy"), the dir between a workspace
  and the added dir holding it included. Through the real SessionManager and
  real git (`src/tests/workdir-pinned.test.ts`): a package dir swapped for a
  link to a planted home (or made anew) between turns isn't snapshotted;
  going back a turn, a fork from an earlier turn and a client's file read
  are refused, said and audited; the planted home is untouched.
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
- Round 6, the real Claude CLI (`sandbox-claude-real.test.ts`, "the Claude
  CLI's own worktrees"): `EnterWorktree` runs without reaching `canUseTool`
  and makes a worktree; with codeoid's PreToolUse refusal it makes none and
  the model is told why. Whether the CLI loads a worktree's committed hooks
  after entering it: see [The Claude CLI's own worktrees](#the-claude-clis-own-worktrees).
- Worktrees (#448 follow-up), real bubblewrap (`sandbox-worktrees-real.test.ts`):
  from inside, `git worktree add ../repo-worktrees/x -b feature/x`, a commit
  and a rebase there, `git worktree list`,
  `git worktree remove` and `git worktree prune` work, and the branch
  is there outside; a worktree made in one sandbox is committed in and removed
  (`--force`) in the session's next. Each of these is refused, from a plain
  repository and from a linked worktree in the sibling location, and the
  user's next git (outside the sandbox) runs nothing planted: an existing
  worktree's `commondir`, `gitdir` or `config.worktree` rewritten; its admin
  dir renamed, removed, or something made in or beside it under its name;
  `worktrees/` renamed away; `git worktree remove --force` of the user's
  worktree in the sibling location (its files stay), its `.git` file
  redirected or a file written in it; the `.git` file of the user's worktree
  outside the locations redirected; `git worktree prune` of the user's
  worktree whose checkout is gone; the repository's config, hooks and `info/`
  written. A worktree someone else added after the session started isn't held
  by its running sandbox and doesn't rebuild it; what a command changes in its
  admin dir is restored at the turn's end (below), and it is held once the
  spec is next built; a configured `sandbox.worktreeRoots` location is
  writable, `..` and `~` aren't taken.
- Worktree admin dirs (#448 round 11), real bubblewrap
  (`sandbox-worktree-entries-real.test.ts`): admin dirs added while the
  session's sandbox runs, then changed inside it: a `gitdir` pointed into the
  session's folder (with and without a checkout planted there naming it
  back), a `commondir` at a planted git dir with `core.fsmonitor`, a
  `config.worktree`, `config` and hook planted, the admin dir replaced by a
  link to a copy whose `../..` is a planted git dir. At the turn's end each is
  restored (the link removed and said), said once, never taken for the
  session's own, and the user's next git there runs nothing planted; the
  session's spec object is the same throughout. Admin dirs planted naming the
  user's worktree's checkout are moved aside before `git worktree repair`
  can adopt one, and one it already adopted is undone (the checkout's `.git`
  pointed back). A name the session's own worktree had, reused by the user's,
  is checked as the user's. Nothing is made in the checkout; the session's
  sibling folder and `<repo>-worktrees/` go while empty, come back for the
  next turn, and stay with a worktree in them. A unix socket standing in for
  `/run/postgresql` is out of reach with the network off and reachable with it
  on; `../.config` of a repository in the home is refused and never made. The
  Claude provider (`provider-claude.test.ts`): a worktree added and one
  removed elsewhere in the repository leave its query as it was (no rebuild,
  no background tasks dropped); its own sandbox changing still rebuilds it. `sandbox-bwrap-real.test.ts` G: a worktree added while
  a sandbox runs is held by the next, and a `commondir` rewritten meanwhile is
  named by the end-of-turn look. The real Claude CLI
  (`sandbox-claude-real.test.ts`): under its own sandbox a command adds a
  worktree in `<repo>-worktrees/`, commits there and removes it, while the
  user's worktrees and the config stay held.
- Docker access (#448 follow-up), with a planted listening socket standing in
  for rootless Docker's in a hidden `$XDG_RUNTIME_DIR` (no Docker daemon is
  reachable here): under real bubblewrap it can't be connected to by default;
  with the option it can (network off and on), `DOCKER_HOST` names it and the
  rest of the runtime dir stays hidden. Under the real Claude CLI's sandbox
  the same, and without `allowAllUnixSockets` its Linux sandbox refuses to
  create a unix socket at all.

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
9. Worktrees: that a `literal` write denial on `worktrees/` and a worktree
   location (pinned as writable git dirs are) refuses `mv` of the dir while
   `git worktree add` can make a new admin dir and checkout in it; that an
   existing worktree's admin dir (`subpath` deny) can't be renamed.
10. Docker access: with Docker Desktop, a sandboxed `docker ps` reaches
   `~/.docker/run/docker.sock` (and through `/var/run/docker.sock`'s link),
   the network off too; Claude's own Seatbelt sandbox with `allowUnixSockets`.

**Docker** (no Docker daemon was reachable here): `CODEOID_TEST_DOCKER=1 bun test
src/tests/sandbox-docker.test.ts` runs the container checks. Also to check: the
Claude CLI in the default image (it needs glibc), codex's app-server in a
container, opencode's per-line latency, a rootless Docker's `DOCKER_HOST`
reaching the client from a launcher (opencode, Qwen), and Docker access from
the Docker provider (the socket at `/var/run/docker.sock` with its group
added, testcontainers starting a sibling container) and from a real Docker
socket under bubblewrap (`docker ps`, testcontainers' Ryuk).

## How it is built

- `src/daemon/sandbox/types.ts` — the `SandboxProvider` contract;
  [sandbox-providers.md](sandbox-providers.md) describes it and how to add one.
- `registry.ts` — `auto | off | <id>`, cached probes.
- `policy.ts` — the hidden home and its allowlist (`home-readable.ts`), the
  hidden-path list, the workspace's git repository, Docker access's sockets
  (`dockerSocketPaths`), and the spec; `worktrees.ts` — the worktree
  locations and which worktrees are the session's own.
- `backend-home.ts` — a process backend's private home.
- `bwrap.ts`, `seatbelt.ts`, `docker.ts` — the providers.
- `confinement.ts` — per (backend, provider), how it is put inside.
- `session-sandbox.ts` — a session's setting, resolution, temp dir, handles and
  launchers; `claude-native.ts` — the Agent SDK option.
