/**
 * Saved approval rules (docs/secrets-and-memory-design.md §4.1): what a rule
 * is, which rules can exist, and whether one runs a tool call. Pure: the
 * store and the service keep and look up rules, Session decides with them.
 *
 * A rule is one of:
 * - `Bash(npm test)`: exactly that command; `Bash(npm test:*)`: that command
 *   and any words after it.
 * - `mcp__<server>__<tool>`: that MCP tool.
 * - `WebFetch(domain:<host>)`: an http(s) fetch of exactly that host.
 *
 * A shell line runs on allow rules only when every simple command in it is
 * covered: a plain read (low's allow-list, judged alone), a `cd` to a literal
 * directory in the workspace, or a match for an allow rule. A deny rule matching any
 * of its commands refuses it.
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

/** A rule as the gate matches it: its pattern and what it does. */
export interface MatchableRule {
  id: string;
  pattern: RulePattern;
  effect: RuleEffect;
  scope: RuleScopeKind;
}

/** Shells, and programs that run another program or as another user: never the program of a rule. */
const NEVER_PROGRAMS = new Set([
  "sh", "bash", "zsh", "dash", "ksh", "mksh", "csh", "tcsh", "fish", "nu", "ash", "busybox", "toybox",
  "eval", "exec", "source", ".", "command", "builtin", "coproc", "trap", "alias",
  "sudo", "doas", "su", "pkexec", "runuser", "chroot", "env", "xargs", "nohup", "nice", "ionice", "timeout", "time",
  "watch", "flock", "script", "setsid", "stdbuf", "unbuffer", "taskset", "chrt", "parallel", "nsenter", "unshare",
  "ssh", "fakeroot", "tmux", "screen",
]);

/** Interpreters and package runners: a rule needs a first word after the program that isn't an option. */
const RUNNERS = new Set([
  "python", "python2", "python3", "pypy", "pypy3", "node", "nodejs", "deno", "bun", "perl", "ruby", "irb", "php", "lua", "luajit",
  "Rscript", "R", "julia", "awk", "gawk", "mawk", "nawk", "sed", "tclsh", "wish", "osascript", "pwsh", "powershell", "groovy",
  "npx", "bunx", "pnpx", "uvx", "pipx", "dlx", "java", "jshell", "swift", "scala", "elixir", "erl", "racket", "guile", "sbcl",
]);

/** A word a rule can hold: no space, quote, shell operator or wildcard, so its text reads back the same. */
const RULE_WORD = /^[^\s'"`$\\;&|<>(){}*?[\]#~!]+$/;
/** A second word read as a subcommand when a card proposes a rule (`npm test` → `Bash(npm test:*)`). */
const SUBCOMMAND = /^[A-Za-z][A-Za-z0-9-]*$/;
const MCP_NAME = /^mcp__[A-Za-z0-9_.-]+__[A-Za-z0-9_.-]+$/;
const HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** Why `words` can't be a shell rule, or null when they can. */
export function shellRuleProblem(words: readonly string[], prefix: boolean): string | null {
  if (words.length === 0) return "a shell rule needs a program";
  const bad = words.find((w) => !RULE_WORD.test(w));
  if (bad !== undefined) return `${JSON.stringify(bad)} can't be part of a rule: it has a space, quote, wildcard or shell character`;
  const prog = basename(words[0]!);
  if (NEVER_PROGRAMS.has(prog)) return `${prog} runs other programs, so it can't be a rule's program`;
  if (prefix && RUNNERS.has(prog) && !words.slice(1).some((w) => !w.startsWith("-"))) {
    return `${prog} runs any code it's given: name what it runs (Bash(${prog} <script or subcommand>:*))`;
  }
  return null;
}

/** Read a rule's text; the error says what's wrong with it. */
export function parseRule(text: string): { ok: true; pattern: RulePattern } | { ok: false; error: string } {
  const t = text.trim();
  const bash = /^Bash\((.*)\)$/s.exec(t);
  if (bash) {
    let body = bash[1]!.trim();
    const prefix = body.endsWith(":*");
    if (prefix) body = body.slice(0, -2).trimEnd();
    if (body === "" || body === "*") return { ok: false, error: "a rule must name a program: Bash and Bash(*) run anything" };
    const words = body.split(/\s+/);
    const why = shellRuleProblem(words, prefix);
    return why ? { ok: false, error: why } : { ok: true, pattern: { tool: "Bash", words, prefix } };
  }
  if (t === "Bash") return { ok: false, error: "a rule must name a program: Bash and Bash(*) run anything" };
  const fetch = /^WebFetch\(domain:(.*)\)$/.exec(t);
  if (fetch) {
    const host = fetch[1]!.trim().toLowerCase();
    if (!HOST.test(host)) return { ok: false, error: `${JSON.stringify(fetch[1])} isn't a host name` };
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

function wordsMatch(cmd: SimpleCommand, p: Extract<RulePattern, { tool: "Bash" }>): boolean {
  if (p.prefix ? cmd.argv.length < p.words.length : cmd.argv.length !== p.words.length) return false;
  return p.words.every((w, i) => literal(cmd.argv[i]) && cmd.argv[i]!.value === w);
}

/** A deny rule's match: by the program's name wherever it is and however it's run, so `sudo /bin/rm -rf x` is `rm`'s. */
function denyMatches(cmd: SimpleCommand, p: Extract<RulePattern, { tool: "Bash" }>): boolean {
  if (cmd.argv.length < p.words.length || (!p.prefix && cmd.argv.length !== p.words.length)) return false;
  const first = cmd.argv[0];
  if (!literal(first) || basename(first.value) !== basename(p.words[0]!)) return false;
  return p.words.slice(1).every((w, i) => literal(cmd.argv[i + 1]) && cmd.argv[i + 1]!.value === w);
}

/** The line itself can run on rules: fully understood, nothing set or evaluated. */
export function lineRunsOnRules(parsed: ParsedShell): boolean {
  return !parsed.unreadable && parsed.problems.length === 0 && parsed.constructs.length === 0 && parsed.assignments.length === 0 && parsed.arithmetic.length === 0;
}

export type ShellRuleVerdict =
  | { kind: "deny"; rule: MatchableRule }
  | { kind: "allow"; rules: MatchableRule[] }
  | { kind: "none" };

/**
 * What saved rules make of a shell line whose level is low or medium (the
 * caller checks the level and credential paths). Deny first, on every command;
 * then allow, only when every command is covered.
 */
export function shellLineVerdict(parsed: ParsedShell, coverage: readonly CommandCoverage[], rules: readonly MatchableRule[]): ShellRuleVerdict {
  const shell = rules.filter((r): r is MatchableRule & { pattern: Extract<RulePattern, { tool: "Bash" }> } => r.pattern.tool === "Bash");
  for (const cmd of parsed.commands) {
    const deny = shell.find((r) => r.effect === "deny" && denyMatches(cmd, r.pattern));
    if (deny) return { kind: "deny", rule: deny };
  }
  if (!lineRunsOnRules(parsed) || parsed.commands.length === 0) return { kind: "none" };
  const used: MatchableRule[] = [];
  for (const cov of coverage) {
    if (cov.plainRead || cov.cd?.inside) continue;
    const cmd = parsed.commands[cov.index]!;
    if (cov.cd || !cov.inWorkspace || !cov.plainRedirects || !plainCommand(cmd)) return { kind: "none" };
    const allow = shell.find((r) => r.effect === "allow" && shellRuleProblem(r.pattern.words, r.pattern.prefix) === null && wordsMatch(cmd, r.pattern));
    if (!allow) return { kind: "none" };
    if (!used.includes(allow)) used.push(allow);
  }
  return used.length > 0 ? { kind: "allow", rules: used } : { kind: "none" };
}

/**
 * The rules a card offers to save for a shell line: one per simple command
 * not already covered, `program subcommand:*` when the second word reads as a
 * subcommand, else the exact command. Null when some command can't be one.
 */
export function proposeShellRules(parsed: ParsedShell, coverage: readonly CommandCoverage[], rules: readonly MatchableRule[]): RulePattern[] | null {
  if (!lineRunsOnRules(parsed) || parsed.commands.length === 0) return null;
  const allow = rules.filter((r): r is MatchableRule & { pattern: Extract<RulePattern, { tool: "Bash" }> } => r.effect === "allow" && r.pattern.tool === "Bash");
  const out: RulePattern[] = [];
  const seen = new Set<string>();
  for (const cov of coverage) {
    if (cov.plainRead || cov.cd?.inside) continue;
    const cmd = parsed.commands[cov.index]!;
    if (cov.cd || !cov.inWorkspace || !cov.plainRedirects || !plainCommand(cmd)) return null;
    if (allow.some((r) => wordsMatch(cmd, r.pattern))) continue;
    if (!cmd.argv.every(literal)) {
      // Only the words the rule keeps need be known: `npm test -- $FILE` is `npm test:*`.
      if (!(literal(cmd.argv[0]) && literal(cmd.argv[1]) && SUBCOMMAND.test(cmd.argv[1].value))) return null;
    }
    const words = cmd.argv.map((w) => w.value ?? "");
    const sub = words[1];
    const pattern: Extract<RulePattern, { tool: "Bash" }> =
      sub !== undefined && SUBCOMMAND.test(sub) && literal(cmd.argv[1]) ? { tool: "Bash", words: [words[0]!, sub], prefix: true } : { tool: "Bash", words, prefix: false };
    if (shellRuleProblem(pattern.words, pattern.prefix) !== null) return null;
    const key = formatRule(pattern);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(pattern);
    }
  }
  return out.length > 0 ? out : null;
}

/** The host an http(s) fetch reaches, or null when the input names no plain URL. */
export function fetchHostOf(input: Record<string, unknown>): string | null {
  if (typeof input.url !== "string") return null;
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    return null;
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username !== "" || url.password !== "") return null;
  const host = url.hostname.toLowerCase();
  return HOST.test(host) ? host : null;
}

/** The rule a non-shell call matches, deny first. */
export function toolRuleMatch(toolName: string, input: Record<string, unknown>, rules: readonly MatchableRule[]): MatchableRule | null {
  const matching = (r: MatchableRule): boolean => {
    if (r.pattern.tool === "mcp") return r.pattern.name === toolName;
    if (r.pattern.tool === "WebFetch") return toolName === "WebFetch" && fetchHostOf(input) === r.pattern.host;
    return false;
  };
  return rules.find((r) => r.effect === "deny" && matching(r)) ?? rules.find((r) => r.effect === "allow" && matching(r)) ?? null;
}

/** The rule a card offers for a non-shell call, or null. */
export function proposeToolRule(toolName: string, input: Record<string, unknown>): RulePattern | null {
  if (toolName === "WebFetch") {
    const host = fetchHostOf(input);
    return host ? { tool: "WebFetch", host } : null;
  }
  return MCP_NAME.test(toolName) ? { tool: "mcp", name: toolName } : null;
}
