/**
 * A workstream's folders on this machine (docs/workstreams-design.md §7): the
 * concrete directories its path rules name, plus the folders recorded as its
 * home (`workstream_folders`: a remote rule names no path). What the read
 * fence is built from — the sandbox's roots and hidden paths, the gate's
 * check.
 *
 * Bounded and link-free: a rule is expanded one segment at a time with
 * `readdir`, never `**`, at most `FOLDER_LIMIT` folders, and a symlinked
 * entry is never followed (a link an agent can plant must not place another
 * workstream's folder, nor make one look like the home's). What can't be
 * expanded is said in `limits`, never guessed at.
 */

import { lstatSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

/** Most folders one workstream's rules expand to. */
export const FOLDER_LIMIT = 512;

const GLOB_CHARS = /[*?[\]{}]/;

export interface ExpandedFolders {
  folders: string[];
  /** Rules that couldn't be expanded fully, and why. */
  limits: string[];
}

/** A directory reached through no link (an entry a glob matched). */
function isDir(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** A directory, links followed: a segment the rule names literally (the user wrote it). */
function isDirFollowed(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The existing directories a path rule (absolute, `~` expanded, normalized)
 * names. A literal rule is its own folder when it is a directory.
 */
export function expandPathRule(rule: string, limit = FOLDER_LIMIT): ExpandedFolders {
  const limits: string[] = [];
  const segments = rule.split("/").filter((s) => s.length > 0);
  let level = ["/"];
  for (const seg of segments) {
    if (seg === "**") {
      // `/**` at the end is normalized away; one in the middle names any depth.
      limits.push(`${rule}: a \`**\` in the middle isn't expanded`);
      return { folders: [], limits };
    }
    const next: string[] = [];
    if (!GLOB_CHARS.test(seg)) {
      for (const dir of level) if (isDirFollowed(join(dir, seg))) next.push(join(dir, seg));
    } else {
      const glob = new Bun.Glob(seg);
      for (const dir of level) {
        let names: string[];
        try {
          names = readdirSync(dir);
        } catch {
          continue;
        }
        for (const name of names) {
          if (!glob.match(name)) continue;
          const path = join(dir, name);
          if (isDir(path)) next.push(path);
          if (next.length > limit) {
            limits.push(`${rule}: more than ${limit} folders`);
            return { folders: [], limits };
          }
        }
      }
    }
    level = next;
    if (level.length === 0) break;
  }
  return { folders: segments.length === 0 ? ["/"] : level, limits };
}

/**
 * The repository top of `dir`: the nearest ancestor holding `.git` (a dir or
 * a file), or `dir` itself when there is none. A recorded home folder is a
 * session's workdir, which may be a package inside a repository: the fence is
 * the whole repository.
 */
export function repositoryTopOf(dir: string, stopAt?: string): string {
  let at = dir;
  for (;;) {
    try {
      lstatSync(join(at, ".git"));
      return at;
    } catch {}
    const up = dirname(at);
    if (up === at || at === stopAt) return dir;
    at = up;
  }
}

/** Whether `path` is `folder` or inside it (both absolute, normalized). */
export function within(path: string, folder: string): boolean {
  return folder === "/" || path === folder || path.startsWith(`${folder}/`);
}

/** The folders with any folder inside another dropped (the outer one kept). */
export function outermost(folders: Iterable<string>): string[] {
  const sorted = [...new Set(folders)].sort((a, b) => a.length - b.length);
  const out: string[] = [];
  for (const f of sorted) if (!out.some((o) => within(f, o))) out.push(f);
  return out;
}
