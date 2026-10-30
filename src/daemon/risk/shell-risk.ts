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
import { loadShellParser, type ParsedShell, parseShellSync, type ShellWord, type SimpleCommand } from "../shell/parse.js";

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
  ".profile",
  ".zshrc",
  ".zprofile",
  ".zshenv",
  ".zlogin",
  ".inputrc",
  ".gitconfig",
  ".git-credentials",
  ".netrc",
  ".npmrc",
  ".pypirc",
  ".local/bin",
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
const ELEVATE = new Set(["sudo", "doas", "su", "pkexec", "runas"]);
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
  // A shell given a script: what the script runs is judged where it's listed.
  if (cmd.delegates) return;

  if (INTERPRETERS.has(prog)) {
    judgeInterpreter(cmd, prog, parsed, cwd, ctx, v);
    return;
  }
  if (DOWNLOADERS.has(prog)) {
    judgeDownloader(cmd, prog, v);
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
      judgeRm(cmd, cwd, ctx, v);
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
    case "launchctl":
    case "systemctl":
      v.add("medium", `${prog} changes what runs on the machine later`);
      return;
    case "history":
      v.add("medium", "history changes the shell's history");
      return;
    case "sort":
      if (hasFlag(cmd, "o", "--output")) v.add("medium", "sort writes a file");
      judgeReader(cmd, prog, parsed, cwd, ctx, v);
      return;
    case "uniq":
      if (positionals(cmd).length >= 2) v.add("medium", "uniq writes a file");
      judgeReader(cmd, prog, parsed, cwd, ctx, v);
      return;
    case "hostname":
    case "date":
      if (positionals(cmd).length > 0 || hasFlag(cmd, "s", "--set")) v.add("high", `${prog} changes the machine's settings`);
      else judgeReader(cmd, prog, parsed, cwd, ctx, v);
      return;
  }
  if (READERS.has(prog)) {
    judgeReader(cmd, prog, parsed, cwd, ctx, v);
    return;
  }
  v.add("medium", `runs ${prog}`);
}

/** Readers whose arguments are never files they read (`echo`, `tr`'s sets). */
const NOT_FILES = new Set(["echo", "printf", "tr", "true", "false", "seq", "sleep", "basename", "dirname", "which", "whereis", "type"]);

/** A read-only program: low inside the workspace, medium for anything it names outside. */
function judgeReader(cmd: SimpleCommand, prog: string, parsed: ParsedShell, cwd: string | null, ctx: Ctx, v: Verdict): void {
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

function judgeRm(cmd: SimpleCommand, cwd: string | null, ctx: Ctx, v: Verdict): void {
  const recursive = hasFlag(cmd, "r", "--recursive") || hasFlag(cmd, "R");
  const targets = positionals(cmd);
  if (targets.length === 0) {
    v.add("medium", "rm deletes files");
    return;
  }
  for (const t of targets) {
    const abs = resolvePath(t, cwd, ctx);
    const at = where(abs, ctx);
    const precious = abs !== null && (abs === ctx.workdir || abs === join(ctx.workdir, ".git") || insideOf(abs, join(ctx.workdir, ".git")));
    if (at === "root" || at === "system" || at === "home" || at === "home-sensitive") {
      v.add("high", `rm deletes ${abs}${recursive ? " and everything under it" : ""}`);
    } else if (precious) {
      v.add("high", `rm deletes ${abs === ctx.workdir ? "the whole workspace" : "the repository's history (.git)"}`);
    } else if (at === "unknown") {
      const why = t.value === null ? "a path only known at run time" : "relative to a directory outside the workspace";
      v.add(recursive ? "high" : "medium", `rm deletes ${t.raw}, ${why}${recursive ? ", recursively" : ""}`);
    } else if (at === "outside") {
      v.add(recursive ? "high" : "medium", `rm deletes ${abs}, outside the workspace${recursive ? ", recursively" : ""}`);
    } else {
      v.add("medium", `rm deletes ${abs} in the workspace`);
    }
  }
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
  const args = positionals(cmd);
  const remote = (w: ShellWord) => w.value !== null && /^[^/]*:/.test(w.value) && !w.value.startsWith("./");
  if ((prog === "scp" || prog === "rsync") && args.some(remote)) {
    v.add(args.at(-1) && remote(args.at(-1)!) ? "high" : "medium", `${prog} copies over the network`);
  }
  const target = args.at(-1);
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

function judgeDownloader(cmd: SimpleCommand, prog: string, v: Verdict): void {
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
    } else if (a === "--git-dir" || a === "--work-tree" || a === "--namespace" || a === "--exec-path") {
      i++;
      v.add("medium", `git ${a} points it somewhere else`);
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
    const force = restValues.some((x) => x === "-f" || x === "--force" || x.startsWith("--force-with-lease") || x === "--force-if-includes" || x === "--mirror" || x === "--delete" || x === "-d" || x === "--prune" || (/^\+/.test(x) && x.length > 1) || /^-[a-zA-Z]*f/.test(x) && !x.startsWith("--"));
    v.add(force ? "high" : "medium", force ? "git push rewrites or deletes history on a remote" : "git push publishes commits to a remote");
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
  if (hasFlag(cmd, "i", "--in-place")) {
    v.add("medium", "sed edits files in place");
    for (const t of positionals(cmd).slice(1)) judgeWrite(resolvePath(t, cwd, ctx), t, ctx, v, "sed edits");
    return;
  }
  const values = cmd.argv.slice(1);
  const scripts: Array<string | null> = [];
  for (let i = 0; i < values.length; i++) {
    const x = values[i]!.value;
    if (x === "-e" || x === "--expression") scripts.push(values[++i]?.value ?? null);
    else if (x === "-f" || x === "--file") scripts.push(null);
  }
  // Without -e / -f, the first operand is the script; the rest are files.
  const inline = scripts.length === 0;
  if (inline) scripts.push(positionals(cmd)[0]?.value ?? null);
  if (scripts.some((s) => s === null || !SAFE_SED.test(s.trim()))) v.add("medium", "sed runs a script that may write files or run commands");
  judgeReader({ ...cmd, argv: [cmd.argv[0]!, ...positionals(cmd).slice(inline ? 1 : 0)] }, "sed", parsed, cwd, ctx, v);
}

function judgeAwk(cmd: SimpleCommand, parsed: ParsedShell, cwd: string | null, ctx: Ctx, v: Verdict): void {
  const program = positionals(cmd)[0]?.value ?? null;
  if (hasFlag(cmd, "f") || program === null || /system\s*\(|\||>|getline|close\s*\(|fflush/.test(program)) {
    v.add("medium", "awk runs a program that may write files or run commands");
  }
  judgeReader({ ...cmd, argv: [cmd.argv[0]!, ...positionals(cmd).slice(1)] }, "awk", parsed, cwd, ctx, v);
}
