/**
 * What the git gateway takes of the owner's setup (docs/git-gateway-design.md §3.4): data, never a program. ssh's
 * config is read by codeoid's own parser for one host's data and written back as a config of codeoid's own; a
 * credential helper is run only when it is one of git's or the platforms' own.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fillGitCredential, safeHelper } from "../daemon/git-gateway/connect.js";
import { snapshotProblem, sshConfigSources, sshConfigText, sshHostOf, sshSnapshot, sshSnapshotLine, sshUrlUserPort } from "../daemon/git-gateway/ssh-snapshot.js";

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

describe("ssh snapshot", () => {
  test("the host an ssh URL names", () => {
    expect(sshHostOf("git@bitbucket.org:team/app.git")).toBe("bitbucket.org");
    expect(sshHostOf("ssh://git@host.example:2222/team/app.git")).toBe("host.example");
    expect(sshHostOf("ssh://[::1]/x")).toBeNull();
    expect(sshHostOf("https://host/x")).toBeNull();
    expect(sshHostOf("git@-oProxyCommand=x:y")).toBeNull();
  });

  test("takes one host's data, first value wins, from every Include form", () => {
    mkdirSync(join(home, ".ssh", "conf.d"));
    ssh(["Include=conf.d/*.conf", "Host bb", "  HostName bitbucket.org", "  User second", "  IdentityFile ~/.ssh/id_bb"].join("\n"));
    ssh(['Host "bb"', "  User   = git", "  Port 22"].join("\n"), "conf.d/a.conf");
    const s = sshSnapshot("bb", home);
    expect(s.hostName).toBe("bitbucket.org");
    expect(s.user).toBe("git");
    expect(s.port).toBe("22");
    expect(s.identityFiles).toEqual([join(home, ".ssh", "id_bb")]);
  });

  test("never takes a Match block or a setting that runs something", () => {
    ssh(["Match exec \"touch /tmp/x\"", "  HostName evil.example", "Host bb", "  ProxyCommand nc evil 22", "  LocalCommand touch x", "  KnownHostsCommand x", "  HostName bitbucket.org"].join("\n"));
    const s = sshSnapshot("bb", home);
    expect(s.hostName).toBe("bitbucket.org");
    const text = sshConfigText(s);
    for (const k of ["nc evil", "  LocalCommand", "KnownHostsCommand", "Match", "Include", "evil"]) expect(text).not.toContain(k);
    expect(text).toContain("PermitLocalCommand no");
    expect(text).toContain("ProxyCommand none");
    expect(text).toContain("BatchMode yes");
    // What ssh would do there can't be known: refused, never guessed.
    expect(snapshotProblem(s, [], home)).toContain("Match");
  });

  test("a ProxyCommand for the host is refused; a ProxyJump alias is snapshotted as its own block", () => {
    ssh(["Host bb", "  ProxyCommand nc %h %p"].join("\n"));
    expect(snapshotProblem(sshSnapshot("bb", home), [], home)).toContain("ProxyCommand");
    ssh(["Host bb", "  HostName bitbucket.org", "  ProxyJump bastion", "Host bastion", "  HostName bastion.corp.example", "  Port 2200", "  User jumper"].join("\n"));
    const s = sshSnapshot("bb", home);
    expect(snapshotProblem(s, [], home)).toBeNull();
    const text = sshConfigText(s);
    expect(text).toContain("Host bastion\n  HostName bastion.corp.example\n  User jumper\n  Port 2200");
  });

  test("resolves as OpenSSH does: case-sensitive hosts, includes in a block that doesn't apply, a file included twice, no dotfiles", () => {
    mkdirSync(join(home, ".ssh", "d"));
    ssh(["Host other", "  Include inner", "Host GH", "  HostName wrong.example", "Host *", "  Include d/*"].join("\n"));
    ssh(["Host gh", "  HostName from-inactive.example"].join("\n"), "inner");
    ssh(["HostName right.example"].join("\n"), "d/z");
    ssh(["HostName dotfile.example"].join("\n"), "d/.hidden");
    expect(sshSnapshot("gh", home).hostName).toBe("right.example");
    ssh(["Host a", "  Include d/u", "Host gh", "  Include d/u"].join("\n"));
    ssh(["User git"].join("\n"), "d/u");
    expect(sshSnapshot("gh", home).user).toBe("git");
    ssh(["Include d/[bad"].join("\n"));
    expect(() => sshSnapshot("gh", home)).not.toThrow();
  });

  test("quoting, none, variables and relative key files", () => {
    ssh(["Host bb", "  IdentityFile '/x/my key'", "  UserKnownHostsFile none"].join("\n"));
    const s = sshSnapshot("bb", home);
    expect(s.identityFiles).toEqual(["/x/my key"]);
    expect(sshConfigText(s)).toContain("UserKnownHostsFile none");
    ssh(["Host bb", "  IdentityFile ${HOME}/.ssh/id"].join("\n"));
    expect(snapshotProblem(sshSnapshot("bb", home), [], home)).toContain("doesn't take");
    ssh(["Host bb", "  IdentityFile id_rel"].join("\n"));
    expect(snapshotProblem(sshSnapshot("bb", home), [], home)).toContain("doesn't take");
    ssh(["Host bb", "  IdentityFile none"].join("\n"));
    expect(sshConfigText(sshSnapshot("bb", home))).toContain("IdentityFile none");
  });

  test("a file the config is read from in what a session may write is refused, in every Include form", () => {
    const ws = join(home, "ws");
    mkdirSync(ws);
    writeFileSync(join(ws, "inc"), "Host bb\n  HostName agent.example\n");
    for (const inc of [`Include=${join(ws, "inc")}`, `Include "${join(ws, "inc")}"`, `Include ${join(ws, "*")}`]) {
      ssh(inc);
      const s = sshSnapshot("bb", home);
      expect(s.sources).toContain(join(ws, "inc"));
      expect(snapshotProblem(s, [ws], home)).not.toBeNull();
    }
    expect(sshConfigSources(home)).toContain(join(ws, "inc"));
  });

  test("what the owner is shown takes the URL's own user and port", () => {
    ssh(["Host bb", "  User bob", "  Port 22"].join("\n"));
    expect(sshUrlUserPort("ssh://alice@bb:2222/x.git")).toEqual({ user: "alice", port: "2222" });
    expect(sshSnapshotLine({ ...sshSnapshot("bb", home), urlUser: "alice", urlPort: "2222" })).toContain("bb:2222 as alice");
  });

  test("refuses a value that isn't plain data, and a key a session may write", () => {
    ssh(["Host bb", "  ProxyJump a;b"].join("\n"));
    expect(snapshotProblem(sshSnapshot("bb", home), [], home)).toContain("doesn't take");
    const ws = join(home, "ws");
    mkdirSync(ws);
    ssh(["Host bb", `  IdentityFile ${join(ws, "key")}`].join("\n"));
    expect(snapshotProblem(sshSnapshot("bb", home), [ws], home)).not.toBeNull();
    ssh(["Host bb", "  IdentityFile ~/.ssh/id_bb"].join("\n"));
    expect(snapshotProblem(sshSnapshot("bb", home), [ws], home)).toBeNull();
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

  test("a store file a session may write is refused", async () => {
    const ws = join(home, "ws");
    mkdirSync(ws);
    writeFileSync(join(home, ".gitconfig"), `[credential]\n\thelper = store --file ${join(ws, "creds")}\n`);
    process.env.HOME = home;
    const r = await fillGitCredential("https://host.invalid/x.git", { runDir: join(home, "run"), writable: [ws] }, 10_000);
    expect("error" in r).toBe(true);
  });
});
