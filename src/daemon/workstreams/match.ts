/**
 * Workstream matching — pure (docs/workstreams-design.md §5.1).
 *
 * Nothing here touches the filesystem: the caller hands in every spelling of
 * the folder (as given, its real path, its aliases through a symlink a rule's
 * prefix names) and the folder's normalised remotes. `folder.ts` gathers
 * those; this module only decides.
 *
 * Rules:
 *  - A path rule matches a folder when the folder, or any folder above it,
 *    matches the glob. `~/x` and `~/x/**` therefore mean the same thing.
 *  - A remote rule matches the `origin` remote, or `upstream`. A match through
 *    `upstream` alone is only ever a suggestion: you see where the code came
 *    from, you are not held to it.
 *  - The most specific RULE wins (never where it matched: `/w/**` matching
 *    the folder itself must not beat `/w/acme` matching its parent): any path
 *    match beats any remote match; then the rule with more literal segments;
 *    then more literal characters; `origin` beats `upstream`.
 *  - Two workstreams tied at the top are ambiguous: no home is picked, and the
 *    tie is reported so an explicit choice can settle it.
 */

export type WorkstreamClaim = "exclusive" | "suggest";

/** What the matcher needs of a workstream. */
export interface MatchableWorkstream {
  id: string;
  abstract: boolean;
  claim: WorkstreamClaim;
  /** Path globs, `~` already expanded. */
  paths: readonly string[];
  /** Remote globs over `host/owner/repo`. */
  remotes: readonly string[];
}

/** The folder, as every spelling the caller could find. */
export interface FolderFacts {
  /** Absolute spellings of the folder: as given, real path, aliases. Deduped by the caller or not — either works. */
  paths: readonly string[];
  /** Normalised `host/owner/repo` of the `origin` remote, when there is one. */
  origin?: string;
  /** Normalised `host/owner/repo` of the `upstream` remote, when there is one. */
  upstream?: string;
}

export interface MatchCandidate {
  workstream: string;
  /** The rule that matched, as written in the config (after `~` expansion for paths). */
  rule: string;
  kind: "path" | "remote";
  /** For a remote match: which remote. */
  via?: "origin" | "upstream";
  /** The claim this match carries: an `upstream`-only match is downgraded to `suggest`. */
  claim: WorkstreamClaim;
  /** Ordering key, highest wins. Exposed for display and tests. */
  score: readonly number[];
}

export interface MatchResult {
  /** Every workstream that matched, best first, one entry per workstream (its best rule). */
  candidates: MatchCandidate[];
  /** The winner, when there is exactly one best. */
  best?: MatchCandidate;
  /** Workstream ids tied for best, when more than one. */
  ambiguous?: string[];
}

/** Characters that make a path segment a glob rather than a literal. */
const GLOB_CHARS = /[*?[\]{}]/;

/** Count of literal (non-glob) characters, a crude but stable specificity. */
export function literalLength(glob: string): number {
  let n = 0;
  for (const ch of glob) if (!GLOB_CHARS.test(ch)) n += 1;
  return n;
}

/** Segments with no glob character: `/home/u/Workspace/acme-*` → 3. */
export function literalSegments(glob: string): number {
  return glob.split("/").filter((s) => s.length > 0 && !GLOB_CHARS.test(s)).length;
}

/** `/a/b/c` → [`/a/b/c`, `/a/b`, `/a`, `/`]. */
export function ancestry(path: string): string[] {
  const clean = path.length > 1 ? path.replace(/\/+$/, "") : path;
  const out: string[] = [clean];
  let cur = clean;
  while (cur !== "/" && cur.length > 0) {
    const i = cur.lastIndexOf("/");
    cur = i <= 0 ? "/" : cur.slice(0, i);
    out.push(cur);
  }
  return out;
}

/** Glob matcher, cached per pattern. Bun's Glob: `*` stays in a segment, `**` crosses. */
const globCache = new Map<string, Bun.Glob>();
export function globMatch(pattern: string, value: string): boolean {
  let g = globCache.get(pattern);
  if (!g) {
    g = new Bun.Glob(pattern);
    if (globCache.size > 2048) globCache.clear();
    globCache.set(pattern, g);
  }
  return g.match(value);
}

/** Best path match of one workstream over every spelling of the folder. */
function bestPathMatch(ws: MatchableWorkstream, folder: FolderFacts): MatchCandidate | undefined {
  let best: MatchCandidate | undefined;
  for (const spelling of folder.paths) {
    for (const dir of ancestry(spelling)) {
      for (const rule of ws.paths) {
        // `x/**` names x too: Bun's `**` needs at least one segment below it.
        const matched = globMatch(rule, dir) || (rule.endsWith("/**") && globMatch(rule.slice(0, -3) || "/", dir));
        if (!matched) continue;
        const cand: MatchCandidate = {
          workstream: ws.id,
          rule,
          kind: "path",
          claim: ws.claim,
          score: [2, literalSegments(rule), literalLength(rule), 1],
        };
        if (!best || compareScore(cand.score, best.score) > 0) best = cand;
      }
    }
  }
  return best;
}

function bestRemoteMatch(ws: MatchableWorkstream, folder: FolderFacts): MatchCandidate | undefined {
  let best: MatchCandidate | undefined;
  const remotes: Array<["origin" | "upstream", string | undefined]> = [
    ["origin", folder.origin],
    ["upstream", folder.upstream],
  ];
  for (const [via, remote] of remotes) {
    if (!remote) continue;
    for (const rule of ws.remotes) {
      if (!globMatch(rule, remote)) continue;
      const cand: MatchCandidate = {
        workstream: ws.id,
        rule,
        kind: "remote",
        via,
        claim: via === "upstream" ? "suggest" : ws.claim,
        score: [1, literalSegments(rule), literalLength(rule), via === "origin" ? 1 : 0],
      };
      if (!best || compareScore(cand.score, best.score) > 0) best = cand;
    }
  }
  return best;
}

export function compareScore(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Match a folder against every workstream. Abstract (base) workstreams never match. */
export function matchFolder(workstreams: readonly MatchableWorkstream[], folder: FolderFacts): MatchResult {
  const candidates: MatchCandidate[] = [];
  for (const ws of workstreams) {
    if (ws.abstract) continue;
    const p = bestPathMatch(ws, folder);
    const r = bestRemoteMatch(ws, folder);
    const pick = p && r ? (compareScore(p.score, r.score) >= 0 ? p : r) : (p ?? r);
    if (pick) candidates.push(pick);
  }
  candidates.sort((a, b) => compareScore(b.score, a.score) || a.workstream.localeCompare(b.workstream));
  if (candidates.length === 0) return { candidates };
  const top = candidates.filter((c) => compareScore(c.score, candidates[0].score) === 0);
  if (top.length > 1) return { candidates, ambiguous: top.map((c) => c.workstream) };
  return { candidates, best: candidates[0] };
}

// ── Remotes ─────────────────────────────────────────────────────────────────

/**
 * Normalise a git remote URL to `host/owner/repo` (lowercase host, no `.git`,
 * no user, no port). `aliases` maps an ssh `Host` alias to its `HostName`, so
 * `git@github-work:acme/x.git` reads as `github.com/acme/x` when
 * `~/.ssh/config` says `Host github-work` → `HostName github.com`.
 * Returns undefined for a local path or anything unparseable.
 */
export function normalizeRemote(url: string, aliases: ReadonlyMap<string, string> = new Map()): string | undefined {
  const raw = url.trim();
  if (raw.length === 0 || raw.length > 2048) return undefined;
  let host: string | undefined;
  let path: string | undefined;
  const scheme = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i.exec(raw);
  if (scheme) {
    const proto = scheme[1].toLowerCase();
    if (proto === "file") return undefined;
    const rest = scheme[2];
    const slash = rest.indexOf("/");
    if (slash <= 0) return undefined;
    const authority = rest.slice(0, slash);
    path = rest.slice(slash + 1);
    host = authority.slice(authority.lastIndexOf("@") + 1).replace(/:\d+$/, "");
    if (host.startsWith("[")) return undefined; // IPv6 literal: not a rule anyone writes
  } else {
    // scp-like: [user@]host:path — but not a Windows/local path.
    const scp = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(raw);
    if (!scp) return undefined;
    host = scp[1];
    path = scp[2];
  }
  if (!host || !path) return undefined;
  host = host.toLowerCase();
  host = aliases.get(host) ?? host;
  const cleanPath = path
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "");
  if (cleanPath.length === 0 || cleanPath.split("/").some((s) => s === ".." || s === "")) return undefined;
  return `${host}/${cleanPath}`;
}

/**
 * The plain `Host alias` → `HostName real` pairs of an ssh config. Wildcard
 * hosts, `Match` blocks and `Include` are ignored: a rule only needs the
 * aliases people make for a second account.
 */
export function parseSshAliases(text: string): Map<string, string> {
  const out = new Map<string, string>();
  let current: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.replace(/#.*$/, "").trim();
    if (t.length === 0) continue;
    const m = /^(\S+)\s*(?:=\s*|\s+)(.+)$/.exec(t);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === "host") {
      current = value.split(/\s+/).filter((h) => !/[*?!]/.test(h)).map((h) => h.toLowerCase());
    } else if (key === "match") {
      current = [];
    } else if (key === "hostname") {
      for (const alias of current) if (!out.has(alias)) out.set(alias, value.toLowerCase());
    }
  }
  return out;
}

/** `~` → home, for a path rule. */
export function expandHome(rule: string, home: string): string {
  if (rule === "~") return home;
  if (rule.startsWith("~/")) return `${home.replace(/\/+$/, "")}/${rule.slice(2)}`;
  return rule;
}

/**
 * The literal head of a path glob: the folders before the first segment with
 * a glob character. `~/Workspace/acme-*` → `~/Workspace`. Used to find
 * symlink aliases (folder.ts).
 */
export function literalHead(glob: string): string {
  const segs = glob.split("/");
  const out: string[] = [];
  for (const s of segs) {
    if (GLOB_CHARS.test(s)) break;
    out.push(s);
  }
  const head = out.join("/");
  return head.length === 0 ? "/" : head;
}

/** The pattern up to (not including) its first `**` segment: what a bounded scan may expand. */
export function scanHead(glob: string): string {
  const segs = glob.split("/");
  const i = segs.indexOf("**");
  return i < 0 ? glob : segs.slice(0, i).join("/") || "/";
}
