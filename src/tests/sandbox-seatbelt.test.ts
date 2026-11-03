/**
 * The Seatbelt provider (#448): its SBPL profile and sandbox-exec argv,
 * generated without a Mac. What only a Mac can show (that the profile
 * loads, and holds) is listed in docs/sandbox.md.
 */
import { describe, expect, test } from "bun:test";
import { SandboxRegistry } from "../daemon/sandbox/registry.js";
import { SANDBOX_EXEC, SeatbeltSandboxProvider, seatbeltArgs, seatbeltEnvPrefix, seatbeltProfile } from "../daemon/sandbox/seatbelt.js";
import type { SandboxSpec } from "../daemon/sandbox/types.js";

function spec(over: Partial<SandboxSpec> = {}): SandboxSpec {
  return {
    sessionId: "s",
    workspace: "/Users/u/repo",
    tempDir: "/private/var/folders/x/T/codeoid-sandbox-s",
    writable: [],
    hidden: ["/Users/u/.ssh", "/Users/u/.netrc"],
    reexposed: [],
    containerSockets: ["/var/run/docker.sock"],
    network: { mode: "on" },
    unsetEnv: ["SSH_AUTH_SOCK"],
    ...over,
  };
}
const dirs = new Set(["/Users/u/repo", "/private/var/folders/x/T/codeoid-sandbox-s", "/Users/u/.ssh", "/Users/u/.codeoid", "/Users/u/.codeoid/worktree"]);
const fs = { real: (p: string) => (p === "/var/run/docker.sock" ? "/private/var/run/docker.sock" : p), isDir: (p: string) => (dirs.has(p) ? true : p.endsWith(".sock") || p.endsWith(".netrc") ? false : null) };

/** The profile with every parameter put back, to read it. */
function readable(s: SandboxSpec): { text: string; params: Record<string, string> } {
  const { profile, params } = seatbeltProfile(s, fs);
  return { text: profile.replace(/\(param "(P\d+)"\)/g, (_m, n: string) => JSON.stringify(params[n])), params };
}

describe("seatbeltProfile", () => {
  test("everything allowed, then no writes but the workspace, the temp dir and the usual devices", () => {
    const { text } = readable(spec());
    const lines = text.trim().split("\n");
    expect(lines.slice(0, 3)).toEqual(["(version 1)", "(allow default)", "(deny file-write*)"]);
    expect(lines[3]).toContain('(literal "/dev/null")');
    expect(text).toContain('(allow file-read* file-write* (subpath "/Users/u/repo"))');
    expect(text).toContain('(allow file-read* file-write* (subpath "/private/var/folders/x/T/codeoid-sandbox-s"))');
  });

  test("hidden: a dir by subpath, a file by literal, neither readable nor writable; a container socket by its real path, and no connection to it", () => {
    const { text } = readable(spec());
    expect(text).toContain('(deny file-read* file-write* (subpath "/Users/u/.ssh"))');
    expect(text).toContain('(deny file-read* file-write* (literal "/Users/u/.netrc"))');
    expect(text).toContain('(deny file-read* file-write* (literal "/private/var/run/docker.sock"))');
    expect(text).toContain('(deny network-outbound (remote unix-socket (path-literal "/private/var/run/docker.sock")))');
  });

  test("shallowest first, as the later rule wins: a workspace inside a hidden dir is allowed back, a hidden dir inside the workspace stays hidden", () => {
    const { text } = readable(spec({ workspace: "/Users/u/.codeoid/worktree", hidden: ["/Users/u/.codeoid", "/Users/u/.codeoid/worktree/.ssh"] }));
    const at = (needle: string) => text.indexOf(needle);
    expect(at('(deny file-read* file-write* (subpath "/Users/u/.codeoid"))')).toBeLessThan(at('(allow file-read* file-write* (subpath "/Users/u/.codeoid/worktree"))'));
    expect(at('(allow file-read* file-write* (subpath "/Users/u/.codeoid/worktree"))')).toBeLessThan(at('"/Users/u/.codeoid/worktree/.ssh"'));
  });

  test("a dir between the workspace and a hidden path in it can't be written (so not renamed)", () => {
    const { text } = readable(spec({ workspace: "/Users/u", hidden: ["/Users/u/.codeoid/worktree"], readOnly: ["/Users/u/.codeoid"] }));
    const at = (n: string) => text.indexOf(n);
    expect(at('(deny file-write* (subpath "/Users/u/.codeoid"))')).toBeGreaterThan(at('(allow file-read* file-write* (subpath "/Users/u"))'));
  });

  test("network: on adds nothing; off and an allowlist (Seatbelt can't hold one by host) deny it all", () => {
    expect(readable(spec()).text).not.toContain("(deny network*)");
    expect(readable(spec({ network: { mode: "off" } })).text).toContain("(deny network*)");
    expect(readable(spec({ network: { mode: "allowlist", allow: ["github.com"] } })).text).toContain("(deny network*)");
  });

  test("a path never enters the profile's text: a quote or a paren in it stays a parameter", () => {
    const evil = '/Users/u/x") (allow file-write* (subpath "/';
    const { profile, params } = seatbeltProfile(spec({ workspace: evil }), fs);
    expect(profile).not.toContain(evil);
    expect(Object.values(params)).toContain(evil);
    expect(profile).not.toContain("/Users");
  });

  test("argv: env (TMPDIR the session's, agent sockets unset), sandbox-exec -p <profile> -D P0=…", () => {
    const s = spec();
    expect(seatbeltEnvPrefix(s)).toEqual(["/usr/bin/env", "-u", "SSH_AUTH_SOCK", "TMPDIR=/private/var/folders/x/T/codeoid-sandbox-s"]);
    const args = seatbeltArgs(s, fs);
    expect(args[0]).toBe("-p");
    expect(args.filter((a) => a === "-D").length).toBe(Object.keys(seatbeltProfile(s, fs).params).length);
    expect(args).toContain("P0=/Users/u/.ssh");
  });

  test("the provider wraps an argv; it is registered for macOS and is auto there", async () => {
    const h = await new SeatbeltSandboxProvider().open(spec());
    const w = h.wrap?.(["/bin/sh", "-c", "true"], { cwd: "/Users/u/repo", env: { A: "1" } });
    expect(w?.argv.slice(0, 1)).toEqual(["/usr/bin/env"]);
    expect(w?.argv).toContain(SANDBOX_EXEC);
    expect(w?.argv.slice(-3)).toEqual(["/bin/sh", "-c", "true"]);
    expect(w?.env).toEqual({ A: "1" });
    const r = new SandboxRegistry("darwin");
    r.register(new SeatbeltSandboxProvider());
    expect(r.autoId()).toBe("seatbelt");
    if (process.platform !== "darwin") expect(await new SeatbeltSandboxProvider().probe()).toEqual({ available: false, reason: "Seatbelt runs on macOS only" });
  });
});
