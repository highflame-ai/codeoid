/**
 * OAuth for remote MCP servers (docs/mcp-oauth-design.md).
 *
 * The protocol — protected-resource discovery (RFC 9728), authorization-server
 * metadata (RFC 8414), dynamic client registration (RFC 7591), authorization
 * code + PKCE, resource indicators (RFC 8707), refresh — is the official MCP
 * SDK's `auth()`. This module is the host side it drives: an
 * `OAuthClientProvider` backed by codeoid's store, the redirect URL, pending
 * authorizations, and a token source for everything that calls a server.
 *
 * Credentials are per tenant (account, project) and never leave the daemon.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { auth, type OAuthClientProvider, type OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Store } from "../store.js";
import type { McpOAuthConfig, McpServerSpec } from "./types.js";

export interface McpTenant {
  accountId: string;
  projectId: string;
}

/**
 * Where a caller gets a credential for a server. The OAuth engine is the first
 * implementation; a Firehog-routed deployment would be another (§7) — nothing
 * that calls a server knows which.
 */
export interface McpCredentialSource {
  /** A usable access token, refreshed when expired; undefined = needs sign-in. */
  accessToken(spec: McpServerSpec, tenant: McpTenant): Promise<string | undefined>;
  /** The server rejected `token` (401): the next accessToken() refreshes it. */
  rejected(spec: McpServerSpec, tenant: McpTenant, token: string): void;
}

/** Thrown to the model/UI when a server has no usable credential. */
export class McpSignInRequired extends Error {
  constructor(readonly server: string) {
    super(`${server} needs sign-in — connect it in Settings (MCP servers)`);
    this.name = "McpSignInRequired";
  }
}

export const MCP_OAUTH_CALLBACK_PATH = "/mcp/oauth/callback";

/** How long a started sign-in stays completable. */
const PENDING_TTL_MS = 10 * 60_000;
/** Refresh this long before the reported expiry, so a request never races it. */
const EXPIRY_SKEW_MS = 60_000;
/** Every network call the SDK makes (discovery, registration, token). */
const OAUTH_FETCH_TIMEOUT_MS = 15_000;

type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>;

export interface McpOAuthOptions {
  store: Store;
  /** Externally reachable base of the daemon, e.g. `http://127.0.0.1:7400`. */
  redirectBaseUrl: () => string;
  /** Env for `clientSecretEnv` (default process.env). */
  env?: Record<string, string | undefined>;
  /** Injected for tests. */
  fetchFn?: FetchLike;
  now?: () => number;
}

interface PendingSignIn {
  server: string;
  tenant: McpTenant;
  state: string;
  /** Secret the starting browser holds (as a cookie); see {@link McpOAuth.complete}. */
  binding: string;
  verifier?: string;
  expiresAt: number;
}

/** What proves a completion belongs to the sign-in it names. */
export type McpOAuthProof =
  /** An authenticated client of this tenant (the paste fallback). */
  | { tenant: McpTenant }
  /** The unauthenticated callback route: the starting browser's binding cookie. */
  | { binding: string | undefined };

/** The callback reached a browser that did not start the sign-in. */
export class McpOAuthUnbound extends Error {
  constructor() {
    super(
      "This browser did not start this sign-in, so it was not completed here. " +
        "To finish it, copy this page's address into codeoid: Settings → MCP Servers → Finish.",
    );
    this.name = "McpOAuthUnbound";
  }
}

/** Cookie the starting browser holds for a sign-in, scoped to the callback path. */
export function mcpOAuthBindingCookieName(state: string): string {
  // `state` is base64url — already cookie-name safe.
  return `codeoid_mcp_oauth_${state}`;
}

/** Started sign-ins one tenant may hold at once; the oldest is dropped past it. */
const MAX_PENDING_PER_TENANT = 16;

export class McpOAuth implements McpCredentialSource {
  readonly #store: Store;
  readonly #redirectBase: () => string;
  readonly #env: Record<string, string | undefined>;
  readonly #fetch: FetchLike;
  readonly #now: () => number;
  /** state → a sign-in awaiting its callback. Single-use, time-limited. */
  readonly #pending = new Map<string, PendingSignIn>();
  /** Discovery results per server URL — spares refreshes the metadata round trips. */
  readonly #discovery = new Map<string, OAuthDiscoveryState>();
  /** In-flight refreshes, so concurrent callers share one. */
  readonly #refreshing = new Map<string, Promise<string | undefined>>();
  /** Tokens a server rejected: refreshed on next use even if not yet expired. */
  readonly #rejected = new Map<string, string>();

  constructor(opts: McpOAuthOptions) {
    this.#store = opts.store;
    this.#redirectBase = opts.redirectBaseUrl;
    this.#env = opts.env ?? process.env;
    this.#now = opts.now ?? Date.now;
    const base = opts.fetchFn ?? ((url, init) => fetch(url, init));
    this.#fetch = (url, init) => base(url, { ...init, signal: AbortSignal.timeout(OAUTH_FETCH_TIMEOUT_MS) });
  }

  /** The redirect URI every registration and authorization uses. */
  get redirectUrl(): string {
    return `${this.#redirectBase().replace(/\/+$/, "")}${MCP_OAUTH_CALLBACK_PATH}`;
  }

  /**
   * Start connecting a tenant to a server. Already connected (or silently
   * refreshable) → `connected`; otherwise the URL to send the user to.
   */
  async begin(
    spec: McpServerSpec,
    tenant: McpTenant,
  ): Promise<{ status: "connected" } | { status: "redirect"; url: string; state: string; binding: string }> {
    const oauth = oauthOf(spec);
    this.#sweepPending();
    const state = randomBytes(24).toString("base64url");
    const pending: PendingSignIn = {
      server: spec.name,
      tenant,
      state,
      binding: randomBytes(32).toString("base64url"),
      expiresAt: this.#now() + PENDING_TTL_MS,
    };
    const provider = this.#provider(spec, oauth, tenant, pending);
    const result = await auth(provider, { serverUrl: urlOf(spec), scope: scopeOf(oauth), fetchFn: this.#fetch });
    if (result === "AUTHORIZED") return { status: "connected" };
    if (!provider.authorizationUrl) throw new Error(`${spec.name}: the authorization server gave no sign-in URL`);
    this.#capPending(tenant);
    this.#pending.set(state, pending);
    return { status: "redirect", url: provider.authorizationUrl.toString(), state, binding: pending.binding };
  }

  /**
   * Finish a sign-in from the provider's redirect: its `code` and `state`, or
   * the full URL the browser landed on (the paste fallback).
   *
   * `state` alone is not enough. Whoever starts a sign-in holds its URL and
   * could get someone else to approve it, binding THAT person's account into
   * the starter's tenant (login CSRF). So a completion must also prove it is
   * the starter's: an authenticated client of the starting tenant, or — on
   * the unauthenticated callback route — the binding cookie the starting
   * browser was given. A failed proof leaves the sign-in pending, so its
   * owner can still finish it by pasting.
   */
  async complete(
    input: { callbackUrl: string } | { state: string; code?: string; error?: string; errorDescription?: string },
    proof: McpOAuthProof,
    resolveSpec: (server: string) => McpServerSpec | undefined,
  ): Promise<{ server: string; tenant: McpTenant }> {
    const params = "callbackUrl" in input ? parseCallback(input.callbackUrl) : input;
    const pending = params.state ? this.#pending.get(params.state) : undefined;
    if (!pending || pending.expiresAt < this.#now()) {
      if (params.state) this.#pending.delete(params.state);
      throw new Error("This sign-in is unknown or has expired — start it again from Settings.");
    }
    if ("tenant" in proof) {
      if (!sameTenant(proof.tenant, pending.tenant)) throw new Error("This sign-in was started for a different workspace.");
    } else if (!proof.binding || !safeEqual(proof.binding, pending.binding)) {
      throw new McpOAuthUnbound();
    }
    this.#pending.delete(pending.state); // single-use, whatever happens next
    if (params.error) {
      throw new Error(`Sign-in to ${pending.server} failed: ${params.errorDescription ?? params.error}`);
    }
    if (!params.code) throw new Error(`Sign-in to ${pending.server} returned no authorization code.`);
    const spec = resolveSpec(pending.server);
    if (!spec) throw new Error(`MCP server "${pending.server}" is no longer configured.`);
    const oauth = oauthOf(spec);
    const provider = this.#provider(spec, oauth, pending.tenant, pending);
    const result = await auth(provider, {
      serverUrl: urlOf(spec),
      authorizationCode: params.code,
      scope: scopeOf(oauth),
      fetchFn: this.#fetch,
    });
    if (result !== "AUTHORIZED") throw new Error(`Sign-in to ${pending.server} did not complete.`);
    this.#rejected.delete(keyOf(spec.name, pending.tenant));
    return { server: pending.server, tenant: pending.tenant };
  }

  async accessToken(spec: McpServerSpec, tenant: McpTenant): Promise<string | undefined> {
    const key = keyOf(spec.name, tenant);
    const tokens = this.#tokens(spec, tenant);
    if (!tokens) return undefined;
    const stale = this.#rejected.get(key) === tokens.access_token;
    if (!stale && !this.#expired(spec, tenant, tokens)) return tokens.access_token;
    if (!tokens.refresh_token) return undefined;
    const inFlight = this.#refreshing.get(key);
    if (inFlight) return inFlight;
    const refresh = this.#refresh(spec, tenant).finally(() => this.#refreshing.delete(key));
    this.#refreshing.set(key, refresh);
    return refresh;
  }

  rejected(spec: McpServerSpec, tenant: McpTenant, token: string): void {
    this.#rejected.set(keyOf(spec.name, tenant), token);
  }

  /** Whether the tenant has a credential the daemon can use (or refresh). */
  status(spec: McpServerSpec, tenant: McpTenant): "connected" | "disconnected" {
    const tokens = this.#tokens(spec, tenant);
    if (!tokens) return "disconnected";
    if (tokens.refresh_token) return "connected";
    return this.#expired(spec, tenant, tokens) ? "disconnected" : "connected";
  }

  /** Forget the tenant's tokens for a server (its client registration stays). */
  disconnect(spec: McpServerSpec, tenant: McpTenant): void {
    this.#store.clearMcpOAuth(tenant, serverOf(spec), "tokens");
    this.#rejected.delete(keyOf(spec.name, tenant));
  }

  // ── internals ──────────────────────────────────────────────────────────────

  async #refresh(spec: McpServerSpec, tenant: McpTenant): Promise<string | undefined> {
    const oauth = oauthOf(spec);
    // A throwaway pending record: if the refresh fails, auth() starts a new
    // authorization instead — which we don't follow here (no user to send).
    const scratch: PendingSignIn = {
      server: spec.name,
      tenant,
      state: randomBytes(24).toString("base64url"),
      binding: "",
      expiresAt: this.#now(),
    };
    try {
      const result = await auth(this.#provider(spec, oauth, tenant, scratch), {
        serverUrl: urlOf(spec),
        scope: scopeOf(oauth),
        fetchFn: this.#fetch,
      });
      if (result !== "AUTHORIZED") return undefined;
    } catch (err) {
      console.error(`[codeoid] mcp oauth: refreshing ${spec.name} failed: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
    this.#rejected.delete(keyOf(spec.name, tenant));
    return this.#tokens(spec, tenant)?.access_token;
  }

  #tokens(spec: McpServerSpec, tenant: McpTenant): OAuthTokens | undefined {
    const tokens = this.#store.getMcpOAuthCredential(tenant, serverOf(spec))?.tokens as OAuthTokens | undefined;
    return tokens?.access_token ? tokens : undefined;
  }

  #expired(spec: McpServerSpec, tenant: McpTenant, tokens: OAuthTokens): boolean {
    if (typeof tokens.expires_in !== "number") return false; // no expiry reported
    const savedAt = this.#store.getMcpOAuthCredential(tenant, serverOf(spec))?.tokensSavedAt ?? 0;
    return this.#now() >= savedAt + tokens.expires_in * 1000 - EXPIRY_SKEW_MS;
  }

  #sweepPending(): void {
    const now = this.#now();
    for (const [state, p] of this.#pending) if (p.expiresAt < now) this.#pending.delete(state);
  }

  /** Make room for one more of `tenant`'s sign-ins (Map order = oldest first). */
  #capPending(tenant: McpTenant): void {
    const mine = [...this.#pending.values()].filter((p) => sameTenant(p.tenant, tenant));
    for (const p of mine.slice(0, Math.max(0, mine.length - MAX_PENDING_PER_TENANT + 1))) this.#pending.delete(p.state);
  }

  #provider(spec: McpServerSpec, oauth: McpOAuthConfig, tenant: McpTenant, pending: PendingSignIn): StoredProvider {
    return new StoredProvider({
      store: this.#store,
      server: spec.name,
      serverUrl: urlOf(spec),
      tenant,
      pending,
      redirectUrl: this.redirectUrl,
      oauth,
      clientSecret: oauth.clientSecretEnv ? this.#env[oauth.clientSecretEnv] : undefined,
      discovery: this.#discovery,
      now: this.#now,
    });
  }
}

interface StoredProviderOptions {
  store: Store;
  server: string;
  serverUrl: string;
  tenant: McpTenant;
  pending: PendingSignIn;
  redirectUrl: string;
  oauth: McpOAuthConfig;
  clientSecret: string | undefined;
  discovery: Map<string, OAuthDiscoveryState>;
  now: () => number;
}

/** The SDK's host interface, backed by codeoid's store for one (tenant, server). */
class StoredProvider implements OAuthClientProvider {
  authorizationUrl: URL | undefined;
  readonly #o: StoredProviderOptions;

  constructor(o: StoredProviderOptions) {
    this.#o = o;
  }

  get #server(): { name: string; url: string } {
    return { name: this.#o.server, url: this.#o.serverUrl };
  }

  get redirectUrl(): string {
    return this.#o.redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "codeoid",
      redirect_uris: [this.#o.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: this.#o.clientSecret ? "client_secret_post" : "none",
      ...(this.#o.oauth.scopes ? { scope: this.#o.oauth.scopes.join(" ") } : {}),
    };
  }

  state(): string {
    return this.#o.pending.state;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    if (this.#o.oauth.clientId) {
      return {
        client_id: this.#o.oauth.clientId,
        ...(this.#o.clientSecret ? { client_secret: this.#o.clientSecret } : {}),
      };
    }
    const stored = this.#o.store.getMcpOAuthCredential(this.#o.tenant, this.#server)?.client as
      | OAuthClientInformationMixed
      | undefined;
    // A registration made for a different redirect (the daemon's reachable URL
    // changed) can't complete a flow here — register afresh.
    const uris = (stored as { redirect_uris?: string[] } | undefined)?.redirect_uris;
    if (stored && Array.isArray(uris) && !uris.includes(this.#o.redirectUrl)) return undefined;
    return stored;
  }

  saveClientInformation(info: OAuthClientInformationMixed): void {
    this.#o.store.saveMcpOAuthClient(this.#o.tenant, this.#server, info);
  }

  tokens(): OAuthTokens | undefined {
    return this.#o.store.getMcpOAuthCredential(this.#o.tenant, this.#server)?.tokens as OAuthTokens | undefined;
  }

  saveTokens(tokens: OAuthTokens): void {
    this.#o.store.saveMcpOAuthTokens(this.#o.tenant, this.#server, tokens, this.#o.now());
  }

  redirectToAuthorization(url: URL): void {
    this.authorizationUrl = url;
  }

  saveCodeVerifier(verifier: string): void {
    this.#o.pending.verifier = verifier;
  }

  codeVerifier(): string {
    if (!this.#o.pending.verifier) throw new Error("No PKCE verifier for this sign-in — start it again.");
    return this.#o.pending.verifier;
  }

  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    if (scope === "verifier") this.#o.pending.verifier = undefined;
    else if (scope === "discovery") this.#o.discovery.delete(this.#o.serverUrl);
    else this.#o.store.clearMcpOAuth(this.#o.tenant, this.#server, scope);
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.#o.discovery.get(this.#o.serverUrl);
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this.#o.discovery.set(this.#o.serverUrl, state);
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

function oauthOf(spec: McpServerSpec): McpOAuthConfig {
  if (spec.transport.kind !== "http" || !spec.transport.oauth) {
    throw new Error(`MCP server "${spec.name}" is not configured for OAuth`);
  }
  return spec.transport.oauth;
}

function urlOf(spec: McpServerSpec): string {
  if (spec.transport.kind !== "http") throw new Error(`MCP server "${spec.name}" has no URL`);
  return spec.transport.url;
}

function scopeOf(oauth: McpOAuthConfig): string | undefined {
  return oauth.scopes && oauth.scopes.length > 0 ? oauth.scopes.join(" ") : undefined;
}

/** A server's store address: its name and the URL its tokens are bound to. */
function serverOf(spec: McpServerSpec): { name: string; url: string } {
  return { name: spec.name, url: urlOf(spec) };
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function keyOf(server: string, tenant: McpTenant): string {
  return `${tenant.accountId}\u0000${tenant.projectId}\u0000${server}`;
}

function sameTenant(a: McpTenant, b: McpTenant): boolean {
  return a.accountId === b.accountId && a.projectId === b.projectId;
}

/** The redirect's query: `code` + `state`, or `error` (+ description). */
function parseCallback(callbackUrl: string): {
  state?: string;
  code?: string;
  error?: string;
  errorDescription?: string;
} {
  let url: URL;
  try {
    url = new URL(callbackUrl);
  } catch {
    throw new Error("That is not a URL — paste the full address the browser showed after signing in.");
  }
  const q = url.searchParams;
  return {
    ...(q.get("state") ? { state: q.get("state")! } : {}),
    ...(q.get("code") ? { code: q.get("code")! } : {}),
    ...(q.get("error") ? { error: q.get("error")! } : {}),
    ...(q.get("error_description") ? { errorDescription: q.get("error_description")! } : {}),
  };
}

