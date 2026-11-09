/**
 * File tools that run outside the OS sandbox, held to its policy (#448 round
 * 8). Claude's Read, Write, Edit, Glob, Grep, LSP (its native sandbox holds
 * only its commands) and opencode's read, write, edit, patch, glob, grep (they
 * run in its shared server) are judged at codeoid's gate against the very spec
 * the session's sandbox is built from: a call is allowed only where a
 * sandboxed command could do the same thing. In autonomous mode, where no one
 * is asked, anything else is refused (#448 round 9); guarded and interactive
 * mode ask or run as they would without a sandbox, the card saying the call
 * is outside the sandbox's bounds.
 *
 *   - a write must land in what the sandbox makes writable (the workspace,
 *     the session's temp dir, the sandbox's caches, a git worktree's git
 *     dirs), never in what it holds read-only there (the repository's git
 *     structure, the project settings) or hides;
 *   - a read must not reach what the sandbox hides (the home outside
 *     `sandbox.homeReadable` and the workspace, codeoid's config and data
 *     dirs, the CLIs' logins and credential stores, container sockets,
 *     `sandbox.hiddenPaths`);
 *   - a search (Glob, Grep, LS) must not start where a hidden path is below
 *     it: the tool would recurse into it, where a sandboxed `grep -r` sees
 *     nothing. Unless the backend's search leaves it out (Claude: a Read deny
 *     rule for it, which its Grep and Glob honour) or the backend's can't
 *     and it is the user's own `sandbox.hiddenPaths` entry inside the
 *     workspace (opencode's ripgrep runs with `--no-config`): `searchable`.
 *
 * Each path is resolved as the kernel resolves it (`physicalPath`: through
 * every link, `..` the parent of what the path so far really is), and also
 * with `..` collapsed first, as a tool normalizing its path reads it; either
 * reading out of bounds counts, and one that can't be resolved for certain
 * (`/proc`'s per-process links, `..` past a missing directory, another
 * user's `~name`, a relative path whose directory isn't known) is refused.
 * Every entry of the spec is compared both as written and physical
 * (`physicalOf`), so a symlinked `/tmp` or workspace can't make the two
 * disagree. The most specific entry decides, a tie the narrower rule.
 *
 * What the backend itself needs to read outside (a Claude skill's own files,
 * the CLI's saved tool output for this session, opencode's truncated tool
 * output) is passed in as `readable`; nothing there is writable. What its own
 * file tools keep there as context, never as code (Claude's auto-memory and
 * plan files, its background tasks' output; opencode's scratch dir), is
 * passed in as `writable`, or `markdown` where only `.md` files are.
 *
 * Backends whose file tools run inside the sandbox (Codex, pi, the Gemini
 * CLI, Qwen; Claude under Docker) need none of this: the OS holds them.
 */

import { lstatSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { writeTargets } from "../held-writes.js";
import { physicalPath } from "../physical-path.js";
import { registeredOpenDirs } from "../secret-paths.js";
import { physicalOf } from "./claude-native.js";
import type { SandboxRuntime } from "./session-sandbox.js";
import type { SandboxSpec } from "./types.js";

/** What the gate holds a host-side file tool to: the sandbox's spec as path rules. */
export interface HostToolBounds {
  /** Writable roots (the workspace, the temp dir, the spec's `writable`). */
  readonly writable: readonly string[];
  /** Read-only inside them (the spec's `readOnly`, more the backend's own). */
  readonly readOnly: readonly string[];
  /** Readable inside a hidden one (the spec's `reexposed`, the backend's own `readable`). */
  readonly readable: readonly string[];
  /** Unreadable (the spec's `hidden` and container sockets). */
  readonly hidden: readonly string[];
  /** The backend's own context files inside a hidden one: writable by its file tools (never by commands). */
  readonly ownWritable: readonly string[];
  /** The same, for `.md` files only (Claude's memory and plan dirs); readable whole. */
  readonly ownMarkdown: readonly string[];
  /** Hidden paths a search may reach: the backend's search leaves them out, or can't and they are the user's own in the workspace. */
  readonly searchable: readonly string[];
  /** Where the session may write, for the refusal's reason: the workspace, and the temp dir as written and physical. */
  readonly writeTo: { readonly workspace: string; readonly tempDir: readonly string[] };
}

/** What a backend's own file tools reach outside the sandbox (SessionProvider.hostFiles). */
export interface BackendHostFiles {
  /** Read, never written: its skills, its saved tool output, its user-tier context. */
  readable?: readonly string[];
  /** Read and written: its context files, never code (Claude's background tasks' output, opencode's scratch dir). */
  writable?: readonly string[];
  /** Read whole, `.md` files written (Claude's auto-memory and plan dirs). */
  markdown?: readonly string[];
  /** Hidden paths its searches leave out (Claude: its Read deny rules). */
  searchExcluded?: readonly string[];
}

const FOLD = process.platform === "darwin" || process.platform === "win32";
const norm = (p: string) => (FOLD ? p.toLowerCase() : p);

/** `child` is `parent` or under it. */
function within(child: string, parent: string): boolean {
  const rel = relative(norm(parent), norm(child));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Each path as written (absolute) and physical, deduplicated. */
function bothForms(paths: readonly string[]): string[] {
  const out = new Set<string>();
  for (const p of paths) {
    if (!isAbsolute(p)) continue;
    out.add(resolve(p));
    out.add(physicalOf(p));
  }
  return [...out];
}

// paths: a look (does a hidden path exist), no write
function lexists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * The rules for `spec`. `tempDir`: the temp dir commands really write, when
 * it isn't the spec's (Claude's native sandbox: its commands' `TMPDIR`).
 * `readOnly`: more the backend's sandbox holds read-only (Claude's
 * `denyWrite` takes a pinned dir's subtree). `readable`: what the backend
 * itself must read outside, never written; a root holding a hidden path is
 * dropped (it would show it); so is a `writable` or `markdown` one.
 * `hidden`: more that commands can't see (the host's /tmp, where the sandbox
 * has its own). `searchable`: hidden paths a search may reach.
 */
export function hostToolBounds(
  spec: SandboxSpec,
  opts: { tempDir?: string; readOnly?: readonly string[]; readable?: readonly string[]; writable?: readonly string[]; markdown?: readonly string[]; hidden?: readonly string[]; searchable?: readonly string[] } = {},
): HostToolBounds {
  const hidden = bothForms([...spec.hidden, ...spec.containerSockets, ...(spec.serviceSockets ?? []), ...(opts.hidden ?? [])]);
  const holdsNothingHidden = (r: string) => !hidden.some((h) => within(h, r));
  const tempDir = opts.tempDir ?? spec.tempDir;
  return {
    writable: bothForms([spec.workspace, tempDir, ...spec.writable]),
    readOnly: bothForms([...(spec.readOnly ?? []), ...(opts.readOnly ?? [])]),
    readable: [...bothForms(spec.reexposed), ...bothForms(opts.readable ?? []).filter(holdsNothingHidden)],
    hidden,
    ownWritable: bothForms(opts.writable ?? []).filter(holdsNothingHidden),
    ownMarkdown: bothForms(opts.markdown ?? []).filter(holdsNothingHidden),
    searchable: bothForms(opts.searchable ?? []),
    writeTo: { workspace: spec.workspace, tempDir: bothForms([tempDir]) },
  };
}

/**
 * The rules for a session's running sandbox, as its backend's commands are
 * really held: under Claude's native sandbox the commands' temp dir is the
 * CLI's (`claudeTemp`), and a pinned dir is read-only with its subtree (the
 * CLI's `denyWrite`). `readable`: what the backend says it reads outside
 * (SessionProvider.hostReadable), with the dirs a backend's registered
 * credential locations keep open (opencode's tool output). `own`: what
 * the backend's own file tools keep outside (SessionProvider.hostFiles).
 * `userHidden`: the user's own `sandbox.hiddenPaths`, which a backend whose
 * search can't leave them out may reach inside the workspace (round 9).
 */
export function hostToolBoundsFor(
  rt: Pick<SandboxRuntime, "spec" | "plan" | "claudeTemp" | "provider">,
  backendId: string,
  readable: readonly string[] = [],
  own: BackendHostFiles = {},
  userHidden: readonly string[] = [],
): HostToolBounds {
  const spec = rt.spec;
  const claudeNative = backendId === "claude" && rt.plan.kind === "native";
  // Claude leaves out of its searches what its Read deny rules name; opencode's ripgrep can't be told to.
  const searchable = own.searchExcluded ?? (backendId === "opencode" ? userHidden.filter((h) => isAbsolute(h) && within(resolve(h), spec.workspace) && resolve(h) !== resolve(spec.workspace)) : []);
  return hostToolBounds(spec, {
    ...(claudeNative ? { tempDir: rt.claudeTemp().commands, readOnly: spec.pinned ?? [] } : {}),
    // Bubblewrap and Docker put the session's temp dir at /tmp: the host's isn't there.
    ...(!claudeNative && REPLACES_TMP.has(rt.provider.id) ? { hidden: ["/tmp"] } : {}),
    readable: [...readable, ...(own.readable ?? []), ...registeredOpenDirs()],
    writable: own.writable ?? [],
    markdown: own.markdown ?? [],
    searchable,
  });
}

/** Providers whose sandbox has a /tmp of its own (bwrap.ts, docker.ts). */
const REPLACES_TMP = new Set(["bwrap", "docker"]);

type Rule = "hidden" | "readOnly" | "readable" | "writable";
/** On a tie (the same path under two rules) the narrower one stands. */
const NARROWER: readonly Rule[] = ["hidden", "readOnly", "readable", "writable"];

/** The rule the most specific entry over `p` (physical) gives, or null when none is over it. */
function ruleAt(b: HostToolBounds, p: string): Rule | null {
  let best: { rule: Rule; depth: number } | null = null;
  const lists: Array<[Rule, readonly string[]]> = [
    ["hidden", b.hidden],
    ["readOnly", b.readOnly],
    ["readable", b.readable],
    ["writable", b.writable],
    ["writable", b.ownWritable],
    // Claude's memory and plan dirs: a `.md` file written, anything else there only read.
    [p.toLowerCase().endsWith(".md") ? "writable" : "readable", b.ownMarkdown],
  ];
  for (const [rule, list] of lists) {
    for (const at of list) {
      if (!within(p, at)) continue;
      const depth = at.length;
      if (!best || depth > best.depth || (depth === best.depth && NARROWER.indexOf(rule) < NARROWER.indexOf(best.rule))) best = { rule, depth };
    }
  }
  return best?.rule ?? null;
}

/** A sandboxed command could read `p` (physical): nothing hides it. */
export function sandboxReads(b: HostToolBounds, p: string): boolean {
  return ruleAt(b, p) !== "hidden";
}

/** A sandboxed command could write `p` (physical). */
export function sandboxWrites(b: HostToolBounds, p: string): boolean {
  return ruleAt(b, p) === "writable";
}

/** A hidden path below `root` (physical) that exists, and that a search may not reach: what a search from there would reach. */
export function hiddenBelow(b: HostToolBounds, root: string): string | null {
  return b.hidden.find((h) => within(h, root) && lexists(h) && !b.searchable.some((s) => within(h, s))) ?? null;
}

/** Why a call breaks the bounds: where, and how. */
export interface HostToolBreach {
  /** The path as the call names it (or where it leads). */
  path: string;
  access: "read" | "write" | "search";
  /** What makes it out of bounds, for the agent. */
  why: "hidden" | "not_writable" | "reaches_hidden" | "unresolved";
  /** The hidden path a search would reach. */
  reaches?: string;
  /** Where the session may write instead (a write refused). */
  writeTo?: { workspace: string; tempDir: readonly string[] };
}

/** Claude's (and opencode's, as its cards name them) host-side file tools, by what they do. */
/** Claude's LSP (`ENABLE_LSP_TOOL`) opens `filePath` in a language server outside the sandbox and hands back what it finds. */
const READ_TOOLS = new Set(["Read", "NotebookRead", "LSP"]);
const SEARCH_TOOLS = new Set(["Glob", "Grep", "LS"]);
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
/** opencode's own tool names, on an external-directory or unresolved-path card (`tool`). */
const OPENCODE_WRITE = new Set(["edit", "write", "patch", "apply_patch", "multiedit"]);
const OPENCODE_READ = new Set(["read"]);
const OPENCODE_SEARCH = new Set(["glob", "grep", "list"]);

/** Whether `toolName` is a file tool this module judges (on a backend whose file tools run outside). */
export function isHostFileTool(toolName: string): boolean {
  return READ_TOOLS.has(toolName) || SEARCH_TOOLS.has(toolName) || WRITE_TOOLS.has(toolName) || toolName === "opencode_external_directory" || toolName === "opencode_unresolved_path";
}

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0) : []);

/** Where `raw` leads: as the kernel resolves it, and `..`-collapsed too; null when that can't be told for certain. */
function landings(raw: string, base: string | null): string[] | null {
  const home = raw === "~" || raw.startsWith("~/") ? `${homedir()}${raw.slice(1)}` : raw;
  if (home.startsWith("~")) return null;
  if (!isAbsolute(home) && base === null) return null;
  const abs = isAbsolute(home) ? home : `${resolve(base as string)}/${home}`;
  const out: string[] = [];
  for (const p of abs.split("/").includes("..") ? [abs, resolve(abs)] : [abs]) {
    try {
      const at = physicalPath(p);
      if (!out.includes(at)) out.push(at);
    } catch {
      return null;
    }
  }
  return out;
}

const WILDCARD = /[*?[{]/;

/**
 * The directories a glob pattern searches from beyond its root: its
 * literal head when that is absolute, `~`, or climbs with `..`. Null when a
 * `..` follows a wildcard (where it goes can't be told).
 */
function globRoots(pattern: string, base: string | null): string[] | null {
  const parts = pattern.split("/");
  const head: string[] = [];
  let wild = false;
  for (const part of parts) {
    if (wild) {
      if (part === "..") return null;
      continue;
    }
    if (WILDCARD.test(part)) wild = true;
    else head.push(part);
  }
  const literal = head.join("/");
  if (!literal) return [];
  if (isAbsolute(literal) || literal === "~" || literal.startsWith("~/") || head.includes("..")) {
    if (!isAbsolute(literal) && !literal.startsWith("~") && base === null) return null;
    return [isAbsolute(literal) || literal.startsWith("~") ? literal : `${base}/${literal}`];
  }
  return [];
}

type Target = { raw: string | null; access: HostToolBreach["access"] };

/** What a host-side file-tool call reads, writes and searches from, as it names them. */
function targetsOf(toolName: string, input: Record<string, unknown>, base: string | null): Target[] | "unresolved" {
  const out: Target[] = [];
  const add = (access: Target["access"], ...raws: Array<string | null>) => {
    for (const raw of raws) out.push({ raw, access });
  };
  if (WRITE_TOOLS.has(toolName)) {
    add("write", ...(writeTargets(toolName, input) ?? [null]));
    if (str(input.requested_path)) add("write", str(input.requested_path));
  } else if (READ_TOOLS.has(toolName)) {
    add("read", str(input.file_path) ?? str(input.notebook_path) ?? str(input.filePath) ?? str(input.path));
    if (str(input.requested_path)) add("read", str(input.requested_path));
  } else if (SEARCH_TOOLS.has(toolName)) {
    // No root: the directory it runs in.
    add("search", str(input.path) ?? ".");
    if (str(input.requested_path)) add("search", str(input.requested_path));
    const pattern = str(input.pattern);
    if (toolName === "Glob" && pattern) {
      const roots = globRoots(pattern, base);
      if (roots === null) return "unresolved";
      add("search", ...roots);
    }
  } else if (toolName === "opencode_external_directory" || toolName === "opencode_unresolved_path") {
    const tool = str(input.tool) ?? "";
    const access: Target["access"] | null = OPENCODE_WRITE.has(tool) ? "write" : OPENCODE_READ.has(tool) ? "read" : OPENCODE_SEARCH.has(tool) ? "search" : null;
    // Another tool's card (a shell's directory): that runs inside the sandbox.
    if (!access) return [];
    const named = (...raws: Array<string | null>) => raws.filter((r): r is string => r !== null);
    if (toolName === "opencode_external_directory") {
      // A directory it is let into: searched from, or written in; and the call's own path when it says.
      const dirs = strs(input.directories);
      add(access === "write" ? "write" : "search", ...(dirs.length > 0 ? dirs : [null]));
      add(access, ...named(str(input.path), str(input.requested)));
    } else {
      // Every place it may lead.
      const all = named(str(input.path), ...strs(input.paths));
      add(access, ...(all.length > 0 ? all : [null]));
    }
  }
  return out;
}

/**
 * Where a host-side file-tool call (`toolName` one {@link isHostFileTool}
 * names) goes beyond what the session's sandbox allows, or null when a
 * sandboxed command could do the same. `cwd`: where the backend says the
 * call runs, which a relative path is resolved from (absent: the workdir;
 * null: not known, so a relative path can't be told).
 */
export function hostFileToolBreach(toolName: string, input: Record<string, unknown>, ctx: { bounds: HostToolBounds; workdir: string; cwd?: string | null }): HostToolBreach | null {
  if (!isHostFileTool(toolName)) return null;
  const base = ctx.cwd === null ? null : typeof ctx.cwd === "string" && isAbsolute(ctx.cwd) ? ctx.cwd : ctx.workdir;
  const targets = targetsOf(toolName, input, base);
  if (targets === "unresolved") return { path: str(input.pattern) ?? "(pattern)", access: "search", why: "unresolved" };
  for (const t of targets) {
    if (t.raw === null) return { path: "(no path given)", access: t.access, why: "unresolved" };
    const at = landings(t.raw, base);
    if (at === null) return { path: t.raw, access: t.access, why: "unresolved" };
    for (const p of at) {
      if (!sandboxReads(ctx.bounds, p)) return { path: p, access: t.access, why: "hidden", ...(t.access === "write" ? { writeTo: ctx.bounds.writeTo } : {}) };
      if (t.access === "write" && !sandboxWrites(ctx.bounds, p)) return { path: p, access: "write", why: "not_writable", writeTo: ctx.bounds.writeTo };
      if (t.access === "search") {
        const reaches = hiddenBelow(ctx.bounds, p);
        if (reaches) return { path: p, access: "search", why: "reaches_hidden", reaches };
      }
    }
  }
  return null;
}

/** What the agent reads when a call is refused for going beyond the sandbox (autonomous mode). */
export function hostFileBreachReason(b: HostToolBreach): string {
  const where = b.writeTo
    ? `the working directory (${b.writeTo.workspace}) or the session's temp dir (${b.writeTo.tempDir.join(", also ")})`
    : "the working directory or the session's temp dir";
  const why =
    b.why === "hidden"
      ? "the sandbox hides it from this session's commands"
      : b.why === "not_writable"
        ? "the sandbox lets this session write only the working directory, its temp dir and the sandbox's caches, not the repository's git structure or project settings"
        : b.why === "reaches_hidden"
          ? `a search there reaches ${b.reaches}, which the sandbox hides`
          : "codeoid can't tell for certain where it leads";
  const instead =
    b.access === "write" && (b.why === "not_writable" || b.why === "hidden")
      ? `Write in ${where} instead.`
      : b.why === "hidden"
        ? "Keep to the working directory; the owner can copy the file into it, add its directory to sandbox.homeReadable, or switch this session to guarded mode to be asked."
        : b.why === "reaches_hidden"
          ? "Search a directory below it that doesn't hold it, or search with grep in the shell, which runs inside the sandbox and sees nothing there."
          : "Name the path in full, without links or `..`.";
  return `Refused: outside what this session's sandbox allows: ${b.path} (${why}). This tool runs outside the OS sandbox, so in autonomous mode codeoid holds it to the sandbox's own policy. ${instead}`;
}

/** What an approval card says of a call outside the sandbox's bounds (guarded and interactive mode, where the owner decides). */
export function hostFileBreachNote(b: HostToolBreach): string {
  const what = b.why === "reaches_hidden" ? `a search reaching ${b.reaches}` : b.why === "unresolved" ? `a path codeoid can't resolve for certain (${b.path})` : `${b.access === "write" ? "a write to" : "a read of"} ${b.path}`;
  return `outside the sandbox's bounds: ${what}; runs in the backend's own process, outside the sandbox`;
}
