/**
 * The boot-time globals the daemon injects into the web UI's index.html, and
 * how a local-mode browser gets the token (#448 round 4).
 *
 *   1. the page never carries the token, for any Host: whoever can fetch it
 *      (a sandboxed command on the loopback with the network on, a page whose
 *      domain is rebound to 127.0.0.1) reads all of it. It says only that the
 *      daemon is in local mode;
 *   2. a one-time code (the banner's link, `codeoid ui`'s) is exchanged once
 *      for the token at `POST /ui/local-session`; a spent, expired, wrong or
 *      missing code gets nothing, nor does a Host that isn't loopback;
 *   3. a fresh code needs the token as its bearer (`POST /ui/local-link`);
 *   4. every injected value is escaped so it can never close the <script>.
 *
 * Tested against the pure builder and handler, and through `handleFetch`
 * over a stand-in `index.html` (the real `web/dist` is a separate CI job).
 */

import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalUiLinks, UI_LINK_FRAGMENT, UI_LINK_TTL_MS, uiLinkUrl } from "../daemon/local-auth.js";
import { buildBootScript, handleLocalSignIn, LOCAL_LINK_PATH, LOCAL_SESSION_PATH, WebUiFrontend } from "../frontends/web-ui/index.js";

const TOKEN = "codeoid_local_TESTTOKEN";
const BASE = "http://127.0.0.1:7400";

const post = (path: string, body: unknown, headers: Record<string, string> = {}, base = BASE) =>
  new Request(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

describe("buildBootScript — embed allowlist", () => {
  it("always publishes the allowlist, empty by default", () => {
    expect(buildBootScript({})).toBe("<script>window.__CODEOID_EMBED_ORIGINS__=[];</script>");
  });

  it("serializes configured origins", () => {
    const s = buildBootScript({ allowedOrigins: ["https://studio.highflame.ai"] });
    expect(s).toContain('window.__CODEOID_EMBED_ORIGINS__=["https://studio.highflame.ai"]');
  });
});

describe("buildBootScript — local mode", () => {
  it("says the daemon is in local mode, and carries no credential", () => {
    const s = buildBootScript({ localMode: true });
    expect(s).toContain("window.__CODEOID_LOCAL_MODE__=true");
    expect(s).not.toContain("__CODEOID_LOCAL_TOKEN__");
    expect(buildBootScript({})).not.toContain("__CODEOID_LOCAL_MODE__");
  });
});

describe("buildBootScript — escaping", () => {
  it("neutralizes `<` so no value can close the script element", () => {
    const s = buildBootScript({ allowedOrigins: ["https://a.test/</script><script>alert(1)</script>"], localMode: true });
    // Exactly one opening and one closing script tag: ours.
    expect(s.match(/<script/g)?.length).toBe(1);
    expect(s.match(/<\/script>/g)?.length).toBe(1);
    expect(s).toContain("\\u003c/script>");
  });

  it("produces valid JS that assigns the exact values", () => {
    const origins = ["https://one.test", "https://two.test"];
    const s = buildBootScript({ allowedOrigins: origins, localMode: true });
    const body = s.replace(/^<script>/, "").replace(/<\/script>$/, "");
    const win: Record<string, unknown> = {};
    new Function("window", body)(win);
    expect(win.__CODEOID_EMBED_ORIGINS__).toEqual(origins);
    expect(win.__CODEOID_LOCAL_MODE__).toBe(true);
  });
});

describe("local sign-in: a one-time code for the token (#448 round 4)", () => {
  it("a code from the banner is exchanged once; the second try, a wrong code, or none get nothing", async () => {
    const local = { token: TOKEN, links: new LocalUiLinks() };
    const code = local.links.mint(60_000);
    const first = await handleLocalSignIn(post(LOCAL_SESSION_PATH, { code }), LOCAL_SESSION_PATH, local);
    expect(first?.status).toBe(200);
    expect(first?.headers.get("cache-control")).toBe("no-store");
    expect(await first?.json()).toEqual({ token: TOKEN });
    for (const body of [{ code }, { code: "guess" }, {}, { code: 42 }, "not json"]) {
      const r = await handleLocalSignIn(post(LOCAL_SESSION_PATH, body), LOCAL_SESSION_PATH, local);
      expect(r?.status).toBe(403);
      expect(await r?.text()).not.toContain(TOKEN);
    }
  });

  it("an expired code gets nothing", async () => {
    let now = 1_000;
    const local = { token: TOKEN, links: new LocalUiLinks(() => now) };
    const code = local.links.mint(500);
    now = 1_500;
    const r = await handleLocalSignIn(post(LOCAL_SESSION_PATH, { code }), LOCAL_SESSION_PATH, local);
    expect(r?.status).toBe(403);
    expect(await r?.text()).toContain("codeoid ui");
  });

  it("a Host that isn't loopback (a rebound domain, a tunnel) gets nothing, even with a live code", async () => {
    const local = { token: TOKEN, links: new LocalUiLinks() };
    for (const base of ["http://evil.example.com:7400", "https://codeoid.mytunnel.dev"]) {
      const code = local.links.mint(60_000);
      const r = await handleLocalSignIn(post(LOCAL_SESSION_PATH, { code }, {}, base), LOCAL_SESSION_PATH, local);
      expect(r?.status).toBe(403);
      expect(await r?.text()).not.toContain(TOKEN);
    }
  });

  it("a fresh code needs the token as its bearer", async () => {
    const local = { token: TOKEN, links: new LocalUiLinks() };
    for (const headers of [{} as Record<string, string>, { Authorization: "Bearer wrong" }, { Authorization: `Bearer ${TOKEN}x` }, { Authorization: TOKEN }]) {
      const r = await handleLocalSignIn(post(LOCAL_LINK_PATH, {}, headers), LOCAL_LINK_PATH, local);
      expect(r?.status).toBe(401);
      const body = await r?.text();
      expect(body).not.toContain(TOKEN);
      expect(body).not.toContain("code\"");
    }
    const ok = await handleLocalSignIn(post(LOCAL_LINK_PATH, {}, { Authorization: `Bearer ${TOKEN}` }), LOCAL_LINK_PATH, local);
    const { code, expiresInMs } = (await ok?.json()) as { code: string; expiresInMs: number };
    expect(expiresInMs).toBe(UI_LINK_TTL_MS);
    const r = await handleLocalSignIn(post(LOCAL_SESSION_PATH, { code }), LOCAL_SESSION_PATH, local);
    expect(await r?.json()).toEqual({ token: TOKEN });
  });

  it("only POST; a ZeroID daemon (no local mode) has no such routes", async () => {
    const local = { token: TOKEN, links: new LocalUiLinks() };
    expect((await handleLocalSignIn(new Request(`${BASE}${LOCAL_SESSION_PATH}`), LOCAL_SESSION_PATH, local))?.status).toBe(405);
    expect((await handleLocalSignIn(post(LOCAL_SESSION_PATH, { code: "x" }), LOCAL_SESSION_PATH, undefined))?.status).toBe(404);
    expect(await handleLocalSignIn(new Request(`${BASE}/ui/`), "/ui/", local)).toBeNull();
  });

  it("the link names the code in the fragment, which no server log or Referer carries", () => {
    expect(uiLinkUrl("http://127.0.0.1:7400/", "abc")).toBe(`http://127.0.0.1:7400/ui/#${UI_LINK_FRAGMENT}=abc`);
  });

  it("codes outstanding at once are bounded: minting in a loop drops the oldest", () => {
    const links = new LocalUiLinks();
    const first = links.mint(60_000);
    for (let i = 0; i < 40; i++) links.mint(60_000);
    expect(links.redeem(first)).toBe(false);
  });
});

describe("WebUiFrontend — the served page (#448 round 4)", () => {
  const dist = mkdtempSync(join(tmpdir(), "codeoid-webui-"));
  writeFileSync(join(dist, "index.html"), "<!doctype html><html><head><title>t</title></head><body></body></html>");
  afterAll(() => rmSync(dist, { recursive: true, force: true }));

  it("no page or deep link carries the token, for any Host; local mode is said", async () => {
    const ui = new WebUiFrontend([], { token: TOKEN, links: new LocalUiLinks() }, dist);
    for (const url of [`${BASE}/ui/`, `${BASE}/ui`, `${BASE}/ui/index.html`, `${BASE}/ui/sessions/x`, "http://localhost:7400/ui/", "http://[::1]:7400/ui/"]) {
      const r = await ui.handleFetch(new Request(url));
      const html = (await r?.text()) ?? "";
      expect(html).toContain("__CODEOID_LOCAL_MODE__=true");
      expect(html).not.toContain(TOKEN);
    }
  });
});
