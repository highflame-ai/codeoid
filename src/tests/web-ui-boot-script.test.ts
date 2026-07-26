/**
 * The boot-time globals the daemon injects into the web UI's index.html.
 *
 * Two trust decisions live in this one function, and both are asserted here:
 *
 *   1. the local-mode token is handed to the browser ONLY when the request's
 *      own `Host` names a loopback address — the DNS-rebinding guard, without
 *      which a page that rebinds its domain to 127.0.0.1 could read the token
 *      as same-origin and take over the daemon;
 *   2. every injected value is escaped so it can never close the <script>.
 *
 * Tested against the pure builder rather than through `handleFetch`, so it runs
 * with no built UI on disk (`web/dist` is a separate CI job) — a test that
 * silently skips is worse than no test.
 */

import { describe, expect, it } from "bun:test";
import { buildBootScript } from "../frontends/web-ui/index.js";

const TOKEN = "codeoid_local_TESTTOKEN";

describe("buildBootScript — embed allowlist", () => {
  it("always publishes the allowlist, empty by default", () => {
    expect(buildBootScript({ requestUrl: "http://127.0.0.1:7400/ui/" })).toBe(
      "<script>window.__CODEOID_EMBED_ORIGINS__=[];</script>",
    );
  });

  it("serializes configured origins", () => {
    const s = buildBootScript({
      allowedOrigins: ["https://studio.highflame.ai"],
      requestUrl: "http://127.0.0.1:7400/ui/",
    });
    expect(s).toContain('window.__CODEOID_EMBED_ORIGINS__=["https://studio.highflame.ai"]');
  });
});

describe("buildBootScript — local-mode token", () => {
  it("injects the token for a loopback Host", () => {
    for (const url of [
      "http://127.0.0.1:7400/ui/",
      "http://localhost:7400/ui/",
      "http://[::1]:7400/ui/",
      "http://127.0.1.1:7400/ui/",
    ]) {
      const s = buildBootScript({ localToken: TOKEN, requestUrl: url });
      expect(s).toContain(`window.__CODEOID_LOCAL_TOKEN__="${TOKEN}"`);
    }
  });

  it("WITHHOLDS the token for any non-loopback Host (DNS-rebinding guard)", () => {
    for (const url of [
      "http://evil.example.com:7400/ui/", // a rebound domain
      "http://192.168.1.20:7400/ui/", // a LAN peer
      "https://codeoid.mytunnel.dev/ui/", // a tunnel hostname
      "http://0.0.0.0:7400/ui/",
    ]) {
      const s = buildBootScript({ localToken: TOKEN, requestUrl: url });
      expect(s).not.toContain("__CODEOID_LOCAL_TOKEN__");
      // The UI still boots — it just has to ask for a credential.
      expect(s).toContain("__CODEOID_EMBED_ORIGINS__");
    }
  });

  it("fails closed on an unparseable request URL", () => {
    expect(buildBootScript({ localToken: TOKEN, requestUrl: "not a url" })).not.toContain(
      "__CODEOID_LOCAL_TOKEN__",
    );
  });

  it("never injects a token in ZeroID mode", () => {
    expect(buildBootScript({ requestUrl: "http://127.0.0.1:7400/ui/" })).not.toContain(
      "__CODEOID_LOCAL_TOKEN__",
    );
  });
});

describe("buildBootScript — escaping", () => {
  it("neutralizes `<` so no value can close the script element", () => {
    const s = buildBootScript({
      allowedOrigins: ["https://a.test/</script><script>alert(1)</script>"],
      localToken: 'codeoid_local_</script><img src=x onerror="alert(1)">',
      requestUrl: "http://127.0.0.1:7400/ui/",
    });
    // Exactly one opening and one closing script tag: ours.
    expect(s.match(/<script/g)?.length).toBe(1);
    expect(s.match(/<\/script>/g)?.length).toBe(1);
    expect(s).toContain("\\u003c/script>");
  });

  it("produces valid JS that assigns the exact values", () => {
    const origins = ["https://one.test", "https://two.test"];
    const s = buildBootScript({
      allowedOrigins: origins,
      localToken: TOKEN,
      requestUrl: "http://localhost:7400/ui/",
    });
    const body = s.replace(/^<script>/, "").replace(/<\/script>$/, "");
    const win: Record<string, unknown> = {};
    new Function("window", body)(win);
    expect(win.__CODEOID_EMBED_ORIGINS__).toEqual(origins);
    expect(win.__CODEOID_LOCAL_TOKEN__).toBe(TOKEN);
  });
});
