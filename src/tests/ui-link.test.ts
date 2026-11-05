/**
 * `codeoid ui` (#448 round 4): on a local-mode daemon it asks for a one-time
 * sign-in link with the token it found (env or the daemon's token file);
 * without one it opens the plain UI. A real daemon's routes are exercised in
 * web-ui-boot-script.test.ts and sandbox-loopback-token-real.test.ts.
 */
import { describe, expect, it } from "bun:test";
import { UI_LINK_FRAGMENT } from "../daemon/local-auth.js";
import { browserOpener, webUiLink } from "../terminal/ui-link.js";

const TOKEN = "codeoid_local_TEST";

function fakeFetch(answer: (url: string, init?: RequestInit) => Response): { fetch: typeof fetch; calls: Array<{ url: string; auth: string | null }> } {
  const calls: Array<{ url: string; auth: string | null }> = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, auth: new Headers(init?.headers).get("authorization") });
    return answer(url, init);
  }) as typeof fetch;
  return { fetch: f, calls };
}

describe("codeoid ui", () => {
  it("with the local token: a one-time link, asked for with the token as bearer", async () => {
    const f = fakeFetch(() => Response.json({ code: "c0de", expiresInMs: 120_000 }));
    const link = await webUiLink("ws://127.0.0.1:7400", { CODEOID_LOCAL_TOKEN: TOKEN }, f.fetch);
    expect(link).toEqual({ url: `http://127.0.0.1:7400/ui/#${UI_LINK_FRAGMENT}=c0de`, signsIn: true, expiresInMs: 120_000 });
    expect(f.calls).toEqual([{ url: "http://127.0.0.1:7400/ui/local-link", auth: `Bearer ${TOKEN}` }]);
  });

  it("without one (a ZeroID daemon): the plain UI, nothing asked", async () => {
    const f = fakeFetch(() => Response.json({}));
    expect(await webUiLink("ws://127.0.0.1:65530", { HOME: "/nonexistent-home", XDG_CONFIG_HOME: "/nonexistent-cfg" }, f.fetch)).toEqual({ url: "http://127.0.0.1:65530/ui/", signsIn: false });
    expect(f.calls).toEqual([]);
  });

  it("says why when the daemon gives no link, or isn't there", async () => {
    const refused = await webUiLink("ws://127.0.0.1:7400", { CODEOID_LOCAL_TOKEN: TOKEN }, fakeFetch(() => Response.json({ error: "this needs the daemon's local token" }, { status: 401 })).fetch);
    expect(refused).toEqual({ error: expect.stringContaining("401: this needs the daemon's local token") });
    const wide = await webUiLink("ws://127.0.0.1:7400", { CODEOID_LOCAL_TOKEN: TOKEN }, fakeFetch(() => new Response("Not Found", { status: 404 })).fetch);
    expect(wide).toEqual({ error: expect.stringContaining("isn't in local mode on a loopback address") });
    const down = await webUiLink("ws://127.0.0.1:7400", { CODEOID_LOCAL_TOKEN: TOKEN }, (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch);
    expect(down).toEqual({ error: expect.stringContaining("is it running?") });
  });
});

describe("codeoid ui: opening the link (#448 round 5)", () => {
  const url = `http://127.0.0.1:7400/ui/#${UI_LINK_FRAGMENT}=SECRETCODE`;

  it("macOS: the link reaches the browser by AppleScript on stdin, in no program's argv (Seatbelt has no pid namespace)", () => {
    const o = browserOpener(url, "darwin");
    expect(o?.argv).toEqual(["/usr/bin/osascript", "-"]);
    expect(o?.argv.join(" ")).not.toContain("SECRETCODE");
    expect(o?.stdin).toBe(`open location "${url}"\n`);
    // One that isn't plain isn't spliced into the script: printed only.
    expect(browserOpener('http://127.0.0.1:7400/ui/#x="; do shell script "id', "darwin")).toBeNull();
  });

  it("Linux: xdg-open (every sandbox there has its own pid namespace); none: nothing; Windows: nothing", () => {
    expect(browserOpener(url, "linux", () => "/usr/bin/xdg-open")).toEqual({ argv: ["/usr/bin/xdg-open", url] });
    expect(browserOpener(url, "linux", () => null)).toBeNull();
    expect(browserOpener(url, "win32")).toBeNull();
  });
});
