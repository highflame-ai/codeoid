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
 * Local mode: the same channel carries the minted local token as
 * `window.__CODEOID_LOCAL_TOKEN__`, so opening `/ui` on a local-mode daemon
 * connects with no sign-in step at all. This is only ever populated for a
 * LOOPBACK bind (the CLI decides) — on a wide bind, serving the token inside
 * the HTML would hand full control to anyone who can reach the port, so there
 * the operator pastes it into the sign-in box instead.
 */

import { existsSync } from "node:fs";
import { join, normalize, resolve } from "node:path";
import { isLoopbackHost } from "../../daemon/local-auth.js";
import type { Frontend, FrontendContext } from "../types.js";

// src/frontends/web-ui → repo root → web/dist
const DIST = resolve(import.meta.dir, "../../../web/dist");
const INDEX_HTML = join(DIST, "index.html");

/**
 * Build the inline <script> of boot-time globals injected into `index.html`.
 *
 * Pure and exported so the trust decisions here are unit-testable without a
 * built UI on disk — there are two of them:
 *
 *  1. **Escaping.** Values are operator- or daemon-controlled, but they are
 *     JSON-encoded with `<` neutralized so nothing can close the <script>.
 *  2. **DNS-rebinding guard on the token.** A loopback-bound daemon is still
 *     reachable from a page whose domain an attacker rebinds to 127.0.0.1; the
 *     browser then treats the response as same-origin with the ATTACKER's
 *     origin and can read it. Since the token is the whole prize, it is emitted
 *     only when the request's own `Host` names a loopback address. Any other
 *     Host (a tunnel hostname, a rebound domain) gets the UI with no
 *     credential, and the operator pastes the token into the sign-in box.
 */
export function buildBootScript(opts: {
  allowedOrigins?: readonly string[];
  /** The minted local-mode token, when the daemon is in local mode. */
  localToken?: string;
  /** The full request URL — its hostname is the `Host` the client used. */
  requestUrl: string;
}): string {
  const enc = (v: unknown): string => JSON.stringify(v).replace(/</g, "\\u003c");
  let script = `window.__CODEOID_EMBED_ORIGINS__=${enc(opts.allowedOrigins ?? [])};`;
  if (opts.localToken && hostIsLoopback(opts.requestUrl)) {
    script += `window.__CODEOID_LOCAL_TOKEN__=${enc(opts.localToken)};`;
  }
  return `<script>${script}</script>`;
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
   * Local-mode token to hand the browser directly, or undefined. Set ONLY when
   * the daemon is in local mode AND bound to loopback — see the module doc.
   */
  readonly #localToken: string | undefined;

  constructor(allowedOrigins: readonly string[] = [], localToken?: string) {
    this.#allowedOrigins = allowedOrigins;
    this.#localToken = localToken;
  }

  async start(_ctx: FrontendContext): Promise<void> {
    if (existsSync(INDEX_HTML)) {
      console.log("[codeoid] web-ui (Mini App) served at /ui");
      if (this.#allowedOrigins.length > 0) {
        console.log(
          `[codeoid] web-ui embed SSO allowlist: ${this.#allowedOrigins.join(", ")}`,
        );
      }
      if (this.#localToken) {
        console.log("[codeoid] web-ui: local-mode token injected — /ui needs no sign-in");
      }
    } else {
      console.error(
        `[codeoid:web-ui] no build at ${DIST} — run: cd web && bunx vite build --base=/ui/`,
      );
    }
  }

  async stop(): Promise<void> {}

  /** Read index.html and inject the boot-time globals just inside <head>. */
  async #serveIndexHtml(req: Request): Promise<Response> {
    let html = await Bun.file(INDEX_HTML).text();
    const inject = buildBootScript({
      allowedOrigins: this.#allowedOrigins,
      localToken: this.#localToken,
      requestUrl: req.url,
    });
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

    const rel =
      path === "/ui" || path === "/ui/" ? "index.html" : path.slice("/ui/".length);
    const target = normalize(join(DIST, rel));
    // Path-traversal guard — never serve outside the dist root.
    if (target !== DIST && !target.startsWith(`${DIST}/`)) {
      return new Response("Forbidden", { status: 403 });
    }

    let file = target;
    if (!existsSync(file)) {
      // A missing asset (has an extension) is a real 404; a missing route
      // (no extension) is an SPA deep-link → serve index.html.
      if (rel.includes(".")) return new Response("Not Found", { status: 404 });
      file = INDEX_HTML;
    }
    if (!existsSync(file)) return new Response("UI not built", { status: 503 });

    // index.html (direct or SPA deep-link fallback) is served with the embed
    // allowlist injected; all other assets stream straight from disk.
    if (file === INDEX_HTML) return this.#serveIndexHtml(req);

    const cache = "public, max-age=3600";
    // Bun infers Content-Type from the file extension.
    return new Response(Bun.file(file), { headers: { "Cache-Control": cache } });
  }
}
