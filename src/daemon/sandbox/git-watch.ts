/**
 * What of a workspace's repository git runs or obeys at the user's next git
 * command, outside any sandbox, that `git status` and a diff don't show
 * (#448): its config, hooks (the hooks dir's, and `core.hooksPath`'s when it
 * points into the repository: husky's `.husky/_`), attributes, and what
 * names its git dirs (`commondir`, a worktree's `gitdir`, the `.git` file).
 *
 * The sandbox holds most of these read-only, as defence in depth; it doesn't
 * guarantee the workspace is safe to run (it is the agent's output, and is
 * code). So a session says when any of them changed while it ran
 * (Session's end-of-turn and destroy check): a cheap, visible signal to look
 * before running git there. Best effort: bounded, never throws, and what
 * codeoid's own placeholders make (an empty `config.worktree`, a `commondir`
 * of `.`) reads as nothing changed.
 */

import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { gitLayoutOf } from "./policy.js";

/** Larger files are fingerprinted by size and time only. */
const READ_LIMIT = 1024 * 1024;
/** At most this many entries of a hooks dir. */
const DIR_LIMIT = 200;

/** Label → fingerprint of each watched file (absent: not in the map). */
export type GitControlSnapshot = ReadonlyMap<string, string>;

function fingerprint(p: string): string | null {
  try {
    const st = lstatSync(p);
    if (st.isSymbolicLink()) return `link:${readlinkOr(p)}`;
    if (!st.isFile()) return null;
    if (st.size > READ_LIMIT) return `big:${st.size}:${st.mtimeMs}:${st.mode}`;
    return `${createHash("sha256").update(readFileSync(p)).digest("hex")}:${st.mode & 0o111 ? "x" : "-"}`;
  } catch {
    return null;
  }
}

function readlinkOr(p: string): string {
  try {
    return readlinkSync(p);
  } catch {
    return "?";
  }
}

/** codeoid's own placeholders read as absent: an empty `config.worktree`, a `commondir` of `.`. */
function placeholder(p: string, name: string): boolean {
  try {
    const text = readFileSync(p, "utf8");
    return (name === "config.worktree" && text === "") || (name === "commondir" && text.trim() === ".");
  } catch {
    return false;
  }
}

function entries(dir: string): string[] {
  try {
    return readdirSync(dir).sort().slice(0, DIR_LIMIT);
  } catch {
    return [];
  }
}

/** `core.hooksPath` as the repository's own config files set it (the last one wins), or null. */
function hooksPathOf(configs: readonly string[]): string | null {
  let found: string | null = null;
  for (const file of configs) {
    let text = "";
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    let inCore = false;
    for (const line of text.split(/\r?\n/)) {
      const section = /^\s*\[\s*([^\]\s"]+)/.exec(line);
      if (section) inCore = section[1]!.toLowerCase() === "core";
      const m = inCore ? /^\s*hookspath\s*=\s*("?)(.*?)\1\s*$/i.exec(line) : null;
      if (m) found = m[2] ?? null;
    }
  }
  return found;
}

/** What a workspace's repository has now that git runs or obeys (see the module's comment); empty without a repository. */
export function gitControlSnapshot(workspace: string, home: string = process.env.HOME ?? homedir()): GitControlSnapshot {
  const out = new Map<string, string>();
  try {
    const layout = gitLayoutOf(workspace, home);
    if (!layout) return out;
    const top = dirname(layout.dotgit);
    const label = (p: string) => {
      const rel = relative(top, p);
      return rel.startsWith("..") || isAbsolute(rel) ? p : rel;
    };
    const watch = (p: string) => {
      const name = p.slice(p.lastIndexOf("/") + 1);
      if (placeholder(p, name)) return;
      const f = fingerprint(p);
      if (f !== null) out.set(label(p), f);
    };
    const watchDir = (dir: string) => {
      for (const n of entries(dir)) watch(join(dir, n));
    };
    if (layout.dotgit !== layout.common) watch(layout.dotgit);
    watch(join(top, ".gitattributes"));
    const common = layout.common;
    if (!common) return out;
    for (const n of ["config", "config.worktree", "commondir"]) watch(join(common, n));
    watch(join(common, "info", "attributes"));
    watchDir(join(common, "hooks"));
    for (const w of entries(join(common, "worktrees"))) for (const n of ["commondir", "gitdir", "config.worktree"]) watch(join(common, "worktrees", w, n));
    const hooksPath = hooksPathOf([join(common, "config"), join(common, "config.worktree"), ...(layout.own ? [join(layout.own, "config.worktree")] : [])]);
    if (hooksPath) {
      const dir = hooksPath.startsWith("~/") ? join(home, hooksPath.slice(2)) : resolve(top, hooksPath);
      out.set("core.hooksPath", hooksPath);
      watchDir(dir);
    }
  } catch {
    /* best effort: what was read stands */
  }
  return out;
}

/** What changed between two snapshots (added, removed or different), by label. */
export function gitControlChanges(before: GitControlSnapshot, after: GitControlSnapshot): string[] {
  const out: string[] = [];
  for (const k of new Set([...before.keys(), ...after.keys()])) if (before.get(k) !== after.get(k)) out.push(k);
  return out.sort();
}

/** The session's warning line for `changed`. */
export function gitControlWarning(changed: readonly string[]): string {
  const shown = changed.slice(0, 8).join(", ");
  const more = changed.length > 8 ? ` and ${changed.length - 8} more` : "";
  return `While this session ran, the repository's git settings changed: ${shown}${more}. git runs or obeys these (a hook, core.fsmonitor, a filter) at your next git command here, and in any other tool that runs git here outside a sandbox (an editor's, another CLI's; the backends codeoid starts run theirs contained), and git status doesn't show them — look before you run git in this repository.`;
}
