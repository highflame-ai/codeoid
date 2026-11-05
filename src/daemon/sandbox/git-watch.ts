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
 *
 * Commits are watched too (#448 round 6): an agent can commit project
 * settings a backend runs code from (a Claude hook, an MCP server, an
 * opencode plugin) through git plumbing inside the sandbox, without them
 * ever being in the working tree; a worktree checked out from HEAD, or a
 * clone, then carries them, and a session started there trusts them. So a
 * commit that became reachable from a ref or HEAD while the session ran and
 * that changes one of those files ({@link isAgentSettingsPath}) is named,
 * with the files, for the owner to review before a session runs there.
 */

import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { hardenedGit } from "../git-env.js";
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

/**
 * The project settings files a backend runs code from (#448 round 6), at any
 * depth of the tree (a session may start in a subdirectory): Claude's
 * settings and hooks, `.mcp.json`, opencode's config and its `.opencode/`
 * (plugins), the Gemini CLI's and Qwen's settings, Codex's and pi's dirs.
 */
const AGENT_SETTINGS_PATH = /(?:^|\/)(?:\.claude\/settings[^/]*\.json|\.claude\/hooks\/.+|\.mcp\.json|opencode\.jsonc?|\.gemini\/settings\.json|\.qwen\/settings\.json|\.codex\/.+|\.pi\/.+|\.opencode\/.+)$/;

/** Whether a path in a commit (relative to the repository's top) is a project settings file a backend runs code from. */
export function isAgentSettingsPath(path: string): boolean {
  return AGENT_SETTINGS_PATH.test(path);
}

/** At most this many new commits are read per look; more are said as such. */
const COMMIT_LIMIT = 500;
/** git's time for each look. */
const COMMIT_GIT_MS = 10_000;

/** Every commit a ref or HEAD names now (tags peeled), sorted; [] without a repository, null when git couldn't say. */
export async function refTips(workspace: string, home: string = process.env.HOME ?? homedir()): Promise<string[] | null> {
  try {
    if (!gitLayoutOf(workspace, home)) return [];
  } catch {
    return null;
  }
  try {
    const out = new Set<string>();
    const refs = await hardenedGit(["for-each-ref", "--format=%(objecttype) %(objectname) %(*objecttype) %(*objectname)"], workspace, {}, { timeoutMs: COMMIT_GIT_MS });
    for (const line of refs.split("\n")) {
      const [type, id, peeledType, peeled] = line.split(" ");
      if (type === "commit" && id) out.add(id);
      else if (peeledType === "commit" && peeled) out.add(peeled);
    }
    const head = await hardenedGit(["rev-parse", "--verify", "-q", "HEAD^{commit}"], workspace, {}, { timeoutMs: COMMIT_GIT_MS }).catch(() => "");
    if (/^[0-9a-f]{40,64}$/.test(head.trim())) out.add(head.trim());
    return [...out].sort();
  } catch {
    return null;
  }
}

/** A commit that changed project settings files (its full id, and those files). */
export interface SettingsCommit {
  commit: string;
  files: string[];
}

/**
 * The commits reachable from `after`'s tips but not from `before`'s, that
 * change a project settings file a backend runs code from (against each
 * parent; a root commit against nothing), newest first. `more`: there were
 * more new commits than were read. null when git couldn't say. git runs
 * hardened (git-env.ts `hardenedGit`): nothing the repository's config names
 * runs, and only names are compared, no content.
 */
export async function settingsCommits(
  workspace: string,
  before: readonly string[],
  after: readonly string[],
): Promise<{ commits: SettingsCommit[]; more: boolean } | null> {
  const old = new Set(before);
  const fresh = after.filter((t) => !old.has(t));
  if (fresh.length === 0) return { commits: [], more: false };
  let out: string;
  try {
    // A baseline commit gone since (a ref deleted, pruned) would fail git's `--not`: only those still there bound it.
    const present = before.length === 0 ? "" : await hardenedGit(["cat-file", "--batch-check=%(objectname) %(objecttype)"], workspace, {}, { timeoutMs: COMMIT_GIT_MS, input: `${before.join("\n")}\n` });
    const bound = present.split("\n").flatMap((line) => (line.endsWith(" commit") ? [line.slice(0, -" commit".length)] : []));
    out = await hardenedGit(
      ["log", "--stdin", "-z", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "-m", "--root", "--name-only", "--format=%x01%H", "-n", String(COMMIT_LIMIT + 1)],
      workspace,
      {},
      { timeoutMs: COMMIT_GIT_MS, input: `${fresh.join("\n")}\n--not\n${bound.join("\n")}\n` },
    );
  } catch {
    return null;
  }
  const byCommit = new Map<string, Set<string>>();
  for (const record of out.split("\x01")) {
    if (!record) continue;
    const [commit = "", ...rest] = record.split("\0");
    if (!/^[0-9a-f]{40,64}$/.test(commit)) continue;
    const files = byCommit.get(commit) ?? new Set<string>();
    byCommit.set(commit, files);
    for (const raw of rest) {
      const file = raw.startsWith("\n") ? raw.slice(1) : raw;
      if (file && isAgentSettingsPath(file)) files.add(file);
    }
  }
  const more = byCommit.size > COMMIT_LIMIT;
  const commits = [...byCommit].slice(0, COMMIT_LIMIT).filter(([, f]) => f.size > 0).map(([commit, f]) => ({ commit, files: [...f].sort() }));
  return { commits, more };
}

/** A path or name as shown on the warning line: no control character, bounded. */
function shown(text: string): string {
  const clean = text.replace(/[\x00-\x1f\x7f]/g, "?");
  return clean.length > 200 ? `${clean.slice(0, 200)}…` : clean;
}

/** The session's warning line for commits that changed project settings files (#448 round 6). */
export function settingsCommitWarning(commits: readonly SettingsCommit[], more: boolean): string {
  const files = [...new Set(commits.flatMap((c) => c.files))].sort();
  const fileList = files.slice(0, 8).map(shown).join(", ") + (files.length > 8 ? ` and ${files.length - 8} more` : "");
  const commitList = commits.slice(0, 8).map((c) => c.commit.slice(0, 12)).join(", ") + (commits.length > 8 ? ` and ${commits.length - 8} more` : "");
  const unread = more ? ` (more than ${COMMIT_LIMIT} new commits: only the newest were read)` : "";
  return `While this session ran, commits changed project settings that agent CLIs run code from: ${fileList}, in ${commitList}${unread}. A worktree or checkout of these commits carries them, and a session started there runs their hooks, MCP servers or plugins on this machine — review them (git show <commit>) before a session runs there.`;
}
