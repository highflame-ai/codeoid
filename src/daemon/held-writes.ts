/**
 * File-tool writes into what a session's OS sandbox holds read-only (#448):
 * the repository's git structure (its git dirs, `.git` files) and the
 * project settings agent CLIs run code from (sandbox/policy.ts
 * `protectedWriteTargets`). A file tool that runs in the backend's own
 * process, outside the sandbox (Claude native's, opencode's), writing them
 * asks in guarded and interactive mode and is refused in autonomous mode
 * (Session's `#heldWrite`); one that runs inside the sandbox (Codex, pi, the
 * Gemini CLI, Qwen) is held by the sandbox itself and isn't judged here.
 * Claude's PreToolUse hook routes it to codeoid's gate past an allow rule
 * (`heldWriteDecision`).
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
 * its path reads it. Either reading in a held place counts. A target that
 * can't be resolved for certain counts too: `..` past a missing directory,
 * anything under `/proc`, another user's `~name`, a loop or too many links,
 * and an existing file with more than one hard link (another name of it may
 * be anywhere on the filesystem).
 *
 * Shell commands aren't judged here: what a sandboxed command writes there
 * is the OS sandbox's to refuse.
 */

import { lstatSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { physicalPath } from "./physical-path.js";

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

/** `p` (absolute) where the kernel resolves it; null when that can't be told for certain (`hardLinks`: a file with several counts). */
function landing(p: string, hardLinks = true): string | null {
  try {
    const at = physicalPath(p);
    if (underProc(at)) return null;
    // A file with another name may be anywhere: writing it here writes it there.
    const st = hardLinks ? lstatSync(at, { throwIfNoEntry: false }) : undefined;
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
 * directory, a loop, a file with several hard links (unless `hardLinks` is
 * false: where its name leads is all that is asked).
 */
export function writeLandings(raw: string, workdir: string, opts: { hardLinks?: boolean } = {}): string[] | null {
  const home = raw === "~" || raw.startsWith("~/") ? `${homedir()}${raw.slice(1)}` : raw;
  if (home.startsWith("~")) return null;
  const abs = isAbsolute(home) ? home : `${resolve(workdir)}/${home}`;
  if (underProc(resolve(abs)) || underProc(abs)) return null;
  const out: string[] = [];
  for (const p of abs.split("/").includes("..") ? [abs, resolve(abs)] : [abs]) {
    const at = landing(p, opts.hardLinks !== false);
    if (at === null) return null;
    if (!out.includes(at)) out.push(at);
  }
  return out;
}

/** A path a file tool must not write unasked: a dir `whole`, or the file itself (sandbox/policy.ts `protectedWriteTargets`). */
export interface HeldPath {
  /** Absolute. */
  at: string;
  whole: boolean;
  /** What it is, for the card: `git` (the repository's structure) or `settings` (project settings agent CLIs run code from). */
  what: "git" | "settings";
}

/**
 * The first place a file-tool call writes among `held` (the repository's
 * git dirs and `.git` files, the workspace's project settings), as
 * resolved, and what it is; null when it writes none, or isn't a file tool
 * (a shell command's writes there are the OS sandbox's to refuse). A target
 * that can't be resolved for certain counts.
 */
export function heldWriteOf(toolName: string, input: Record<string, unknown>, workdir: string, held: readonly HeldPath[]): { path: string; what: HeldPath["what"] | "unresolved" } | null {
  const targets = writeTargets(toolName, input);
  if (!targets) return null;
  const real = held.map((h) => ({ ...h, at: landing(resolve(h.at)) ?? resolve(h.at) }));
  for (const raw of targets) {
    if (raw === null) continue;
    const at = writeLandings(raw, workdir);
    if (at === null) return { path: raw, what: "unresolved" };
    for (const p of at) {
      const hit = real.find((h) => (h.whole ? within(p, h.at) : norm(p) === norm(h.at)));
      if (hit) return { path: p, what: hit.what };
    }
  }
  return null;
}

/** The approval card's reason for a file-tool write into what the sandbox holds read-only. */
export function heldWriteReason(w: { path: string; what: HeldPath["what"] | "unresolved" }): string {
  const where =
    w.what === "git"
      ? "the repository's git structure (its config, hooks or git dir, which git runs from at your next command)"
      : w.what === "settings"
        ? "project settings an agent CLI runs code from"
        : "a path that can't be resolved for certain";
  return `writes ${where}: ${w.path} — this tool runs outside the sandbox, which holds it read-only for commands`;
}
