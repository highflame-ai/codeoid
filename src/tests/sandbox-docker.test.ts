/**
 * The Docker provider (#448). Its `docker run` arguments are built and
 * checked here without a Docker daemon. The real-container checks run only
 * with CODEOID_TEST_DOCKER=1 (and a reachable daemon): everything they run
 * runs in a container, against files this test planted in its own dir.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { CWD_FROM_CALLER, DockerSandboxProvider, type DockerPathKind, dockerNetwork, dockerRunArgs } from "../daemon/sandbox/docker.js";
import { launcherScript } from "../daemon/sandbox/session-sandbox.js";
import type { SandboxSpec } from "../daemon/sandbox/types.js";

function spec(over: Partial<SandboxSpec> = {}): SandboxSpec {
  return {
    sessionId: "sess-1",
    workspace: "/work/repo",
    tempDir: "/tmp/codeoid-sandbox-sess-1",
    writable: [],
    hidden: ["/home/u/.ssh", "/work/repo/.secrets", "/work/repo/.env"],
    reexposed: [],
    containerSockets: ["/run/docker.sock"],
    network: { mode: "on" },
    unsetEnv: ["SSH_AUTH_SOCK"],
    ...over,
  };
}
const kinds: Record<string, DockerPathKind> = { "/work/repo/.secrets": "dir", "/work/repo/.env": "other", "/home/u/.pi/agent": "dir", "/opt/node/bin": "dir", "/home/u/.ssh": "dir", "/run/docker.sock": "other" };
const base = { image: "node:22-bookworm-slim", name: "codeoid-sess-1-ab", cwd: "/work/repo/sub", envNames: ["PATH", "OPENAI_API_KEY", "SSH_AUTH_SOCK", "DOCKER_HOST"], uid: 1000, gid: 1000, kind: (p: string) => kinds[p] ?? null };

/** One CSV line as Go's encoding/csv reads it (what Docker's --mount parser uses). */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i <= line.length) {
    let field = "";
    if (line[i] === '"') {
      i++;
      for (;;) {
        const q = line.indexOf('"', i);
        if (q < 0) throw new Error("unterminated");
        field += line.slice(i, q);
        if (line[q + 1] === '"') {
          field += '"';
          i = q + 2;
        } else {
          i = q + 1;
          break;
        }
      }
    } else {
      const c = line.indexOf(",", i);
      field = line.slice(i, c < 0 ? line.length : c);
      i = c < 0 ? line.length : c;
    }
    out.push(field);
    if (line[i] !== ",") break;
    i++;
  }
  return out;
}

/** Pairs of [flag, value] as they follow each other. */
function flags(args: string[], flag: string): string[] {
  const out: string[] = [];
  args.forEach((a, i) => {
    if (a === flag) out.push(args[i + 1] ?? "");
  });
  return out;
}

describe("dockerRunArgs", () => {
  test("a fresh container, removed after, no capabilities, no new privileges, as the user, labelled for the session", () => {
    const args = dockerRunArgs(spec(), ["sh", "-c", "true"], base);
    expect(args.slice(0, 4)).toEqual(["run", "--rm", "-i", "--init"]);
    expect(flags(args, "--name")).toEqual(["codeoid-sess-1-ab"]);
    expect(flags(args, "--label")).toEqual(["codeoid.session=sess-1"]);
    expect(flags(dockerRunArgs(spec(), ["x"], { ...base, handle: "h1" }), "--label")).toEqual(["codeoid.session=sess-1", "codeoid.handle=h1"]);
    expect(flags(args, "--user")).toEqual(["1000:1000"]);
    expect(flags(args, "--cap-drop")).toEqual(["ALL"]);
    expect(flags(args, "--security-opt")).toEqual(["no-new-privileges"]);
    expect(args.slice(-4)).toEqual(["node:22-bookworm-slim", "sh", "-c", "true"]);
  });

  test("only the workspace, the session's /tmp and what the backend needs are mounted; a hidden path inside one is covered again", () => {
    const args = dockerRunArgs(spec({ writable: ["/home/u/.pi/agent"], reexposed: ["/opt/node/bin", "/work/repo/node_modules"] }), ["x"], base);
    expect(flags(args, "-v")).toEqual([]);
    expect(flags(args, "--mount")).toEqual([
      "type=bind,source=/work/repo,target=/work/repo",
      "type=bind,source=/tmp/codeoid-sandbox-sess-1,target=/tmp",
      "type=bind,source=/home/u/.pi/agent,target=/home/u/.pi/agent",
      "type=bind,source=/opt/node/bin,target=/opt/node/bin,readonly",
      "type=tmpfs,destination=/work/repo/.secrets,readonly",
      "type=bind,source=/dev/null,target=/work/repo/.env,readonly",
    ]);
    // ~/.ssh and the Docker socket aren't mounted at all: nothing to hide.
    expect(args.join(" ")).not.toContain(".ssh");
    expect(args.join(" ")).not.toContain("docker.sock");
  });

  test("a dir between the workspace and a hidden path in it is pinned: mounted on itself (no rename), writable (#448 round 1); a repository's hooks are mounted read-only", () => {
    const k = (p: string) => (p === "/work/repo/config" || p === "/work/repo/.git/hooks" ? "dir" : (kinds[p] ?? null));
    const args = dockerRunArgs(spec({ pinned: ["/work/repo/config"], readOnly: ["/work/repo/.git/hooks"] }), ["x"], { ...base, kind: k });
    expect(flags(args, "--mount")).toContain("type=bind,source=/work/repo/config,target=/work/repo/config");
    expect(flags(args, "--mount")).not.toContain("type=bind,source=/work/repo/config,target=/work/repo/config,readonly");
    expect(flags(args, "--mount")).toContain("type=bind,source=/work/repo/.git/hooks,target=/work/repo/.git/hooks,readonly");
    // A pinned dir a hidden one covers isn't mounted: that would show the real dir again.
    const hiddenPin = dockerRunArgs(spec({ hidden: ["/work/repo/.secrets"], pinned: ["/work/repo/.secrets/inner"] }), ["x"], { ...base, kind: () => "dir" });
    expect(flags(hiddenPin, "--mount").some((m) => m.includes("/work/repo/.secrets/inner"))).toBe(false);
  });

  test("a path with `:`, `,` or `\"` is one path: every --mount field is CSV-quoted (#448 round 1)", () => {
    const args = dockerRunArgs(spec({ workspace: '/home/u/proj:v2,"x"', hidden: [] }), ["x"], { ...base, kind: () => "dir" });
    expect(flags(args, "--mount")[0]).toBe('type=bind,"source=/home/u/proj:v2,""x""","target=/home/u/proj:v2,""x"""');
    // Docker's own reader (encoding/csv): the quoted fields come back whole.
    const fields = parseCsvLine(flags(args, "--mount")[0] ?? "");
    expect(fields).toEqual(["type=bind", 'source=/home/u/proj:v2,"x"', 'target=/home/u/proj:v2,"x"']);
  });

  test("a launcher names no container (it may run many at once); each handle labels its own containers (#448 round 1)", async () => {
    const h = await new DockerSandboxProvider({ image: "img", docker: "/usr/bin/docker" }).open(spec());
    const launcher = h.wrap?.(["sh"], { cwd: "", env: {} }).argv ?? [];
    expect(flags(launcher, "--name")).toEqual([]);
    const direct = h.wrap?.(["sh"], { cwd: "/work/repo", env: {} }).argv ?? [];
    expect(flags(direct, "--name")).toHaveLength(1);
    const handleLabel = flags(direct, "--label").find((l) => l.startsWith("codeoid.handle="));
    expect(handleLabel).toBeDefined();
    expect(flags(launcher, "--label")).toContain(handleLabel ?? "");
    const other = await new DockerSandboxProvider({ image: "img", docker: "/usr/bin/docker" }).open(spec());
    expect(flags(other.wrap?.(["sh"], { cwd: "", env: {} }).argv ?? [], "--label")).not.toContain(handleLabel ?? "");
  });

  test("network: on is the bridge, off and an allowlist (Docker can't hold one) are none", () => {
    expect(flags(dockerRunArgs(spec(), ["x"], base), "--network")).toEqual(["bridge"]);
    expect(dockerNetwork("off")).toBe("none");
    expect(dockerNetwork("allowlist")).toBe("none");
  });

  test("variables by name only, never the docker client's own or an agent socket; the cwd, or the caller's for a launcher", () => {
    const args = dockerRunArgs(spec(), ["x"], base);
    expect(flags(args, "-e")).toEqual(["OPENAI_API_KEY", "TMPDIR=/tmp", `HOME=${homedir()}`]);
    // The toolchains' caches (#448 round 2), by value: they are the sandbox's, not the client's.
    expect(flags(dockerRunArgs(spec({ env: { GOCACHE: "/c/go-build" } }), ["x"], base), "-e")).toContain("GOCACHE=/c/go-build");
    expect(flags(args, "-w")).toEqual(["/work/repo/sub"]);
    const launcher = dockerRunArgs(spec(), ["x"], { ...base, cwd: "" });
    expect(flags(launcher, "-w")).toEqual([CWD_FROM_CALLER]);
    expect(launcherScript(["docker", "-w", CWD_FROM_CALLER, "img"])).toContain(`exec 'docker' '-w' "$PWD" 'img' "$@"`);
  });

  test("gVisor: --runtime runsc, and the provider says kernel isolation", () => {
    expect(flags(dockerRunArgs(spec(), ["x"], { ...base, runtime: "runsc" }), "--runtime")).toEqual(["runsc"]);
    expect(new DockerSandboxProvider({ image: "x", runtime: "runsc" }).capabilities.isolation).toBe("kernel");
    expect(new DockerSandboxProvider({ image: "x" }).capabilities).toMatchObject({ isolation: "os", placement: "local", stdioProcess: true, network: ["on", "off"] });
  });

  test("the provider wraps an argv through the docker client, keeping the client's own settings for it", async () => {
    const h = await new DockerSandboxProvider({ image: "img", docker: "/usr/bin/docker" }).open(spec());
    const w = h.wrap?.(["/bin/sh", "-c", "true"], { cwd: "/work/repo", env: { A: "1" } });
    expect(w?.argv[0]).toBe("/usr/bin/docker");
    expect(w?.argv[1]).toBe("run");
    expect(w?.argv.slice(-4)).toEqual(["img", "/bin/sh", "-c", "true"]);
    expect(w?.env.A).toBe("1");
  });

  test("a missing client is a probe failure, with the reason", async () => {
    const p = await new DockerSandboxProvider({ image: "img", docker: join(tmpdir(), "no-such-docker") }).probe();
    expect(p.available).toBe(false);
  });
});

const REAL = process.env.CODEOID_TEST_DOCKER === "1";
const provider = new DockerSandboxProvider({ image: process.env.CODEOID_TEST_DOCKER_IMAGE ?? "node:22-bookworm-slim" });
const probe = REAL ? await provider.probe() : { available: false as const, reason: "CODEOID_TEST_DOCKER isn't 1" };

describe.skipIf(!probe.available)("Docker, for real (CODEOID_TEST_DOCKER=1)", () => {
  let root: string;
  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(process.env.CODEOID_TEST_SANDBOX_DIR ?? join(homedir(), ".cache"), "codeoid-sbx-docker-")));
    for (const d of ["ws", "tmp", "secrets", "outside-target"]) mkdirSync(join(root, d), { recursive: true });
    writeFileSync(join(root, "secrets", "token"), "PLANTED\n");
    writeFileSync(join(root, "outside-target", "keep.txt"), "keep\n");
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const make = (network: "on" | "off" = "off"): SandboxSpec => ({
    sessionId: "docker-real",
    workspace: join(root, "ws"),
    tempDir: join(root, "tmp"),
    writable: [],
    hidden: [join(root, "secrets")],
    reexposed: [],
    containerSockets: ["/var/run/docker.sock", "/run/docker.sock"],
    network: { mode: network },
    unsetEnv: [],
  });

  test("hidden is absent, outside the workspace is absent (so rm -rf of it touches nothing real), the workspace and /tmp are writable, no Docker socket", async () => {
    const h = await provider.open(make());
    try {
      const r = await h.exec(
        ["sh", "-c", `cat ${join(root, "secrets", "token")} 2>&1; rm -rf ${join(root, "outside-target")}; echo hi > ${join(root, "ws", "made.txt")} && echo WROTE; echo t > /tmp/t && echo TMP; test -S /var/run/docker.sock && echo SOCKET; echo done`],
        { cwd: join(root, "ws"), env: {}, timeoutMs: 120_000 },
      );
      expect(r.stdout).not.toContain("PLANTED");
      expect(r.stdout).toContain("WROTE");
      expect(r.stdout).toContain("TMP");
      expect(r.stdout).not.toContain("SOCKET");
      expect(readFileSync(join(root, "outside-target", "keep.txt"), "utf8")).toBe("keep\n");
      expect(readFileSync(join(root, "ws", "made.txt"), "utf8")).toBe("hi\n");
      expect(existsSync(join(root, "tmp", "t"))).toBe(true);
    } finally {
      await h.close();
    }
  }, 180_000);

  test("network off: nothing is reachable", async () => {
    const h = await provider.open(make("off"));
    try {
      const r = await h.exec(["node", "-e", "require('dns').lookup('example.com', (e) => { console.log(e ? 'NO-NET' : 'NET'); })"], { cwd: join(root, "ws"), env: {}, timeoutMs: 120_000 });
      expect(r.stdout).toContain("NO-NET");
    } finally {
      await h.close();
    }
  }, 180_000);
});
