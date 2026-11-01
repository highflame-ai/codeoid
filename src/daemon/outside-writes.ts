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
 * temp dir (`os.tmpdir()`, and `/tmp`), where scratch files are routine.
 *
 * Each backend names its file tools its own way ({@link writeTargets}):
 * Claude's Write/Edit/MultiEdit/NotebookEdit, opencode's Write/Edit (a
 * patch's every file, moves included, in `files`), Codex's
 * `codex_file_change` (`changes[].path`, and a move's destination), pi's
 * `write`/`edit`, Qwen Code's `write_file`/`edit`/`notebook_edit`, the Gemini
 * CLI's `acp_edit`/`acp_delete`/`acp_move`. A path is resolved as the
 * secret-path gate resolves it: against the workdir, `~` expanded, `..` as the
 * kernel takes it, then through every symlink of its longest existing prefix
 * (a link in the workdir that leads out is outside). A write whose target
 * can't be resolved for certain (none given, `..` past a missing directory,
 * anything under `/proc`) counts as outside.
 *
 * Shell commands: the targets #431's parser can name (redirects, `rm`, `mv`,
 * `cp`, `tee`, `ln`, `touch`, `dd of=`, `sed -i`, `find -delete`, …,
 * `shellWriteTargets`) are judged the same way. One the parser can't place
 * (a variable, a path after a `cd` it can't follow) isn't: shell levels are
 * guidance, not a sandbox (#448).
 */

import { existsSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { shellWriteTargets } from "./risk/effects.js";
import { kernelPath } from "./secret-paths.js";
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

/** Path keys an ACP (Gemini CLI) call may carry; the real CLI sends none (its `rawInput` is absent). */
function acpTargets(input: Record<string, unknown>): Targets {
  const found = [str(input.file_path), str(input.path), str(input.absolute_path), str(input.destination), str(input.source), ...strs(input.paths), ...strs(input.locations)].filter((p) => p !== null);
  return found.length > 0 ? found : [null];
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
      return [str(input.notebook_path) ?? str(input.file_path)];
    // Qwen Code (absolute paths); `edit` is pi's too, which names it `path`.
    case "write_file":
      return [str(input.file_path) ?? str(input.path)];
    case "edit":
      return [str(input.file_path) ?? piPath(input.path)];
    case "notebook_edit":
      return [str(input.notebook_path)];
    // pi: relative to its cwd (the workdir), a leading `@` dropped as pi drops it.
    case "write":
      return [piPath(input.path)];
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

function within(child: string, parent: string): boolean {
  const rel = relative(norm(parent), norm(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** `p` through every symlink of its longest existing prefix: where a write to it lands. */
function realOfLongestExisting(p: string): string {
  let at = p;
  const rest: string[] = [];
  for (;;) {
    try {
      if (existsSync(at)) return join(realpathSync(at), ...rest.reverse());
    } catch {
      // unreadable: keep walking up
    }
    const parent = dirname(at);
    if (parent === at) return p;
    rest.push(basename(at));
    at = parent;
  }
}

/**
 * Where a tool's path leads, resolved as the secret-path gate resolves it
 * (against the workdir, `~` expanded, `..` as the kernel takes it), then
 * through the links of its longest existing prefix. Null when that can't be
 * told for certain: a path through `/proc` (a process's own links), a `..`
 * the kernel reading can't settle.
 */
export function resolveWritePath(raw: string, workdir: string): string | null {
  const home = raw === "~" || raw.startsWith("~/") ? `${homedir()}${raw.slice(1)}` : raw;
  if (home.startsWith("~")) return null;
  const abs = isAbsolute(home) ? home : `${resolve(workdir)}/${home}`;
  const k = kernelPath(abs, resolve(workdir));
  if (k === null || k === "/proc" || k.startsWith("/proc/")) return null;
  const real = realOfLongestExisting(k);
  return real === "/proc" || real.startsWith("/proc/") ? null : real;
}

/** The directories a session's writes stay inside: its workdir, and the system temp dir. */
export function insideDirs(workdir: string): string[] {
  return [...new Set([workdir, tmpdir(), "/tmp"].map((d) => realOfLongestExisting(resolve(d))))];
}

/** Why a call asks: the first of its targets outside the working directory, as resolved; null when none is. */
export interface OutsideWrite {
  /** The resolved path, or the path as written when it can't be resolved. */
  path: string;
  /** False: the target couldn't be resolved for certain (or the call names none). */
  resolved: boolean;
}

/**
 * The first write of `toolName` whose target provably resolves outside the
 * working directory, or can't be resolved for certain; null when every
 * target is inside it, or the call writes no file (a read, a search, a
 * command whose targets the parser can't name). `cwd`: where a shell call
 * runs, when it names a directory.
 */
export function outsideWriteOf(toolName: string, input: Record<string, unknown>, workdir: string): OutsideWrite | null {
  const inside = insideDirs(workdir);
  const isInside = (p: string) => inside.some((d) => within(p, d));
  const targets = writeTargets(toolName, input);
  if (targets) {
    for (const raw of targets) {
      if (raw === null) return { path: "(the call names no path)", resolved: false };
      const at = resolveWritePath(raw, workdir);
      if (at === null) return { path: raw, resolved: false };
      if (!isInside(at)) return { path: at, resolved: true };
    }
    return null;
  }
  const call = shellCallOf(toolName, input);
  if (!call) return null;
  const cwd = call.cwd ? resolve(workdir, call.cwd) : workdir;
  for (const target of shellWriteTargets(call.command, { workdir, cwd })) {
    const at = resolveWritePath(target, workdir);
    // A target the reader named but that can't be settled (under /proc): not provably outside, as the parser's misses aren't.
    if (at !== null && !isInside(at)) return { path: at, resolved: true };
  }
  return null;
}

/** The approval card's reason for an outside write. */
export function outsideWriteReason(w: OutsideWrite): string {
  return w.resolved
    ? `writes outside the working directory: ${w.path}`
    : `writes outside the working directory: ${w.path} (where it leads can't be resolved for certain)`;
}
