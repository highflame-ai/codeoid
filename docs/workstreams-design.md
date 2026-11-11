# Codeoid Workstreams — Design Proposal

> Status: **W0 in review (#461), W1 built** · Author: design session 2026-11-10
> Companion to [conductor-design.md](./conductor-design.md) and [federation-design.md](./federation-design.md).
> Goal: let one owner run several separate lines of work on one daemon. A line of work can be a company, a client, a project, a team, research, or just a different personal setup.
> Each line of work gets its own MCP servers, credentials, models and memory.
> The conductor still sees and coordinates all of them, and nothing leaks from one to another by default.

---

## Decisions locked (grill 2026-11-11)

- **G1. Daemon-held credentials, always proxied.** Every credentialed server a workstream selects is reached through the daemon's hub and proxy (`mcp/hub.ts`, `mcp/proxy.ts`), the path OAuth servers already use.
  A backend process (argv, env or `--mcp-config`) never holds a workstream secret. It gets a local proxy URL and a per-session proxy token.
  The hub's client cache is keyed by `(server, credential slot)`.
  Stdio servers are the one exception: the hub spawns them, so their secret goes into the env of a subprocess the hub owns, never a backend's.
- **G2. Credentials are named, first-class objects behind a pluggable store.**
  The declaration (`config.json` → `credentials[]`: `id`, `kind` = `bearer | header | env | oauth`, plus kind fields) is metadata only.
  Values sit behind a `CredentialStore` interface (`get / put / delete / status / writable`). The default implementation keeps static values in `.env` as `CODEOID_CRED_<ID>`, which `DENY_PREFIXES` keeps out of every agent env. OAuth tokens go in `mcp_oauth_credentials`, which gains a `credential` column in its primary key (`''` = default sign-in, so existing rows are unchanged). The PK change is a table rebuild in one transaction.
  Other implementations (file vault, Kubernetes Secret, …) plug in by config. A read-only store (`writable: false`) shows "managed externally" in the UI, and OAuth tokens can use a different, writable store.
- **G3. Override = a two-step create with a bound token.** A conflicting `session.create` returns `workstream_conflict` with the diff and an `overrideToken`.
  The token is held in daemon memory, is single-use, expires after 5 minutes, and is bound to (caller subject, workdir, chosen workstream, config revision).
  The retry carries the token, and the caller must hold `session:approve`.
  For the conductor, the override warning is placed on `fleet_spawn`'s existing approval card, and that approval is the confirmation. The conductor never receives a token.
  Rejected: a pending session with a synthetic approval. Approvals are `canUseTool` gates inside a live turn (`session.ts:1318`) and aren't persisted across restarts.
- **G4. Revocation applies on every call. The tool list catches up at the turn boundary.**
  The proxy checks the session's *current* binding on every credentialed call, so a removed server or credential fails at once, mid-turn, with an error naming the workstream.
  The tool list the model sees is rebuilt at the next turn boundary through the existing query-loop rebuild.
  Widening waits for refresh or a new session.
- **G5. The binding is stored in `TranscriptMeta.workstream` and sticks.** Resume re-checks the stored home against the current config and never re-matches folders.
  A deleted workstream leaves its sessions `orphaned`, which refuse turns until moved.
  A session from before workstreams is resolved once by folder rules on its first resume with workstreams configured, and saved with `source: "migrated"`.
  If nothing matches and there's no default, it **fails closed**: built-ins only, with a banner asking you to pick.
  Forks and collaboration children inherit the parent's binding.
- **G6. Delivery.** Branch `feat/workstreams`, one PR per phase into `main`. Each PR gets two deep audit rounds, with fixes folded in. After merge, an end-to-end test of the phase, with follow-up fix PRs until it works.
  W4 builds the fleet-tool scoping now, and leaves workstream-homed egress as a tested stub until P6's Slack and email egress exists.
  Mobile changes wait for the app revival. Federation (W5) is out of this round.

---

## 1. The gap

Today every session on a daemon gets the same tool surface.

- `loadUserMcpServers` (`providers/claude/index.ts`) merges the user scope of `~/.claude.json` into every Claude session.
  The session view (`mcp/session-view.ts`) hands the same global servers to every other backend.
- So a session working on one project is handed a server that can query another project's production database.
  A session in one team's repo is handed another team's GitHub token.
  Nobody chose this. It is simply what "user scope" means.
- Per-folder servers already exist (`mcp/workdir-servers.ts`, #395), but they are keyed by **one exact path**.
  An owner with forty worktrees of one project's repos would need forty entries, kept in sync by hand.
- Memory is scoped by tenant `(account, project)` and by **workspace** (`workspaceIdFromPath`, `memory/store.ts:107`), which is a single folder.
  Nothing groups folders into "all my Sentisum work", so recall cannot be asked for it and cannot be fenced to it.
- The conductor (conductor-design §5–§8) is about to draft Slack replies and chase reviews on the owner's behalf.
  Without a boundary it can compose a reply in one Slack workspace using recall from another workstream's sessions.
  That is the failure the owner cares about most, and nothing in the current model can express it.

## 2. Goal and non-goals

**Goal.** A **workstream** is a named line of work.
It decides, for every session that belongs to it: which MCP servers and credentials the session gets, which accounts and models it uses by default, and which memory it writes to and may read.
Sessions join a workstream automatically by folder, or by explicit choice.
They may read another workstream's code only when that workstream allows it.

**A workstream is whatever boundary the owner wants.** It is not tied to an employer.
Examples: a company, a client engagement, one product inside a company, a team, a research effort, or a personal setup such as "local models only, no cloud servers".
Workstreams don't have to be strict silos either. They can share servers, accounts and skills on purpose (§6.5).
The policies below (`claim`, `share`, `allowOverride`) let each workstream be as open or as closed as its contents need.

**Non-goals.**
- **Not a new tenant.** Tenancy `(account, project)` is the authorization boundary *between principals*.
  Workstreams partition *one owner's* work inside a tenant (see §11, rejected alternatives).
- **Not a sandbox.** Credential isolation is enforced (§6). File-read isolation is a gate on file tools plus a prompt on `Bash`, **not** an OS fence (§7.3).
  The real fence is the same open sandbox question as conductor-design open question #10.
- **Not mandatory.** A daemon with no workstreams configured behaves exactly as it does today.

## 3. Vocabulary

| Term | Meaning | Exists today |
| --- | --- | --- |
| **tenant** | `(account_id, project_id)` from the caller's JWT. The auth boundary. | yes |
| **workspace** | One folder (git root or path). The memory key, `workspaceIdFromPath`. | yes |
| **workstream** | A named set of workspaces plus policy: servers, credentials, accounts, models, memory, sharing. | **new** |
| **home workstream** | The one workstream a session belongs to. Decides everything the session is *given*. | **new** |
| **reference** | Read-only access a session holds to another workstream's folders. | **new** |

A session has **exactly one** home workstream, and zero or more references.
That single rule answers all three of the owner's questions (§5).

## 4. The workstream object

```jsonc
// ~/.codeoid/config.json → "workstreams"
{
  "workstreams": {
    "isolateGlobalServers": true,      // §6.1 — off = today's behaviour
    "default": "personal",             // home for sessions nothing matches
    "items": [
      {
        "id": "highflame",
        "name": "Highflame",
        "color": "orange",
        "match": {
          "paths":   ["~/Workspace/highflame-*", "~/Workspace/highflame-*-worktrees/**", "~/Workspace/zeroid-main"],
          "remotes": ["github.com/highflame-ai/*"]
        },
        "claim": "exclusive",          // §5.2
        "mcpServers": ["github-hf", "highflame-platform", "highflame-platform-prod", "slack-hf"],
        "accounts": { "claude": "default" },
        "defaults": { "provider": "claude", "model": "claude-opus-5-5", "effort": "xhigh" },
        "env": { "GH_TOKEN": { "secret": "gh-rdkrds" } },
        "skillDirs": ["~/Workspace/highflame-architecture/claude/skills"],
        "share": "ask"                 // §7 — may other workstreams reference this one?
      },
      {
        "id": "sentisum",
        "match": { "paths": ["~/Workspace/sentisum/**"], "remotes": ["github.com/sentisum/*"] },
        "claim": "exclusive",
        "mcpServers": ["github-sentisum"],
        "share": "closed"
      },
      {
        "id": "dhishvari",
        "match": { "paths": ["~/dhishvari/**"], "remotes": ["github.com/Dhishvari/*"] },
        "claim": "exclusive",
        "env": { "GH_TOKEN": { "secret": "gh-saucam" } },
        "share": "open"
      },
      {
        "id": "research",
        "match": { "paths": ["~/Workspace/gemma-4-comp/**", "~/Workspace/training/**"] },
        "claim": "suggest",
        "defaults": { "provider": "claude", "model": "claude-opus-5-5" },
        "share": "open"
      },
      { "id": "personal", "claim": "suggest", "share": "open" }
    ]
  }
}
```

Field notes:

- **`match.paths`** are globs, with `~` expanded. Globs, not regex: they read the way people write paths, and a regex is one bad `.*` away from matching `$HOME`.
  A `regex:` prefix can be added later if a real case needs it.
- **`match.remotes`** match the git `origin` URL, normalised to `host/owner/repo`.
  This is the rule that **survives federation**: a repo lives at `/home/deploy/Workspace/...` on one machine and `/home/ydatta/Workspace/...` on another, but its remote is the same (§9).
- **`mcpServers`** name entries in the existing registry (`mcp/registry.ts`). A workstream doesn't define servers. It *selects* them.
  Servers stay defined once, in the MCP Servers panel, and keep their OAuth state there.
- **`env`** values are **secret references**, never inline secrets, so the config file is safe to show, diff and send to a satellite.
- **`accounts`** reuse the per-backend accounts from [backend-accounts-design.md](./backend-accounts-design.md). A workstream only names which account is the default.
- **`skillDirs`** are added to the skill directories (the `--add-dir` list) for the workstream's sessions only.
  Today every session gets `highflame-architecture/claude/skills`, which is the same leak in a smaller form.

## 5. How a session gets its home workstream

### 5.1 Resolution order

At `session.create`:

1. **Explicit**: `SessionCreateMsg.workstream` was set (new picker, `codeoid new --workstream`, `fleet_spawn(workstream=…)`).
2. **Matched**: the workdir matches a workstream's rules.
   The most specific **rule** wins: a path glob beats a remote rule, then the rule with more literal folders, then more literal characters, and `origin` beats `upstream`.
   Where a rule matched never counts: `~/w/**` matching the folder itself must not beat `~/w/acme` matching its parent (found while building W0).
   The same rule written in two workstreams is a **config error** when the config loads.
   Two *different* rules that tie on a real folder can only be found against that folder, so they are reported at resolution: the folder gets no home until a workstream is chosen, and the picker shows the tie.
   A folder matches as given and as its real path, and a rule with a symlinked fixed part (`~` itself, or `~/Workspace`) through its real path too.
   Links are never searched for: the W0 audit showed a link anyone plants under a rule's folder becomes a spelling an attacker chose. When the given and real spellings match different workstreams, the folder gets no home until one is chosen.
   **An exclusive claim outranks any suggestion**, whatever the specificity (W0 audit): a more specific `suggest` rule must not take a folder from the workstream holding it exclusively. Carving one out takes a more specific exclusive rule.

   **A remote is text an agent can edit.** `.git/config` is in the repository, so an agent that can write it could make the folder's *next* session resolve to a more privileged workstream.
   Three things bound this: a path rule outranks any remote rule, a live session's home never changes, and (W1) a remote-derived match that differs from how the folder resolved before is treated as a conflict, not a silent re-homing.
   Under the OS sandbox (#448) the repository's `config` is read-only to the agent anyway.
3. **Default**: `workstreams.default`, if one is set.
   The default is optional (decided 2026-11-10).
   With none set, a session in an unmatched folder has no home until you pick one: the dialog asks, and `codeoid new` without `--workstream` fails with the list.
   A session with no workstream is never silently given the global servers.

The result is stored in the session meta as a **binding**:

```ts
interface WorkstreamBinding {
  id: string;                       // home workstream
  source: "explicit" | "matched" | "default" | "override";   // override = confirmed past an exclusive claim (§5.2)
  matchedBy?: string;               // the rule that matched, for display
  revision: string;                 // config revision applied (§8): a hash of the workstreams block
  references: Reference[];          // §7
}
```

### 5.2 When the explicit choice and the folder disagree

This is the owner's second question. The answer depends on the folder's **claim**:

| The folder is… | You pick a different workstream | Result |
| --- | --- | --- |
| unmatched (e.g. `/tmp/scratch`) | any | **allowed**. The explicit pick is the home. |
| matched by a `suggest` workstream (`research`, `personal`) | any | **allowed**. The picker shows "folder suggests *research*", and your choice wins. |
| matched by an `exclusive` workstream (`highflame`, `sentisum`) | another one | **you are warned and asked to confirm** (decided 2026-11-10). The create returns `workstream_conflict`, and the dialog shows three choices. |

The three choices on a conflict:

- **(a) Use the folder's workstream.** You are working in that repo, so you are doing that workstream's work. This is the right answer almost every time, because the mismatch is usually a slip of the picker. It is the default button.
- **(b) Start in your chosen workstream with that folder as a read-only reference.** The session's workdir becomes a scratch folder or a worktree in the chosen workstream's area. The conflicting folder is attached as a reference (§7), if its `share` policy allows that.
- **(c) Override: start in the folder, homed in your chosen workstream.** The warning names what will happen: "This folder belongs to *Sentisum*. The session gets *Dhishvari*'s servers and `GH_TOKEN` and writes into Sentisum's code."
  Confirming sets the binding's `source: "override"`, records an audit row naming both workstreams, and puts a warning badge on the session chip for its lifetime.
  The folder's own workstream's servers and env are still withheld, because an override changes the home and does not merge the two.

The override confirmation is enforced by the daemon, not a client-side checkbox (G3). The conflict reply carries a single-use `overrideToken` bound to the request, and the confirming retry must present it and hold `session:approve`.
The conductor's `fleet_spawn` cannot confirm its own override: the warning goes on the spawn's approval card, and only your approval confirms it.
A workstream can set `allowOverride: false` to make (c) unavailable for its folders. That is the hard refusal, for code that must never run under another identity, such as a client's repo under a contract.

Why the default answer is (a) and (c) takes a confirmation, instead of letting the explicit choice silently win:

- **The home decides credentials.** If you could home a session in `dhishvari` while its workdir is a Sentisum checkout, the agent could read and write Sentisum code freely.
  It could also push with the Dhishvari GitHub token or commit under the wrong identity. The folder's claim exists to stop exactly that.
- **The opposite direction is worse.** If you could home a session in `sentisum` while sitting in a Dhishvari repo, Sentisum's servers could be pointed at your own company's code. An `exclusive` claim protects both sides.

`claim: exclusive` suits workstreams whose folders should only ever run with their own credentials and identity. That is usually because the code or the credentials belong to someone else (a client, an organisation) or because a wrong-identity commit or push would be costly.
`claim: suggest` suits everything else: research, scratch work, personal setups. The folder hints at the workstream and never gets in the way.

### 5.3 Changing workstream after creation

`session.set_workstream` re-homes a live session. It is treated as a **share of the session's whole transcript** from the old workstream to the new one, because that is what it is: the conversation carries everything the session has read.

- It is allowed only if the old workstream's `share` policy allows the new one (§7.1): `closed` refuses, `ask` needs approval, `open` is allowed.
- Moving from the `default` workstream is always allowed. This covers "I started a scratch session and now it's real work".
- The backend restarts at the next turn boundary with the new tool surface, the same cost model as an MCP refresh.
  The move is audited as one event.
- A **fork** into another workstream follows the same rule, because a fork also carries the transcript.

## 6. What the home workstream controls

### 6.1 MCP servers — enforced

For a session homed in workstream *W*, the session's MCP view is:

```
built-ins (codeoid_memory, codeoid_fleet on the conductor, blackboard, …)
  ∪ servers listed in W.mcpServers
  ∪ the workdir's own per-folder servers (#395), but only if the folder is in W
```

The user's global Claude servers (`~/.claude.json` user scope):

- **`isolateGlobalServers: false`** (default, back-compatible): they reach every session, as today.
- **`isolateGlobalServers: true`**: a global server reaches only the workstreams that list it by name.
  An unlisted global server reaches nobody, and the settings panel shows it as "not in any workstream".

**Enforcement on Claude.** The Claude CLI loads `~/.claude.json` itself, so it isn't enough for codeoid to leave a server out of what it passes.
Withheld servers go into `settings.deniedMcpServers` by URL. The provider already does exactly this for OAuth servers (`providers/claude/index.ts:1175`), so this widens an existing mechanism instead of adding one.
On every other backend, codeoid builds the server list itself, so leaving a server out is enough.
Qwen reads a project's `.mcp.json` itself (session-view.ts header). That only matters for a folder inside *W*, so it stays inside the boundary.

This is the one control that makes the owner's split real: **a session can't call a tool it was never given.** It holds no matter what the model is told.

### 6.2 Credentials and environment — enforced

`W.env` is merged into the backend's environment after codeoid's own scrubbing (`buildQwenEnv` and the shared prefix-strip).
A `GH_TOKEN` for one workstream is simply absent from another's processes.
The daemon resolves secrets when it spawns the backend and never writes them to session meta or the transcript.

**Git identity** comes from the same mechanism. A workstream can set `git: { name, email }`, which becomes `GIT_AUTHOR_*` and `GIT_COMMITTER_*` in the backend's env.
Commits in a workstream's sessions then carry its identity no matter what the repo's local git config says.
It is cheap, and it prevents a whole class of wrong-identity commits.

### 6.3 Accounts, models, effort, skills — defaults

These fill fields the create message left empty: `providerId`, `account`, `model`, `effort`.
An explicit value on the create message wins, so these are defaults and not a fence.
The exception is an account belonging to another workstream. Picking it would hand the session that workstream's subscription or API key, so it is refused just like a server is withheld.

### 6.4 Memory — scoped

- Every episode and session card records the session's home workstream (a `workstream_id` column, written at capture).
  Workspace ids don't change, and no re-keying is needed.
- `recall` from a session searches **its home workstream plus its references** by default. "All" is available only to the conductor (§10).
- A `closed` workstream's episodes never show up in another workstream's recall, including through a reference grant made before the policy changed (§8).

### 6.5 Sharing resources between workstreams

Workstreams **select** resources. They don't own them.
An MCP server, an account, a skills folder or a pack is defined once, in its own panel, and any number of workstreams can list it.
Sharing is therefore the normal case, not a special feature. There are three kinds:

**1. Shared server and shared credential.** Two workstreams list the same server, and both use the same sign-in or token.
Typical examples: a web-search server, a local model server, your own notes or calendar, a design tool.

```jsonc
{ "id": "dhishvari", "mcpServers": ["web-search", "notes", "github"] }
{ "id": "vibzart",   "mcpServers": ["web-search", "notes", "github"] }
```

**2. Shared server, separate credential per workstream.** The server definition is the same, but each workstream signs in as itself.
The common case is one GitHub MCP server used with a different account or token per workstream.

```jsonc
{ "id": "dhishvari", "mcpServers": [{ "server": "github", "credential": "gh-saucam" }] }
{ "id": "research",  "mcpServers": [{ "server": "github", "credential": "gh-research-bot" }] }
```

- For a header-authenticated server, `credential` names a secret, and the daemon sets the header from it when it builds the session's view.
- For an OAuth server, the OAuth token store (`mcp/oauth.ts`, already keyed by `McpTenant`) gains a credential slot. Each slot has its own sign-in, started from the Workstreams panel.
- Leaving `credential` out means the server's default sign-in, which is case 1.

**3. Shared base.** A workstream can `extends` one or more **base** workstreams.
A base has no `match` rules and no sessions of its own. It holds the common set, and each workstream adds to it or takes away from it:

```jsonc
{ "id": "base-personal", "abstract": true,
  "mcpServers": ["web-search", "notes"], "skillDirs": ["~/.claude/skills"],
  "accounts": { "claude": "max-personal" } }
{ "id": "dhishvari", "extends": ["base-personal"], "mcpServers": ["+github"], "exclude": ["notes"] }
```

Merge rules: lists are unioned in `extends` order, the workstream's own entries come last, and `exclude` is applied after the merge. Scalars are overridden by the most specific setting.
A cycle in `extends` is a config error, reported when you save.
`claim`, `share` and `match` are **never inherited**, because they describe *this* workstream's folders, not a common setup.

**Shared beyond servers:**

| Resource | Shareable | Notes |
| --- | --- | --- |
| MCP servers | yes | as above |
| Accounts (subscriptions, API keys) | yes | One Claude subscription across workstreams is normal. Its quota is shared too, which is what the deferred spend cap (§15) would split. |
| Skills folders, packs | yes | via `skillDirs` and `packs`, or through a base |
| Routines | no | A routine runs in one workstream, its home. A routine that should exist in several workstreams is defined once per workstream. |
| Memory | only through references | Reading another workstream's memory is a reference (§7), governed by the `share` policy of the workstream being read. A base workstream holds no memory. |

**The one warning: a shared credential is a bridge.**
If two workstreams use the same Slack sign-in, a session in either can read the channels of both, whatever `share` says.
A server is just a tool, and the tool sees what its credential sees.
So the panel shows "shared by *N* workstreams" on each server and credential.
It **warns, without blocking**, when a credential is shared with a workstream whose `share` is `closed`, since that sharing contradicts the policy.
The fix is case 2: the same server with a separate credential per workstream.

### 6.6 Channels (for the conductor's inbox)

A workstream can also name its **channels**: the places messages come from and replies go to.
Examples: a Slack workspace with the user it acts as, an email account, a GitHub org's notifications.
They are listed here so the binding exists from the start, but they are wired up only when the conductor's Slack front end lands (§10, "Intake").
A channel is a credentialed resource like any other, so it can be shared or separate by the same rules as §6.5.

## 7. Reading across workstreams

This is the owner's third question: one workstream sometimes needs to read another's projects for ideas, code or patterns.

### 7.1 Share policy, set by the workstream being read

| `share` | Another workstream may reference it… |
| --- | --- |
| `open` | freely. Picked in the new-session dialog or added mid-session; audited. |
| `ask` | with owner approval per grant, through the existing `approvalId` flow. |
| `closed` | never. The picker doesn't offer it, and `session.add_reference` is refused. |

The policy belongs to the workstream being **read**, not the one reading, because the risk is the owner's obligation to that workstream's code.
Code you hold under someone else's terms (a client, an organisation) should be `closed` or `ask`, because copying it elsewhere can be an IP problem no matter how convenient it is.
Your own projects, research and personal setups are typically `open`.

### 7.2 What a reference gives a session

A reference names a workstream and, optionally, specific folders inside it:

```ts
interface Reference {
  workstream: string;
  paths?: string[];    // absent = all the workstream's matched folders on this machine
  grantedBy: string;   // ZeroID subject that approved it
  grantedAt: string;
}
```

It grants:
- **read** of those folders through file tools (`Read`, `Grep`, `Glob`);
- **recall** over that workstream's memory, filtered to those folders if `paths` is set.

It never grants:
- write there;
- that workstream's MCP servers, env or accounts.

You read Highflame's code, but you don't get Highflame's database.

"Copy a pattern" therefore means: read it from the reference, write it in the home workdir.
The write lands in the home workstream and its git identity, which is exactly the provenance you want.

### 7.3 Enforcement — say precisely what is enforced

| Control | Status |
| --- | --- |
| Another workstream's MCP servers, env, accounts | **enforced**. Never given (§6.1–6.2). |
| File-tool read outside home + references | **enforced in the gate.** `canUseTool` path check, denied with a reason naming the workstream. |
| File-tool write outside the home workstream's folders | **enforced in the gate**, same place. |
| Recall outside home + references | **enforced** in the memory query. |
| `Bash` reading another workstream's files (`cat`, `rg`) | **prompted, not enforced.** `Bash` gets around every path scope; this is the same honest limit as conductor-design §3 and §9. |
| Qwen's read-only shell auto-allow (CLAUDE.md, "Known gap") | **not enforced.** A qwen session can read any file the daemon user can. Workstream isolation on qwen is credential isolation only. |

The path check goes in the session's gate, not in `tool-safety.ts`, for the reason conductor-design open question #8 already settled: the classifier stays pure, and the gate makes the contextual decision.

**The OS sandbox (#448) has landed since this was drafted, and it is the read fence.** It hides the home by default and shows `sandbox.projectRoots` (default `@parent`, the parent of the repository) read-only.
That default is exactly the wrong thing for workstreams: with `~/Workspace` as the parent, every other workstream's repositories are readable.
So W3 builds on the sandbox rather than beside it:
- a session's project roots are its home workstream's folders plus its references, never the bare `@parent`;
- every other workstream's matched folders under a shown root go into the session's hidden paths;
- the `Bash` row above becomes **enforced** for a sandboxed session, because a command runs inside the fence; the gate's path check stays for the file tools that run outside the sandbox (Claude native's, opencode's), exactly as `sandbox/host-file-tools.ts` already holds them to the sandbox's spec.
An unsandboxed session (`--sandbox off`) keeps the weaker rows as written.

## 8. When configuration changes

- The config has a **revision** (a hash of the `workstreams` block, so it is the same across restarts for the same config), and each binding records the revision it applied.
- **Narrowing** changes take effect at the **next turn boundary** of every affected live session, with a backend restart. That includes removing a server, removing a reference, and tightening `share`.
  Waiting for a manual refresh would leave a revoked credential live, which is the wrong failure.
- **Widening** changes (adding a server, loosening `share`) take effect at the next turn boundary too (as built, W2: the session's MCP view fingerprint includes its grant, and a change either way rebuilds the backend — simpler, and a rebuild is cheap next to a turn).
- A session's **env** (its workstream's env credentials and git identity) is read live as well: a credential cleared or an env entry removed is gone from the backend's next start, which the same next-turn rebuild brings (W2 audit).
- **Deleting a workstream** re-homes its sessions to the default only if they have no running turn. Otherwise they are marked `orphaned` and refuse new turns until re-homed. Memory keeps its tag.
- **Changing match rules** never re-homes a live session. It affects only new sessions. The panel lists the sessions that would resolve differently.

## 9. Federation

Workstreams are owner configuration, so they live on the **hub** and travel to satellites the same way federation-design plans for other owner settings.
Two things make this work across machines:

- **Remote rules are machine-independent.** `github.com/highflame-ai/*` means the same thing on every box. Path rules are expanded per machine (`~`), and a satellite can add machine-local path rules if its layout differs.
- **Secrets never travel.** `env` holds references, and each machine resolves them from its own secret store.
  If a satellite lacks a secret, sessions of that workstream can't be **placed** on that machine. That gives federated dispatch a real placement rule: "Sentisum work runs only where the Sentisum token lives".

The fleet board treats workstream the way federation-design §14.1 treats machine: **a badge and a filter, not the grouping.**

## 10. The conductor

The conductor is the one session whose job crosses workstreams, and this design keeps that without making it the leak.

- **Home.** The conductor is homed in a reserved `conductor` workstream. It is given no workstream's servers and no workstream's env.
  Its own capabilities (fleet, memory, notes, web) are unchanged.
- **Reading across workstreams.** `fleet_list`, `fleet_find` and `fleet_recall` see every workstream.
  For a `closed` workstream they return **session cards, including the rolling summary, and status, but never episode text** (decided 2026-11-10: the summaries are what make "what's going on across my work" answerable).
  Each tool gains a `workstream` filter, and each result carries its workstream id.
  The conductor can tell you "the Sentisum review is stuck on Ankit, and the migration PR is waiting on CI". It can't quote Sentisum code or transcripts into another context.
  Because summaries do carry specifics, the boundary that matters is the next point: what the conductor *knows* never reaches another workstream's egress without passing through a worker homed there and an approval you see.
- **Acting goes through a session homed in the target workstream.** This is conductor-design §8 ("the conductor decides; a narrowly-scoped child acts") with one more constraint:
  every send-class action names a target workstream, and it runs in a worker **homed there**.
  - That worker has only the target workstream's servers, credentials and memory.
  - A Highflame Slack reply is drafted by a worker that has never seen a Sentisum episode.
  - The approval card shows the workstream as well as recipient, repo and content.
- **`fleet_spawn`** takes `workstream` and follows §5. A conflicting spawn returns `workstream_conflict` to the conductor, and it has to choose instead of guessing.
- **Intake.** When the conductor's Slack and GitHub intake arrives (Slack front end, a later phase), each inbox source is bound to one workstream: Highflame Slack to `highflame`, Sentisum Slack to `sentisum`.
  A signal is born with its workstream, and its reply worker inherits it.

This is why workstreams belong in codeoid's core rather than in a personal layer on top. The conductor can only be safe across all of an owner's lines of work if the boundary exists below it.

## 11. Rejected alternatives

- **A workstream as a ZeroID project (tenant).** This gives real auth isolation, but the conductor would need a token per tenant to read across them, and the owner would need to log in per workstream.
  Tenancy is for separating principals. One person's lines of work are one principal with several policies.
- **Regex-only matching.** It's error-prone for paths and doesn't follow a repo across machines. Globs plus remote rules do both.
- **Explicit choice always wins, silently.** That turns the picker into a way around every credential boundary. The chosen design lets it win only after a warning you confirm (§5.2).
- **The folder always wins, with no explicit choice.** Scratch folders and new projects have no folder yet, and "start a Dhishvari session in `/tmp`" is a real need.
- **A separate daemon per workstream.** This isolates fully but loses the conductor's whole view, shared memory infrastructure, and one approval queue. It also multiplies the mobile and Telegram front doors.

## 12. Interfaces

### Protocol (`packages/protocol`)

| Message | Scope | Purpose |
| --- | --- | --- |
| `workstream.list` | `settings:read` | the items, a summary of resolved matches, conflicts, unassigned global servers |
| `workstream.upsert` / `workstream.delete` | `settings:write` | edit; validates globs, overlap and server names; bumps the revision |
| `workstream.resolve { workdir }` | `session:create` | what the picker shows: home, source, `matchedBy`, conflicts, allowed references |
| `session.create.workstream`, `session.create.references` | `session:create` | explicit choice (§5) |
| `session.set_workstream`, `session.add_reference`, `session.remove_reference` | `session:send` (+ approval per §7.1) | changes mid-session |
| `SessionInfo.workstream` | — | badge and filter on the fleet board, session list and Rust TUI mirror |

Workstreams are a list of structured objects, so they get their own messages and their own panel, as accounts and MCP servers do.
They don't fit the scalar fields of the settings manifest (`settings/manifest.ts`).

### Web UI

- **Settings → Workstreams**, a list editor beside the **Accounts** and **MCP Servers** panels (`AccountsPanel.tsx` and `McpServersPanel.tsx` are the patterns):
  - name, color, match rules with a **live preview** of the folders and current sessions each rule matches;
  - an MCP server checklist drawn from the registry, plus a warning for unassigned global servers;
  - an account per backend; default model and effort; secret references for env;
  - the `claim` and `share` policies, with a one-line explanation of each next to the control.
- **New-session dialog**: a workstream picker, pre-filled from `workstream.resolve` as you choose the folder, with a "matched by …" hint.
  An exclusive-claim conflict is shown inline with options (a) and (b), before you submit. There is a reference picker filtered by `share`.
- **Session header**: a workstream chip. Clicking it shows servers, references and "move to…".
- **Fleet board**: filtered by workstream and colored by workstream.
- **Mobile and Telegram approval cards** show the workstream badge beside the recipient, repo and content, so an approval is never made without knowing which line of work it acts in.

### CLI

```bash
codeoid workstream ls | show <id> | add <id> --path <glob> --remote <pat> | rm <id>
codeoid workstream match <dir>          # what would this folder resolve to, and why
codeoid new <name> <dir> --workstream <id> [--ref <workstream>[:<path>]]...
codeoid workstream move <session> <id>
```

### 12.1 W3 as built (2026-11-11)

- **Enforcement switch.** Everything W3 enforces (the fence, recall scoping) is on only with `isolateGlobalServers`, like W1's servers. Without it, episodes are still tagged with `workstream_id` and references are recorded, but nothing is fenced.
- **What is fenced.** Another workstream's folders, not everything outside the home: a blanket deny would refuse toolchains and system headers, and the cross-workstream read is the risk. A workstream's folders are its path rules expanded on disk (`workstreams/folders.ts`: one segment at a time, links followed only where the rule names a segment literally, at most 512) plus its recorded homes' repository tops (never the home, nor a top at or above it). Every one is fenced, nested in the home's or holding it: what the session may read inside one (`WorkstreamFence.readable`: its workdir and repository, its home's folders, exactly what its references grant) is carved out of it (the gate: a path in a foreign folder and in none of those; the sandbox: every other entry on the way to them, `carveOut`, else the folder whole).
- **Sandbox.** The fence's readable folders replace `@parent` as the project roots unless the session's own setting names roots; other workstreams' folders go into the spec's hidden paths (`SpecInputs.extraHidden`), and a root inside one is dropped. A change of fence is a change of directories, applied between turns (`SessionSandbox.dirsPending`).
- **Gate.** `workstreams/gate.ts` judges every tool call's read, search and write paths (secret-paths.ts and held-writes.ts extractors), in every mode; Claude's PreToolUse hook refuses the same calls, since the CLI skips `canUseTool` for some.
- **Memory.** `episodes.workstream_id`, tagged with the home at write time. Recall stays the repository's (`workspace_id`), filtered to the home and references; untagged episodes stay visible. Cross-repository recall over a whole workstream is deferred.
- **`ask` grants.** The owner asking with `session:approve`, undelegated, is the approval. Anyone else (a delegated or send-only token) is asked of the owner on the session, and the verdict is judged again when they answer.
- **Read-from record.** `readFrom` is recorded when a reference is granted (it may be read from then).
- **Monorepos.** A session's repository top is its own only where no other workstream's folder holds it; a recorded home is widened to its repository's top only where no other workstream has a folder inside that top. A granted reference path counts only where it really is (written and real) inside the granting workstream's folders, at grant (resolved then) and at every fence.
- **Turn boundary.** `Session.setWorkstream` saves the new binding at once and applies it at the next turn's start (`#applyPendingWorkstream`); a running turn keeps its gate, servers, env and memory scope together.
- **Homed in another's folder.** `folderVerdict`: a home chosen in, or moved into, a folder another workstream holds (any claim) reads it, judged by that workstream's `share`, and it is added to `readFrom`. A move adds the old home (but the default) to `readFrom`.
- **Carve limit.** A carve past `CARVE_LIMIT` is tried at ten times it, then the folder is hidden whole; one holding the session's workspace can't be hidden whole, and is then left visible to its commands (said in `limits`), the gate still fencing its file tools.
- **Sealed.** A stored binding that can't be read back gives no home and `sealed: true`: what it read from is unknown, so it never moves.
- **Known limits:** a reference with `paths` gives the workstream's whole memory (recall isn't filtered by folder yet); an episode is tagged with the home that wrote it, so what a session read through a reference stays in its home's recall after that workstream closes; the conductor's fleet reads (`fleet_summary`, the dispatch digest) are W4's.
- **Deferred:** `Bash` commands naming another workstream's path in an unsandboxed session (§14 q4) are not yet asked about; fork *into* another workstream; skillDirs.

### 12.2 W4 as built (2026-11-11)

- **Fleet reads.** `FleetSessionView.workstream`; `fleet_list`, `fleet_find` and `fleet_recall` take a `workstream` filter and name each result's. `FleetDeps.textWithheld` (the manager: a `closed` workstream, under isolation) drops a closed workstream's episode text from `fleet_find` snippets, `fleet_summary` and `fleet_recall` (counted, not shown) and from the dispatch digest (`buildWorkerDigest`: status only), which is also what `fleet_tasks` shows.
- **No rolling summaries yet.** §10 promises a closed workstream's session cards and summaries; nothing writes session cards today (`memory/cards.ts` has no caller), so a closed workstream gives status and metadata only until cards exist (backlog).
- **Spawns.** `fleet_spawn.workstream`; `FleetDispatchDeps.checkWorkstream` before queueing (`#fleetSpawnHome`: `forCreate` with the folder required under isolation, `folderVerdict`), stored on the task (`dispatch_tasks.workstream`, `workstream_override`) and judged again at claim. The approval card (`ToolWaitingConfirmationState.targetWorkstream`, from `Session` `fleetTargetWorkstream`, the manager's `#fleetCardWorkstream`) names the workstream and warns of the override approving it confirms (G3), or of a refusal.
- **Egress.** `workstreams/egress.ts` `planEgress`: a tested stub (G6) — a message names its workstream and is sent by a worker homed there, never by the conductor; wired when P6's Slack and email egress lands.
- **The conductor's own memory.** Its recall includes its reserved workstream's episodes (it couldn't reach them under isolation before).
- **Phones.** The fleet rail docks beside the chat from `md` up; below, the chat (and its approval card) has the width.

## 13. Phases

| Phase | Ships | Enforced by the end |
| --- | --- | --- |
| **W0** | schema and config, resolver, `codeoid workstream match`, binding in session meta, `SessionInfo.workstream`. **No behavior change.** | nothing. Visibility only, to check the rules against real folders |
| **W1** | per-workstream MCP servers (all three sharing kinds in §6.5), env, git identity and `skillDirs`; `extends`; `isolateGlobalServers`; Claude `deniedMcpServers` by URL; `codeoid workstream import` | **credentials**, the part the owner needs first |
| **W2** | Web UI: settings panel, picker, conflict flow, chip, fleet filter; CLI `new --workstream` | — |
| **W3** | memory `workstream_id`, scoped recall, references with `share` policy, path gate for file tools | recall and file-tool reads |
| **W4** | conductor: reserved home, workstream-aware fleet tools, workers homed in the target workstream for send-class actions | the conductor's egress |
| **W5** | federation: placement by secret availability; remote-rule resolution on satellites | placement |

**Moving off today's setup.** `codeoid workstream import` reads `~/.claude.json` and the git remotes of folders under the workspace root, then *proposes* workstreams: groups of folders by remote owner, with the global servers each group seems to use.
You review and edit the proposal in the panel, save it, and only then turn on `isolateGlobalServers`.
Nothing is enforced until you flip that switch, so the import can be tried with no risk.

How this fits [conductor-build-plan.md](./conductor-build-plan.md):
- **W0–W1 come before P5 (front doors).** Once the conductor is reachable from a phone, its sessions need the credential boundary.
- **W4 is a prerequisite of P6** ("act on behalf"). Slack and email egress must be workstream-homed from the first send.
- **W3's path gate is the same code site as the R6 path-scoped write** (conductor-design §3). Build them together.

## 14. Open questions (grill seeds)

**Settled 2026-11-10:**

1. ~~**Exclusive-claim conflict.**~~ Warn and confirm, via the approval flow. Per-workstream `allowOverride: false` for a hard refusal (§5.2).
2. ~~**Conductor and `closed` summaries.**~~ The conductor sees card summaries and status. It never sees episode text (§10).
7. ~~**Default workstream.**~~ Optional. With none set, unmatched folders must pick (§5.1).
3. ~~**A reference after a `share` tightening.**~~ The reference is removed at the next turn (§8). The session is also tagged "has read from *X*" for its lifetime, so a later fork or move into another workstream follows *X*'s **new** policy, not the policy at the time of the read.
4. ~~**`Bash` in a session with references.**~~ Approval is required only for `Bash` commands that name a path outside the home workstream and its references. Other `Bash` calls are unaffected. It is a cheap check, not a fence (§7.3).
6. ~~**Forks of another organisation's repo under your own account.**~~ Remote rules also check the `upstream` remote. A match through `upstream` alone counts as `claim: suggest`, never `exclusive`: you see where the code came from, but you are not blocked.

**Still open:** none from the first round. The next round belongs to `/grill-feature` against W1's credential model (§6.5 case 2 and the OAuth credential slot).

## 15. Deferred (backlog)

- **`skillDirs`** (W1): accepted, not applied. Delivering skills per session safely reuses the pack's per-entry plugin synthesis (pipeline/pack-service.ts `#ensureSkillPlugin`), which wants extracting rather than copying.
- **Orphaned sessions refusing turns** (§8): under isolation an orphaned session already gets built-ins only; refusing its turns waits for `session.set_workstream` (W3), so there is a way out.
- **Workstream env on opencode**: its one shared server takes no per-session process env; a session's shell environment could carry it.
- **MCP prompts and resources through the Claude bridge**: the bridge serves tools only.

- **Per-workstream spend caps** (was open question 5). A daily cap per workstream plus an overall cap, so an unattended loop in one workstream can't use up the subscription quota another needs.
  Deferred on 2026-11-10. It stays a prerequisite of unattended routines across workstreams, the same position as the amended R5 in conductor-design.
- **A real read fence** (§7.3): a per-session OS sandbox with the home and reference folders bound in. Decide together with conductor-design open question #10.
- **`regex:` match rules** (§4), only if a real case needs them.
