/**
 * What the git gateway takes of the owner's ssh setup (docs/git-gateway-design.md §3.4): data, never a program. When a
 * remote is connected (the owner's act), the owner's `~/.ssh/config` is read by codeoid's own parser for that host's
 * data alone: HostName, User, Port, IdentityFile, IdentitiesOnly, CertificateFile, UserKnownHostsFile, HostKeyAlias,
 * ProxyJump (each jump host's own data too). Every gateway ssh runs with `-F` on a file codeoid writes from that
 * snapshot, so neither the owner's ssh config nor the system's (whoever may have written either since) decides
 * anything a run does.
 *
 * The parser follows OpenSSH's resolution (readconf.c): the first value of each setting wins; `Host` patterns match
 * case-sensitively; an `Include` in a block that doesn't apply is read with nothing in it applying; a file may be
 * included more than once; globs skip dotfiles. What it can't follow faithfully it refuses rather than guess: a
 * `Match` block reached, a `ProxyCommand` for the host, a value that isn't plain data.
 */
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { hostPathProblem } from "./hostpath.js";

export interface SshSnapshot {
  /** The host as the URL names it (what git hands ssh): the generated config's `Host`. */
  host: string;
  hostName?: string;
  user?: string;
  port?: string;
  identityFiles: string[];
  identitiesOnly?: boolean;
  certificateFiles: string[];
  knownHostsFiles: string[];
  hostKeyAlias?: string;
  proxyJump?: string;
  /** Each jump host ProxyJump names, snapshotted the same way (their own `Host` blocks in the generated config). */
  jumps?: SshSnapshot[];
  /** What the URL itself says (it beats the config, as in ssh): shown, not written. */
  urlUser?: string;
  urlPort?: string;
  /** Every file the snapshot was read from, and every dir an Include pattern looked in: judged, held read-only. */
  sources: string[];
  /** What the parser can't follow faithfully (a Match block reached, a ProxyCommand): refused. */
  unsupported?: string;
}

/** The host an ssh URL names (`git@host:path`, `ssh://user@host:port/path`), or null. */
export function sshHostOf(url: string): string | null {
  const m = /^ssh:\/\/(?:[^@/]*@)?(\[[^\]]+\]|[^/:]+)/i.exec(url) ?? /^(?:[^@/:]*@)?([^/:]+):(?!\/\/)/.exec(url);
  const host = m?.[1]?.replace(/^\[|\]$/g, "");
  return host && /^[A-Za-z0-9._-]+$/.test(host) && !host.startsWith("-") ? host : null;
}

/** The user and port an ssh URL names itself, which ssh takes over its config's. */
export function sshUrlUserPort(url: string): { user?: string; port?: string } {
  const m = /^ssh:\/\/(?:([^@/]*)@)?(?:\[[^\]]+\]|[^/:]+)(?::(\d+))?/i.exec(url) ?? /^(?:([^@/:]*)@)?[^/:]+:(?!\/\/)/.exec(url);
  return { ...(m?.[1] ? { user: m[1] } : {}), ...(m?.[2] ? { port: m[2] } : {}) };
}

/** A glob component as a regex (`*`, `?`, `[...]`), or null when it isn't a valid one (ssh then matches nothing). */
function patternRe(p: string, flags = ""): RegExp | null {
  let out = "";
  for (let i = 0; i < p.length; i++) {
    const c = p[i] as string;
    if (c === "*") out += ".*";
    else if (c === "?") out += ".";
    else if (c === "[") {
      const end = p.indexOf("]", i + 2);
      if (end < 0) return null;
      const body = p.slice(i + 1, end).replace(/\\/g, "\\\\");
      out += `[${body.startsWith("!") ? `^${body.slice(1)}` : body}]`;
      i = end;
    } else out += c.replace(/[.+^${}()|[\]\\/-]/g, "\\$&");
  }
  try {
    return new RegExp(`^${out}$`, flags);
  } catch {
    return null;
  }
}

/** ssh's `Host` pattern list matches `host` (wildcards, negation; case-sensitive, as `match_pattern` is). */
function hostMatches(patterns: readonly string[], host: string): boolean {
  let matched = false;
  for (const raw of patterns) {
    const neg = raw.startsWith("!");
    const p = neg ? raw.slice(1) : raw;
    // match_pattern knows only `*` and `?`: everything else is itself.
    const re = new RegExp(`^${p.replace(/[.+^${}()|[\]\\/-]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
    if (re.test(host)) {
      if (neg) return false;
      matched = true;
    }
  }
  return matched;
}

/** A config line's keyword and arguments as ssh splits them (`argv_split`): `"…"` and `'…'` quotes, `\` escapes. */
function parseLine(line: string): { key: string; args: string[] } | null {
  const t = line.trim();
  if (!t || t.startsWith("#")) return null;
  const m = /^([A-Za-z]+)(?:\s*=\s*|\s+)(.*)$/.exec(t);
  if (!m?.[1]) return null;
  const args: string[] = [];
  const rest = m[2] ?? "";
  let cur: string | null = null;
  let quote: string | null = null;
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i] as string;
    if (quote) {
      if (c === "\\" && (rest[i + 1] === quote || rest[i + 1] === "\\")) cur += rest[++i] as string;
      else if (c === quote) quote = null;
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      cur ??= "";
    } else if (c === "\\" && i + 1 < rest.length) cur = (cur ?? "") + (rest[++i] as string);
    else if (/\s/.test(c)) {
      if (cur !== null) args.push(cur);
      cur = null;
    } else if (c === "#" && cur === null) break;
    else cur = (cur ?? "") + c;
  }
  if (cur !== null) args.push(cur);
  return { key: m[1].toLowerCase(), args };
}

/** `~` expanded (the snapshot judges and writes the path ssh would use). */
function tilde(p: string, home: string): string {
  return p === "~" || p.startsWith("~/") ? join(home, p.slice(1)) : p;
}

/** A glob's matching paths (wildcards in any component; dotfiles only when the component starts with `.`), and every dir it looked in. */
function glob(pattern: string): { paths: string[]; dirs: string[] } {
  const parts = pattern.split("/").filter(Boolean);
  let paths = ["/"];
  const dirs: string[] = [];
  for (const part of parts) {
    const next: string[] = [];
    const re = /[*?[]/.test(part) ? patternRe(part) : null;
    for (const at of paths) {
      if (!/[*?[]/.test(part)) next.push(join(at, part));
      else {
        dirs.push(at);
        if (!re) continue;
        try {
          for (const n of readdirSync(at)) if ((part.startsWith(".") || !n.startsWith(".")) && re.test(n)) next.push(join(at, n));
        } catch {
          /* nothing there */
        }
      }
    }
    paths = next;
  }
  return { paths: paths.sort(), dirs };
}

/** ssh's maximum Include depth (READCONF_MAX_DEPTH). */
const MAX_DEPTH = 16;

/**
 * Read the owner's ssh config for `host`'s data as ssh does, never a setting that runs something. `sources` lists
 * every file read (as named and resolved) and every dir a pattern looked in.
 */
// paths: the owner's ssh config and its includes, read, nothing run
export function sshSnapshot(host: string, home: string, jumpDepth = 0): SshSnapshot {
  const snap: SshSnapshot = { host, identityFiles: [], certificateFiles: [], knownHostsFiles: [], sources: [] };
  const sources = new Set<string>();
  const source = (p: string) => {
    sources.add(p);
    try {
      sources.add(realpathSync(p));
    } catch {
      /* not there (yet): as named */
    }
  };
  let knownHostsSet = false;
  const read = (file: string, active: boolean, neverMatch: boolean, depth: number): void => {
    if (depth > MAX_DEPTH) return;
    source(file);
    let text = "";
    try {
      const st = lstatSync(file);
      if (!st.isFile() && !st.isSymbolicLink()) return;
      text = readFileSync(file, "utf8");
    } catch {
      return;
    }
    let on = active;
    for (const line of text.split("\n")) {
      const l = parseLine(line);
      if (!l) continue;
      if (l.key === "host") {
        on = !neverMatch && hostMatches(l.args, host);
        continue;
      }
      // A Match block's conditions (exec among them) aren't evaluated, so its settings can't be known: refused.
      if (l.key === "match") {
        if (!neverMatch) snap.unsupported ??= "a Match block, which codeoid doesn't evaluate";
        on = false;
        continue;
      }
      if (l.key === "include") {
        // As readconf.c: read in an inactive block with nothing in it applying (SSHCONF_NEVERMATCH).
        for (const a of l.args) {
          const named = tilde(a, home);
          const full = isAbsolute(named) ? named : join(home, ".ssh", named);
          if (/[*?[]/.test(full)) {
            const g = glob(full);
            for (const d of g.dirs) source(d);
            for (const f of g.paths) read(f, on, neverMatch || !on, depth + 1);
          } else read(full, on, neverMatch || !on, depth + 1);
        }
        continue;
      }
      if (!on) continue;
      const v = l.args[0];
      if (v === undefined) continue;
      switch (l.key) {
        case "hostname":
          snap.hostName ??= v;
          break;
        case "user":
          snap.user ??= v;
          break;
        case "port":
          snap.port ??= v;
          break;
        case "identityfile":
          snap.identityFiles.push(v.toLowerCase() === "none" ? "none" : tilde(v, home));
          break;
        case "certificatefile":
          snap.certificateFiles.push(tilde(v, home));
          break;
        case "identitiesonly":
          snap.identitiesOnly ??= /^yes$/i.test(v);
          break;
        case "userknownhostsfile":
          if (!knownHostsSet) {
            knownHostsSet = true;
            snap.knownHostsFiles.push(...l.args.map((a) => (a.toLowerCase() === "none" ? "none" : tilde(a, home))));
          }
          break;
        case "hostkeyalias":
          snap.hostKeyAlias ??= v;
          break;
        case "proxyjump":
          snap.proxyJump ??= v;
          break;
        case "proxycommand":
          if (snap.proxyJump === undefined && v.toLowerCase() !== "none") snap.unsupported ??= "a ProxyCommand, which codeoid doesn't run";
          snap.proxyJump ??= "none";
          break;
      }
    }
  };
  read(join(home, ".ssh", "config"), true, false, 0);
  if (snap.proxyJump === "none") delete snap.proxyJump;
  // ssh's -J children read only the generated file too: each jump host's own data, as its own Host block.
  if (snap.proxyJump) {
    if (jumpDepth >= 3) snap.unsupported ??= "a ProxyJump chain deeper than codeoid follows";
    else
      for (const hop of snap.proxyJump.split(",")) {
        const name = /^(?:[^@]*@)?(\[[^\]]+\]|[^:]+)/.exec(hop)?.[1] ?? "";
        if (!/^[A-Za-z0-9._-]+$/.test(name) || name.startsWith("-")) {
          snap.unsupported ??= `a ProxyJump host codeoid doesn't take (${JSON.stringify(hop.slice(0, 40))})`;
          continue;
        }
        if (name === host) continue;
        const j = sshSnapshot(name, home, jumpDepth + 1);
        for (const s of j.sources) sources.add(s);
        if (j.unsupported) snap.unsupported ??= `jump host ${name}: ${j.unsupported}`;
        snap.jumps = [...(snap.jumps ?? []), { ...j, sources: [] }];
      }
  }
  snap.sources = [...sources];
  return snap;
}

/** The files and dirs the owner's ssh config is read from (what a sandbox holds read-only, gateway or not). */
export function sshConfigSources(home: string): string[] {
  return [join(home, ".ssh"), ...sshSnapshot("\0", home).sources];
}

const PLAIN = /^[A-Za-z0-9._@:,[\]-]+$/;

/**
 * Why a snapshot can't be used: what the parser can't follow, a value that isn't plain data, a file it was read from
 * in what a sandboxed session may write, or a key, certificate or known-hosts file there (or anyone else's). Null: it can.
 */
export function snapshotProblem(s: SshSnapshot, writable: readonly string[], home: string): string | null {
  if (s.unsupported) return `your ssh config for ${s.host} has ${s.unsupported}: codeoid can't take its settings as ssh would`;
  for (const v of [s.hostName, s.user, s.port, s.hostKeyAlias, s.proxyJump]) if (v !== undefined && !PLAIN.test(v)) return `your ssh config for ${s.host} has a value codeoid doesn't take (${JSON.stringify(v.slice(0, 40))})`;
  if (s.port && !/^\d{1,5}$/.test(s.port)) return `your ssh config for ${s.host} has a port that isn't one`;
  for (const f of [...s.identityFiles, ...s.certificateFiles, ...s.knownHostsFiles]) {
    if (f === "none") continue;
    if (/[\n\r"'%$\\]/.test(f) || !isAbsolute(f)) return `your ssh config for ${s.host} names a file codeoid doesn't take (${JSON.stringify(f.slice(0, 60))}): give it as an absolute path or ~/…, with no tokens or variables`;
    const bad = hostPathProblem(dirname(f), writable, home, { homeAllowed: true });
    if (bad) return `your ssh config for ${s.host} names ${f}: ${bad}`;
  }
  for (const f of s.sources) {
    const bad = hostPathProblem(f, writable, home, { homeAllowed: true });
    if (bad) return `your ssh config for ${s.host} is read from ${f}: ${bad}`;
  }
  for (const j of s.jumps ?? []) {
    const bad = snapshotProblem({ ...j, sources: [] }, writable, home);
    if (bad) return bad;
  }
  return null;
}

/** One snapshot's Host block. */
function block(s: SshSnapshot): string[] {
  const q = (p: string) => (p === "none" ? "none" : `"${p}"`);
  const lines = [`Host ${s.host}`];
  if (s.hostName) lines.push(`  HostName ${s.hostName}`);
  if (s.user) lines.push(`  User ${s.user}`);
  if (s.port) lines.push(`  Port ${s.port}`);
  for (const f of s.identityFiles) lines.push(`  IdentityFile ${q(f)}`);
  for (const f of s.certificateFiles) lines.push(`  CertificateFile ${q(f)}`);
  if (s.identitiesOnly) lines.push("  IdentitiesOnly yes");
  if (s.knownHostsFiles.length > 0) lines.push(`  UserKnownHostsFile ${s.knownHostsFiles.map(q).join(" ")}`);
  if (s.hostKeyAlias) lines.push(`  HostKeyAlias ${s.hostKeyAlias}`);
  if (s.proxyJump) lines.push(`  ProxyJump ${s.proxyJump}`);
  return lines;
}

/** The ssh config codeoid writes for a run: the snapshot's data for its host and jump hosts, nothing else (no Include, no Match). */
export function sshConfigText(s: SshSnapshot): string {
  const lines = block(s);
  const seen = new Set([s.host]);
  const walk = (j: SshSnapshot) => {
    if (seen.has(j.host)) return;
    seen.add(j.host);
    lines.push(...block(j));
    for (const k of j.jumps ?? []) walk(k);
  };
  for (const j of s.jumps ?? []) walk(j);
  lines.push("Host *", "  BatchMode yes", "  ConnectTimeout 20", "  PermitLocalCommand no", "  ForwardAgent no", "  ClearAllForwardings yes", "  ProxyCommand none");
  return `${lines.join("\n")}\n`;
}

/** What the owner is told the ssh connection will be (where it goes, as whom, with which key). */
export function sshSnapshotLine(s: SshSnapshot): string {
  const user = s.urlUser ?? s.user;
  const port = s.urlPort ?? s.port;
  const keys = s.identityFiles.length > 0 ? `, key ${s.identityFiles.join(", ")}` : ", your agent's or default keys";
  return `ssh to ${s.hostName ?? s.host}${port ? `:${port}` : ""}${user ? ` as ${user}` : ""}${s.proxyJump ? ` via ${s.proxyJump}` : ""}${keys}`;
}
