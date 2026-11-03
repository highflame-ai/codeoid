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
| **Writable** | the session's working directory (its worktree), and a private temp dir made for the session (`$TMPDIR`, and the sandbox's `/tmp` under bubblewrap and Docker). Nothing else. |
| **Read-only** | everything else on the machine. `rm -rf ~` fails with "Read-only file system". |
| **Hidden** (not readable at all) | codeoid's config dir (`~/.codeoid`: keys, accounts, endpoints, the local token) and every data dir it owns (the database, transcripts and checkpoints, opencode's database and data dirs, memory's; their lock files); the agent CLIs' logins (`~/.claude/.credentials.json`, `~/.codex/auth.json`, `~/.qwen/oauth_creds.json`, `~/.gemini/oauth_creds.json` …, pi's `auth.json`) and what backends registered as credentials (opencode's key files); `~/.ssh`, `~/.aws`, `~/.azure`, `~/.config/gcloud`, `~/.kube`, `~/.docker`, `~/.gnupg`, `~/.config/gh`, `~/.config/hub`, `~/.config/glab-cli`, `~/.netrc`, `~/.git-credentials`, `~/.config/git/credentials`, `~/.local/share/keyrings`, `~/.password-store`, `~/.config/op`, `~/.vault-token`, `~/.pypirc`, `~/.cargo/credentials(.toml)`, `~/.terraform.d/credentials.tfrc.json`, `~/.claude.json` (MCP tokens), `~/Library/Keychains`; the desktop session's runtime dir (`$XDG_RUNTIME_DIR`: keyring, D-Bus, agent sockets) and `$SSH_AUTH_SOCK`'s dir; the daemon's own temp dir when it isn't `/tmp` (sign-in homes); plus `sandbox.hiddenPaths`. |
| **Never reachable** | container runtime sockets: `/run/docker.sock`, `/var/run/docker.sock`, containerd, podman, CRI-O, buildkit, k3s, the user's rootless sockets, Docker Desktop / Colima / Lima / Rancher / OrbStack, `$DOCKER_HOST`. A container socket is root on the machine. |
| **Environment** | `SSH_AUTH_SOCK`, `SSH_AGENT_PID`, `GPG_AGENT_INFO`, `DBUS_SESSION_BUS_ADDRESS`, `DOCKER_HOST`, `CONTAINER_HOST`, `KUBECONFIG` are unset inside. On Claude, every credential-named variable the CLI runs with is denied to its commands. |
| **Network** | `on` (default), `off`, or `allowlist` (hosts in `sandbox.allowedHosts`), per session and in config. |
| **Processes** | no new privileges; under bubblewrap a pid namespace (the sandbox sees only its own processes, so not the daemon's or the CLI's environment) and processes die with the session. |

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
| `bwrap` | [bubblewrap](https://github.com/containers/bubblewrap) (Linux; `apt install bubblewrap`). Claude Code also needs `socat` for its network proxy. |
| `seatbelt` | macOS `sandbox-exec` |
| `docker` | a container of `sandbox.docker.image` (default `node:22-bookworm-slim`; it must carry what the backend runs). `sandbox.docker.runtime: runsc` runs it on gVisor, a separate kernel. Never chosen by `auto`. |
| `off` | no sandbox: commands run with your full rights |

`sandbox.network` (`CODEOID_SANDBOX_NETWORK`): `on` | `off` | `allowlist`,
with `sandbox.allowedHosts` (`CODEOID_SANDBOX_ALLOWED_HOSTS`, `example.com`,
`*.example.com`). `sandbox.hiddenPaths` (`CODEOID_SANDBOX_HIDDEN_PATHS`) adds
paths to hide (`~` expands). `sandbox.bwrapPath` picks the bwrap binary.

Per session:

- at creation: `codeoid new <name> <dir> --sandbox bwrap|seatbelt|docker|auto|off [--network on|off|allowlist] [--allow-host h …]`,
  the web UI's new-session dialog ("Sandbox: the daemon's default. change"), or
  `session.create`'s `sandbox: { provider?, network?, allowedHosts? }`;
- later, by the session's owner: `codeoid sandbox set <session> <provider> [--network …]`,
  `/sandbox <auto|off|id> [on|off|allow:host,…]`, or `session.set_sandbox`.
  Narrowing (on, the network off) applies at once. **Widening — turning it off,
  a wider network, another provider — is a confirm shown on the session to its
  owner, in every mode, and audited** (`session.sandbox_widen_ask`, `…_denied`,
  `session.set_sandbox`); it never lands on an unattended turn. The backend
  picks the change up when it next starts (at once when idle). Creating a
  session with `off` needs `session:approve`; a delegated token can't turn it off;
- routines (`codeoid routine add … --sandbox …`, the spec's `sandbox`) and loops
  (`codeoid loop start … --sandbox …`, `loop.start`'s `sandbox`) take one too.
- A fork, and a collaboration's children, keep their parent's setting.

`codeoid sandbox providers` (`sandbox.providers`) lists what the daemon has and
whether each runs here, and why not.

## When it can't run

Where the chosen sandbox can't run — bubblewrap missing, unprivileged user
namespaces forbidden, a backend that provider can't hold — or can't enforce
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
| **Codex** | codex's own `workspace-write` (workspace + temp dir writable, network per session) **inside** codeoid's bubblewrap around the app-server; network on/off | the whole app-server under Seatbelt, full access inside it (Seatbelt doesn't nest); network on only | the whole app-server in the container; network on only |
| **opencode** | each shell line in the session's bubblewrap (the shared server's `SHELL` is codeoid's shim); network on/off | each line under Seatbelt | each line in its own container |
| **pi, Gemini CLI, Qwen Code** | the whole process inside; network on only | the same | the same |
| **OpenAI, Gemini API, llama.cpp, `oai:*` endpoints** | run no commands: "no shell", never refused | | |

What each leaves open:

- **Claude (native)**: its file tools (Read, Edit, Write, Grep, Glob) run in the
  CLI, outside the sandbox — codeoid's gate judges them (credential paths are
  refused, writes outside the workspace ask in autonomous mode). The CLI's own
  login and key are not visible to its commands (its credentials file is
  denied, its key variables are denied to commands, and it has its own pid
  namespace). Network `on` means hosts the CLI's proxy asks about are allowed
  by codeoid's gate (`SandboxNetworkAccess`).
- **Codex (bubblewrap)**: codex's own home (`CODEX_HOME`, with `auth.json`) stays
  readable by its commands — the app-server needs it, and codex's sandbox
  doesn't hide reads. Everything else is hidden by codeoid's bubblewrap.
- **Process backends (pi, the Gemini CLI, Qwen; Claude and Codex under Docker)**:
  the backend's own home (its login, settings, sessions) is reachable and
  writable by its commands, the API key in its environment is visible to them
  (`env`, `/proc/<backend>/environ` in the same sandbox), and they have the
  network (the backend needs it).
- **opencode**: its file tools run in its shared server, outside the sandbox,
  under codeoid's gate. A subagent created in a feed gap, before codeoid set its
  shell environment, now runs nothing (it used to run with the server's
  environment).
- **MCP servers** a backend mounts (stdio servers from config, a project's
  `.mcp.json`) and the workdir's own hooks run as the backend starts them:
  inside the sandbox for process backends, outside it for Claude (native),
  Codex's own MCP servers inside codeoid's bubblewrap.

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
- Credentials in **project files** (`.env` in the workspace) are the workspace's:
  add them to `sandbox.hiddenPaths` or keep them out of the workdir.
  Registry tokens in `~/.npmrc`, `~/.gradle/gradle.properties` and
  `~/.m2/settings.xml` aren't hidden by default (those files are configuration
  too); add them to `sandbox.hiddenPaths` to hide them.
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
  in the sandbox's `/proc`; closing the handle ends what runs inside.
- `src/tests/sandbox-claude-real.test.ts`: the Agent SDK's real CLI, driven by a
  localhost stand-in for the Messages API (no model): with codeoid's policy a
  planted credential is unreadable, `rm -rf` outside fails, the workspace and
  temp dir are writable, `ANTHROPIC_API_KEY` is empty in the command, network
  off is refused by its proxy, and a `dangerouslyDisableSandbox` retry reaches
  the gate and, denied, never runs. (Manually also: network on reaches a host;
  the command sees 5 processes and no environment carrying the key.)
- `src/tests/sandbox-codex.test.ts`: the app-server started inside real
  bubblewrap can't read a planted credential and can read its own home; codex's
  own sandbox (0.166) works nested inside codeoid's bubblewrap.
- `src/tests/sandbox-process-backends.test.ts`: pi's and the Gemini CLI's
  processes (fake agents) inside real bubblewrap can't read a planted credential
  and can read their own login; Qwen Code's real bundled CLI starts through its
  launcher inside bubblewrap.
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
- `policy.ts` — the hidden-path list and the spec.
- `bwrap.ts`, `seatbelt.ts`, `docker.ts` — the providers.
- `confinement.ts` — per (backend, provider), how it is put inside.
- `session-sandbox.ts` — a session's setting, resolution, temp dir, handles and
  launchers; `claude-native.ts` — the Agent SDK option.
