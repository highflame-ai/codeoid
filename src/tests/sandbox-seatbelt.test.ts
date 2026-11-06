/**
 * The Seatbelt provider (#448): its SBPL profile and sandbox-exec argv,
 * generated without a Mac. What only a Mac can show (that the profile
 * loads, and holds) is listed in docs/sandbox.md.
 */
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SandboxRegistry } from "../daemon/sandbox/registry.js";
import { PRIVATE_TEMP_WORD, SANDBOX_EXEC, SeatbeltSandboxProvider, seatbeltArgs, seatbeltEnvPrefix, seatbeltProfile } from "../daemon/sandbox/seatbelt.js";
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

  test("a dir between the workspace and a hidden path in it can't itself be written (so not renamed), while what is in it can (#448 round 1)", () => {
    const { text } = readable(spec({ workspace: "/Users/u", hidden: ["/Users/u/.codeoid/worktree"], pinned: ["/Users/u/.codeoid"] }));
    const at = (n: string) => text.indexOf(n);
    expect(at('(deny file-write* (literal "/Users/u/.codeoid"))')).toBeGreaterThan(at('(allow file-read* file-write* (subpath "/Users/u"))'));
    expect(text).not.toContain('(deny file-write* (subpath "/Users/u/.codeoid"))');
  });

  test("a writable git dir can't itself be written (renamed away and rebuilt), what is in it can; its worktrees' git dirs held read-only inside it (#448 round 2)", () => {
    const g = "/Users/u/repo/.git";
    const { text } = readable(spec({ writable: [g, `${g}/worktrees`, `${g}/worktrees/w`], readOnly: [`${g}/config`, `${g}/worktrees/other`, `${g}/worktrees/w/commondir`] }));
    const at = (n: string) => text.indexOf(n);
    for (const p of [g, `${g}/worktrees`, `${g}/worktrees/w`]) {
      expect(at(`(deny file-write* (literal "${p}"))`)).toBeGreaterThan(at(`(allow file-read* file-write* (subpath "${p}"))`));
    }
    // Neither the workspace nor the temp dir: they are the session's to lay out.
    expect(text).not.toContain('(deny file-write* (literal "/Users/u/repo"))');
    expect(at(`"${g}/worktrees/other"`)).toBeGreaterThan(at(`(allow file-read* file-write* (subpath "${g}/worktrees"))`));
    expect(at(`"${g}/worktrees/w/commondir"`)).toBeGreaterThan(at(`(allow file-read* file-write* (subpath "${g}/worktrees/w"))`));
  });

  test("worktrees/ read-only whole, this worktree's own git dir writable inside it, its commondir read-only again: later rules win, so each comes after the one it overrides (#448 round 3)", () => {
    const g = "/Users/u/repo/.git";
    const dirsHere = new Set([...dirs, g, `${g}/worktrees`, `${g}/worktrees/w`, "/Users/u/repo/HEAD"]);
    const { profile, params } = seatbeltProfile(spec({ writable: [g, `${g}/worktrees/w`], readOnly: [`${g}/worktrees`, `${g}/worktrees/w/commondir`, "/Users/u/repo/HEAD", "/Users/u/repo/opencode.json"] }), { ...fs, isDir: (p) => (dirsHere.has(p) ? true : fs.isDir(p)) });
    const text = profile.replace(/\(param "(P\d+)"\)/g, (_m, n: string) => JSON.stringify(params[n]));
    const at = (n: string) => text.indexOf(n);
    expect(at(`(allow file-read* file-write* (subpath "${g}/worktrees/w"))`)).toBeGreaterThan(at(`(deny file-write* (subpath "${g}/worktrees"))`));
    expect(at(`(deny file-write* (subpath "${g}/worktrees"))`)).toBeGreaterThan(at(`(allow file-read* file-write* (subpath "${g}"))`));
    expect(at(`"${g}/worktrees/w/commondir"`)).toBeGreaterThan(at(`(allow file-read* file-write* (subpath "${g}/worktrees/w"))`));
    expect(at('(deny file-write* (subpath "/Users/u/repo/HEAD"))')).toBeGreaterThan(at('(allow file-read* file-write* (subpath "/Users/u/repo"))'));
    expect(text).toContain('"/Users/u/repo/opencode.json"');
  });

  test("Docker access (#448 follow-up): a socket the owner let in is allowed last, its file and a connection to it, the network off too; Docker Desktop's link by both paths", () => {
    const { text } = readable(spec({ containerSockets: [], dockerSockets: ["/var/run/docker.sock"], network: { mode: "off" } }));
    const lines = text.split("\n");
    const deny = lines.indexOf("(deny network*)");
    for (const p of ["/var/run/docker.sock", "/private/var/run/docker.sock"]) {
      const file = lines.indexOf(`(allow file-read* file-write-data (literal ${JSON.stringify(p)}))`);
      const conn = lines.indexOf(`(allow network-outbound (remote unix-socket (path-literal ${JSON.stringify(p)})))`);
      expect(file).toBeGreaterThan(deny);
      expect(conn).toBeGreaterThan(deny);
    }
    expect(readable(spec()).text).not.toContain("(allow network-outbound");
  });

  test("worktrees (#448 follow-up): worktrees/ and a worktree location writable but not renamable; another worktree's git dir and checkout read-only", () => {
    const { text } = readable(spec({ writable: ["/Users/u/repo/.git", "/Users/u/repo/.git/worktrees", "/Users/u/repo-worktrees"], readOnly: ["/Users/u/repo/.git/worktrees/theirs", "/Users/u/repo-worktrees/theirs"] }));
    for (const p of ["/Users/u/repo/.git/worktrees", "/Users/u/repo-worktrees"]) {
      expect(text).toContain(`(deny file-write* (literal ${JSON.stringify(p)}))`);
    }
    for (const p of ["/Users/u/repo/.git/worktrees/theirs", "/Users/u/repo-worktrees/theirs"]) expect(text).toMatch(new RegExp(`\\(deny file-write\\* [^\\n]*${p.replace(/[/.]/g, "\\$&")}`));
  });

  test("a repository's hooks and config can't be written, with what is in them", () => {
    const { text } = readable(spec({ readOnly: ["/Users/u/repo/.git/hooks", "/Users/u/repo/.git/config"] }));
    expect(text).toContain('"/Users/u/repo/.git/hooks"');
    expect(text.indexOf('(deny file-write* (literal "/Users/u/repo/.git/config") (subpath "/Users/u/repo/.git/config"))')).toBeGreaterThan(text.indexOf('(allow file-read* file-write* (subpath "/Users/u/repo"))'));
  });

  test("the home hidden whole; the allowlist allowed back (a link by its own path and where it leads), the workspace in it writable (#448 round 1)", () => {
    const real = (p: string) => (p === "/Users/u/.gitconfig" ? "/Users/u/dotfiles/gitconfig" : p);
    const s = spec({ workspace: "/Users/u/repo", hidden: ["/Users/u"], reexposed: ["/Users/u/.gitconfig", "/Users/u/.bun"] });
    const { profile, params } = seatbeltProfile(s, { real, isDir: (p) => (p === "/Users/u" || p === "/Users/u/.bun" || p === "/Users/u/repo" ? true : p.includes("gitconfig") ? false : null) });
    const text = profile.replace(/\(param "(P\d+)"\)/g, (_m, n: string) => JSON.stringify(params[n]));
    const at = (n: string) => text.indexOf(n);
    expect(at('(deny file-read* file-write* (subpath "/Users/u"))')).toBeGreaterThan(-1);
    for (const allow of ['(allow file-read* (literal "/Users/u/.gitconfig"))', '(allow file-read* (literal "/Users/u/dotfiles/gitconfig"))', '(allow file-read* (subpath "/Users/u/.bun"))', '(allow file-read* file-write* (subpath "/Users/u/repo"))']) {
      expect(at(allow)).toBeGreaterThan(at('(deny file-read* file-write* (subpath "/Users/u"))'));
    }
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
    // The toolchains' caches (#448 round 2), set before TMPDIR.
    expect(seatbeltEnvPrefix(spec({ env: { GOCACHE: "/Users/u/.cache/codeoid-sandbox/go-build" } }))).toEqual([
      "/usr/bin/env",
      "-u",
      "SSH_AUTH_SOCK",
      "GOCACHE=/Users/u/.cache/codeoid-sandbox/go-build",
      "TMPDIR=/private/var/folders/x/T/codeoid-sandbox-s",
    ]);
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

  // #448 round 5: the git shim's spec gives each program a temp dir of its own. Seatbelt has no mount namespace, so a
  // wrapper makes it, names it in the profile and TMPDIR, and removes it. Run here with a stand-in for sandbox-exec
  // that ignores the profile and runs the program, so the wrapper itself is what is tested.
  test("a private-temp spec: each program gets a fresh dir made in the temp dir, the only part of it writable, removed when it exits", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "codeoid-sb-private-")));
    try {
      const parent = join(root, "git-tmp");
      mkdirSync(parent);
      const params = join(root, "params");
      const stub = join(root, "sandbox-exec");
      // Writes each `-D` parameter it is given to `params`, then runs the program.
      writeFileSync(stub, `#!/bin/sh\nwhile [ "$#" -gt 0 ]; do case "$1" in -p) shift 2 ;; -D) printf '%s\\n' "$2" >> '${params}'; shift 2 ;; *) break ;; esac; done\nexec "$@"\n`);
      chmodSync(stub, 0o755);
      const h = new SeatbeltSandboxProvider({ sandboxExec: stub }).openSync(spec({ tempDir: parent, privateTemp: true, unsetEnv: [] }));
      const run = async () => {
        rmSync(params, { force: true });
        const r = await h.exec(["/bin/sh", "-c", 'printf %s "$TMPDIR"; ls -A "$TMPDIR"; echo kept > "$TMPDIR/LEAK"; exit 3'], { cwd: root, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } });
        return { r, params: readFileSync(params, "utf8").trim().split("\n") };
      };
      const first = await run();
      expect(first.r.exitCode).toBe(3);
      const dir = first.r.stdout;
      expect(dir.startsWith(`${parent}/t.`)).toBe(true);
      // The profile's parameter for the temp dir is that dir, not the parent.
      expect(first.params.some((p) => p.endsWith(`=${dir}`))).toBe(true);
      expect(first.params.some((p) => p.endsWith(`=${parent}`))).toBe(false);
      // Gone when the program exits, and nothing of it seen by the next.
      expect(readdirSync(parent)).toEqual([]);
      const second = await run();
      expect(second.r.stdout).not.toContain("LEAK");
      expect(second.r.stdout).not.toBe(dir);
      expect(readdirSync(parent)).toEqual([]);
      // The profile itself: the dir's parameter, never the parent's path.
      const { profile, params: p } = seatbeltProfile({ ...spec({ privateTemp: true }), tempDir: PRIVATE_TEMP_WORD }, fs);
      expect(Object.values(p)).toContain(PRIVATE_TEMP_WORD);
      expect(profile).not.toContain(parent);
      await h.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
