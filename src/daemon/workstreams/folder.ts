/**
 * What the matcher needs to know about a folder (docs/workstreams-design.md
 * §5.1): its two spellings (as given, and its real path), and its git remotes.
 *
 * Only those two spellings, never ones found by scanning for symlinks: a link
 * anyone can plant under a rule's folder would otherwise be a spelling an
 * attacker chose, re-homing an exclusive folder or pulling a foreign one into
 * an exclusive workstream (W0 audit). The given path is the caller's choice
 * and the real path is the kernel's; neither is a link someone else made.
 *
 * Read-only and bounded. The git remotes come from the repository's config
 * file, parsed here, never from running `git`: a repository an agent can
 * write could otherwise pick what runs (an `include.path`, a config-driven
 * helper). Parsing only `[remote "…"] url` means a hostile config can make a
 * folder look like it belongs elsewhere, and nothing more — which is why a
 * path rule outranks a remote rule (match.ts) and a session's home sticks
 * once chosen (G5).
 */

import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync, statSync, constants as fsc } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { type FolderFacts, normalizeRemote, parseSshAliases } from "./match.js";

/** Largest git config or ssh config read. */
const MAX_CONFIG_BYTES = 1_000_000;
/** Most folders above a workdir searched for `.git`. */
const MAX_WALK = 64;
/**
 * Read a small regular file, never through a final symlink; undefined on
 * anything odd. Opened non-blocking: a FIFO planted where a config is read
 * would otherwise block `open` until a writer came, freezing the daemon's
 * event loop (W0 audit) — non-blocking, the open returns and `fstat` refuses
 * it as not a regular file.
 */
function readSmall(path: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, fsc.O_RDONLY | fsc.O_NOFOLLOW | fsc.O_NONBLOCK);
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > MAX_CONFIG_BYTES) return undefined;
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = readSync(fd, buf, off, st.size - off, off);
      if (n <= 0) break;
      off += n;
    }
    return buf.subarray(0, off).toString("utf8");
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function realOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** The git dir and common dir for a folder, found by walking up. */
export function findGitDirs(start: string): { gitDir: string; commonDir: string } | undefined {
  let cur = start;
  for (let i = 0; i < MAX_WALK; i += 1) {
    const dotGit = join(cur, ".git");
    let st: ReturnType<typeof lstatSync> | undefined;
    try {
      st = lstatSync(dotGit);
    } catch {
      st = undefined;
    }
    // A `.git` that is a link is no repository we read — and must not be
    // walked past either, or a parent repository (a dotfiles repo in $HOME)
    // would lend this folder its remotes.
    if (st?.isSymbolicLink()) return undefined;
    if (st?.isDirectory()) return { gitDir: dotGit, commonDir: commonOf(dotGit) };
    if (st?.isFile()) {
      const text = readSmall(dotGit);
      const m = text ? /^gitdir:\s*(.+?)\s*$/m.exec(text) : null;
      if (!m) return undefined;
      const gitDir = isAbsolute(m[1]) ? m[1] : resolve(cur, m[1]);
      return { gitDir, commonDir: commonOf(gitDir) };
    }
    const up = dirname(cur);
    if (up === cur) return undefined;
    cur = up;
  }
  return undefined;
}

function commonOf(gitDir: string): string {
  const text = readSmall(join(gitDir, "commondir"));
  const rel = text?.trim();
  if (!rel) return gitDir;
  return isAbsolute(rel) ? rel : resolve(gitDir, rel);
}

/**
 * `[remote "name"] url = …` pairs of a git config. The first `url` of a remote
 * wins (git pushes to every url but fetches from the first). Subsections are
 * case-sensitive, section names and keys are not, as git reads them.
 */
export function parseGitRemotes(text: string): Map<string, string> {
  const out = new Map<string, string>();
  let remote: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (t.length === 0 || t.startsWith("#") || t.startsWith(";")) continue;
    const section = /^\[\s*([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\]/.exec(t);
    if (section) {
      remote = section[1].toLowerCase() === "remote" && section[2] !== undefined ? section[2].replace(/\\(.)/g, "$1") : undefined;
      continue;
    }
    if (remote === undefined) continue;
    const kv = /^([A-Za-z][A-Za-z0-9-]*)\s*=\s*(.*)$/.exec(t);
    if (!kv || kv[1].toLowerCase() !== "url") continue;
    const value = gitConfigValue(kv[2]);
    if (!out.has(remote) && value.length > 0) out.set(remote, value);
  }
  return out;
}

export interface FolderReaderOptions {
  home?: string;
  /** ssh config text; default `~/.ssh/config`. */
  sshConfig?: string;
}

/**
 * Gathers FolderFacts. One per daemon; caches ssh aliases (by the file's
 * mtime), never a resolution — a session's home is decided once and kept by
 * the session, not here.
 */
export class FolderReader {
  readonly home: string;
  #sshPath: string;
  #sshText: string | undefined;
  #sshAliases: { mtimeMs: number; map: Map<string, string> } | undefined;

  constructor(opts: FolderReaderOptions = {}) {
    this.home = opts.home ?? homedir();
    this.#sshPath = join(this.home, ".ssh", "config");
    this.#sshText = opts.sshConfig;
  }

  /** `Host` → `HostName` aliases from the ssh config. */
  sshAliases(): Map<string, string> {
    if (this.#sshText !== undefined) {
      if (!this.#sshAliases) this.#sshAliases = { mtimeMs: 0, map: parseSshAliases(this.#sshText) };
      return this.#sshAliases.map;
    }
    let mtimeMs = -1;
    try {
      mtimeMs = statSync(this.#sshPath).mtimeMs;
    } catch {
      return new Map();
    }
    if (this.#sshAliases?.mtimeMs === mtimeMs) return this.#sshAliases.map;
    const text = readSmall(this.#sshPath);
    const map = text ? parseSshAliases(text) : new Map<string, string>();
    this.#sshAliases = { mtimeMs, map };
    return map;
  }

  /** The folder's normalised `origin` and `upstream`. */
  remotes(folder: string): { origin?: string; upstream?: string } {
    const dirs = findGitDirs(realOr(folder));
    if (!dirs) return {};
    const text = readSmall(join(dirs.commonDir, "config"));
    if (!text) return {};
    const raw = parseGitRemotes(text);
    const aliases = this.sshAliases();
    const origin = raw.get("origin");
    const upstream = raw.get("upstream");
    return {
      ...(origin ? { origin: normalizeRemote(origin, aliases) } : {}),
      ...(upstream ? { upstream: normalizeRemote(upstream, aliases) } : {}),
    };
  }

  /** The folder as given and as its real path (deduped). */
  spellings(folder: string): string[] {
    return [...new Set([folder, realOr(folder)])];
  }

  facts(folder: string, wantRemotes: boolean): FolderFacts {
    return { paths: this.spellings(folder), ...(wantRemotes ? this.remotes(folder) : {}) };
  }
}

/**
 * A git config value as git reads it: `#` or `;` outside quotes ends it,
 * quotes are dropped, `\"` `\\` `\n` `\t` unescaped. (A line ending in `\`
 * continues git's value; such a url is not one anyone writes, and is left
 * cut short here — a non-match, never a wrong one.)
 */
function gitConfigValue(raw: string): string {
  let out = "";
  let quoted = false;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch === "\\" && i + 1 < raw.length) {
      const nx = raw[++i];
      out += nx === "n" ? "\n" : nx === "t" ? "\t" : nx;
    } else if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === "#" || ch === ";")) break;
    else out += ch;
  }
  return out.trim();
}
