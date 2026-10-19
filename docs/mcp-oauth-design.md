# OAuth for remote MCP servers

## Problem

The official remote MCP servers for Notion, Google, Slack, GitHub and most SaaS tools authenticate with OAuth, per the MCP authorization spec.
codeoid's registry only supports a static bearer token read from an env var (`bearerTokenEnv`), so none of them are usable.

## Goals

- Connect any spec-compliant remote MCP server from codeoid itself — no Highflame dependency.
- Every backend reaches an OAuth server, not just the ones whose MCP client codeoid owns.
- The user's upstream token never leaves the daemon: not in a backend's config, argv, env or subprocess.
- Tokens refresh transparently for the life of a long session.
- Credentials are scoped to a tenant, like everything else codeoid stores.

## Non-goals

- Routing through Firehog. It is a planned alternative credential source, not a dependency; §7 leaves the seam.
- OAuth for stdio servers (they authenticate out of band) or for `native: true` servers (the backend owns their client, and its own OAuth).
- Token revocation at the authorization server on disconnect (local deletion only, for now).

## 1. The protocol, and who implements it

The MCP authorization spec (2025-06-18) is OAuth 2.1 with PKCE, discovered from the resource server:

1. An unauthenticated request gets `401` with `WWW-Authenticate: Bearer resource_metadata="…"`, or the client fetches the server's protected-resource metadata (RFC 9728).
2. That names the authorization server, whose metadata (RFC 8414, or OIDC discovery) gives the endpoints.
3. The client registers itself dynamically (RFC 7591) when the server allows it, else uses a pre-registered client id.
4. Authorization code + PKCE (S256), with the resource indicator (RFC 8707) binding the token to this MCP server.
5. Refresh tokens keep it alive.

codeoid does not hand-roll this.
The official `@modelcontextprotocol/sdk` client implements it end to end behind one entry point, `auth(provider, …)`, driving an `OAuthClientProvider` the host implements for storage and redirects.
It is already installed (the Claude Agent SDK requires it as a peer); it becomes a direct dependency.
codeoid supplies the provider: persistence in its own store, the redirect URL, and capture of the authorization URL.

## 2. Configuration

An HTTP registry server opts in with `oauth`:

```json
{
  "mcpServers": {
    "notion": { "url": "https://mcp.notion.com/mcp", "oauth": true },
    "google": {
      "url": "https://example.com/mcp",
      "oauth": { "clientId": "…", "clientSecretEnv": "GOOGLE_MCP_CLIENT_SECRET", "scopes": ["…"] }
    }
  }
}
```

- `oauth: true` — discover everything; register dynamically.
- `clientId` / `clientSecretEnv` — a pre-registered client, for servers without dynamic registration (the secret by env-var name, never inline).
- `scopes` — requested scopes; omitted, the server's advertised `scopes_supported` apply.
- `oauth` is only valid with `url`, and not together with `bearerTokenEnv` or `native: true`.

`mcpOAuth.redirectBaseUrl` (env `CODEOID_MCP_OAUTH_REDIRECT_BASE_URL`) sets the externally reachable daemon URL for the redirect, for a daemon reached through a tunnel or a remote host.
Unset, it is the loopback `http://127.0.0.1:<port>`, which OAuth 2.1 permits for native clients.

## 3. Credentials

One row per (account, project, server, server URL) in a new `mcp_oauth_credentials` table: the registered client information and the tokens, with the time they were saved so expiry is known.
The URL is in the key so a server re-pointed at another host never receives tokens minted for the old one.

- **Tenant-scoped.** A tenant is codeoid's unit of ownership for sessions, memory and settings; an MCP credential belongs to the same unit.
  Everyone in a tenant who can run sessions uses its connected accounts — the same trust boundary as the session list.
- Never returned to a client, never logged.
- Pending authorizations (the PKCE verifier, the `state`) live in memory for ten minutes and are single-use.

## 4. Connecting

1. Settings shows each OAuth server as connected or not, for the viewer's tenant.
2. "Connect" sends `mcp.oauth.begin {server}`.
   The daemon runs `auth()`: with a usable token it reports connected; otherwise it returns the authorization URL, which the client opens.
3. The provider redirects to `<redirectBase>/mcp/oauth/callback?code&state`.
   The daemon matches `state` to the pending authorization (tenant, server, verifier), checks the browser's binding cookie (below), exchanges the code, stores the tokens, and shows a "connected — you can close this tab" page.
4. When the browser cannot reach the daemon (remote daemon, loopback redirect), the page fails to load but its address holds the code.
   The user pastes that address into Settings: `mcp.oauth.complete {callbackUrl}` completes the same way.
5. "Disconnect" (`mcp.oauth.disconnect {server}`) deletes the tenant's tokens.

Scope: `settings:write`, as for backend sign-in — connecting an account is configuring the tenant.

## 5. Using the token — every backend, token stays in the daemon

Backends mount MCP servers two ways (see `provider-mcp-registry-design.md` §3):

| Backends | Today | For an OAuth server |
| --- | --- | --- |
| openai, gemini, pi | daemon-owned client (`McpHub`) | `HttpMcpClient` asks the credential source for a token per request; one client per (server, tenant) |
| claude | native mount, header baked at start | an in-process server per OAuth server, in front of `McpHub` as the session's tenant (#390); the CLI's own copy of the URL is denied |
| codex, gemini-cli, qwen | native mount, header baked at start | a loopback MCP relay in front of `McpOAuth`, with a per-session proxy token (§5.1, #396) |

A baked-in token cannot work for native backends: an access token lives about an hour, a warm Claude loop lives for hours, and a token in the backend's config is readable by the agent subprocess.

**Status.** OAuth servers are never baked into a native backend's config; every backend reaches them, Claude in-process (below) and Codex, the Gemini CLI and Qwen through the relay (§5.1).

**Claude (#390)** takes them in-process: for each OAuth registry server the tenant has signed in to, the provider mounts an SDK server under the server's own name (so tools stay `mcp__<server>__<tool>`) whose `tools/list` and `tools/call` go to `McpHub` with the session's tenant (`providers/claude/oauth-bridge.ts`).
The token stays in the daemon, refresh and the `401` retry are the hub's, and nothing listens on a port.
The CLI must not also connect its own copy (from `~/.claude.json` or a `.mcp.json`): a same-name mount alone doesn't stop it (measured: the CLI still dials its copy), so the provider passes every OAuth server's URL in the flag settings' `deniedMcpServers`, and leaves those servers out of the user servers it passes in.
The denylist and the mounts are fixed at query construction, so adopting a server, or signing in to or out of one, rebuilds the query on the next turn (it resumes the same conversation; the CLI's background work ends with the old process, as for any rebuild).
A live `setMcpServers` swap was tried and dropped: an interrupt while a turn's message waited behind it could not reliably stop that turn, and sign-in changes are rare.
A session never redials the CLI's copy of a server at a URL codeoid owns (decided by URL, by the provider, which sees the copy's config).
A server the hub can't list (signed out, a revoked token, down, a timeout) makes the in-process server's `tools/list` fail, so the CLI reports it failed rather than connected with no tools.
The rebuild key includes a per-tenant sign-in counter (bumped by sign-ins and sign-outs, not refreshes), so signing out and back in between two turns — say after a revoked token — still gets a fresh connection.
When the authorization server refuses a refresh (`invalid_grant`, or `invalid_client` / `unauthorized_client`, which end the client's registration too), the tokens are forgotten, so the server reads as signed out; a refresh that merely fails (network, 5xx, `temporarily_unavailable`) keeps them for the next try.

### 5.1 The proxy: Codex, the Gemini CLI and Qwen (#396)

Codex, the Gemini CLI and Qwen own their MCP clients, fix a server's headers when they start it, and run the agent's shell commands as their children.
So an OAuth server reaches them through a loopback **MCP relay** on the daemon: they mount `http://127.0.0.1:<port>/mcp/proxy/<server>` with a per-session proxy token, and the upstream token never leaves the daemon.

**A relay, not a byte forwarder.**
The proxy is an MCP server toward the backend and an MCP client toward the upstream server, one pair per backend MCP session, both on the official SDK (`WebStandardStreamableHTTPServerTransport` downstream, `Client` + `StreamableHTTPClientTransport` upstream).
A byte forwarder would have to re-implement, outside the protocol, what the token needs (refresh before a request, a `401` retry that replays the body, single-flight refresh, refusing redirects) and could not apply a tool allowlist to a streamed response.
A relay keeps all of that at the MCP layer and still carries the whole protocol:

- **Initialization.** On the backend's `initialize`, the relay connects upstream announcing the backend's own client capabilities, then answers with the upstream server's protocol version, capabilities, server info and instructions. Each hop negotiates its version with the SDK.
- **Requests, both ways.** The client→server methods MCP defines (`tools/*`, `resources/*`, `prompts/*`, `completion/complete`, `logging/setLevel`) are forwarded through the SDK's `fallbackRequestHandler`; any other method is refused without reaching the server, so a method MCP adds later is opened deliberately. `initialize` and `ping` are answered by the relay itself. Server→client requests (`sampling/createMessage`, `elicitation/create`, `roots/list`) are forwarded to the backend — on the stream of the call that made them — and are possible only because the upstream saw the backend's own capabilities. The server's `_meta` on them is dropped: a backend may read markers there as its own (Codex marks its tool approvals that way).
- **Notifications, both ways.** Progress, cancellation, `*/list_changed`, `resources/updated`, `elicitation/complete` and log messages are relayed (the methods MCP defines, the server's `_meta` dropped as on requests); a cancelled request is cancelled upstream, and so is one whose HTTP request the backend abandons (closes before the answer); ending a session cancels its calls in flight.
- **Policy at the relay.** A server with a `toolAllowlist` is only those tools here: `tools/list` is filtered, any other `tools/call` is refused, its resources, prompts and completions are neither advertised nor forwarded, and it can ask the backend something only during one of its calls. Each request has the session's MCP timeout (renewed by progress, up to four times it in all), which also bounds a server's question to the backend made during it; a request body is capped.

Tool calls keep the one approval gate: the backend asks codeoid before each call, as for any other MCP server it mounts.
The relay adds no second prompt.

**One upstream client.**
The relay and the hub (which serves the daemon-run backends and Claude's in-process bridge) open an HTTP server through the same layer, `mcp/upstream.ts`: the SDK `Client` over streamable HTTP, with codeoid's headers, bearer and redirect policy.
The hub still exposes only tools to its backends; the relay exposes everything.
(The hub's stdio client is unchanged: stdio servers have no OAuth.)

**Credentials upstream.**
The upstream transport gets its bearer from `McpOAuth.accessToken(server, tenant)` per request, the same source as the hub, so refresh-before-expiry, single-flight refresh, forgetting tokens the authorization server refuses, and the per-tenant sign-in counter are one implementation.
On an upstream `401` it reports the token rejected and retries once with a fresh one.
It never runs an interactive authorization and never follows a redirect while carrying a token.

**The proxy token.**
256 random bits, minted by the session's provider when it builds a backend, bound to the session's tenant (account, project), the session, and the names of the OAuth servers that backend may use (`McpRegistry.oauthFor(backend)`).
It lives only in daemon memory: revoked when the backend is torn down or rebuilt, when the session ends, and on daemon shutdown; a resumed session mints a new one.
The proxy authenticates it from the `Authorization` header only (no `?token=` fallback), takes the tenant from the token and never from the request, refuses a server the token isn't bound to, and fails closed on an unknown or revoked token.
It must not reach the agent's shell:

- the Gemini CLI and Qwen get it as a header in their MCP config, which their SDKs pass in-process;
- Codex reads it through `bearer_token_env_var`, and the provider adds that variable to Codex's `shell_environment_policy.exclude`, so commands Codex runs don't inherit it (never on argv, which any local process can read).

If the user's Codex config can't be read here (to keep their own excludes), OAuth servers aren't mounted on Codex rather than risk the token reaching its commands.
A command can still read the backend's own process: Codex's environment through `/proc/<pid>/environ` (readable by the same user, and `cat` or `grep` may need no approval there), the Gemini CLI's or Qwen's memory with more effort.
That's the limit of keeping it from a process the agent's commands run beside; what bounds it is the token's reach — the loopback relay, that session's servers, until the backend is rebuilt — and that using it needs a network call, which is approved like any other.

**Reachability.**
The relay answers only loopback peers, even when the daemon binds wide, and refuses a request whose `Origin` or `Host` isn't loopback, so a web page can't drive it (DNS rebinding included).
A tunnel on the same host that rewrites `Host` to a loopback name (one way to reach a daemon for the Telegram Mini App) makes remote requests look local; then the 256-bit token alone guards the relay.
Once a request is authenticated the daemon's idle-connection cut is lifted for it: a call may stay quiet as long as its tool runs.

**Sign-in, live.**
A server the tenant hasn't signed in to (or whose credential is lost mid-session, a refresh refused) still initializes, so the backend doesn't mark it failed or start an OAuth flow of its own.
It lists no tools (an error there may make a backend give up on the server for good, and miss the tools a sign-in brings), its instructions say it needs sign-in, a tool call answers with an error result the model reads ("<server> needs sign-in — connect it in Settings"), and anything else with JSON-RPC error `-32011` saying the same — never an HTTP `401`.
When the tenant signs in, the relay connects upstream on the next request and sends `notifications/tools/list_changed`, so a running Codex, Gemini CLI or Qwen session gets the tools without a restart.
A session started before the sign-in advertised only tools, so the server's resources and prompts reach it once the backend starts a new session.
Signing out closes the upstream sessions for that (tenant, server), and the next request gets the sign-in error.

**One copy per backend.**
The registry's servers split cleanly: `forNativeMount` (not OAuth) is mounted by the backend directly, `oauthFor` (OAuth) through the relay, so a server is never connected twice.
A server adopted from Claude's config (#390) is an OAuth registry entry, so it goes through the relay like any other; these backends don't read Claude's config, so there is no CLI copy to deny.

**Limits.**
At most 8 relay sessions per proxy token for each server: a new one past that closes the least recently used that isn't mid-call (whose backend re-initializes if it returns), so a backend that opens a session per thread never locks itself out, and a call is never cut to make room.
At most 32 calls running upstream per token, each counted until it settles upstream — a call the backend abandons is cancelled, and counted until the cancel lands — and one JSON-RPC message per POST (no batches); a session's notification stream and its `DELETE` aren't calls, so a backend can always close what it opened.
At most 30 new sessions per token per minute.
An `initialize` is checked in full (its schema, `Accept`, `Content-Type`) before anything opens upstream or any session makes room, and a request body is capped at 4 MB as it streams in; the daemon's idle-connection cut is lifted only once the body is in.
An upstream session idle for 10 minutes — no request in flight, no resource subscription held on it — is closed and reopened on the next request; the backend's own session stays, so an idle agent doesn't see its server go away.
Only a session that is itself gone (connection closed, the server forgot it, no connection to the server) is dropped after a failed request, or one that has failed three times running with timeouts or transport errors (stuck without saying so; a call the backend cancelled is no failure of the session); any other failure is that request's alone, and the calls beside it go on. The hub holds its shared sessions to the same rule, and drops only the session that failed, never a newer one.
A listing's tool that a strict client would reject is set right (its input schema made an object schema, invalid optional fields dropped) or, with no usable name, left out — so one malformed tool can't make a backend reject the rest, nor be hidden when it can be used.
Everything closes with the token: when the backend is rebuilt or torn down, or the session ends — the backend's side first, and the server's session with a bounded wait for its `DELETE`.

**Observability.**
The relay records per-tenant status (tools, last error) where the hub does, so Settings shows one status for a server whichever path used it, and logs errors through `cleanMcpError`.
Minting and revoking a proxy token is not audited (it is the daemon's own bookkeeping); every tool call is already audited by the approval gate.

**Not covered.**
Legacy HTTP+SSE upstreams (the registry's `http` transport is streamable HTTP); stdio servers (no OAuth); OAuth for `native: true` servers (the backend owns their client).

## 6. Security

- The upstream token exists only in the daemon's store and memory.
  Agent subprocesses see a proxy token that works only against the loopback proxy, only for its session, and dies with it.
- `state` is random, single-use, time-limited and bound to the tenant that began the flow; PKCE binds the code to the verifier.
- **Login CSRF.** `state` alone does not prove who finishes a sign-in: whoever starts one holds its URL and could get someone else to approve it, binding that person's account into the starter's tenant.
  So `mcp.oauth.begin` also returns a binding secret, which the web UI sets as a cookie on the daemon's origin.
  The unauthenticated callback completes only for a browser holding it; any other completion must come through the authenticated `mcp.oauth.complete`, whose tenant must be the one that began it.
  A refused callback leaves the sign-in pending, so its owner can still paste the address.
- At most 16 sign-ins per tenant are pending at once; the oldest is dropped.
- The daemon's MCP client follows no redirect on a request carrying an OAuth token.
- A server's settings status (health, tools, last error) is per tenant for OAuth servers, since the calls run as that tenant.
- The resource indicator is validated by the SDK against the configured server URL, so a token minted for one server is not presented to another.
- Client secrets are read by env-var name, never inline.
- Tool calls keep going through the one approval gate; OAuth changes who can reach a server, not what a call may do.

## 7. Credential source seam (Firehog later)

Token lookup goes through one interface, `McpCredentialSource.accessToken(server, tenant)`.
The OAuth engine is its first implementation.
A Firehog-routed deployment is a second: route the MCP mount through Firehog (`token_broker` / `oauth_passthrough`), which holds the credential, and codeoid holds none.
Nothing in §1–§6 assumes Highflame.

## 8. Slices

1. Config, registry normalization, credential store.
2. OAuth engine on the SDK's `auth()`: begin, complete, access token with refresh, status, disconnect.
3. Callback route and the `mcp.oauth.*` protocol.
4. `McpHub` HTTP client uses the engine; tenant flows into the call scope.
5. Native mounters (claude, codex, gemini-cli, qwen) skip OAuth servers in their direct mounts (claude reaches them since step 7, the rest since step 8).
6. Settings: connect / disconnect / paste fallback, status per tenant.
7. Claude: in-process mounts in front of the hub, and adopting a server from Claude's config (`mcp.adopt`, #390).
8. The relay (§5.1), so Codex, the Gemini CLI and Qwen mount OAuth servers too (#396).

## 9. Testing

A local fake authorization server and protected MCP server (both `Bun.serve`) implement the spec's surface — protected-resource metadata, AS metadata, dynamic registration, authorize, token and refresh — so the whole flow runs deterministically: discovery → registration → authorize → callback → token → tool call → expiry → refresh → `401` → retry, for both the hub path and the proxy path.
