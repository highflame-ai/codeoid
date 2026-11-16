/**
 * What the git gateway takes of the owner's setup (docs/git-gateway-design.md §3.4): data, never a program. ssh's
 * config is read by codeoid's own parser for one host's data and written back as a config of codeoid's own; a
 * credential helper is run only when it is one of git's or the platforms' own.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fillGitCredential } from "../daemon/git-gateway/connect.js";
import { snapshotProblem, sshConfigText, sshHostOf, sshSnapshot } from "../daemon/git-gateway/ssh-snapshot.js";

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
    for (const k of ["ProxyCommand", "  LocalCommand", "KnownHostsCommand", "Match", "Include", "evil"]) expect(text).not.toContain(k);
    expect(text).toContain("PermitLocalCommand no");
    expect(text).toContain("BatchMode yes");
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

  test("a store file a session may write is refused", async () => {
    const ws = join(home, "ws");
    mkdirSync(ws);
    writeFileSync(join(home, ".gitconfig"), `[credential]\n\thelper = store --file ${join(ws, "creds")}\n`);
    process.env.HOME = home;
    const r = await fillGitCredential("https://host.invalid/x.git", { runDir: join(home, "run"), writable: [ws] }, 10_000);
    expect("error" in r).toBe(true);
  });
});
