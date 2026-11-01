/**
 * What a shell command does that restoring the workspace's files can't undo
 * (#355, #431): the rewind warning. Read from the parsed command — wrappers,
 * quoting and `bash -c` seen through — not a pattern over its text.
 */
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
