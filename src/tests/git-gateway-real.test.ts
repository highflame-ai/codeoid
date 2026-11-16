/**
 * Real bubblewrap, skipped where it can't run (docs/git-gateway-design.md §8): with the network off, a sandboxed
 * command's own `git clone`, `git fetch` and `git push` reach the remote through the session's git gateway, with
 * the spec `buildSandboxSpec` gives a session; a push to main, a force push and a delete are refused with reasons
 * the command reads; nothing a command can read holds a credential. The "remote" is a local bare repository
 * (file://, a test-only allowance) outside what the sandbox shows.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { type GatewayHost, GitGateway } from "../daemon/git-gateway/gateway.js";
import { BwrapSandboxProvider } from "../daemon/sandbox/bwrap.js";
import { buildSandboxSpec } from "../daemon/sandbox/policy.js";
import type { SandboxHandle } from "../daemon/sandbox/types.js";

const provider = new BwrapSandboxProvider();
const probe = await provider.probe();

function scratchParent(): string {
  for (const dir of [process.env.CODEOID_TEST_SANDBOX_DIR, join(homedir(), ".cache")]) {
    if (!dir) continue;
    try {
      mkdirSync(dir, { recursive: true });
      return dir;
    } catch {
      /* next */
    }
  }
  return tmpdir();
}

const URL = "git@bitbucket.example:team/repo.git";

describe.skipIf(!probe.available || !Bun.which("git"))("bubblewrap, for real: git through the gateway with the network off", () => {
  let base: string;
  let home: string;
  let upstream: string;
  let gw: GitGateway;
  let h: SandboxHandle;
  let work: string;
  const env = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };

  beforeAll(async () => {
    base = realpathSync(mkdtempSync(join(scratchParent(), "codeoid-gw-real-")));
    home = join(base, "home");
    work = join(home, "Workspace", "work");
    mkdirSync(work, { recursive: true });
    // The "remote", and the gateway's own dir, in the hidden config dir: nothing inside sees either.
    const configDir = join(home, ".codeoid");
    upstream = join(configDir, "upstream.git");
    mkdirSync(configDir, { recursive: true });
    const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: { PATH: process.env.PATH ?? "", HOME: home, GIT_CONFIG_NOSYSTEM: "1", ...env }, encoding: "utf8" });
    git(base, "init", "-q", "--bare", "-b", "main", upstream);
    const seed = join(base, "seed");
    git(base, "clone", "-q", upstream, seed);
    writeFileSync(join(seed, "a.txt"), "a\n");
    git(seed, "add", ".");
    git(seed, "commit", "-q", "-m", "first");
    git(seed, "push", "-q", "origin", "main");
    const host: GatewayHost = {
      grant: async (_s, _svc, url) =>
        url === URL ? { upstream: { url: `file://${upstream}`, kind: "ssh", testFile: true }, ssh: null, protectedBranches: ["main"], agentBranches: new Map<string, string>(), cacheKey: "real" } : { refused: "not connected" },
      approve: async () => ({ ok: true }),
      report: () => {},
    };
    gw = new GitGateway({ base: join(configDir, "git-gateway"), host });
    const spec = buildSandboxSpec({
      sessionId: "gw-real",
      workspace: work,
      tempDir: mkdtempSync(join(base, "tmp-")),
      network: { mode: "off" },
      hidden: { home, configDir, env: { HOME: home }, daemonTmp: "/tmp" },
      cache: false,
      gitGateway: { ...gw.forSession("gw-real"), urls: [URL] },
    });
    expect(spec.gatewaySockets?.length).toBe(1);
    h = await provider.open(spec);
  });
  afterAll(async () => {
    await h?.close();
    await gw?.close();
    rmSync(base, { recursive: true, force: true });
  });

  const sh = (script: string) => h.exec(["/bin/sh", "-c", script], { cwd: work, env: { PATH: "/usr/bin:/bin", HOME: home, ...env }, timeoutMs: 60_000 });

  test("clone, commit, push a branch of its own: on the remote; main and a force push refused, said to the command", async () => {
    // No network in there.
    expect((await sh("git ls-remote https://github.com/git/git.git HEAD 2>&1")).exitCode).not.toBe(0);
    const clone = await sh(`git clone -q ${URL} r && cd r && git checkout -q -b feature/x && echo b > b.txt && git add . && git commit -q -m b && git push origin feature/x 2>&1`);
    expect([clone.exitCode, clone.stdout + clone.stderr]).toEqual([0, expect.stringContaining("codeoid pushed feature/x")]);
    expect(execFileSync("git", ["-C", upstream, "rev-parse", "--verify", "-q", "refs/heads/feature/x"], { encoding: "utf8" }).trim()).toMatch(/^[0-9a-f]{40}$/);
    const main = await sh("cd r && git checkout -q main && echo m > m.txt && git add . && git commit -q -m m && git push origin main 2>&1");
    expect(main.exitCode).not.toBe(0);
    expect(main.stdout + main.stderr).toContain("main is a protected branch");
    const force = await sh("cd r && git checkout -q feature/x && git reset -q --hard HEAD~1 && echo c > c.txt && git add . && git commit -q -m c && git push --force origin feature/x 2>&1");
    expect(force.exitCode).not.toBe(0);
    expect(force.stdout + force.stderr).toMatch(/a force push isn't done for agents|wasn't made by an agent/);
    const del = await sh("cd r && git push origin --delete feature/x 2>&1");
    expect(del.exitCode).not.toBe(0);
    // Nothing a command reads holds a credential, nor the remote's path (it is the gateway's, outside).
    const env = await sh("env; cat r/.git/config");
    expect(env.stdout).not.toContain(upstream);
    expect(env.stdout).toContain("CODEOID_GIT_GATEWAY=");
  });
});
