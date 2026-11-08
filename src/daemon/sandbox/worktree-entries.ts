/**
 * The repository's worktree entries (`<common>/worktrees/<name>`, git's
 * admin dir of each linked worktree) kept as git makes them (#448 round 11).
 *
 * A sandboxed command may add a worktree, so `worktrees/` is writable inside
 * the sandbox; every entry there when the session's spec is built that isn't
 * the session's own is held read-only (policy.ts). One someone else makes
 * while the sandbox runs (you, a fork, another session) is writable to it
 * until the spec is next built, and what a command writes there is followed
 * by git in that worktree's checkout, outside any sandbox: a `commondir`
 * naming a planted git dir runs its `core.fsmonitor` at your next
 * `git status`. Holding it would mean rebuilding the session's sandbox
 * (a Claude query, a process backend) whenever a worktree is added anywhere.
 * So instead each entry is checked against git's own layout when the
 * session's sandbox is built, at the end of every turn and at destroy
 * ({@link WorktreeEntryGuard.check}):
 *
 *   - the entry is a dir, not a link (git would follow one anywhere);
 *   - `commondir` names the repository's git dir (`../..`, as git writes it);
 *   - no `config`, `hooks/` or `info/` (but `info/sparse-checkout`) in it:
 *     git makes none there (they are the repository's, through `commondir`);
 *   - `config.worktree` empty (codeoid's placeholder), or kept: the
 *     repository has `extensions.worktreeConfig` and it was there when the
 *     session first looked, or it copies the main worktree's (as
 *     `git worktree add` does);
 *   - its `gitdir` names a checkout's `.git` file that names it back, and the
 *     checkout the session last saw it name, where that one still names it.
 *
 * What fails is restored to git's own form: `commondir` and a `gitdir` are
 * written again (the `gitdir` from the back-link: the checkout's `.git` file,
 * looked for in the worktree locations, beside the main checkout and where
 * git's records named it at the last look; never from the tampered file),
 * what git doesn't make is moved aside into `<common>/codeoid-held-worktrees/`,
 * and so is an entry that appeared naming another entry's checkout (a
 * `git worktree repair` would point that checkout at it). What can't be
 * restored with certainty is said and left: an entry replaced by a link (the
 * link is removed, so git in its checkout stops instead of following it),
 * one whose checkout no checkout or record vouches for, one removed while its
 * checkout still names it. The session says each (an info line, the
 * end-of-turn warning) and audits it (session.worktree_entry_restored).
 *
 * An entry is the session's own (left writable, policy.ts) when it is first
 * seen checked out in the session's own folder and no other checkout names
 * it: that verdict is the session's record, never read again from the
 * entry's `gitdir`, which a command can write. A record is per entry dir
 * (its inode): a name reused by another dir is looked at afresh.
 */

import { lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { madeByCodeoid } from "./worktrees.js";

/** One entry found not as git makes it. */
export interface WorktreeEntryFinding {
  /** The entry's name in the repository's `worktrees/`. */
  name: string;
  /** Restored to git's own form; false: said and left for the user. */
  restored: boolean;
  /** What was found, and what was done, in words. */
  what: string;
}

/** What a look is told of the session and its repository. */
export interface WorktreeEntryContext {
  /** The repository's git dir. */
  common: string;
  /** Its main checkout: the dirs beside it are looked at for checkouts. */
  main: string | null;
  /** The session's own worktree folders. */
  ownFolders: readonly string[];
  /** Where the session's commands can write (its workspace, temp dir, the spec's writable). */
  writable: readonly string[];
  /** What the spec holds read-only inside those. */
  readOnly: readonly string[];
  /** Dirs worktrees are checked out in: the repository's worktree locations, the main checkout's `.worktrees/`. */
  locations: readonly string[];
  /** Now, in ms (tests). */
  now?: number;
}

/** An entry younger than this that isn't whole yet may be one git is still making: looked at again after it. */
export const ENTRY_GRACE_MS = 2_000;
/** At most this many entries are looked at. */
const ENTRY_LIMIT = 500;
/** At most this many dirs are looked in for checkouts. */
const SCAN_DIR_LIMIT = 500;
/** What git never makes in a worktree's entry: the repository's, through `commondir`. */
const FOREIGN_NAMES = ["config", "hooks", "info"] as const;
/** Where what is taken out of an entry goes, in the repository's git dir (git doesn't look there). */
export const QUARANTINE_DIR = "codeoid-held-worktrees";

interface EntryRecord {
  dev: number;
  ino: number;
  /** The checkout's `.git` file that names it, absolute. */
  dotgit: string;
  /** Made by the session in its own folder. */
  own: boolean;
  /** Its `config.worktree` as accepted (empty: none). */
  config: string;
}

function realOr(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function within(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith("/") ? parent : `${parent}/`);
}

function lexists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/** A small regular file's text (never through a link): `missing`, `file` with its text, or `other` (a link, a dir, too big). */
function readSmall(p: string): { kind: "missing" } | { kind: "file"; text: string } | { kind: "other"; what: string } {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(p);
  } catch {
    return { kind: "missing" };
  }
  if (st.isSymbolicLink()) return { kind: "other", what: "a link" };
  if (!st.isFile()) return { kind: "other", what: st.isDirectory() ? "a dir" : "not a file" };
  if (st.size > 64 * 1024) return { kind: "other", what: "a large file" };
  try {
    return { kind: "file", text: readFileSync(p, "utf8") };
  } catch {
    return { kind: "other", what: "unreadable" };
  }
}

/** What a `.git` file names (`gitdir: <path>`), absolute; null for anything else (a dir, a link, no such line). */
function gitFileTarget(dotgit: string): string | null {
  const f = readSmall(dotgit);
  if (f.kind !== "file") return null;
  const m = /^gitdir:\s*(.+?)\s*$/m.exec(f.text);
  return m?.[1] ? resolve(dirname(dotgit), m[1]) : null;
}

/** The checkout `.git` an entry's `gitdir` names, absolute; null when it names none (missing, a link, empty). */
function entryGitdir(entry: string): string | null {
  const f = readSmall(join(entry, "gitdir"));
  if (f.kind !== "file") return null;
  const named = f.text.trim();
  return named ? resolve(entry, named) : null;
}

/** Whether the `.git` file `dotgit` names the entry `entryReal` (a real path). */
function namesBack(dotgit: string, entryReal: string): boolean {
  const t = gitFileTarget(dotgit);
  return t !== null && realOr(t) === entryReal;
}

/** The entry of `worktreesReal` the `.git` file `dotgit` names, or null. */
function namedEntry(dotgit: string, worktreesReal: string): string | null {
  const t = gitFileTarget(dotgit);
  if (!t) return null;
  const real = realOr(t);
  return dirname(real) === worktreesReal ? basename(real) : null;
}

function samePath(a: string, b: string): boolean {
  return resolve(a) === resolve(b) || realOr(a) === realOr(b);
}

/** `info/` holding only `sparse-checkout`: what git makes for a sparse worktree. */
function onlySparse(info: string): boolean {
  try {
    if (!lstatSync(info).isDirectory()) return false;
    const names = readdirSync(info);
    return names.length === 1 && names[0] === "sparse-checkout" && lstatSync(join(info, "sparse-checkout")).isFile();
  } catch {
    return false;
  }
}

/** A git config file's settings as `section[.sub].key=value` lines (best effort; null when there is none). */
function configLines(text: string): Set<string> {
  const out = new Set<string>();
  let section = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^\s+|\s+$/g, "");
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const head = /^\[\s*([^\]\s"]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\]\s*(.*)$/.exec(line);
    if (head) {
      section = `${head[1]!.toLowerCase()}${head[2] !== undefined ? `.${head[2]}` : ""}`;
      if (!head[3]) continue;
      out.add(`${section}.${head[3]}`);
      continue;
    }
    const kv = /^([A-Za-z][A-Za-z0-9-]*)\s*(?:=\s*(.*))?$/.exec(line);
    out.add(kv ? `${section}.${kv[1]!.toLowerCase()}=${kv[2] ?? "true"}` : `${section}.?${line}`);
  }
  return out;
}

/** Whether the repository reads per-worktree config (`extensions.worktreeConfig`). */
function worktreeConfigOn(common: string): boolean {
  const f = readSmall(join(common, "config"));
  if (f.kind !== "file") return false;
  for (const l of configLines(f.text)) {
    const m = /^extensions\.worktreeconfig=(.*)$/.exec(l);
    if (m && /^(true|yes|on|1)$/i.test(m[1]!.trim())) return true;
  }
  return false;
}

/** Whether `text` sets nothing the main worktree's `config.worktree` doesn't (what `git worktree add` copies). */
function copiesMain(text: string, common: string): boolean {
  const main = readSmall(join(common, "config.worktree"));
  if (main.kind !== "file") return false;
  const have = configLines(main.text);
  for (const l of configLines(text)) if (!have.has(l)) return false;
  return true;
}

function readlinkOr(p: string): string {
  try {
    return readlinkSync(p);
  } catch {
    return "?";
  }
}

let replaceSeq = 0;

/** Replace `p` with a regular file holding `content` (atomically: never written through a link). Whether it was. */
function replaceFile(p: string, content: string): boolean {
  const part = `${p}.codeoid-${process.pid}-${++replaceSeq}`;
  try {
    writeFileSync(part, content, { flag: "wx", mode: 0o644 });
    renameSync(part, p);
    return true;
  } catch {
    try {
      unlinkSync(part);
    } catch {
      /* never made */
    }
    return false;
  }
}

/** Is `p` written by the session's commands: inside what they can write, and not held read-only there. */
function writableBy(ctx: WorktreeEntryContext): (p: string) => boolean {
  const roots = ctx.writable.flatMap((w) => [resolve(w), realOr(w)]);
  const held = ctx.readOnly.flatMap((w) => [resolve(w), realOr(w)]);
  return (p) => {
    const forms = [resolve(p), realOr(p), realOr(dirname(p))];
    return forms.some((f) => roots.some((r) => within(f, r))) && !forms.some((f) => held.some((h) => within(f, h)));
  };
}

/**
 * The `.git` files that name an entry of `worktreesReal`, by entry name:
 * `seeds` (where records and gitdirs say), then, breadth first, each of
 * `roots` to its depth (never through a link, not inside a checkout), bounded.
 */
function scanClaims(worktreesReal: string, seeds: readonly string[], roots: ReadonlyArray<{ dir: string; depth: number }>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const seen = new Set<string>();
  const visit = (dotgit: string): boolean => {
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(dotgit);
    } catch {
      return false;
    }
    const key = resolve(dotgit);
    if (seen.has(key)) return true;
    seen.add(key);
    if (!st.isFile()) return true;
    const name = namedEntry(dotgit, worktreesReal);
    if (name) out.set(name, [...(out.get(name) ?? []), key]);
    return true;
  };
  for (const s of seeds) visit(s);
  let budget = SCAN_DIR_LIMIT;
  for (const r of roots) {
    let level = [resolve(r.dir)];
    for (let depth = 0; depth <= r.depth && level.length > 0; depth++) {
      const next: string[] = [];
      for (const dir of level) {
        if (--budget < 0) return out;
        // A checkout: its own `.git` is what counts, nothing deeper.
        if (visit(join(dir, ".git")) && depth > 0) continue;
        if (depth === r.depth) continue;
        let names: string[] = [];
        try {
          names = readdirSync(dir).sort();
        } catch {
          continue;
        }
        for (const n of names) {
          if (n === ".git") continue;
          try {
            const st = lstatSync(join(dir, n));
            if (st.isDirectory() && !st.isSymbolicLink()) next.push(join(dir, n));
          } catch {
            /* gone meanwhile */
          }
        }
      }
      level = next;
    }
  }
  return out;
}

/**
 * One session's look at its repository's worktree entries, over its life
 * (see the module's comment). Never throws; bounded.
 */
export class WorktreeEntryGuard {
  readonly #records = new Map<string, EntryRecord>();
  #common: string | null = null;
  #looked = false;
  /** Every entry dir seen at a look (`<name>:<dev>:<ino>`): one not among them appeared since. */
  readonly #known = new Set<string>();
  /** What was said and left: said once. */
  readonly #said = new Set<string>();
  /** When an entry was first let wait (by key): never longer than {@link ENTRY_GRACE_MS}, whatever its times say. */
  readonly #waiting = new Map<string, number>();

  /** The entries the session made itself: left writable to it (policy.ts). Absolute. */
  ownEntries(): string[] {
    const common = this.#common;
    if (!common) return [];
    return [...this.#records].filter(([, r]) => r.own).map(([n]) => join(common, "worktrees", n));
  }

  /** Look at every entry now, restoring what can be; `pending`: an entry still being made, to look at again after {@link ENTRY_GRACE_MS}. */
  check(ctx: WorktreeEntryContext): { findings: WorktreeEntryFinding[]; pending: boolean } {
    const findings: WorktreeEntryFinding[] = [];
    let pending = false;
    try {
      pending = this.#check(ctx, findings);
    } catch {
      /* best effort: what was found stands */
    }
    return { findings, pending };
  }

  #check(ctx: WorktreeEntryContext, findings: WorktreeEntryFinding[]): boolean {
    const common = resolve(ctx.common);
    if (this.#common !== common) {
      this.#records.clear();
      this.#known.clear();
      this.#looked = false;
      this.#common = common;
    }
    const firstLook = !this.#looked;
    this.#looked = true;
    const dir = join(common, "worktrees");
    let names: string[] = [];
    try {
      // A linked `worktrees/` makes the git dir read-only whole (policy.ts): nothing of it is the session's to make.
      if (lstatSync(dir).isSymbolicLink()) return false;
      names = readdirSync(dir).sort().slice(0, ENTRY_LIMIT);
    } catch {
      names = [];
    }
    const worktreesReal = realOr(dir);
    const now = ctx.now ?? Date.now();
    const agentWritable = writableBy(ctx);
    const own = ctx.ownFolders.map((f) => realOr(f));
    const inOwnFolder = (dotgit: string): boolean => {
      const co = realOr(dirname(dotgit));
      return own.some((f) => within(co, f) && co !== f) && !madeByCodeoid(dirname(dotgit));
    };
    let claims: Map<string, string[]> | null = null;
    const claimsOf = (name: string): string[] => {
      if (!claims) {
        const seeds = [...[...this.#records.values()].map((r) => r.dotgit), ...names.flatMap((n) => entryGitdir(join(dir, n)) ?? [])];
        const roots = [
          ...ctx.locations.map((d) => ({ dir: d, depth: 3 })),
          ...(ctx.main ? [{ dir: dirname(resolve(ctx.main)), depth: 1 }] : []),
        ];
        claims = scanClaims(worktreesReal, seeds, roots);
      }
      return claims.get(name) ?? [];
    };
    const say = (f: WorktreeEntryFinding): void => {
      const key = `${f.name}\n${f.what}`;
      if (!f.restored && this.#said.has(key)) return;
      this.#said.add(key);
      findings.push(f);
    };
    const aside = (src: string, label: string): string | null => quarantine(common, src, label);
    let pending = false;
    // A checkout the session saw naming its entry, now naming another one made since, which names it back: a
    // `git worktree repair` adopted a planted entry. Its `.git` is pointed back (the planted entry is moved aside below).
    for (const [name, rec] of this.#records) {
      if (rec.own || !names.includes(name)) continue;
      const other = namedEntry(rec.dotgit, worktreesReal);
      if (!other || other === name || this.#records.has(other) || !names.includes(other)) continue;
      const otherNamed = entryGitdir(join(dir, other));
      let otherKey = "";
      try {
        const o = lstatSync(join(dir, other));
        otherKey = `${other}:${o.dev}:${o.ino}`;
      } catch {
        continue;
      }
      if (firstLook || this.#known.has(otherKey) || !otherNamed || !samePath(otherNamed, rec.dotgit)) continue;
      if (replaceFile(rec.dotgit, `gitdir: ${join(dir, name)}\n`)) {
        say({ name, restored: true, what: `its checkout's .git (${rec.dotgit}) had been pointed at worktrees/${other}, an entry made since naming it (a \`git worktree repair\` does that): pointed back` });
      }
    }
    const seen = new Set<string>();
    for (const name of names) {
      seen.add(name);
      const at = join(dir, name);
      const atReal = join(worktreesReal, name);
      let st: ReturnType<typeof lstatSync>;
      try {
        st = lstatSync(at);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) {
        const rec = this.#records.get(name);
        this.#records.delete(name);
        const target = readlinkOr(at);
        let removed = false;
        try {
          unlinkSync(at);
          removed = true;
        } catch {
          /* said as is */
        }
        say({
          name,
          restored: false,
          what: removed
            ? `was replaced with a link to ${target}, which git would follow to whatever git dir is there: the link is removed, so git in its checkout${rec ? ` (${dirname(rec.dotgit)})` : ""} stops instead ("not a git repository"); look at ${target} before putting anything back, or remove the checkout and add the worktree again`
            : `is a link to ${target}, which git in its checkout follows: remove it before running git there`,
        });
        continue;
      }
      // Anything else that isn't a dir git ignores, and a checkout naming it fails ("not a git repository").
      if (!st.isDirectory()) continue;
      // Made since the session's last look (not at its first: what was there then is as the user left it).
      const key = `${name}:${st.dev}:${st.ino}`;
      const isNew = !firstLook && !this.#known.has(key);
      this.#known.add(key);
      let rec = this.#records.get(name);
      // Another dir under a name the session saw (removed, then made again): looked at afresh.
      if (rec && (rec.ino !== st.ino || rec.dev !== st.dev)) {
        this.#records.delete(name);
        rec = undefined;
      }
      const named = entryGitdir(at);
      const commondir = readSmall(join(at, "commondir"));
      // git writes `gitdir`, the checkout's `.git` and `commondir` one after the other: one caught between them waits,
      // once, and no longer than the grace (a command touching it can't keep it waiting).
      const waitingSince = this.#waiting.get(key);
      const young = !rec && now - Math.max(st.mtimeMs, st.ctimeMs) < ENTRY_GRACE_MS && (waitingSince === undefined || now - waitingSince < ENTRY_GRACE_MS);
      if (young && (named === null || !lexists(named) || commondir.kind === "missing")) {
        if (waitingSince === undefined) this.#waiting.set(key, now);
        this.#known.delete(key);
        pending = true;
        continue;
      }
      this.#waiting.delete(key);
      const fixes: string[] = [];
      const left: string[] = [];
      // What git never makes there: moved aside.
      for (const x of FOREIGN_NAMES) {
        const p = join(at, x);
        if (!lexists(p) || (x === "info" && onlySparse(p))) continue;
        const moved = aside(p, `${name}-${x}`);
        if (moved) fixes.push(`${x === "config" ? "a config" : `${x}/`} (git makes none there) moved to ${moved}`);
        else left.push(`it holds ${x}, which git makes none of there: remove it`);
      }
      // `commondir`: the repository's git dir, as git writes it.
      const commondirOk = commondir.kind === "file" && [common, realOr(common)].includes(resolve(at, commondir.text.trim()));
      if (!commondirOk) {
        const was = commondir.kind === "file" ? `named ${commondir.text.trim() || "nothing"}` : commondir.kind === "missing" ? "was missing" : `was ${commondir.what}`;
        if (commondir.kind === "other") aside(join(at, "commondir"), `${name}-commondir`);
        if (replaceFile(join(at, "commondir"), "../..\n")) fixes.push(`commondir ${was}: now ../.. (the repository's git dir)`);
        else left.push(`its commondir ${was}: set it to ../..`);
      }
      // `config.worktree`: none of its own, but the user's where the repository reads them.
      let config = "";
      const cw = readSmall(join(at, "config.worktree"));
      if (cw.kind === "other") {
        const moved = aside(join(at, "config.worktree"), `${name}-config.worktree`);
        if (moved && replaceFile(join(at, "config.worktree"), "")) fixes.push(`config.worktree was ${cw.what}: moved to ${moved}`);
        else left.push(`its config.worktree is ${cw.what}: remove it`);
      } else if (cw.kind === "file" && cw.text !== "") {
        const on = worktreeConfigOn(common);
        const kept = (on && (rec ? rec.config === cw.text : !isNew)) || (on && copiesMain(cw.text, common));
        if (kept) config = cw.text;
        else {
          const moved = keepAside(common, `${name}-config.worktree`, cw.text);
          if (moved && replaceFile(join(at, "config.worktree"), "")) fixes.push(`config.worktree set ${configLines(cw.text).size} setting(s)${on ? "" : ", which git reads once the repository turns on extensions.worktreeConfig"}: emptied, its content kept at ${moved}`);
          else left.push("its config.worktree has settings of its own: look at it");
        }
      }
      const consistent = named !== null && namesBack(named, atReal);
      // The session's own: made in its folder; only a checkout out of its reach makes it someone else's.
      if (rec?.own) {
        if (!(consistent && named && !agentWritable(named))) {
          if (consistent && named) rec.dotgit = named;
          rec.config = config;
          this.#report(name, fixes, left, say);
          continue;
        }
        rec.own = false;
      }
      let canonical: string | null = null;
      let problem: string | null = null;
      let planted = false;
      const trusted = (others: string[]) => others.filter((c) => !agentWritable(c) && !(named && consistent && samePath(c, named)));
      if (rec) {
        if (consistent && named && samePath(named, rec.dotgit)) canonical = named;
        // Its checkout still names it: the gitdir was rewritten.
        else if (namesBack(rec.dotgit, atReal)) canonical = rec.dotgit;
        // Its checkout moved (git worktree move) out of the session's reach.
        else if (consistent && named && !agentWritable(named)) canonical = named;
        // Its gitdir as it was: only the checkout changed. Gone (removed by hand) it is prunable, as git leaves it.
        else if (named && samePath(named, rec.dotgit)) {
          if (lexists(named)) problem = `its checkout (${dirname(named)}) no longer names it${namedEntry(named, worktreesReal) ? ` but worktrees/${namedEntry(named, worktreesReal)}` : ""}: run git worktree repair there if that isn't yours`;
        } else {
          const t = trusted(claimsOf(name));
          if (t.length === 1) canonical = t[0] ?? null;
          else problem = `its checkout (${dirname(rec.dotgit)}) no longer names it, and its gitdir names ${named ?? "nothing"}${t.length > 1 ? `; ${t.length} checkouts name it` : ""}: run git worktree repair in the checkout that is really its own`;
        }
      } else {
        const t = trusted(claimsOf(name));
        if (consistent && named) {
          if (inOwnFolder(named) && t.length === 0) {
            this.#records.set(name, { dev: st.dev, ino: st.ino, dotgit: named, own: true, config });
            this.#report(name, fixes, left, say);
            continue;
          }
          if (!inOwnFolder(named) && !agentWritable(named)) canonical = named;
          else if (t.length === 1) canonical = t[0] ?? null;
          else if (t.length === 0) canonical = named;
          else problem = `${t.length + 1} checkouts name it (${[named, ...t].map((c) => dirname(c)).join(", ")}): keep it for the one that is really its own (git worktree repair there)`;
        } else if (t.length === 1) canonical = t[0] ?? null;
        else if (t.length > 1) problem = `its gitdir names ${named ?? "nothing"}, which doesn't name it back, and ${t.length} checkouts do (${t.map((c) => dirname(c)).join(", ")}): run git worktree repair in the one that is really its own`;
        else {
          const other = named ? namedEntry(named, worktreesReal) : null;
          if (named && other && other !== name) {
            // Naming a checkout that is another entry's: a `git worktree repair` would point that checkout here.
            if (!isNew) problem = `names ${dirname(named)}, which is the worktree ${other}'s checkout: \`git worktree repair\` would point that checkout at this entry; remove it if you didn't make it`;
            else planted = true;
          } else if (isNew) {
            problem = `appeared naming ${named ? dirname(named) : "no checkout"}, which doesn't name it back, and no checkout found does: if it is yours, run \`git worktree repair <its checkout>\``;
          }
          // One there before (its checkout gone: prunable) is as git leaves it.
        }
      }
      if (planted) {
        const moved = aside(at, name);
        if (moved) fixes.push(`appeared naming ${dirname(named as string)}, the worktree ${namedEntry(named as string, worktreesReal)}'s checkout (a \`git worktree repair\` would have pointed it here): moved to ${moved}`);
        else left.push(`names ${dirname(named as string)}, another worktree's checkout: remove it`);
        this.#report(name, fixes, left, say);
        continue;
      }
      if (canonical && !(consistent && named && samePath(named, canonical))) {
        if (readSmall(join(at, "gitdir")).kind === "other") aside(join(at, "gitdir"), `${name}-gitdir`);
        if (replaceFile(join(at, "gitdir"), `${resolve(canonical)}\n`)) fixes.push(`gitdir named ${named ?? "nothing"}: now ${resolve(canonical)}, the checkout that names it`);
        else left.push(`its gitdir names ${named ?? "nothing"}, not its checkout ${resolve(canonical)}`);
      }
      if (canonical) this.#records.set(name, { dev: st.dev, ino: st.ino, dotgit: resolve(canonical), own: false, config });
      if (problem) left.push(problem);
      this.#report(name, fixes, left, say);
    }
    // Entries gone since the last look whose checkout still names them.
    for (const [name, rec] of [...this.#records]) {
      if (seen.has(name)) continue;
      this.#records.delete(name);
      if (rec.own) continue;
      const still = gitFileTarget(rec.dotgit);
      if (still !== null && [join(dir, name), join(worktreesReal, name)].includes(resolve(still))) {
        say({ name, restored: false, what: `was removed while its checkout (${dirname(rec.dotgit)}) still names it: git there fails ("not a git repository"), and its HEAD and index are gone; add the worktree again, or remove that checkout` });
      }
    }
    return pending;
  }

  #report(name: string, fixes: string[], left: string[], say: (f: WorktreeEntryFinding) => void): void {
    if (fixes.length > 0) say({ name, restored: true, what: fixes.join("; ") });
    if (left.length > 0) say({ name, restored: false, what: left.join("; ") });
  }
}

/** The repository's dir for what is taken out of its worktree entries: made 0700, never through a link; null when it can't be. */
function quarantineDir(common: string): string | null {
  const dir = join(common, QUARANTINE_DIR);
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch {
    /* there already */
  }
  try {
    const st = lstatSync(dir);
    return st.isDirectory() && !st.isSymbolicLink() ? dir : null;
  } catch {
    return null;
  }
}

/** Move `src` (a file, a dir, a link) into the quarantine dir; where it went, or null. */
function quarantine(common: string, src: string, label: string): string | null {
  const dir = quarantineDir(common);
  if (!dir) return null;
  const safe = label.replace(/[^A-Za-z0-9._-]/g, "_");
  for (let i = 0; i < 100; i++) {
    const dest = join(dir, `${safe}-${Date.now()}${i ? `-${i}` : ""}`);
    if (lexists(dest)) continue;
    try {
      renameSync(src, dest);
      return dest;
    } catch {
      return null;
    }
  }
  return null;
}

/** Keep `content` in the quarantine dir; where, or null. */
function keepAside(common: string, label: string, content: string): string | null {
  const dir = quarantineDir(common);
  if (!dir) return null;
  const dest = join(dir, `${label.replace(/[^A-Za-z0-9._-]/g, "_")}-${Date.now()}-${++replaceSeq}`);
  try {
    writeFileSync(dest, content, { flag: "wx", mode: 0o600 });
    return dest;
  } catch {
    return null;
  }
}

/** A finding as said on the session (#448 round 11): the entry, and what was found and done. */
export function worktreeEntryLine(common: string, f: WorktreeEntryFinding): string {
  return `${basename(common)}/worktrees/${f.name} ${f.what}`;
}

/** The session's warning for `findings` (an info line; the end-of-turn warning). */
export function worktreeEntryWarning(common: string, findings: readonly WorktreeEntryFinding[]): string {
  const restored = findings.filter((f) => f.restored);
  const left = findings.filter((f) => !f.restored);
  const parts: string[] = [];
  if (restored.length > 0) parts.push(`git's record of a worktree was changed from how git makes it, and is restored: ${restored.slice(0, 5).map((f) => worktreeEntryLine(common, f)).join(". ")}${restored.length > 5 ? `. And ${restored.length - 5} more` : ""}.`);
  if (left.length > 0) parts.push(`Not restored, for you to look at: ${left.slice(0, 5).map((f) => worktreeEntryLine(common, f)).join(". ")}${left.length > 5 ? `. And ${left.length - 5} more` : ""}.`);
  return `${parts.join(" ")} git in a worktree follows its record (a planted git dir's config, its core.fsmonitor, runs at your next git command there): look before you run git in these worktrees.`;
}
