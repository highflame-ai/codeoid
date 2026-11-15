/**
 * Saved approval rules (docs/secrets-and-memory-design.md §4.1): what a rule
 * is, which rules can exist, and whether one runs a tool call. Pure: the
 * store and the service keep and look up rules, Session decides with them.
 *
 * A rule is one of:
 * - `Bash(npm test)`: exactly that command; `Bash(npm test:*)`: that command
 *   and any words after it.
 * - `mcp__<server>__<tool>`: that MCP tool.
 * - `WebFetch(domain:<host>)`: an http(s) fetch of that host.
 *
 * A shell line runs on allow rules only when every simple command in it is
 * covered: a plain read (low's allow-list, judged alone), a `cd` to a literal
 * directory in the workspace, or a match for an allow rule run plainly. A deny
 * rule matching any of its commands, as far as the line can be read, refuses it.
 */
import { basename } from "node:path";
import type { CommandCoverage } from "../risk/shell-risk.js";
import type { ParsedShell, ShellWord, SimpleCommand } from "../shell/parse.js";

export type RuleEffect = "allow" | "deny";
export type RuleScopeKind = "session" | "repository" | "workstream" | "everywhere";

export type RulePattern =
  | { tool: "Bash"; words: string[]; prefix: boolean }
  | { tool: "mcp"; name: string }
  | { tool: "WebFetch"; host: string };

type ShellPattern = Extract<RulePattern, { tool: "Bash" }>;

/** A rule as the gate matches it: its pattern and what it does. */
export interface MatchableRule {
  id: string;
  pattern: RulePattern;
  effect: RuleEffect;
  scope: RuleScopeKind;
}

/**
 * Shells, programs that run another program or as another user, and
 * builtins that change what later words run or print the environment:
 * never the program of an allow rule.
 */
const NEVER_PROGRAMS = new Set([
  "busybox", "toybox", "xonsh", "elvish", "nu", "fish",
  "eval", "exec", "source", ".", "command", "builtin", "coproc", "trap", "alias", "unalias", "hash", "enable", "shopt", "set",
  "export", "declare", "typeset", "local", "readonly", "unset", "let", "printenv",
  "sudo", "doas", "su", "sg", "pkexec", "runuser", "chroot", "env", "xargs", "nohup", "nice", "ionice", "timeout", "time",
  "watch", "flock", "script", "setsid", "stdbuf", "unbuffer", "taskset", "chrt", "parallel", "nsenter", "unshare",
  "systemd-run", "firejail", "bwrap", "ssh", "fakeroot", "tmux", "screen",
]);
/** Shells, by name. */
const SHELLS = new Set(["sh", "bash", "rbash", "zsh", "dash", "ash", "ksh", "mksh", "pdksh", "oksh", "loksh", "rksh", "csh", "tcsh", "yash", "posh"]);

/** Interpreters and package runners: an allow rule names what they run. */
const RUNNERS = new Set([
  "deno", "bun", "irb", "Rscript", "R", "julia", "awk", "gawk", "mawk", "nawk", "sed", "wish", "osascript", "pwsh", "powershell",
  "groovy", "npx", "bunx", "pnpx", "uvx", "pipx", "java", "jshell", "swift", "scala", "elixir", "erl", "racket", "guile", "sbcl",
  "tsx", "ts-node", "node", "nodejs",
]);
/** `python3.12`, `ruby3`, `perl5.36`, …: versioned interpreters. */
const VERSIONED_RUNNER = /^(?:python|pypy|ruby|perl|php|node|lua|luajit|tclsh)[\d.]*$/;

/** A runner's subcommands that run any code they're given: a rule needs what follows named. */
const RUN_SUBCOMMANDS: Record<string, ReadonlySet<string>> = {
  npm: new Set(["exec", "x", "run", "run-script", "explore", "start"]),
  pnpm: new Set(["exec", "dlx", "x", "run", "start"]),
  yarn: new Set(["exec", "dlx", "run", "node", "start"]),
  bun: new Set(["x", "run", "exec"]),
  deno: new Set(["run", "eval", "x", "task"]),
  uv: new Set(["run", "tool"]),
  poetry: new Set(["run"]),
  pipenv: new Set(["run"]),
  go: new Set(["run", "tool", "generate"]),
  cargo: new Set(["run", "install"]),
};

/** Second words a card offers as `program verb:*`: building and checking the project. */
const PREFIX_VERBS = new Set(["test", "build", "lint", "check", "typecheck", "type-check", "fmt", "format", "clippy", "vet", "bench", "compile"]);

/** A word a rule can hold: no space, quote, shell operator, wildcard, control or invisible character, so its text reads back the same. */
const RULE_WORD = /^[^\s'"`$\\;&|<>(){}*?[\]#~!\p{Cc}\p{Cf}]+$/u;
const MCP_NAME = /^mcp__[A-Za-z0-9_.-]+__[A-Za-z0-9_.-]+$/;
const HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

function isRunner(prog: string): boolean {
  return RUNNERS.has(prog) || VERSIONED_RUNNER.test(prog);
}

function isNever(prog: string): boolean {
  return NEVER_PROGRAMS.has(prog) || SHELLS.has(prog);
}

/** Why `words` can't be a shell rule with this effect, or null when they can. A deny rule may name any program. */
export function shellRuleProblem(words: readonly string[], prefix: boolean, effect: RuleEffect = "allow"): string | null {
  if (words.length === 0) return "a shell rule needs a program";
  const bad = words.find((w) => !RULE_WORD.test(w));
  if (bad !== undefined) return `${JSON.stringify(bad)} can't be part of a rule: it has a space, quote, wildcard or shell character`;
  if (effect === "deny") return null;
  const prog = basename(words[0]!);
  if (isNever(prog)) return `${prog} runs other programs, so it can't be an allow rule's program`;
  if (prefix && words.length < 2) return `Bash(${prog}:*) would run anything ${prog} does: name its subcommand (Bash(${prog} test:*))`;
  const needsNamed = RUN_SUBCOMMANDS[prog]?.has(words[1] ?? "") ? 2 : isRunner(prog) ? 1 : 0;
  if (prefix && needsNamed > 0 && !words.slice(needsNamed).some((w) => !w.startsWith("-"))) {
    return `${words.slice(0, needsNamed).join(" ")} runs any code it's given: name what it runs (Bash(${words.slice(0, needsNamed).join(" ")} <script>:*))`;
  }
  return null;
}

/** Read a rule's text; the error says what's wrong with it. */
export function parseRule(text: string, effect: RuleEffect = "allow"): { ok: true; pattern: RulePattern } | { ok: false; error: string } {
  const t = text.trim();
  const bash = /^Bash\((.*)\)$/s.exec(t);
  if (bash) {
    let body = bash[1]!.trim();
    const prefix = body.endsWith(":*");
    if (prefix) body = body.slice(0, -2).trimEnd();
    if (body === "" || body === "*") return { ok: false, error: "a rule must name a program: Bash and Bash(*) match anything" };
    const words = body.split(/\s+/);
    const why = shellRuleProblem(words, prefix, effect);
    return why ? { ok: false, error: why } : { ok: true, pattern: { tool: "Bash", words, prefix } };
  }
  if (t === "Bash") return { ok: false, error: "a rule must name a program: Bash and Bash(*) match anything" };
  const fetch = /^WebFetch\(domain:(.*)\)$/.exec(t);
  if (fetch) {
    const host = fetch[1]!.trim().toLowerCase().replace(/\.$/, "");
    if (!HOST.test(host)) return { ok: false, error: `${JSON.stringify(fetch[1])} isn't a host name` };
    if (effect === "allow" && localHost(host)) return { ok: false, error: `${host} is a local or IP address: fetches there aren't allowed by a rule` };
    return { ok: true, pattern: { tool: "WebFetch", host } };
  }
  if (MCP_NAME.test(t)) return { ok: true, pattern: { tool: "mcp", name: t } };
  return { ok: false, error: "a rule is Bash(<command>), Bash(<command>:*), mcp__<server>__<tool> or WebFetch(domain:<host>)" };
}

export function formatRule(p: RulePattern): string {
  if (p.tool === "Bash") return `Bash(${p.words.join(" ")}${p.prefix ? ":*" : ""})`;
  if (p.tool === "WebFetch") return `WebFetch(domain:${p.host})`;
  return p.name;
}

/** A word known before the line runs, with nothing in it to expand. */
function literal(w: ShellWord | undefined): w is ShellWord & { value: string } {
  return w !== undefined && w.value !== null && !w.glob && !w.input;
}

/** The command itself, run plainly: no wrapper, no script it runs, nothing it runs for others. */
function plainCommand(cmd: SimpleCommand): boolean {
  return cmd.via.length === 0 && !cmd.delegates && !cmd.stdinScript && cmd.inputFrom === undefined && (cmd.wrapped?.length ?? 0) === 0;
}

/** Where a command can run on an allow rule: in the workspace, writing nothing by redirect, naming no path outside it. */
function coverable(cov: CommandCoverage, cmd: SimpleCommand): boolean {
  return !cov.cd && cov.inWorkspace && cov.plainRedirects && cov.pathsInside && plainCommand(cmd);
}

function wordsMatch(cmd: SimpleCommand, p: ShellPattern): boolean {
  if (p.prefix ? cmd.argv.length < p.words.length : cmd.argv.length !== p.words.length) return false;
  return p.words.every((w, i) => literal(cmd.argv[i]) && cmd.argv[i]!.value === w);
}

/** `words` appear in `seq` in order, with anything between: `publish` in `npm --yes publish`. */
function inOrder(words: readonly string[], seq: readonly string[]): boolean {
  let i = 0;
  for (const s of seq) if (i < words.length && s === words[i]) i++;
  return i === words.length;
}

/**
 * A deny rule's match, generous: the rule's program by name wherever it is
 * and however it's run (`sudo /bin/npm`), or named as what a runner or
 * wrapper runs (`npx npm …`); then the rule's other words in order among
 * the words after it, options and their values skipped (`npm --yes publish`).
 */
function denyMatches(cmd: SimpleCommand, p: ShellPattern): boolean {
  const prog = basename(p.words[0]!);
  const words = cmd.argv.map((w) => (literal(w) ? w.value : null));
  for (let at = 0; at < words.length; at++) {
    const w = words[at];
    if (w === null || w === undefined) {
      if (at === 0) return false;
      continue;
    }
    if (basename(w) === prog) {
      const rest = words.slice(at + 1).filter((x): x is string => x !== null);
      return p.prefix ? inOrder(p.words.slice(1), rest) : inOrder(p.words.slice(1), rest) && rest.length === p.words.length - 1;
    }
    // Past the program, only a runner's or wrapper's words may name the one it runs.
    if (at === 0 && !isRunner(basename(w)) && !isNever(basename(w))) return false;
  }
  return false;
}

/**
 * The script of a line that is only a shell running one fixed script
 * (`bash -lc 'npm test'`, `/bin/zsh -c …`), as Codex hands its commands over;
 * null for anything else.
 */
export function backendShellScript(parsed: ParsedShell): string | null {
  const top = parsed.commands.filter((c) => c.via.length === 0 && c.substitution === null);
  if (top.length !== 1 || parsed.problems.length > 0 || parsed.unreadable) return null;
  const [cmd] = top;
  const [prog, flag, script] = cmd!.argv;
  if (cmd!.argv.length !== 3 || !literal(prog) || !SHELLS.has(basename(prog.value)) || !literal(flag) || !/^-l?cl?$/.test(flag.value)) return null;
  if (!literal(script) || cmd!.redirects.length > 0) return null;
  return script.value;
}

/** The line itself can run on rules: fully understood, nothing set or evaluated. */
export function lineRunsOnRules(parsed: ParsedShell): boolean {
  return !parsed.unreadable && parsed.problems.length === 0 && parsed.constructs.length === 0 && parsed.assignments.length === 0 && parsed.arithmetic.length === 0;
}

/** Part of the line can't be read: a script it runs that isn't in the line, or text the reader couldn't follow. */
function partlyUnread(parsed: ParsedShell): boolean {
  return parsed.unreadable === true || parsed.problems.length > 0 || parsed.commands.some((c) => c.stdinScript);
}

export type ShellRuleVerdict =
  | { kind: "deny"; rule: MatchableRule; uncertain?: true }
  | { kind: "allow"; rules: MatchableRule[] }
  | { kind: "none" };

/**
 * What saved rules make of a shell line (the caller checks the level and
 * credential paths for allow). Deny first, on every command; a line partly
 * unread whose text names a deny rule's words in order is refused too. Then
 * allow, only when every command is covered.
 */
export function shellLineVerdict(parsed: ParsedShell, coverage: readonly CommandCoverage[], rules: readonly MatchableRule[], text = ""): ShellRuleVerdict {
  const shell = rules.filter((r): r is MatchableRule & { pattern: ShellPattern } => r.pattern.tool === "Bash");
  const denies = shell.filter((r) => r.effect === "deny");
  for (const cmd of parsed.commands) {
    const deny = denies.find((r) => denyMatches(cmd, r.pattern));
    if (deny) return { kind: "deny", rule: deny };
  }
  if (denies.length > 0 && partlyUnread(parsed)) {
    const tokens = text.split(/[\s;&|()<>`'"$={}]+/).filter(Boolean).map((t) => basename(t));
    const named = denies.find((r) => inOrder([basename(r.pattern.words[0]!), ...r.pattern.words.slice(1)], tokens));
    if (named) return { kind: "deny", rule: named, uncertain: true };
  }
  if (!lineRunsOnRules(parsed) || parsed.commands.length === 0) return { kind: "none" };
  const used: MatchableRule[] = [];
  for (const cov of coverage) {
    if (cov.plainRead || cov.cd?.inside) continue;
    const cmd = parsed.commands[cov.index]!;
    if (!coverable(cov, cmd)) return { kind: "none" };
    const allow = shell.find((r) => r.effect === "allow" && shellRuleProblem(r.pattern.words, r.pattern.prefix) === null && wordsMatch(cmd, r.pattern));
    if (!allow) return { kind: "none" };
    if (!used.includes(allow)) used.push(allow);
  }
  return used.length > 0 ? { kind: "allow", rules: used } : { kind: "none" };
}

/** The rule a card offers for one command: `program verb:*` for building and checking, else the exact command. */
function proposeOne(cmd: SimpleCommand): ShellPattern | null {
  const lit = cmd.argv.map((w) => (literal(w) ? w.value : null));
  const [prog, sub, third] = lit;
  if (!prog) return null;
  // `npm run lint`: a runner's run, of a named script that builds or checks.
  if (sub && RUN_SUBCOMMANDS[basename(prog)]?.has(sub)) {
    if (third && PREFIX_VERBS.has(third)) return { tool: "Bash", words: [prog, sub, third], prefix: true };
  } else if (sub && PREFIX_VERBS.has(sub)) {
    return { tool: "Bash", words: [prog, sub], prefix: true };
  }
  return lit.every((w): w is string => w !== null) ? { tool: "Bash", words: lit, prefix: false } : null;
}

/**
 * The rules a card offers to save for a shell line: one per simple command
 * not already covered. Null when some command can't be one, and an empty list
 * when every command is covered already.
 */
export function proposeShellRules(parsed: ParsedShell, coverage: readonly CommandCoverage[], rules: readonly MatchableRule[]): RulePattern[] | null {
  if (!lineRunsOnRules(parsed) || parsed.commands.length === 0) return null;
  const allow = rules.filter((r): r is MatchableRule & { pattern: ShellPattern } => r.effect === "allow" && r.pattern.tool === "Bash");
  const out: RulePattern[] = [];
  const seen = new Set<string>();
  for (const cov of coverage) {
    if (cov.plainRead || cov.cd?.inside) continue;
    const cmd = parsed.commands[cov.index]!;
    if (!coverable(cov, cmd)) return null;
    if (allow.some((r) => shellRuleProblem(r.pattern.words, r.pattern.prefix) === null && wordsMatch(cmd, r.pattern))) continue;
    const pattern = proposeOne(cmd);
    if (!pattern || shellRuleProblem(pattern.words, pattern.prefix) !== null) return null;
    const key = formatRule(pattern);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(pattern);
    }
  }
  return out;
}

/** A host a rule never allows fetching: loopback, a local name, or an IP address. */
function localHost(host: string): boolean {
  return host === "localhost" || /\.(localhost|local|internal|home\.arpa)$/.test(host) || /^[\d.]+$/.test(host) || !host.includes(".");
}

/** What an http(s) fetch reaches, or null when the input names no plain URL. */
export function fetchTargetOf(input: Record<string, unknown>): { host: string; defaultPort: boolean } | null {
  if (typeof input.url !== "string") return null;
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    return null;
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username !== "" || url.password !== "") return null;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  return HOST.test(host) ? { host, defaultPort: url.port === "" } : null;
}

/** The host an http(s) fetch reaches, or null. */
export function fetchHostOf(input: Record<string, unknown>): string | null {
  return fetchTargetOf(input)?.host ?? null;
}

/**
 * The rule a non-shell call matches, deny first. A fetch deny rule covers the
 * host's subdomains too, and a fetch whose host can't be read is refused while
 * any fetch deny rule exists; an allow rule covers the host itself on its
 * default port only, never a local or IP address.
 */
export function toolRuleMatch(toolName: string, input: Record<string, unknown>, rules: readonly MatchableRule[]): MatchableRule | null {
  if (toolName === "WebFetch") {
    const target = fetchTargetOf(input);
    const denies = rules.filter((r) => r.effect === "deny" && r.pattern.tool === "WebFetch");
    const denied = target
      ? denies.find((r) => r.pattern.tool === "WebFetch" && (target.host === r.pattern.host || target.host.endsWith(`.${r.pattern.host}`)))
      : denies[0];
    if (denied) return denied;
    if (!target || !target.defaultPort || localHost(target.host)) return null;
    return rules.find((r) => r.effect === "allow" && r.pattern.tool === "WebFetch" && r.pattern.host === target.host) ?? null;
  }
  const named = (r: MatchableRule) => r.pattern.tool === "mcp" && r.pattern.name === toolName;
  return rules.find((r) => r.effect === "deny" && named(r)) ?? rules.find((r) => r.effect === "allow" && named(r)) ?? null;
}

/** The rule a card offers for a non-shell call, or null. */
export function proposeToolRule(toolName: string, input: Record<string, unknown>): RulePattern | null {
  if (toolName === "WebFetch") {
    const target = fetchTargetOf(input);
    return target?.defaultPort && !localHost(target.host) ? { tool: "WebFetch", host: target.host } : null;
  }
  return MCP_NAME.test(toolName) ? { tool: "mcp", name: toolName } : null;
}
