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
- **Every request, both ways.** Client→server requests (`tools/*`, `resources/*`, `prompts/*`, `completion/complete`, `logging/setLevel`, `ping`, and methods added later) are forwarded generically through the SDK's `fallbackRequestHandler`. Server→client requests (`sampling/createMessage`, `elicitation/create`, `roots/list`) are forwarded to the backend, and are possible only because the upstream saw the backend's own capabilities.
- **Notifications, both ways.** Progress, cancellation, `*/list_changed`, `resources/updated` and log messages are relayed; a cancelled request is cancelled upstream; a backend that disconnects cancels its in-flight upstream requests.
- **Policy at the relay.** The server's `toolAllowlist` filters `tools/list` and refuses any other `tools/call`; each request has the session's MCP timeout; a request body is capped.

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

A command that reads the backend's own process memory or config can still find it; that already needs an approved shell call, and the token works only on the loopback relay, for that session's servers, until the backend is rebuilt.

**Reachability.**
The relay answers only loopback peers, even when the daemon binds wide, and refuses a request whose `Origin` or `Host` isn't loopback (the SDK's DNS-rebinding protection), so a web page can't drive it.

**Sign-in, live.**
A server the tenant hasn't signed in to (or whose token was refused) still initializes, so the backend doesn't mark it failed or start an OAuth flow of its own; `tools/list` and every call return a JSON-RPC error the model can read ("<server> needs sign-in — connect it in Settings"), never an HTTP `401`.
When the tenant signs in, the relay connects upstream on the next request and sends `notifications/tools/list_changed`, so a running Codex, Gemini CLI or Qwen session gets the tools without a restart.
Signing out closes the upstream sessions for that (tenant, server), and the next request gets the sign-in error.

**One copy per backend.**
The registry's servers split cleanly: `forNativeMount` (not OAuth) is mounted by the backend directly, `oauthFor` (OAuth) through the relay, so a server is never connected twice.
A server adopted from Claude's config (#390) is an OAuth registry entry, so it goes through the relay like any other; these backends don't read Claude's config, so there is no CLI copy to deny.

**Limits.**
At most 8 relay sessions per proxy token and a 4 MB cap on a request body.
An upstream session idle for 10 minutes is closed and reopened on the next request; the backend's own session stays, so an idle agent doesn't see its server go away.
Everything closes with the token: when the backend is rebuilt or torn down, or the session ends.

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
