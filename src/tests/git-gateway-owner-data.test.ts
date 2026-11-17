/**
 * What the git gateway takes of the owner's setup (docs/git-gateway-design.md §3.4): data, never a program. ssh's
 * config is resolved by OpenSSH itself (`ssh -G`) once codeoid's scan found no Match block and nothing a session may
 * write, and written back as a config of codeoid's own; a credential helper is run only when it is one of git's or
 * the platforms' own, as a line codeoid writes.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { credentialUrlMatches, fillGitCredential, safeHelper } from "../daemon/git-gateway/connect.js";
import { resolveSshSnapshot, scanSshConfig, snapshotProblem, sshConfigSources, sshConfigText, sshHostOf, sshSnapshotLine, sshUrlUserPort } from "../daemon/git-gateway/ssh-snapshot.js";

let home: string;
let savedHome: string | undefined;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "gw-owner-")));
  mkdirSync(join(home, ".ssh"), { mode: 0o700 });
  savedHome = process.env.HOME;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
});

const ssh = (text: string, file = "config") => writeFileSync(join(home, ".ssh", file), text, { mode: 0o600 });

const SSH = "/usr/bin/ssh";
const resolve = (url: string, writable: string[] = []) => resolveSshSnapshot(url, { ssh: SSH, home, writable });

describe("ssh snapshot", () => {
  test("the host an ssh URL names, and its own user and port", () => {
    expect(sshHostOf("git@bitbucket.org:team/app.git")).toBe("bitbucket.org");
    expect(sshHostOf("ssh://git@host.example:2222/team/app.git")).toBe("host.example");
    expect(sshHostOf("ssh://[::1]/x")).toBeNull();
    expect(sshHostOf("https://host/x")).toBeNull();
    expect(sshHostOf("git@-oProxyCommand=x:y")).toBeNull();
    expect(sshUrlUserPort("ssh://alice@bb:2222/x.git")).toEqual({ user: "alice", port: "2222" });
  });

  test("OpenSSH resolves it: IdentitiesOnly in any spelling, the URL's user and port, jump hosts as their own blocks", async () => {
    const key = join(home, ".ssh", "id_bb");
    writeFileSync(key, "k", { mode: 0o600 });
    ssh(["Host bb", "  HostName bitbucket.org", "  User git", "  IdentitiesOnly true", `  IdentityFile ${key}`, "  ProxyJump j1", "Host j1", "  HostName jump.example", "  Port 2200", "  User jumper"].join("\n"));
    const s = await resolve("bb:team/app.git");
    if ("error" in s) throw new Error(s.error);
    expect(s.hostName).toBe("bitbucket.org");
    expect(s.identitiesOnly).toBe(true);
    expect(s.identityFiles).toContain(key);
    expect(s.jumps?.[0]).toMatchObject({ host: "j1", hostName: "jump.example", port: "2200", user: "jumper" });
    expect(snapshotProblem(s, [], home)).toBeNull();
    const text = sshConfigText(s);
    expect(text).toContain("IdentitiesOnly yes");
    expect(text).toContain("Host j1\n  HostName jump.example\n  User jumper\n  Port 2200");
    for (const k of ["ProxyCommand none", "PermitLocalCommand no", "ControlPath none", "BatchMode yes"]) expect(text).toContain(k);
    expect(sshSnapshotLine(s)).toContain(`bitbucket.org as git via j1, key ${key}`);
    const u = await resolve("ssh://alice@bb:2222/x.git");
    if ("error" in u) throw new Error(u.error);
    expect(u).toMatchObject({ user: "alice", port: "2222" });
  });

  test("a Match block in any spelling, in any file the config can read, is refused before ssh runs", async () => {
    const mark = join(home, "ran");
    mkdirSync(join(home, ".ssh", "d"));
    for (const line of [`Match exec "touch ${mark}"`, `"Match" exec "touch ${mark}"`, `=match exec "touch ${mark}"`, `MATCH exec "touch ${mark}"`, `M\\atch exec "touch ${mark}"`]) {
      ssh(["Host other", "  Include d/inner", "Host bb", "  HostName bitbucket.org"].join("\n"));
      ssh(line, "d/inner");
      const s = await resolve("bb:x.git");
      expect("error" in s && s.error).toContain("Match");
    }
    expect(existsSync(mark)).toBe(false);
  });

  test("what codeoid doesn't take is refused: ProxyCommand, KnownHostsCommand, CanonicalizeHostname, variables", async () => {
    for (const [cfg, word] of [
      ["  ProxyCommand nc %h %p", "ProxyCommand"],
      ["  KnownHostsCommand /bin/true", "KnownHostsCommand"],
      ["  CanonicalizeHostname yes", "CanonicalizeHostname"],
      ["  IdentityFile ${HOME}/.ssh/id", "doesn't take"],
      ["  IdentityFile %d/.ssh/id", "doesn't take"],
    ] as const) {
      ssh(["Host bb", cfg].join("\n"));
      const s = await resolve("bb:x.git");
      const why = "error" in s ? s.error : snapshotProblem(s, [], home);
      expect(why).toContain(word);
    }
    ssh(["Include $HOME/x"].join("\n"));
    expect(scanSshConfig(home).problem).toContain("Include");
  });

  test("a FIFO the config includes is never read (nothing blocks), and refused", async () => {
    const ws = join(home, "ws");
    mkdirSync(ws);
    spawnSync("mkfifo", [join(ws, "fifo")]);
    ssh(`Include ${join(ws, "fifo")}`);
    const t = Date.now();
    const scan = scanSshConfig(home);
    expect(Date.now() - t).toBeLessThan(2_000);
    expect(scan.problem).toContain("plain file");
  });

  test("a file the config is read from in what a session may write is refused, in every Include form, and held", async () => {
    const ws = join(home, "ws");
    mkdirSync(ws);
    writeFileSync(join(ws, "inc"), "Host bb\n  HostName agent.example\n");
    for (const inc of [`Include=${join(ws, "inc")}`, `Include "${join(ws, "inc")}"`, `"Include" ${join(ws, "*")}`, `Host nomatch\n  Include ${join(ws, "inc")}`, `include ${join(ws, "missing")}`]) {
      ssh(inc);
      const s = await resolve("bb:x.git", [ws]);
      expect("error" in s).toBe(true);
    }
    ssh(`Include=${join(ws, "inc")}`);
    expect(sshConfigSources(home)).toContain(join(ws, "inc"));
  });

  test("a key file that leads into what a session may write is refused", async () => {
    const ws = join(home, "ws");
    mkdirSync(ws);
    writeFileSync(join(ws, "key"), "k", { mode: 0o600 });
    symlinkSync(join(ws, "key"), join(home, ".ssh", "id_link"));
    ssh(["Host bb", `  IdentityFile ${join(home, ".ssh", "id_link")}`].join("\n"));
    const s = await resolve("bb:x.git");
    if ("error" in s) throw new Error(s.error);
    expect(snapshotProblem(s, [ws], home)).toContain("id_link");
  });
});

describe("credential helpers", () => {
  test("a helper that isn't git's or a platform's own is never run", async () => {
    const mark = join(home, "ran");
    writeFileSync(join(home, ".gitconfig"), `[credential]\n\thelper = "!touch ${mark}; echo password=x"\n`);
    process.env.HOME = home;
    const r = await fillGitCredential("https://host.invalid/x.git", { runDir: join(home, "run"), writable: [] }, 10_000);
    expect("error" in r && r.error).toContain("--token");
    expect(existsSync(mark)).toBe(false);
  });

  test("git's own store helper is run, with only the helpers allowed", async () => {
    const store = join(home, ".git-credentials");
    writeFileSync(store, "https://agent:secret-value@host.invalid\n", { mode: 0o600 });
    writeFileSync(join(home, ".gitconfig"), `[credential]\n\thelper = store --file ${store}\n`);
    process.env.HOME = home;
    const r = await fillGitCredential("https://host.invalid/x.git", { runDir: join(home, "run"), writable: [] }, 10_000);
    expect(r).toEqual({ username: "agent", password: "secret-value" });
  });

  test("an allowed helper's name is never found in a PATH dir a session may write", async () => {
    const ws = join(home, "ws");
    const mark = join(home, "ran");
    mkdirSync(join(ws, "bin"), { recursive: true });
    writeFileSync(join(ws, "bin", "git-credential-manager"), `#!/bin/sh\ntouch ${mark}\necho password=x\n`, { mode: 0o755 });
    writeFileSync(join(home, ".gitconfig"), "[credential]\n\thelper = manager\n");
    process.env.HOME = home;
    const savedPath = process.env.PATH;
    process.env.PATH = `${join(ws, "bin")}:${savedPath}`;
    try {
      const r = await fillGitCredential("https://host.invalid/x.git", { runDir: join(home, "run"), writable: [ws] }, 10_000);
      expect("error" in r).toBe(true);
      expect(existsSync(mark)).toBe(false);
    } finally {
      process.env.PATH = savedPath;
    }
  });

  test("a store helper carrying shell is refused, and nothing of it runs", async () => {
    const mark = join(home, "ran");
    for (const h of [`store --file=/usr/x|touch\${IFS}${mark}|true`, `store --file=/x$(touch ${mark})`, `store --file=/x\`touch ${mark}\``]) {
      expect("error" in safeHelper(h, home)).toBe(true);
      writeFileSync(join(home, ".gitconfig"), `[credential]\n\thelper = ${JSON.stringify(h)}\n`);
      process.env.HOME = home;
      const r = await fillGitCredential("https://host.invalid/x.git", { runDir: join(home, "run"), writable: [] }, 10_000);
      expect("error" in r).toBe(true);
    }
    expect(existsSync(mark)).toBe(false);
    expect(safeHelper("store --file ~/.git-credentials", home)).toEqual({ line: `store --file '${join(home, ".git-credentials")}'`, file: join(home, ".git-credentials") });
  });

  test("a helper scoped to another URL isn't used (git's urlmatch, not a prefix)", () => {
    const u = new URL("https://host.example/team/app.git");
    expect(credentialUrlMatches("https://host.example", u)).toBe(true);
    expect(credentialUrlMatches("https://host.example/team", u)).toBe(true);
    expect(credentialUrlMatches("https://*.example", u)).toBe(true);
    expect(credentialUrlMatches("https://host.example/te", u)).toBe(false);
    expect(credentialUrlMatches("https://host.example.evil", u)).toBe(false);
    expect(credentialUrlMatches("http://host.example", u)).toBe(false);
    expect(credentialUrlMatches("https://host.example:8443", u)).toBe(false);
    expect(credentialUrlMatches("host.example", u)).toBe(false);
  });

  test("a store file a session may write is refused", async () => {
    const ws = join(home, "ws");
    mkdirSync(ws);
    writeFileSync(join(home, ".gitconfig"), `[credential]\n\thelper = store --file ${join(ws, "creds")}\n`);
    process.env.HOME = home;
    const r = await fillGitCredential("https://host.invalid/x.git", { runDir: join(home, "run"), writable: [ws] }, 10_000);
    expect("error" in r).toBe(true);
  });
});
