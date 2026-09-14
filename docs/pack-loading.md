# Dynamic Pack Loading — Design

> Status: **implementation** · Builds on [`sdlc-pipeline.md`](./sdlc-pipeline.md).
> Goal: let a user **discover, fetch, trust, and select** SDLC packs at runtime —
> from a git **registry** like [ai-factory](https://github.com/highflame-ai/ai-factory) —
> instead of only hand-editing `config.pipeline.packs` at boot.

---

## 1. Problem

Today a pack reaches codeoid exactly one way: `config.pipeline.packs = [{ dir, trusted }]`,
read once at boot by `createPipelineManagerFromConfig`. There is no way to add,
list, remove, trust, or select a pack at runtime, and no notion of *where a pack
comes from*. A user who wants the `aif-sdlc` methodology must clone the registry
by hand, find the pack subdir, edit JSON, and restart the daemon.

## 2. Model

Three concepts, mirroring the McpHub registry pattern but adding mutation +
persistence (the two gaps: `installPack` persists nothing; the MCP registry is
itself boot-only):

- **Registry** — a git repo laid out like ai-factory (`packs/<id>/pack.yaml`).
  Declared in `config.pipeline.registries = [{ name, url, ref? }]`. codeoid
  clones/pulls each into a local cache `~/.codeoid/packs/<name>/`.
- **Available pack** — a `packs/<id>/` directory found in a cached registry that
  is not yet installed. Discovered by enumerating `packs/*/pack.yaml`, or cheaply
  from a generated `packs/index.yaml` (added to ai-factory) without a full scan.
- **Installed pack** — a pack the user has committed to: its `dir` (+ `trusted`)
  lives in `config.pipeline.packs` and it is registered into the live
  `PipelineManager` so `pipeline.create({ pack })` resolves it.

`config.pipeline.defaultPack` is the **selected** pack — the one a pipeline runs
when created without an explicit `pack`.

## 3. PackService

`src/daemon/pipeline/pack-service.ts` — one always-constructed, lightweight
service (no DB, no runner), so a user can curate packs even before turning the
pipeline runtime on. It owns:

| Method | Effect |
| --- | --- |
| `listRegistries()` | configured registries + cache status |
| `addRegistry(url, name?, ref?)` | `git clone`/pull into the cache, persist to config |
| `refresh(name?)` | `git pull` a cached registry |
| `available()` | packs found across caches, not yet installed |
| `installed()` | loaded packs + metadata + trust + selected flag + status |
| `install(ref, { trusted })` | resolve a pack (registry `id` or explicit dir) → `loadPack` → persist to `config.pipeline.packs` → `installPack` into the live manager (if any) → under `skillScope: global`, link the registry's `skills/` into `~/.claude/skills` so the pack is *runnable* (see §3a) |
| `remove(id)` | unregister from the manager + drop from config |
| `trust(id, trusted)` | update config trust + reload the pack at the new trust |
| `select(id)` | set `config.pipeline.defaultPack` |

**Trust default is `false`** (decision): a fetched pack loads and its
skill/review gates work, but its shell `command` gates fail closed until an
explicit `trust`. Matches the sandbox zero-standing-privilege posture.

### 3a. Skill scope — machine-wide symlinks or per-session plugins

A trusted pack's registry `skills/` can reach a session two ways, chosen by
`config.pipeline.skillScope`:

| `skillScope` | How the skills reach a session | Who else sees them |
| --- | --- | --- |
| `global` (default) | `#linkSkills` symlinks each `skills/<name>` into `~/.claude/skills` on install / trust / refresh (additive; a **dangling** link left by an older loader is repaired, a real dir or live link is never touched) | every Claude Code session on the machine — the user's own same-named skills win collisions |
| `session` | nothing is linked; `resolveActivation()` returns `skillsPluginDir`, a synthesized Claude-Code-plugin dir (`~/.codeoid/plugins/<registry>/` = `.claude-plugin/plugin.json` + a real `skills/` holding one symlink per real skill directory in `<cache>/skills`) that the Claude backend passes to the SDK `plugins` option for that session's turns | only pack-activated codeoid sessions and pipeline phases |

Both scopes apply the same trust rule (an untrusted pack contributes no
runnable skills either way) and the same lstat guard (a `skills/<name>` that
is itself a symlink in the registry is never propagated — under session scope
a whole-dir link would have exposed it *and* widened the read sandbox to its
real parent), and both scan the skills for their `!`…`` substitutions so the
command grants (#233) and the read sandbox work identically. Plugin skills
resolve both bare (`/spec`) and namespaced (`/<registry>:spec`), so pack
`command:` values are unchanged. On a bare-name collision the user- or
project-tier skill wins under both scopes (verified against the binary); a
pack that wants the registry's version regardless names it
`/<registry>:<skill>`. Stale plugin links (a skill removed on `registry
refresh`) are pruned on the next activation; a real directory an operator
places in the plugin's `skills/` is left alone. `CODEOID_PIPELINE_SKILL_SCOPE`
sets the scope per invocation.

`session` is the scope for a machine whose `~/.claude` is owned by something
else (an org bundle symlinked by hand, another toolkit): the methodology's
skills exist inside codeoid runs and nowhere else. Switching an existing
machine from `global` to `session` does not remove links already made — delete
the `~/.claude/skills/<name>` symlinks that point into `~/.codeoid/packs/` if
you want them gone. Non-Claude backends ignore `pluginDirs` today, exactly as
they ignore pack subagents.

Registry skills and gates are registered under `<packId>/<id>` (`scoped.ts`)
so two installed packs declaring the same bare id (`review`, `ship`,
`tests_pass`) coexist; a run created from a pack resolves its own pack's entry
first and falls back to the bare id for built-in gates (`always`, `manual`).
An explicit-`phases` plan has no pack to scope by: it resolves built-ins and
directly registered entries by bare id, and an installed pack's entries by
their qualified id (`skill: "org-dev/spec"`). It can no longer borrow a pack's
entry by bare id — the create error lists the qualified ids that exist.
`pipeline.pack.list` reports the daemon's live `skillScope`.

Persistence goes through one shared config mutator (`mutateConfigFile`) that
read → mutates → validates against `RootSchema` → atomically writes `0o600` —
reusing the settings-store path so config integrity is enforced in one place.

## 4. Wire protocol (additive — no `PROTOCOL_VERSION` bump)

New client verbs, replies `pipeline.pack.list.result` / `pipeline.snapshot`-style:

- `pipeline.pack.list` → `{ installed[], available[], registries[] }` — scope `pipeline:read`
- `pipeline.registry.add { url, name?, ref? }` — scope `pipeline:manage`
- `pipeline.pack.install { ref, trusted? }` — scope `pipeline:manage`
- `pipeline.pack.remove { id }` — scope `pipeline:manage`
- `pipeline.pack.trust { id, trusted }` — scope `pipeline:manage`
- `pipeline.pack.select { id }` — scope `pipeline:manage`

`pipeline:manage` is a **new owner-tier scope** (not in `OPERATOR_SCOPES`) —
these verbs rewrite `config.json`, same trust tier as `settings:write`.

## 5. CLI (`codeoid pack …`, commander in `src/cli.ts`)

```
codeoid pack registry add <git-url> [--name <n>] [--ref <ref>]
codeoid pack list                 # installed + available across registries
codeoid pack install <id> [--trust]
codeoid pack show <id>            # phases / roles / gates
codeoid pack trust <id> [--off]
codeoid pack select <id>
codeoid pack remove <id>
```

The CLI drives the daemon verbs when it is running; otherwise it mutates config
directly through the same `PackService` primitives (so `pack install` works
during image build / before `codeoid start`).

## 6. Web UX

A `/packs` slash command opens a **Pack Browser** (`web/src/components/PackBrowser.tsx`):
installed packs as cards (name · version · a visual phase pipeline · role badges
· gate markers · trust state · source), with *Set default · Start pipeline ·
Trust · Remove*; an **Available** section listing registry packs with *Install*;
and *Add registry…*. A pack selector is also added to the New-Session modal.

## 7. Forge (follow-up slice)

codeoid has git access in the sandbox, so a Forge sandbox fetches the ai-factory
registry at start via a `packs`/`registries` field on `HarnessDef` → resolved
into `WorkspaceSpec` env → codeoid config. Git auth follows the sandbox posture
(short-lived / SSH, never a long-lived env credential). Baking the registry into
the image remains the fallback for network-restricted egress bundles.

## 8. Non-goals (here)

- Dynamic **MCP-server** provisioning from dev/saas into the sandbox — a
  separate follow-up feature.
- Per-tenant pack scoping — packs stay daemon-global (managed at the owner tier)
  for now, like the MCP registry.
