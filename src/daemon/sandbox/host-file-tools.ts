/**
 * File tools that run outside the OS sandbox, held to its policy (#448 round
 * 8). Claude's Read, Write, Edit, Glob, Grep (its native sandbox holds only its
 * commands) and opencode's read, write, edit, patch, glob, grep (they run in
 * its shared server) are judged at codeoid's gate against the very spec the
 * session's sandbox is built from: a call is allowed only where a sandboxed
 * command could do the same thing. Anything else is refused, in every mode,
 * never asked.
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
 *     nothing.
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
 * output) is passed in as `readable`; nothing there is ever writable.
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
 * dropped (it would show it). `hidden`: more that commands can't see (the
 * host's /tmp, where the sandbox has its own).
 */
export function hostToolBounds(spec: SandboxSpec, opts: { tempDir?: string; readOnly?: readonly string[]; readable?: readonly string[]; hidden?: readonly string[] } = {}): HostToolBounds {
  const hidden = bothForms([...spec.hidden, ...spec.containerSockets, ...(opts.hidden ?? [])]);
  const extra = bothForms(opts.readable ?? []).filter((r) => !hidden.some((h) => within(h, r)));
  return {
    writable: bothForms([spec.workspace, opts.tempDir ?? spec.tempDir, ...spec.writable]),
    readOnly: bothForms([...(spec.readOnly ?? []), ...(opts.readOnly ?? [])]),
    readable: [...bothForms(spec.reexposed), ...extra],
    hidden,
  };
}

/**
 * The rules for a session's running sandbox, as its backend's commands are
 * really held: under Claude's native sandbox the commands' temp dir is the
 * CLI's (`claudeTemp`), and a pinned dir is read-only with its subtree (the
 * CLI's `denyWrite`). `readable`: what the backend says it reads outside
 * (SessionProvider.hostReadable), with the dirs a backend's registered
 * credential locations keep open (opencode's tool output).
 */
export function hostToolBoundsFor(rt: Pick<SandboxRuntime, "spec" | "plan" | "claudeTemp" | "provider">, backendId: string, readable: readonly string[] = []): HostToolBounds {
  const spec = rt.spec;
  const claudeNative = backendId === "claude" && rt.plan.kind === "native";
  return hostToolBounds(spec, {
    ...(claudeNative ? { tempDir: rt.claudeTemp().commands, readOnly: spec.pinned ?? [] } : {}),
    // Bubblewrap and Docker put the session's temp dir at /tmp: the host's isn't there.
    ...(!claudeNative && REPLACES_TMP.has(rt.provider.id) ? { hidden: ["/tmp"] } : {}),
    readable: [...readable, ...registeredOpenDirs()],
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

/** A hidden path below `root` (physical) that exists: what a search from there would reach. */
export function hiddenBelow(b: HostToolBounds, root: string): string | null {
  return b.hidden.find((h) => within(h, root) && lexists(h)) ?? null;
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
}

/** Claude's (and opencode's, as its cards name them) host-side file tools, by what they do. */
const READ_TOOLS = new Set(["Read", "NotebookRead"]);
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
    add("read", str(input.file_path) ?? str(input.notebook_path) ?? str(input.path));
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
      if (!sandboxReads(ctx.bounds, p)) return { path: p, access: t.access, why: "hidden" };
      if (t.access === "write" && !sandboxWrites(ctx.bounds, p)) return { path: p, access: "write", why: "not_writable" };
      if (t.access === "search") {
        const reaches = hiddenBelow(ctx.bounds, p);
        if (reaches) return { path: p, access: "search", why: "reaches_hidden", reaches };
      }
    }
  }
  return null;
}

/** What the agent reads when a call is refused for going beyond the sandbox. */
export function hostFileBreachReason(b: HostToolBreach): string {
  const why =
    b.why === "hidden"
      ? "the sandbox hides it from this session's commands"
      : b.why === "not_writable"
        ? "the sandbox lets this session write only the working directory, its temp dir and the sandbox's caches, not the repository's git structure or project settings"
        : b.why === "reaches_hidden"
          ? `a search there reaches ${b.reaches}, which the sandbox hides`
          : "codeoid can't tell for certain where it leads";
  return `Refused: outside what this session's sandbox allows: ${b.path} (${why}). This tool runs outside the OS sandbox, so codeoid holds it to the sandbox's own policy; keep to the working directory.`;
}
