/**
 * The OS sandbox's policy, as arguments (#448): bubblewrap's argv for a spec,
 * the hidden-path list derived from codeoid's data dirs, the credential
 * stores and the config, and the registry's choice of provider. Pure: no
 * sandbox runs here (sandbox-bwrap-real.test.ts runs real ones).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodeoidConfig } from "../config.js";
import { loadConfig } from "../config.js";
import { BwrapSandboxProvider, type PathKind, bwrapArgs } from "../daemon/sandbox/bwrap.js";
import {
  DEFAULT_HOME_READABLE,
  HOME_CREDENTIAL_PATHS,
  buildSandboxSpec,
  containerSocketPaths,
  hiddenPathsFor,
  networkPolicyOf,
  protectedAncestors,
  sandboxConfigOf,
  validAllowedHost,
} from "../daemon/sandbox/policy.js";
import { SandboxRegistry } from "../daemon/sandbox/registry.js";
import type { SandboxProbe, SandboxProvider, SandboxSpec } from "../daemon/sandbox/types.js";
import { registerSecretPaths } from "../daemon/secret-paths.js";

function spec(over: Partial<SandboxSpec> = {}): SandboxSpec {
  return {
    sessionId: "s1",
    workspace: "/work/repo",
    tempDir: "/var/tmp/codeoid-s1",
    writable: [],
    hidden: [],
    reexposed: [],
    containerSockets: [],
    network: { mode: "on" },
    unsetEnv: [],
    ...over,
  };
}

/** A fake filesystem: every listed path exists as given. */
function fs(entries: Record<string, "dir" | "other">): (p: string) => PathKind {
  return (p) => entries[p] ?? null;
}

/** The mount operations, in order, as [flag, ...operands]. */
function mounts(args: string[]): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (a === "--tmpfs" || a === "--remount-ro" || a === "--unsetenv" || a === "--chdir") out.push([a, args[++i] ?? ""]);
    else if (a === "--bind" || a === "--ro-bind" || a === "--setenv") out.push([a, args[++i] ?? "", args[++i] ?? ""]);
  }
  return out;
}

describe("bwrapArgs", () => {
  test("the host read-only, a new /dev and /proc, a private /tmp, the workspace writable, starting in cwd", () => {
    const args = bwrapArgs(spec(), "/work/repo/sub", fs({ "/work/repo": "dir", "/var/tmp/codeoid-s1": "dir" }));
    expect(args.slice(0, 6)).toEqual(["--die-with-parent", "--new-session", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--unshare-cgroup-try"]);
    expect(args).not.toContain("--unshare-net");
    const m = mounts(args);
    expect(m[0]).toEqual(["--ro-bind", "/", "/"]);
    expect(args).toContain("--dev");
    expect(args[args.indexOf("--proc") + 1]).toBe("/proc");
    expect(m).toContainEqual(["--bind", "/var/tmp/codeoid-s1", "/tmp"]);
    expect(m).toContainEqual(["--bind", "/work/repo", "/work/repo"]);
    expect(m).toContainEqual(["--setenv", "TMPDIR", "/tmp"]);
    expect(m.at(-1)).toEqual(["--chdir", "/work/repo/sub"]);
  });

  test("network off unshares the network; an allowlist can't be enforced, so it is off too (never on)", () => {
    expect(bwrapArgs(spec({ network: { mode: "off" } }), "/", fs({}))).toContain("--unshare-net");
    expect(bwrapArgs(spec({ network: { mode: "allowlist", allow: ["github.com"] } }), "/", fs({}))).toContain("--unshare-net");
  });

  test("a hidden dir is an empty tmpfs made read-only again; a hidden file or socket is /dev/null; a missing one is skipped", () => {
    const m = mounts(
      bwrapArgs(
        spec({ hidden: ["/home/u/.ssh", "/home/u/.netrc", "/home/u/.nothing"], containerSockets: ["/run/docker.sock", "/run/containerd"] }),
        "/",
        fs({ "/home/u/.ssh": "dir", "/home/u/.netrc": "other", "/run/docker.sock": "other", "/run/containerd": "dir" }),
      ),
    );
    expect(m).toContainEqual(["--tmpfs", "/home/u/.ssh"]);
    expect(m).toContainEqual(["--remount-ro", "/home/u/.ssh"]);
    expect(m).toContainEqual(["--ro-bind", "/dev/null", "/home/u/.netrc"]);
    expect(m).toContainEqual(["--ro-bind", "/dev/null", "/run/docker.sock"]);
    expect(m).toContainEqual(["--tmpfs", "/run/containerd"]);
    expect(m.flat()).not.toContain("/home/u/.nothing");
  });

  test("mounts are laid shallowest first: a workspace inside a hidden dir is bound back, a hidden dir inside the workspace stays hidden", () => {
    const m = mounts(
      bwrapArgs(
        spec({ workspace: "/home/u", hidden: ["/home/u/.ssh", "/srv"], writable: ["/srv/data/ws"] }),
        "/",
        fs({ "/home/u": "dir", "/home/u/.ssh": "dir", "/srv": "dir", "/srv/data/ws": "dir" }),
      ),
    );
    const at = (op: string[]) => m.findIndex((x) => x.join(" ") === op.join(" "));
    expect(at(["--bind", "/home/u", "/home/u"])).toBeLessThan(at(["--tmpfs", "/home/u/.ssh"]));
    expect(at(["--tmpfs", "/srv"])).toBeLessThan(at(["--bind", "/srv/data/ws", "/srv/data/ws"]));
    // Read-only again only after every mount point inside it is made.
    expect(at(["--remount-ro", "/srv"])).toBeGreaterThan(at(["--bind", "/srv/data/ws", "/srv/data/ws"]));
  });

  test("a hidden path under the host's /tmp isn't mounted (the sandbox's /tmp is its own) unless a writable location brings it in", () => {
    const m = mounts(
      bwrapArgs(spec({ workspace: "/tmp/ws", hidden: ["/tmp/codeoid-login-x", "/tmp/ws/.env"] }), "/", fs({ "/tmp/ws": "dir", "/tmp/codeoid-login-x": "dir", "/tmp/ws/.env": "other" })),
    );
    expect(m.flat()).not.toContain("/tmp/codeoid-login-x");
    expect(m).toContainEqual(["--ro-bind", "/dev/null", "/tmp/ws/.env"]);
  });

  test("a re-exposed path is shown read-only only where a hidden dir covers it", () => {
    const m = mounts(
      bwrapArgs(spec({ hidden: ["/home/u/.config"], reexposed: ["/home/u/.config/tool", "/opt/elsewhere"] }), "/", fs({ "/home/u/.config": "dir", "/home/u/.config/tool": "dir", "/opt/elsewhere": "dir" })),
    );
    expect(m).toContainEqual(["--ro-bind", "/home/u/.config/tool", "/home/u/.config/tool"]);
    expect(m.flat()).not.toContain("/opt/elsewhere");
  });

  test("environment variables that lead out of the sandbox are unset", () => {
    expect(mounts(bwrapArgs(spec({ unsetEnv: ["SSH_AUTH_SOCK", "DBUS_SESSION_BUS_ADDRESS"] }), "/", fs({})))).toEqual(
      expect.arrayContaining([
        ["--unsetenv", "SSH_AUTH_SOCK"],
        ["--unsetenv", "DBUS_SESSION_BUS_ADDRESS"],
      ]),
    );
  });

  test("a provider handle wraps an argv after `--`", async () => {
    const p = new BwrapSandboxProvider({ bwrapPath: "/usr/bin/bwrap" });
    const h = await p.open(spec());
    const w = h.wrap?.(["/bin/sh", "-c", "true"], { cwd: "/work/repo", env: { A: "1" } });
    expect(w?.argv[0]).toBe("/usr/bin/bwrap");
    expect(w?.argv.slice(-4)).toEqual(["--", "/bin/sh", "-c", "true"]);
    expect(w?.env).toEqual({ A: "1" });
    await h.close();
    await h.close(); // idempotent
    expect(() => h.wrap?.(["true"], { cwd: "/", env: {} })).toThrow(/closed/);
  });
});

describe("hidden paths", () => {
  let root: string;
  let home: string;
  let configDir: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "codeoid-sbx-policy-"));
    home = join(root, "home");
    configDir = join(home, ".codeoid");
    mkdirSync(join(home, ".ssh"), { recursive: true });
    mkdirSync(configDir, { recursive: true });
    mkdirSync(join(root, "real-aws"), { recursive: true });
    symlinkSync(join(root, "real-aws"), join(home, ".aws"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const config = (extra: Partial<CodeoidConfig> = {}) =>
    ({
      dbPath: join(root, "data", "codeoid.db"),
      transcriptDir: join(root, "data", "transcripts"),
      providers: { opencode: { dbPath: join(root, "oc", "opencode.db"), dataDir: join(root, "oc-data") } },
      memory: { enabled: true, dbPath: join(root, "mem", "memory.db") },
      ...extra,
    }) as unknown as CodeoidConfig;

  test("codeoid's config dir and every dir it owns, the credential stores, the runtime dir, a symlinked one by where it leads", () => {
    const hidden = hiddenPathsFor(config(), { home, configDir, env: { HOME: home, XDG_RUNTIME_DIR: "/run/user/4242" }, daemonTmp: "/tmp" });
    expect(hidden).toContain(configDir);
    expect(hidden).toContain(join(root, "data"));
    expect(hidden).toContain(join(root, "data", "transcripts"));
    expect(hidden).toContain(join(root, "oc"));
    expect(hidden).toContain(join(root, "oc-data"));
    expect(hidden).toContain(join(root, "mem"));
    for (const rel of [".ssh", ".aws", ".kube", ".docker", ".gnupg", ".config/gh", ".netrc", ".git-credentials", ".config/gcloud", ".local/share/keyrings"]) {
      expect(hidden).toContain(join(home, rel));
    }
    expect(HOME_CREDENTIAL_PATHS).toContain(".ssh");
    expect(hidden).toContain(join(root, "real-aws"));
    expect(hidden).toContain("/run/user/4242");
    // /tmp is replaced inside, not hidden; another daemon temp dir is hidden.
    expect(hidden).not.toContain("/tmp");
    expect(hiddenPathsFor(undefined, { home, configDir, env: { HOME: home }, daemonTmp: "/var/folders/x/T" })).toContain("/var/folders/x/T");
  });

  test("the agent CLIs' logins and what backends registered", () => {
    const undo = registerSecretPaths({ dirs: [join(root, "creds")], files: [join(root, "oc.db")] });
    try {
      const hidden = hiddenPathsFor(undefined, { home, configDir, env: { HOME: home }, daemonTmp: "/tmp" });
      expect(hidden).toContain(join(root, "creds"));
      expect(hidden).toContain(join(root, "oc.db"));
      expect(hidden).toContain(join(root, "oc.db-wal"));
      expect(hidden.some((p) => p.endsWith("/.credentials.json"))).toBe(true);
      expect(hidden.some((p) => p.endsWith("/auth.json"))).toBe(true);
    } finally {
      undo();
    }
  });

  test("sandbox.hiddenPaths adds more, `~` expanded; relative entries are ignored", () => {
    const hidden = hiddenPathsFor(config({ sandbox: { ...sandboxConfigOf(undefined), hiddenPaths: ["~/secrets", "/srv/keys", "rel/path"] } }), {
      home,
      configDir,
      env: { HOME: home },
      daemonTmp: "/tmp",
    });
    expect(hidden).toContain(join(home, "secrets"));
    expect(hidden).toContain("/srv/keys");
    expect(hidden.some((p) => p.endsWith("rel/path"))).toBe(false);
  });

  test("a backend's own state is taken out of the hidden list and made writable", () => {
    const s = buildSandboxSpec({
      sessionId: "s",
      workspace: join(root, "ws"),
      tempDir: join(root, "t"),
      network: { mode: "on" },
      backendState: [join(home, ".pi", "agent")],
      hidden: { home, configDir, env: { HOME: home, PI_CODING_AGENT_DIR: join(home, ".pi", "agent") }, daemonTmp: "/tmp" },
    });
    // Its state, and the sandbox's cache dir (the toolchains' caches).
    expect(s.writable).toEqual([join(home, ".pi", "agent"), join(home, ".cache", "codeoid-sandbox")]);
    expect(s.hidden.some((h) => h.startsWith(join(home, ".pi", "agent")))).toBe(false);
    // The home is hidden whole; a credential store in it needs no rule of its own.
    expect(s.hidden).toContain(home);
    expect(s.hidden).not.toContain(join(home, ".ssh"));
    expect(s.unsetEnv).toContain("SSH_AUTH_SOCK");
    expect(s.containerSockets).toContain("/run/docker.sock");
  });

  test("container sockets: the system ones, the user's runtime dir's, Docker Desktop's, DOCKER_HOST's", () => {
    const socks = containerSocketPaths("/home/u", { XDG_RUNTIME_DIR: "/run/user/1000", DOCKER_HOST: "unix:///srv/d.sock" });
    for (const p of ["/run/docker.sock", "/var/run/docker.sock", "/run/containerd", "/run/podman", "/run/user/1000/docker.sock", "/run/user/1000/podman", "/home/u/.docker/run", "/srv/d.sock"]) {
      expect(socks).toContain(p);
    }
  });

  test("network policy: the session's over the config's; an allowlist carries its hosts", () => {
    const cfg = sandboxConfigOf({ sandbox: { ...sandboxConfigOf(undefined), network: "allowlist", allowedHosts: ["github.com"] } });
    expect(networkPolicyOf(cfg)).toEqual({ mode: "allowlist", allow: ["github.com"] });
    expect(networkPolicyOf(cfg, { mode: "off" })).toEqual({ mode: "off" });
    expect(networkPolicyOf(cfg, { allow: ["*.npmjs.org"] })).toEqual({ mode: "allowlist", allow: ["*.npmjs.org"] });
    expect(validAllowedHost("*.example.com")).toBe(true);
    expect(validAllowedHost("localhost")).toBe(true);
    for (const bad of ["*", "http://x.com", "a b", "x.com/path", ""]) expect(validAllowedHost(bad)).toBe(false);
  });
});

describe("config", () => {
  test("on by default: auto, network on", () => {
    const c = loadConfig({ raw: {}, env: {}, quiet: true });
    expect(c.sandbox).toEqual({ provider: "auto", network: "on", allowedHosts: [], hiddenPaths: [], homeReadable: [...DEFAULT_HOME_READABLE], docker: { image: "node:22-bookworm-slim" } });
  });

  test("env vars override the file", () => {
    const c = loadConfig({
      raw: { sandbox: { provider: "docker", network: "on" } },
      env: { CODEOID_SANDBOX: "off", CODEOID_SANDBOX_NETWORK: "allowlist", CODEOID_SANDBOX_ALLOWED_HOSTS: "github.com,*.npmjs.org", CODEOID_SANDBOX_HIDDEN_PATHS: "~/x" },
      quiet: true,
    });
    expect(c.sandbox?.provider).toBe("off");
    expect(c.sandbox?.network).toBe("allowlist");
    expect(c.sandbox?.allowedHosts).toEqual(["github.com", "*.npmjs.org"]);
    expect(c.sandbox?.hiddenPaths).toEqual(["~/x"]);
  });

  test("an unknown network mode is refused", () => {
    expect(() => loadConfig({ raw: { sandbox: { network: "sometimes" } }, env: {}, quiet: true })).toThrow();
  });
});

describe("SandboxRegistry", () => {
  function fake(id: string, probe: SandboxProbe, platforms: NodeJS.Platform[] = ["linux", "darwin"]): SandboxProvider & { probes: number } {
    const p = {
      id,
      displayName: id,
      probes: 0,
      capabilities: { isolation: "os", placement: "local", workspace: "mount", stdioProcess: true, commands: true, wrapsArgv: true, network: ["on", "off"], platforms },
      async probe() {
        p.probes++;
        return probe;
      },
      async open(): Promise<never> {
        throw new Error("not here");
      },
    } as SandboxProvider & { probes: number };
    return p;
  }

  test("auto is bwrap on Linux and seatbelt on macOS; Docker only when chosen", async () => {
    const linux = new SandboxRegistry("linux");
    linux.register(fake("bwrap", { available: true }));
    linux.register(fake("seatbelt", { available: true }, ["darwin"]));
    linux.register(fake("docker", { available: true }));
    const r = await linux.resolve("auto");
    expect(r.kind === "provider" && r.provider.id).toBe("bwrap");
    const mac = new SandboxRegistry("darwin");
    mac.register(fake("bwrap", { available: true }, ["linux"]));
    mac.register(fake("seatbelt", { available: true }, ["darwin"]));
    const m = await mac.resolve("auto");
    expect(m.kind === "provider" && m.provider.id).toBe("seatbelt");
    const d = await linux.resolve("docker");
    expect(d.kind === "provider" && d.provider.id).toBe("docker");
    const w = new SandboxRegistry("win32");
    w.register(fake("docker", { available: true }));
    expect((await w.resolve("auto")).kind).toBe("unknown");
  });

  test("off, an unknown id, a provider for another platform", async () => {
    const r = new SandboxRegistry("linux");
    r.register(fake("bwrap", { available: true }));
    r.register(fake("seatbelt", { available: true }, ["darwin"]));
    expect(await r.resolve("off")).toEqual({ kind: "off" });
    const u = await r.resolve("firecracker");
    expect(u.kind).toBe("unknown");
    expect(u.kind === "unknown" && u.reason).toContain("auto, off, bwrap, seatbelt");
    const s = await r.resolve("seatbelt");
    expect(s.kind === "provider" && s.probe).toEqual({ available: false, reason: "seatbelt doesn't run on linux" });
    expect(r.knows("auto") && r.knows("off") && r.knows("bwrap") && !r.knows("nope")).toBe(true);
    expect(() => r.register(fake("off", { available: true }))).toThrow(/reserved/);
  });

  test("probes are cached, and run once for concurrent asks", async () => {
    const r = new SandboxRegistry("linux");
    const p = fake("bwrap", { available: false, reason: "missing" });
    r.register(p);
    await Promise.all([r.probe("bwrap"), r.probe("bwrap"), r.probe("bwrap")]);
    await r.probe("bwrap");
    expect(p.probes).toBe(1);
    expect(r.cachedProbe("bwrap")).toEqual({ available: false, reason: "missing" });
    r.resetProbes();
    await r.probe("bwrap");
    expect(p.probes).toBe(2);
  });
});

describe("bwrap probe", () => {
  test("names what's missing", async () => {
    const p = new BwrapSandboxProvider({ bwrapPath: join(tmpdir(), "no-such-bwrap-binary") });
    const probe = await p.probe();
    expect(probe.available).toBe(false);
  });
  test("a file at a fake bwrap path that isn't bwrap fails the probe with its own error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codeoid-sbx-fakebwrap-"));
    try {
      const bin = join(dir, "bwrap");
      writeFileSync(bin, "#!/bin/sh\necho 'bwrap: No permissions to creating new namespace' >&2\nexit 1\n", { mode: 0o755 });
      const probe = await new BwrapSandboxProvider({ bwrapPath: bin }).probe();
      expect(probe).toEqual({ available: false, reason: "bubblewrap can't create a sandbox here: bwrap: No permissions to creating new namespace" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("protected ancestors (#448 review)", () => {
  test("every dir strictly between a writable root and an existing hidden path in it", () => {
    const exists = (p: string) => p !== "/home/u/.gone";
    expect(protectedAncestors(["/home/u/.config/gh", "/home/u/.ssh", "/home/u/.gone", "/srv/other"], ["/home/u"], exists).sort()).toEqual(["/home/u/.config"]);
    expect(protectedAncestors(["/w/a/b/c/.env"], ["/w"], () => true).sort()).toEqual(["/w/a", "/w/a/b", "/w/a/b/c"]);
    expect(protectedAncestors(["/w"], ["/w"], () => true)).toEqual([]);
    // A hidden dir (the home in a workspace of /home) is never pinned, nor one inside it: a pin would show it again.
    expect(protectedAncestors(["/w/home", "/w/home/.config/gh"], ["/w"], () => true)).toEqual([]);
    expect(protectedAncestors(["/w/a/secret", "/w/a"], ["/w"], () => true)).toEqual([]);
  });

  test("bwrap: they are writable self-bind mount points (no rename, still writable inside: #448 round 1), laid between the workspace and the hidden path; the temp dir's own-path bind isn't covered by a hidden dir above it", () => {
    const fsKinds: Record<string, PathKind> = { "/home/u": "dir", "/home/u/.config": "dir", "/home/u/.config/gh": "dir", "/var/tmp/d": "dir", "/var/tmp/d/codeoid-sandbox-x/tmp-s": "dir" };
    const m = mounts(
      bwrapArgs(spec({ workspace: "/home/u", tempDir: "/var/tmp/d/codeoid-sandbox-x/tmp-s", hidden: ["/home/u/.config/gh", "/var/tmp/d"], pinned: ["/home/u/.config"] }), "", (p) => fsKinds[p] ?? null),
    );
    const at = (op: string[]) => m.findIndex((x) => x.join(" ") === op.join(" "));
    expect(m).not.toContainEqual(["--ro-bind", "/home/u/.config", "/home/u/.config"]);
    expect(at(["--bind", "/home/u", "/home/u"])).toBeLessThan(at(["--bind", "/home/u/.config", "/home/u/.config"]));
    expect(at(["--bind", "/home/u/.config", "/home/u/.config"])).toBeLessThan(at(["--tmpfs", "/home/u/.config/gh"]));
    expect(at(["--tmpfs", "/var/tmp/d"])).toBeLessThan(at(["--bind", "/var/tmp/d/codeoid-sandbox-x/tmp-s", "/var/tmp/d/codeoid-sandbox-x/tmp-s"]));
    // No cwd: a launcher starts where its caller is.
    expect(m.some((x) => x[0] === "--chdir")).toBe(false);
  });
});
