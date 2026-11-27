/**
 * Web-UI frontend — serves the built SolidJS app (`web/dist`) from the
 * daemon at `/ui/*`. This makes the daemon a single origin for the UI, the
 * WebSocket, and the ZeroID token proxy, so one HTTPS tunnel exposes the
 * whole thing — which is exactly what a Telegram Mini App needs.
 *
 * Build it with `cd web && bunx vite build --base=/ui/` (the `/ui/` base
 * makes the emitted asset URLs resolve under this mount).
 *
 * Embed-SSO trust: when the daemon serves `index.html` it injects the
 * operator-configured embed allowlist as `window.__CODEOID_EMBED_ORIGINS__`
 * (a synchronous global, defined before the SPA boots). The web UI's
 * trusted-framing-origin gate reads it to decide whether a URL-hash
 * credential handoff may be consumed (see web/src/lib/handoff.ts). This is
 * the delivery channel for the allowlist — the client reads no other daemon
 * config surface synchronously at boot, and the gate must run before any
 * credential is consumed, so a synchronous injected global fits better than
 * an async fetch. Empty allowlist ⇒ no origin is trusted ⇒ handoff disabled.
 *
 * Local mode: the page never carries the token (#448 round 4). Being a
 * loopback client proves nothing — an agent's sandboxed command with the
 * network on is one — so the token goes only to a browser that presents a
 * one-time code it was given out of band: the link the start banner prints,
 * or one `codeoid ui` asks for with the token it read from its file (hidden
 * from every sandbox). The page exchanges the code once
 * (`POST /ui/local-session`) and keeps the token itself. The channel above
 * carries only `window.__CODEOID_LOCAL_MODE__`, so the sign-in box can say
 * how to get a link. Only for a LOOPBACK bind (the CLI decides); on a wide
 * bind the operator pastes the token.
 */

import { existsSync } from "node:fs";
import { join, normalize, resolve, sep } from "node:path";
import { isLoopbackHost, type LocalUiLinks, sameLocalToken, UI_LINK_TTL_MS } from "../../daemon/local-auth.js";
import type { Frontend, FrontendContext } from "../types.js";

// src/frontends/web-ui → repo root → web/dist
const DIST = resolve(import.meta.dir, "../../../web/dist");

/**
 * Build the inline <script> of boot-time globals injected into `index.html`.
 *
 * Pure and exported so it is unit-testable without a built UI on disk.
 * Values are operator- or daemon-controlled, but they are JSON-encoded with
 * `<` neutralized so nothing can close the <script>. No credential is ever
 * in it: whoever can fetch the page (a sandboxed command on the loopback, a
 * page whose domain an attacker rebinds to 127.0.0.1) reads all of it.
 */
export function buildBootScript(opts: {
  allowedOrigins?: readonly string[];
  /** The daemon is in local mode on a loopback bind: the page can be signed in by a one-time link. */
  localMode?: boolean;
}): string {
  const enc = (v: unknown): string => JSON.stringify(v).replace(/</g, "\\u003c");
  let script = `window.__CODEOID_EMBED_ORIGINS__=${enc(opts.allowedOrigins ?? [])};`;
  if (opts.localMode) script += "window.__CODEOID_LOCAL_MODE__=true;";
  return `<script>${script}</script>`;
}

/** Where the page exchanges a one-time code for the local token. */
export const LOCAL_SESSION_PATH = "/ui/local-session";
/** Where `codeoid ui` asks for a fresh code, with the token. */
export const LOCAL_LINK_PATH = "/ui/local-link";

/** What local mode gives the web UI: the token, and the one-time codes that get it. */
export interface WebUiLocal {
  token: string;
  links: LocalUiLinks;
}

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * `POST /ui/local-session` `{code}` → `{token}`, once per code; and
 * `POST /ui/local-link` with the token as its bearer → a fresh `{code}`.
 * Anything else (no code, a spent or expired one, no bearer, a wrong one,
 * a Host that isn't loopback) gets no token and no code. Exported for tests.
 */
export async function handleLocalSignIn(req: Request, path: string, local: WebUiLocal | undefined): Promise<Response | null> {
  if (path !== LOCAL_SESSION_PATH && path !== LOCAL_LINK_PATH) return null;
  if (!local) return new Response("Not Found", { status: 404 });
  if (req.method !== "POST") return Response.json({ error: "POST only" }, { status: 405, headers: { Allow: "POST" } });
  // A page whose domain is rebound to 127.0.0.1 is answered nothing here either.
  if (!hostIsLoopback(req.url)) return Response.json({ error: "local sign-in is for this machine's own address only" }, { status: 403, headers: NO_STORE });
  if (path === LOCAL_LINK_PATH) {
    const auth = req.headers.get("authorization") ?? "";
    const bearer = /^Bearer\s+(\S+)$/i.exec(auth)?.[1] ?? "";
    if (!bearer || !sameLocalToken(bearer, local.token)) return Response.json({ error: "this needs the daemon's local token" }, { status: 401, headers: NO_STORE });
    return Response.json({ code: local.links.mint(UI_LINK_TTL_MS), expiresInMs: UI_LINK_TTL_MS }, { headers: NO_STORE });
  }
  let code: unknown;
  try {
    const body = await req.text();
    if (body.length > 1024) return Response.json({ error: "request too large" }, { status: 413, headers: NO_STORE });
    code = (JSON.parse(body) as { code?: unknown }).code;
  } catch {
    code = undefined;
  }
  if (!local.links.redeem(code)) {
    return Response.json({ error: "this sign-in link has expired or was already used — run `codeoid ui` for a new one" }, { status: 403, headers: NO_STORE });
  }
  return Response.json({ token: local.token }, { headers: NO_STORE });
}

/**
 * The slice of `node:path` the asset resolver needs. Injectable so the
 * resolver can be exercised under Windows semantics (`path.win32`) from a
 * POSIX host — the separator bug this guards against is invisible otherwise.
 */
export type PathFlavor = { join: typeof join; normalize: typeof normalize; sep: string };

const NATIVE_PATH: PathFlavor = { join, normalize, sep };

/**
 * Map a `/ui/...` request path to a file under `distRoot`, or `null` when it
 * escapes that root.
 *
 * The containment check compares against `distRoot + sep`, NOT a hardcoded
 * `/`. `normalize()` emits the platform separator, so on Windows every legit
 * asset resolves to `C:\...\web\dist\index.html` — which does not start with
 * `C:\...\web\dist/`, and the whole UI 403s (issue #299). The separator has to
 * come from the same path flavor that produced the string being tested.
 */
export function resolveUiAsset(
  distRoot: string,
  urlPath: string,
  p: PathFlavor = NATIVE_PATH,
): { rel: string; target: string } | null {
  const rel =
    urlPath === "/ui" || urlPath === "/ui/" ? "index.html" : urlPath.slice("/ui/".length);
  const target = p.normalize(p.join(distRoot, rel));
  if (target !== distRoot && !target.startsWith(`${distRoot}${p.sep}`)) return null;
  return { rel, target };
}

/** Does this request's `Host` name a loopback address? Fails closed. */
function hostIsLoopback(requestUrl: string): boolean {
  try {
    return isLoopbackHost(new URL(requestUrl).hostname);
  } catch {
    return false;
  }
}

export class WebUiFrontend implements Frontend {
  readonly name = "web-ui";

  /** Origins allowed to frame the UI + hand it a credential (embed SSO). */
  readonly #allowedOrigins: readonly string[];

  /**
   * Local mode's token and sign-in links, or undefined. Set ONLY when the
   * daemon is in local mode AND bound to loopback — see the module doc.
   */
  readonly #local: WebUiLocal | undefined;
  readonly #dist: string;

  constructor(allowedOrigins: readonly string[] = [], local?: WebUiLocal, dist: string = DIST) {
    this.#allowedOrigins = allowedOrigins;
    this.#local = local;
    this.#dist = dist;
  }

  get #indexHtml(): string {
    return join(this.#dist, "index.html");
  }

  async start(_ctx: FrontendContext): Promise<void> {
    if (existsSync(this.#indexHtml)) {
      console.log("[codeoid] web-ui (Mini App) served at /ui");
      if (this.#allowedOrigins.length > 0) {
        console.log(
          `[codeoid] web-ui embed SSO allowlist: ${this.#allowedOrigins.join(", ")}`,
        );
      }
      if (this.#local) {
        console.log("[codeoid] web-ui: local mode — the link in the banner (or `codeoid ui`) signs a browser in");
      }
    } else {
      console.error(
        `[codeoid:web-ui] no build at ${this.#dist} — run: cd web && bunx vite build --base=/ui/`,
      );
    }
  }

  async stop(): Promise<void> {}

  /** Read index.html and inject the boot-time globals just inside <head>. */
  async #serveIndexHtml(): Promise<Response> {
    let html = await Bun.file(this.#indexHtml).text();
    const inject = buildBootScript({ allowedOrigins: this.#allowedOrigins, localMode: this.#local !== undefined });
    // Insert right after the opening <head> so the global is defined before the
    // SPA module executes. Fall back to prepending if there's no <head>.
    html = /<head[^>]*>/i.test(html)
      ? html.replace(/<head[^>]*>/i, (m) => `${m}${inject}`)
      : `${inject}${html}`;
    return new Response(html, {
      headers: {
        "Cache-Control": "no-cache",
        "Content-Type": "text/html; charset=utf-8",
      },
    });
  }

  async handleFetch(req: Request): Promise<Response | null> {
    const path = new URL(req.url).pathname;
    if (path !== "/ui" && !path.startsWith("/ui/")) return null;
    const signIn = await handleLocalSignIn(req, path, this.#local);
    if (signIn) return signIn;

    // Path-traversal guard — never serve outside the dist root.
    const asset = resolveUiAsset(this.#dist, path);
    if (!asset) return new Response("Forbidden", { status: 403 });
    const { rel, target } = asset;

    let file = target;
    if (!existsSync(file)) {
      // A missing asset (has an extension) is a real 404; a missing route
      // (no extension) is an SPA deep-link → serve index.html.
      if (rel.includes(".")) return new Response("Not Found", { status: 404 });
      file = this.#indexHtml;
    }
    if (!existsSync(file)) return new Response("UI not built", { status: 503 });

    // index.html (direct or SPA deep-link fallback) is served with the embed
    // allowlist injected; all other assets stream straight from disk.
    if (file === this.#indexHtml) return this.#serveIndexHtml();

    const cache = "public, max-age=3600";
    // Bun infers Content-Type from the file extension.
    return new Response(Bun.file(file), { headers: { "Cache-Control": cache } });
  }
}
