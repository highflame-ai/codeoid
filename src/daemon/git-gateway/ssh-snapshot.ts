/**
 * What the git gateway takes of the owner's ssh setup (docs/git-gateway-design.md §3.4): data, never a program. When a
 * remote is connected (the owner's act), the owner's `~/.ssh/config` is read by codeoid's own parser for that host's
 * data alone: HostName, User, Port, IdentityFile, IdentitiesOnly, CertificateFile, UserKnownHostsFile, HostKeyAlias,
 * ProxyJump. `Match` blocks, `ProxyCommand`, `LocalCommand`, `KnownHostsCommand` and the rest are never taken. Every
 * gateway ssh runs with `-F` on a file codeoid writes from that snapshot, so neither the owner's ssh config nor the
 * system's (whoever may have written either since) decides anything a run does.
 */
import { lstatSync, readdirSync, readFileSync } from "node:fs";
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
}

/** The host an ssh URL names (`git@host:path`, `ssh://user@host:port/path`), or null. */
export function sshHostOf(url: string): string | null {
  const m = /^ssh:\/\/(?:[^@/]*@)?(\[[^\]]+\]|[^/:]+)/i.exec(url) ?? /^(?:[^@/:]*@)?([^/:]+):(?!\/\/)/.exec(url);
  const host = m?.[1]?.replace(/^\[|\]$/g, "");
  return host && /^[A-Za-z0-9._-]+$/.test(host) ? host : null;
}

/** ssh's `Host` pattern list matches `host` (wildcards, negation). */
function hostMatches(patterns: readonly string[], host: string): boolean {
  let matched = false;
  for (const raw of patterns) {
    const neg = raw.startsWith("!");
    const p = neg ? raw.slice(1) : raw;
    const re = new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "i");
    if (re.test(host)) {
      if (neg) return false;
      matched = true;
    }
  }
  return matched;
}

/** A config line's keyword and arguments: `Key value`, `Key=value`, `Key = "quoted value"`. */
function parseLine(line: string): { key: string; args: string[] } | null {
  const t = line.trim();
  if (!t || t.startsWith("#")) return null;
  const m = /^([A-Za-z]+)\s*(?:=\s*|\s+)(.*)$/.exec(t);
  if (!m?.[1]) return null;
  const args: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  for (let a = re.exec(m[2] ?? ""); a; a = re.exec(m[2] ?? "")) args.push(a[1] ?? a[2] ?? "");
  return { key: m[1].toLowerCase(), args };
}

/** Expand `~` and make a path relative to `~/.ssh` absolute. */
function expand(p: string, home: string): string {
  if (p === "~" || p.startsWith("~/")) return join(home, p.slice(1));
  return isAbsolute(p) ? p : join(home, ".ssh", p);
}

/** A glob's matching paths (wildcards in any component). */
function glob(pattern: string): string[] {
  const parts = pattern.split("/").filter(Boolean);
  let paths = ["/"];
  for (const part of parts) {
    const next: string[] = [];
    const wild = /[*?[]/.test(part);
    const re = wild ? new RegExp(`^${part.replace(/[.+^${}()|\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`) : null;
    for (const at of paths) {
      if (!re) next.push(join(at, part));
      else {
        try {
          for (const n of readdirSync(at)) if (re.test(n)) next.push(join(at, n));
        } catch {
          /* nothing there */
        }
      }
    }
    paths = next;
  }
  return paths.sort();
}

/**
 * Read the owner's ssh config for `host`'s data, as ssh does (the first value of each wins; `Include` in every
 * form, with patterns), never a `Match` block's settings and never a setting that runs something.
 */
// paths: the owner's ssh config and its includes, read, nothing run
export function sshSnapshot(host: string, home: string): SshSnapshot {
  const snap: SshSnapshot = { host, identityFiles: [], certificateFiles: [], knownHostsFiles: [] };
  const seen = new Set<string>();
  const read = (file: string, active: boolean, depth: number): boolean => {
    // Returns whether the block in force at the end of `file` still applies (ssh's includes inherit it).
    if (depth > 8 || seen.has(file)) return active;
    seen.add(file);
    let text = "";
    try {
      if (!lstatSync(file).isFile() && !lstatSync(file).isSymbolicLink()) return active;
      text = readFileSync(file, "utf8");
    } catch {
      return active;
    }
    let on = active;
    for (const line of text.split("\n")) {
      const l = parseLine(line);
      if (!l) continue;
      if (l.key === "host") {
        on = hostMatches(l.args, host);
        continue;
      }
      // A Match block's conditions (exec among them) aren't evaluated: its settings are never taken.
      if (l.key === "match") {
        on = false;
        continue;
      }
      if (l.key === "include") {
        for (const a of l.args) for (const f of /[*?[]/.test(a) ? glob(expand(a, home)) : [expand(a, home)]) read(f, on, depth + 1);
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
          snap.identityFiles.push(expand(v, home));
          break;
        case "certificatefile":
          snap.certificateFiles.push(expand(v, home));
          break;
        case "identitiesonly":
          snap.identitiesOnly ??= /^yes$/i.test(v);
          break;
        case "userknownhostsfile":
          if (snap.knownHostsFiles.length === 0) snap.knownHostsFiles.push(...l.args.map((a) => expand(a, home)));
          break;
        case "hostkeyalias":
          snap.hostKeyAlias ??= v;
          break;
        case "proxyjump":
          snap.proxyJump ??= v;
          break;
      }
    }
    return on;
  };
  read(join(home, ".ssh", "config"), true, 0);
  return snap;
}

const PLAIN = /^[A-Za-z0-9._@:,[\]-]+$/;

/**
 * Why a snapshot can't be used: a value that isn't plain data, or a key, certificate or known-hosts file in what a
 * sandboxed session may write (or anyone else's, or open to others). Null: it can.
 */
export function snapshotProblem(s: SshSnapshot, writable: readonly string[], home: string): string | null {
  for (const v of [s.hostName, s.user, s.port, s.hostKeyAlias, s.proxyJump]) if (v !== undefined && !PLAIN.test(v)) return `your ssh config for ${s.host} has a value codeoid doesn't take (${JSON.stringify(v.slice(0, 40))})`;
  if (s.port && !/^\d{1,5}$/.test(s.port)) return `your ssh config for ${s.host} has a port that isn't one`;
  for (const f of [...s.identityFiles, ...s.certificateFiles, ...s.knownHostsFiles]) {
    if (/[\n\r"%]/.test(f)) return `your ssh config for ${s.host} names a file codeoid doesn't take (${JSON.stringify(f.slice(0, 60))})`;
    const bad = hostPathProblem(dirname(f), writable, home, { homeAllowed: true });
    if (bad) return `your ssh config for ${s.host} names ${f}: ${bad}`;
  }
  return null;
}

/** The ssh config codeoid writes for a run: the snapshot's data for its host, nothing else (no Include, no Match). */
export function sshConfigText(s: SshSnapshot): string {
  const q = (p: string) => `"${p}"`;
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
  lines.push("Host *", "  BatchMode yes", "  ConnectTimeout 20", "  PermitLocalCommand no", "  ForwardAgent no", "  ClearAllForwardings yes");
  return `${lines.join("\n")}\n`;
}

/** What the owner is told the ssh connection will be (where it goes, as whom). */
export function sshSnapshotLine(s: SshSnapshot): string {
  return `ssh to ${s.hostName ?? s.host}${s.port ? `:${s.port}` : ""}${s.user ? ` as ${s.user}` : ""}${s.proxyJump ? ` via ${s.proxyJump}` : ""}`;
}
