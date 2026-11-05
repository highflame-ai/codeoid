# Sandbox providers (#448)

A sandbox provider is one way of building the OS boundary a session's
commands run in ([sandbox.md](sandbox.md)). bubblewrap, Seatbelt and Docker
ship; Forge/Droneship (remote VMs, gVisor) and Firecracker are expected next.
This is the contract they implement and how codeoid uses it.

## The interface

`src/daemon/sandbox/types.ts`:

```ts
interface SandboxProvider {
  readonly id: string;              // "bwrap", "seatbelt", "docker", later "forge"
  readonly displayName: string;
  readonly capabilities: SandboxCapabilities;
  probe(): Promise<SandboxProbe>;   // { available: true } | { available: false, reason }
  open(spec: SandboxSpec): Promise<SandboxHandle>;
  openSync?(spec: SandboxSpec): SandboxHandle;   // local providers whose open does no I/O
}

interface SandboxCapabilities {
  isolation: "os" | "kernel" | "hardware";  // namespaces/profiles | gVisor | a VM
  placement: "local" | "remote";
  workspace: "mount" | "sync";              // mounted in place | copied in, changes copied back
  stdioProcess: boolean;                    // a long-lived process with piped stdin/stdout
  commands: boolean;                        // one command, its output returned
  wrapsArgv: boolean;                       // an argv this machine can spawn that runs a program inside
  network: readonly ("on" | "off" | "allowlist")[];   // what it can enforce
  platforms: readonly NodeJS.Platform[];
}

interface SandboxSpec {
  sessionId: string;
  workspace: string;          // writable
  tempDir: string;            // writable, private; the sandbox's /tmp where it can be
  privateTemp?: boolean;      // a fresh temp dir per program, gone when it exits, never tempDir itself (the git shim's):
                              //   bwrap/Docker a tmpfs /tmp; Seatbelt a dir the wrapper makes in tempDir and removes
  writable: string[];         // the backend's private home (when its whole process is inside); a git repository's dirs; the cache dir
                              // (each bound at its own path: none may be renamed, as a mount point can't)
  hidden: string[];           // not readable at all (the user's home first, whole)
  reexposed: string[];        // read-only inside something hidden (the home allowlist, the backend's program and login)
  readOnly?: string[];        // read-only inside something writable, with what is in it (what picks a repository's config,
                              // hooks and git dir; the project settings agent CLIs run code from); each exists
  gitDirs?: string[];         // the git dirs a commit writes (a backend's own sandbox's extra writable roots)
  env?: Record<string, string>; // set inside: the toolchains' caches in the sandbox's cache dir
  pinned?: string[];          // can't be renamed or removed, contents still writable (a dir between the workspace and a hidden path)
  containerSockets: string[]; // never reachable
  network: { mode: "on" | "off" | "allowlist"; allow?: string[] };
  unsetEnv: string[];         // removed inside (agent and desktop sockets)
}

interface SandboxHandle {
  readonly providerId: string;
  readonly spec: SandboxSpec;
  spawn(command, args, { cwd, env }): ChildProcessWithoutNullStreams;  // piped stdio; throws without stdioProcess
  exec(argv, { cwd, env, stdin?, timeoutMs? }): Promise<{ exitCode, signal, stdout, stderr }>;
  wrap?(argv, { cwd, env }): { argv, env };  // only with wrapsArgv; cwd "" = the caller's
  close(): Promise<void>;                     // idempotent; ends what still runs inside
}
```

The registry (`registry.ts`) resolves a setting — `auto` (the platform's own:
`bwrap` on Linux, `seatbelt` on macOS), `off`, or an id — to a provider and its
cached probe (5 minutes; concurrent asks share one run).

## How codeoid uses a provider

A session resolves its setting for its backend (`session-sandbox.ts`
`resolveSandbox`): the provider and its probe, then the backend's **confinement
plan** (`confinement.ts` `confinementFor(backendId, provider)`), chosen from the
provider's capabilities:

| Plan | Needs | Used for |
|---|---|---|
| `native` | a local OS provider the backend's own sandbox matches | Claude Code (its SDK `sandbox` option: bubblewrap/Seatbelt); Codex on bubblewrap (its workspace-write inside codeoid's bubblewrap around the app-server) |
| `process` | `stdioProcess` and `wrapsArgv` | the whole backend process inside (pi, the Gemini CLI, Qwen; Claude and Codex where `native` doesn't fit) |
| `command` | `commands` and `wrapsArgv` | each shell line inside (opencode's shared server) |
| `no-shell` | — | backends that run no commands |

and the network that plan can enforce (an allowlist the plan can't hold is
`off`; a backend that needs the network to reach its model keeps it `on`, and
the session is then not `enforced`). The result is `SessionInfo.sandbox`.

When the sandbox is on, the backend gets a `SandboxRuntime`
(`ProviderSessionInit.sandbox()`): the plan, the spec, `open(backendState,
{ backendNetwork?, readable? })` for a handle whose spec also lets the backend's
own process reach its home, `launcher(handle, argv, envNames)` — an
executable script that starts `argv` inside, for spawners codeoid doesn't
control (an SDK's `pathToQwenExecutable`, opencode's `SHELL`), `privateHome(key)`
— a fresh private dir for the backend's own home (`backend-home.ts`: a backend
whose process is inside never gets its real home writable), `stateDir(key)` —
the session's own dir its conversations live in across starts, and
`claudeTemp()` for Claude's native sandbox.

A provider must lay the spec so a hidden path stays hidden whatever the host
does meanwhile: the home is hidden as a whole (a tmpfs, a subtree denial, or
not mounting it), so a file created or renamed in later isn't seen; paths it
binds are taken physically (a destination reached through a linked dir is a
trap: Claude's own bubblewrap couldn't mount through `/var/run`); a pinned dir,
and every writable location besides the workspace and temp dir, must refuse a
rename without making its contents read-only; `env` is set for what runs
inside.

A backend closes the handle it opened when its process ends (one per process,
not one per start piling up); a change of setting closes none (the backend is
restarted, idle, to take the new one). Everything still open for a session is
closed with it, and its temp dir and private homes removed. Docker labels each
handle's containers, so closing one removes only its own.

## Adding a provider

1. Implement `SandboxProvider` in `src/daemon/sandbox/<id>.ts`. Keep the
   policy → arguments step a pure function (`bwrapArgs`, `seatbeltProfile`,
   `dockerRunArgs`) and unit-test it; put real-boundary tests behind its
   availability or an env gate (`CODEOID_TEST_DOCKER=1`).
2. Declare capabilities honestly: anything not in `network` is never claimed,
   and a missing `stdioProcess` / `wrapsArgv` makes `confinementFor` refuse the
   backends that need it, with a reason the session shows.
3. Register it in `createDefaultSandboxRegistry` and add its id to the
   `sandbox.provider` enum in `src/config.ts` and the settings manifest.
4. If a backend needs it differently, add a case to `confinementFor`.
5. Document in [sandbox.md](sandbox.md) what it holds, per backend.

The spec is what must hold; how is the provider's. A provider that can't hide a
path, or can't keep the workspace writable and the rest read-only, isn't a
workspace-write sandbox and shouldn't be registered as one.

## Forge provider: what Forge needs to add

Forge (highflame-forge, Droneship) runs sandboxes on remote backends
(Modal, Cloudflare, gVisor, local) behind `POST /v1/forge/sandboxes`, with an
isolation floor (`required_isolation`: OS, KERNEL, HARDWARE) a backend meets or
refuses. A `ForgeSandboxProvider` would declare:

```ts
capabilities = {
  isolation: "kernel",      // from the chosen backend; codeoid would pass required_isolation and refuse a downgrade
  placement: "remote",
  workspace: "sync",
  stdioProcess: false,      // today: no stdio-piped process
  commands: true,           // POST /sandboxes/{id}/exec (buffered)
  wrapsArgv: false,         // nothing on this machine can spawn into it
  network: ["on", "off"],   // allow_network; allowlists only on Modal today
  platforms: ["linux", "darwin"],
};
```

With that, `confinementFor` refuses every backend today: the CLI backends need
`stdioProcess`, opencode's per-command shim needs `wrapsArgv` (a local program
per line) — and the session says why. What Forge needs to add, in order:

1. **A stdio-piped long-lived process**: `exec` with `stdin` and streamed
   `stdout`/`stderr` on a WebSocket (not a PTY: raw pipes, no echo, binary
   safe), or SSH exec without a PTY as the transport. With it, `spawn()` returns
   a `ChildProcess`-shaped object over that stream, `stdioProcess: true`, and
   pi, the Gemini CLI, Qwen, Codex's app-server and the Claude CLI
   (`spawnClaudeCodeProcess`) run there.
2. **Streaming exec with stdin, per command**: today's `exec` is buffered and
   takes a shell string. For opencode's shim the provider's `wrap` would become
   a local relay program (`codeoid forge-exec <sandbox> -- bash -c <line>`)
   that streams the line's output; `wrapsArgv: true` through that relay.
3. **Workspace sync both ways**: there is no file API. Today a workspace gets in
   by `repo`/`ref` clone, a durable volume, or the CLI's tar over SSH, and comes
   back by `workspace diff/pull`. codeoid's sessions work in a host directory, so
   the provider needs, at least, push-in at open (the worktree, untracked files
   included) and pull-back before a turn ends or a checkpoint is taken — or
   codeoid's checkpoints and file-tool checks run against a stale tree.
   A file upload/download endpoint (or a sync session over the SSH transport)
   would do both.
4. **Per-session credential handling for codeoid**: the credential sidecar
   excludes codeoid ("needs per-session key handling"), and the credential guard
   refuses KERNEL+ launches whose environment holds long-lived keys. A remote
   backend process needs its model key: a sidecar or a short-lived per-session
   token the backend's gateway accepts (the ZeroID workload badge per sandbox
   could carry it), so no long-lived key enters the sandbox.
5. **Enforced host allowlists beyond Modal**, so `allowlist` can be in
   `network` (Docker refuses a host allowlist today).
6. **Lifecycle tied to the session**: `DELETE` on close (the provider's
   `close()`), `idle_timeout_seconds` / `timeout_seconds` from the session's
   expected life, and `expires_at` surfaced so codeoid can say when a sandbox
   will go.

Hidden paths are easy remotely — nothing of the host is there unless synced —
but the sync step must exclude them (the spec's `hidden` list) from what it
copies in.
