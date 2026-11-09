/**
 * Seatbelt (macOS `sandbox-exec`): a program runs under an SBPL profile.
 * The profile allows everything by default and then, in order (a later
 * rule wins in SBPL):
 *
 *   - no writes anywhere, then writes to the workspace, the session's temp
 *     dir, the backend's own state, and the devices every program writes
 *     (/dev/null, a tty, /dev/fd);
 *   - per path, shallowest first: hidden ones (the whole home among them)
 *     neither readable nor writable, a workspace, state dir or allowlisted
 *     path inside a hidden one allowed back, a hidden one inside the
 *     workspace hidden again (as bwrap.ts lays its mounts); a repository's
 *     hooks and config not writable; a pinned directory not writable itself
 *     (`literal`: no rename, no removal), what is in it still writable;
 *   - container sockets: not readable, and no connection to them (but
 *     those the owner let in, `spec.dockerSockets`: allowed last);
 *   - network off (and an allowlist, which Seatbelt can't enforce by host):
 *     no network at all.
 *
 * Every path reaches the profile as a `-D` parameter (`(param "P3")`),
 * never spliced into its text, so a path can't change the profile. Paths are
 * real paths (Seatbelt sees `/private/tmp`, not `/tmp`).
 *
 * Not verified on a Mac in this change (docs/sandbox.md lists what to check).
 * Seatbelt doesn't nest: a program already under `sandbox-exec` can't start
 * another (Codex's own sandbox on macOS), and it has no pid namespace: the
 * sandboxed program can see (not signal: same user, though) other processes.
 */

import { realpathSync, statSync } from "node:fs";
import { LocalSandboxHandle } from "./local-handle.js";
import { boundPath } from "./pinned.js";
import type { NetworkMode, SandboxCapabilities, SandboxHandle, SandboxProbe, SandboxProvider, SandboxSpawnOptions, SandboxSpec } from "./types.js";

export const SEATBELT_PROVIDER_ID = "seatbelt";
export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

function depth(p: string): number {
  return p.split("/").filter(Boolean).length;
}

function within(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith("/") ? parent : `${parent}/`);
}

/** The network Seatbelt gives a policy: on, or none (it can't hold a host allowlist). */
export function seatbeltNetwork(mode: NetworkMode): "on" | "off" {
  return mode === "on" ? "on" : "off";
}

export interface SeatbeltProfile {
  /** The SBPL text: only parameter references, no paths. */
  profile: string;
  /** `-D` parameters: name → absolute path. */
  params: Record<string, string>;
}

/**
 * The profile for `spec`. Pure but for `real` (a path's real path; tests
 * replace it). `isDir` tells a directory (a subpath rule) from a file (a
 * literal one); a path that doesn't exist is ruled as both.
 */
export function seatbeltProfile(
  spec: SandboxSpec,
  fs: { real?: (p: string) => string; isDir?: (p: string) => boolean | null } = {},
): SeatbeltProfile {
  // Everything a rule names by path is pinned: named as it was pinned (the handle checked it is still that, and
  // the launched argv checks again; #448 round 14), never resolved again here. Only what isn't is resolved.
  // paths: resolves only what isn't pinned (boundPath): a hidden path, the home's allowlist
  const real = boundPath(spec.pins, fs.real ?? ((p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  }));
  const isDir = fs.isDir ?? (() => null);
  const params: Record<string, string> = {};
  const names = new Map<string, string>();
  const param = (path: string): string => {
    let name = names.get(path);
    if (!name) {
      name = `P${names.size}`;
      names.set(path, name);
      params[name] = path;
    }
    return `(param "${name}")`;
  };
  /** A path as a filter: a directory and everything in it, a file itself, or (unknown) both. */
  const filter = (path: string): string => {
    const d = isDir(path);
    if (d === true) return `(subpath ${param(path)})`;
    if (d === false) return `(literal ${param(path)})`;
    return `(literal ${param(path)}) (subpath ${param(path)})`;
  };

  const writable = [...new Set([spec.workspace, spec.tempDir, ...spec.writable].map(real))];
  type Rule = { path: string; kind: "hide" | "write" | "read" | "read-only" | "pinned" };
  const rules: Rule[] = [];
  const seen = new Set<string>();
  for (const p of [...spec.hidden, ...spec.containerSockets, ...(spec.serviceSockets ?? [])].map(real)) {
    if (p === "/" || seen.has(`h:${p}`)) continue;
    seen.add(`h:${p}`);
    rules.push({ path: p, kind: "hide" });
  }
  const hidden = rules.map((r) => r.path);
  for (const p of writable) rules.push({ path: p, kind: "write" });
  // A writable location besides the workspace and temp dir (a repository's git dir, a backend's home) can't be
  // renamed itself, as a mount point can't under bwrap or Docker: renaming a git dir away would leave its read-only parts behind.
  const own = new Set([real(spec.workspace), real(spec.tempDir)]);
  for (const p of writable) if (!own.has(p)) rules.push({ path: p, kind: "pinned" });
  for (const r of spec.reexposed) {
    // A link is read by its own path and where it leads: both allowed.
    for (const p of new Set([r, real(r)])) {
      if (hidden.some((h) => within(p, h) && h !== p)) rules.push({ path: p, kind: "read" });
    }
  }
  // A repository's hooks and config: not writable, with everything in them.
  for (const p of (spec.readOnly ?? []).map(real)) rules.push({ path: p, kind: "read-only" });
  // Every dir between a writable root and a hidden path in it: the directory itself not writable (so no rename), its contents still.
  for (const p of [...(spec.pinned ?? []), ...(spec.heldInPlace ?? [])].map(real)) rules.push({ path: p, kind: "pinned" });
  const rank = (r: Rule) => (r.kind === "hide" ? 0 : 1);
  rules.sort((a, b) => depth(a.path) - depth(b.path) || rank(a) - rank(b));

  const lines = [
    "(version 1)",
    "(allow default)",
    // Writes only where the session may write.
    "(deny file-write*)",
    '(allow file-write* (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty") (literal "/dev/dtracehelper") (regex #"^/dev/fd/") (regex #"^/dev/ttys[0-9]+$"))',
  ];
  for (const r of rules) {
    if (r.kind === "hide") lines.push(`(deny file-read* file-write* ${filter(r.path)})`);
    else if (r.kind === "write") lines.push(`(allow file-read* file-write* ${filter(r.path)})`);
    else if (r.kind === "read-only") lines.push(`(deny file-write* ${filter(r.path)})`);
    else if (r.kind === "pinned") lines.push(`(deny file-write* (literal ${param(r.path)}))`);
    else lines.push(`(allow file-read* ${filter(r.path)})`);
  }
  // Container runtimes and (the network off) local services: nothing connects to their sockets.
  // (A socket in a container runtime's dir is behind its dir's file rule; connecting needs write access.)
  for (const s of [...spec.containerSockets, ...(spec.serviceSockets ?? [])].map(real)) {
    if (isDir(s) !== true) lines.push(`(deny network-outbound (remote unix-socket (path-literal ${param(s)})))`);
  }
  if (seatbeltNetwork(spec.network.mode) === "off") lines.push("(deny network*)");
  // Container runtime sockets the owner let in (spec.dockerSockets), last, so they win over the rules above: the file
  // (by its own path and where it leads: Docker Desktop's `/var/run/docker.sock` links into the home), read and
  // written as a socket is, never removed or replaced, and a connection to it, the network off or not.
  for (const s of spec.dockerSockets ?? []) {
    for (const p of new Set([s, real(s)])) {
      lines.push(`(allow file-read* file-write-data (literal ${param(p)}))`);
      lines.push(`(allow network-outbound (remote unix-socket (path-literal ${param(p)})))`);
    }
  }
  return { profile: `${lines.join("\n")}\n`, params };
}

/** `sandbox-exec`'s arguments (everything before the program) for `spec`. */
export function seatbeltArgs(spec: SandboxSpec, fs?: Parameters<typeof seatbeltProfile>[1]): string[] {
  const { profile, params } = seatbeltProfile(spec, fs);
  const args = ["-p", profile];
  for (const [k, v] of Object.entries(params)) args.push("-D", `${k}=${v}`);
  return args;
}

/**
 * What runs before `sandbox-exec`: `env` removing the spec's unset names,
 * setting its variables (the toolchains' caches) and pointing TMPDIR at the
 * session's temp dir. In the argv, not the spawn's
 * environment, so a launcher (which has only an argv) does it too.
 */
export function seatbeltEnvPrefix(spec: SandboxSpec): string[] {
  return ["/usr/bin/env", ...spec.unsetEnv.flatMap((n) => ["-u", n]), ...Object.entries(spec.env ?? {}).map(([k, v]) => `${k}=${v}`), `TMPDIR=${spec.tempDir}`];
}

/**
 * In a privateTemp spec's argv (#448 round 5), the per-program temp dir:
 * {@link PRIVATE_TEMP_SCRIPT} puts the dir it made where a word of the
 * prefix ends with this (the profile's parameter for it, `TMPDIR=`).
 */
export const PRIVATE_TEMP_WORD = "@codeoid-private-temp@";

/**
 * sh, run as `sh -c <this> codeoid-temp <parent> <k> <argv…>`: a fresh dir
 * in `<parent>` (the only part of it the profile lets the program write),
 * named in the first `<k>` words where they end with {@link PRIVATE_TEMP_WORD},
 * the program run, the dir removed when it exits (or the wrapper is
 * signalled), its exit status the program's. Seatbelt has no mount
 * namespace, so this is how a program gets a temp dir nothing else shares
 * and nothing outlives.
 */
export const PRIVATE_TEMP_SCRIPT = [
  'd=$(mktemp -d "$1/t.XXXXXX") || exit 125',
  'trap \'rm -rf "$d"; exit 129\' HUP',
  'trap \'rm -rf "$d"; exit 130\' INT',
  'trap \'rm -rf "$d"; exit 143\' TERM',
  'k=$2',
  "shift 2",
  "n=$#",
  'while [ "$n" -gt 0 ]; do',
  "  a=$1",
  "  shift",
  "  n=$((n - 1))",
  `  if [ "$k" -gt 0 ]; then k=$((k - 1)); case "$a" in *${PRIVATE_TEMP_WORD}) a="\${a%${PRIVATE_TEMP_WORD}}$d" ;; esac; fi`,
  '  set -- "$@" "$a"',
  "done",
  '"$@"',
  "r=$?",
  'rm -rf "$d"',
  'exit "$r"',
].join("\n");

export class SeatbeltSandboxProvider implements SandboxProvider {
  readonly id = SEATBELT_PROVIDER_ID;
  readonly displayName = "Seatbelt (macOS)";
  readonly capabilities: SandboxCapabilities = {
    isolation: "os",
    placement: "local",
    workspace: "mount",
    stdioProcess: true,
    commands: true,
    wrapsArgv: true,
    network: ["on", "off"],
    platforms: ["darwin"],
  };
  readonly #bin: string;

  constructor(opts: { sandboxExec?: string } = {}) {
    this.#bin = opts.sandboxExec ?? SANDBOX_EXEC;
  }

  async probe(): Promise<SandboxProbe> {
    if (process.platform !== "darwin") return { available: false, reason: "Seatbelt runs on macOS only" };
    try {
      // paths: the probe: a fixed argv, in no session's directory
      const proc = Bun.spawn([this.#bin, "-p", "(version 1)(allow default)", "/usr/bin/true"], { stdin: "ignore", stdout: "ignore", stderr: "pipe", timeout: 10_000 });
      const [code, err] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
      if (code === 0) return { available: true, detail: this.#bin };
      return { available: false, reason: `sandbox-exec can't apply a profile here${err.trim() ? `: ${err.trim().split("\n").at(-1)}` : ""} (already inside a sandbox?)` };
    } catch (err) {
      return { available: false, reason: `sandbox-exec failed to start: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  async open(spec: SandboxSpec): Promise<SandboxHandle> {
    return this.openSync(spec);
  }

  openSync(spec: SandboxSpec): SandboxHandle {
    const bin = this.#bin;
    // paths: a look (directory or file) for a rule's form, once the handle checked the pins
    const isDir = (p: string): boolean | null => {
      try {
        return statSync(p).isDirectory();
      } catch {
        return null;
      }
    };
    // The cwd is the spawn's (sandbox-exec keeps it): a launcher runs where its caller is.
    if (spec.privateTemp) {
      // The temp dir is made per program, in the spec's (a real path: Seatbelt sees `/private/…`).
      let parent = spec.tempDir;
      // paths: the session's temp dir: made by the daemon in its private dir, which no sandbox sees
      try {
        parent = realpathSync(parent);
      } catch {
        /* made later: as given */
      }
      const inner: SandboxSpec = { ...spec, tempDir: PRIVATE_TEMP_WORD };
      const prefix = [...seatbeltEnvPrefix(inner), bin, ...seatbeltArgs(inner, { isDir })];
      return new LocalSandboxHandle(this.id, spec, (argv: readonly string[], opts: SandboxSpawnOptions) => ({
        argv: ["/bin/sh", "-c", PRIVATE_TEMP_SCRIPT, "codeoid-temp", parent, String(prefix.length), ...prefix, ...argv],
        env: opts.env,
      }));
    }
    return new LocalSandboxHandle(this.id, spec, (argv: readonly string[], opts: SandboxSpawnOptions) => ({
      argv: [...seatbeltEnvPrefix(spec), bin, ...seatbeltArgs(spec, { isDir }), ...argv],
      env: opts.env,
    }));
  }
}
