# Local mode — run Codeoid with no account and no login

> `codeoid start --local` runs the daemon with **no ZeroID, no account, no login, and no network on the auth path**.
> It exists so you can try Codeoid in under a minute, and so a single-operator machine never needs identity infrastructure it isn't using.
>
> It is a **deliberately degraded** posture, not the default. This page states exactly what you get and exactly what you give up.

## TL;DR

```bash
codeoid start --local          # terminal 1 — prints a token, binds 127.0.0.1 only
codeoid tui                    # terminal 2 — picks the token up automatically
```

Or open <http://localhost:7400/ui/> — already signed in, because the daemon hands the page its token.

To move to real identities later: `codeoid login`, then start without `--local`.

## What you keep

Almost everything that makes Codeoid interesting is orthogonal to identity, so it all still works:

| | |
|---|---|
| Cross-session verbatim memory | ✅ `recall()`, `recall_file()`, `timeline()` |
| Workspace memory index | ✅ auto-injected into every system prompt |
| Every backend | ✅ Claude, Codex, Gemini, Gemini CLI, OpenAI, pi |
| Cross-backend session fork | ✅ |
| Conductor + durable dispatch | ✅ |
| CLI-output compression, auto-rotation | ✅ |
| Git worktrees, parallel sessions | ✅ |
| Per-turn token / cost / cache telemetry | ✅ |
| TUI + web UI, device handoff, scrollback replay | ✅ |
| Audit log of every action | ✅ — but see below on *who* it attributes to |

## What you give up

Everything that requires a **verified** principal:

- **Per-agent and per-sub-agent identity.** No ZeroID SPIFFE/WIMSE URI is registered; agents run as `anonymous:*`.
- **Delegated sub-agent tokens and scope attenuation.** There is no issuer to mint them from.
- **Cascading revocation.** Nothing to revoke — the credential is a local file, and killing the daemon is the only revocation.
- **Cryptographic audit attribution.** The audit log still records *what* happened; the principal recorded is `anonymous:operator`, which is **self-asserted**. It proves the daemon accepted a token that could read a file on this machine — nothing more.
- **Multi-user sharing and delegation.** No scoped read-only share tokens for teammates.
- **The Telegram frontend.** Refused under `--local` (see [Telegram](#why-telegram-is-refused)).
- **Google OAuth sign-in for the web UI.** It works by exchanging at ZeroID's token endpoint, so it is disabled.

Every surface says so out loud: a startup banner, `authMode: "local"` on the wire, a `local mode` badge in the web UI status bar, and a warning at the top of the identity drawer.
If you ever see Codeoid demoed as "identity-first" without that badge missing, you are looking at the real posture.

## The trust model

**"No login" does not mean "no auth on the socket."**
The daemon runs coding agents with shell and file-write authority. A token-less port would be a remote-code-execution surface for any other process on the box — and any LAN peer, if bound wide. Local mode therefore follows the Jupyter model:

1. **A random 256-bit token is minted at startup** and printed in the banner.
2. **It is published to `~/.codeoid/local-token`** (mode `0600`) so clients on this machine pick it up with zero setup — and **removed when the daemon shuts down**, so it never becomes a durable credential lying around.
3. **The bind is loopback-only.** A non-loopback `--host` is *refused* unless you also pass `--local-allow-remote`.

None of that costs you a setup step. Nothing is typed, nothing is registered, nothing is fetched.

### The bind guard

```
$ codeoid start --local --host 0.0.0.0

--local refuses to bind 0.0.0.0: local mode has no ZeroID identity, so a non-loopback bind
exposes an agent with shell and file-write access to anything that can reach this port.
  • keep it local:   drop --host (defaults to 127.0.0.1)
  • need it remote:  use ZeroID auth (codeoid login) — real identities, revocable tokens
  • accept the risk: add --local-allow-remote (the minted token becomes the only guard)
```

If you genuinely need remote reach, use ZeroID. That is what it is for. `--local-allow-remote` exists for containers and lab setups where you have your own network boundary, and it changes one more thing: the web UI **stops** being handed the token automatically (see below), because on a wide bind the served HTML would hand full control to anyone who can reach the port.

### Why the web UI needs no sign-in

On a loopback bind the daemon injects the token into the `index.html` it serves, as a synchronous `window.__CODEOID_LOCAL_TOKEN__` global — the same channel it already uses to publish the embed-SSO allowlist. The page connects with it directly.

Two guards apply:

- **Loopback bind only.** Under `--local-allow-remote` the token is never injected; paste it into the sign-in box instead (the field accepts `codeoid_local_…` verbatim, no exchange).
- **A DNS-rebinding check on the request's own `Host`.** A loopback-bound daemon is still reachable from a page whose domain an attacker rebinds to `127.0.0.1`; the browser would then treat the response as same-origin with the attacker's origin and could read it. So the token is emitted only when the request's `Host` names a loopback address. Any other `Host` — a tunnel hostname, a rebound domain — gets the UI with no credential.

### Why Telegram is refused

Telegram is reached *through Telegram's servers* — a remote surface. Local mode's trust model is "whoever can read a `0600` file on this machine." Pairing them would let a locally-minted token stand in for a verified identity over the public internet, so the frontend refuses to start and the CLI declines to register it. Run `codeoid login` and start without `--local` to use Telegram.

## The tenant one-way door — read this before you invest work

Local-mode sessions live in a **reserved `local` / `local` tenant**.

That means sessions and memory you create in local mode **will not appear** after a later `codeoid login`, and vice versa. This is correct isolation — Codeoid scopes every session, every memory episode, and every audit row to `(account, project)`, and a self-asserted principal must not share a bucket with a verified one — but it reads like data loss if you aren't expecting it.

The database file is the same, so nothing is deleted and the embedding-model cache isn't duplicated. The rows are simply in a different tenant.

**Practical advice:** use local mode to evaluate, demo, and learn. Once you're doing work you want attributed, revocable, or shareable, `codeoid login` first.

## How clients find the token

Every Codeoid client resolves a credential in this order:

1. **`CODEOID_LOCAL_TOKEN`** — an explicit, per-invocation decision. Set it on the daemon too, to pin the token across restarts (useful in a container or a script).
2. **`~/.codeoid/local-token`** — the file the running local-mode daemon published.
3. **`CODEOID_API_KEY` / `config.json`'s `apiKey`** — the ZeroID path.

The published file outranks a stored ZeroID key on purpose. It exists *only while a local-mode daemon is listening* (it is written at boot and removed at shutdown), so it is a statement about the daemon you're about to talk to, whereas `apiKey` is durable config that says nothing about it. That's what lets you flip between postures without editing config either way.

A stale file left by a crash fails closed at the daemon's verifier with a message naming the file — it never silently authenticates anyone.

For the web UI, the daemon-injected global takes precedence over anything in `localStorage`, for the same reason.

## Flags and variables

| Flag | Effect |
|---|---|
| `--local` | Mint a token, publish it, bind loopback only, disable ZeroID-dependent subsystems |
| `--local-allow-remote` | Permit `--local` on a non-loopback bind. **Unsafe** — the minted token becomes the only guard, and the web UI no longer gets it automatically |

| Variable | Effect |
|---|---|
| `CODEOID_LOCAL_TOKEN` | On the daemon: use this token instead of minting one. On a client: present this token. |

| Path | Contents |
|---|---|
| `~/.codeoid/local-token` | The published token, mode `0600`. Written at boot, removed at shutdown. |

Check a running daemon's posture without connecting anything:

```bash
curl -s http://127.0.0.1:7400/config
# → {"zeroid_url":"…","auth_mode":"local"}
```

## Graduating to ZeroID

```bash
codeoid login              # paste a zid_sk_… key from Studio → Code Agents
codeoid start              # no --local
```

You now get per-agent identities, delegated sub-agent tokens with attenuated scopes, cascading revocation, cryptographic audit attribution, scoped share tokens for teammates, Telegram, and remote binds.
See the [README quickstart](../README.md#quick-start) and [Configuration](CONFIGURATION.md).

Remember the [tenant boundary](#the-tenant-one-way-door--read-this-before-you-invest-work): your local-mode sessions stay in `local/local`.

## For contributors — the design invariant

Local mode is a **second implementation of one function**, never a conditional inside the verified path:

```
verifyToken(token, config) → AuthContext        # src/daemon/auth.ts
TokenVerifier { mode, verify(token) }           # src/daemon/verifier.ts — the seam
  ├── ZeroIdVerifier                            # src/daemon/auth.ts      — primary
  └── LocalVerifier                             # src/daemon/local-auth.ts — degraded
```

The daemon picks one verifier at construction. Everything downstream — all ~20 `hasScope()` checks, `store.audit(subject, …)`, `RateLimiter.check(sub)`, tenant scoping — consumes the resulting `AuthContext` and never learns which issuer produced it.

**Reject in review:** any `if (localMode) …` branch inside a scope check, the handshake, an audit write, or any other enforcement site. The moment local mode becomes a conditional inside the verified path, it stops being an isolated second posture and becomes a hole in the first one.

Two further invariants are enforced by tests (`src/tests/local-auth.test.ts`, `src/tests/local-mode-server.test.ts`, `src/tests/web-ui-boot-script.test.ts`):

- **`local-auth.ts` never imports `@highflame/sdk`, directly or transitively.** A test walks the import graph. This is what makes local mode genuinely offline-capable, and it is the regression most likely to creep back in silently.
- **Local mode fails closed.** A wrong, empty, truncated, or superstring token is rejected with the same `4003` close code a bad JWT gets.
