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
  /** A shell (or `source`) running the script its input carries: a pipe's output or a process substitution. */
  stdinScript?: true;
  /** For a command find -exec runs: the index of that find, whose search roots its `{}` is under. */
  inputFrom?: number;
  /** Words its wrappers took for themselves (`xargs -a FILE`, `time -o FILE`): not part of argv, but still files. */
  wrapped?: ShellWord[];
}

/** A variable the line sets. */
export interface ShellAssignment {
  name: string;
  value: ShellWord;
  /** In a program's environment: a prefix (`X=1 cmd`), `env X=1 cmd`, or `export X=1`. */
  exported: boolean;
}

export interface ParsedShell {
  commands: SimpleCommand[];
  /** Every variable the line sets, wherever. */
  assignments: ShellAssignment[];
  /** Why the line isn't fully understood; empty when it is. */
  problems: string[];
  /**
   * Shell constructs beyond plain commands, pipelines, `&&` / `||` / `;`
   * lists, subshells, `{ … }` and `if`: loops, `case`, functions, `declare`,
   * `[[ … ]]`, `(( … ))`. Understood, but never low.
   */
  constructs: string[];
  /**
   * Where bash evaluates a variable's value as an expression or a name:
   * arithmetic (`$((x))`, `[[ $x -eq 1 ]]`, `${a[$i]}`, `let`), `${!x}`. A
   * value holding `a[$(cmd)]` runs cmd there.
   */
  arithmetic: string[];
  /** Nothing of it could be read: the parser isn't loaded or failed, or the line is too long. */
  unreadable?: true;
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
    return { commands: [], assignments: [], problems: [`the shell parser failed to load: ${err instanceof Error ? err.message : String(err)}`], constructs: [], arithmetic: [], unreadable: true };
  }
  return parseShellSync(source);
}

/** Parse with the parser already loaded; before it is, nothing is understood. */
export function parseShellSync(source: string): ParsedShell {
  const out: ParsedShell = { commands: [], assignments: [], problems: [], constructs: [], arithmetic: [] };
  if (source.length > MAX_LENGTH) {
    out.problems.push(`the command is over ${MAX_LENGTH} characters`);
    out.unreadable = true;
    return out;
  }
  if (!loaded) {
    out.problems.push("the shell parser isn't loaded");
    out.unreadable = true;
    return out;
  }
  try {
    new Walker(loaded, out).line(source, [], 0);
  } catch (err) {
    out.problems.push(`the command couldn't be parsed: ${err instanceof Error ? err.message : String(err)}`);
    out.unreadable = true;
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
    if (!PLAIN_NODES.has(n.type) || (n.type === "compound_statement" && n.text.startsWith("(("))) this.out.constructs.push(constructName(n));
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
        // A substitution in these redirects (`bash < <(curl …)`) feeds the
        // command that is the body, which isn't listed yet: patched below.
        const owner = -2 - this.#nextPipeline++;
        for (const r of n.childrenForFieldName("redirect")) {
          if (!r) continue;
          redirects.push(...this.redirect(r, ctx, owner));
          if (r.type === "heredoc_redirect" || r.type === "herestring_redirect") heredoc = true;
        }
        const body = n.childForFieldName("body");
        const index = this.out.commands.length;
        if (body) this.node(body, { ...ctx, redirects, heredoc });
        for (const c of this.out.commands) if (c.feeds === owner) c.feeds = body?.type === "command" ? index : null;
        return;
      }
      case "variable_assignment":
        this.#assignment(n, ctx, null, false);
        return;
      case "variable_assignments":
        for (const c of n.namedChildren) if (c) this.node(c, ctx);
        return;
      case "declaration_command": {
        // `export X=1`, `declare -x X=1`: into the environment of what runs next.
        const exported = n.child(0)?.text === "export" || n.namedChildren.some((c) => c?.type === "word" && /^-[a-zA-Z]*x/.test(c.text));
        for (const c of n.namedChildren) {
          if (c?.type === "variable_assignment") this.#assignment(c, ctx, null, exported);
          // `declare 'a[$(cmd)]=1'`: a quoted name's subscript runs as arithmetic.
          else if (c) this.#subscriptName(this.word(c, ctx, null), n.child(0)?.text ?? "declare");
        }
        return;
      }
      case "unset_command":
      case "test_command":
        // `[[ $x -eq 0 ]]` compares as arithmetic.
        if (n.text.startsWith("[[") && n.descendantsOfType("test_operator").some((o) => o && /^-(eq|ne|lt|le|gt|ge)$/.test(o.text))) this.#arithmetic(n);
        // `[[ -v 'a[$(cmd)]' ]]`, `unset 'a[$(cmd)]'`: the subscript of a name runs.
        if ((n.type === "unset_command" || /(^|\s)-[vR]\s/.test(n.text)) && /\[/.test(n.text)) {
          const literal =
            n.descendantsOfType(["raw_string", "word", "string_content"]).some((c) => c !== null && SUBSCRIPT_CODE.test(c.text)) ||
            n.descendantsOfType("ansi_c_string").some((c) => c !== null && SUBSCRIPT_CODE.test(decodeAnsiC(c.text.slice(2, -1)) ?? "$"));
          if (literal) this.out.problems.push(`a variable name's subscript runs as code (${n.text})`);
          else if (/\[[^\]]*\$/.test(n.text)) this.out.arithmetic.push(n.text);
        }
        // No program runs, but a substitution inside does.
        this.substitutionsIn(n, ctx, null);
        return;
      case "compound_statement":
      case "c_style_for_statement":
        // `((x++))`, `for ((i=0; i<n; i++))`.
        if (n.type === "c_style_for_statement" || n.text.startsWith("((")) {
          for (const c of n.namedChildren) if (c && c.type !== "do_group" && c.type !== "compound_statement") this.#arithmetic(c);
        }
        for (const c of n.namedChildren) if (c) this.node(c, ctx);
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
        this.#assignment(c, ctx, index, true);
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
    // `let` evaluates its arguments as arithmetic.
    if (words[0]?.value === "let" && words.slice(1).some((w) => /[A-Za-z_]/.test(w.raw))) this.out.arithmetic.push(n.text);
    this.unwrap(cmd, ctx);
    this.#namesSet(cmd);
  }

  /**
   * Builtins that set or read a variable named in an argument: `printf -v X`,
   * `read X`, `mapfile X`, `test -v X`. The variable is recorded as set, and
   * a name's subscript is arithmetic (`printf -v 'a[$(cmd)]' x` runs cmd).
   */
  #namesSet(cmd: SimpleCommand): void {
    const prog = basename(cmd.argv[0]?.value ?? "");
    const args = cmd.argv.slice(1);
    const set = (name: ShellWord | undefined, value: ShellWord = DYNAMIC_VALUE) => {
      if (!name) return;
      this.#subscriptName(name, prog);
      if (name.value !== null && /^[A-Za-z_]\w*(\[|$)/.test(name.value)) this.out.assignments.push({ name: name.value.replace(/\[[\s\S]*$/, ""), value, exported: false });
    };
    if (prog === "printf") {
      const v = args.findIndex((w) => w.value?.startsWith("-v"));
      if (v < 0) return;
      const attached = args[v]!.value!.length > 2;
      const name = attached ? { ...args[v]!, value: args[v]!.value!.slice(2) } : args[v + 1];
      // What it sets is the format applied to the rest: their text is what could hold code.
      const rest = args.slice(v + (attached ? 1 : 2));
      set(name, { value: null, raw: rest.map((w) => w.raw).join(" "), glob: false });
    } else if (prog === "test" || prog === "[") {
      args.forEach((w, i) => (w.value === "-v" || w.value === "-R") && args[i + 1] && this.#subscriptName(args[i + 1]!, prog));
    } else if (prog === "read" || prog === "mapfile" || prog === "readarray" || prog === "wait") {
      // `mapfile -C cmd` runs cmd as each line is read.
      if (prog !== "read" && prog !== "wait" && args.some((w) => w.value !== null && /^-[a-zA-Z]*C/.test(w.value))) this.out.problems.push(`${prog} -C runs a callback`);
      const withValue = prog === "read" ? /^-[a-zA-Z]*[dinNptu]$/ : /^-[a-zA-Z]*[dnOsucC]$/;
      for (let i = 0; i < args.length; i++) {
        const x = args[i]!.value;
        if (x?.startsWith("-") && x !== "-") {
          // `read -a NAME`, `wait -p NAME`: an option whose value is a name.
          if ((prog === "read" && /^-[a-zA-Z]*a$/.test(x)) || (prog === "wait" && x === "-p")) set(args[++i]);
          else if (withValue.test(x)) i++;
          continue;
        }
        if (prog !== "wait") set(args[i]);
      }
    }
  }

  /** A variable name given as an argument: a subscript in it is arithmetic, and code when it holds `$(…)` or `…` as text. */
  #subscriptName(w: ShellWord, what: string): void {
    const name = (w.value ?? w.raw).replace(/=[\s\S]*$/, "");
    if (!name.includes("[")) return;
    if (w.value !== null && SUBSCRIPT_CODE.test(name)) this.out.problems.push(`a variable name's subscript runs as code in ${what} (${w.raw})`);
    else if (/\[[^\]]*\$/.test(name)) this.out.arithmetic.push(w.raw);
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
        if (n.type === "arithmetic_expansion") this.#arithmetic(n);
        if (n.type === "expansion") this.#expansion(n);
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

  /** A `NAME=value`, recorded, and the commands inside its substitutions. */
  #assignment(n: Node, ctx: Ctx, owner: number | null, exported: boolean): void {
    const name = n.namedChildren[0];
    const value = n.namedChildren.length > 1 ? n.namedChildren.at(-1) : null;
    if (name) this.substitutionsIn(name, ctx, owner); // `a[$(x)]=1`
    if (name?.type === "subscript") this.#arithmetic(name, 1);
    this.out.assignments.push({
      name: (name?.text ?? "").replace(/\[[\s\S]*$/, ""),
      value: value ? this.word(value, ctx, owner) : lit(""),
      exported,
    });
  }

  /**
   * Arithmetic that reads a variable: bash evaluates a variable's value as
   * an expression there, so `x='a[$(cmd)]'; echo $((x))` runs cmd — the
   * value, from wherever it came, is code. Not understood.
   */
  #arithmetic(n: Node, from = 0): void {
    const reads = (x: Node): boolean =>
      x.type === "variable_name" ||
      x.type === "simple_expansion" ||
      x.type === "expansion" ||
      (x.type === "word" && /^[A-Za-z_]/.test(x.text)) ||
      // A `$(…)`'s commands are judged as commands.
      (x.type !== "command_substitution" && x.namedChildren.some((c) => c !== null && reads(c)));
    if (n.namedChildren.slice(from).some((c) => c !== null && reads(c))) this.out.arithmetic.push(n.text);
  }

  /** `${…}`: a prompt expansion (`@P`) runs the value's `$(…)`; an index is arithmetic; one the grammar cut short isn't read. */
  #expansion(n: Node): void {
    if (!n.text.endsWith("}")) this.out.problems.push(`an expansion the parser doesn't know (${n.text})`);
    else if (/@P\}$/.test(n.text)) this.out.problems.push(`a prompt expansion runs what the value holds (${n.text})`);
    // `${!x}` looks up the variable x names, whose subscript is arithmetic.
    else if (/^\$\{!\w+\}$/.test(n.text)) this.out.arithmetic.push(n.text);
    // `${x:off:len}`: the offset and length are arithmetic.
    else if (/[A-Za-z_]/.test(/^\$\{[!#]?\w+(?:\[[^\]]*\])?:(?![-=?+])([\s\S]*)\}$/.exec(n.text)?.[1] ?? "")) this.out.arithmetic.push(n.text);
    for (const s of n.namedChildren) if (s?.type === "subscript") this.#arithmetic(s, 1);
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
      if (name.glob) {
        // `/bin/r? -rf x`, `r{m,} x`: the program is whatever the pattern expands to.
        this.out.problems.push(`the program to run is a pattern (${name.raw})`);
        return;
      }
      const prog = basename(name.value);
      if (RESERVED.has(name.value)) {
        // `time { …; }`, `coproc X while …`: the grammar doesn't know these
        // keywords there and reads a compound command as plain words. What
        // follows the keyword is judged, but the line isn't understood.
        this.out.problems.push(`a compound command the parser can't read (${name.raw})`);
        cmd.argv = cmd.argv.slice(1);
        continue;
      }
      const inner = WRAPPERS[prog]?.(cmd.argv.slice(1));
      if (inner === undefined) {
        if (!SHELLS.has(prog) && prog !== "source" && prog !== ".") return;
        const script = SHELLS.has(prog) ? shellScript(cmd) : sourcedScript(cmd);
        if (script === undefined) return; // a script file: judged as the shell itself
        if (script === STDIN) {
          cmd.stdinScript = true; // judged from what feeds it
          return;
        }
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
        const inputFrom = inner.rooted ? this.out.commands.indexOf(cmd) : undefined;
        for (const run of inner.runs) {
          if (run.length === 0) continue;
          const sub: SimpleCommand = { ...cmd, argv: run, via: [...cmd.via, prog], redirects: [], heredoc: false, delegates: false, inputFrom };
          this.out.commands.push(sub);
          this.unwrap(sub, ctx);
        }
        return;
      }
      // `env X=1 cmd`, `sudo X=1 cmd`: X is in cmd's environment.
      const own = cmd.argv.slice(1, cmd.argv.length - inner.argv.length);
      for (const w of own) {
        const m = w.value === null ? null : /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/.exec(w.value);
        if (m && (prog === "env" || prog === "sudo")) this.out.assignments.push({ name: m[1]!, value: { ...w, value: m[2]! }, exported: true });
      }
      // What the wrapper kept for itself (xargs adds its input to what it runs).
      const kept = cmd.argv.slice(1).filter((w) => !inner.argv.includes(w));
      if (kept.length > 0) cmd.wrapped = [...(cmd.wrapped ?? []), ...kept];
      // A wrapper with nothing to run (`env`, `sudo` alone) is judged as itself.
      if (inner.argv.length === 0) return;
      cmd.via = [...cmd.via, prog];
      cmd.argv = inner.argv;
    }
    this.out.problems.push("wrappers nested too deep");
  }
}

/** `exec`: commands run on each match; `rooted` when the matches are under the wrapper's search roots, as find's are. */
type Unwrapped = { kind: "run"; argv: ShellWord[] } | { kind: "eval"; argv: ShellWord[] } | { kind: "exec"; runs: ShellWord[][]; rooted: boolean };

/** Options taking a value, per wrapper: `sudo -u root` is not a command named `root`. */
function skipOptions(args: ShellWord[], withValue: ReadonlySet<string>, opts: { stopAtNonOption?: boolean; assignments?: boolean; dash?: boolean } = {}): ShellWord[] | null {
  let i = 0;
  while (i < args.length) {
    const v = args[i]!.value;
    if (v === null) return null;
    if (v === "--") return args.slice(i + 1);
    if ((opts.assignments && /^[A-Za-z_][A-Za-z0-9_]*=/.test(v)) || (opts.dash && v === "-")) {
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
    // `env -S "…"` (or `-iS…`) splits a string into a command line; `-C` runs it elsewhere.
    if (a.some((w) => w.value !== null && (/^-[a-zA-Z]*[SC]/.test(w.value) || w.value.startsWith("--split-string") || w.value.startsWith("--chdir")))) return null;
    // `env -` is `env -i`.
    return run(skipOptions(a, new Set(["-u", "--unset"]), { assignments: true, dash: true }));
  },
  nice: (a) => run(skipOptions(a, new Set(["-n", "--adjustment"]))),
  nohup: (a) => run(skipOptions(a, new Set())),
  setsid: (a) => run(skipOptions(a, new Set())),
  time: (a) => run(skipOptions(a, new Set(["-f", "-o", "--format", "--output"]))),
  command: (a) => {
    // `command -v x` looks x up; it runs nothing. Only its own options count: `command rm -v x` runs rm.
    for (const w of a) {
      if (w.value === null || w.value === "--" || !w.value.startsWith("-")) break;
      if (/[vV]/.test(w.value)) return undefined;
    }
    return run(skipOptions(a, new Set()));
  },
  // `busybox rm …`: the applet is the program.
  busybox: (a) => (a[0]?.value?.startsWith("-") ? undefined : run(a)),
  toybox: (a) => (a[0]?.value?.startsWith("-") ? undefined : run(a)),
  // `coproc NAME { …; }`: a name, then a compound command (a reserved word, read in unwrap).
  coproc: (a) => run(a[1]?.value && RESERVED.has(a[1].value) ? a.slice(1) : a),
  // `trap 'line' SIGNAL…` runs the line when the signal comes; `trap - X` / `trap '' X` reset or ignore.
  trap: (a) => {
    const rest = skipOptions(a, new Set());
    if (rest === null) return null;
    const action = rest[0];
    if (!action || rest.length === 1 || action.value === "-" || action.value === "") return undefined;
    return { kind: "eval", argv: [action] };
  },
  // `script -c 'line'` runs the line; without -c it starts an interactive shell.
  script: (a) => {
    for (let i = 0; i < a.length; i++) {
      const v = a[i]!.value;
      if (v === null) return null;
      if (v.startsWith("--command=")) return { kind: "eval", argv: [{ ...a[i]!, value: v.slice("--command=".length) }] };
      if (v === "--command" || /^-[a-zA-Z]*c$/.test(v)) return a[i + 1] ? { kind: "eval", argv: [a[i + 1]!] } : null;
      if (/^-[a-zA-Z]*c./.test(v)) return { kind: "eval", argv: [{ ...a[i]!, value: v.slice(v.indexOf("c") + 1) }] };
    }
    return undefined;
  },
  // Wrappers whose options are too many to read with certainty: what they run isn't known.
  strace: (a) => (a.length > 0 ? null : undefined),
  ltrace: (a) => (a.length > 0 ? null : undefined),
  parallel: (a) => (a.length > 0 ? null : undefined),
  unshare: (a) => (a.length > 0 ? null : undefined),
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
    // `-i`, `-l` and `-e` take their value attached only (`-i{}`, `-l1`).
    const rest = skipOptions(a, new Set(["-I", "-n", "-P", "-d", "-E", "-L", "-s", "-a", "--max-args", "--max-procs", "--delimiter", "--eof", "--max-lines", "--max-chars", "--arg-file"]));
    if (rest === null) return null;
    // No command: xargs echoes. What it appends comes from input, unknown here.
    if (rest.length === 0) return run([lit("echo")]);
    // `-I R` / `-i` / `--replace`: R in an argument is replaced by an input line.
    const replace = xargsReplace(a.slice(0, a.length - rest.length));
    if (replace === null) return run([...rest, DYNAMIC_ARG]);
    return run(rest.map((w) => (w.value?.includes(replace) ? { ...DYNAMIC_ARG, raw: w.raw } : w)));
  },
  eval: (a) => ({ kind: "eval", argv: a }),
  // `alias ll='…'`: the line runs wherever the name is used (aliases expand where expand_aliases is on).
  alias: (a) => {
    const lines = a.flatMap((w) => (w.value === null ? [null] : /^[^=]+=([\s\S]*)$/.exec(w.value)?.slice(1) ?? []));
    if (lines.length === 0) return undefined;
    if (lines.some((l) => l === null)) return null;
    return { kind: "eval", argv: [lit(lines.join("\n"))] };
  },
  // fd -x / -X: everything after it (to a `;`) is the command, run on each match.
  fd: (a) => {
    for (let i = 0; i < a.length; i++) {
      const v = a[i]!.value;
      if (v === null || v === "--") return v === null ? null : undefined;
      if (!(v === "--exec" || v === "--exec-batch" || /^-[a-zA-Z]*[xX]$/.test(v))) continue;
      const argv: ShellWord[] = [];
      for (i++; i < a.length && a[i]!.value !== ";"; i++) argv.push(a[i]!.value?.includes("{") ? { ...DYNAMIC_ARG, raw: a[i]!.raw } : a[i]!);
      if (!argv.slice(1).some((w) => w.input)) argv.push(DYNAMIC_ARG);
      return { kind: "exec", runs: [argv], rooted: false };
    }
    return undefined;
  },
  find: (a) => {
    const runs: ShellWord[][] = [];
    for (let i = 0; i < a.length; i++) {
      const v = a[i]!.value;
      if (v === "-exec" || v === "-execdir" || v === "-ok" || v === "-okdir") {
        const argv: ShellWord[] = [];
        // GNU find replaces `{}` anywhere in an argument: `{}/`, `sh -c 'rm {}'`.
        for (i++; i < a.length && a[i]!.value !== ";" && a[i]!.value !== "+"; i++) {
          argv.push(a[i]!.value?.includes("{}") ? { ...DYNAMIC_ARG, raw: a[i]!.raw } : a[i]!);
        }
        runs.push(argv);
      }
    }
    return runs.length > 0 ? { kind: "exec", runs, rooted: true } : undefined;
  },
};

/** The replace string of xargs's options, or null when it appends its input. */
function xargsReplace(options: ShellWord[]): string | null {
  let replace: string | null = null;
  for (let i = 0; i < options.length; i++) {
    const v = options[i]!.value ?? "";
    if (v === "-I") replace = options[++i]?.value ?? "{}";
    else if (v.startsWith("--replace")) replace = v.startsWith("--replace=") ? v.slice("--replace=".length) : "{}";
    else if (/^-[a-zA-Z0-9]*[Ii]/.test(v) && !v.startsWith("--")) {
      const k = v.search(/[Ii]/);
      replace = v.slice(k + 1) || (v[k] === "I" ? (options[++i]?.value ?? "{}") : "{}");
    }
  }
  return replace;
}

/** Shells that run a string given with `-c`. */
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "mksh", "ash", "fish"]);

/**
 * The script a shell runs, when it's on the command line: its `-c` string,
 * or a here-document or here-string it reads. Undefined when it runs a file
 * (the shell itself is judged then); STDIN when it runs a pipe's output or a
 * process substitution; null when the script is only known at run time.
 */
function shellScript(cmd: SimpleCommand): string | null | undefined | typeof STDIN {
  const args = cmd.argv.slice(1);
  // `-c` runs its first operand, whatever options come between: `bash -c -e 'x'`, `sh -c -- 'x'`.
  let inline = false;
  // `-s` reads the script from the input; its operands are arguments.
  let fromInput = false;
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
      if (v.startsWith("-") && v.includes("s")) fromInput = true;
      if (/[oO]$/.test(v)) i++; // `-eo pipefail`
    }
  }
  if (inline) return args[i] ? args[i]!.value : null;
  // `bash /dev/stdin`: the script file is its input.
  if (i < args.length && !fromInput && !STDIN_FILES.has(args[i]!.value ?? "")) return undefined; // a script file
  return inputOf(cmd);
}

/** What `source` / `.` runs: a file (undefined), or its input when the file is `/dev/stdin` or a `<(…)`. */
function sourcedScript(cmd: SimpleCommand): string | null | undefined | typeof STDIN {
  const args = cmd.argv.slice(1);
  const file = args[0]?.value === "--" ? args[1] : args[0];
  if (!file) return undefined;
  if (file.value === null) return file.raw.startsWith("<(") ? STDIN : null;
  if (STDIN_FILES.has(file.value)) return inputOf(cmd);
  return undefined;
}

/** Names of a process's own input. */
const STDIN_FILES = new Set(["/dev/stdin", "/dev/fd/0", "/proc/self/fd/0"]);

/** A script read from the input: a here-document's or here-string's text, a pipe's or a `< <(…)`'s output (STDIN), or a `< file` (undefined). */
function inputOf(cmd: SimpleCommand): string | null | undefined | typeof STDIN {
  // `< /dev/stdin` is no redirect at all.
  const input = cmd.redirects.filter(
    (r) => (r.fd === null || r.fd === 0) && (r.op.startsWith("<<") || r.op === "<<<" || r.op === "<") && !(r.op === "<" && STDIN_FILES.has(r.target?.value ?? "")),
  );
  const last = input.at(-1);
  // A later pipeline stage, or the inside of `>(…)`, reads what's written to it.
  if (!last) return cmd.stage > 0 || cmd.substitution === "process-out" ? STDIN : undefined;
  if (last.op === "<") {
    if (last.target?.value != null) return undefined; // a script file
    return last.target?.raw.startsWith("<(") ? STDIN : null;
  }
  if (last.op === "<<<") return last.target?.value ?? null;
  return last.body ?? null;
}

/** A shell's script is whatever its input carries. */
const STDIN = Symbol("stdin");

/** Shell options that take the next word as their value. */
const SHELL_VALUE_OPTIONS = new Set(["-o", "+o", "-O", "+O", "--rcfile", "--init-file"]);

/** Bash's reserved words: never a program, though the grammar can leave one as a command's first word. */
const RESERVED = new Set(["{", "}", "!", "[[", "]]", "((", "while", "until", "for", "select", "if", "then", "else", "elif", "fi", "do", "done", "case", "esac", "in", "function"]);

/** Statements a plain command line is made of: anything else is a construct (see ParsedShell.constructs). */
const PLAIN_NODES = new Set(["program", "list", "pipeline", "command", "redirected_statement", "variable_assignment", "variable_assignments", "subshell", "compound_statement", "if_statement", "elif_clause", "else_clause", "negated_command", "comment"]);

function constructName(n: Node): string {
  switch (n.type) {
    case "for_statement":
    case "c_style_for_statement":
      return "a for loop";
    case "while_statement":
      return n.text.startsWith("until") ? "an until loop" : "a while loop";
    case "case_statement":
      return "a case statement";
    case "function_definition":
      return "a function definition";
    case "declaration_command":
    case "unset_command":
      return n.child(0)?.text ?? "declare";
    case "test_command":
      return n.text.startsWith("[[") ? "[[ … ]]" : "[ … ]";
    case "variable_assignment":
    case "variable_assignments":
      return "a variable assignment";
    case "compound_statement":
      return "(( … ))";
    default:
      return n.type.replaceAll("_", " ");
  }
}

/** A subscript holding `$` or `` ` `` as text: bash runs a `$(…)` in it when it evaluates the name. */
const SUBSCRIPT_CODE = /\[[^\]]*[$`]/;

const lit = (value: string): ShellWord => ({ value, raw: value, glob: false });
/** A value the line sets only at run time (`read X`). */
const DYNAMIC_VALUE: ShellWord = { value: null, raw: "", glob: false };
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
