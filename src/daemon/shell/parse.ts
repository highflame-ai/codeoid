/**
 * What a shell command line runs (#431): every simple command in it, with its
 * argv, redirections and the pipeline it sits in, wrappers looked through
 * (`sudo`, `env`, `xargs`, `bash -c '…'`, `find -exec`, …). The approval gate
 * judges risk from this, never from a tool's name or a regex over the text.
 *
 * Parsing is tree-sitter's bash grammar, in WASM (no native addon). Anything
 * it can't read with certainty is reported in `problems`, and a caller must
 * treat a line with problems as not understood: never as harmless.
 */
import { fileURLToPath } from "node:url";
import { Language, type Node, Parser } from "web-tree-sitter";
import bashWasm from "./tree-sitter-bash.wasm" with { type: "file" };

/** One shell word after quote removal. */
export interface ShellWord {
  /** The word's value, or null when it depends on the environment at run time (`$X`, `$(…)`). */
  value: string | null;
  /** The source text. */
  raw: string;
  /** Unquoted glob or brace characters: it may expand to several words, or none. */
  glob: boolean;
  /** An argument supplied at run time: xargs's input, or a match find -exec runs on. */
  input?: true;
  /** When the word is unknown only for a leading `$HOME` / `${HOME}`: its value with that written `~` (`"$HOME/.ssh"` is `~/.ssh`). */
  home?: string;
}

export interface ShellRedirect {
  /** `>`, `>>`, `<`, `&>`, `>&`, `<<`, `<<<`, … */
  op: string;
  fd: number | null;
  /** Where it reads or writes; null for a here-document. */
  target: ShellWord | null;
  /** A here-document's text: null when it expands anything at run time; undefined for any other redirect. */
  body?: string | null;
}

export interface SimpleCommand {
  /** argv, wrappers removed: `sudo rm -rf x` is `rm -rf x`, run `via` sudo. */
  argv: ShellWord[];
  redirects: ShellRedirect[];
  /** The wrappers it was found inside, outermost first (`sudo`, `bash -c`, `xargs`, …). */
  via: string[];
  /** The pipeline it belongs to, and its stage there (0 = first). Commands outside any pipeline have their own id. */
  pipeline: number;
  stage: number;
  /** What its output feeds, when it is the inside of a substitution: the index of the command whose word holds it. */
  feeds: number | null;
  /** The substitution it is the inside of: `$(…)`, `<(…)`, `>(…)`. */
  substitution: "command" | "process-in" | "process-out" | null;
  /** It reads a here-document or here-string as its input. */
  heredoc: boolean;
  /**
   * A shell given a script to run (`bash -c '…'`, `eval …`, `bash <<EOF`):
   * what it runs is in the commands parsed from that script, listed after it.
   */
  delegates: boolean;
  /** For a command find -exec runs: the index of that find, whose search roots its `{}` is under. */
  inputFrom?: number;
}

export interface ParsedShell {
  commands: SimpleCommand[];
  /** Why the line isn't fully understood; empty when it is. */
  problems: string[];
}

/** Deeper than this (`bash -c "bash -c '…'"` nested) and the line is not understood. */
const MAX_DEPTH = 8;
/** Longer than this and the line is not understood: a huge line is no ordinary command. */
const MAX_LENGTH = 100_000;

let ready: Promise<Parser> | null = null;
let loaded: Parser | null = null;

/**
 * Load the parser (once; a load that fails is retried on the next call). The
 * daemon loads it at start, so the approval gate can judge a command in the
 * same step as it decides — see parseShellSync.
 */
export function loadShellParser(): Promise<Parser> {
  ready ??= (async () => {
    await Parser.init({
      locateFile: (name: string) => fileURLToPath(import.meta.resolve(`web-tree-sitter/${name}`)),
    });
    const language = await Language.load(await Bun.file(bashWasm).bytes());
    const p = new Parser();
    p.setLanguage(language);
    loaded = p;
    return p;
  })().catch((err) => {
    ready = null;
    throw err;
  });
  return ready;
}

/** The parser is loaded: parseShellSync understands commands. */
export function shellParserReady(): boolean {
  return loaded !== null;
}

/** Parse a command line, loading the parser first if need be. Never throws: a failure to parse is a problem, reported. */
export async function parseShell(source: string): Promise<ParsedShell> {
  try {
    await loadShellParser();
  } catch (err) {
    return { commands: [], problems: [`the shell parser failed to load: ${err instanceof Error ? err.message : String(err)}`] };
  }
  return parseShellSync(source);
}

/** Parse with the parser already loaded; before it is, nothing is understood. */
export function parseShellSync(source: string): ParsedShell {
  const out: ParsedShell = { commands: [], problems: [] };
  if (source.length > MAX_LENGTH) {
    out.problems.push(`the command is over ${MAX_LENGTH} characters`);
    return out;
  }
  if (!loaded) {
    out.problems.push("the shell parser isn't loaded");
    return out;
  }
  try {
    new Walker(loaded, out).line(source, [], 0);
  } catch (err) {
    out.problems.push(`the command couldn't be parsed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return out;
}

interface Ctx {
  via: string[];
  depth: number;
  pipeline: number;
  stage: number;
  feeds: number | null;
  substitution: SimpleCommand["substitution"];
  redirects: ShellRedirect[];
  heredoc: boolean;
}

class Walker {
  #nextPipeline = 0;
  constructor(
    private readonly parser: Parser,
    private readonly out: ParsedShell,
  ) {}

  /** A whole line (the top level, or the string a `bash -c` runs). */
  line(source: string, via: string[], depth: number): void {
    if (depth > MAX_DEPTH) {
      this.out.problems.push("shells nested too deep");
      return;
    }
    const tree = this.parser.parse(source);
    if (!tree) {
      this.out.problems.push("the command could not be parsed");
      return;
    }
    try {
      if (tree.rootNode.hasError) this.out.problems.push("the command has a syntax error or a construct the parser doesn't know");
      this.node(tree.rootNode, this.#fresh(via, depth));
    } finally {
      tree.delete();
    }
  }

  #fresh(via: string[], depth: number, over: Partial<Ctx> = {}): Ctx {
    return { via, depth, pipeline: this.#nextPipeline++, stage: 0, feeds: null, substitution: null, redirects: [], heredoc: false, ...over };
  }

  node(n: Node, ctx: Ctx): void {
    switch (n.type) {
      case "comment":
        return;
      case "command":
        this.command(n, ctx);
        return;
      case "pipeline": {
        const pipeline = this.#nextPipeline++;
        let stage = 0;
        for (const c of n.namedChildren) {
          if (!c || c.type === "comment") continue;
          this.node(c, { ...ctx, pipeline, stage: stage++ });
        }
        return;
      }
      case "redirected_statement": {
        // The grammar attaches a trailing redirect to a whole `a && b > f`
        // list; bash gives it to `b` alone. Giving it to all of them only
        // ever over-states what is written.
        const redirects = [...ctx.redirects];
        let heredoc = ctx.heredoc;
        for (const r of n.childrenForFieldName("redirect")) {
          if (!r) continue;
          redirects.push(...this.redirect(r, ctx));
          if (r.type === "heredoc_redirect" || r.type === "herestring_redirect") heredoc = true;
        }
        const body = n.childForFieldName("body");
        if (body) this.node(body, { ...ctx, redirects, heredoc });
        return;
      }
      case "variable_assignment":
      case "variable_assignments":
      case "declaration_command":
      case "unset_command":
      case "test_command":
        // No program runs, but a substitution inside does.
        this.substitutionsIn(n, ctx, null);
        return;
      case "program":
        // Each statement is a pipeline of its own.
        for (const c of n.namedChildren) if (c) this.node(c, { ...ctx, pipeline: this.#nextPipeline++, stage: 0 });
        return;
      default:
        // Lists, subshells, braces, if/while/for/case and functions: every
        // command inside may run, in the stage of the pipeline they're in.
        for (const c of n.namedChildren) if (c) this.node(c, ctx);
    }
  }

  command(n: Node, ctx: Ctx): void {
    const words: ShellWord[] = [];
    const redirects = [...ctx.redirects];
    let heredoc = ctx.heredoc;
    const index = this.out.commands.length;
    // Reserve the slot first: substitutions inside point at it.
    const cmd: SimpleCommand = {
      argv: words,
      redirects,
      via: ctx.via,
      pipeline: ctx.pipeline,
      stage: ctx.stage,
      feeds: ctx.feeds,
      substitution: ctx.substitution,
      heredoc,
      delegates: false,
    };
    this.out.commands.push(cmd);
    for (const c of n.namedChildren) {
      if (!c) continue;
      if (c.type === "variable_assignment") {
        this.substitutionsIn(c, ctx, index);
      } else if (c.type === "command_name") {
        const w = c.firstNamedChild;
        if (w) words.push(this.word(w, ctx, index));
      } else if (c.type === "file_redirect" || c.type === "heredoc_redirect" || c.type === "herestring_redirect") {
        redirects.push(...this.redirect(c, ctx, index));
        if (c.type !== "file_redirect") heredoc = true;
      } else if (c.type !== "comment") {
        words.push(this.word(c, ctx, index));
      }
    }
    cmd.heredoc = heredoc;
    this.unwrap(cmd, ctx);
  }

  /**
   * A redirect, and what rides on it: after `<<EOF` the rest of the line
   * (`| sh`, `> f`, `&& ls`) hangs off the here-document in the grammar.
   */
  redirect(n: Node, ctx: Ctx, owner: number | null = null): ShellRedirect[] {
    let fd: number | null = null;
    let op = "";
    let target: ShellWord | null = null;
    let body: string | null = "";
    let quoted = false;
    const more: ShellRedirect[] = [];
    for (const c of n.children) {
      if (!c) continue;
      if (c.type === "file_descriptor") fd = Number(c.text);
      else if (!c.isNamed) op ||= c.text;
      else if (n.type !== "heredoc_redirect") target = this.word(c, ctx, owner);
      else if (c.type === "heredoc_start") quoted = /['"\\]/.test(c.text);
      else if (c.type === "heredoc_end") continue;
      else if (c.type === "heredoc_body") {
        // Data to most programs — but `$(…)` in an unquoted body runs, and a shell runs all of it.
        this.substitutionsIn(c, ctx, owner);
        body = c.namedChildren.some((x) => x && x.type !== "heredoc_content") ? null : c.text;
        // So does `…`, which the grammar leaves as text in a body.
        if (!quoted && this.#backticks(c.text, ctx, owner)) body = null;
      } else if (c.type === "file_redirect" || c.type === "herestring_redirect" || c.type === "heredoc_redirect") {
        more.push(...this.redirect(c, ctx, owner));
      } else if (c.type === "pipeline") {
        // `cat <<EOF | sh`: what follows are the next stages of the owner's pipeline.
        let stage = ctx.stage + 1;
        for (const k of c.namedChildren) if (k) this.node(k, { ...ctx, stage: stage++, redirects: [], heredoc: false });
      } else {
        // `cat <<EOF && ls`: a statement of its own.
        this.node(c, { ...ctx, pipeline: this.#nextPipeline++, stage: 0, redirects: [], heredoc: false });
      }
    }
    if (!op) return more;
    if (n.type === "heredoc_redirect") return [{ op, fd, target: null, body }, ...more];
    return [{ op, fd, target }, ...more];
  }

  /** A word's value, and the commands inside its substitutions. */
  word(n: Node, ctx: Ctx, owner: number | null): ShellWord {
    const raw = n.text;
    switch (n.type) {
      case "word":
      case "number": {
        const value = unescapeUnquoted(raw);
        return { value, raw, glob: /(^|[^\\])[*?[]/.test(raw) || /(^|[^\\])\{[^}]*,/.test(raw) };
      }
      case "raw_string":
        return { value: raw.slice(1, -1), raw, glob: false };
      case "ansi_c_string": {
        const value = decodeAnsiC(raw.slice(2, -1));
        return { value, raw, glob: false };
      }
      case "string":
      case "translated_string": {
        let value: string | null = "";
        let home: string | undefined = "";
        for (const c of n.namedChildren) {
          if (!c) continue;
          if (c.type === "string_content") {
            value = value === null ? null : value + unescapeDouble(c.text);
            home = home === undefined ? undefined : home + unescapeDouble(c.text);
          } else {
            // `$X`, `$(…)` inside the quotes: known at run time, and a substitution runs.
            const w = this.word(c, ctx, owner);
            home = home === "" && w.home !== undefined ? w.home : undefined;
            value = null;
          }
        }
        // The grammar leaves a string of nothing but quotes without content nodes.
        if (value === "" && n.namedChildCount === 0) value = unescapeDouble(raw.replace(/^\$?"|"$/g, ""));
        return { value, raw, glob: false, ...(value === null && home ? { home } : {}) };
      }
      case "concatenation": {
        let value: string | null = "";
        let home: string | undefined;
        // The grammar splits `b{1,2}` into pieces none of which looks like a brace expansion.
        let glob = /(^|[^\\])\{[^}]*,/.test(raw);
        let first = true;
        for (const c of n.namedChildren) {
          if (!c) continue;
          const w = this.word(c, ctx, owner);
          glob ||= w.glob;
          if (first) home = w.home;
          else home = home === undefined || w.value === null ? undefined : home + w.value;
          first = false;
          value = value === null || w.value === null ? null : value + w.value;
        }
        return { value, raw, glob, ...(value === null && home !== undefined ? { home } : {}) };
      }
      case "command_substitution":
      case "process_substitution": {
        const kind = n.type === "command_substitution" ? "command" : raw.startsWith(">") ? "process-out" : "process-in";
        for (const c of n.namedChildren) {
          if (c) this.node(c, this.#fresh(ctx.via, ctx.depth, { feeds: owner, substitution: kind }));
        }
        return { value: null, raw, glob: false };
      }
      default:
        // $X, ${X}, $((…)), brace expressions, and anything else: known only at run time.
        this.substitutionsIn(n, ctx, owner);
        if (raw === "$HOME" || raw === "${HOME}") return { value: null, raw, glob: false, home: "~" };
        return { value: null, raw, glob: n.type === "brace_expression" };
    }
  }

  /**
   * The `…` substitutions in an unquoted here-document's text, parsed as the
   * commands they run. True when there is one.
   */
  #backticks(text: string, ctx: Ctx, owner: number | null): boolean {
    let found = false;
    for (let i = 0; i < text.length; i++) {
      if (text[i] === "\\") {
        i++;
        continue;
      }
      if (text[i] !== "`") continue;
      found = true;
      let inner = "";
      let j = i + 1;
      for (; j < text.length && text[j] !== "`"; j++) {
        // Inside backquotes a backslash quotes only $ ` and \.
        if (text[j] === "\\" && /[$`\\]/.test(text[j + 1] ?? "")) inner += text[++j];
        else inner += text[j];
      }
      if (j >= text.length) {
        this.out.problems.push("a here-document has an unterminated `…`");
        return true;
      }
      this.#substitution(inner, ctx, owner);
      i = j;
    }
    return found;
  }

  /** The text of a `$(…)`-like substitution, parsed as the commands it runs. */
  #substitution(source: string, ctx: Ctx, owner: number | null): void {
    if (ctx.depth + 1 > MAX_DEPTH) {
      this.out.problems.push("shells nested too deep");
      return;
    }
    const tree = this.parser.parse(source);
    if (!tree) {
      this.out.problems.push("the command could not be parsed");
      return;
    }
    try {
      if (tree.rootNode.hasError) this.out.problems.push("the command has a syntax error or a construct the parser doesn't know");
      this.node(tree.rootNode, this.#fresh(ctx.via, ctx.depth + 1, { feeds: owner, substitution: "command" }));
    } finally {
      tree.delete();
    }
  }

  /** Commands inside `$(…)` / `<(…)` anywhere under n. */
  substitutionsIn(n: Node, ctx: Ctx, owner: number | null): void {
    for (const c of n.namedChildren) {
      if (!c) continue;
      if (c.type === "command_substitution" || c.type === "process_substitution") this.word(c, ctx, owner);
      else this.substitutionsIn(c, ctx, owner);
    }
  }

  /**
   * A wrapper runs another command: replace the wrapper's argv with the one
   * it runs, and remember the wrapper. A shell given a string to run (`-c`)
   * has the string parsed in turn.
   */
  unwrap(cmd: SimpleCommand, ctx: Ctx): void {
    for (let guard = 0; guard < MAX_DEPTH; guard++) {
      const name = cmd.argv[0];
      if (!name) return;
      if (name.value === null) {
        this.out.problems.push(`the program to run is only known at run time (${name.raw})`);
        return;
      }
      const prog = basename(name.value);
      const inner = WRAPPERS[prog]?.(cmd.argv.slice(1));
      if (inner === undefined) {
        if (!SHELLS.has(prog)) return;
        const script = shellScript(cmd);
        if (script === undefined) return; // a script file, or stdin from a pipe: judged as the shell itself
        if (script === null) {
          this.out.problems.push(`${prog} runs a script only known at run time`);
          return;
        }
        // The shell stays in the list (it is the program run); what it runs follows.
        cmd.delegates = true;
        this.line(script, [...cmd.via, prog], ctx.depth + 1);
        return;
      }
      if (inner === null) {
        this.out.problems.push(`can't tell what ${prog} runs`);
        return;
      }
      if (inner.kind === "eval") {
        const parts = inner.argv.map((w) => w.value);
        if (parts.some((v) => v === null)) {
          this.out.problems.push(`${prog} runs a string only known at run time`);
          return;
        }
        cmd.delegates = true;
        this.line(parts.join(" "), [...cmd.via, prog], ctx.depth + 1);
        return;
      }
      if (inner.kind === "exec") {
        // find -exec: the command runs per match, its `{}` a path from the search.
        const inputFrom = this.out.commands.indexOf(cmd);
        for (const run of inner.runs) {
          if (run.length === 0) continue;
          const sub: SimpleCommand = { ...cmd, argv: run, via: [...cmd.via, prog], redirects: [], heredoc: false, delegates: false, inputFrom };
          this.out.commands.push(sub);
          this.unwrap(sub, ctx);
        }
        return;
      }
      // A wrapper with nothing to run (`env`, `sudo` alone) is judged as itself.
      if (inner.argv.length === 0) return;
      cmd.via = [...cmd.via, prog];
      cmd.argv = inner.argv;
    }
    this.out.problems.push("wrappers nested too deep");
  }
}

type Unwrapped = { kind: "run"; argv: ShellWord[] } | { kind: "eval"; argv: ShellWord[] } | { kind: "exec"; runs: ShellWord[][] };

/** Options taking a value, per wrapper: `sudo -u root` is not a command named `root`. */
function skipOptions(args: ShellWord[], withValue: ReadonlySet<string>, opts: { stopAtNonOption?: boolean; assignments?: boolean } = {}): ShellWord[] | null {
  let i = 0;
  while (i < args.length) {
    const v = args[i]!.value;
    if (v === null) return null;
    if (v === "--") return args.slice(i + 1);
    if (opts.assignments && /^[A-Za-z_][A-Za-z0-9_]*=/.test(v)) {
      i++;
      continue;
    }
    if (!v.startsWith("-") || v === "-") break;
    if (v.startsWith("--")) {
      const eq = v.indexOf("=");
      i += eq < 0 && withValue.has(v) ? 2 : 1;
      continue;
    }
    // Clustered short options: `-un root` takes the value after the cluster; `-uroot` holds it.
    let consumed = 1;
    for (let k = 1; k < v.length; k++) {
      if (withValue.has(`-${v[k]}`)) {
        if (k === v.length - 1) consumed = 2;
        break;
      }
    }
    i += consumed;
  }
  return args.slice(i);
}

const run = (argv: ShellWord[] | null): Unwrapped | null => (argv === null ? null : { kind: "run", argv });

/** Programs that run the command named in their arguments. */
const WRAPPERS: Record<string, (args: ShellWord[]) => Unwrapped | null | undefined> = {
  sudo: (a) => {
    // `sudo -e` / `-l` / `-v` / `-k` run no command of the caller's choosing.
    if (a.some((w) => w.value !== null && /^-[a-zA-Z]*[elvkK]/.test(w.value) && !w.value.startsWith("--"))) return undefined;
    return run(skipOptions(a, new Set(["-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-T", "-U", "--user", "--group", "--chdir", "--host", "--prompt", "--role", "--type", "--command-timeout", "--other-user", "--close-from"])));
  },
  doas: (a) => run(skipOptions(a, new Set(["-u", "-C"]))),
  env: (a) => {
    // `env -S "…"` splits a string into a command line.
    if (a.some((w) => w.value === "-S" || w.value?.startsWith("--split-string") || (w.value?.startsWith("-S") ?? false))) return null;
    return run(skipOptions(a, new Set(["-u", "-C", "--unset", "--chdir"]), { assignments: true }));
  },
  nice: (a) => run(skipOptions(a, new Set(["-n", "--adjustment"]))),
  nohup: (a) => run(skipOptions(a, new Set())),
  setsid: (a) => run(skipOptions(a, new Set())),
  time: (a) => run(skipOptions(a, new Set(["-f", "-o", "--format", "--output"]))),
  command: (a) => {
    // `command -v x` looks x up; it runs nothing.
    if (a.some((w) => w.value === "-v" || w.value === "-V")) return undefined;
    return run(skipOptions(a, new Set()));
  },
  builtin: (a) => run(a),
  exec: (a) => run(skipOptions(a, new Set(["-a"]))),
  stdbuf: (a) => run(skipOptions(a, new Set(["-i", "-o", "-e", "--input", "--output", "--error"]))),
  ionice: (a) => run(skipOptions(a, new Set(["-c", "-n", "-p", "-P", "-u", "--class", "--classdata", "--pid", "--pgid", "--uid"]))),
  chrt: (a) => {
    const rest = skipOptions(a, new Set(["-T", "-P", "-D"]));
    return run(rest === null ? null : rest.slice(1)); // the priority
  },
  taskset: (a) => {
    const rest = skipOptions(a, new Set(["-c"]));
    if (rest === null) return null;
    return run(a.some((w) => w.value === "-c" || w.value === "--cpu-list") ? rest : rest.slice(1));
  },
  timeout: (a) => {
    const rest = skipOptions(a, new Set(["-k", "-s", "--kill-after", "--signal"]));
    return run(rest === null ? null : rest.slice(1)); // the duration
  },
  watch: (a) => {
    const rest = skipOptions(a, new Set(["-n", "-d", "--interval", "--differences"]));
    // watch joins its arguments into one shell line.
    return rest === null ? null : { kind: "eval", argv: rest };
  },
  flock: (a) => {
    const rest = skipOptions(a, new Set(["-w", "-E", "--timeout", "--conflict-exit-code"]));
    if (rest === null) return null;
    // flock FILE -c 'line' runs a line; flock FILE cmd… runs cmd.
    const c = rest.findIndex((w) => w.value === "-c" || w.value === "--command");
    if (c >= 0) return rest[c + 1] ? { kind: "eval", argv: [rest[c + 1]!] } : null;
    return run(rest.slice(1));
  },
  xargs: (a) => {
    const rest = skipOptions(a, new Set(["-I", "-i", "-n", "-P", "-d", "-E", "-e", "-L", "-l", "-s", "-a", "--max-args", "--max-procs", "--delimiter", "--eof", "--max-lines", "--max-chars", "--arg-file", "--replace"]));
    if (rest === null) return null;
    // No command: xargs echoes. What it appends comes from input, unknown here.
    return run(rest.length === 0 ? [lit("echo")] : [...rest, DYNAMIC_ARG]);
  },
  eval: (a) => ({ kind: "eval", argv: a }),
  find: (a) => {
    const runs: ShellWord[][] = [];
    for (let i = 0; i < a.length; i++) {
      const v = a[i]!.value;
      if (v === "-exec" || v === "-execdir" || v === "-ok" || v === "-okdir") {
        const argv: ShellWord[] = [];
        for (i++; i < a.length && a[i]!.value !== ";" && a[i]!.value !== "+"; i++) {
          argv.push(a[i]!.value === "{}" ? DYNAMIC_ARG : a[i]!);
        }
        runs.push(argv);
      }
    }
    return runs.length > 0 ? { kind: "exec", runs } : undefined;
  },
};

/** Shells that run a string given with `-c`. */
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "mksh", "ash", "fish", "busybox"]);

/**
 * The script a shell runs, when it's on the command line: its `-c` string,
 * or a here-document or here-string it reads. Undefined when it runs a file
 * or a pipe's output (the shell itself is judged then); null when the script
 * is only known at run time.
 */
function shellScript(cmd: SimpleCommand): string | null | undefined {
  const args = cmd.argv.slice(1);
  // `-c` runs its first operand, whatever options come between: `bash -c -e 'x'`, `sh -c -- 'x'`.
  let inline = false;
  const fish = basename(cmd.argv[0]?.value ?? "") === "fish";
  let i = 0;
  for (; i < args.length; i++) {
    const v = args[i]!.value;
    if (v === null) return null;
    // fish's `-C`/`--init-command` runs a line before anything else.
    if (fish && (v === "-C" || v.startsWith("--init-command"))) return null;
    if (v === "--" || v === "-") {
      i++;
      break;
    }
    if (v === "--command") inline = true; // fish
    else if (v.startsWith("--command=")) return v.slice("--command=".length);
    else if (SHELL_VALUE_OPTIONS.has(v)) i++; // `-o pipefail`: its value is no script
    else if (!v.startsWith("-") && !v.startsWith("+")) break;
    else if (/^[-+][a-zA-Z]+$/.test(v)) {
      if (v.startsWith("-") && v.includes("c")) inline = true;
      if (/[oO]$/.test(v)) i++; // `-eo pipefail`
    }
  }
  if (inline) return args[i] ? args[i]!.value : null;
  if (i < args.length) return undefined; // a script file
  const input = cmd.redirects.filter((r) => (r.fd === null || r.fd === 0) && (r.op.startsWith("<<") || r.op === "<<<"));
  const last = input.at(-1);
  if (!last) return undefined;
  if (last.op === "<<<") return last.target?.value ?? null;
  return last.body ?? null;
}

/** Shell options that take the next word as their value. */
const SHELL_VALUE_OPTIONS = new Set(["-o", "+o", "-O", "+O", "--rcfile", "--init-file"]);

const lit = (value: string): ShellWord => ({ value, raw: value, glob: false });
/** An argument supplied at run time (xargs input, find's `{}`). */
const DYNAMIC_ARG: ShellWord = { value: null, raw: "{}", glob: false, input: true };

function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? p : p.slice(i + 1);
}

/** An unquoted word: a backslash quotes the next character. */
function unescapeUnquoted(s: string): string {
  return s.replace(/\\(\n|.)/g, (_m, c: string) => (c === "\n" ? "" : c));
}

/** Inside double quotes a backslash quotes only $ ` " \ and a newline. */
function unescapeDouble(s: string): string {
  return s.replace(/\\([$`"\\\n])/g, (_m, c: string) => (c === "\n" ? "" : c));
}

/** $'…' escapes; one it doesn't know makes the word unknown. */
function decodeAnsiC(s: string): string | null {
  const map: Record<string, string> = { n: "\n", t: "\t", r: "\r", "\\": "\\", "'": "'", '"': '"', a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", v: "\v", "?": "?" };
  let out = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== "\\") {
      out += s[i];
      continue;
    }
    const c = s[++i];
    if (c === undefined) return null;
    if (c in map) out += map[c];
    else if (c === "x") {
      const hex = /^[0-9a-fA-F]{1,2}/.exec(s.slice(i + 1))?.[0];
      if (!hex) return null;
      out += String.fromCharCode(Number.parseInt(hex, 16));
      i += hex.length;
    } else if (/[0-7]/.test(c)) {
      const oct = /^[0-7]{1,3}/.exec(s.slice(i))![0];
      out += String.fromCharCode(Number.parseInt(oct, 8));
      i += oct.length - 1;
    } else return null;
  }
  return out;
}
