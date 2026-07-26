/**
 * Local mode — the verifier, the bind guard, and the token-file lifecycle.
 *
 * These are the invariants that make `--local` a *safe* degraded posture rather
 * than an auth bypass, so each one is asserted directly:
 *
 *   1. it still fails closed — a wrong/absent token is rejected, exactly as in
 *      ZeroID mode;
 *   2. the synthetic subject is unmistakably self-asserted (`anonymous:` prefix,
 *      never SPIFFE-shaped) and lands in a reserved tenant;
 *   3. a non-loopback bind is REFUSED without an explicit override;
 *   4. nothing in local mode's import graph reaches `@highflame/sdk` — the
 *      regression that would silently reintroduce a network dependency and
 *      quietly break offline use.
 *
 * The existing integration suites spin up fake JWKS servers, so none of this is
 * covered incidentally by them.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { ALL_SCOPES } from "@codeoid/protocol";
import {
  assertLocalBindAllowed,
  isLocalToken,
  isLoopbackHost,
  LOCAL_ACCOUNT_ID,
  LOCAL_PROJECT_ID,
  LOCAL_SUBJECT,
  LOCAL_TOKEN_PREFIX,
  LocalVerifier,
  mintLocalToken,
  readLocalTokenFile,
  removeLocalTokenFile,
  writeLocalTokenFile,
} from "../daemon/local-auth.js";

const tmpDirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "codeoid-local-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe("mintLocalToken", () => {
  it("is prefixed, high-entropy, and unique per call", () => {
    const a = mintLocalToken();
    const b = mintLocalToken();

    expect(a.startsWith(LOCAL_TOKEN_PREFIX)).toBe(true);
    expect(isLocalToken(a)).toBe(true);
    expect(a).not.toBe(b);

    // 32 random bytes → 43 base64url chars (no padding). Guards against someone
    // "simplifying" the mint into something guessable.
    const entropy = a.slice(LOCAL_TOKEN_PREFIX.length);
    expect(entropy.length).toBe(43);
    expect(entropy).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("is distinguishable from a ZeroID key", () => {
    expect(isLocalToken("zid_sk_abc")).toBe(false);
    expect(isLocalToken("")).toBe(false);
  });
});

describe("LocalVerifier", () => {
  it("declares the local mode", () => {
    expect(new LocalVerifier(mintLocalToken()).mode).toBe("local");
  });

  it("refuses to be constructed without a token", () => {
    expect(() => new LocalVerifier("")).toThrow(/non-empty token/);
  });

  it("accepts the exact token", async () => {
    const token = mintLocalToken();
    const auth = await new LocalVerifier(token).verify(token);
    expect(auth.sub).toBe(LOCAL_SUBJECT);
  });

  it("FAILS CLOSED on anything else", async () => {
    const token = mintLocalToken();
    const v = new LocalVerifier(token);

    // Empty, absent, wrong, truncated, and superstring must all be rejected —
    // a prefix/substring match would make the token trivially forgeable.
    for (const bad of [
      "",
      "zid_sk_something",
      mintLocalToken(),
      token.slice(0, -1),
      `${token}x`,
      token.toUpperCase(),
      LOCAL_TOKEN_PREFIX,
    ]) {
      await expect(v.verify(bad)).rejects.toThrow(/Invalid local-mode token/);
    }
    // A missing token frame reaches us as undefined at the type boundary.
    await expect(v.verify(undefined as unknown as string)).rejects.toThrow();
  });

  it("returns a self-asserted principal that can never read as verified", async () => {
    const token = mintLocalToken();
    const auth = await new LocalVerifier(token).verify(token);

    // The audit_log.subject column is shared with real WIMSE URIs, so this is
    // the load-bearing assertion: an export can separate self-asserted from
    // verified principals on the prefix alone.
    expect(auth.sub).toBe("anonymous:operator");
    expect(auth.sub.startsWith("anonymous:")).toBe(true);
    expect(auth.sub).not.toContain("spiffe://");

    // Reserved tenant — explicit, never the empty bucket verifyToken rejects.
    expect(auth.accountId).toBe(LOCAL_ACCOUNT_ID);
    expect(auth.projectId).toBe(LOCAL_PROJECT_ID);
    expect(auth.accountId).not.toBe("");
    expect(auth.projectId).not.toBe("");

    // Nothing delegated this, and no expiry (the token's life is the process).
    expect(auth.delegationDepth).toBe(0);
    expect(auth.delegatedBy).toBeUndefined();
    expect(auth.exp).toBeUndefined();
  });

  it("grants the full scope set so the enforcement path stays identical", async () => {
    const token = mintLocalToken();
    const auth = await new LocalVerifier(token).verify(token);
    expect([...auth.scopes].sort()).toEqual([...ALL_SCOPES].sort());
  });

  it("hands out a frozen context so one connection can't mutate another's", async () => {
    const token = mintLocalToken();
    const v = new LocalVerifier(token);
    const a = await v.verify(token);
    expect(Object.isFrozen(a)).toBe(true);

    // Mutation attempts must not take effect (silently in sloppy mode, throwing
    // in strict — either is fine; what matters is the second read is clean).
    try {
      (a as { sub: string }).sub = "spiffe://evil";
    } catch {
      /* strict-mode TypeError is an acceptable outcome */
    }
    const b = await v.verify(token);
    expect(b.sub).toBe(LOCAL_SUBJECT);
  });
});

describe("isLoopbackHost", () => {
  it("recognizes loopback", () => {
    for (const host of [
      "127.0.0.1",
      "127.0.1.1", // Debian's /etc/hosts entry
      "127.255.255.255", // the whole /8
      "localhost",
      "LocalHost",
      " 127.0.0.1 ",
      "::1",
      "[::1]",
      "0:0:0:0:0:0:0:1",
      "::ffff:127.0.0.1",
    ]) {
      expect(isLoopbackHost(host)).toBe(true);
    }
  });

  it("fails closed on everything else", () => {
    for (const host of [
      "0.0.0.0", // bind-all is NOT loopback — the whole point of the guard
      "::",
      "[::]",
      "",
      "   ",
      "192.168.1.10",
      "10.0.0.1",
      "128.0.0.1",
      "1270.0.0.1",
      "127.0.0.256",
      "127.0.0",
      "example.com",
      "notlocalhost",
      "localhost.evil.com",
    ]) {
      expect(isLoopbackHost(host)).toBe(false);
    }
  });
});

describe("assertLocalBindAllowed", () => {
  it("allows loopback", () => {
    expect(() => assertLocalBindAllowed("127.0.0.1", false)).not.toThrow();
    expect(() => assertLocalBindAllowed("::1", false)).not.toThrow();
  });

  it("REFUSES a non-loopback bind without the explicit override", () => {
    // This is the guard that keeps "no login" from meaning "an agent with shell
    // access is reachable from the network".
    expect(() => assertLocalBindAllowed("0.0.0.0", false)).toThrow(/refuses to bind/);
    expect(() => assertLocalBindAllowed("192.168.1.5", false)).toThrow(/refuses to bind/);
    // The message has to tell the operator what to do instead.
    expect(() => assertLocalBindAllowed("0.0.0.0", false)).toThrow(/codeoid login/);
    expect(() => assertLocalBindAllowed("0.0.0.0", false)).toThrow(/--local-allow-remote/);
  });

  it("allows a non-loopback bind once explicitly accepted", () => {
    expect(() => assertLocalBindAllowed("0.0.0.0", true)).not.toThrow();
  });
});

describe("token file", () => {
  it("writes 0600, round-trips, and removes", () => {
    const path = join(tmp(), "nested", "local-token");
    const token = mintLocalToken();

    writeLocalTokenFile(path, token);
    expect(readLocalTokenFile(path)).toBe(token);
    // Owner-only: the file IS the credential for every client on this machine.
    expect(statSync(path).mode & 0o777).toBe(0o600);

    removeLocalTokenFile(path);
    expect(readLocalTokenFile(path)).toBeNull();
    // Idempotent — shutdown may run after a manual delete.
    expect(() => removeLocalTokenFile(path)).not.toThrow();
  });

  it("tightens the mode of a pre-existing world-readable file", () => {
    const path = join(tmp(), "local-token");
    // writeFileSync's `mode` only applies on creation, so a leftover 0644 file
    // would keep leaking without the explicit chmod.
    writeFileSync(path, "stale\n", { mode: 0o644 });
    writeLocalTokenFile(path, mintLocalToken());
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("treats a missing or blank file as no token", () => {
    const dir = tmp();
    expect(readLocalTokenFile(join(dir, "absent"))).toBeNull();
    const blank = join(dir, "blank");
    writeFileSync(blank, "   \n");
    expect(readLocalTokenFile(blank)).toBeNull();
  });
});

// ── The dependency invariant ────────────────────────────────────────────────

/**
 * Drop comments so the scan below reasons about CODE, not prose — this very
 * file's modules discuss `@highflame/sdk` in their doc headers precisely
 * because they must not import it. Block comments plus whole-line `//`
 * comments; inline `//` is left alone so `https://…` inside a string survives.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

/**
 * Walk the transitive relative-import graph from an entry module and return
 * every visited file's (comment-stripped) source. Only relative specifiers are
 * followed; package specifiers are returned separately so the caller can assert
 * on them.
 */
function importGraph(entry: string): { files: Map<string, string>; packages: Set<string> } {
  const files = new Map<string, string>();
  const packages = new Set<string>();
  const queue = [entry];

  while (queue.length > 0) {
    const file = queue.pop()!;
    if (files.has(file)) continue;
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch {
      // A `.js` specifier resolving to a `.ts` source on disk.
      raw = readFileSync(file.replace(/\.js$/, ".ts"), "utf8");
    }
    const src = stripComments(raw);
    files.set(file, src);

    for (const m of src.matchAll(/(?:from|import)\s*["']([^"']+)["']/g)) {
      const spec = m[1]!;
      if (!spec.startsWith(".")) {
        packages.add(spec);
        continue;
      }
      queue.push(resolve(dirname(file), spec.replace(/\.js$/, ".ts")));
    }
  }
  return { files, packages };
}

describe("local mode is offline-capable by construction", () => {
  const LOCAL_AUTH = resolve(import.meta.dir, "../daemon/local-auth.ts");

  it("never reaches @highflame/sdk, directly or transitively", () => {
    const { files, packages } = importGraph(LOCAL_AUTH);

    // No package specifier anywhere in the graph is the ZeroID SDK. This is the
    // assertion that fails if someone adds a convenience import to auth.ts (or
    // anything that pulls it in) from local-auth.ts.
    const sdkImports = [...packages].filter((p) => p.startsWith("@highflame/"));
    expect(sdkImports).toEqual([]);

    // Belt and suspenders: no visited SOURCE mentions it either, which also
    // catches a dynamic `await import("@highflame/sdk")`.
    const offenders = [...files.entries()]
      .filter(([, src]) => src.includes("@highflame/sdk"))
      .map(([f]) => f);
    expect(offenders).toEqual([]);

    // Sanity: the walker actually walked something (a broken resolver would
    // otherwise make this suite pass vacuously).
    expect(files.size).toBeGreaterThan(0);
    expect(packages.has("node:crypto")).toBe(true);
  });

  it("keeps @codeoid/protocol — its one package dependency — SDK-free", async () => {
    // The graph walker stops at package boundaries, and @codeoid/protocol is
    // the only non-node package local-auth depends on. Scan it directly so the
    // invariant covers the whole reachable set.
    const glob = new Bun.Glob("**/*.ts");
    const root = resolve(import.meta.dir, "../../packages/protocol/src");
    const offenders: string[] = [];
    for await (const rel of glob.scan(root)) {
      if (stripComments(readFileSync(join(root, rel), "utf8")).includes("@highflame/sdk")) {
        offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("proves the guard works by catching a module that DOES import the SDK", () => {
    // Anchors the previous assertions: if the walker were broken, this would
    // pass empty too.
    const { packages } = importGraph(resolve(import.meta.dir, "../daemon/auth.ts"));
    expect(packages.has("@highflame/sdk")).toBe(true);
  });
});
