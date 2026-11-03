/**
 * Docker (local containers, Linux and macOS): a program runs in a fresh
 * container of `sandbox.docker.image`. Only what the spec lets in is
 * mounted, so everything else on the host — credentials, other repos, the
 * container runtime's own socket — simply isn't there:
 *
 *   docker run --rm -i --init --name codeoid-<session>-<n> --label codeoid.session=<session>
 *     --user <uid>:<gid> --cap-drop ALL --security-opt no-new-privileges --pids-limit 4096
 *     --network none | bridge            off (and an allowlist it can't hold) | on
 *     -v <workspace>:<workspace>          writable, at the same path
 *     -v <temp>:/tmp                      the session's temp dir
 *     -v <state>:<state>                  the backend's own state, when its whole process is inside
 *     -v <program>:<program>:ro           the backend's own program (it must run on the image)
 *     --mount type=tmpfs,…  /  -v /dev/null:<file>:ro   a hidden path inside something mounted
 *     -w <cwd> -e NAME …                  values copied from the docker client's environment
 *     <image> <argv…>
 *
 * The container runtime's socket is never mounted, and `DOCKER_HOST` is the
 * docker client's only, never the container's. With `--runtime runsc`
 * (gVisor) the isolation is a separate kernel.
 *
 * Not verified against a Docker daemon in this change (the integration tests
 * are behind CODEOID_TEST_DOCKER=1).
 */

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { LocalSandboxHandle } from "./local-handle.js";
import type { NetworkMode, SandboxCapabilities, SandboxHandle, SandboxProbe, SandboxProvider, SandboxSpawnOptions, SandboxSpec } from "./types.js";

export const DOCKER_PROVIDER_ID = "docker";
/** A launcher's word for "the directory it is started from" (launcherScript writes it as "$PWD"). */
export const CWD_FROM_CALLER = "\u0000PWD";

/** The docker client's own settings: kept for it, never handed into the container. */
const CLIENT_ENV = ["DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "DOCKER_CERT_PATH", "DOCKER_TLS_VERIFY", "PATH", "HOME"];

export function dockerNetwork(mode: NetworkMode): "bridge" | "none" {
  return mode === "on" ? "bridge" : "none";
}

function within(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith("/") ? parent : `${parent}/`);
}

function realOr(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** What exists at a path: a directory, something else, nothing. */
export type DockerPathKind = "dir" | "other" | null;

function pathKind(p: string): DockerPathKind {
  try {
    const st = lstatSync(realOr(p));
    return st.isDirectory() ? "dir" : "other";
  } catch {
    return null;
  }
}

export interface DockerRunOptions {
  image: string;
  /** `--runtime` (e.g. `runsc`). */
  runtime?: string;
  /** The container's name (unique). */
  name: string;
  /** Where the program starts; empty: the caller's directory (a launcher). */
  cwd: string;
  /** The names of the variables handed in (values come from the docker client's environment). */
  envNames: readonly string[];
  uid: number;
  gid: number;
  kind?: (p: string) => DockerPathKind;
}

/** `docker run`'s arguments for `argv` under `spec`. Pure but for `kind` (tests replace it). */
export function dockerRunArgs(spec: SandboxSpec, argv: readonly string[], o: DockerRunOptions): string[] {
  const kind = o.kind ?? pathKind;
  const args = [
    "run",
    "--rm",
    "-i",
    "--init",
    "--name",
    o.name,
    "--label",
    `codeoid.session=${spec.sessionId}`,
    "--user",
    `${o.uid}:${o.gid}`,
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    "4096",
    "--network",
    dockerNetwork(spec.network.mode),
    ...(o.runtime ? ["--runtime", o.runtime] : []),
  ];
  const mounted: string[] = [];
  const bind = (src: string, dest: string, ro: boolean) => {
    args.push("-v", `${src}:${dest}${ro ? ":ro" : ""}`);
    mounted.push(dest);
  };
  const workspace = realOr(spec.workspace);
  bind(workspace, workspace, false);
  bind(realOr(spec.tempDir), "/tmp", false);
  for (const w of spec.writable) {
    const at = realOr(w);
    if (kind(at) && !mounted.includes(at)) bind(at, at, false);
  }
  for (const r of spec.reexposed) {
    const at = realOr(r);
    if (kind(at) && !mounted.some((m) => within(at, m))) bind(at, at, true);
  }
  // Every dir between a mounted writable root and a hidden path in it: read-only (Docker mounts parents first).
  for (const p of spec.readOnly ?? []) {
    const at = realOr(p);
    if (kind(at) === "dir" && mounted.some((m) => m !== "/tmp" && within(at, m) && at !== m)) bind(at, at, true);
  }
  // A hidden path inside something mounted is covered again.
  for (const h of [...spec.hidden, ...spec.containerSockets]) {
    const at = realOr(h);
    if (!mounted.some((m) => m !== "/tmp" && within(at, m) && at !== m)) continue;
    const k = kind(at);
    if (k === "dir") args.push("--mount", `type=tmpfs,destination=${at},readonly`);
    else if (k === "other") args.push("-v", `/dev/null:${at}:ro`);
  }
  args.push("-w", o.cwd ? o.cwd : CWD_FROM_CALLER);
  for (const n of o.envNames) if (!spec.unsetEnv.includes(n) && !CLIENT_ENV.includes(n)) args.push("-e", n);
  args.push("-e", "TMPDIR=/tmp", "-e", `HOME=${homedir()}`);
  args.push(o.image, ...argv);
  return args;
}

export interface DockerProviderOptions {
  image: string;
  runtime?: string;
  /** The docker client (default: `docker` on PATH). */
  docker?: string;
}

export class DockerSandboxProvider implements SandboxProvider {
  readonly id = DOCKER_PROVIDER_ID;
  readonly displayName = "Docker";
  readonly capabilities: SandboxCapabilities;
  readonly #opts: DockerProviderOptions;

  constructor(opts: DockerProviderOptions) {
    this.#opts = opts;
    this.capabilities = {
      isolation: opts.runtime === "runsc" ? "kernel" : "os",
      placement: "local",
      workspace: "mount",
      stdioProcess: true,
      commands: true,
      wrapsArgv: true,
      network: ["on", "off"],
      platforms: ["linux", "darwin"],
    };
  }

  #client(): string | null {
    return this.#opts.docker ?? Bun.which("docker") ?? null;
  }

  async probe(): Promise<SandboxProbe> {
    const docker = this.#client();
    if (!docker) return { available: false, reason: "the docker client isn't installed" };
    try {
      const proc = Bun.spawn([docker, "version", "--format", "{{.Server.Version}}"], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 10_000 });
      const [code, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      if (code === 0 && out.trim()) return { available: true, detail: `Docker ${out.trim()}` };
      return { available: false, reason: `the Docker daemon isn't reachable${err.trim() ? `: ${err.trim().split("\n").at(-1)}` : ""}` };
    } catch (err) {
      return { available: false, reason: `docker failed to start: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  async open(spec: SandboxSpec): Promise<SandboxHandle> {
    return this.openSync(spec);
  }

  openSync(spec: SandboxSpec): SandboxHandle {
    const docker = this.#client();
    if (!docker) throw new Error("the docker client isn't installed");
    const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
    const gid = typeof process.getgid === "function" ? process.getgid() : 1000;
    const safe = spec.sessionId.replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 32) || "session";
    const clientEnv: Record<string, string> = {};
    for (const n of CLIENT_ENV) {
      const v = process.env[n];
      if (v) clientEnv[n] = v;
    }
    const wrap = (argv: readonly string[], opts: SandboxSpawnOptions) => ({
      argv: [
        docker,
        ...dockerRunArgs(spec, argv, {
          image: this.#opts.image,
          ...(this.#opts.runtime ? { runtime: this.#opts.runtime } : {}),
          name: `codeoid-${safe}-${randomBytes(4).toString("hex")}`,
          cwd: opts.cwd,
          envNames: Object.keys(opts.env),
          uid,
          gid,
        }),
      ],
      // The program's variables for `-e NAME` to copy, and the docker client's own settings.
      env: { ...opts.env, ...clientEnv },
    });
    // Containers outlive a killed client: remove every one this session started.
    const onClose = () =>
      new Promise<void>((resolve) => {
        execFile(docker, ["ps", "-aq", "--filter", `label=codeoid.session=${spec.sessionId}`], { env: { ...clientEnv } }, (err, out) => {
          const ids = err ? [] : out.split("\n").filter(Boolean);
          if (ids.length === 0) return resolve();
          execFile(docker, ["rm", "-f", ...ids], { env: { ...clientEnv } }, () => resolve());
        });
      });
    return new LocalSandboxHandle(this.id, spec, wrap, onClose);
  }
}
