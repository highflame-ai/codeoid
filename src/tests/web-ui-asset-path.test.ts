/**
 * The `/ui/*` → file mapping and its path-traversal guard.
 *
 * The guard used to compare against a hardcoded `${DIST}/`. `normalize()`
 * emits the PLATFORM separator, so on Windows every legitimate asset resolved
 * to `C:\...\web\dist\index.html` — which does not start with
 * `C:\...\web\dist/` — and the entire UI returned 403 (issue #299).
 *
 * That bug is invisible to a POSIX-only test, so the resolver takes its path
 * flavor as an argument and both flavors are asserted here: `path.win32`
 * reproduces the Windows failure from Linux CI, `path.posix` proves the fix
 * did not loosen containment on the platform that already worked.
 */

import { describe, expect, it } from "bun:test";
import path from "node:path";
import { type PathFlavor, resolveUiAsset } from "../frontends/web-ui/index.js";

const FLAVORS: ReadonlyArray<{ name: string; p: PathFlavor; dist: string; outside: string }> = [
  {
    name: "posix",
    p: path.posix,
    dist: "/home/dev/codeoid/web/dist",
    outside: "/home/dev/codeoid/web/dist/../../../etc/passwd",
  },
  {
    name: "win32",
    p: path.win32,
    dist: "C:\\Users\\dev\\codeoid\\web\\dist",
    outside: "C:\\Users\\dev\\.ssh\\id_rsa",
  },
];

for (const { name, p, dist } of FLAVORS) {
  describe(`resolveUiAsset — ${name}`, () => {
    it("serves index.html for the mount root, with and without a trailing slash", () => {
      for (const url of ["/ui", "/ui/"]) {
        const asset = resolveUiAsset(dist, url, p);
        expect(asset).not.toBeNull();
        expect(asset?.rel).toBe("index.html");
        expect(asset?.target).toBe(p.join(dist, "index.html"));
      }
    });

    it("resolves a nested asset inside the dist root", () => {
      // The regression: on win32 this used to be rejected as a traversal.
      const asset = resolveUiAsset(dist, "/ui/assets/index-a1b2c3.js", p);
      expect(asset).not.toBeNull();
      expect(asset?.rel).toBe("assets/index-a1b2c3.js");
      expect(asset?.target).toBe(p.join(dist, "assets", "index-a1b2c3.js"));
    });

    it("keeps an SPA deep-link inside the root (no extension → index fallback)", () => {
      const asset = resolveUiAsset(dist, "/ui/sessions/abc123", p);
      expect(asset).not.toBeNull();
      expect(asset?.rel).toBe("sessions/abc123");
      expect(asset?.rel.includes(".")).toBe(false);
    });

    it("rejects `..` traversal out of the dist root", () => {
      for (const url of [
        "/ui/../secret.txt",
        "/ui/../../../../etc/passwd",
        "/ui/assets/../../../.env",
      ]) {
        expect(resolveUiAsset(dist, url, p)).toBeNull();
      }
    });

    it("rejects a sibling directory that merely shares the root's prefix", () => {
      // `.../web/dist-secrets` starts with `.../web/dist` but is NOT inside it.
      expect(resolveUiAsset(dist, "/ui/../dist-secrets/keys.json", p)).toBeNull();
    });
  });
}

describe("resolveUiAsset — win32 separator handling", () => {
  const dist = "C:\\Users\\dev\\codeoid\\web\\dist";

  it("produces backslash-separated targets under the dist root", () => {
    const asset = resolveUiAsset(dist, "/ui/assets/app.css", path.win32);
    expect(asset?.target).toBe("C:\\Users\\dev\\codeoid\\web\\dist\\assets\\app.css");
    expect(asset?.target.startsWith(`${dist}\\`)).toBe(true);
    // The pre-fix check — proof this test would catch the regression.
    expect(asset?.target.startsWith(`${dist}/`)).toBe(false);
  });

  it("still refuses to escape when the URL smuggles backslashes", () => {
    // A raw client can send `\` unencoded; the WHATWG parser folds it to `/`
    // for http(s), but assert the resolver holds either way.
    expect(resolveUiAsset(dist, "/ui/..\\..\\id_rsa", path.win32)).toBeNull();
  });
});

describe("resolveUiAsset — native flavor", () => {
  it("defaults to node:path and admits a real asset under the root", () => {
    const dist = path.resolve("/tmp/codeoid-test/web/dist");
    const asset = resolveUiAsset(dist, "/ui/assets/index.js");
    expect(asset?.target).toBe(path.join(dist, "assets", "index.js"));
  });

  it("defaults to node:path and rejects a real traversal", () => {
    const dist = path.resolve("/tmp/codeoid-test/web/dist");
    expect(resolveUiAsset(dist, "/ui/../../../etc/passwd")).toBeNull();
  });
});
