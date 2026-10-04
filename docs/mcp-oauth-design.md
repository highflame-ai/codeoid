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
| claude, codex, gemini-cli, qwen | native mount, header baked at start | **not mounted yet** (`McpRegistry.forNativeMount`); planned: a daemon proxy |

A baked-in token cannot work for native backends: an access token lives about an hour, a warm Claude loop lives for hours, and a token in the backend's config is readable by the agent subprocess.

**Status.** The first release leaves OAuth servers off the native backends rather than bake in a token, and Settings names the backends a server does not reach yet.
The proxy below is the planned way to close that gap; nothing else in this design depends on it.

**The proxy (planned)** (`/mcp/proxy/<server>`, loopback) is a transparent streamable-HTTP forwarder.
Each session's provider mints an opaque proxy token bound to (account, project, session) — the memory endpoint's pattern — and mounts `{url: proxy, Authorization: Bearer <proxy token>}`.
The proxy authenticates the proxy token, looks up the tenant's upstream token, forwards the request (method, body and the MCP headers: `Mcp-Session-Id`, `MCP-Protocol-Version`, `Accept`, `Last-Event-ID`) with the upstream bearer, and streams the response back.
Unknown or revoked proxy tokens fail closed.
The provider revokes its token on teardown.

**Refresh** happens where the token is used: before a request when the saved token has expired, and once on an upstream `401` (then retry).
Refreshes for one (tenant, server) are single-flight.

**Not connected** is an error the model can read ("<server> needs sign-in — connect it in Settings"), returned as a JSON-RPC error, never a `401`: a `401` with `WWW-Authenticate` would make a backend's own MCP client start an OAuth flow of its own inside the agent process.

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
5. Native mounters (claude, codex, gemini-cli, qwen) skip OAuth servers; Settings says so.
6. Settings: connect / disconnect / paste fallback, status per tenant.
7. Later: the proxy, so native backends mount OAuth servers too.

## 9. Testing

A local fake authorization server and protected MCP server (both `Bun.serve`) implement the spec's surface — protected-resource metadata, AS metadata, dynamic registration, authorize, token and refresh — so the whole flow runs deterministically: discovery → registration → authorize → callback → token → tool call → expiry → refresh → `401` → retry, for both the hub path and the proxy path.
