/**
 * What a shell command does that restoring the workspace's files can't undo
 * (#355, #431): the rewind warning. Read from the parsed command — wrappers,
 * quoting and `bash -c` seen through — not a pattern over its text.
 */
import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, normalize, resolve, sep } from "node:path";
import { parseShellSync, type ShellWord, type SimpleCommand } from "../shell/parse.js";
import { findRoots } from "./shell-risk.js";

/** Git subcommands whose effect lives in git's own state or on a remote. */
const GIT_OUTSIDE = new Set([
  "push", "commit", "tag", "reset", "rebase", "merge", "checkout", "switch", "stash", "cherry-pick", "revert", "pull", "fetch",
  "am", "apply", "notes", "filter-branch", "filter-repo", "update-ref", "gc", "prune", "worktree", "submodule", "remote", "config",
  "branch-delete",
]);
/** Programs whose effects are elsewhere: the network, a cluster, a database, the system. */
const OUTSIDE_PROGRAMS = new Set([
  "gh", "glab", "curl", "wget", "scp", "rsync", "ssh", "sftp", "ftp", "nc", "ncat", "socat", "telnet",
  "docker", "podman", "kubectl", "helm", "terraform", "tofu", "pulumi", "aws", "gcloud", "az", "flyctl", "vercel", "netlify", "heroku",
  "psql", "mysql", "mariadb", "redis-cli", "mongosh", "mongo", "sqlite3",
  "sudo", "doas", "su", "systemctl", "launchctl", "crontab", "at", "kill", "pkill", "killall", "shutdown", "reboot",
  "brew", "apt", "apt-get", "dnf", "yum", "pacman", "snap",
]);
/** Package managers: installing or publishing reaches outside the workspace. */
const PACKAGE_VERBS: Record<string, Set<string>> = {
  npm: new Set(["publish", "install", "i", "add", "unpublish", "link", "ci"]),
  pnpm: new Set(["publish", "install", "i", "add", "link"]),
  yarn: new Set(["publish", "install", "add", "link"]),
  bun: new Set(["publish", "install", "i", "add", "link"]),
  pip: new Set(["install", "uninstall"]),
  pip3: new Set(["install", "uninstall"]),
  uv: new Set(["pip", "add", "tool"]),
  cargo: new Set(["publish", "install"]),
  gem: new Set(["install", "push"]),
  go: new Set(["install"]),
};

export interface EffectContext {
  workdir: string;
  /** The directory the command ran in, absolute; the workdir when absent. */
  cwd?: string;
  home?: string;
}

/**
 * Whether `command` has effects outside the workspace's files. A command that
 * can't be read counts as having them: going back can't promise to undo it.
 */
export function outsideEffects(command: string, ctx: EffectContext): boolean {
  const parsed = parseShellSync(command);
  if (parsed.problems.length > 0) return true;
  const home = ctx.home ?? homedir();
  // Outside the workspace, a relative path's target is as unknown as after a `cd` there.
  const start = ctx.cwd ?? ctx.workdir;
  let cwd: string | null = inside(start, ctx.workdir) ? start : null;
  for (const cmd of parsed.commands) {
    const prog = programOf(cmd);
    if (prog === null) return true;
    if (prog === "cd" || prog === "pushd") {
      const to = cmd.argv[1];
      const dir: string | null = to ? pathOf(to, cwd, home) : home;
      cwd = dir !== null && inside(dir, ctx.workdir) ? dir : null;
      continue;
    }
    if (cmd.via.some((w) => w === "sudo" || w === "doas")) return true;
    // A shell running its input runs something this line doesn't show.
    if (cmd.stdinScript) return true;
    if (OUTSIDE_PROGRAMS.has(prog)) return true;
    const sub = cmd.argv[1]?.value ?? null;
    if (prog === "git" && (sub === null || gitOutside(cmd))) return true;
    // The verb is the first operand: `npm --global install x`.
    const verb = cmd.argv.slice(1).find((w) => w.value === null || !w.value.startsWith("-"))?.value ?? "";
    if (PACKAGE_VERBS[prog]?.has(verb)) return true;
    // `python3 -m pip install x`
    if (/^python[0-9.]*$/.test(prog) && sub === "-m" && /^pip[0-9.]*$/.test(cmd.argv[2]?.value ?? "") && PACKAGE_VERBS.pip!.has(cmd.argv[3]?.value ?? "")) return true;
    // find -delete / -fprint, and sed -i: what they change is under the roots or the files they name.
    const values = cmd.argv.slice(1).map((w) => w.value);
    const findChanges = prog === "find" && values.some((x) => x === "-delete" || x?.startsWith("-fprint") || x === "-fls");
    const sedEdits = prog === "sed" && values.some((x) => x !== null && (/^-[a-zA-Z]*i/.test(x) || x.startsWith("--in-place")));
    if (findChanges || sedEdits) {
      const operands = cmd.argv.slice(1).filter((w) => w.value === null || !/^[-(!]/.test(w.value));
      // find's roots come before its expression; sed's first operand is its script unless -e/-f gives one.
      const named = findChanges ? findRoots(cmd) : operands.slice(values.some((x) => x !== null && /^(-[a-zA-Z]*[ef]|--expression|--file)/.test(x)) ? 0 : 1);
      for (const w of named) {
        const at = pathOf(w, cwd, home);
        if (at === null || !inside(at, ctx.workdir)) return true;
      }
    }
    // Writes and deletes outside the workspace: redirects, and what rm/mv/cp/tee/ln touch.
    for (const r of cmd.redirects) {
      if (!r.target || r.op === "<" || r.op === "<<<" || ((r.op === ">&" || r.op === "<&") && /^\d+$|^-$/.test(r.target.value ?? ""))) continue;
      const at = pathOf(r.target, cwd, home);
      if (at === null || (!inside(at, ctx.workdir) && !at.startsWith("/dev/"))) return true;
    }
    if (["rm", "mv", "cp", "tee", "ln", "install", "rmdir", "mkdir", "touch", "chmod", "chown", "dd", "truncate", "shred"].includes(prog)) {
      for (const w of cmd.argv.slice(1)) {
        if (w.value === null) return true;
        if (w.value.startsWith("-")) {
          if (prog === "dd" && w.value.startsWith("of=") && !targetInside(w.value.slice(3), cwd, ctx.workdir, home)) return true;
          continue;
        }
        if (prog === "dd") continue;
        const at = pathOf(w, cwd, home);
        if (at === null || !inside(at, ctx.workdir)) {
          // A source outside the workspace read by cp is fine; anything else isn't.
          if (prog === "cp" && w !== cmd.argv.at(-1)) continue;
          return true;
        }
      }
    }
  }
  return false;
}

/** Programs whose every operand is a file they change, create or remove. */
const WRITES_EVERY_OPERAND = new Set(["rm", "rmdir", "mkdir", "touch", "chmod", "chown", "chgrp", "truncate", "shred", "tee", "mv", "unlink"]);
/** Programs whose last operand (or `-t DIR`) is what they write: `cp a b`, `install a /usr/bin/a` (`ln` is read on its own). */
const WRITES_LAST_OPERAND = new Set(["cp", "install"]);
/** Files a redirect may name without writing a file: discarding, the terminal, the process's own descriptors. */
const NOT_A_FILE = /^\/dev\/(?:null|zero|tty|stdout|stderr|stdin|fd\/\d+)$/;

/** A file a command line writes, as {@link shellWriteTargets} names it. */
export interface ShellWriteTarget {
  /**
   * Absolute and as written — `..` kept, for the kernel's reading, which
   * goes through a link before its parent — or, where `unplaced` is set,
   * the word as written.
   */
  path: string;
  /** Why the reader can't place it for certain: a `~name`, a relative path where the cwd isn't known, a path the line's own link may redirect. */
  unplaced?: string;
}

/**
 * The files `command` writes, edits, creates, removes or moves that the
 * parse can name: redirects, what `rm`/`mv`/`cp`/`tee`/`touch`/… write, what
 * `ln` links (the link, and what it leads to: writing through it writes
 * that), `dd of=`, `sed -i`'s files, `find -delete`'s roots. Each is
 * absolute, unnormalized (the caller resolves links and `..` as the kernel
 * does). A `cd` is followed only where it surely moves what follows — run
 * unconditionally, in the line's own shell, into a directory that exists —
 * anything else leaves the cwd unknown, and a relative target after it is
 * `unplaced`; so is every other target of a line that makes a link. A word
 * the reader can't know (a variable) is left out: this lists what is
 * provably written, it isn't a sandbox (#448). A command that can't be
 * parsed has none.
 */
export function shellWriteTargets(command: string, ctx: EffectContext): ShellWriteTarget[] {
  const parsed = parseShellSync(command);
  if (parsed.problems.length > 0) return [];
  const home = ctx.home ?? homedir();
  let cwd: string | null = ctx.cwd ?? ctx.workdir;
  const linking = parsed.commands.map(makesLink);
  const out: ShellWriteTarget[] = [];
  for (const [i, cmd] of parsed.commands.entries()) {
    const others = linking.some((l, j) => l && j !== i);
    const add = (w: ShellWord | undefined, from: string | null = cwd) => {
      if (!w) return;
      const t = rawTargetOf(w, from, home);
      if (t === null || NOT_A_FILE.test(t.path)) return;
      out.push(others && !t.unplaced ? { ...t, unplaced: "the line makes a link that may lead it elsewhere" } : t);
    };
    const prog = programOf(cmd);
    for (const r of cmd.redirects) {
      if (!r.target || r.op === "<" || r.op === "<<" || r.op === "<<<" || r.op === "<<-" || r.op === "<&") continue;
      if (r.op === ">&" && /^\d+$|^-$/.test(r.target.value ?? "")) continue;
      add(r.target);
    }
    if (prog === null) continue;
    if (prog === "cd" || prog === "pushd") {
      cwd = cdTarget(cmd, cwd, home);
      continue;
    }
    if (prog === "popd") {
      cwd = null;
      continue;
    }
    const args = cmd.argv.slice(1);
    const operands = args.filter((w) => w.value === null || !w.value.startsWith("-"));
    if (WRITES_EVERY_OPERAND.has(prog)) for (const w of operands) add(w);
    if (WRITES_LAST_OPERAND.has(prog)) {
      const dir = targetDirectory(args);
      if (dir) add(dir);
      else if (operands.length >= 2) add(operands.at(-1));
      // `cp -l` / `cp -s`: a hard or symbolic link to each source, which a write through it changes.
      if (linking[i]) for (const w of dir ? operands : operands.slice(0, -1)) add(w);
    }
    if (prog === "ln" || prog === "link") lnTargets(cmd, cwd, home, add);
    if (prog === "dd") {
      const of = args.find((w) => w.value?.startsWith("of="));
      if (of?.value) add({ value: of.value.slice(3), raw: of.raw, glob: false });
    }
    const values = args.map((w) => w.value);
    if (prog === "sed" && values.some((x) => x !== null && (/^-[a-zA-Z]*i/.test(x) || x.startsWith("--in-place")))) {
      const scripted = values.some((x) => x !== null && /^(-[a-zA-Z]*[ef]|--expression|--file)/.test(x));
      for (const w of scripted ? operands : operands.slice(1)) add(w);
    }
    if (prog === "find" && values.some((x) => x === "-delete")) for (const w of findRoots(cmd)) add(w);
  }
  return out;
}

/** `-t DIR` / `--target-directory[=]DIR`: the directory `cp`, `install` or `ln` writes into. */
function targetDirectory(args: ShellWord[]): ShellWord | undefined {
  const t = args.findIndex((w) => w.value === "-t" || w.value === "--target-directory");
  if (t >= 0) return args[t + 1];
  const eq = args.find((w) => w.value?.startsWith("--target-directory="));
  return eq?.value ? { value: eq.value.slice("--target-directory=".length), raw: eq.raw, glob: false } : undefined;
}

/** A command that makes a hard or symbolic link: `ln`, `link`, `cp -l` / `cp -s`. */
function makesLink(cmd: SimpleCommand): boolean {
  const prog = programOf(cmd);
  if (prog === "ln" || prog === "link") return true;
  return prog === "cp" && cmd.argv.slice(1).some((w) => w.value !== null && (/^-[a-zA-Z]*[ls]/.test(w.value) || w.value === "--link" || w.value === "--symbolic-link"));
}

/**
 * What `ln` writes: the link's name (the last operand, `-t DIR`, or the
 * cwd), and what the link leads to — a hard link's source is the same file,
 * a symlink's target (relative to the link's directory unless `-r`) is where
 * a write through it lands.
 */
function lnTargets(cmd: SimpleCommand, cwd: string | null, home: string, add: (w: ShellWord | undefined, from?: string | null) => void): void {
  const args = cmd.argv.slice(1);
  const flags = args.filter((w) => w.value?.startsWith("-")).map((w) => w.value!);
  const symbolic = flags.some((f) => /^-[a-zA-Z]*s/.test(f) || f === "--symbolic");
  const relativeToCwd = flags.some((f) => /^-[a-zA-Z]*r/.test(f) || f === "--relative");
  // Operands, less the values `-t DIR` and `-S SUFFIX` take.
  const operands: ShellWord[] = [];
  for (let i = 0; i < args.length; i++) {
    const v = args[i]!.value;
    if (v === "-t" || v === "-S" || v === "--target-directory" || v === "--suffix") i++;
    else if (v === null || !v.startsWith("-")) operands.push(args[i]!);
  }
  const dir = targetDirectory(args);
  let sources = operands;
  let linkDir: ShellWord | null = null;
  if (dir) {
    add(dir);
    linkDir = dir;
  } else if (operands.length >= 2) {
    const name = operands.at(-1)!;
    add(name);
    sources = operands.slice(0, -1);
    // Into a directory when there are several sources, or the name is one; else the link is the name itself.
    const at = rawTargetOf(name, cwd, home);
    const isDir = operands.length > 2 || (at !== null && !at.unplaced && directoryAt(at.path));
    linkDir = isDir ? name : name.value !== null ? { ...name, value: name.value.includes("/") ? name.value.slice(0, name.value.lastIndexOf("/")) || "/" : "." } : null;
  } else add({ value: ".", raw: ".", glob: false });
  for (const s of sources) {
    if (!symbolic || relativeToCwd || s.value === null || isAbsolute(s.value) || s.value.startsWith("~")) {
      add(s);
      continue;
    }
    const base = linkDir ? rawTargetOf(linkDir, cwd, home) : cwd === null ? null : { path: cwd };
    if (base === null || base.unplaced) add(s, null);
    else add(s, base.path);
  }
}

/** Where a `cd` leaves the shell: its directory, when the line surely runs there next; null otherwise. */
function cdTarget(cmd: SimpleCommand, cwd: string | null, home: string): string | null {
  // In a subshell, a pipeline, the background, a nested shell or a substitution it moves nothing after it; on a condition it may not run.
  if (cmd.subshell || cmd.conditional || cmd.via.length > 0 || cmd.substitution !== null) return null;
  const to = cmd.argv[1];
  // `cd -` and options (`cd -P dir`) aren't followed: where they lead isn't told here.
  if (to && (to.value === null || to.value.startsWith("-") || to.glob || cmd.argv.length > 2)) return null;
  const at = to ? rawTargetOf(to, cwd, home) : { path: home };
  // One that fails leaves the shell where it was: followed only into a directory it can enter.
  return at !== null && !at.unplaced && directoryAt(at.path) ? at.path : null;
}

/** `p` is a directory that can be entered, read both as the kernel reads it and with `..` collapsed (as `cd` does). */
function directoryAt(p: string): boolean {
  try {
    for (const q of [p, resolve(p)]) {
      if (!statSync(q).isDirectory()) return false;
      accessSync(q, constants.X_OK);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * A write target's path as written, made absolute without collapsing `..`:
 * `~` expanded, a relative path joined to `cwd`. Unplaced for `~name`, and
 * for a relative path when `cwd` isn't known; null for a word with no value.
 */
function rawTargetOf(w: ShellWord, cwd: string | null, home: string): ShellWriteTarget | null {
  const v = w.value;
  if (v === null) return null;
  if (w.glob) {
    const cut = v.search(/[*?[{]/);
    const dir = v.slice(0, Math.max(0, v.lastIndexOf("/", cut)));
    return rawTargetOf({ value: dir || (v.startsWith("/") ? "/" : "."), raw: dir, glob: false }, cwd, home);
  }
  if (v === "~" || v.startsWith("~/")) return { path: home + v.slice(1) };
  if (v.startsWith("~")) return { path: v, unplaced: "another user's home" };
  if (isAbsolute(v)) return { path: v };
  if (cwd === null) return { path: v, unplaced: "the directory it runs in isn't known" };
  return { path: `${cwd}/${v}` };
}

function targetInside(path: string, cwd: string | null, workdir: string, home: string): boolean {
  const at = pathOf({ value: path, raw: path, glob: false }, cwd, home);
  return at !== null && inside(at, workdir);
}

/** A git command whose effect is in git's own state or on a remote; `git config --get` only reads. */
function gitOutside(cmd: SimpleCommand): boolean {
  const sub = gitSubcommand(cmd);
  if (sub === "config" && cmd.argv.some((w) => w.value !== null && /^(--get|--get-all|--get-regexp|--get-urlmatch|--list|-l)$/.test(w.value))) return false;
  return GIT_OUTSIDE.has(sub ?? "");
}

function gitSubcommand(cmd: SimpleCommand): string | null {
  const args = cmd.argv.slice(1);
  for (let i = 0; i < args.length; i++) {
    const v = args[i]!.value;
    if (v === null) return null;
    if (v === "-C" || v === "-c" || v === "--git-dir" || v === "--work-tree") {
      i++;
      continue;
    }
    if (v.startsWith("-")) continue;
    // `git branch -d` deletes; `git branch` alone lists.
    if (v === "branch") return args.slice(i + 1).some((w) => w.value !== null && /^-[a-zA-Z]*[dDmMcC]|^--(delete|move|copy|force)/.test(w.value)) ? "branch-delete" : "branch";
    return v;
  }
  return null;
}

function programOf(cmd: SimpleCommand): string | null {
  const v = cmd.argv[0]?.value;
  if (v === undefined || v === null) return null;
  const i = v.lastIndexOf("/");
  return i < 0 ? v : v.slice(i + 1);
}

function pathOf(w: ShellWord, cwd: string | null, home: string): string | null {
  const v = w.value;
  if (v === null) return null;
  if (w.glob) {
    const cut = v.search(/[*?[{]/);
    const dir = v.slice(0, Math.max(0, v.lastIndexOf("/", cut)));
    return pathOf({ value: dir || (v.startsWith("/") ? "/" : "."), raw: dir, glob: false }, cwd, home);
  }
  if (v === "~" || v.startsWith("~/")) return normalize(home + v.slice(1));
  if (v.startsWith("~")) return null;
  if (isAbsolute(v)) return normalize(v);
  return cwd === null ? null : resolve(cwd, v);
}

function inside(path: string, dir: string): boolean {
  return path === dir || path.startsWith(dir.endsWith(sep) ? dir : dir + sep);
}
