/**
 * Credentials git may read in a project root, and credential files found by
 * name or by what is in them (#448 round 13; the real-bwrap side is
 * sandbox-root-credentials-real.test.ts): every `extraheader` syntax git
 * reads, an inline helper printing a password, a token in a URL's query,
 * what a config includes; a bare mirror's, a submodule's and a worktree's
 * config, a credential store in the git dir, private keys by their usual
 * names (never a source file), a Mercurial `hgrc`, Yarn's and Composer's.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { gitConfigHasCredential, gitConfigIncludes, projectRootSecrets } from "../daemon/sandbox/project-roots.js";

let base: string;
beforeAll(() => {
  const parent = process.env.CODEOID_TEST_SANDBOX_DIR ?? join(homedir(), ".cache");
  mkdirSync(parent, { recursive: true });
  base = realpathSync(mkdtempSync(join(parent, "codeoid-pins-")));
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

let n = 0;
function scratch(): string {
  const d = join(base, `t${++n}`);
  mkdirSync(d, { recursive: true });
  return d;
}

const GIT_ENV = (home: string) => ({ PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e.invalid" });
function git(args: string[], cwd: string): void {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: GIT_ENV(cwd) });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
}
function repo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  git(["init", "-q", "-b", "main"], dir);
  writeFileSync(join(dir, "README.md"), "x\n");
  git(["add", "."], dir);
  git(["commit", "-qm", "i"], dir);
  return dir;
}

describe("credentials git may read in a project root", () => {
  test("every extraheader syntax, an inline helper with a password, a token in a URL's query; a plain config isn't", () => {
    const d = scratch();
    const cases: Record<string, [string, boolean]> = {
      headerLine: ["[http] extraheader = AUTHORIZATION: bearer T1\n", true],
      headerUrl: ['[http "https://example.invalid/"]\n\textraHeader = Authorization: Basic T\n', true],
      headerCase: ["[http]\n\tExtraHeader=x\n", true],
      helperInline: ['[credential]\n\thelper = "!f() { echo password=T3; }; f"\n', true],
      urlSameLine: ['[remote "o"] url = https://u:T2@h/x\n', true],
      sshPassword: ['[remote "o"]\n\turl = ssh://u:pw@h/x\n', true],
      queryToken: ['[remote "o"]\n\turl = https://h/x.git?private_token=T4\n', true],
      plain: ['[remote "o"]\n\turl = https://example.invalid/x.git\n[credential]\n\thelper = osxkeychain\n', false],
      sshUser: ['[remote "o"]\n\turl = ssh://git@example.invalid/x.git\n', false],
    };
    for (const [name, [text, expected]] of Object.entries(cases)) {
      writeFileSync(join(d, name), text);
      expect([name, gitConfigHasCredential(join(d, name))]).toEqual([name, expected]);
    }
    writeFileSync(join(d, "inc"), '[include]\n\tpath = ../tokens.cfg\n[includeIf "gitdir:~/w/"]\n\tpath = "/abs/x.cfg"\n[include] path = ~/y.cfg\n');
    expect(gitConfigIncludes(join(d, "inc"), "/h")).toEqual([join(base, "tokens.cfg"), "/abs/x.cfg", "/h/y.cfg"]);
  });

  test("a bare mirror's, a submodule's, a worktree's config.worktree, an included file, a store in the git dir, key names, hgrc, Yarn's and Composer's: hidden; the rest isn't", () => {
    const d = scratch();
    const root = join(d, "W");
    const a = repo(join(root, "a"));
    const b = repo(join(root, "b"));
    const mirror = join(root, "mirror.git");
    git(["init", "-q", "--bare", mirror], root);
    git(["remote", "add", "origin", "https://x:BARE@example.invalid/m.git"], mirror);
    mkdirSync(join(b, ".git", "modules", "libs", "sub"), { recursive: true });
    writeFileSync(join(b, ".git", "modules", "libs", "sub", "config"), '[remote "origin"]\n\turl = https://x:SUB@example.invalid/s.git\n');
    mkdirSync(join(b, ".git", "worktrees", "w"), { recursive: true });
    writeFileSync(join(b, ".git", "worktrees", "w", "config.worktree"), "[http] extraheader = AUTHORIZATION: bearer WT\n");
    writeFileSync(join(b, "tokens.cfg"), "[http]\n\textraheader = AUTHORIZATION: bearer INC\n");
    git(["config", "include.path", "../tokens.cfg"], b);
    git(["config", "credential.helper", "store --file=.git/creds-store"], b);
    writeFileSync(join(b, ".git", "creds-store"), "https://x:STORE@example.invalid\n");
    writeFileSync(join(b, ".git", "credentials"), "https://x:STORE2@example.invalid\n");
    const keys = ["deploy_key", "github_ed25519", "id_work", "id_rsa.old", "server.ppk", "AuthKey_ABC.p8", "x_deploy_key"];
    const notKeys = ["id_generator.ts", "crypto_rsa.go", "id_rsa.pub", "deploy_key.pub", "README.md"];
    for (const f of [...keys, ...notKeys]) writeFileSync(join(b, f), "k\n");
    const c = join(root, "c");
    mkdirSync(join(c, ".hg"), { recursive: true });
    writeFileSync(join(c, ".hg", "hgrc"), "[auth]\nx.prefix = example.invalid\nx.password = HG\n");
    writeFileSync(join(c, ".yarnrc.yml"), 'npmAuthToken: "YARN"\n');
    writeFileSync(join(c, "auth.json"), '{"github-oauth":{"github.com":"COMPOSER"}}\n');
    const plain = join(root, "plain");
    mkdirSync(plain);
    writeFileSync(join(plain, ".yarnrc.yml"), "nodeLinker: node-modules\n");
    writeFileSync(join(plain, "auth.json"), '{"user":"x"}\n');
    const found = projectRootSecrets([root], [a]);
    const expected = [
      join(mirror, "config"),
      join(b, ".git", "modules", "libs", "sub", "config"),
      join(b, ".git", "worktrees", "w", "config.worktree"),
      join(b, "tokens.cfg"),
      join(b, ".git", "creds-store"),
      join(b, ".git", "credentials"),
      ...keys.map((k) => join(b, k)),
      join(c, ".hg", "hgrc"),
      join(c, ".yarnrc.yml"),
      join(c, "auth.json"),
    ];
    for (const p of expected) expect([p, found.hidden.includes(p)]).toEqual([p, true]);
    for (const p of [...notKeys.map((k) => join(b, k)), join(plain, ".yarnrc.yml"), join(plain, "auth.json"), join(b, ".git", "config")]) expect([p, found.hidden.includes(p)]).toEqual([p, false]);
    expect(found.gitConfigs).toContain(join(mirror, "config"));
    expect(found.gitConfigs).toContain(join(b, "tokens.cfg"));
  });

});
