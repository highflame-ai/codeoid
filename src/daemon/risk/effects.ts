/**
 * What a shell command does that restoring the workspace's files can't undo
 * (#355, #431): the rewind warning. Read from the parsed command — wrappers,
 * quoting and `bash -c` seen through — not a pattern over its text.
 */
import { accessSync, constants, lstatSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, normalize, resolve, sep } from "node:path";
import { parseShellSync, type ShellWord, type SimpleCommand, wordShape } from "../shell/parse.js";
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
  /** The directory the command runs in, absolute; the workdir when absent; null when it isn't known. */
  cwd?: string | null;
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
  const start = ctx.cwd === undefined ? ctx.workdir : ctx.cwd;
  let cwd: string | null = start !== null && inside(start, ctx.workdir) ? start : null;
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
  /**
   * Why the reader can't place it for certain: a word that expands (a
   * pattern, a brace, a variable, a substitution, `~name`), a relative path
   * where the cwd isn't known, a path the line's own link may redirect, a
   * command whose options the reader doesn't know for certain.
   */
  unplaced?: string;
  /**
   * The command removes or renames the name itself (`rm`, `unlink`,
   * `rmdir`, `mv`'s sources): only the directory it is in is resolved, so a
   * link there is what goes, not what it leads to.
   */
  name?: true;
}

/**
 * The options a writing program is read with, as an allow-list: any other
 * option, and the reader isn't sure what the command writes. `flags`: short
 * options that take no value; `values`: short ones that take one (the rest
 * of the word, or the next word); `long`: `name` takes no value, `name=` one
 * (`--name=v` or `--name v`), `name?` an optional `=v`. Long options are
 * matched whole: an abbreviation getopt would accept isn't known.
 */
interface Options {
  flags: string;
  values?: string;
  long?: string[];
}

const OWNER_OPTIONS: Options = { flags: "Rvcfh", long: ["recursive", "verbose", "changes", "silent", "quiet", "no-dereference", "reference=", "from=", "preserve-root", "no-preserve-root"] };

/**
 * The writing programs the reader knows, and the options it is sure of for
 * each. Left out on purpose: whatever may copy or move a link as a link
 * (`cp -P/-d/-a/-r/-R`, `-l`/`-s`), `-T`, backups (`-b`, `-S`), and
 * `chown -H/-L` (which follow links while recursing).
 */
const OPTIONS: Record<string, Options> = {
  rm: { flags: "fiIrRdv", long: ["force", "interactive?", "recursive", "dir", "verbose", "one-file-system", "preserve-root?", "no-preserve-root"] },
  rmdir: { flags: "pv", long: ["parents", "verbose", "ignore-fail-on-non-empty"] },
  unlink: { flags: "" },
  mkdir: { flags: "pv", values: "m", long: ["parents", "verbose", "mode="] },
  touch: { flags: "acmfh", values: "drt", long: ["no-create", "no-dereference", "date=", "reference=", "time="] },
  chmod: { flags: "Rvcf", long: ["recursive", "verbose", "changes", "silent", "quiet", "reference=", "preserve-root", "no-preserve-root"] },
  chown: OWNER_OPTIONS,
  chgrp: OWNER_OPTIONS,
  truncate: { flags: "co", values: "sr", long: ["no-create", "io-blocks", "size=", "reference="] },
  shred: { flags: "fuvxz", values: "ns", long: ["force", "iterations=", "random-source=", "size=", "remove?", "verbose", "exact", "zero"] },
  tee: { flags: "aip", long: ["append", "ignore-interrupts", "output-error?"] },
  mv: { flags: "finvu", values: "t", long: ["force", "interactive", "no-clobber", "verbose", "update?", "strip-trailing-slashes", "target-directory="] },
  cp: { flags: "finvupL", values: "t", long: ["force", "interactive", "no-clobber", "verbose", "update?", "dereference", "strip-trailing-slashes", "target-directory="] },
  install: { flags: "vcpsCDd", values: "mogt", long: ["verbose", "compare", "preserve-timestamps", "strip", "directory", "mode=", "owner=", "group=", "target-directory="] },
  ln: { flags: "sfnvri", values: "t", long: ["symbolic", "force", "no-dereference", "verbose", "relative", "interactive", "target-directory="] },
  link: { flags: "" },
};

/** A writing program's arguments, read with its {@link Options}. */
interface Reading {
  operands: ShellWord[];
  /** Options given: a short one by its letter, a long one by its name; the value one took. */
  given: Map<string, ShellWord | true>;
  /** Why the reader can't be sure what the command writes; null when it can. */
  unsure: string | null;
}

/** Words a value was cut from (`-tDIR`, `of=x`): bash expands no `~` there that the reader would see. */
const CUT = new WeakSet<ShellWord>();

/** The value part of `w` after its option text `prefix`: null when the option text isn't written plainly. */
function cut(w: ShellWord, prefix: string): ShellWord | null {
  if (w.value === null || !w.raw.startsWith(prefix) || !w.value.startsWith(prefix)) return null;
  const v: ShellWord = { value: w.value.slice(prefix.length), raw: w.raw.slice(prefix.length), glob: w.glob };
  CUT.add(v);
  return v;
}

function readOptions(prog: string, args: ShellWord[], spec: Options): Reading {
  const r: Reading = { operands: [], given: new Map(), unsure: null };
  const unsure = (why: string): Reading => ({ ...r, unsure: why });
  let ended = false;
  for (let i = 0; i < args.length; i++) {
    const w = args[i]!;
    const v = w.value;
    if (ended || (v !== null && (!v.startsWith("-") || v === "-"))) {
      r.operands.push(w);
      continue;
    }
    if (v === null) return unsure(`${w.raw} may be an option of ${prog}'s`);
    // `chmod -w f`: a mode, not an option.
    if (prog === "chmod" && /^-[rwxXst]+$/.test(v)) {
      r.operands.push(w);
      continue;
    }
    // After an operand, getopt reads an option as one only without POSIXLY_CORRECT.
    if (r.operands.length > 0) return unsure(`${prog} has an option (${w.raw}) after its operands`);
    if (v === "--") {
      ended = true;
      continue;
    }
    const long = spec.long ?? [];
    if (v.startsWith("--")) {
      const eq = v.indexOf("=");
      const name = eq < 0 ? v.slice(2) : v.slice(2, eq);
      if (long.includes(`${name}?`) || (eq < 0 && long.includes(name))) {
        r.given.set(name, true);
        continue;
      }
      if (long.includes(`${name}=`)) {
        const value = eq >= 0 ? cut(w, v.slice(0, eq + 1)) : args[++i];
        if (!value) return unsure(`${prog} ${w.raw}'s value isn't plain`);
        r.given.set(name, value);
        continue;
      }
      return unsure(`${prog} ${w.raw} isn't an option the reader is sure of`);
    }
    for (let k = 1; k < v.length; k++) {
      const c = v[k]!;
      if (spec.flags.includes(c)) {
        r.given.set(c, true);
        continue;
      }
      if (spec.values?.includes(c)) {
        const value = k + 1 < v.length ? cut(w, v.slice(0, k + 1)) : args[++i];
        if (!value) return unsure(`${prog} ${w.raw}'s value isn't plain`);
        r.given.set(c, value);
        break;
      }
      return unsure(`${prog} -${c} isn't an option the reader is sure of`);
    }
  }
  return r;
}

/** The value an option took, by any of its names. */
function optionValue(r: Reading, ...names: string[]): ShellWord | undefined {
  for (const n of names) {
    const v = r.given.get(n);
    if (v && v !== true) return v;
  }
  return undefined;
}

/**
 * The files `command` writes, edits, creates, removes or moves: redirects,
 * what `rm`/`mv`/`cp`/`tee`/`touch`/… write, what `ln` links (the link, and
 * what it leads to: writing through it writes that), `dd of=`, `sed -i`'s
 * files, `find -delete`'s roots and `-fprint`'s files. Each is absolute,
 * unnormalized (the caller resolves links and `..` as the kernel does).
 *
 * It fails closed: a target is placed only when it is a plain literal word
 * (any expansion — a pattern, a brace, `$`, a substitution, `~name`, a `~`
 * mid-word — is `unplaced`); a writing program is read only with the
 * options it is sure of (OPTIONS), any other form is `unplaced`; a `cd` is
 * followed only where it surely moves what follows (run unconditionally, in
 * the line's own shell, by a path `CDPATH` doesn't apply to, into a
 * directory that exists), anything else leaves the cwd unknown and a
 * relative target after it `unplaced`; so is every other target of a line
 * that makes or moves a link (`ln`, a `cp` that may copy one, an `mv` of
 * anything but a plain file). A line that can't be parsed has none (the
 * risk gate asks about it as not understood).
 * Programs the reader doesn't know aren't judged: it lists what is provably
 * written, it isn't a sandbox (#448).
 */
export function shellWriteTargets(command: string, ctx: EffectContext): ShellWriteTarget[] {
  const parsed = parseShellSync(command);
  // A line that can't be read is the risk gate's: not understood, it asks unless the config lets such lines run (`askOnUnknown`).
  if (parsed.problems.length > 0) return [];
  const home = ctx.home ?? homedir();
  // Where each command runs, as far as the reader can follow it.
  const cwds: Array<string | null> = [];
  let cwd: string | null = ctx.cwd === undefined ? ctx.workdir : ctx.cwd;
  for (const cmd of parsed.commands) {
    cwds.push(cwd);
    const prog = programOf(cmd);
    if (prog === "cd" || prog === "pushd") cwd = cdTarget(cmd, cwd, home);
    else if (prog === "popd") cwd = null;
  }
  const linking = parsed.commands.map((cmd, i) => makesLink(cmd, cwds[i]!, home));
  const out: ShellWriteTarget[] = [];
  for (const [i, cmd] of parsed.commands.entries()) {
    const others = linking.some((l, j) => l && j !== i);
    const here = cwds[i]!;
    const add = (w: ShellWord | undefined, opts: { from?: string | null; name?: true } = {}) => {
      if (!w) return;
      const t = rawTargetOf(w, opts.from === undefined ? here : opts.from, home);
      if (t === null || NOT_A_FILE.test(t.path)) return;
      const named = opts.name ? { ...t, name: true as const } : t;
      out.push(others && !t.unplaced ? { ...named, unplaced: "the line makes or moves a link that may lead it elsewhere" } : named);
    };
    const unsure = (why: string) => out.push({ path: cmd.argv.map((w) => w.raw).join(" "), unplaced: why });
    const prog = programOf(cmd);
    for (const r of cmd.redirects) {
      if (!r.target || r.op === "<" || r.op === "<<" || r.op === "<<<" || r.op === "<<-" || r.op === "<&") continue;
      if (r.op === ">&" && /^\d+$|^-$/.test(r.target.value ?? "")) continue;
      add(r.target);
    }
    if (prog === null || prog === "cd" || prog === "pushd" || prog === "popd") continue;
    const args = cmd.argv.slice(1);
    if (prog === "dd") {
      for (const w of args) {
        if (w.value === null || !/^[a-z]+=/.test(w.value)) {
          unsure(`dd ${w.raw} isn't an operand the reader is sure of`);
          break;
        }
        if (w.value.startsWith("of=")) add(cut(w, "of=") ?? { value: null, raw: w.raw, glob: false });
      }
      continue;
    }
    if (prog === "sed" || prog === "find") {
      const files = prog === "sed" ? sedTargets(args) : findTargets(cmd);
      if (typeof files === "string") unsure(files);
      else for (const w of files) add(w);
      continue;
    }
    const spec = OPTIONS[prog];
    if (!spec) continue;
    const r = readOptions(prog, args, spec);
    if (r.unsure) {
      unsure(r.unsure);
      continue;
    }
    const ops = r.operands;
    switch (prog) {
      case "rm":
      case "rmdir":
      case "unlink":
        for (const w of ops) add(w, { name: true });
        break;
      case "mkdir":
      case "touch":
      case "truncate":
      case "shred":
      case "tee":
        for (const w of ops) add(w);
        break;
      case "chmod":
      case "chown":
      case "chgrp":
        // The mode or owner comes first, unless --reference gives it.
        for (const w of r.given.has("reference") ? ops : ops.slice(1)) add(w);
        break;
      case "mv": {
        const dir = optionValue(r, "t", "target-directory");
        if (dir) add(dir);
        else if (ops.length >= 2) add(ops.at(-1));
        for (const w of dir ? ops : ops.slice(0, -1)) add(w, { name: true });
        break;
      }
      case "cp":
      case "install": {
        const dir = optionValue(r, "t", "target-directory");
        if (dir) add(dir);
        else if (prog === "install" && (r.given.has("d") || r.given.has("directory"))) for (const w of ops) add(w);
        else if (ops.length >= 2) add(ops.at(-1));
        break;
      }
      case "ln":
      case "link":
        lnTargets(r, here, home, add);
        break;
    }
  }
  return out;
}

/**
 * Whether `cmd` makes a link, or moves one into a name the line may write
 * through next: `ln`, `link`; a `cp` read with anything but the options
 * that copy a file's content (OPTIONS: `-P`, `-a`, `-r`, `-l`, `-s` may copy
 * or make a link); an `mv` of anything but an existing plain file.
 */
function makesLink(cmd: SimpleCommand, cwd: string | null, home: string): boolean {
  const prog = programOf(cmd);
  if (prog === "ln" || prog === "link") return true;
  if (prog !== "cp" && prog !== "mv") return false;
  const r = readOptions(prog, cmd.argv.slice(1), OPTIONS[prog]!);
  if (r.unsure) return true;
  if (prog === "cp") return false;
  const sources = optionValue(r, "t", "target-directory") ? r.operands : r.operands.slice(0, -1);
  return sources.some((w) => {
    const at = rawTargetOf(w, cwd, home);
    if (at === null || at.unplaced) return true;
    try {
      return !lstatSync(at.path).isFile();
    } catch {
      return true;
    }
  });
}

/**
 * What `ln` writes: the link's name (the last operand, `-t DIR`, or the
 * cwd), and what the link leads to — a hard link's source is the same file,
 * a symlink's target (relative to the link's directory unless `-r`) is where
 * a write through it lands.
 */
function lnTargets(r: Reading, cwd: string | null, home: string, add: (w: ShellWord | undefined, opts?: { from?: string | null }) => void): void {
  const symbolic = r.given.has("s") || r.given.has("symbolic");
  const relativeToCwd = r.given.has("r") || r.given.has("relative");
  const operands = r.operands;
  const dir = optionValue(r, "t", "target-directory");
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
    if (base === null || base.unplaced) add(s, { from: null });
    else add(s, { from: base.path });
  }
}

/**
 * What `sed` writes: with `-i`, its files; and any file its script writes
 * (`w`, `W`, an `s///w`) or a command it runs (`e`), which can't be placed.
 * Its files, or why the reader isn't sure. Read as sed reads its options: `-e S`, `-eS`, `--expression=S`, `-f F`,
 * `-l N`, `-i[SUFFIX]`, `--in-place[=SUFFIX]`; anything else is unsure.
 */
function sedTargets(args: ShellWord[]): ShellWord[] | string {
  const scripts: ShellWord[] = [];
  const operands: ShellWord[] = [];
  let suffix: string | null = null;
  let inPlace = false;
  let ended = false;
  for (let i = 0; i < args.length; i++) {
    const w = args[i]!;
    const x = w.value;
    if (ended || (x !== null && (!x.startsWith("-") || x === "-"))) {
      operands.push(w);
      continue;
    }
    if (x === null) return (`${w.raw} may be an option of sed's`);
    if (operands.length > 0) return (`sed has an option (${w.raw}) after its operands`);
    if (x === "--") {
      ended = true;
      continue;
    }
    if (x.startsWith("--")) {
      const eq = x.indexOf("=");
      const name = eq < 0 ? x : x.slice(0, eq);
      const value = () => (eq < 0 ? args[++i] : (cut(w, x.slice(0, eq + 1)) ?? undefined));
      if (name === "--expression") {
        const s = value();
        if (!s) return ("sed's script isn't plain");
        scripts.push(s);
      } else if (name === "--file") return ("sed runs a script from a file");
      else if (name === "--line-length") value();
      else if (name === "--in-place") {
        inPlace = true;
        suffix = eq < 0 ? "" : x.slice(eq + 1);
      } else if (!SED_LONG.has(x)) return (`sed ${w.raw} isn't an option the reader is sure of`);
      continue;
    }
    for (let k = 1; k < x.length; k++) {
      const c = x[k]!;
      if ("nErsuz".includes(c)) continue;
      if (c === "i") {
        inPlace = true;
        suffix = x.slice(k + 1); // the rest is a backup suffix
        break;
      }
      if (c === "e" || c === "f" || c === "l") {
        const s = x.length > k + 1 ? (cut(w, x.slice(0, k + 1)) ?? undefined) : args[++i];
        if (c === "f") return ("sed runs a script from a file");
        if (c === "e") {
          if (!s) return ("sed's script isn't plain");
          scripts.push(s);
        }
        break;
      }
      return (`sed -${c} isn't an option the reader is sure of`);
    }
  }
  // Without -e / -f, the first operand is the script; the rest are files.
  if (scripts.length === 0) {
    const s = operands.shift();
    if (s) scripts.push(s);
  }
  for (const s of scripts) {
    if (s.value === null) return ("sed's script is only known at run time");
    const why = sedScriptWrites(s.value);
    if (why) return (why);
  }
  if (!inPlace) return [];
  // A suffix with `/` or `*` puts the backup in another directory (GNU sed).
  if (suffix !== null && /[/*]/.test(suffix)) return (`sed's backup suffix ${suffix} names another place`);
  return operands;
}

const SED_LONG = new Set(["--quiet", "--silent", "--regexp-extended", "--separate", "--null-data", "--zero-terminated", "--posix", "--debug", "--sandbox", "--unbuffered", "--follow-symlinks"]);

/**
 * Why a sed script may write a file or run a command (`w`, `W`, an `s`
 * flag `w` or `e`, `e`), or isn't read for certain; null when it surely
 * does neither. A small reader of sed's own syntax: addresses, then one
 * command each, separated by `;`, a newline or braces.
 */
export function sedScriptWrites(script: string): string | null {
  let i = 0;
  const n = script.length;
  const ws = () => {
    while (i < n && /[ \t]/.test(script[i]!)) i++;
  };
  /** Past a delimited part (`/re/`, `s`'s pattern or replacement); false when it doesn't end. */
  const delimited = (d: string): boolean => {
    while (i < n && script[i] !== d) {
      if (script[i] === "\\") {
        i += 2;
        continue;
      }
      if (script[i] === "\n") return false;
      i++;
    }
    if (i >= n) return false;
    i++;
    return true;
  };
  const toEol = () => {
    while (i < n && script[i] !== "\n") i++;
  };
  const address = (): boolean => {
    const c = script[i];
    if (c === undefined) return true;
    if (/[0-9]/.test(c)) {
      while (i < n && /[0-9~]/.test(script[i]!)) i++;
    } else if (c === "$") i++;
    else if (c === "/") {
      i++;
      if (!delimited("/")) return false;
      while (i < n && /[IM]/.test(script[i]!)) i++;
    } else if (c === "\\") {
      const d = script[i + 1];
      if (d === undefined) return false;
      i += 2;
      if (!delimited(d)) return false;
      while (i < n && /[IM]/.test(script[i]!)) i++;
    } else if (c === "+" || c === "~") {
      i++;
      while (i < n && /[0-9]/.test(script[i]!)) i++;
    }
    return true;
  };
  const unsure = "sed's script isn't one the reader is sure of";
  while (i < n) {
    while (i < n && /[ \t\n;]/.test(script[i]!)) i++;
    if (i >= n) break;
    if (!address()) return unsure;
    ws();
    if (script[i] === ",") {
      i++;
      ws();
      if (!address()) return unsure;
      ws();
    }
    while (script[i] === "!") {
      i++;
      ws();
    }
    const c = script[i++];
    if (c === undefined) return unsure;
    if (c === "{") continue;
    if ("}=dDgGhHnNpPxzF".includes(c)) {
      // no argument
    } else if ("qQlL".includes(c)) {
      ws();
      while (i < n && /[0-9]/.test(script[i]!)) i++;
    } else if (":btT".includes(c)) {
      while (i < n && script[i] !== ";" && script[i] !== "\n") i++;
    } else if ("aicrR#".includes(c)) {
      // Text or a file to read, to the end of the line.
      toEol();
    } else if (c === "s" || c === "y") {
      const d = script[i++];
      if (d === undefined || d === "\n" || d === "\\") return unsure;
      if (!delimited(d) || !delimited(d)) return unsure;
      if (c === "s") {
        while (i < n && /[gpiImM0-9we]/.test(script[i]!)) {
          if (script[i] === "w") return "sed's script writes a file (s///w)";
          if (script[i] === "e") return "sed's script runs a command (s///e)";
          i++;
        }
      }
    } else if (c === "w" || c === "W") return `sed's script writes a file (${c})`;
    else if (c === "e") return "sed's script runs a command (e)";
    else return unsure;
    ws();
    if (i < n && !/[;\n}]/.test(script[i]!)) return unsure;
  }
  return null;
}

/**
 * What `find` writes: with `-delete`, its roots (the matches are under
 * them; with `-L`/`-H` it follows links out of them, so unsure); and the
 * file each of `-fprint`, `-fprint0`, `-fls`, `-fprintf` names; or why the
 * reader isn't sure.
 */
function findTargets(cmd: SimpleCommand): ShellWord[] | string {
  const args = cmd.argv.slice(1);
  const out: ShellWord[] = [];
  const values = args.map((w) => w.value);
  if (values.includes("-delete")) {
    let follows = false;
    for (const x of values) {
      if (x === null || !/^-([HLP]|D|O\d*)$/.test(x)) break;
      if (x === "-L" || x === "-H") follows = true;
    }
    if (follows || values.includes("-follow")) return ("find -delete follows links");
    out.push(...findRoots(cmd));
  }
  for (const [i, x] of values.entries()) {
    if (x === "-fprint" || x === "-fprint0" || x === "-fls" || x === "-fprintf") out.push(args[i + 1] ?? { value: null, raw: x, glob: false });
  }
  return out;
}

/**
 * Where a `cd` leaves the shell: its directory, when the line surely runs
 * there next; null otherwise. A relative name not starting `./` or `../`
 * is looked up in `CDPATH` first, which the reader doesn't know.
 */
function cdTarget(cmd: SimpleCommand, cwd: string | null, home: string): string | null {
  // In a subshell, a pipeline, the background, a nested shell or a substitution it moves nothing after it; on a condition it may not run.
  if (cmd.subshell || cmd.conditional || cmd.via.length > 0 || cmd.substitution !== null) return null;
  const to = cmd.argv[1];
  // `cd -` and options (`cd -P dir`) aren't followed: where they lead isn't told here.
  if (to && (to.value === null || to.value.startsWith("-") || cmd.argv.length > 2)) return null;
  if (to && !/^(\/|~|\.\.?(\/|$))/.test(to.value!)) return null;
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

/** A word's text outside its quotes, each quoted or escaped character a placeholder; null when a quote doesn't end. */
function unquotedText(raw: string): string | null {
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    if (c === "\\") {
      i++;
      out += "\u0001";
    } else if (c === "'" || (c === "$" && raw[i + 1] === "'")) {
      if (c === "$") i++;
      const ansi = c === "$";
      let j = i + 1;
      while (j < raw.length && raw[j] !== "'") j += ansi && raw[j] === "\\" ? 2 : 1;
      if (j >= raw.length) return null;
      out += "\u0001";
      i = j;
    } else if (c === '"' || (c === "$" && raw[i + 1] === '"')) {
      if (c === "$") i++;
      let j = i + 1;
      while (j < raw.length && raw[j] !== '"') j += raw[j] === "\\" ? 2 : 1;
      if (j >= raw.length) return null;
      out += "\u0001";
      i = j;
    } else out += c;
  }
  return out;
}

/**
 * Why `w` isn't a plain literal word the reader knows for certain: a value
 * known only at run time, a pattern or a brace, anything unquoted that may
 * expand (`$`, a backquote, `{`, `*`, `?`, `[`, an extglob's `(`, `~` past
 * the start); null for a plain word.
 */
export function expansionIn(w: ShellWord): string | null {
  if (w.value === null || w.input) return `${w.raw || "a word"} is only known at run time`;
  if (w.glob || /[-]/.test(wordShape(w))) return `${w.raw} is a pattern that may expand to other names`;
  const bare = unquotedText(w.raw);
  if (bare === null || /[{}*?[$`()<>]/.test(bare)) return `${w.raw} may expand to other names`;
  const tilde = bare.indexOf("~");
  if (tilde > 0 || (tilde === 0 && CUT.has(w))) return `${w.raw} may expand ~`;
  return null;
}

/**
 * A write target's path as written, made absolute without collapsing `..`:
 * `~` expanded, a relative path joined to `cwd`. Unplaced for a word that
 * isn't plain ({@link expansionIn}), `~name`, and for a relative path when
 * `cwd` isn't known.
 */
function rawTargetOf(w: ShellWord, cwd: string | null, home: string): ShellWriteTarget | null {
  const why = expansionIn(w);
  if (why) return { path: w.raw || "(a word only known at run time)", unplaced: why };
  const v = w.value!;
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
    // A pattern stays under its fixed directory only without a brace, a bracket, `..` or `~`, and with its wildcards in its last component.
    if (/[{[(~]/.test(w.raw) || /(^|\/)\.\.(\/|$)/.test(v)) return null;
    const cut = v.search(/[*?]/);
    if (v.indexOf("/", cut) >= 0) return null;
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
