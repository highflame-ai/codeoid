/** git-env.ts: git the daemon runs in a repository an agent can write. */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { driverOverrides, gitEnv, hardenedGit, safeGit, safeGitEnv } from "../daemon/git-env.js";
import { createForkWorktree, removeForkWorktree } from "../daemon/git-worktree.js";

let tmp: string;
let repo: string;
const git = (...args: string[]): string => execFileSync("git", args, { cwd: repo, encoding: "utf8" });

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "codeoid-git-env-"));
  repo = join(tmp, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  git("config", "user.name", "T");
  git("config", "user.email", "t@example.com");
  writeFileSync(join(repo, "a.txt"), "a\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("git-env", () => {
  test("the environment never carries the daemon's own credentials", () => {
    process.env.CODEOID_API_KEY = "zid_sk_test";
    try {
      expect(gitEnv().CODEOID_API_KEY).toBeUndefined();
      expect(gitEnv({}, { network: true }).CODEOID_API_KEY).toBeUndefined();
    } finally {
      delete process.env.CODEOID_API_KEY;
    }
  });

  test("hardened git runs no fsmonitor, hook or filter a repository's config names", async () => {
    const marker = join(tmp, "ran");
    const script = join(tmp, "evil.sh");
    writeFileSync(script, `#!/bin/sh\necho "$CODEOID_API_KEY" >> ${marker}\n`);
    chmodSync(script, 0o755);
    git("config", "core.fsmonitor", script);
    git("config", "filter.x.clean", script);
    writeFileSync(join(repo, ".gitattributes"), "* filter=x\n");
    writeFileSync(join(repo, "a.txt"), "changed\n");
    process.env.CODEOID_API_KEY = "zid_sk_test";
    try {
      await hardenedGit(["--no-optional-locks", "status", "--porcelain"], repo);
    } finally {
      delete process.env.CODEOID_API_KEY;
    }
    expect(existsSync(marker)).toBe(false);
  });

  test("a session's work is saved on destroy even with commit signing on", async () => {
    git("config", "commit.gpgsign", "true");
    git("config", "gpg.program", "false");
    const wt = join(tmp, "wt");
    git("worktree", "add", "-q", "-b", "fork", wt);
    writeFileSync(join(wt, "work.txt"), "work\n");
    await removeForkWorktree({ workdir: repo, worktreePath: wt, branch: "fork" });
    expect(git("show", "fork:work.txt")).toBe("work\n");
  });

  test("git that exits before reading its input is an error, not a crash", async () => {
    const outside = mkdtempSync(join(tmpdir(), "codeoid-not-a-repo-"));
    try {
      await expect(hardenedGit(["check-attr", "--stdin", "-z", "filter"], outside, {}, { input: "a\0".repeat(8_000_000) })).rejects.toThrow();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("removing a worktree whose directory is already gone still prunes it", async () => {
    const wt = join(tmp, "gone");
    git("worktree", "add", "-q", "-b", "gone", wt);
    rmSync(wt, { recursive: true, force: true });
    await removeForkWorktree({ workdir: repo, worktreePath: wt, branch: "gone" });
    expect(git("worktree", "list")).not.toContain("gone");
  });
});


/**
 * #448 round 2: every git the daemon runs in a user's repository an agent
 * can write runs nothing that repository's config names. The planted
 * program only appends to a marker in the test's own temp dir.
 */
describe("the daemon's own git in a user's repository (#448 round 2)", () => {
  let marker: string;
  let evil: string;
  beforeEach(() => {
    marker = join(tmp, "ran");
    evil = join(tmp, "evil.sh");
    writeFileSync(evil, `#!/bin/sh\necho "$0 $*" >> '${marker}'\ncat\n`);
    chmodSync(evil, 0o755);
  });
  const plant = (cwd: string) => {
    for (const [k, v] of [
      ["core.fsmonitor", evil],
      ["filter.x.clean", evil],
      ["filter.x.smudge", evil],
      ["filter.x.process", evil],
      ["diff.x.textconv", evil],
      ["diff.x.command", evil],
      ["merge.x.driver", evil],
      ["core.sshCommand", evil],
      ["credential.helper", `!${evil}`],
      ["core.hooksPath", tmp],
    ] as const) {
      execFileSync("git", ["config", k, v], { cwd });
    }
    writeFileSync(join(tmp, "post-checkout"), `#!/bin/sh\necho hook >> '${marker}'\n`, { mode: 0o755 });
  };

  test("destroying a --worktree session (its snapshot, the worktree's removal) after a planted fsmonitor, filter, drivers, helper and hook runs none of them, and the work is saved", async () => {
    const wt = await createForkWorktree({ workdir: repo, label: "s", shortId: "abcd1234" });
    plant(repo);
    writeFileSync(join(wt.path, ".gitattributes"), "* filter=x diff=x merge=x\n");
    writeFileSync(join(wt.path, "work.txt"), "work\n");
    writeFileSync(join(wt.path, "a.txt"), "changed\n");
    await removeForkWorktree({ workdir: repo, worktreePath: wt.path, branch: wt.branch });
    expect(existsSync(marker)).toBe(false);
    expect(git("show", `${wt.branch}:work.txt`)).toBe("work\n");
    expect(existsSync(wt.path)).toBe(false);
  });

  test("forking (a worktree made and the parent's state carried) runs nothing planted either", async () => {
    plant(repo);
    writeFileSync(join(repo, ".gitattributes"), "* filter=x\n");
    writeFileSync(join(repo, "a.txt"), "dirty\n");
    const wt = await createForkWorktree({ workdir: repo, label: "f", shortId: "ffff0000" });
    expect(existsSync(marker)).toBe(false);
    expect(readFileSync(join(wt.path, "a.txt"), "utf8")).toBe("dirty\n");
  });

  test("a driver the user defined in their own config (git lfs, globally) still runs; a repository redefining it, or defining its own, doesn't", async () => {
    // A driver name of its own: a machine with git-lfs installed system-wide
    // (GitHub's runners) has `filter.lfs.process`, which git prefers to `clean`.
    const home = join(tmp, "home");
    mkdirSync(home);
    const own = join(tmp, "own.sh");
    const ownMarker = join(tmp, "own-ran");
    writeFileSync(own, `#!/bin/sh\necho own >> '${ownMarker}'\ncat\n`, { mode: 0o755 });
    writeFileSync(join(home, ".gitconfig"), `[filter "ownlfs"]\n\tclean = ${own}\n`);
    git("config", "filter.ownlfs.clean", evil);
    git("config", "filter.y.clean", evil);
    writeFileSync(join(repo, ".gitattributes"), "a.txt filter=ownlfs\nb.txt filter=y\n");
    writeFileSync(join(repo, "a.txt"), "changed\n");
    writeFileSync(join(repo, "b.txt"), "b\n");
    const prev = process.env.HOME;
    process.env.HOME = home;
    try {
      await safeGit(["add", "-A"], repo);
    } finally {
      process.env.HOME = prev;
    }
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(ownMarker)).toBe(true);
  });

  test("driverOverrides: an agent-writable scope's drivers and credential helpers reset, the user's own put back; strict resets every driver", () => {
    const entries = [
      { scope: "global", key: "filter.lfs.clean", value: "git-lfs clean -- %f" },
      { scope: "local", key: "filter.lfs.clean", value: "evil" },
      { scope: "global", key: "filter.only-global.clean", value: "g" },
      { scope: "worktree", key: "diff.d.textconv", value: "evil" },
      { scope: "global", key: "credential.helper", value: "store" },
      { scope: "local", key: "credential.https://Example.com.helper", value: "!evil" },
      { scope: "local", key: "credential.helper", value: "!evil" },
    ];
    const o = driverOverrides(entries, false);
    expect(o).toContainEqual(["filter.lfs.clean", ""]);
    expect(o.findLast(([k]) => k === "filter.lfs.clean")).toEqual(["filter.lfs.clean", "git-lfs clean -- %f"]);
    expect(o.some(([k]) => k.startsWith("filter.only-global."))).toBe(false);
    expect(o).toContainEqual(["diff.d.textconv", ""]);
    expect(o.filter(([k]) => k === "credential.helper")).toEqual([["credential.helper", ""], ["credential.helper", "store"]]);
    // A URL subsection keeps its case.
    expect(o).toContainEqual(["credential.https://Example.com.helper", ""]);
    const strict = driverOverrides(entries, true);
    expect(strict).toContainEqual(["filter.only-global.clean", ""]);
    expect(strict.findLast(([k]) => k === "filter.lfs.clean")).toEqual(["filter.lfs.clean", ""]);
    expect(() => driverOverrides([{ scope: "local", key: "filter.a=b c.clean", value: "x" }], false)).toThrow(/refusing/);
  });
});

describe("every config key that names a program runs nothing under safeGitEnv (#448 round 3)", () => {
  let marker: string;
  let evil: string;
  beforeEach(() => {
    marker = join(tmp, "ran");
    evil = join(tmp, "evil.sh");
    writeFileSync(evil, `#!/bin/sh\necho "$0 $*" >> '${marker}'\nexit 0\n`);
    chmodSync(evil, 0o755);
  });
  type Env = (opts?: { network?: boolean }) => Promise<Record<string, string>>;
  const run = (args: string[], env: Record<string, string>, input = "") => {
    try {
      execFileSync("git", args, { cwd: repo, env, input, stdio: ["pipe", "pipe", "pipe"], timeout: 20_000 });
    } catch {
      /* refused or failed: what matters is whether the planted program ran */
    }
  };
  /** A commit object carrying a signature git hands to its verifier. */
  const signedCommit = (armor: string): string => {
    const tree = git("rev-parse", "HEAD^{tree}").trim();
    const head = git("rev-parse", "HEAD").trim();
    const body = `tree ${tree}\nparent ${head}\nauthor T <t@example.com> 0 +0000\ncommitter T <t@example.com> 0 +0000\ngpgsig -----BEGIN ${armor} SIGNATURE-----\n \n QUJD\n -----END ${armor} SIGNATURE-----\n\nsigned\n`;
    return execFileSync("git", ["hash-object", "-t", "commit", "-w", "--stdin"], { cwd: repo, input: body, encoding: "utf8" }).trim();
  };
  const remoteRepo = () => {
    const remote = join(tmp, "remote");
    execFileSync("git", ["clone", "-q", "--bare", repo, remote]);
    return remote;
  };
  const commit = (env: Env) => async () => run(["commit", "-q", "--allow-empty", "-m", "x"], await env());

  /** `refused`: git itself refuses it by default too (no control run). */
  const cases: Array<{ key: string; refused?: true; plant: () => void; trigger: (env: Env) => Promise<void> }> = [
    { key: "core.fsmonitor", plant: () => git("config", "core.fsmonitor", evil), trigger: async (env) => run(["status"], await env()) },
    {
      key: "core.hooksPath (a pre-commit hook)",
      plant: () => {
        writeFileSync(join(tmp, "pre-commit"), `#!/bin/sh\n'${evil}' hook\n`, { mode: 0o755 });
        git("config", "core.hooksPath", tmp);
      },
      trigger: (env) => commit(env)(),
    },
    {
      key: "hook.<name>.command (a config-defined hook)",
      plant: () => {
        git("config", "hook.planted.command", evil);
        git("config", "--add", "hook.planted.event", "pre-commit");
        git("config", "--add", "hook.planted.event", "post-commit");
      },
      trigger: (env) => commit(env)(),
    },
    { key: "core.editor", plant: () => git("config", "core.editor", evil), trigger: async (env) => run(["commit", "--allow-empty"], await env()) },
    { key: "sequence.editor", plant: () => git("config", "sequence.editor", evil), trigger: async (env) => run(["rebase", "-i", "HEAD"], await env()) },
    {
      key: "core.pager / pager.<cmd> (never reached without a tty; GIT_PAGER outranks both)",
      refused: true,
      plant: () => {
        git("config", "core.pager", evil);
        git("config", "pager.log", evil);
      },
      trigger: async (env) => run(["log", "-1"], await env()),
    },
    {
      key: "diff.external",
      plant: () => {
        git("config", "diff.external", evil);
        writeFileSync(join(repo, "a.txt"), "changed\n");
      },
      trigger: async (env) => run(["diff"], await env()),
    },
    {
      key: "diff.<driver>.textconv / .command",
      plant: () => {
        git("config", "diff.x.textconv", evil);
        git("config", "diff.y.command", evil);
        writeFileSync(join(repo, ".gitattributes"), "a.txt diff=x\nb.txt diff=y\n");
        writeFileSync(join(repo, "b.txt"), "b\n");
        git("add", "b.txt");
        writeFileSync(join(repo, "a.txt"), "changed\n");
        writeFileSync(join(repo, "b.txt"), "b2\n");
      },
      trigger: async (env) => run(["diff"], await env()),
    },
    {
      key: "filter.<driver>.clean / .smudge / .process",
      plant: () => {
        for (const k of ["clean", "smudge", "process"]) git("config", `filter.x.${k}`, evil);
        writeFileSync(join(repo, ".gitattributes"), "* filter=x\n");
        writeFileSync(join(repo, "a.txt"), "changed\n");
      },
      trigger: async (env) => {
        const e = await env();
        run(["add", "-A"], e);
        run(["checkout", "--", "."], e);
      },
    },
    {
      key: "merge.<driver>.driver",
      plant: () => {
        git("checkout", "-q", "-b", "side");
        writeFileSync(join(repo, "a.txt"), "side\n");
        git("commit", "-qam", "side");
        git("checkout", "-q", "main");
        writeFileSync(join(repo, "a.txt"), "main\n");
        git("commit", "-qam", "main");
        git("config", "merge.x.driver", `${evil} %O %A %B`);
        writeFileSync(join(repo, ".git", "info", "attributes"), "* merge=x\n");
      },
      trigger: async (env) => run(["merge", "-q", "--no-edit", "side"], await env()),
    },
    {
      key: "credential.helper",
      plant: () => git("config", "credential.helper", `!${evil}`),
      trigger: async (env) => run(["credential", "fill"], await env({ network: true }), "protocol=https\nhost=example.invalid\n\n"),
    },
    {
      key: "core.alternateRefsCommand",
      plant: () => {
        const remote = remoteRepo();
        git("remote", "add", "origin", `file://${remote}`);
        const who = { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@example.com" };
        const more = execFileSync("git", ["--git-dir", remote, "commit-tree", "-m", "more", "-p", "HEAD", "HEAD^{tree}"], { encoding: "utf8", env: who }).trim();
        execFileSync("git", ["--git-dir", remote, "update-ref", "refs/heads/more", more]);
        writeFileSync(join(repo, ".git", "objects", "info", "alternates"), `${join(remote, "objects")}\n`);
        git("config", "core.alternateRefsCommand", evil);
      },
      // file:// only so the fetch runs offline: fetch-pack's negotiation, which runs the command, is the same for https.
      trigger: async (env) => run(["fetch", "-q", "origin"], { ...(await env({ network: true })), GIT_ALLOW_PROTOCOL: "file" }),
    },
    {
      key: "gpg.program / gpg.openpgp.program / merge.verifySignatures",
      plant: () => {
        git("config", "gpg.program", evil);
        git("config", "gpg.openpgp.program", evil);
        git("config", "merge.verifySignatures", "true");
      },
      trigger: async (env) => {
        const sha = signedCommit("PGP");
        const e = await env();
        run(["verify-commit", sha], e);
        run(["merge", "-q", "--ff-only", sha], e);
      },
    },
    {
      key: "gpg.ssh.program / gpg.x509.program",
      plant: () => {
        writeFileSync(join(tmp, "allowed"), "");
        git("config", "gpg.format", "ssh");
        git("config", "gpg.ssh.program", evil);
        git("config", "gpg.x509.program", evil);
        git("config", "gpg.ssh.allowedSignersFile", join(tmp, "allowed"));
      },
      trigger: async (env) => {
        const e = await env();
        run(["verify-commit", signedCommit("SSH")], e);
        run(["verify-commit", signedCommit("SIGNED MESSAGE")], e);
      },
    },
    {
      key: "gpg.ssh.defaultKeyCommand / commit.gpgSign",
      plant: () => {
        git("config", "gpg.format", "ssh");
        git("config", "commit.gpgSign", "true");
        git("config", "gpg.ssh.defaultKeyCommand", evil);
        git("config", "gpg.ssh.program", evil);
      },
      trigger: (env) => commit(env)(),
    },
    {
      key: "core.sshCommand",
      plant: () => {
        git("config", "core.sshCommand", evil);
        git("remote", "add", "origin", "ssh://git@example.invalid/x.git");
      },
      trigger: async (env) => {
        const { GIT_SSH_COMMAND: _c, GIT_SSH: _s, ...e } = await env({ network: true });
        run(["fetch", "-q", "origin"], e);
      },
    },
    {
      key: "core.gitProxy (git://)",
      plant: () => {
        git("config", "core.gitProxy", evil);
        git("remote", "add", "origin", "git://example.invalid/x.git");
      },
      trigger: async (env) => run(["fetch", "-q", "origin"], await env({ network: true })),
    },
    {
      key: "ext:: with protocol.ext.allow",
      plant: () => {
        git("config", "protocol.ext.allow", "always");
        git("config", "protocol.allow", "always");
        git("remote", "add", "origin", `ext::${evil} %S`);
      },
      trigger: async (env) => run(["fetch", "-q", "origin"], await env({ network: true })),
    },
    {
      key: "remote.<name>.vcs (a remote helper)",
      plant: () => {
        mkdirSync(join(tmp, "bin"));
        writeFileSync(join(tmp, "bin", "git-remote-planted"), `#!/bin/sh\n'${evil}' helper\n`, { mode: 0o755 });
        git("config", "remote.origin.vcs", "planted");
        git("config", "remote.origin.url", "planted::x");
        git("config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
      },
      trigger: async (env) => {
        const e = await env({ network: true });
        run(["fetch", "-q", "origin"], { ...e, PATH: `${join(tmp, "bin")}:${e.PATH ?? ""}` });
      },
    },
    {
      key: "remote.<name>.uploadpack (file://)",
      plant: () => {
        git("remote", "add", "origin", `file://${remoteRepo()}`);
        git("config", "remote.origin.uploadpack", evil);
      },
      trigger: async (env) => run(["fetch", "-q", "origin"], await env({ network: true })),
    },
  ];

  const safe: Env = (opts) => safeGitEnv(repo, opts);
  for (const c of cases) {
    test(c.key, async () => {
      c.plant();
      await c.trigger(safe);
      expect(existsSync(marker) ? readFileSync(marker, "utf8") : "").toBe("");
    });
  }

  // The control: each planted program does run under git's plain environment
  // (no overrides; the protocols the case's trigger needs allowed), so each
  // case above tests something.
  for (const c of cases.filter((c) => !c.refused)) {
    test(`control: ${c.key} runs without the overrides`, async () => {
      c.plant();
      await c.trigger(async () => ({ ...gitEnv({ LANG: "C" }, { network: true }), GIT_ALLOW_PROTOCOL: "file:https:ssh:git:ext:planted" }));
      expect(existsSync(marker)).toBe(true);
    });
  }
});
