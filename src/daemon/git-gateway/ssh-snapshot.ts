/**
 * What the git gateway takes of the owner's ssh setup (docs/git-gateway-design.md §3.4): data, never a program. When a
 * remote is connected (the owner's act), OpenSSH itself resolves the owner's `~/.ssh/config` for that host
 * (`ssh -G -F <it>`: the settings printed, nothing connected, the system's config left out), after codeoid's own
 * scan of every file that config can read has found no `Match` block (whose `exec` `-G` would run) and nothing a
 * session may write. The data taken (where, as whom, which keys, agent and known hosts, jump hosts the same way) is
 * stored with the connection, and every gateway ssh runs with `-F` on a file codeoid writes from it, so neither the
 * owner's ssh config nor the system's (whoever may have written either since) decides anything a run does.
 *
 * Resolution is OpenSSH's own, so codeoid's reading never has to agree with it on what applies. The scan only has to
 * find every file and every `Match`, and it over-approximates: every `Include` in any block, any spelling of the
 * keyword, refused when it can't tell.
 */
import { spawn } from "node:child_process";
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readdirSync, readSync, realpathSync } from "node:fs";
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
  /** `IdentityAgent`: a socket path, `SSH_AUTH_SOCK` or `none`; absent: ssh's default (the environment's agent). */
  identityAgent?: string;
  certificateFiles: string[];
  knownHostsFiles: string[];
  globalKnownHostsFiles?: string[];
  hostKeyAlias?: string;
  proxyJump?: string;
  /** Each jump host ProxyJump names, resolved the same way (their own `Host` blocks in the generated config). */
  jumps?: SshSnapshot[];
  /** Every file the owner's ssh config can read, and every dir an Include pattern looks in: judged, held read-only. */
  sources: string[];
  /** What codeoid doesn't take (a ProxyCommand, a KnownHostsCommand, hostname canonicalization): refused. */
  unsupported?: string;
}

/** The host an ssh URL names (`git@host:path`, `ssh://user@host:port/path`), or null. */
export function sshHostOf(url: string): string | null {
  const m = /^ssh:\/\/(?:[^@/]*@)?(\[[^\]]+\]|[^/:]+)/i.exec(url) ?? /^(?:[^@/:]*@)?([^/:]+):(?!\/\/)/.exec(url);
  const host = m?.[1]?.replace(/^\[|\]$/g, "");
  return host && /^[A-Za-z0-9._-]+$/.test(host) && !host.startsWith("-") ? host : null;
}

/** The user and port an ssh URL names itself (git hands them to ssh, which takes them over its config's). */
export function sshUrlUserPort(url: string): { user?: string; port?: string } {
  const m = /^ssh:\/\/(?:([^@/]*)@)?(?:\[[^\]]+\]|[^/:]+)(?::(\d+))?/i.exec(url) ?? /^(?:([^@/:]*)@)?[^/:]+:(?!\/\/)/.exec(url);
  return { ...(m?.[1] ? { user: m[1] } : {}), ...(m?.[2] ? { port: m[2] } : {}) };
}

/** A glob component as a regex (`*`, `?`, `[...]`), or null when codeoid can't tell what it matches. */
function patternRe(p: string): RegExp | null {
  let out = "";
  for (let i = 0; i < p.length; i++) {
    const c = p[i] as string;
    if (c === "*") out += ".*";
    else if (c === "?") out += ".";
    else if (c === "[") {
      const end = p.indexOf("]", i + 2);
      if (end < 0) return null;
      const body = p.slice(i + 1, end);
      if (/[\\[]/.test(body)) return null;
      out += `[${body.startsWith("!") ? `^${body.slice(1).replace(/\^/g, "\\^")}` : body.replace(/\^/g, "\\^")}]`;
      i = end;
    } else out += c.replace(/[.+^${}()|[\]\\/-]/g, "\\$&");
  }
  try {
    return new RegExp(`^${out}$`);
  } catch {
    return null;
  }
}

/** A glob's matches (dotfiles too: over, never under) and every dir it looks in; null when it can't be told. */
function glob(pattern: string): { paths: string[]; dirs: string[] } | null {
  let paths = ["/"];
  const dirs: string[] = [];
  for (const part of pattern.split("/").filter(Boolean)) {
    if (!/[*?[]/.test(part)) {
      paths = paths.map((at) => join(at, part));
      continue;
    }
    const re = patternRe(part);
    if (!re) return null;
    const next: string[] = [];
    for (const at of paths) {
      dirs.push(at);
      try {
        for (const n of readdirSync(at)) if (re.test(n)) next.push(join(at, n));
      } catch {
        /* nothing there */
      }
    }
    paths = next;
  }
  return { paths: paths.sort(), dirs };
}

/** A regular file's text, read without blocking (a FIFO or device is never read); null if not one. */
// paths: the owner's ssh config files, opened non-blocking, read only when regular
function readRegular(file: string): string | null {
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > 1 << 20) return null;
    const buf = Buffer.alloc(st.size);
    let at = 0;
    while (at < st.size) {
      const n = readSync(fd, buf, at, st.size - at, at);
      if (n <= 0) break;
      at += n;
    }
    return buf.subarray(0, at).toString("utf8");
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** ssh's maximum Include depth (READCONF_MAX_DEPTH); and a bound on files read. */
const MAX_DEPTH = 16;
const MAX_FILES = 256;

/**
 * Every file the owner's ssh config (`<home>/.ssh/config`) can read, as named and resolved, and every dir a pattern
 * looks in, following every `Include` in any block; and why it can't be used, if it can't: a `Match` block in any
 * file (in any spelling: quoted, `=`, any case), an Include whose target codeoid can't tell, or something there that
 * isn't a plain file.
 */
// paths: the owner's ssh config and what it includes, read (regular files only), nothing run
export function scanSshConfig(home: string): { sources: string[]; problem?: string } {
  const sources = new Set<string>();
  let problem: string | undefined;
  let files = 0;
  const source = (p: string) => {
    sources.add(p);
    try {
      sources.add(realpathSync(p));
    } catch {
      /* not there (yet): as named */
    }
  };
  const read = (file: string, depth: number): void => {
    source(file);
    if (depth > MAX_DEPTH || ++files > MAX_FILES) {
      problem ??= "more includes than codeoid follows";
      return;
    }
    const text = readRegular(file);
    if (text === null) {
      // Something there that isn't a regular file (a FIFO, a dir): what ssh makes of it can't be told.
      try {
        lstatSync(file);
        if (!lstatSync(realpathSync(file)).isFile()) problem ??= `${file}, which isn't a plain file`;
      } catch {
        /* missing: judged as named (a session mustn't be able to create it) */
      }
      return;
    }
    for (const raw of text.split(/\r?\n/)) {
      // The keyword, however it is spelled: quotes, `=`, backslashes and case don't hide it.
      const bare = raw.replace(/^[\s"'=\\]+/, "").toLowerCase();
      if (/^["'\\]*m["'\\]*a["'\\]*t["'\\]*c["'\\]*h/.test(bare)) {
        problem ??= "a Match block, which codeoid doesn't evaluate";
        continue;
      }
      if (!/^["'\\]*i["'\\]*n["'\\]*c["'\\]*l["'\\]*u["'\\]*d["'\\]*e/.test(bare)) continue;
      const rest = raw.replace(/^[\s"'=\\]*include["'\\]*/i, "").replace(/^[\s=]+/, "");
      if (/[%$`\\]/.test(rest) || (rest.match(/"/g)?.length ?? 0) % 2 || (rest.match(/'/g)?.length ?? 0) % 2) {
        problem ??= `an Include codeoid can't follow (${JSON.stringify(rest.slice(0, 60))})`;
        continue;
      }
      const args: string[] = [];
      for (const m of rest.matchAll(/"([^"]*)"|'([^']*)'|([^\s"']+)/g)) {
        const a = m[1] ?? m[2] ?? m[3] ?? "";
        if (m[3]?.startsWith("#")) break;
        args.push(a);
      }
      for (const a of args) {
        const named = a === "~" || a.startsWith("~/") ? join(home, a.slice(1)) : a;
        const full = isAbsolute(named) ? named : join(home, ".ssh", named);
        if (/[*?[]/.test(full)) {
          const g = glob(full);
          if (!g) {
            problem ??= `an Include pattern codeoid can't follow (${JSON.stringify(a.slice(0, 60))})`;
            continue;
          }
          for (const d of g.dirs) source(d);
          for (const f of g.paths) read(f, depth + 1);
        } else read(full, depth + 1);
      }
    }
  };
  source(join(home, ".ssh"));
  read(join(home, ".ssh", "config"), 0);
  return { sources: [...sources], ...(problem ? { problem } : {}) };
}

/** The files and dirs the owner's ssh config is read from (what a sandbox holds read-only, gateway or not). */
export function sshConfigSources(home: string): string[] {
  return scanSshConfig(home).sources;
}

/** `ssh -G` for one destination: OpenSSH's own resolution of the given config, as key → values. */
// paths: the system ssh (judged by the caller) with -G: prints its settings, connects nowhere; the scan refused any Match first
function sshG(ssh: string, config: string, home: string, dest: { host: string; user?: string; port?: string }): Promise<Map<string, string[]> | { error: string }> {
  const args = ["-G", "-F", config, ...(dest.port ? ["-p", dest.port] : []), ...(dest.user ? ["-l", dest.user] : []), "--", dest.host];
  return new Promise((done) => {
    const p = spawn(ssh, args, { cwd: "/", env: { PATH: "/usr/bin:/bin", HOME: home, LANG: "C" }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout.on("data", (d: Buffer) => {
      if (out.length < 1 << 20) out += d.toString("utf8");
    });
    p.stderr.on("data", (d: Buffer) => {
      if (err.length < 4096) err += d.toString("utf8");
    });
    const timer = setTimeout(() => p.kill("SIGKILL"), 10_000);
    p.on("error", (e) => {
      clearTimeout(timer);
      done({ error: e.message });
    });
    p.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return done({ error: `ssh couldn't read your ssh config: ${err.trim().split("\n").pop() || `exit ${code}`}` });
      const map = new Map<string, string[]>();
      for (const line of out.split("\n")) {
        const sp = line.indexOf(" ");
        if (sp <= 0) continue;
        const k = line.slice(0, sp).toLowerCase();
        map.set(k, [...(map.get(k) ?? []), line.slice(sp + 1)]);
      }
      done(map);
    });
  });
}

/**
 * The owner's ssh settings for `url`, as OpenSSH resolves them now, or why they can't be taken: the scan's problem,
 * a source in what a session may write, or ssh's own failure. What codeoid doesn't take is in `unsupported`
 * (snapshotProblem refuses it).
 */
export async function resolveSshSnapshot(url: string, o: { ssh: string; home: string; writable: readonly string[] }): Promise<SshSnapshot | { error: string }> {
  const host = sshHostOf(url);
  if (!host) return { error: `${url} names no host codeoid can reach by ssh` };
  const scan = scanSshConfig(o.home);
  if (scan.problem) return { error: `your ssh config has ${scan.problem}: codeoid can't take its settings as ssh would` };
  for (const f of scan.sources) {
    const bad = hostPathProblem(f, o.writable, o.home, { homeAllowed: true });
    if (bad) return { error: `your ssh config is read from ${f}: ${bad}` };
  }
  const config = existsSync(join(o.home, ".ssh", "config")) ? join(o.home, ".ssh", "config") : "/dev/null";
  const one = async (dest: { host: string; user?: string; port?: string }, depth: number): Promise<SshSnapshot | { error: string }> => {
    const g = await sshG(o.ssh, config, o.home, dest);
    if ("error" in g) return g;
    const v = (k: string) => g.get(k)?.[0];
    const all = (k: string) => (g.get(k) ?? []).flatMap((x) => x.split(" ")).filter(Boolean);
    const path = (p: string) => (p === "~" || p.startsWith("~/") ? join(o.home, p.slice(1)) : p);
    const snap: SshSnapshot = {
      host: dest.host,
      identityFiles: (g.get("identityfile") ?? []).map(path),
      certificateFiles: (g.get("certificatefile") ?? []).map(path),
      knownHostsFiles: all("userknownhostsfile").map(path),
      sources: [],
    };
    const hostName = v("hostname");
    if (hostName) snap.hostName = hostName;
    const user = v("user");
    if (user) snap.user = user;
    const port = v("port");
    if (port) snap.port = port;
    const only = v("identitiesonly");
    if (only) snap.identitiesOnly = only === "yes";
    const agent = v("identityagent");
    if (agent) snap.identityAgent = agent === "SSH_AUTH_SOCK" || agent === "none" ? agent : path(agent);
    const global = all("globalknownhostsfile");
    if (global.length > 0) snap.globalKnownHostsFiles = global;
    const alias = v("hostkeyalias");
    if (alias) snap.hostKeyAlias = alias;
    const jump = v("proxyjump");
    if (jump && jump !== "none") snap.proxyJump = jump;
    const pc = v("proxycommand");
    if (pc && pc !== "none") snap.unsupported ??= "a ProxyCommand, which codeoid doesn't run";
    const khc = v("knownhostscommand");
    if (khc && khc !== "none") snap.unsupported ??= "a KnownHostsCommand, which codeoid doesn't run";
    const canon = v("canonicalizehostname");
    if (canon && canon !== "false" && canon !== "no") snap.unsupported ??= "CanonicalizeHostname, which codeoid doesn't follow";
    if (snap.proxyJump) {
      if (depth >= 3) snap.unsupported ??= "a ProxyJump chain deeper than codeoid follows";
      else
        for (const hop of snap.proxyJump.split(",")) {
          const m = /^(?:([A-Za-z0-9._-]+)@)?([A-Za-z0-9._-]+)(?::(\d{1,5}))?$/.exec(hop);
          if (!m?.[2] || m[2].startsWith("-")) {
            snap.unsupported ??= `a ProxyJump host codeoid doesn't take (${JSON.stringify(hop.slice(0, 40))})`;
            continue;
          }
          const j = await one({ host: m[2], ...(m[1] ? { user: m[1] } : {}), ...(m[3] ? { port: m[3] } : {}) }, depth + 1);
          if ("error" in j) return j;
          if (j.unsupported) snap.unsupported ??= `jump host ${m[2]}: ${j.unsupported}`;
          snap.jumps = [...(snap.jumps ?? []), j];
        }
    }
    return snap;
  };
  const snap = await one({ host, ...sshUrlUserPort(url) }, 0);
  if ("error" in snap) return snap;
  snap.sources = scan.sources;
  return snap;
}

const PLAIN = /^[A-Za-z0-9._@:,[\]-]+$/;

/** Why a file the run's ssh opens can't be taken: not a plain absolute path, or in what a session may write (as named or where it leads). */
function fileProblem(host: string, f: string, writable: readonly string[], home: string): string | null {
  if (/[\n\r"'%$\\]/.test(f) || !isAbsolute(f)) return `your ssh config for ${host} names a file codeoid doesn't take (${JSON.stringify(f.slice(0, 60))}): give it as an absolute path or ~/…, with no tokens or variables`;
  let real: string[] = [];
  try {
    const r = realpathSync(f);
    real = [r, dirname(r)];
  } catch {
    /* not there: its dir is judged */
  }
  for (const p of [dirname(f), ...real]) {
    const bad = hostPathProblem(p, writable, home, { homeAllowed: true });
    if (bad) return `your ssh config for ${host} names ${f}: ${bad}`;
  }
  return null;
}

/**
 * Why a snapshot can't be used: what codeoid doesn't take, a value that isn't plain data, a file the config is read
 * from, or a key, certificate, agent or known-hosts file, in what a sandboxed session may write (or anyone else's, or
 * open to others). Null: it can.
 */
export function snapshotProblem(s: SshSnapshot, writable: readonly string[], home: string): string | null {
  if (s.unsupported) return `your ssh config for ${s.host} has ${s.unsupported}: codeoid can't take its settings as ssh would`;
  for (const v of [s.hostName, s.user, s.port, s.hostKeyAlias, s.proxyJump]) if (v !== undefined && !PLAIN.test(v)) return `your ssh config for ${s.host} has a value codeoid doesn't take (${JSON.stringify(v.slice(0, 40))})`;
  if (s.port && !/^\d{1,5}$/.test(s.port)) return `your ssh config for ${s.host} has a port that isn't one`;
  const agent = s.identityAgent && s.identityAgent !== "SSH_AUTH_SOCK" && s.identityAgent !== "none" ? [s.identityAgent] : [];
  for (const f of [...s.identityFiles, ...s.certificateFiles, ...s.knownHostsFiles, ...(s.globalKnownHostsFiles ?? []), ...agent]) {
    if (f === "none") continue;
    const bad = fileProblem(s.host, f, writable, home);
    if (bad) return bad;
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
  if (s.identitiesOnly !== undefined) lines.push(`  IdentitiesOnly ${s.identitiesOnly ? "yes" : "no"}`);
  if (s.identityAgent) lines.push(`  IdentityAgent ${s.identityAgent === "SSH_AUTH_SOCK" || s.identityAgent === "none" ? s.identityAgent : q(s.identityAgent)}`);
  if (s.knownHostsFiles.length > 0) lines.push(`  UserKnownHostsFile ${s.knownHostsFiles.map(q).join(" ")}`);
  if (s.globalKnownHostsFiles?.length) lines.push(`  GlobalKnownHostsFile ${s.globalKnownHostsFiles.map(q).join(" ")}`);
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
  lines.push("Host *", "  BatchMode yes", "  ConnectTimeout 20", "  PermitLocalCommand no", "  ForwardAgent no", "  ClearAllForwardings yes", "  ProxyCommand none", "  ControlMaster no", "  ControlPath none");
  return `${lines.join("\n")}\n`;
}

/** What the owner is told the ssh connection will be (where it goes, as whom, with which key). */
export function sshSnapshotLine(s: SshSnapshot): string {
  const present = s.identityFiles.filter((f) => f !== "none" && existsSync(f));
  const keys = s.identitiesOnly ? `, key ${present.join(", ") || "none found"}` : present.length > 0 ? `, your agent's keys or ${present.join(", ")}` : ", your agent's keys";
  return `ssh to ${s.hostName ?? s.host}${s.port && s.port !== "22" ? `:${s.port}` : ""}${s.user ? ` as ${s.user}` : ""}${s.proxyJump ? ` via ${s.proxyJump}` : ""}${keys}`;
}
