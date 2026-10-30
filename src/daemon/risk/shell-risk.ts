/**
 * How risky a shell command line is (#431), judged from what it runs
 * (src/daemon/shell/parse.ts), not from the tool's name:
 *
 * - `low`: reads inside the workspace and nothing else — `git status`, `ls`,
 *   `grep -r foo src`.
 * - `medium`: changes something, runs code, or reaches outside the workspace
 *   — `npm test`, `echo x > f`, `git commit`, `cat /etc/hosts`.
 * - `high`: hard or impossible to undo, or a classic way to lose data or
 *   credentials — `rm -rf ~`, `git push --force`, `curl … | sh`, writes to
 *   system paths or shell start-up files, credential reads, `sudo`.
 * - `unknown`: the line can't be read with certainty (a syntax error, a
 *   program or script only known at run time). Never treated as low.
 *
 * A command that touches one of codeoid's own credential files, or another
 * agent's login, is refused outright (`deny`), as the file tools are.
 *
 * Rules over-state rather than under-state: a word that merely looks like a
 * path outside the workspace makes a read medium, and a recursive delete of
 * anything that isn't plainly inside the workspace is high.
 */
import { homedir } from "node:os";
import { isAbsolute, join, normalize, resolve, sep } from "node:path";
import { secretDirsOf, secretPathVerdict } from "../secret-paths.js";
import { loadShellParser, type ParsedShell, parseShellSync, type ShellAssignment, type ShellWord, type SimpleCommand } from "../shell/parse.js";

export type RiskLevel = "low" | "medium" | "high" | "unknown";

export interface ShellRisk {
  level: RiskLevel;
  /** Why, most serious first; empty for low. */
  reasons: string[];
  /** A credential file the line names: refused (`deny`) or asked about (`ask`), whatever the level. */
  secret?: { action: "deny" | "ask"; path: string };
}

export interface RiskContext {
  /** The directory the command runs in (the session's workdir unless the tool names another). */
  cwd: string;
  /** The session's workspace: inside it is the agent's own ground. */
  workdir: string;
  /** codeoid's config dir (its credential files). */
  configDir: string;
  home?: string;
}

const RANK: Record<RiskLevel, number> = { low: 0, medium: 1, unknown: 2, high: 3 };

/** The more serious of two levels (high > unknown > medium > low). */
export function maxRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
  return RANK[a] >= RANK[b] ? a : b;
}

/** Judge a command line, loading the parser first if need be. */
export async function assessShellCommand(command: string, ctx: RiskContext): Promise<ShellRisk> {
  await loadShellParser().catch(() => {});
  return assessShellCommandSync(command, ctx);
}

/**
 * Judge a command line with the parser already loaded (the daemon loads it
 * at start); before then the line is `unknown`. Never throws: an analyser
 * failure is `high` (fail closed).
 */
export function assessShellCommandSync(command: string, ctx: RiskContext): ShellRisk {
  try {
    return judge(parseShellSync(command), { ...ctx, home: ctx.home ?? homedir() });
  } catch (err) {
    return { level: "high", reasons: [`the command couldn't be analysed: ${err instanceof Error ? err.message : String(err)}`] };
  }
}

type Ctx = Required<RiskContext>;

class Verdict {
  level: RiskLevel = "low";
  readonly reasons: Array<{ level: RiskLevel; text: string }> = [];
  secret?: ShellRisk["secret"];
  add(level: RiskLevel, text: string): void {
    this.level = maxRisk(this.level, level);
    if (level !== "low" && !this.reasons.some((r) => r.text === text)) this.reasons.push({ level, text });
  }
  out(): ShellRisk {
    const reasons = [...this.reasons].sort((x, y) => RANK[y.level] - RANK[x.level]).map((r) => r.text);
    return { level: this.level, reasons, ...(this.secret ? { secret: this.secret } : {}) };
  }
}

export function judge(parsed: ParsedShell, ctx: Ctx): ShellRisk {
  const v = new Verdict();
  judgeLine(parsed, ctx.cwd, ctx, v);
  return v.out();
}

function judgeLine(parsed: ParsedShell, start: string | null, ctx: Ctx, v: Verdict): void {
  for (const p of parsed.problems) v.add("unknown", p);
  for (const a of parsed.assignments) judgeAssignment(a, v);
  // A `cd` moves every relative path after it: null once where to isn't known.
  let cwd: string | null = start;
  for (const cmd of parsed.commands) {
    const prog = programOf(cmd);
    if (prog === "cd" || prog === "pushd" || prog === "popd") {
      cwd = cdTarget(cmd, prog, cwd, ctx);
      continue;
    }
    judgeCommand(cmd, parsed, cwd, ctx, v);
  }
}

/** Variables that change what a program runs or loads, or where a path points. */
const STEERING_VARS = /^(LD_\w+|DYLD_\w+|GIT_\w+|\w+_PAGER|\w+_EDITOR|\w+_COMMAND|BASH_ENV|ENV|PS4|PROMPT_COMMAND|SHELLOPTS|BASHOPTS|IFS|CDPATH|OLDPWD|HOME|PATH|PAGER|MANPAGER|EDITOR|VISUAL|BROWSER|LESSOPEN|LESSCLOSE|NODE_OPTIONS|PYTHONSTARTUP|PYTHONPATH|PERL5OPT|PERL5LIB|RUBYOPT|SSH_ASKPASS|SUDO_ASKPASS)$/;
/** In a program's environment, these change nothing it runs. */
const PLAIN_VARS = /^(LANG|LANGUAGE|LC_\w+|TZ|NO_COLOR|FORCE_COLOR|CLICOLOR|CLICOLOR_FORCE|TERM|COLUMNS|LINES|CI|GIT_TERMINAL_PROMPT|GIT_OPTIONAL_LOCKS|GIT_AUTHOR_(NAME|EMAIL|DATE)|GIT_COMMITTER_(NAME|EMAIL|DATE))$/;
/** A pager or editor that runs nothing: `GIT_PAGER=cat git log`, `GIT_EDITOR=true git rebase --continue`. */
const PLAIN_PROGRAM = /(PAGER|EDITOR)$/;

/**
 * A variable the line sets: one that steers what runs or where paths point
 * (`LD_PRELOAD`, `PATH`, `GIT_*`, `PAGER`, `HOME`, `CDPATH`, …) isn't
 * understood, wherever it is set; any other one in a program's environment
 * makes it medium.
 */
function judgeAssignment(a: ShellAssignment, v: Verdict): void {
  if (PLAIN_VARS.test(a.name)) return;
  if (PLAIN_PROGRAM.test(a.name) && ["", "cat", "true", ":"].includes(a.value.value ?? "-")) return;
  if (STEERING_VARS.test(a.name)) v.add("unknown", `it sets ${a.name}, which changes what programs run or where paths point`);
  else if (a.exported) v.add("medium", `runs with ${a.name} set in its environment`);
}

/** Where a `cd` goes: null for `cd -`, `popd`, and anything only known at run time. */
function cdTarget(cmd: SimpleCommand, prog: string, cwd: string | null, ctx: Ctx): string | null {
  if (prog === "popd") return null;
  let args = cmd.argv.slice(1);
  while (args[0]?.value && /^-[LPe@]+$/.test(args[0].value)) args = args.slice(1);
  if (args[0]?.value === "--") args = args.slice(1);
  const to = args[0];
  if (!to) return prog === "cd" ? ctx.home : null; // `pushd` alone swaps with the stack
  if (to.value === "-" || /^[+-]\d+$/.test(to.value ?? "")) return null;
  return resolvePath(to, cwd, ctx);
}

function programOf(cmd: SimpleCommand): string | null {
  const v = cmd.argv[0]?.value;
  if (v === undefined || v === null) return null;
  const i = v.lastIndexOf("/");
  return i < 0 ? v : v.slice(i + 1);
}

/** A word as an absolute path, or null when it isn't known (dynamic, or relative to an unknown cwd). */
function resolvePath(w: ShellWord, cwd: string | null, ctx: Ctx): string | null {
  // `$HOME/x` is `~/x`: both are the home directory the shell has.
  let v = w.value ?? w.home ?? null;
  if (v === null) return null;
  if (w.glob) {
    // The fixed part before the first wildcard: `/tmp/x*` is somewhere in /tmp.
    const cut = v.search(/[*?[{]/);
    v = cut < 0 ? v : v.slice(0, Math.max(0, v.lastIndexOf("/", cut)) || (v.startsWith("/") ? 1 : 0));
    if (v === "") v = ".";
  }
  if (v === "~" || v.startsWith("~/")) return normalize(join(ctx.home, v.slice(1)));
  if (v.startsWith("~")) return null; // another user's home
  if (isAbsolute(v)) return normalize(v);
  return cwd === null ? null : resolve(cwd, v);
}

function insideOf(path: string, dir: string): boolean {
  const d = dir.endsWith(sep) ? dir : dir + sep;
  return path === dir || path.startsWith(d);
}

/** Paths whose loss or change breaks the machine or the user's environment. */
const SYSTEM_PREFIXES = ["/etc", "/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/boot", "/dev", "/sys", "/proc", "/var", "/opt", "/root", "/srv", "/System", "/Library", "/Applications", "/private"];
/** In the home directory: start-up files, keys and tool configs. */
const HOME_SENSITIVE = [
  ".ssh",
  ".gnupg",
  ".aws",
  ".azure",
  ".config",
  ".kube",
  ".docker",
  ".bashrc",
  ".bash_profile",
  ".bash_login",
  ".bash_aliases",
  ".bash_logout",
  ".profile",
  ".zshrc",
  ".zprofile",
  ".zshenv",
  ".zlogin",
  ".zlogout",
  ".xprofile",
  ".xinitrc",
  ".pam_environment",
  ".inputrc",
  ".vimrc",
  ".gitconfig",
  ".git-credentials",
  ".netrc",
  ".npmrc",
  ".pypirc",
  ".local/bin",
  ".cargo/env",
  // Agents' own settings and logins: a Claude hook is a command that runs outside the gate.
  ".claude",
  ".claude.json",
  ".codex",
  ".gemini",
  ".qwen",
  ".pi",
  ".codeoid",
];
/** Files that are credentials themselves: reading one is high. */
const CREDENTIAL_FILES = [".ssh/id_", ".aws/credentials", ".netrc", ".git-credentials", ".docker/config.json", ".kube/config", ".npmrc", ".pypirc", ".config/gh/hosts.yml", ".gnupg/"];
const SYSTEM_CREDENTIALS = ["/etc/shadow", "/etc/gshadow", "/etc/sudoers", "/etc/ssh/ssh_host_"];

type Where = "workspace" | "outside" | "home" | "home-sensitive" | "system" | "root" | "unknown";

/** Where a path is, in terms of what's at stake. */
function where(path: string | null, ctx: Ctx): Where {
  if (path === null) return "unknown";
  if (path === "/" ) return "root";
  if (path === "/dev/null" || path === "/dev/stdout" || path === "/dev/stderr" || path === "/dev/tty") return "outside";
  if (insideOf(path, ctx.workdir)) return "workspace";
  if (insideOf(path, ctx.configDir)) return "home-sensitive";
  if (path === ctx.home) return "home";
  if (insideOf(path, ctx.home)) {
    const rel = path.slice(ctx.home.length + 1);
    return HOME_SENSITIVE.some((s) => rel === s || rel.startsWith(`${s}/`)) ? "home-sensitive" : "outside";
  }
  if (SYSTEM_PREFIXES.some((p) => insideOf(path, p))) return "system";
  return "outside";
}

function isCredentialPath(path: string | null, ctx: Ctx): boolean {
  if (path === null) return false;
  if (SYSTEM_CREDENTIALS.some((p) => path.startsWith(p))) return true;
  if (!insideOf(path, ctx.home)) return false;
  const rel = path.slice(ctx.home.length + 1);
  return CREDENTIAL_FILES.some((c) => rel === c.replace(/\/$/, "") || rel.startsWith(c));
}

/** Words that look like paths: `./x`, `a/b`, `~`, `/x`, or the value after `--opt=`. */
function pathLike(w: ShellWord): ShellWord[] {
  const v = w.value ?? w.home ?? null;
  if (v === null) return [];
  const out: ShellWord[] = [];
  const eq = v.startsWith("-") ? v.indexOf("=") : -1;
  const value = eq >= 0 ? v.slice(eq + 1) : v;
  if (value.startsWith("-") && eq < 0) return [];
  if (/^(\.{1,2}(\/|$)|~|\/)/.test(value) || (value.includes("/") && !/^[a-z][a-z0-9+.-]*:\/\//i.test(value))) {
    out.push({ ...w, value });
  }
  return out;
}

/**
 * Words that may name a file: path-like ones, and a bare name (`config.json`),
 * which is a file in the directory the command runs in.
 */
function fileWords(w: ShellWord): ShellWord[] {
  const p = pathLike(w);
  if (p.length > 0) return p;
  const v = w.value;
  return v && !v.startsWith("-") && !v.includes("=") && !/^[a-z][a-z0-9+.-]*:/i.test(v) ? [w] : [];
}

/** Note a credential file the command names: codeoid's and other agents' logins are refused. */
function checkSecrets(cmd: SimpleCommand, cwd: string | null, ctx: Ctx, v: Verdict): void {
  const words = [...cmd.argv.slice(1), ...cmd.redirects.map((r) => r.target).filter((t): t is ShellWord => t !== null)];
  for (const w of words) {
    for (const p of fileWords(w)) {
      const abs = resolvePath(p, cwd, ctx);
      if (abs === null) {
        if (cwd === null) checkSecretsAnywhere(p, ctx, v);
        continue;
      }
      const s = secretPathVerdict("Grep", { path: abs }, { workdir: ctx.workdir, configDir: ctx.configDir });
      if (!s) continue;
      if (s.action === "deny" || !v.secret) v.secret = s;
      if (s.action === "deny") v.add("high", `touches ${s.path}, which holds credentials`);
      else v.add("medium", `reaches ${s.path}, which contains credential files`);
    }
  }
}

/**
 * A relative path after a `cd` to a directory only known at run time: if it
 * would name a credential file in any of the directories that hold them,
 * it's asked about, never run unasked.
 */
function checkSecretsAnywhere(w: ShellWord, ctx: Ctx, v: Verdict): void {
  const rel = w.value;
  if (rel === null || isAbsolute(rel) || rel.startsWith("~")) return;
  for (const dir of [ctx.home, join(ctx.home, ".ssh"), ...secretDirsOf(ctx.configDir)]) {
    const abs = resolve(dir, rel);
    if (secretPathVerdict("Grep", { path: abs }, { workdir: ctx.workdir, configDir: ctx.configDir })?.action === "deny" || isCredentialPath(abs, ctx)) {
      v.secret ??= { action: "ask", path: abs };
      v.add("medium", `may read ${abs}, a credential file, from a directory only known at run time`);
      return;
    }
  }
}

/** Read-only programs: low when everything they name is in the workspace. */
const READERS = new Set([
  "ls", "cat", "head", "tail", "wc", "grep", "egrep", "fgrep", "rg", "ag", "fd", "echo", "printf", "pwd", "which", "whereis", "type",
  "file", "stat", "du", "df", "tree", "cut", "tr", "diff", "cmp", "comm", "nl", "tac", "rev", "paste", "column", "fold", "fmt",
  "expand", "unexpand", "md5sum", "sha1sum", "sha224sum", "sha256sum", "sha384sum", "sha512sum", "shasum", "cksum", "b2sum",
  "whoami", "id", "uname", "true", "false", "test", "[", "basename", "dirname", "realpath", "readlink", "seq", "sleep", "jq",
  "od", "hexdump", "xxd", "strings", "less", "more", "bat", "date", "uptime", "nproc", "arch", "groups", "locale", "tty",
]);
const DOWNLOADERS = new Set(["curl", "wget", "fetch", "http", "https", "aria2c", "lwp-request", "xh"]);
const INTERPRETERS = new Set([
  "sh", "bash", "zsh", "dash", "ksh", "mksh", "ash", "fish", "busybox", "python", "python2", "python3", "perl", "ruby", "node",
  "nodejs", "bun", "deno", "php", "lua", "luajit", "Rscript", "pwsh", "powershell", "osascript", "tclsh", "source", ".",
]);
const DISK_TOOLS = new Set(["mkfs", "mke2fs", "mkfs.ext4", "mkfs.ext3", "mkfs.xfs", "mkfs.vfat", "mkfs.btrfs", "fdisk", "sfdisk", "gdisk", "parted", "wipefs", "shred", "blkdiscard", "mkswap", "hdparm", "diskutil", "format"]);
const POWER = new Set(["shutdown", "reboot", "halt", "poweroff", "init", "telinit"]);
const ELEVATE = new Set(["sudo", "doas", "su", "pkexec", "runas", "run0", "runuser", "sudoedit", "machinectl", "systemd-run"]);
/** Run a command as root inside another root directory or namespace. */
const ROOT_TOOLS = new Set(["chroot", "nsenter"]);
const NET_RAW = new Set(["nc", "ncat", "netcat", "socat", "telnet"]);

const flags = (cmd: SimpleCommand): string[] => cmd.argv.slice(1).map((w) => w.value ?? "").filter((x) => x.startsWith("-"));
const hasFlag = (cmd: SimpleCommand, short: string, long?: string): boolean =>
  flags(cmd).some((f) => (long !== undefined && (f === long || f.startsWith(`${long}=`))) || (/^-[a-zA-Z]+$/.test(f) && f.includes(short)));
const positionals = (cmd: SimpleCommand): ShellWord[] => {
  const out: ShellWord[] = [];
  let ended = false;
  for (const w of cmd.argv.slice(1)) {
    if (!ended && w.value === "--") {
      ended = true;
      continue;
    }
    if (!ended && w.value?.startsWith("-") && w.value !== "-") continue;
    out.push(w);
  }
  return out;
};

function judgeCommand(cmd: SimpleCommand, parsed: ParsedShell, cwd: string | null, ctx: Ctx, v: Verdict): void {
  checkSecrets(cmd, cwd, ctx, v);
  if (cmd.via.some((w) => ELEVATE.has(w))) v.add("high", `runs as another user (${cmd.via.find((w) => ELEVATE.has(w))})`);
  judgeRedirects(cmd, cwd, ctx, v);
  const prog = programOf(cmd);
  if (prog === null) return; // a dynamic program is already a parse problem
  if (ELEVATE.has(prog)) {
    v.add("high", `runs as another user (${prog})`);
    return;
  }
  if (ROOT_TOOLS.has(prog)) {
    v.add("high", `${prog} runs a command as root in another root or namespace`);
    return;
  }
  // A shell given a script: what the script runs is judged where it's listed.
  if (cmd.delegates) return;

  if (INTERPRETERS.has(prog)) {
    judgeInterpreter(cmd, prog, parsed, cwd, ctx, v);
    return;
  }
  if (DOWNLOADERS.has(prog)) {
    judgeDownloader(cmd, prog, cwd, ctx, v);
    return;
  }
  if (NET_RAW.has(prog)) {
    v.add("high", `${prog} opens raw network connections (a way to send files out or take commands in)`);
    return;
  }
  if (DISK_TOOLS.has(prog) || prog.startsWith("mkfs.")) {
    v.add("high", `${prog} can destroy a disk's contents`);
    return;
  }
  if (POWER.has(prog)) {
    v.add("high", `${prog} stops or restarts the machine`);
    return;
  }
  switch (prog) {
    case "rm":
    case "rmdir":
    case "unlink":
      judgeRm(cmd, prog, parsed, cwd, ctx, v);
      return;
    case "truncate":
    case "touch":
    case "mkdir":
      // Their targets are writes: `truncate -s 0 /etc/passwd` is `> /etc/passwd`.
      for (const t of operandsAfter(cmd, prog === "truncate" ? ["-s", "-r", "--size", "--reference"] : prog === "touch" ? ["-d", "-r", "-t", "--date", "--reference"] : ["-m", "--mode", "--context"])) {
        judgeWrite(resolvePath(t, cwd, ctx), t, ctx, v, `${prog} writes`);
      }
      return;
    case "dd":
      judgeDd(cmd, cwd, ctx, v);
      return;
    case "chmod":
    case "chown":
    case "chgrp":
      judgePermissions(cmd, prog, cwd, ctx, v);
      return;
    case "mv":
    case "cp":
    case "ln":
    case "install":
    case "rsync":
    case "scp":
      judgeCopy(cmd, prog, cwd, ctx, v);
      return;
    case "tee":
      for (const w of positionals(cmd)) judgeWrite(resolvePath(w, cwd, ctx), w, ctx, v, "tee writes");
      return;
    case "git":
      judgeGit(cmd, cwd, ctx, v);
      return;
    case "find":
      judgeFind(cmd, parsed, cwd, ctx, v);
      return;
    case "sed":
      judgeSed(cmd, parsed, cwd, ctx, v);
      return;
    case "awk":
    case "gawk":
    case "mawk":
    case "nawk":
      judgeAwk(cmd, parsed, cwd, ctx, v);
      return;
    case "kill":
    case "pkill":
    case "killall":
      judgeKill(cmd, prog, v);
      return;
    case "env":
    case "printenv":
    case "set":
    case "export":
      // Printed, the environment hands over whatever secrets it holds.
      v.add("medium", `${prog} prints the environment, which may hold secrets`);
      return;
    case "crontab":
    case "at":
    case "batch":
    case "launchctl":
    case "systemctl": {
      // Scheduling or installing something to run later is as lasting as a start-up file.
      const sub = positionals(cmd)[0]?.value ?? "";
      const lasting =
        prog === "at" || prog === "batch" ||
        (prog === "crontab" && !flags(cmd).includes("-l")) ||
        (prog === "systemctl" && ["enable", "link", "edit", "set-environment", "import-environment", "preset", "reenable", "set-property", "add-wants", "add-requires"].includes(sub)) ||
        (prog === "launchctl" && ["load", "bootstrap", "enable", "submit", "setenv"].includes(sub));
      v.add(lasting ? "high" : "medium", `${prog} changes what runs on the machine later`);
      return;
    }
    case "history":
      v.add("medium", "history changes the shell's history");
      return;
    case "ssh":
      judgeSsh(cmd, v);
      return;
    case "tar": {
      // A command tar is told to run: `--to-command`, `--checkpoint-action=exec=…`, `-I prog`, `-F script`.
      const first = cmd.argv[1]?.value ?? "";
      const runs =
        flags(cmd).some((f) => /^--(to-command|checkpoint-action|use-compress-program|rsh-command|rmt-command|info-script|new-volume-script)/.test(f) || /^-[a-zA-Z]*[IF]/.test(f)) ||
        (!first.startsWith("-") && /[IF]/.test(first));
      v.add(runs ? "unknown" : "medium", runs ? "tar runs a command it is given" : "runs tar");
      return;
    }
    case "sort":
      if (hasFlag(cmd, "o", "--output")) v.add("medium", "sort writes a file");
      if (flags(cmd).some((f) => f.startsWith("--compress-program"))) v.add("medium", "sort runs the compression program it is given");
      judgeReader(cmd, prog, parsed, cwd, ctx, v);
      return;
    case "xxd":
      // `xxd in out`, `xxd -r in out`: the second operand is written.
      for (const t of operandsAfter(cmd, ["-c", "-g", "-l", "-o", "-s", "-n", "-C", "--cols", "--groupsize", "--len", "--offset", "--seek", "--name"]).slice(1, 2)) {
        judgeWrite(resolvePath(t, cwd, ctx), t, ctx, v, "xxd writes");
      }
      judgeReader(cmd, prog, parsed, cwd, ctx, v);
      return;
    case "tree": {
      const o = cmd.argv.findIndex((w) => w.value === "-o");
      if (o > 0 && cmd.argv[o + 1]) judgeWrite(resolvePath(cmd.argv[o + 1]!, cwd, ctx), cmd.argv[o + 1]!, ctx, v, "tree writes");
      judgeReader(cmd, prog, parsed, cwd, ctx, v);
      return;
    }
    case "rg":
      if (flags(cmd).some((f) => /^--pre(=|$)/.test(f))) v.add("medium", "rg runs the preprocessor it is given on each file");
      judgeReader(cmd, prog, parsed, cwd, ctx, v);
      return;
    case "jq":
      if (cmd.argv.slice(1).some((w) => /\$ENV\b|\benv\b/.test(w.value ?? ""))) v.add("medium", "jq prints the environment, which may hold secrets");
      judgeReader(cmd, prog, parsed, cwd, ctx, v);
      return;
    case "uniq":
      if (positionals(cmd).length >= 2) v.add("medium", "uniq writes a file");
      judgeReader(cmd, prog, parsed, cwd, ctx, v);
      return;
    case "hostname":
      if (positionals(cmd).length > 0 || hasFlag(cmd, "s", "--set")) v.add("high", `${prog} changes the machine's settings`);
      else judgeReader(cmd, prog, parsed, cwd, ctx, v);
      return;
    case "date":
      if (dateSets(cmd)) v.add("high", "date changes the machine's clock");
      else judgeReader(cmd, prog, parsed, cwd, ctx, v);
      return;
  }
  if (READERS.has(prog)) {
    judgeReader(cmd, prog, parsed, cwd, ctx, v);
    return;
  }
  v.add("medium", `runs ${prog}`);
}

/** `date -s …`, `date --set=…` or `date MMDDhhmm…` sets the clock; `+FORMAT`, `-d DATE` and `-r FILE` only read. */
function dateSets(cmd: SimpleCommand): boolean {
  const args = cmd.argv.slice(1);
  for (let i = 0; i < args.length; i++) {
    const x = args[i]!.value;
    // A run-time operand could be a time to set; a format starts with `+`.
    if (x === null) {
      if (!/^["']?\+/.test(args[i]!.raw)) return true;
    } else if (/^--set(=|$)/.test(x)) return true;
    else if (x === "--date" || x === "--reference" || x === "--file") i++;
    else if (/^-[a-zA-Z]/.test(x)) {
      // A cluster: `-s` sets; `-d`, `-r`, `-f` take a value, `-I` an attached format.
      for (const c of x.slice(1)) {
        if (c === "s") return true;
        if (c === "I") break;
        if (c === "d" || c === "r" || c === "f") {
          if (x.endsWith(c)) i++;
          break;
        }
      }
    } else if (/^\d{4,}(\.\d{2})?$/.test(x)) return true;
  }
  return false;
}

/** Readers whose arguments are never files they read (`echo`, `tr`'s sets). */
const NOT_FILES = new Set(["echo", "printf", "tr", "true", "false", "seq", "sleep", "basename", "dirname", "which", "whereis", "type"]);

/** A read-only program: low inside the workspace, medium for anything it names outside. */
function judgeReader(cmd: SimpleCommand, prog: string, parsed: ParsedShell, cwd: string | null, ctx: Ctx, v: Verdict): void {
  // `--files0-from=F`: the files are whatever F lists.
  if (flags(cmd).some((f) => f.startsWith("--files0-from"))) v.add("medium", `${prog} reads the files a list names`);
  for (const w of cmd.argv.slice(1)) {
    // find -exec's `{}` is a match under find's roots; xargs's input is
    // whatever the words it splits name, anywhere.
    if (w.input && cmd.inputFrom !== undefined && rootsInside(parsed.commands[cmd.inputFrom], cwd, ctx)) continue;
    if (w.value === null && w.home === undefined && !NOT_FILES.has(prog)) {
      v.add("medium", `${prog} reads ${w.input ? "files it is given at run time" : `${w.raw}, a path only known at run time`}`);
      continue;
    }
    for (const p of pathLike(w)) {
      const abs = resolvePath(p, cwd, ctx);
      if (isCredentialPath(abs, ctx)) {
        v.add("high", `${prog} reads ${abs}, a credential file`);
        continue;
      }
      const at = where(abs, ctx);
      if (at !== "workspace" && abs !== "/dev/null") v.add("medium", `${prog} reads ${abs ?? p.raw}, outside the workspace`);
    }
    // A bare name is a file in the directory it runs in: `cd ~/.ssh; cat id_rsa`.
    if (cwd !== null && pathLike(w).length === 0 && fileWords(w).length > 0 && isCredentialPath(resolvePath(w, cwd, ctx), ctx)) {
      v.add("high", `${prog} reads ${resolvePath(w, cwd, ctx)}, a credential file`);
    }
  }
  if ((cwd === null || !insideOf(cwd, ctx.workdir)) && !NOT_FILES.has(prog)) {
    v.add("medium", cwd === null ? `${prog} runs in a directory only known at run time` : `${prog} runs in ${cwd}, outside the workspace`);
  }
}

function judgeRedirects(cmd: SimpleCommand, cwd: string | null, ctx: Ctx, v: Verdict): void {
  for (const r of cmd.redirects) {
    if (!r.target) continue;
    // `2>&1`, `>&2`: a descriptor, not a file.
    if ((r.op === ">&" || r.op === "<&") && /^\d+$|^-$/.test(r.target.value ?? "")) continue;
    const abs = resolvePath(r.target, cwd, ctx);
    if (r.op.startsWith(">") || r.op === "&>" || r.op === "&>>" || r.op === "<>") {
      judgeWrite(abs, r.target, ctx, v, "writes");
    } else if (r.op === "<") {
      if (isCredentialPath(abs, ctx)) v.add("high", `reads ${abs}, a credential file`);
      else if (where(abs, ctx) !== "workspace") v.add("medium", `reads ${abs ?? r.target.raw}, outside the workspace`);
    }
  }
}

function judgeWrite(abs: string | null, w: ShellWord, ctx: Ctx, v: Verdict, what: string): void {
  if (abs === "/dev/null" || abs === "/dev/stdout" || abs === "/dev/stderr" || abs === "/dev/tty") return;
  const at = where(abs, ctx);
  if (at === "system" || at === "root" || at === "home-sensitive") v.add("high", `${what} ${abs}, a system or start-up file`);
  else if (at === "unknown") v.add("medium", `${what} ${w.raw}, a path only known at run time`);
  else if (at === "workspace") v.add("medium", `${what} ${abs} in the workspace`);
  else v.add("medium", `${what} ${abs}, outside the workspace`);
}

function judgeRm(cmd: SimpleCommand, prog: string, parsed: ParsedShell, cwd: string | null, ctx: Ctx, v: Verdict): void {
  const recursive = prog === "rm" && (hasFlag(cmd, "r", "--recursive") || hasFlag(cmd, "R"));
  const targets = positionals(cmd);
  if (targets.length === 0) {
    v.add("medium", `${prog} deletes files`);
    return;
  }
  for (const t of targets) {
    // What find or xargs hands it: a delete of whatever the search outside the workspace found.
    if (t.input) {
      const from = inputSource(cmd, parsed, cwd, ctx);
      if (from !== null) {
        v.add(from === "workspace" ? "medium" : "high", `${prog} deletes files ${from === "workspace" ? "a search in the workspace finds" : "found outside the workspace"}`);
        continue;
      }
    }
    const abs = resolvePath(t, cwd, ctx);
    const at = where(abs, ctx);
    const precious = abs !== null && (abs === ctx.workdir || abs === join(ctx.workdir, ".git") || insideOf(abs, join(ctx.workdir, ".git")));
    if (at === "root" || at === "system" || at === "home" || at === "home-sensitive") {
      v.add("high", `${prog} deletes ${abs}${recursive ? " and everything under it" : ""}`);
    } else if (precious) {
      v.add("high", `${prog} deletes ${abs === ctx.workdir ? "the whole workspace" : "the repository's history (.git)"}`);
    } else if (at === "unknown") {
      const why = t.value === null ? "a path only known at run time" : "relative to a directory outside the workspace";
      v.add(recursive ? "high" : "medium", `${prog} deletes ${t.raw}, ${why}${recursive ? ", recursively" : ""}`);
    } else if (at === "outside") {
      v.add(recursive ? "high" : "medium", `${prog} deletes ${abs}, outside the workspace${recursive ? ", recursively" : ""}`);
    } else {
      v.add("medium", `${prog} deletes ${abs} in the workspace`);
    }
  }
}

/**
 * Where the paths find or xargs hands a command come from: "workspace" when
 * every search root, or every path the earlier pipeline stages name, is in
 * it; "outside" when one isn't; null when there's nothing to tell by.
 */
function inputSource(cmd: SimpleCommand, parsed: ParsedShell, cwd: string | null, ctx: Ctx): "workspace" | "outside" | null {
  if (cmd.inputFrom !== undefined) {
    const find = parsed.commands[cmd.inputFrom];
    return find && rootsInside(find, cwd, ctx) ? "workspace" : "outside";
  }
  const feeders = parsed.commands.filter((c) => c.pipeline === cmd.pipeline && c.stage < cmd.stage);
  const named = feeders.flatMap((c) => (programOf(c) === "find" ? findRoots(c) : c.argv.slice(1).flatMap(pathLike)));
  if (named.some((w) => where(resolvePath(w, cwd, ctx), ctx) !== "workspace")) return "outside";
  return null;
}

/** A command's operands, skipping the values of the options listed. */
function operandsAfter(cmd: SimpleCommand, withValue: string[]): ShellWord[] {
  const args = cmd.argv.slice(1);
  const out: ShellWord[] = [];
  for (let i = 0; i < args.length; i++) {
    const x = args[i]!.value;
    if (x === "--") return [...out, ...args.slice(i + 1)];
    if (x !== null && x.startsWith("-") && x !== "-") {
      if (withValue.includes(x)) i++;
      continue;
    }
    out.push(args[i]!);
  }
  return out;
}

function judgeDd(cmd: SimpleCommand, cwd: string | null, ctx: Ctx, v: Verdict): void {
  const of = cmd.argv.slice(1).find((w) => w.value?.startsWith("of="));
  if (!of) {
    v.add("medium", "dd copies raw data");
    return;
  }
  const target: ShellWord = { ...of, value: of.value!.slice(3) };
  const abs = resolvePath(target, cwd, ctx);
  if (abs?.startsWith("/dev/") && abs !== "/dev/null") v.add("high", `dd writes straight onto ${abs}`);
  else judgeWrite(abs, target, ctx, v, "dd writes");
}

function judgePermissions(cmd: SimpleCommand, prog: string, cwd: string | null, ctx: Ctx, v: Verdict): void {
  const recursive = hasFlag(cmd, "R", "--recursive");
  const args = positionals(cmd);
  const mode = prog === "chmod" ? args[0]?.value : null;
  if (mode && /(^|[^-])[ugoa]*\+[rwxXt]*s|^[2467]\d{3}$/.test(mode)) v.add("high", "chmod sets a setuid/setgid bit");
  for (const t of args.slice(1)) {
    const abs = resolvePath(t, cwd, ctx);
    const at = where(abs, ctx);
    if (at === "root" || at === "system" || at === "home" || at === "home-sensitive") v.add("high", `${prog} changes ${abs}${recursive ? " and everything under it" : ""}`);
    else if (at !== "workspace") v.add(recursive ? "high" : "medium", `${prog} changes ${abs ?? t.raw}, outside the workspace`);
    else v.add("medium", `${prog} changes ${abs}`);
  }
}

function judgeCopy(cmd: SimpleCommand, prog: string, cwd: string | null, ctx: Ctx, v: Verdict): void {
  let args = positionals(cmd);
  const remote = (w: ShellWord) => w.value !== null && /^[^/]*:/.test(w.value) && !w.value.startsWith("./");
  if ((prog === "scp" || prog === "rsync") && args.some(remote)) {
    v.add(args.at(-1) && remote(args.at(-1)!) ? "high" : "medium", `${prog} copies over the network`);
  }
  // `cp -t DIR src…`, `--target-directory=DIR`: the target comes first.
  const all = cmd.argv.slice(1);
  const t = all.findIndex((w) => w.value === "-t" || w.value === "--target-directory" || /^(-t.|--target-directory=)/.test(w.value ?? ""));
  if (t >= 0 && prog !== "rsync" && prog !== "scp") {
    const x = all[t]!.value!;
    const dirWord = x === "-t" || x === "--target-directory" ? all[t + 1] : { ...all[t]!, value: x.startsWith("-t") ? x.slice(2) : x.slice(x.indexOf("=") + 1) };
    args = args.filter((w) => w !== all[t + 1]);
    if (dirWord) args = [...args, dirWord];
  }
  const target = args.at(-1);
  // rsync --delete removes whatever the target has that the source doesn't.
  if (prog === "rsync" && target && !remote(target) && flags(cmd).some((f) => f.startsWith("--delete") || f === "--remove-source-files")) {
    const at = where(resolvePath(target, cwd, ctx), ctx);
    v.add(at === "workspace" ? "medium" : "high", `rsync deletes files under ${resolvePath(target, cwd, ctx) ?? target.raw}`);
  }
  if (!target) {
    v.add("medium", `runs ${prog}`);
    return;
  }
  for (const src of args.slice(0, -1)) {
    const abs = resolvePath(src, cwd, ctx);
    if (isCredentialPath(abs, ctx)) v.add("high", `${prog} copies ${abs}, a credential file`);
    if (prog === "mv" && where(abs, ctx) !== "workspace") v.add(where(abs, ctx) === "system" || where(abs, ctx) === "home-sensitive" ? "high" : "medium", `mv moves ${abs ?? src.raw} away from where it was`);
  }
  if (!remote(target)) judgeWrite(resolvePath(target, cwd, ctx), target, ctx, v, `${prog} writes`);
}

function judgeInterpreter(cmd: SimpleCommand, prog: string, parsed: ParsedShell, cwd: string | null, ctx: Ctx, v: Verdict): void {
  const index = parsed.commands.indexOf(cmd);
  // Fed by a download: `curl … | sh`, `sh <(curl …)`, `source <(wget …)`.
  const fedByDownload =
    parsed.commands.some((c) => c.pipeline === cmd.pipeline && c.stage < cmd.stage && DOWNLOADERS.has(programOf(c) ?? "")) ||
    parsed.commands.some((c) => c.feeds === index && c.substitution !== null && DOWNLOADERS.has(programOf(c) ?? ""));
  if (fedByDownload) {
    v.add("high", `${prog} runs code downloaded from the internet`);
    return;
  }
  if (cmd.stdinScript) {
    // A shell running its input: judged as the script when the line holds
    // it (`echo '…' | sh`, `cat <<EOF | sh`), and not understood otherwise.
    const script = fedText(cmd, parsed);
    if (script === null) v.add("unknown", `${prog} runs a script it reads from its input`);
    else judgeLine(parseShellSync(script), cwd, ctx, v);
    return;
  }
  v.add("medium", `${prog} runs code`);
}

/** The text the stage before cmd writes, when the line holds it: a plain `echo`, a `printf` of plain text, a `cat` of a here-document. */
function fedText(cmd: SimpleCommand, parsed: ParsedShell): string | null {
  if (cmd.stage === 0) return null;
  const feeders = parsed.commands.filter((c) => c.pipeline === cmd.pipeline && c.stage === cmd.stage - 1);
  const f = feeders[0];
  if (feeders.length !== 1 || !f || f.via.length > 0 || f.delegates) return null;
  if (f.redirects.some((r) => r.op.startsWith(">") || r.op === "&>" || r.op === "&>>")) return null;
  const args = f.argv.slice(1);
  const values = args.map((w) => w.value);
  if (values.some((x) => x === null)) return null;
  const prog = programOf(f);
  if (prog === "echo" && !values[0]?.startsWith("-")) return values.join(" ");
  if (prog === "printf" && values.length === 1 && !/^-|[%\\]/.test(values[0]!)) return values[0]!;
  if (prog === "cat" && args.length === 0) {
    const last = f.redirects.filter((r) => (r.fd === null || r.fd === 0) && r.op.startsWith("<<")).at(-1);
    if (!last) return null;
    return last.op === "<<<" ? (last.target?.value ?? null) : (last.body ?? null);
  }
  return null;
}

/** Downloader options naming a file it writes, short and long. */
const DOWNLOAD_OUTPUT: Record<string, { short: string; long: RegExp }> = {
  curl: { short: "oDc", long: /^--(output|output-dir|dump-header|cookie-jar|trace|trace-ascii|stderr)$/ },
  wget: { short: "OoaP", long: /^--(output-document|output-file|append-output|directory-prefix)$/ },
};

function judgeDownloader(cmd: SimpleCommand, prog: string, cwd: string | null, ctx: Ctx, v: Verdict): void {
  // What it writes: `curl -o ~/.bashrc …`, `wget -qO ~/.local/bin/ls …`.
  const out = DOWNLOAD_OUTPUT[prog];
  const args = cmd.argv.slice(1);
  for (let i = 0; out && i < args.length; i++) {
    const x = args[i]!.value;
    if (x === null || !x.startsWith("-") || x === "-") continue;
    let target: ShellWord | undefined;
    if (x.startsWith("--")) {
      const eq = x.indexOf("=");
      if (out.long.test(eq < 0 ? x : x.slice(0, eq))) target = eq < 0 ? args[++i] : { ...args[i]!, value: x.slice(eq + 1) };
    } else {
      const k = [...x.slice(1)].findIndex((c) => out.short.includes(c));
      if (k >= 0) target = x.length > k + 2 ? { ...args[i]!, value: x.slice(k + 2) } : args[++i];
    }
    if (target && target.value !== "-") judgeWrite(resolvePath(target, cwd, ctx), target, ctx, v, `${prog} writes`);
  }
  // A word only known at run time is read as written: `-d @"$F"` still sends a file.
  const words = cmd.argv.slice(1).map((w) => w.value ?? w.raw.replace(/^["']/, ""));
  // Sends a local file out: `-d @f`, `--data-binary @f`, `-F x=@f`, `-T f`, `--upload-file`, `--post-file`.
  const sendsFile = words.some(
    (w, i) =>
      w.startsWith("@") ||
      /^-[dF]@/.test(w) ||
      /^--(data|data-binary|data-urlencode|form|data-raw)=.*@/.test(w) ||
      /^-F.*=@/.test(w) ||
      w === "-T" ||
      w === "--upload-file" ||
      w.startsWith("--upload-file=") ||
      w.startsWith("--post-file") ||
      w.startsWith("--body-file") ||
      ((w === "-F" || w === "--form") && /=@|=</.test(words[i + 1] ?? "")),
  );
  if (sendsFile) v.add("high", `${prog} uploads a local file`);
  else v.add("medium", `${prog} fetches from the network`);
}

/** ssh options that take a value. */
const SSH_VALUE = new Set(["-b", "-B", "-c", "-D", "-E", "-e", "-F", "-I", "-i", "-J", "-L", "-l", "-m", "-O", "-o", "-p", "-P", "-Q", "-R", "-S", "-W", "-w"]);

/** ssh: a connection is medium; a command it runs, here (`ProxyCommand`, a config file) or there, isn't understood. */
function judgeSsh(cmd: SimpleCommand, v: Verdict): void {
  const args = cmd.argv.slice(1);
  const operands: ShellWord[] = [];
  for (let i = 0; i < args.length; i++) {
    const x = args[i]!.value;
    if (x === null) {
      v.add("unknown", "ssh's arguments are only known at run time");
      return;
    }
    if (operands.length > 0 || x === "--" || !x.startsWith("-")) {
      if (x !== "--") operands.push(args[i]!);
      continue;
    }
    // A cluster (`-vo X`) gives the value to its first option that takes one.
    const k = [...x.slice(1)].findIndex((c) => SSH_VALUE.has(`-${c}`));
    if (k < 0) continue;
    const opt = `-${x[k + 1]}`;
    const value = x.length > k + 2 ? x.slice(k + 2) : (args[++i]?.value ?? null);
    if ((opt === "-o" &&(value === null || /^\s*(proxycommand|localcommand|permitlocalcommand|knownhostscommand|proxyusefdpass|match)/i.test(value))) || opt === "-F") {
      v.add("unknown", "ssh runs a local command its options name");
      return;
    }
  }
  if (operands.length > 1) v.add("unknown", "ssh runs a command on another machine");
  else v.add("medium", "ssh connects to another machine");
}

function judgeKill(cmd: SimpleCommand, prog: string, v: Verdict): void {
  const all = positionals(cmd).some((w) => w.value === "-1" || w.value === "1") || cmd.argv.some((w) => w.value === "-1");
  if (prog === "kill" && all) v.add("high", "kill signals every process (or init)");
  else v.add("medium", `${prog} stops processes`);
}

/** `git branch` options that only list. */
const BRANCH_LIST_FLAGS = /^(-a|-r|-v|-vv|-l|--all|--remotes|--list|--show-current|--verbose|--(no-)?column|--(sort|format|contains|no-contains|merged|no-merged|points-at)=.+|--color(=.+)?)$/;

/** git: reads are low, changes medium, rewriting shared history or force-pushing high. */
const GIT_READS = new Set([
  "status", "log", "diff", "show", "rev-parse", "ls-files", "ls-tree", "blame", "describe", "shortlog", "grep", "cat-file",
  "show-ref", "merge-base", "name-rev", "rev-list", "count-objects", "check-ignore", "version", "help", "whatchanged", "annotate",
  "for-each-ref", "ls-remote", "var", "cherry", "range-diff",
]);

function judgeGit(cmd: SimpleCommand, cwd: string | null, ctx: Ctx, v: Verdict): void {
  const args = cmd.argv.slice(1);
  let i = 0;
  let dir = cwd;
  // Global options before the subcommand.
  for (; i < args.length; i++) {
    const a = args[i]!.value;
    if (a === null) {
      v.add("unknown", "git's arguments are only known at run time");
      return;
    }
    if (!a.startsWith("-")) break;
    if (a === "-C") {
      dir = resolvePath(args[++i] ?? { value: null, raw: "", glob: false }, cwd, ctx);
    } else if (a === "-c" || a.startsWith("--config-env")) {
      // A config override can name a program to run (core.pager, core.sshCommand, alias.*).
      v.add("medium", "git runs with a configuration override");
      if (a === "-c") i++;
    } else if (/^--(git-dir|work-tree|namespace|exec-path)(=|$)/.test(a)) {
      if (!a.includes("=") && a !== "--exec-path") i++;
      v.add("medium", `git ${a.replace(/=.*/, "")} points it somewhere else`);
    }
  }
  const sub = args[i]?.value;
  const rest = args.slice(i + 1);
  const restValues = rest.map((w) => w.value ?? "");
  const inWorkspace = dir !== null && insideOf(dir, ctx.workdir);
  if (!sub) {
    v.add("low", "git");
    return;
  }
  if (sub === "push") {
    const force = restValues.some((x) => x === "-f" || x === "--force" || x.startsWith("--force-with-lease") || x === "--force-if-includes" || x === "--mirror" || x === "--delete" || x === "-d" || x === "--prune" || (/^\+/.test(x) && x.length > 1) || /^:./.test(x) || /^-[a-zA-Z]*f/.test(x) && !x.startsWith("--"));
    v.add(force ? "high" : "medium", force ? "git push rewrites or deletes history on a remote" : "git push publishes commits to a remote");
    return;
  }
  // `git config --global core.fsmonitor …`: the user's own git config, as `>> ~/.gitconfig` is.
  const configReads = ["--get", "--get-all", "--list", "-l", "--get-regexp", "--get-urlmatch", "--show-origin", "--show-scope"];
  if (sub === "config" && restValues.some((x) => /^(--global|--system|--file|-f$|--file=)/.test(x)) && !restValues.some((x) => configReads.includes(x))) {
    v.add("high", "git config changes git's configuration outside the repository");
    return;
  }
  if (sub === "filter-branch" || sub === "filter-repo" || (sub === "update-ref" && restValues.includes("-d"))) {
    v.add("high", `git ${sub} rewrites the repository's history`);
    return;
  }
  if (sub === "reset" && restValues.includes("--hard")) {
    v.add("medium", "git reset --hard discards uncommitted work");
    return;
  }
  if (sub === "clean" && restValues.some((x) => /^-[a-zA-Z]*f/.test(x) || x === "--force")) {
    v.add("medium", "git clean deletes untracked files");
    return;
  }
  const readOnly =
    GIT_READS.has(sub) ||
    (sub === "branch" && rest.every((w) => w.value !== null && BRANCH_LIST_FLAGS.test(w.value))) ||
    (sub === "remote" && (rest.length === 0 || ["-v", "--verbose", "show", "get-url"].includes(restValues[0] ?? ""))) ||
    (sub === "tag" && (rest.length === 0 || restValues.every((x) => x === "-l" || x === "--list" || x.startsWith("--sort") || x.startsWith("--contains") || x === "-n"))) ||
    (sub === "config" && restValues.some((x) => x === "--get" || x === "--get-all" || x === "--list" || x === "-l" || x === "--get-regexp")) ||
    (sub === "stash" && (restValues[0] === "list" || restValues[0] === "show")) ||
    (sub === "worktree" && restValues[0] === "list") ||
    (sub === "reflog" && (rest.length === 0 || restValues[0] === "show")) ||
    (sub === "notes" && (rest.length === 0 || restValues[0] === "list" || restValues[0] === "show"));
  if (readOnly) {
    if (!inWorkspace) v.add("medium", `git ${sub} reads a repository outside the workspace`);
    // A program it's told to run: `--upload-pack`, `grep -O`/`--open-files-in-pager`, `--ext-diff`.
    if (restValues.some((x) => /^--(upload-pack|receive-pack|exec|open-files-in-pager|ext-diff)(=|$)/.test(x) || (sub === "grep" && /^-[a-zA-Z]*O/.test(x)) || (sub === "ls-remote" && x === "-u"))) {
      v.add("medium", `git ${sub} runs a program it is given`);
    }
    if (sub === "ls-remote") v.add("medium", "git ls-remote asks a remote over the network");
    // `git diff --output=f`, `git log --output`: a write.
    if (restValues.some((x) => x.startsWith("--output"))) v.add("medium", `git ${sub} writes a file`);
    for (const w of rest) for (const p of pathLike(w)) {
      const abs = resolvePath(p, dir, ctx);
      if (where(abs, ctx) !== "workspace") v.add("medium", `git ${sub} names ${abs ?? p.raw}, outside the workspace`);
    }
    return;
  }
  v.add("medium", `git ${sub} changes the repository`);
}

function judgeFind(cmd: SimpleCommand, parsed: ParsedShell, cwd: string | null, ctx: Ctx, v: Verdict): void {
  const values = cmd.argv.slice(1).map((w) => w.value ?? "");
  if (values.includes("-delete")) {
    // Deleting whatever matches under the roots: as rm -r on them.
    for (const r of findRoots(cmd)) {
      const abs = resolvePath(r, cwd, ctx);
      const at = where(abs, ctx);
      v.add(at === "workspace" ? "medium" : "high", `find -delete removes files under ${abs ?? r.raw}`);
    }
    return;
  }
  if (values.some((x) => x === "-fprint" || x === "-fprint0" || x === "-fprintf" || x === "-fls")) v.add("medium", "find writes a file");
  // -exec commands are judged where they're listed.
  judgeReader(cmd, "find", parsed, cwd, ctx, v);
}

/** The directories a find searches: the operands before its expression (`.` when none). */
function findRoots(cmd: SimpleCommand): ShellWord[] {
  const args = cmd.argv.slice(1);
  let i = 0;
  // `-H`, `-L`, `-P`, `-D debugopts`, `-O3` come before the roots.
  while (i < args.length && /^-([HLP]|D|O\d*)$/.test(args[i]!.value ?? "")) i += args[i]!.value === "-D" ? 2 : 1;
  const roots: ShellWord[] = [];
  for (; i < args.length; i++) {
    const x = args[i]!.value;
    if (x !== null && (x.startsWith("-") || x === "(" || x === "!")) break;
    roots.push(args[i]!);
  }
  return roots.length > 0 ? roots : [{ value: ".", raw: ".", glob: false }];
}

/** Every root of a search is inside the workspace. */
function rootsInside(find: SimpleCommand | undefined, cwd: string | null, ctx: Ctx): boolean {
  return find !== undefined && findRoots(find).every((r) => where(resolvePath(r, cwd, ctx), ctx) === "workspace");
}

/** A sed script that only prints or substitutes (no `w`, `e`, `r` commands or flags). */
const SAFE_SED = /^(-n\s*)?((\d+|\$)(,(\d+|\$))?)?\s*[pdq]?$|^s(.)(?:(?!\6).)*\6(?:(?!\6).)*\6[gpiI0-9]*$/;

function judgeSed(cmd: SimpleCommand, parsed: ParsedShell, cwd: string | null, ctx: Ctx, v: Verdict): void {
  // Read as sed reads its options: `-e S`, `-eS`, `--expression=S`, `-f F`, `-l N`, `-i[SUFFIX]`, `--in-place[=SUFFIX]`.
  const args = cmd.argv.slice(1);
  const scripts: Array<string | null> = [];
  const operands: ShellWord[] = [];
  let inPlace = false;
  let ended = false;
  for (let i = 0; i < args.length; i++) {
    const x = args[i]!.value;
    if (ended || x === null || !x.startsWith("-") || x === "-") {
      operands.push(args[i]!);
      continue;
    }
    if (x === "--") {
      ended = true;
      continue;
    }
    if (x.startsWith("--")) {
      const eq = x.indexOf("=");
      const name = eq < 0 ? x : x.slice(0, eq);
      const value = () => (eq < 0 ? (args[++i]?.value ?? null) : x.slice(eq + 1));
      if (name === "--expression") scripts.push(value());
      else if (name === "--file") {
        value();
        scripts.push(null);
      }
      else if (name === "--line-length") value();
      else if (name === "--in-place") inPlace = true;
      continue;
    }
    for (let k = 1; k < x.length; k++) {
      const c = x[k];
      if (c === "i") {
        inPlace = true; // the rest is a backup suffix
        break;
      }
      if (c === "e" || c === "f" || c === "l") {
        const value = x.length > k + 1 ? x.slice(k + 1) : (args[++i]?.value ?? null);
        if (c === "e") scripts.push(value);
        else if (c === "f") scripts.push(null);
        break;
      }
    }
  }
  // Without -e / -f, the first operand is the script; the rest are files.
  if (scripts.length === 0) scripts.push(operands.shift()?.value ?? null);
  if (inPlace) {
    v.add("medium", "sed edits files in place");
    for (const t of operands) judgeWrite(resolvePath(t, cwd, ctx), t, ctx, v, "sed edits");
    return;
  }
  if (scripts.some((s) => s === null || !SAFE_SED.test(s.trim()))) v.add("medium", "sed runs a script that may write files or run commands");
  judgeReader({ ...cmd, argv: [cmd.argv[0]!, ...operands] }, "sed", parsed, cwd, ctx, v);
}

/** awk options that take a value; the ones marked load code from elsewhere. */
const AWK_VALUE = new Set(["-v", "-F", "-W", "--assign", "--field-separator"]);
const AWK_CODE = new Set(["-f", "-e", "-i", "-l", "-E", "--file", "--source", "--include", "--load", "--exec"]);

function judgeAwk(cmd: SimpleCommand, parsed: ParsedShell, cwd: string | null, ctx: Ctx, v: Verdict): void {
  // The program is the first operand after the options (`-v x=1`, `-F :` take values); none with -f / -e.
  const args = cmd.argv.slice(1);
  const programs: Array<string | null> = [];
  let elsewhere = false;
  let i = 0;
  for (; i < args.length; i++) {
    const x = args[i]!.value;
    if (x === null || !x.startsWith("-") || x === "-") break;
    if (x === "--") {
      i++;
      break;
    }
    const eq = x.startsWith("--") ? x.indexOf("=") : -1;
    const name = x.startsWith("--") ? (eq < 0 ? x : x.slice(0, eq)) : x.slice(0, 2);
    const attached = x.startsWith("--") ? eq >= 0 : x.length > 2;
    if (AWK_CODE.has(name)) {
      const value = attached ? x.slice(eq >= 0 ? eq + 1 : 2) : (args[++i]?.value ?? null);
      if (name === "-e" || name === "--source") programs.push(value);
      else elsewhere = true;
    } else if (AWK_VALUE.has(name) && !attached) i++;
    else if (/^-[opd]/.test(x) || /^--(pretty-print|profile|dump-variables)/.test(x)) elsewhere = true; // gawk writes a file
  }
  if (!elsewhere && programs.length === 0) programs.push(i < args.length ? args[i++]!.value : null);
  if (elsewhere || programs.some((p) => p === null || /system\s*\(|\||>|getline|close\s*\(|fflush|@load|@include/.test(p))) {
    v.add("medium", "awk runs a program that may write files or run commands");
  }
  judgeReader({ ...cmd, argv: [cmd.argv[0]!, ...args.slice(i)] }, "awk", parsed, cwd, ctx, v);
}
