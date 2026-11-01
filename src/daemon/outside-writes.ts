/**
 * Writes outside a session's working directory (autonomous mode asks first).
 *
 * Autonomous mode runs a session's writes without asking. A write, edit,
 * delete or move whose target provably resolves outside the session's
 * working directory is asked about instead, on every backend, at codeoid's
 * own gate (Session's `canUseTool`): a session set loose on one repository
 * doesn't change another, or the user's home, unseen. Reads, searches and
 * listings outside it are unchanged (credential paths are refused in every
 * mode, secret-paths.ts). Other modes are unchanged: guarded and interactive
 * already ask about every write.
 *
 * "Inside" is the session's workdir (a worktree session's workdir is its
 * worktree; codeoid gives a session no other directories) and the system
 * temp dir (`os.tmpdir()`, and `/tmp`), where scratch files are routine —
 * less codeoid's own entries there (`codeoid-*`: sign-in homes, the pi
 * bridge, loop indexes), which are outside.
 *
 * Each backend names its file tools its own way ({@link writeTargets}):
 * Claude's Write/Edit/MultiEdit/NotebookEdit, opencode's Write/Edit (a
 * patch's every file, moves included, in `files`), Codex's
 * `codex_file_change` (`changes[].path`, and a move's destination), pi's
 * `write`/`edit`, Qwen Code's `write_file`/`edit`/`notebook_edit`, the Gemini
 * CLI's `acp_edit`/`acp_delete`/`acp_move` (the `locations` its permission
 * request names). Every path key a call carries is judged. A path is
 * resolved where the kernel would really write it (`physicalPath`, the
 * resolver opencode's `realTarget` uses): against the workdir, `~`
 * expanded, one component at a time, a symlink's target spliced in (a
 * dangling one leads to its target), `..` the parent of what the path so far
 * really is; and also with `..` collapsed first, as a tool that normalizes
 * its path reads it. Either reading outside is outside. A write whose target
 * can't be resolved for certain counts as outside: none given, `..` past a
 * missing directory, anything under `/proc`, another user's `~name`, a loop
 * or too many links, and an existing file with more than one hard link
 * (another name of it may be anywhere on the filesystem).
 *
 * Shell commands: the targets #431's parser can name (redirects, `rm`, `mv`,
 * `cp`, `tee`, `touch`, `dd of=`, `sed -i`, `find -delete`, …, and `ln`'s
 * link and what it leads to: `shellWriteTargets`) are judged the same way,
 * `..` kept for the kernel's reading; a removal or rename by its name (a
 * link that goes, not what it leads to). The reader fails closed: a word
 * that expands, a writing program's option it isn't sure of, a relative
 * target after a `cd` it can't be sure moved the shell, and every other
 * target of a line that makes or moves a link, can't be placed for certain
 * and asks. Relative targets are judged from the shell's real cwd, as the
 * backend reports it (`shellCwd`). A program the reader doesn't model as a
 * writer isn't judged: shell levels are guidance, not a sandbox (#448).
 */

import { lstatSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { physicalPath } from "./physical-path.js";
import { shellWriteTargets } from "./risk/effects.js";
import { shellCallOf } from "./shell/tool-call.js";

/** What a file-writing tool call targets: each a raw path, or null where the call names none. */
type Targets = Array<string | null>;

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0) : []);

/** A Codex `changes` entry's path and, for a move, its destination (`kind.move_path` upstream, `move_path` / `movePath` flat). */
function codexChangeTargets(changes: unknown): Targets {
  if (!Array.isArray(changes) || changes.length === 0) return [null];
  const out: Targets = [];
  for (const c of changes) {
    if (!c || typeof c !== "object") {
      out.push(null);
      continue;
    }
    const ch = c as Record<string, unknown>;
    out.push(str(ch.path));
    const kind = ch.kind && typeof ch.kind === "object" ? (ch.kind as Record<string, unknown>) : {};
    for (const move of [kind.move_path, kind.movePath, ch.move_path, ch.movePath]) if (str(move)) out.push(str(move));
  }
  return out;
}

/** `{path}` objects or strings: an ACP call's `locations`. */
const locationPaths = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((l) => (l && typeof l === "object" ? (l as { path?: unknown }).path : l)).filter((p): p is string => typeof p === "string" && p.length > 0) : [];

/** Every path among `values`; `[null]` (names none) when there's none. */
function present(...values: Array<string | null | string[]>): Targets {
  const found = values.flat().filter((p): p is string => p !== null);
  return found.length > 0 ? found : [null];
}

/**
 * Path keys an ACP (Gemini CLI) call may carry. The real CLI sends no
 * `rawInput`; the provider adds the request's `locations` (acp/index.ts
 * `acpToolInput`).
 */
function acpTargets(input: Record<string, unknown>): Targets {
  return present(str(input.file_path), str(input.path), str(input.absolute_path), str(input.destination), str(input.source), strs(input.paths), locationPaths(input.locations));
}

/**
 * The paths a file-writing tool call writes, edits, creates, removes or
 * moves, as the call names them; null when `toolName` isn't one.
 */
export function writeTargets(toolName: string, input: Record<string, unknown>): Targets | null {
  switch (toolName) {
    // Claude (absolute paths), opencode (absolute and resolved; a patch's every file in `files`), scripted.
    case "Write":
    case "MultiEdit":
      return [str(input.file_path)];
    case "Edit":
      return [str(input.file_path), ...strs(input.files)];
    case "NotebookEdit":
      return present(str(input.notebook_path), str(input.file_path));
    // Qwen Code (absolute paths); `edit` is pi's too, which writes `path`.
    // Every key is judged: a call carrying both is judged by both.
    case "write_file":
      return present(str(input.file_path), str(input.path));
    case "edit":
      return present(str(input.file_path), piPath(input.path));
    case "notebook_edit":
      return present(str(input.notebook_path), str(input.file_path));
    // pi: relative to its cwd (the workdir), a leading `@` dropped as pi drops it.
    case "write":
      return present(piPath(input.path), str(input.file_path));
    case "codex_file_change":
      return codexChangeTargets(input.changes);
    case "acp_edit":
    case "acp_delete":
    case "acp_move":
      return acpTargets(input);
    default:
      return null;
  }
}

function piPath(v: unknown): string | null {
  const p = str(v);
  return p?.startsWith("@") ? p.slice(1) || null : p;
}

const FOLD = process.platform === "darwin" || process.platform === "win32";
const norm = (p: string) => (FOLD ? p.toLowerCase() : p);

/** `child` is `parent` or under it (a name like `..foo` is under it). */
function within(child: string, parent: string): boolean {
  const rel = relative(norm(parent), norm(child));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

const underProc = (p: string) => p === "/proc" || p.startsWith("/proc/");

/**
 * `p` (absolute) where the kernel resolves it; null when that can't be told
 * for certain. `name`: the call removes or renames the name itself (`rm`,
 * `mv`'s source), so its last component is kept as it is — a link there is
 * what goes, not what it leads to, and another hard link of it is untouched.
 */
function landing(p: string, name = false): string | null {
  try {
    const slash = p.lastIndexOf("/");
    const last = p.slice(slash + 1);
    if (name && slash >= 0 && last !== "" && last !== "." && last !== "..") {
      const dir = physicalPath(p.slice(0, slash) || "/");
      const at = dir === "/" ? `/${last}` : `${dir}/${last}`;
      return underProc(dir) ? null : at;
    }
    const at = physicalPath(p);
    if (underProc(at)) return null;
    // A file with another name may be anywhere: writing it here writes it there.
    const st = lstatSync(at, { throwIfNoEntry: false });
    if (st && !st.isDirectory() && st.nlink > 1) return null;
    return at;
  } catch {
    return null;
  }
}

/**
 * Where a write to `raw` may land: the path (against the workdir, `~`
 * expanded) resolved as the kernel resolves it, component by component
 * through every link, and, when it has a `..`, also with that collapsed
 * first, as a tool normalizing its path reads it. Null when either can't be
 * told for certain: another user's `~name`, `/proc`, `..` past a missing
 * directory, a loop, a file with several hard links.
 */
export function writeLandings(raw: string, workdir: string, name = false): string[] | null {
  const home = raw === "~" || raw.startsWith("~/") ? `${homedir()}${raw.slice(1)}` : raw;
  if (home.startsWith("~")) return null;
  const abs = isAbsolute(home) ? home : `${resolve(workdir)}/${home}`;
  if (underProc(resolve(abs)) || underProc(abs)) return null;
  const out: string[] = [];
  for (const p of abs.split("/").includes("..") ? [abs, resolve(abs)] : [abs]) {
    const at = landing(p, name);
    if (at === null) return null;
    if (!out.includes(at)) out.push(at);
  }
  return out;
}

/** Where a write to `raw` lands, for a path with one reading; the first reading otherwise (see {@link writeLandings}). */
export function resolveWritePath(raw: string, workdir: string): string | null {
  return writeLandings(raw, workdir)?.[0] ?? null;
}

/** Whether a resolved path is inside: the workdir, or the temp dir less codeoid's own entries there. */
function insideOf(workdir: string): (p: string) => boolean {
  const real = (d: string) => landing(resolve(d)) ?? resolve(d);
  const work = real(workdir);
  const temps = [...new Set([tmpdir(), "/tmp"].map(real))];
  return (p) => {
    if (within(p, work)) return true;
    return temps.some((t) => within(p, t) && !codeoidOwn(relative(norm(t), norm(p))));
  };
}

/** A temp-dir entry codeoid itself made (`codeoid-login-*`, `codeoid-pi-bridge-*`, …), or a path under one. */
const codeoidOwn = (rel: string) => rel.split(sep)[0]!.startsWith("codeoid");

/** Why a call asks: the first of its targets outside the working directory, as resolved; null when none is. */
export interface OutsideWrite {
  /** The resolved path, or the path as written when it can't be resolved. */
  path: string;
  /** False: the target couldn't be resolved for certain (or the call names none). */
  resolved: boolean;
  /** Why it couldn't be, when the shell reader says (an expansion, an option it isn't sure of, an unknown cwd). */
  why?: string;
}

/**
 * The first write of `toolName` whose target provably resolves outside the
 * working directory, or can't be resolved for certain; null when every
 * target is inside it, or the call writes no file (a read, a search, a
 * command whose targets the parser can't name).
 *
 * A shell call's relative targets are judged from where it runs: the
 * directory its input names (`cwd`, `workdir`, …), else `shellCwd`, the
 * directory the backend reports its shell is in for this call (Claude's
 * Bash keeps a `cd` between calls: its hook input's `cwd`), else the
 * workdir (a backend whose shell starts there each call). `shellCwd` null:
 * the backend's shell may have moved and it didn't say where, so a relative
 * target is unplaced. A cwd outside the workdir makes every relative target
 * outside.
 */
export function outsideWriteOf(toolName: string, input: Record<string, unknown>, workdir: string, shellCwd?: string | null): OutsideWrite | null {
  const isInside = insideOf(workdir);
  const judge = (raw: string, name = false): OutsideWrite | null => {
    const at = writeLandings(raw, workdir, name);
    if (at === null) return { path: raw, resolved: false };
    const out = at.find((p) => !isInside(p));
    return out === undefined ? null : { path: out, resolved: true };
  };
  const targets = writeTargets(toolName, input);
  if (targets) {
    for (const raw of targets) {
      if (raw === null) return { path: "(the call names no path)", resolved: false };
      const w = judge(raw);
      if (w) return w;
    }
    return null;
  }
  const call = shellCallOf(toolName, input);
  if (!call) return null;
  const reported = shellCwd === undefined ? resolve(workdir) : shellCwd !== null && isAbsolute(shellCwd) ? shellCwd : null;
  const cwd = call.cwd ? (isAbsolute(call.cwd) ? call.cwd : reported === null ? null : `${reported}/${call.cwd}`) : reported;
  for (const target of shellWriteTargets(call.command, { workdir: resolve(workdir), cwd })) {
    if (target.unplaced) return { path: target.path, resolved: false, why: target.unplaced };
    const w = judge(target.path, target.name);
    if (w) return w;
  }
  return null;
}

/** The approval card's reason for an outside write. */
export function outsideWriteReason(w: OutsideWrite): string {
  if (w.resolved) return `writes outside the working directory: ${w.path}`;
  return `writes outside the working directory: ${w.path} (where it leads can't be resolved for certain${w.why ? `: ${w.why}` : ""})`;
}
