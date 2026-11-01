/**
 * How risky a shell command line is (#431), judged from reading it
 * (src/daemon/shell/parse.ts), not from the tool's name. This is guidance,
 * not a sandbox: a command can be written in ways the reader doesn't
 * recognise, so `high`, `unknown` and a refused credential file are a best
 * effort. Only `low` is a promise, and it is kept by being an allow-list.
 *
 * - `low`: a plain read inside the workspace, of a shape vetted for it
 *   (notLow): `git status`, `ls -la`, `grep -rn foo src | head`. Anything
 *   unusual (a `cd`, a variable, a loop, a wrapper, an option that runs or
 *   writes) simply isn't low.
 * - `medium`: everything else that isn't high or unknown: changes something,
 *   runs code, reaches outside the workspace, or isn't of a vetted shape —
 *   `npm test`, `echo x > f`, `git commit`, `cat /etc/hosts`, `cd src && ls`.
 * - `high`: hard or impossible to undo, or a classic way to lose data or
 *   credentials — `rm -rf ~`, `git push --force`, `curl … | sh`, writes to
 *   system paths or shell start-up files, credential reads, `sudo`.
 * - `unknown`: the line can't be read with certainty (a syntax error, a
 *   program or script only known at run time, a value set to code that
 *   arithmetic evaluates).
 *
 * A command that names one of codeoid's own credential files, or another
 * agent's login, as the reader sees it, is refused (`deny`), as the file
 * tools are.
 */
import { homedir, userInfo } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { isProcSecretPath, kernelPath, secretDirsOf, secretPathVerdict } from "../secret-paths.js";
import {
  loadShellParser,
  type ParsedShell,
  parseShellSync,
  SHAPE_ANY,
  SHAPE_ONE,
  SHAPE_STAR,
  type ShellAssignment,
  type ShellRedirect,
  type ShellWord,
  type SimpleCommand,
  wordShape,
} from "../shell/parse.js";

export type RiskLevel = "low" | "medium" | "high" | "unknown";

export interface ShellRisk {
  level: RiskLevel;
  /** Why, most serious first; empty for low. */
  reasons: string[];
  /** A credential file the line names: refused (`deny`) or asked about (`ask`), whatever the level. */
  secret?: { action: "deny" | "ask"; path: string };
  /**
   * Nothing of the command could be read (the parser isn't there, the line is
   * too long, the call holds no command): it asks even where `unknown` is
   * let through (`approvals.askOnUnknown: false`).
   */
  unreadable?: true;
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
  // Low is an allow-list: what the rules above found harmless is low only if
  // every part of the line is of a shape vetted as a plain read.
  if (v.level === "low") {
    const why = notLow(parsed, ctx);
    if (why) v.add("medium", `not a plain read: ${why}`);
  }
  return parsed.unreadable ? { ...v.out(), unreadable: true } : v.out();
}

/**
 * Programs a low line may run: read-only ones. The options that make one of
 * them run another program or write (`find -exec`, `rg --pre`, `sed -i`,
 * `sort -o`, `git -c`, …) are refused in lowOptions.
 */
const LOW_PROGRAMS = new Set([
  "ls", "cat", "head", "tail", "wc", "grep", "egrep", "fgrep", "rg", "ag", "fd", "echo", "printf", "pwd", "which", "whereis", "type",
  "file", "stat", "du", "df", "tree", "cut", "tr", "diff", "cmp", "comm", "nl", "tac", "rev", "paste", "column", "fold",
  "fmt", "expand", "unexpand", "md5sum", "sha1sum", "sha224sum", "sha256sum", "sha384sum", "sha512sum", "shasum", "cksum", "b2sum",
  "whoami", "id", "uname", "true", "false", "test", "basename", "dirname", "realpath", "readlink", "seq", "sleep", "jq", "od",
  "hexdump", "xxd", "strings", "date", "uptime", "nproc", "arch", "groups", "locale", "tty", "hostname", "sort", "uniq", "find",
  "sed", "awk", "gawk", "mawk", "nawk", "git",
]);
/** git subcommands that only read the repository (no network, no pager or browser of their own). */
const GIT_LOW = new Set([
  "status", "log", "diff", "show", "rev-parse", "ls-files", "ls-tree", "blame", "describe", "shortlog", "grep", "cat-file",
  "show-ref", "merge-base", "name-rev", "rev-list", "count-objects", "check-ignore", "version", "whatchanged", "annotate",
  "for-each-ref", "var", "cherry", "range-diff",
]);
/** Programs whose arguments are never files: what they're given isn't checked against the workspace. */
const LOW_NOT_FILES = new Set(["echo", "printf", "tr", "true", "false", "seq", "sleep", "basename", "dirname", "which", "whereis", "type", "uname", "whoami", "id", "groups", "nproc", "arch", "uptime", "locale", "tty", "hostname"]);

/**
 * Why a line the rules found harmless still isn't low, or null when it is.
 * Every simple command must run a LOW_PROGRAMS program, by name, with no
 * wrapper and none of the options that make it run or write something;
 * every word must be known before it runs (no `$X`, `$(…)`, arithmetic, or
 * glob that could reach outside); every path must be inside the workspace;
 * and the line may only be commands, pipelines, `&&` / `||` / `;` lists,
 * subshells, `{ … }` and `if`: no `cd`, no assignment, no loop, no
 * `declare`, no `[[ … ]]`. A redirect may only read a file in the workspace,
 * duplicate a descriptor, or write to /dev/null.
 */
function notLow(parsed: ParsedShell, ctx: Ctx): string | null {
  if (parsed.unreadable || parsed.problems.length > 0) return "it isn't fully understood";
  if (parsed.constructs.length > 0) return `it uses ${parsed.constructs[0]}`;
  if (parsed.assignments.length > 0) return `it sets ${parsed.assignments[0]!.name}`;
  if (parsed.arithmetic.length > 0) return `it does arithmetic on a variable (${parsed.arithmetic[0]})`;
  if (where(ctx.cwd, ctx) !== "workspace") return `it runs in ${ctx.cwd}, outside the workspace`;
  for (const cmd of parsed.commands) {
    const why = notLowCommand(cmd, ctx);
    if (why) return why;
  }
  return null;
}

function notLowCommand(cmd: SimpleCommand, ctx: Ctx): string | null {
  const name = cmd.argv[0];
  if (!name || name.value === null) return "a program only known at run time";
  if (cmd.via.length > 0) return `it runs ${name.value} through ${cmd.via[0]}`;
  if (cmd.substitution !== null) return `it runs ${name.value} in a substitution`;
  if (cmd.delegates || cmd.stdinScript || cmd.inputFrom !== undefined) return `${name.value} runs other commands`;
  const prog = name.value;
  if (prog === "cd" || prog === "pushd" || prog === "popd") return `it changes directory (${prog})`;
  if (prog.includes("/")) return `it runs ${prog} by its path`;
  if (!LOW_PROGRAMS.has(prog)) return `${prog} isn't one of the read-only programs`;
  const args = cmd.argv.slice(1);
  for (const w of args) {
    const why = notStatic(w);
    if (why) return why;
  }
  const values = args.map((w) => w.value!);
  const option = lowOptions(prog, values, cmd);
  if (option) return option;
  if (!LOW_NOT_FILES.has(prog)) {
    for (const w of args) {
      for (const p of pathCandidates(w.value!)) {
        const why = outsideWorkspace({ ...w, value: p }, ctx);
        if (why) return `${prog} ${why}`;
      }
    }
  }
  for (const r of cmd.redirects) {
    const why = notLowRedirect(r, ctx);
    if (why) return why;
  }
  return null;
}

/** Why a word isn't known before the line runs, or could name something outside the workspace by expanding. */
function notStatic(w: ShellWord): string | null {
  if (w.value === null || w.input) return `${w.raw} is only known at run time`;
  // bash expands `~` after `=` or `:` in a word that looks like an assignment (`if=~/x`).
  if (/[=:]~/.test(w.value)) return `${w.raw} may expand ~`;
  if (w.glob) {
    // A pattern stays under its fixed directory only without braces,
    // brackets, `..`, `~` and a wildcard that could match a leading dot.
    if (/[{[(~]/.test(w.raw) || /(^|\/)\.\.(\/|$)/.test(w.value) || /(^|\/)\.[^/]*[*?]/.test(w.value)) return `the pattern ${w.raw} could reach outside the workspace`;
  }
  return null;
}

/** The parts of an argument that may be a path: the word, the value after `=`, an attached short-option value. */
function pathCandidates(v: string): string[] {
  if (v === "-" || v === "--") return [];
  if (v.startsWith("-")) {
    const eq = v.indexOf("=");
    if (eq >= 0) return [v.slice(eq + 1)];
    // `-C/x`, `-f~/x`: an attached value that looks like a path.
    return /[/~]/.test(v) ? [v.replace(/^-+[a-zA-Z0-9]?/, "")] : [];
  }
  const eq = v.indexOf("=");
  return eq > 0 ? [v, v.slice(eq + 1)] : [v];
}

/** Why a path-like word isn't inside the workspace, or null when it is (or isn't path-like). */
function outsideWorkspace(w: ShellWord, ctx: Ctx): string | null {
  const v = w.value!;
  if (v === "" || !(/^[.~/]/.test(v) || v.includes("/"))) return null;
  const abs = resolvePath(w, ctx.cwd, ctx);
  if (isCredentialPath(abs, ctx)) return `reads ${abs}, a credential file`;
  if (where(abs, ctx) !== "workspace") return `names ${abs ?? w.raw}, outside the workspace`;
  return null;
}

function notLowRedirect(r: ShellRedirect, ctx: Ctx): string | null {
  if (r.fd !== null && !Number.isInteger(r.fd)) return "it redirects through a named descriptor";
  // A here-document or here-string: plain text, unless it expands something.
  if (r.op === "<<" || r.op === "<<-") return r.body === null ? "a here-document expands something at run time" : null;
  if (!r.target) return `the ${r.op} redirect can't be read`;
  const why = notStatic(r.target);
  if (why) return why;
  if (r.op === "<<<") return null;
  if ((r.op === ">&" || r.op === "<&") && /^(\d+|-)$/.test(r.target.value!)) return null;
  if (r.op === "<") return outsideWorkspace({ ...r.target, value: r.target.value!.includes("/") ? r.target.value : `./${r.target.value}` }, ctx);
  if (/^(>|>>|>\||&>|&>>|>&)$/.test(r.op) && r.target.value === "/dev/null") return null;
  return `it writes ${r.target.raw}`;
}

/** Options that make a read-only program run another program or write a file. */
function lowOptions(prog: string, args: string[], cmd: SimpleCommand): string | null {
  const opts = args.filter((a) => a.startsWith("-") && a !== "-" && a !== "--");
  /** A short-option cluster holding any of these letters. */
  const short = (letters: string) => opts.some((o) => /^-[a-zA-Z0-9]+$/.test(o) && [...letters].some((c) => o.includes(c)));
  const long = (re: RegExp) => opts.some((o) => re.test(o));
  const refuse = `${prog} is given an option that can run or write something`;
  if (long(/^--files0-from/)) return `${prog} reads the files a list names`;
  switch (prog) {
    case "printf":
      return args.some((a) => a.startsWith("-v")) ? "printf -v sets a variable" : null;
    case "test":
      return args.some((a) => a === "-v" || a === "-R" || a.includes("[")) ? "test -v reads a variable by name" : null;
    case "find":
      return args.some((a) => /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/.test(a)) ? "find runs commands, deletes, or writes" : null;
    case "fd":
      return short("xXl") || long(/^--(exec|exec-batch|list-details)/) ? refuse : null;
    case "rg":
      return short("z") || long(/^--(pre|search-zip|hostname-bin)/) ? refuse : null;
    case "ag":
      return long(/^--pager/) ? refuse : null;
    case "sed":
      return short("if") || long(/^--(in-place|file)/) ? refuse : null;
    case "awk":
    case "gawk":
    case "mawk":
    case "nawk":
      // Only -F and -v, and a program that neither runs, writes, nor reads the environment.
      if (opts.some((o) => !/^-[Fv]/.test(o) && !/^--(field-separator|assign)(=|$)/.test(o))) return refuse;
      return args.some((a) => /system|getline|close|fflush|ENVIRON|PROCINFO|[@|>]/.test(a)) ? "awk runs a program that may run, write, or read the environment" : null;
    case "sort":
      return short("oT") || long(/^--(output|compress-program|temporary-directory)/) ? refuse : null;
    case "uniq":
      return operandsAfter(cmd, ["-f", "-s", "-w", "--skip-fields", "--skip-chars", "--check-chars"]).length > 1 ? "uniq writes a file" : null;
    case "xxd":
      return operandsAfter(cmd, ["-c", "-g", "-l", "-o", "-s", "-n", "-C", "--cols", "--groupsize", "--len", "--offset", "--seek", "--name"]).length > 1 ? "xxd writes a file" : null;
    case "tree":
      return short("oR") ? refuse : null;
    case "file":
      return short("C") || long(/^--compile/) ? refuse : null;
    case "hostname":
      return args.length === 0 || (args.length === 1 && ["-f", "-i", "-I", "--fqdn"].includes(args[0]!)) ? null : "hostname may change the machine's name";
    case "date":
      return dateSets(cmd) ? "date may set the clock" : null;
    case "jq":
      return args.some((a) => /\$ENV\b|\benv\b/.test(a)) ? "jq reads the environment" : null;
    case "git":
      return gitNotLow(args);
  }
  return null;
}

/** Why a git command isn't a plain read of the repository. */
function gitNotLow(args: string[]): string | null {
  let i = 0;
  for (; i < args.length && args[i]!.startsWith("-"); i++) {
    const a = args[i]!;
    // Paths after it are judged from where the line runs: `-C` may only go down.
    if (a === "-C") {
      const dir = args[++i] ?? "";
      if (dir === "" || /^[/~]/.test(dir) || /(^|\/)\.\.(\/|$)/.test(dir)) return `git -C ${dir} reads a repository elsewhere`;
    }
    else if (!["--no-pager", "-P", "--no-optional-locks", "--literal-pathspecs"].includes(a)) return `git ${a} changes what git runs or reads`;
  }
  const sub = args[i];
  if (sub === undefined) return null;
  const rest = args.slice(i + 1);
  const read =
    GIT_LOW.has(sub) ||
    (sub === "branch" && rest.every((x) => BRANCH_LIST_FLAGS.test(x))) ||
    (sub === "remote" && (rest.length === 0 || (rest.length === 1 && ["-v", "--verbose"].includes(rest[0]!)) || rest[0] === "get-url")) ||
    (sub === "tag" && rest.every((x) => x === "-l" || x === "--list" || x === "-n" || x.startsWith("--sort=") || x.startsWith("--contains"))) ||
    (sub === "config" && rest.some((x) => ["--get", "--get-all", "--list", "-l", "--get-regexp"].includes(x))) ||
    (sub === "stash" && (rest[0] === "list" || rest[0] === "show")) ||
    (sub === "worktree" && rest[0] === "list") ||
    (sub === "reflog" && (rest.length === 0 || rest[0] === "show")) ||
    (sub === "notes" && (rest.length === 0 || rest[0] === "list" || rest[0] === "show"));
  if (!read) return `git ${sub} isn't a plain read`;
  if (rest.some((x) => /^--(upload-pack|receive-pack|exec|open-files-in-pager|ext-diff|textconv|filters|output|paginate)(=|$)/.test(x) || (sub === "grep" && /^-[a-zA-Z]*O/.test(x)))) {
    return `git ${sub} is told to run or write something`;
  }
  return null;
}

/** A shell tool call with no command in it that can be read. */
export const UNREADABLE_SHELL_CALL: ShellRisk = { level: "unknown", reasons: ["the shell command in the request can't be read"], unreadable: true };

function judgeLine(parsed: ParsedShell, start: string | null, ctx: Ctx, v: Verdict): void {
  for (const p of parsed.problems) v.add("unknown", p);
  for (const a of parsed.assignments) judgeAssignment(a, v);
  // A value the line sets can be a path a command reads later (`p=/proc/$PPID/environ; cat $p`).
  for (const a of parsed.assignments) {
    const why = procSecretWord(a.value, start, ctx);
    if (why) refuseEnvironRead(v, `it sets ${a.name || "a variable"} to ${why}`);
  }
  procListedAndRead(parsed, start, ctx, v);
  // Arithmetic evaluates a variable's value as an expression, and runs a
  // `$(…)` in a subscript there: not understood when the line itself sets a
  // variable to text that could hold one (`x='a[$(cmd)]'; echo $((x))`).
  // Arithmetic on any other value is medium (never low: see notLow).
  const carrier = codeInArithmetic(parsed);
  if (carrier) v.add("unknown", `arithmetic (${carrier.where}) may run code the line puts in ${carrier.name}`);
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

/**
 * Variables that make a program or the shell load or run code, or move where
 * a `cd` goes: `LD_PRELOAD=./x.so ls`, `GIT_EXTERNAL_DIFF=… git diff`,
 * `BASH_ENV=x bash -c …`, `CDPATH=~ cd .codeoid`.
 */
const CODE_VARS = /^(LD_\w+|DYLD_\w+|GIT_\w+|\w+_COMMAND|BASH_ENV|ENV|PS4|PROMPT_COMMAND|SHELLOPTS|BASHOPTS|CDPATH|OLDPWD|LESSOPEN|LESSCLOSE|PYTHONSTARTUP|PERL5OPT|PERL5LIB|RUBYOPT|SSH_ASKPASS|SUDO_ASKPASS)$/;
/**
 * Variables that choose which program runs, or how words split, in everyday
 * ways (`PATH=./node_modules/.bin:$PATH`, `EDITOR=vim git commit`,
 * `while IFS= read -r l`): medium, wherever set.
 */
const TOOL_VARS = /^(PATH|PYTHONPATH|NODE_OPTIONS|IFS|HOME|EDITOR|VISUAL|PAGER|MANPAGER|BROWSER|\w+_PAGER|\w+_EDITOR)$/;
/** In a program's environment, these change nothing it runs. */
const PLAIN_VARS = /^(LANG|LANGUAGE|LC_\w+|TZ|NO_COLOR|FORCE_COLOR|CLICOLOR|CLICOLOR_FORCE|TERM|COLUMNS|LINES|CI|GIT_TERMINAL_PROMPT|GIT_OPTIONAL_LOCKS|GIT_AUTHOR_(NAME|EMAIL|DATE)|GIT_COMMITTER_(NAME|EMAIL|DATE))$/;
/** A pager or editor that runs nothing: `GIT_PAGER=cat git log`, `GIT_EDITOR=true git rebase --continue`. */
const PLAIN_PROGRAM = /(PAGER|EDITOR)$/;

/**
 * A variable the line sets. One that makes programs load or run code
 * (`LD_PRELOAD`, `GIT_*`, `BASH_ENV`, `CDPATH`, …) isn't understood,
 * wherever it is set; one that picks a program or splits words (`PATH`,
 * `EDITOR`, `IFS`, `HOME`, …) is medium, and so is any other one put in a
 * program's environment. Any assignment at all keeps a line from being low
 * (notLow).
 */
function judgeAssignment(a: ShellAssignment, v: Verdict): void {
  if (a.name === "" || PLAIN_VARS.test(a.name)) return; // "": a name only known at run time, already a problem
  if (PLAIN_PROGRAM.test(a.name) && ["", "cat", "true", ":"].includes(a.value.value ?? "-")) return;
  if (TOOL_VARS.test(a.name)) v.add("medium", `it sets ${a.name}, which changes ${a.name === "IFS" ? "how words are split" : "which programs run or where paths point"}`);
  else if (CODE_VARS.test(a.name)) v.add("unknown", `it sets ${a.name}, which can make programs load or run other code`);
  else if (a.exported) v.add("medium", `runs with ${a.name} set in its environment`);
}

/** A value whose text could hold code arithmetic would run: `$(…)`, `` `…` ``, or a subscript. */
function carriesCode(w: ShellWord): boolean {
  const code = /\$\((?!\()|`|\[/;
  return code.test(w.raw) || (w.value !== null && code.test(w.value));
}

const namesIn = (text: string): string[] => text.match(/[A-Za-z_]\w*/g) ?? [];

/**
 * A variable that arithmetic on the line reads, and that the line gives a
 * value that could hold code: directly, or through a value naming another
 * such variable (`n=y; y='a[$(cmd)]'; echo $((n))`, which arithmetic follows).
 */
function codeInArithmetic(parsed: ParsedShell): { name: string; where: string } | null {
  if (parsed.arithmetic.length === 0) return null;
  // Who names whom: tainted spreads from a variable to the ones whose values name it.
  const namedBy = new Map<string, string[]>();
  for (const a of parsed.assignments) {
    for (const n of new Set(namesIn(`${a.value.raw} ${a.value.value ?? ""}`))) namedBy.set(n, [...(namedBy.get(n) ?? []), a.name]);
  }
  const tainted = new Set<string>();
  const queue = parsed.assignments.filter((a) => carriesCode(a.value)).map((a) => a.name);
  while (queue.length > 0) {
    const name = queue.pop()!;
    if (tainted.has(name)) continue;
    tainted.add(name);
    queue.push(...(namedBy.get(name) ?? []));
  }
  for (const where of parsed.arithmetic) {
    const name = namesIn(where).find((n) => tainted.has(n));
    if (name) return { name, where };
  }
  return null;
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
  // `..` is taken as the kernel takes it, after following what came before
  // (`/dev/fd/../..` is `/proc`); the program opening it runs in `cwd`.
  const at = (p: string) => kernelPath(p, cwd);
  if (v === "~" || v.startsWith("~/")) return at(`${ctx.home}/${v.slice(1)}`);
  // `~me/x` is `~/x`; `~+` is the directory it runs in.
  const tilde = /^~([^/]*)(\/[\s\S]*)?$/.exec(v);
  if (tilde?.[1] === ownUser() && ownUser() !== "") return at(`${ctx.home}/${tilde[2] ?? ""}`);
  if (tilde?.[1] === "+" && cwd !== null) return at(`${cwd}/${tilde[2] ?? ""}`);
  if (v.startsWith("~")) return null; // another user's home, or `~-`
  if (isAbsolute(v)) return at(v);
  if (cwd === null) return null;
  // As `resolve` gives it: no trailing `/`.
  const r = at(`${cwd}/${v}`);
  return r !== null && r.length > 1 && r.endsWith("/") ? r.slice(0, -1) : r;
}

let user: string | undefined;
/** The daemon's user name, whose `~name` is the home directory ("" when it can't be read). */
function ownUser(): string {
  if (user === undefined) {
    try {
      user = userInfo().username;
    } catch {
      user = "";
    }
  }
  return user;
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
  const sensitive = sensitiveArea(path, ctx);
  // A workspace inside a sensitive area is its own ground; one that holds
  // it (a workspace at `~` or `/`) doesn't make `~/.bashrc` or `/etc` its own.
  if (insideOf(path, ctx.workdir) && (!sensitive || insideOf(ctx.workdir, sensitive.root))) return "workspace";
  if (sensitive) return sensitive.kind;
  if (path === ctx.home) return "home";
  return "outside";
}

/** The start-up file, key or tool config, or system directory a path is in. */
function sensitiveArea(path: string, ctx: Ctx): { root: string; kind: "home-sensitive" | "system" } | null {
  if (insideOf(path, ctx.configDir)) return { root: ctx.configDir, kind: "home-sensitive" };
  if (insideOf(path, ctx.home)) {
    const rel = path.slice(ctx.home.length + 1);
    const s = HOME_SENSITIVE.find((x) => rel === x || rel.startsWith(`${x}/`));
    return s ? { root: join(ctx.home, s), kind: "home-sensitive" } : null;
  }
  const p = SYSTEM_PREFIXES.find((x) => insideOf(path, x));
  return p ? { root: p, kind: "system" } : null;
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
  // A wrapper's own words name files too: `xargs -a FILE`, `time -o FILE`.
  const words = [...cmd.argv.slice(1), ...(cmd.wrapped ?? []), ...cmd.redirects.map((r) => r.target).filter((t): t is ShellWord => t !== null)];
  const lists = listsOnly(cmd);
  for (const w of words) {
    // `ls -l /proc/$$/fd` reads no file: only what reads one can read an environment.
    const procReads = !(lists && cmd.argv.includes(w));
    // A path known in full is the secret-path check's, below.
    const proc = procReads && (SHAPE_MARK.test(wordShape(w)) || cwd === null) ? procSecretWord(w, cwd, ctx) : null;
    if (proc) refuseEnvironRead(v, `it names ${proc}`);
    // `dd if=F`, `of=F`: the value after `=` is a file too.
    const assigned = w.value !== null && /^[A-Za-z_][\w.-]*=[\s\S]/.test(w.value) ? [{ ...w, value: w.value.slice(w.value.indexOf("=") + 1), shape: undefined }] : [];
    for (const p of [...fileWords(w), ...assigned.flatMap(fileWords)]) {
      const abs = resolvePath(p, cwd, ctx);
      if (abs === null) {
        if (cwd === null) checkSecretsAnywhere(p, ctx, v);
        continue;
      }
      const s = secretPathVerdict("Grep", { path: abs }, { workdir: ctx.workdir, configDir: ctx.configDir, procReads });
      if (!s) continue;
      if (s.action === "deny" || !v.secret) v.secret = s;
      if (s.action === "deny") v.add("high", `touches ${s.path}, which holds credentials`);
      else v.add("medium", `reaches ${s.path}, which contains credential files`);
    }
  }
}

/** Programs that only list or stat what they're given, never reading a file's contents. */
const LISTERS = new Set(["ls", "stat", "readlink", "realpath"]);

/** `ls`, `stat`, `readlink`, `realpath`, not recursing: they read no file, so no process's environment either. */
function listsOnly(cmd: SimpleCommand): boolean {
  const prog = programOf(cmd);
  if (prog === null || !LISTERS.has(prog)) return false;
  return !cmd.argv.slice(1).some((w) => w.value === null ? false : w.value === "--recursive" || /^-[a-zA-Z]*R/.test(w.value));
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
  checkProcReads(cmd, parsed, cwd, ctx, v);
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
    case "ps":
      judgePs(cmd, parsed, v);
      return;
    case "top":
      // Its fields come from a configuration file (toprc, found through
      // HOME / XDG_CONFIG_HOME), which can name the environment field.
      refuseEnvironRead(v, "top shows the fields its configuration file names, processes' environments among them");
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
    if (x?.startsWith("-") && x !== "-") {
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

/**
 * Another process's environment is a credential: the daemon's keys, a backend
 * server's password (opencode's `OPENCODE_PASSWORD` is in the environ of the
 * shell's parent). A command that could read one is refused, as reading
 * /proc/<pid>/environ with a file tool is, in every mode and on every
 * backend. The rule fails closed: a word, a `ps`, a search is refused unless
 * what the line shows proves it can't reach one (see docs/approvals.md).
 */
function refuseEnvironRead(v: Verdict, why: string): void {
  const path = "/proc/<pid>/environ";
  if (v.secret?.action !== "deny") v.secret = { action: "deny", path };
  v.add("high", `${why}: a process's environment holds credentials (it reads ${path})`);
}

/** The files of /proc/<pid> that hand over a process's environment, memory or open files (secret-paths.ts PROC_SECRET). */
const PROC_SECRET_NAMES = ["environ", "mem", "fd", "fdinfo", "map_files"];
const SHAPE_MARK = new RegExp(`[${SHAPE_ANY}${SHAPE_STAR}${SHAPE_ONE}]`);

/** A shape (or one component of it) as a regular expression over the values it could take. */
function shapeRegex(shape: string): RegExp {
  let src = "";
  for (const c of shape) src += c === SHAPE_ANY ? "[\\s\\S]*" : c === SHAPE_STAR ? "[^/]*" : c === SHAPE_ONE ? "[^/]" : c.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
  return new RegExp(`^${src}$`);
}

/** A last component that is fixed text and none of the secret files, nor an entry of their directories (`fd/3`, `map_files/7f…-7f…`). */
function safeProcLeaf(leaf: string): boolean {
  return !SHAPE_MARK.test(leaf) && !PROC_SECRET_NAMES.includes(leaf) && !/^\d+$/.test(leaf) && !/^[0-9a-f]+-[0-9a-f]+$/i.test(leaf);
}

/**
 * The components of a word's shape as an absolute path: `~` is the home,
 * a relative one is under cwd (or under any directory, when that isn't
 * known). Null when the word starts with `~user`.
 */
function shapeComponents(w: ShellWord, cwd: string | null, ctx: Ctx): string[] | null {
  let shape = wordShape(w);
  if (shape === "~" || shape.startsWith("~/")) shape = ctx.home + shape.slice(1);
  else if (shape.startsWith("~")) return null;
  else if (!shape.startsWith("/") && !shape.startsWith(SHAPE_ANY)) shape = `${cwd ?? SHAPE_ANY}/${shape}`;
  return shape
    .replace(new RegExp(`${SHAPE_ANY}+`, "g"), SHAPE_ANY)
    .split("/")
    .filter((c) => c !== "" && c !== ".");
}

/**
 * Why a word could name a file that hands over a process's environment (or
 * memory, or open files), or null when its fixed text proves it can't:
 * /proc/<pid>/environ however the pid or the name is written (`$PPID`,
 * `$$`, `self`, `$(pgrep …)`, a glob, an xargs or find argument), relative
 * to /proc, or through a `/proc/<pid>/root` link back to `/`. A word only
 * known at run time with no fixed text at all (`$f`) proves nothing either
 * way; what the line does with it is judged elsewhere (procListedAndRead).
 */
function procSecretWord(w: ShellWord, cwd: string | null, ctx: Ctx): string | null {
  // A path known in full is judged as it is: `cat environ` in the workspace is a file there.
  if (!SHAPE_MARK.test(wordShape(w)) && (cwd !== null || wordShape(w).startsWith("/"))) {
    const abs = w.value === null ? null : resolvePath(w, cwd, ctx);
    return abs !== null && isProcSecretPath(abs) ? abs : null;
  }
  const comps = shapeComponents(w, cwd, ctx);
  if (comps === null || comps.length === 0) return null;
  const leaf = comps.at(-1)!;
  // The last component could be environ or mem, and the word says so in fixed text: `$d/environ`, `env*`, `"$x"iron`.
  const tail = leaf.includes(SHAPE_ANY) ? leaf.slice(leaf.lastIndexOf(SHAPE_ANY)) : leaf;
  if (tail.replace(new RegExp(SHAPE_MARK.source, "g"), "") !== "") {
    const name = ["environ", "mem"].find((n) => shapeRegex(tail).test(n));
    if (name) return `${w.raw}, which could be /proc/<pid>/${name}`;
  }
  // Under a `proc` component (`/proc`, `/pr?c`, a cwd in /proc): only a fixed last component that is none of them is safe.
  const at = comps.findIndex((c, i) => i < comps.length - 1 && !c.includes(SHAPE_ANY) && shapeRegex(c).test("proc"));
  if (at < 0) return null;
  // `/proc/<x>/root/…` is the process's `/`: what follows is judged from there.
  const root = comps.findIndex((c, i) => i > at && c === "root");
  if (root >= 0 && root < comps.length - 1) {
    const rest = comps.slice(root + 1).join("/");
    const inner = procSecretWord({ value: SHAPE_MARK.test(rest) ? null : `/${rest}`, raw: w.raw, glob: false, shape: `/${rest}` }, "/", ctx);
    if (inner) return inner;
    if (!SHAPE_MARK.test(rest) && secretPathVerdict("Grep", { path: `/${rest}` }, { workdir: ctx.workdir, configDir: ctx.configDir })?.action === "deny") return `${w.raw}, which is /${rest} through a process's root`;
  }
  if (comps.slice(at + 1).some((c) => SHAPE_MARK.test(c)) || cwd === null || SHAPE_MARK.test(comps.slice(0, at).join("/"))) {
    if (!safeProcLeaf(leaf)) return `${w.raw}, a path under /proc only known at run time`;
  }
  return null;
}

/** A directory listing it holds /proc/<pid> entries: /proc, /proc/<pid>, its task dirs, and a process's root or cwd link. */
function isProcDir(abs: string | null): boolean {
  return abs !== null && (/^\/proc(?:\/[^/]+(?:\/task(?:\/[^/]+)?)?)?$/.test(abs) || /^\/proc\/[^/]+(?:\/task\/[^/]+)?\/(?:root|cwd)(?:\/|$)/.test(abs));
}

/** A word that is, or could be, such a directory, or `/` (where a recursive read reaches /proc). */
function reachesProc(w: ShellWord, cwd: string | null, ctx: Ctx): boolean {
  if (w.value !== null && !w.glob) {
    const abs = resolvePath(w, cwd, ctx);
    return abs === "/" || isProcDir(abs);
  }
  const comps = shapeComponents(w, cwd, ctx);
  return comps?.some((c) => !c.includes(SHAPE_ANY) && shapeRegex(c).test("proc")) ?? false;
}

/**
 * A find whose results could be a process's environment: a root that reaches
 * /proc (`/`, `/proc`, `/proc/$PPID`), unless its expression is a plain
 * conjunction with a `-name` / `-iname` pattern none of the secret files'
 * names match.
 */
function findYieldsProcSecret(find: SimpleCommand, cwd: string | null, ctx: Ctx): boolean {
  if (!findRoots(find).some((r) => reachesProc(r, cwd, ctx))) return false;
  const args = find.argv.slice(1);
  if (args.some((w) => w.value === null || ["-o", "-or", ",", "!", "-not", "(", ")"].includes(w.value))) return true;
  for (let i = 0; i < args.length - 1; i++) {
    const opt = args[i]!.value;
    if (opt !== "-name" && opt !== "-iname") continue;
    const re = shapeRegex(wordShape(args[i + 1]!).replace(/\\(.)/g, "$1"));
    const fold = opt === "-iname";
    if (![...PROC_SECRET_NAMES, "3", "12", "7f00-7f01"].some((n) => (fold ? new RegExp(re.source, "i") : re).test(n))) return false;
  }
  return true;
}

/**
 * The line lists entries of /proc (a find there, `ls /proc/$PPID`, `echo
 * /proc`) and some command reads a path only known at run time — what a
 * pipe, a loop or xargs hands on (`find /proc -name environ | while read f;
 * do cat "$f"; done`): refused, as that path could be a process's environment.
 */
function procListedAndRead(parsed: ParsedShell, cwd: string | null, ctx: Ctx, v: Verdict): void {
  const lists = parsed.commands.some((c) =>
    programOf(c) === "find" ? findYieldsProcSecret(c, cwd, ctx) : [...c.argv.slice(1), ...c.redirects.map((r) => r.target).filter((t): t is ShellWord => t !== null)].some((w) => (w.value !== null ? !w.glob && isProcDir(resolvePath(w, cwd, ctx)) : reachesProc(w, cwd, ctx))),
  );
  if (!lists) return;
  const reads = parsed.commands.find((c) => !NOT_FILES.has(programOf(c) ?? "") && programOf(c) !== "find" && !listsOnly(c) && [...c.argv.slice(1), ...(c.wrapped ?? [])].some((w) => w.value === null && w.home === undefined && !safeProcLeaf(wordShape(w).split("/").at(-1) ?? "")));
  if (reads) refuseEnvironRead(v, `${programOf(reads)} reads a path only known at run time, on a line that lists /proc, so it could read processes' environments`);
}

/** Programs that read every file under a directory they're given, and the options that make them. */
function recursesInto(cmd: SimpleCommand, prog: string): boolean {
  const f = flags(cmd);
  switch (prog) {
    case "grep":
    case "egrep":
    case "fgrep":
    case "ugrep":
      return hasFlag(cmd, "r", "--recursive") || hasFlag(cmd, "R", "--dereference-recursive") || f.some((x) => x === "-drecurse" || x === "--directories=recurse") || cmd.argv.some((w, i) => (w.value === "-d" || w.value === "--directories") && cmd.argv[i + 1]?.value === "recurse");
    case "rg":
    case "ag":
    case "ack":
    case "tar":
    case "bsdtar":
      return true;
    case "diff":
      return hasFlag(cmd, "r", "--recursive");
    case "cp":
    case "scp":
      return hasFlag(cmd, "r", "--recursive") || hasFlag(cmd, "R") || hasFlag(cmd, "a", "--archive");
    case "rsync":
      return hasFlag(cmd, "r", "--recursive") || hasFlag(cmd, "a", "--archive");
    case "zip":
      return hasFlag(cmd, "r", "--recurse-paths");
  }
  return false;
}

/** Debuggers attached to a process read its memory, its environment included. */
const ATTACH_ALWAYS = new Set(["gcore", "gstack", "pstack", "eu-stack"]);

/** gdb / lldb / strace / ltrace told to attach to a running process. */
function attaches(cmd: SimpleCommand, prog: string): boolean {
  // Each word's fixed text, run-time parts marked: `--pid=$PPID` and `-ex "attach $PPID"` show what they do.
  const args = cmd.argv.slice(1).map(wordShape);
  switch (prog) {
    case "strace":
    case "ltrace":
      return args.some((a) => /^-[a-zA-Z]*p/.test(a) || /^--attach(=|$)/.test(a));
    case "gdb":
    case "lldb": {
      if (args.some((a) => /^(-p|-pid|--pid|-p=|--pid=|--attach-pid|--attach-name|-n|-w|--wait-for)/.test(a) && !/^--?(nx|nh|nw)$/.test(a))) return true;
      // A command it runs that attaches: `-ex 'attach 123'`, `-o 'process attach -p 1'`.
      if (args.some((a) => /(^|\s)(attach|process\s+attach)\b/.test(a))) return true;
      // `gdb PROG PID`: a number after the program is a process to attach to.
      return prog === "gdb" && positionals(cmd).length >= 2 && /^\d+$/.test(positionals(cmd)[1]!.value ?? "");
    }
  }
  return false;
}

/**
 * A debugger or tracer whose words could attach to a process though their
 * fixed text doesn't show it: a word that starts with what's only known at
 * run time (`gdb $OPTS`, `gdb -ex "$CMD"`), or a pid after gdb's program
 * that is (`gdb PROG $PID`).
 */
function mayAttach(cmd: SimpleCommand, prog: string): boolean {
  if (!["gdb", "lldb", "strace", "ltrace"].includes(prog)) return false;
  if (cmd.argv.slice(1).some((w) => wordShape(w).startsWith(SHAPE_ANY))) return true;
  return prog === "gdb" && positionals(cmd)[1]?.value === null;
}

/** Interpreters whose inline code isn't parsed as shell (shells are: their `-c` line is judged command by command). */
const CODE_TEXT = /\/proc\b[\s\S]*\benviron\b/;

/**
 * Reads of other processes' environments a command makes itself: what find
 * or xargs hands it from /proc, a recursive read of `/` or /proc, a debugger
 * attached to a process, and inline code that names /proc/…/environ.
 */
function checkProcReads(cmd: SimpleCommand, parsed: ParsedShell, cwd: string | null, ctx: Ctx, v: Verdict): void {
  const prog = programOf(cmd);
  if (prog === null) return;
  // `find /proc -name environ -exec cat {} +`, `find / | xargs cat`: what it's handed comes from there.
  if (cmd.argv.slice(1).some((w) => w.input && wordShape(w) === SHAPE_ANY)) {
    const sources = cmd.inputFrom !== undefined ? [parsed.commands[cmd.inputFrom]!] : parsed.commands.filter((c) => c.pipeline === cmd.pipeline && c.stage < cmd.stage);
    if (sources.some((c) => programOf(c) === "find" && findYieldsProcSecret(c, cwd, ctx))) refuseEnvironRead(v, `${prog} reads what a search of /proc finds, processes' environments among them`);
  }
  if (recursesInto(cmd, prog)) {
    const operands = positionals(cmd);
    const at = operands.find((w) => reachesProc(w, cwd, ctx)) ?? (operands.length === 0 && /^(rg|ag|ack|grep|egrep|fgrep|ugrep)$/.test(prog) && (cwd === null || cwd === "/" || isProcDir(cwd)) ? { value: cwd, raw: cwd ?? "the current directory", glob: false } : undefined);
    if (at) refuseEnvironRead(v, `${prog} reads every file under ${at.raw}, processes' environments in /proc included`);
  }
  if (ATTACH_ALWAYS.has(prog) || attaches(cmd, prog)) refuseEnvironRead(v, `${prog} attaches to another process, whose memory holds its environment`);
  else if (mayAttach(cmd, prog)) v.add("unknown", `${prog}'s arguments are only known at run time: it may attach to another process, whose memory holds its environment`);
  if (INTERPRETERS.has(prog) || ["awk", "gawk", "mawk", "nawk", "sed", "gdb", "lldb"].includes(prog)) {
    const texts = [...cmd.argv.slice(1).map((w) => w.value ?? w.raw), ...cmd.redirects.flatMap((r) => [r.body ?? "", r.op === "<<<" ? (r.target?.value ?? r.target?.raw ?? "") : ""])];
    if (texts.some((t) => CODE_TEXT.test(t))) refuseEnvironRead(v, `${prog}'s code names /proc/…/environ, a process's environment`);
  }
}

/** ps options that take an argument: Unix (`-o FMT`, `-oFMT`), long (`--format FMT`, `--format=FMT`), BSD (`o FMT`). */
const PS_UNIX_ARG = new Set("CGgnOopqstUuk");
const PS_BSD_ARG = new Set("oOpqtUk");
/** Every other option ps takes that shows no environment: procps' and macOS's Unix (`-ef`, `-AH`) and BSD (`aux`, `axjf`) ones. */
const PS_UNIX_PLAIN = new Set("AacdeFfHhjLlMmNPrSTVvwXxyZ");
const PS_BSD_PLAIN = new Set("acfghjLlMmnrSsTuVvwXxZH");
const PS_LONG_ARG = new Set(["--format", "--cols", "--columns", "--width", "--lines", "--rows", "--group", "--Group", "--pid", "--ppid", "--quick-pid", "--sid", "--sort", "--tty", "--user", "--User"]);
const PS_LONG_PLAIN = new Set(["--context", "--cumulative", "--deselect", "--forest", "--headers", "--no-headers", "--info", "--version", "--help"]);
const PS_FORMAT_OPTS = new Set(["o", "O", "--format"]);
/** Variables ps reads: the default format, how options are read (personality), and the rest procps documents. */
const PS_VARS = /^(PS_\w+|PROCPS_\w+|CMD_ENV|I_WANT_A_BROKEN_PS|POSIXLY_CORRECT|POSIX2|UNIX95|_XPG)$/;

/**
 * A word only known at run time that can't become more than one argument:
 * fully double-quoted (`"$pid"`), or one variable the line doesn't set
 * (inherited, as the rest of ps's environment is) or a pid bash sets (`$$`).
 */
function oneArgument(w: ShellWord, parsed: ParsedShell): boolean {
  if (/^"(?:[^"\\]|\\.)*"$/.test(w.raw)) return true;
  const name = /^\$(?:\{(\w+|[$!])\}|(\w+|[$!]))$/.exec(w.raw);
  const v = name?.[1] ?? name?.[2];
  return v !== undefined && (["$", "!", "PPID", "BASHPID"].includes(v) || !parsed.assignments.some((a) => a.name === v || a.name === ""));
}

/**
 * `ps` prints every same-user process's environment when told to (BSD `e`,
 * as in `ps eww` or `ps auxe`; macOS's `-E`; an `environ` field, in `-o` or in
 * `$PS_FORMAT`), reading /proc/<pid>/environ itself, so the line names no file
 * the secret check sees. It is judged an environment reader unless its
 * options and the variables the line sets prove it can't show one: every
 * option is one ps documents as showing none, every format names no
 * environment field, every word is known (or a single option value), and the
 * line sets no variable ps reads (`PS_PERSONALITY` changes how options are
 * read) but a `PS_FORMAT` of that kind.
 */
function judgePs(cmd: SimpleCommand, parsed: ParsedShell, v: Verdict): void {
  let env: string | null = null;
  let pending: string | null = null;
  const format = (value: string) => {
    if (value.split(/[\s,]+/).some((f) => /^(env|environ)(=|:|$)/i.test(f))) env ??= "an environment field";
  };
  for (const a of parsed.assignments) {
    if (a.name === "") env ??= "a variable whose name is only known at run time";
    else if (a.name === "PS_FORMAT") {
      if (a.value.value === null) env ??= "a PS_FORMAT only known at run time";
      else format(a.value.value);
    } else if (PS_VARS.test(a.name)) env ??= `${a.name}, which changes what ps shows`;
  }
  for (const w of cmd.argv.slice(1)) {
    const word = w.value;
    if (pending !== null) {
      if (word === null && (PS_FORMAT_OPTS.has(pending) || !oneArgument(w, parsed))) env ??= PS_FORMAT_OPTS.has(pending) ? "a format only known at run time" : `${w.raw}, which could split into options`;
      else if (word !== null && PS_FORMAT_OPTS.has(pending)) format(word);
      pending = null;
      continue;
    }
    if (word === null) {
      env ??= `an option only known at run time (${w.raw})`;
      continue;
    }
    if (word.startsWith("--")) {
      const eq = word.indexOf("=");
      const name = eq < 0 ? word : word.slice(0, eq);
      if (PS_LONG_ARG.has(name)) {
        if (eq < 0) pending = name;
        else if (PS_FORMAT_OPTS.has(name)) format(word.slice(eq + 1));
      } else if (!PS_LONG_PLAIN.has(name) && word !== "--") env ??= `an option ps may read as one (${word})`;
      continue;
    }
    if (/^\d[\d,]*$/.test(word)) continue; // pids
    const unix = word.startsWith("-");
    const group = unix ? word.slice(1) : word;
    for (let i = 0; i < group.length; i++) {
      const c = group[i]!;
      if ((unix ? PS_UNIX_ARG : PS_BSD_ARG).has(c)) {
        const rest = group.slice(i + 1);
        if (rest) {
          if (c === "o" || c === "O") format(rest);
        } else pending = c;
        break;
      }
      if (!(unix ? PS_UNIX_PLAIN : PS_BSD_PLAIN).has(c)) {
        env ??= (unix && c === "E") || (!unix && c === "e") ? (unix ? "-E" : "e") : `${unix ? "-" : ""}${c}, an option ps may read as one`;
        break;
      }
    }
  }
  if (env === null) {
    v.add("medium", "runs ps");
    return;
  }
  refuseEnvironRead(v, `ps shows processes' environments (${env})`);
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
export function findRoots(cmd: SimpleCommand): ShellWord[] {
  const args = cmd.argv.slice(1);
  let i = 0;
  // `-H`, `-L`, `-P`, `-D debugopts`, `-O3` come before the roots.
  while (i < args.length && /^-([HLP]|D|O\d*)$/.test(args[i]!.value ?? "")) i += args[i]!.value === "-D" ? 2 : 1;
  // `find -- ROOT …`: the end of those options.
  if (args[i]?.value === "--") i++;
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
