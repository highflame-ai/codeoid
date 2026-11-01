/**
 * Where a path really leads: resolved the way the kernel resolves it, one
 * component at a time from `/`, never lexically. One resolver for every
 * judge that must know where a path lands: opencode's `realTarget`
 * (providers/opencode/translate.ts) and the outside-writes rule
 * (outside-writes.ts).
 */

import { lstatSync, readlinkSync, statfsSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";

/** procfs's `f_type` (`PROC_SUPER_MAGIC`). */
const PROC_SUPER_MAGIC = 0x9fa0;

/** Paths that are per-process wherever procfs is or isn't (macOS's `/dev/fd` is fdesc). */
const PER_PROCESS = ["/proc/self", "/proc/thread-self", "/dev/fd", "/dev/stdin", "/dev/stdout", "/dev/stderr"];

/** The kernel's limit on symlinks followed in one lookup (`ELOOP` past it). */
const MAX_LINKS = 40;

/** Thrown by `physicalPath` for a path whose target depends on the process that follows it. */
export class PerProcessPath extends Error {
  constructor(readonly path: string) {
    super(`${path} leads through a link that goes somewhere else in opencode's process`);
  }
}

/**
 * Thrown by `physicalPath` for a path codeoid can't resolve for certain.
 * `candidates` are where it might lead, judged by the secret-path gate.
 */
export class UnresolvedPath extends Error {
  constructor(
    readonly path: string,
    readonly why: string,
    readonly candidates: readonly string[] = [],
  ) {
    super(`codeoid can't tell for certain where ${path} leads: ${why}`);
  }
}

function onProcfs(dir: string): boolean {
  try {
    return statfsSync(dir).type === PROC_SUPER_MAGIC;
  } catch {
    return false;
  }
}

/** A path's components, `.` and empty ones dropped (`..` kept). */
export const components = (p: string) => p.split("/").filter((c) => c !== "" && c !== ".");

/** `p` is `root` or under it (a name like `..foo` is under it). */
export function within(root: string, p: string): boolean {
  const rel = relative(root, p);
  return rel === "" || (rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel));
}

/**
 * `p` (absolute) resolved the way the kernel resolves it, one component at
 * a time from `/`: `..` is the parent of the physical prefix so far, and a
 * symlink's target is spliced in as written (a relative one from the link's
 * directory), never normalized first. A dangling link leads to its target.
 * A component that doesn't exist ends what's followed: the rest is appended
 * as written (what a create makes). Throws `PerProcessPath` at any
 * per-process link — one of `PER_PROCESS`, or any symlink on procfs — and
 * `UnresolvedPath` at any step it can't be sure of: `..` after a missing
 * component, a component under a file, one codeoid can't look at, or too
 * many links (a loop).
 */
export function physicalPath(p: string): string {
  const parts = components(p);
  let at = "/";
  let missing = false;
  for (let links = 0; parts.length > 0; ) {
    const name = parts.shift()!;
    if (name === "..") {
      if (missing) throw new UnresolvedPath(p, `".." follows ${at}, which doesn't exist`);
      at = dirname(at);
      continue;
    }
    const next = join(at, name);
    if (PER_PROCESS.some((pp) => within(pp, next))) throw new PerProcessPath(p);
    if (missing) {
      at = next;
      continue;
    }
    let link: string | undefined;
    try {
      const st = lstatSync(next);
      if (st.isSymbolicLink()) link = readlinkSync(next);
      else if (parts.length > 0 && !st.isDirectory()) throw new UnresolvedPath(p, `${next} isn't a directory`);
    } catch (err) {
      if (err instanceof UnresolvedPath) throw err;
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw new UnresolvedPath(p, `codeoid can't look at ${next}`);
      missing = true;
      at = next;
      continue;
    }
    if (link === undefined) {
      at = next;
      continue;
    }
    if (onProcfs(at)) throw new PerProcessPath(p);
    if (++links > MAX_LINKS) throw new UnresolvedPath(p, "it goes through too many links");
    parts.unshift(...components(link));
    if (isAbsolute(link)) at = "/";
  }
  return at;
}
