/**
 * bubblewrap (Linux): a program runs in its own mount, pid, ipc and uts
 * namespaces (and network, when the network is off), seeing the host
 * read-only, with codeoid's policy laid over it:
 *
 *   --ro-bind / /            everything read-only
 *   --dev /dev, --proc /proc a minimal /dev, and a /proc of the sandbox's own processes only
 *   --bind <temp> /tmp       a private /tmp (the host's, with other sessions' files and sockets, isn't there);
 *                            --tmpfs /tmp for a spec whose temp is per program (privateTemp)
 *   --tmpfs <home>           the home hidden whole, then (read-only) the allowlist and the workspace in it shown again
 *   --bind <workspace>       the workspace writable (and any other writable location)
 *   --tmpfs <dir>            a hidden directory: empty, then read-only again (--remount-ro)
 *   --ro-bind /dev/null <f>  a hidden file or socket: empty, and nothing to connect to
 *   --ro-bind <p> <p>        read-only inside something writable (what of a repository decides its config,
 *                            hooks and git dir; the project settings agent CLIs run code from)
 *   --bind <d> <d>           a pinned directory: a mount point, so it can't be renamed, still writable inside
 *   --ro-bind <s> <s>        a container runtime socket the owner let in (spec.dockerSockets; off by default):
 *                            connecting needs no write to the mount, and it can't be removed or replaced
 *   --setenv                 the toolchains' caches in the sandbox's cache dir (spec.env)
 *   --unshare-net            network off
 *   --die-with-parent, --new-session; bwrap always sets no_new_privs
 *
 * Mounts are laid shallowest first, so a workspace inside a hidden directory
 * is bound back into it, and a hidden directory inside the workspace is
 * hidden again on top of it. A host allowlist can't be enforced here (no
 * proxy): it is reported, and the network is off instead of on.
 */

import { lstatSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { LocalSandboxHandle } from "./local-handle.js";
import type { NetworkMode, SandboxCapabilities, SandboxHandle, SandboxProbe, SandboxProvider, SandboxSpawnOptions, SandboxSpec } from "./types.js";

export const BWRAP_PROVIDER_ID = "bwrap";

/** What is at a path: a directory, anything else that exists, or nothing. */
export type PathKind = "dir" | "other" | null;

export function pathKind(p: string): PathKind {
  try {
    const st = lstatSync(p);
    if (st.isSymbolicLink()) {
      // Mounted where it leads: bwrap resolves the destination.
      const real = realpathSync(p);
      return lstatSync(real).isDirectory() ? "dir" : "other";
    }
    return st.isDirectory() ? "dir" : "other";
  } catch {
    return null;
  }
}

/** The real path when it exists, else the path. */
function realOr(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function depth(p: string): number {
  return p.split("/").filter(Boolean).length;
}

function within(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith("/") ? parent : `${parent}/`);
}

type Mount =
  | { kind: "hide-dir"; path: string }
  | { kind: "hide-file"; path: string }
  | { kind: "bind"; src: string; path: string }
  | { kind: "ro-bind"; src: string; path: string };

/** The network bwrap gives a spec's policy: on, or off (an allowlist can't be enforced, so it is off). */
export function bwrapNetwork(mode: NetworkMode): "on" | "off" {
  return mode === "on" ? "on" : "off";
}

/**
 * bwrap's arguments (everything before the program) for `spec`, the program
 * starting in `cwd` (empty: wherever it is started from). Pure but for
 * `kind` (what exists at a path), which tests replace.
 */
export function bwrapArgs(spec: SandboxSpec, cwd: string, kind: (p: string) => PathKind = pathKind): string[] {
  const args = ["--die-with-parent", "--new-session", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--unshare-cgroup-try"];
  if (bwrapNetwork(spec.network.mode) === "off") args.push("--unshare-net");
  args.push("--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc");

  const mounts: Mount[] = [];
  const seen = new Set<string>();
  const writable = [spec.workspace, ...spec.writable].map(realOr);
  const shownInTmp = [...writable, ...spec.reexposed.flatMap((r) => [resolve(r), realOr(r)]).filter((r) => r !== "/tmp")];
  const hide = (p: string) => {
    const at = realOr(p);
    const k = kind(at);
    if (!k || seen.has(`h:${at}`)) return;
    // The sandbox's own /dev and /proc are new, and so is its /tmp: the
    // host's is reachable only where a writable location, or one shown
    // again (a worktree location of a repository in /tmp), is bound into it.
    if (at === "/" || within(at, "/proc") || within(at, "/dev")) return;
    if (within(at, "/tmp") && !shownInTmp.some((w) => within(at, w))) return;
    seen.add(`h:${at}`);
    mounts.push(k === "dir" ? { kind: "hide-dir", path: at } : { kind: "hide-file", path: at });
  };
  for (const p of spec.hidden) hide(p);
  for (const p of [...spec.containerSockets, ...(spec.serviceSockets ?? [])]) hide(p);
  const hiddenDirs = mounts.filter((m) => m.kind === "hide-dir").map((m) => m.path);
  for (const at of writable) {
    if (!kind(at) || seen.has(`w:${at}`)) continue;
    seen.add(`w:${at}`);
    mounts.push({ kind: "bind", src: at, path: at });
  }
  // The session's temp dir at its own path too, when that is outside the
  // host's /tmp: a program that finds where its /tmp really is (codex's own
  // sandbox does) can write there. In the sorted list, so a hidden dir above
  // it (the daemon's temp dir) doesn't cover it.
  const temp = realOr(spec.tempDir);
  if (!spec.privateTemp && !within(temp, "/tmp") && kind(temp) && !seen.has(`w:${temp}`)) {
    seen.add(`w:${temp}`);
    mounts.push({ kind: "bind", src: temp, path: temp });
  }
  // Read-only inside something writable (a repository's hooks and config), with everything in it.
  for (const p of spec.readOnly ?? []) {
    const at = realOr(p);
    if (!kind(at) || seen.has(`o:${at}`)) continue;
    seen.add(`o:${at}`);
    mounts.push({ kind: "ro-bind", src: at, path: at });
  }
  // Every dir between a writable root and a hidden path in it: a mount point nothing can rename, still writable inside.
  for (const p of spec.pinned ?? []) {
    const at = realOr(p);
    // Never one a hidden dir covers (or is): its bind would show the real dir again.
    if (kind(at) !== "dir" || seen.has(`o:${at}`) || hiddenDirs.some((d) => within(at, d))) continue;
    seen.add(`o:${at}`);
    mounts.push({ kind: "bind", src: at, path: at });
  }
  // Container runtime sockets the owner let in (spec.dockerSockets): each bound at its own path, over a hidden dir holding it.
  for (const p of spec.dockerSockets ?? []) {
    const at = realOr(p);
    if (kind(at) !== "other" || seen.has(`d:${at}`)) continue;
    seen.add(`d:${at}`);
    // Read-only: connecting to a socket needs no write to its mount, and it can't be removed or replaced.
    mounts.push({ kind: "ro-bind", src: at, path: at });
  }
  const coveredAt = (at: string) => hiddenDirs.some((d) => within(at, d) && d !== at) || (within(at, "/tmp") && at !== "/tmp" && !writable.some((w) => within(at, w)));
  for (const p of spec.reexposed) {
    const at = realOr(p);
    // Only what a hidden directory, or the sandbox's own /tmp, covers needs showing again.
    if (!kind(at) || seen.has(`r:${at}`)) continue;
    if (coveredAt(at)) {
      seen.add(`r:${at}`);
      mounts.push({ kind: "ro-bind", src: at, path: at });
    }
    // A link (`~/.gitconfig` into a dotfiles repository): what it leads to, at its own path too.
    const literal = resolve(p);
    if (literal !== at && coveredAt(literal) && !seen.has(`r:${literal}`)) {
      seen.add(`r:${literal}`);
      mounts.push({ kind: "ro-bind", src: at, path: literal });
    }
  }
  // Shallowest first; at the same depth, hide before showing.
  const rank = (m: Mount) => (m.kind === "hide-dir" || m.kind === "hide-file" ? 0 : 1);
  mounts.sort((a, b) => depth(a.path) - depth(b.path) || rank(a) - rank(b));

  // The private /tmp first: a workspace below the host's /tmp is bound into it. A
  // private-temp spec's is a tmpfs of this sandbox's own, gone when it exits.
  if (spec.privateTemp) args.push("--tmpfs", "/tmp");
  else args.push("--bind", temp, "/tmp");
  for (const m of mounts) {
    if (m.kind === "hide-dir") args.push("--tmpfs", m.path);
    else if (m.kind === "hide-file") args.push("--ro-bind", "/dev/null", m.path);
    else if (m.kind === "bind") args.push("--bind", m.src, m.path);
    else args.push("--ro-bind", m.src, m.path);
  }
  // A hidden directory's tmpfs is read-only like the rest (its mount points are made by now),
  // unless something writable was bound over it at the same path (then that is what is there).
  const boundAt = new Set(mounts.filter((m) => m.kind === "bind").map((m) => m.path));
  for (const m of mounts) if (m.kind === "hide-dir" && !boundAt.has(m.path)) args.push("--remount-ro", m.path);
  for (const name of spec.unsetEnv) args.push("--unsetenv", name);
  for (const [k, v] of Object.entries(spec.env ?? {})) args.push("--setenv", k, v);
  args.push("--setenv", "TMPDIR", "/tmp");
  // No cwd: the caller's own (a launcher run from wherever its caller is; bwrap keeps it).
  if (cwd) args.push("--chdir", cwd);
  return args;
}

export interface BwrapProviderOptions {
  /** The bwrap binary; default: `bwrap` on PATH. */
  bwrapPath?: string;
}

export class BwrapSandboxProvider implements SandboxProvider {
  readonly id = BWRAP_PROVIDER_ID;
  readonly displayName = "bubblewrap";
  readonly capabilities: SandboxCapabilities = {
    isolation: "os",
    placement: "local",
    workspace: "mount",
    stdioProcess: true,
    commands: true,
    wrapsArgv: true,
    network: ["on", "off"],
    platforms: ["linux"],
  };
  readonly #configured: string | undefined;

  constructor(opts: BwrapProviderOptions = {}) {
    this.#configured = opts.bwrapPath;
  }

  /** The binary used, or null when there is none. */
  binary(): string | null {
    if (this.#configured) return this.#configured;
    return Bun.which("bwrap") ?? null;
  }

  async probe(): Promise<SandboxProbe> {
    if (process.platform !== "linux") return { available: false, reason: "bubblewrap runs on Linux only" };
    const bin = this.binary();
    if (!bin) return { available: false, reason: "bubblewrap (bwrap) is not installed — install the `bubblewrap` package" };
    // The real thing, as a session would run it: user and pid namespaces, a
    // new /proc, no network. Kernels that forbid unprivileged user namespaces
    // (an AppArmor restriction, a container) fail here.
    const argv = [bin, "--die-with-parent", "--unshare-pid", "--unshare-net", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp", "--", "/bin/sh", "-c", "exit 0"];
    try {
      const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "pipe", timeout: 10_000 });
      const [code, err] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
      if (code === 0) return { available: true, detail: bin };
      return { available: false, reason: `bubblewrap can't create a sandbox here: ${err.trim().split("\n").at(-1) || `exit ${code}`}` };
    } catch (err) {
      return { available: false, reason: `bubblewrap failed to start: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  async open(spec: SandboxSpec): Promise<SandboxHandle> {
    return this.openSync(spec);
  }

  openSync(spec: SandboxSpec): SandboxHandle {
    const bin = this.binary();
    if (!bin) throw new Error("bubblewrap (bwrap) is not installed");
    return new LocalSandboxHandle(this.id, spec, (argv: readonly string[], opts: SandboxSpawnOptions) => ({
      argv: [bin, ...bwrapArgs(spec, opts.cwd), "--", ...argv],
      env: opts.env,
    }));
  }
}

/** Where a session's private temp dirs are made (under the daemon's temp dir). */
export function sandboxTempRoot(tmp: string): string {
  return join(tmp, "codeoid-sandbox");
}
