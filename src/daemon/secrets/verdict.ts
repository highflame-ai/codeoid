/**
 * Each tool call's verdict before it is stored
 * (docs/secrets-and-memory-design.md §2.4, after atuin's
 * `session_capture/policy.rs`):
 *
 * - `keep`: stored, scrubbed (the default);
 * - `withhold-output`: stored, its output replaced by a note — a command that
 *   exists to print a credential (`gh auth token`, `printenv`, `op read`, …),
 *   or a read of a credential file (`cat .env`, a file tool reading
 *   `~/.aws/credentials`);
 * - `withhold-written`: a write of a credential file stored without what was
 *   written;
 * - `drop`: not stored at all (a command the user listed in
 *   `secrets.dropCommands`).
 *
 * A shell line is read with codeoid's parser (shell/parse.ts), wrappers and
 * `bash -c '…'` looked through, so `x=$(gh auth token)` is caught as the plain
 * form is. A line the parser can't read is matched as text, so it fails toward
 * withholding.
 */

import { parseShellSync, type SimpleCommand } from "../shell/parse.js";
import { shellCallOf } from "../shell/tool-call.js";
import { toolReadPaths } from "../secret-paths.js";
import { isCredentialFile } from "./files.js";

export type ToolVerdict = "keep" | "withhold-output" | "withhold-written" | "drop";

export const OUTPUT_WITHHELD = "‹output withheld: it prints credentials›";
export const WRITTEN_WITHHELD = "‹content withheld: a credential file›";

/**
 * Commands whose output is a credential, as argv prefixes (`*` any one word).
 * Matched against the words after the program's own options are skipped
 * (`aws --profile x configure get …`).
 */
const PRINTS_CREDENTIALS: ReadonlyArray<readonly string[]> = [
  ["gh", "auth", "token"],
  ["glab", "auth", "status", "--show-token"],
  ["gcloud", "auth", "print-access-token"],
  ["gcloud", "auth", "print-identity-token"],
  ["gcloud", "auth", "application-default", "print-access-token"],
  ["aws", "configure", "get"],
  ["aws", "configure", "export-credentials"],
  ["aws", "sts", "get-session-token"],
  ["aws", "sts", "assume-role"],
  ["aws", "sts", "get-federation-token"],
  ["aws", "ecr", "get-login-password"],
  ["aws", "ecr-public", "get-login-password"],
  ["aws", "codeartifact", "get-authorization-token"],
  ["az", "account", "get-access-token"],
  ["az", "ad", "sp", "create-for-rbac"],
  ["az", "ad", "sp", "credential", "reset"],
  ["kubectl", "get", "secret"],
  ["kubectl", "get", "secrets"],
  ["kubectl", "describe", "secret"],
  ["kubectl", "describe", "secrets"],
  ["kubectl", "create", "token"],
  ["vault", "read"],
  ["vault", "login"],
  ["vault", "print", "token"],
  ["vault", "token", "create"],
  ["vault", "kv", "get"],
  ["op", "read"],
  ["op", "inject"],
  ["op", "item", "get"],
  ["pass", "show"],
  ["gopass", "show"],
  ["gopass", "cat"],
  ["secret-tool", "lookup"],
  ["heroku", "auth:token"],
  ["doppler", "secrets"],
  ["npm", "token", "create"],
  ["git", "credential", "fill"],
  ["printenv"],
  ["codeoid", "mcp", "headers"],
  ["atuin", "key"],
];

/** Programs that print the environment when run alone (no command after them). */
const ENV_PRINTERS = new Set(["env", "set", "export", "declare", "typeset"]);

/** Programs that print a file's contents: a credential file among their operands is read out. */
const FILE_PRINTERS = new Set(["cat", "less", "more", "head", "tail", "bat", "batcat", "nl", "tac", "strings", "xxd", "hexdump", "od", "base64", "grep", "rg", "ag", "awk", "sed", "jq", "yq", "cut", "sort", "diff"]);

const PROGRAM_OPTION_WITH_VALUE = /^--?(?:profile|region|output|namespace|context|kubeconfig|n|address|format|account|vault|project)$/;

/** argv as text: a word only known at run time is null, but one that is only `$HOME/…` reads as `~/…`. */
function words(c: SimpleCommand): Array<string | null> {
  return c.argv.map((w) => w.value ?? w.home ?? null);
}

/** The paths a program reads besides its plain operands: `dd if=FILE`, `git show REV:FILE`. */
function readsOf(argv: Array<string | null>): string[] {
  const program = programName(argv[0] ?? "");
  const out: string[] = [];
  for (const a of argv.slice(1)) {
    if (a === null) continue;
    if (program === "dd" && a.startsWith("if=")) out.push(a.slice(3));
    if (program === "git" && /^[^-:][^:]*:[^:]+$/.test(a) && argv.slice(1).some((w) => w === "show" || w === "cat-file")) out.push(a.slice(a.indexOf(":") + 1));
  }
  // git's commands that print a file's contents or changes: their path operands are read out.
  if (program === "git" && argv.slice(1).some((w) => w !== null && ["show", "diff", "log", "blame", "grep", "cat-file"].includes(w))) {
    for (const a of argv.slice(1)) if (a !== null && !a.startsWith("-")) out.push(a);
  }
  return out;
}

function programName(word: string): string {
  return word.slice(word.lastIndexOf("/") + 1);
}

/** The words after the program, its own options (and their values) skipped, for matching a subcommand. */
function subcommandWords(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    const w = argv[i]!;
    if (out.length === 0 && w.startsWith("-")) {
      if (!w.includes("=") && PROGRAM_OPTION_WITH_VALUE.test(w)) i++;
      continue;
    }
    out.push(w);
  }
  return out;
}

function printsCredentials(argv: string[]): boolean {
  const program = programName(argv[0] ?? "");
  const rest = subcommandWords(argv);
  for (const sig of PRINTS_CREDENTIALS) {
    if (sig[0] !== program) continue;
    const tail = sig.slice(1);
    // `glab auth status --show-token`: the flag may come anywhere after the subcommand.
    const flag = tail.find((t) => t.startsWith("--"));
    const sub = tail.filter((t) => !t.startsWith("--"));
    if (sub.every((t, i) => t === "*" || rest[i] === t) && (!flag || argv.includes(flag))) return true;
  }
  // `gh auth status -t` / `--show-token`.
  if (program === "gh" && rest[0] === "auth" && rest[1] === "status" && (argv.includes("-t") || argv.includes("--show-token"))) return true;
  // `security find-generic-password -w` (macOS keychain: -w / -g print the password).
  if (program === "security" && /^find-(?:generic|internet)-password$/.test(rest[0] ?? "") && argv.some((a) => /^-[a-zA-Z]*[wg]/.test(a))) return true;
  // `kubectl config view --raw`, `terraform output -json|-raw`.
  if (program === "kubectl" && rest[0] === "config" && rest[1] === "view" && argv.includes("--raw")) return true;
  if (program === "terraform" && rest[0] === "output" && (argv.includes("-json") || argv.includes("-raw"))) return true;
  // The environment, the shell's variables: alone, not running a command.
  if (ENV_PRINTERS.has(program)) {
    const opts = argv.slice(1);
    if (program === "env" && opts.every((a) => a.startsWith("-"))) return true;
    if (program === "set" && opts.length === 0) return true;
    if ((program === "export" || program === "declare" || program === "typeset") && opts.length > 0 && opts.every((a) => /^-[a-zA-Z]*[px]/.test(a))) return true;
  }
  return false;
}

/** The same, matched as text when the line can't be parsed: fails toward withholding. */
const PRINTS_CREDENTIALS_TEXT =
  /(?:^|[;&|(`{!\n'"]|\$\()\s*(?:(?:sudo|command|exec|time|nohup)\s+|\w+=\S*\s+)*(?:\S*\/)?(?:(?:env|set|export\s+-p)\s*(?:$|[;&|)\n'"])|gh\s+auth\s+token|printenv|gcloud\s+auth\s+(?:application-default\s+)?print-(?:access|identity)-token|aws\b[^\n;&|]*\bconfigure\s+(?:get|export-credentials)|op\s+(?:read|inject|item\s+get)|vault\s+(?:read|login|kv\s+get|print\s+token)|kubectl\b[^\n;&|]*\b(?:get|describe)\s+secrets?|git\s+credential\s+fill|pass\s+show|secret-tool\s+lookup)\b/;

export interface VerdictOptions {
  /** Where the call runs, for relative paths. */
  cwd: string;
  /** `secrets.dropCommands`: programs (or argv prefixes, space-separated) whose calls aren't stored at all. */
  dropCommands?: readonly string[];
  /** `secrets.credentialFiles`: more file globs that hold credentials. */
  credentialFiles?: readonly string[];
}

/** Whether a tool is one that writes files (by every backend's name for it). */
function writesFiles(toolName: string): boolean {
  return /^(?:write|edit|multiedit|notebookedit|codex_file_change|write_file|replace|edit_file|create_file|apply_patch|str_replace_based_edit_tool|patch)$/i.test(toolName);
}

/** A tool call's verdict (see the module comment). Never throws. */
export function toolVerdict(toolName: string, input: unknown, opts: VerdictOptions): ToolVerdict {
  try {
    const obj = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
    const shell = shellCallOf(toolName, obj);
    if (shell) return shellVerdict(shell.command, shell.cwd ?? opts.cwd, opts);
    const paths = toolReadPaths(toolName, obj);
    if (paths.some((p) => isCredentialFile(p, opts.cwd, opts.credentialFiles))) {
      return writesFiles(toolName) ? "withhold-written" : "withhold-output";
    }
    return "keep";
  } catch {
    return "keep";
  }
}

function shellVerdict(command: string, cwd: string, opts: VerdictOptions): ToolVerdict {
  const parsed = parseShellSync(command);
  const drops = (opts.dropCommands ?? []).map((d) => d.trim().split(/\s+/).filter(Boolean)).filter((d) => d.length > 0);
  if (parsed.unreadable) {
    if (drops.some((d) => command.includes(d.join(" ")))) return "drop";
    if (PRINTS_CREDENTIALS_TEXT.test(command)) return "withhold-output";
    // A reader and a credential file named anywhere on the line: withheld, since the line can't be read.
    const tokens = command.split(/[\s;&|()<>]+/).map((t) => t.replace(/^["']|["']$/g, "")).filter(Boolean);
    if (tokens.some((t) => FILE_PRINTERS.has(programName(t))) && tokens.some((t) => isCredentialFile(t, cwd, opts.credentialFiles))) return "withhold-output";
    return "keep";
  }
  let verdict: ToolVerdict = "keep";
  for (const c of parsed.commands) {
    const argv = words(c);
    if (argv.length === 0 || argv[0] === null) continue;
    const program = programName(argv[0]);
    if (drops.some((d) => d.every((w, i) => (i === 0 ? program === w : argv[i] === w)))) return "drop";
    // A word only known at run time can't be a subcommand that prints a credential; the rest still counts.
    if (argv.every((a) => a !== null) && printsCredentials(argv as string[])) verdict = "withhold-output";
    // A credential file read out: an operand of a printer, what dd or git show reads, or a redirect it reads (`< .env`).
    const known = argv.filter((a): a is string => a !== null);
    const operands = [...(FILE_PRINTERS.has(program) ? known.slice(1).filter((a) => !a.startsWith("-")) : []), ...readsOf(argv)];
    const reads = c.redirects.filter((r) => r.op === "<" && r.target?.value).map((r) => r.target!.value!);
    if ([...operands, ...reads].some((p) => isCredentialFile(p, cwd, opts.credentialFiles))) verdict = "withhold-output";
    // A credential file written by a redirect (`echo KEY=… > .env`): the line holds the value.
    const writes = c.redirects.filter((r) => /^(?:>|>>|&>|>\||&>>)$/.test(r.op) && r.target?.value).map((r) => r.target!.value!);
    if (writes.some((p) => isCredentialFile(p, cwd, opts.credentialFiles)) && verdict === "keep") verdict = "withhold-written";
  }
  if (verdict === "keep" && parsed.problems.length > 0 && PRINTS_CREDENTIALS_TEXT.test(command)) verdict = "withhold-output";
  return verdict;
}
