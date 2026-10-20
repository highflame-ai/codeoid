/**
 * A workdir's own Claude MCP servers, in full (#395): what a session's view
 * adds to the daemon-wide registry so they reach every backend in that
 * workdir, not just Claude.
 *
 * Read from where Claude Code keeps them:
 *  - the user's own `~/.claude.json` → `projects[<workdir>].mcpServers`
 *    (`claude mcp add`'s default, local scope) — the user's choice;
 *  - the workdir's `.mcp.json` — the repo's choice, carrying Claude's own
 *    approval of it (`enabledMcpjsonServers` / `disabledMcpjsonServers` /
 *    `enableAllProjectMcpServers`), read ONLY from the user's own
 *    `~/.claude.json` project entry. Never from a file in the workdir:
 *    anything there — a committed `.claude/settings.local.json`, one behind a
 *    symlink or a submodule, one the agent or a build script wrote — could be
 *    the repo approving its own servers.
 *
 * (Claude Code takes no `mcpServers` from its settings files, so neither does
 * this.) Unlike the drawer's reader (claude-config.ts), values are kept —
 * env, headers — since a backend dials these; nothing here leaves the daemon.
 */

import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { RawMcpServerConfig } from "../../config.js";
import { mapEntry } from "./import-claude.js";

/** A repo's file read at most this big (as in claude-config.ts). */
const MAX_REPO_FILE_BYTES = 1_000_000;
/** The user's own `~/.claude.json`, which also holds Claude Code's history. */
const MAX_CLAUDE_JSON_BYTES = 64_000_000;

/** A workdir server's name: plain ASCII, no `__` and no `mcp__` start — so its
 *  tools' names (`mcp__<name>__<tool>`) can't pass for another server's. */
const WORKDIR_SERVER_NAME = /^(?!mcp__)(?!.*__)[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

/** Daemon env a repo's server may not ask for by `${VAR}` reference: codeoid's
 *  own secrets (the same prefixes kept from every agent subprocess). */
const DAEMON_SECRET_VAR = /\$\{(CODEOID_|ZEROID_|TELEGRAM_)[A-Za-z0-9_]*\}/gi;

export interface WorkdirServer {
  name: string;
  raw: RawMcpServerConfig;
  origin: "claude-local" | "claude-repo";
  /** The file it was read from. */
  path: string;
  /** For a repo server: Claude's own approval of it. A local one is the user's own. */
  claudeApproval: "approved" | "denied" | "unset";
  /** Fingerprint of its config: an edit is a new entry (and needs consent again). */
  fingerprint: string;
}

/** A workdir's servers as read now. */
export interface WorkdirRead {
  servers: WorkdirServer[];
  /** The project's .mcp.json is there but couldn't be read (mid-edit, not
   *  JSON, too big): its servers aren't in `servers` — what was known of them
   *  stands, and nothing can be said about which names it declares. */
  repoUnreadable: boolean;
  /** Claude Code's approval of a project server by name, as `~/.claude.json` says now. */
  claudeApprovalOf(name: string): WorkdirServer["claudeApproval"];
}

/** The user's home as the rest of the daemon reads it (claude-config.ts):
 *  `os.homedir()` caches at process start, so HOME is read first. */
function homedir(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? os.homedir();
}

/**
 * Every server the workdir adds, before consent or precedence is applied —
 * or null when `~/.claude.json` is there but can't be read now (mid-rewrite
 * by Claude Code, too big): that's no news, not "everything was removed". A
 * project .mcp.json that can't be read leaves the user's own servers read,
 * and says so (`repoUnreadable`).
 */
export async function readWorkdirServers(workdir: string, home: string = homedir()): Promise<WorkdirRead | null> {
  const claudeJsonPath = path.join(home, ".claude.json");
  const read = await readClaudeJson(claudeJsonPath);
  if (read === UNREADABLE) return null;
  const claudeJson = asObject(read);
  const project = asObject(asObject(claudeJson?.projects)?.[workdir]);
  const mcpJsonPath = path.join(workdir, ".mcp.json");
  const repoRead = await readInside(workdir, mcpJsonPath);
  const mcpJson = repoRead === UNREADABLE ? null : asObject(repoRead);

  const enabled = new Set(strings(project?.enabledMcpjsonServers));
  const disabled = new Set(strings(project?.disabledMcpjsonServers));
  const enableAll = project?.enableAllProjectMcpServers === true;
  const approval = (name: string): WorkdirServer["claudeApproval"] =>
    disabled.has(name) ? "denied" : enabled.has(name) || enableAll ? "approved" : "unset";

  const out: WorkdirServer[] = [];
  const add = (block: unknown, origin: WorkdirServer["origin"], file: string) => {
    for (const [name, def] of Object.entries(asObject(block) ?? {})) {
      if (!WORKDIR_SERVER_NAME.test(name)) continue;
      const mapped = mapEntry(def);
      if (!mapped) continue;
      const raw = origin === "claude-repo" ? withoutDaemonSecrets(mapped) : mapped;
      out.push({
        name,
        raw,
        origin,
        path: file,
        claudeApproval: origin === "claude-local" ? "approved" : approval(name),
        fingerprint: fingerprintOf(raw),
      });
    }
  };
  add(project?.mcpServers, "claude-local", claudeJsonPath);
  add(mcpJson?.mcpServers, "claude-repo", mcpJsonPath);
  return { servers: out, repoUnreadable: repoRead === UNREADABLE, claudeApprovalOf: approval };
}

/** The user's global servers from `~/.claude.json` (cached by size and mtime),
 *  as the boot import maps them — or null when the file is there but can't be read now. */
export async function readGlobalServers(home: string = homedir()): Promise<Record<string, RawMcpServerConfig> | null> {
  const read = await readClaudeJson(path.join(home, ".claude.json"));
  if (read === UNREADABLE) return null;
  const block = asObject(asObject(read)?.mcpServers);
  const out: Record<string, RawMcpServerConfig> = {};
  for (const [name, def] of Object.entries(block ?? {})) {
    if (name.startsWith("_")) continue;
    const raw = mapEntry(def);
    if (raw) out[name] = raw;
  }
  return out;
}

/** A stable fingerprint of what a server dials: command, args, env, URL, headers. */
export function fingerprintOf(raw: RawMcpServerConfig): string {
  const sorted = (o: Record<string, string> | undefined) => Object.fromEntries(Object.entries(o ?? {}).sort(([a], [b]) => a.localeCompare(b)));
  const canon = JSON.stringify({
    command: raw.command ?? null,
    args: raw.args ?? [],
    env: sorted(raw.env),
    url: raw.url ?? null,
    headers: sorted(raw.headers),
  });
  return createHash("sha256").update(canon).digest("hex").slice(0, 32);
}

/** `~/.claude.json` exists but couldn't be read (as opposed to absent: no servers). */
const UNREADABLE = Symbol("unreadable");

/** A repo's server can't ask, by reference, for the daemon's own secrets —
 *  nor build one by nesting (`${CODEO${CODEOID_X}ID_API_KEY}`): stripped until none is left. */
function withoutDaemonSecrets(raw: RawMcpServerConfig): RawMcpServerConfig {
  const stripAll = (value: string): string => {
    let v = value;
    for (let prev = ""; prev !== v; ) [prev, v] = [v, v.replace(DAEMON_SECRET_VAR, "")];
    return v;
  };
  const strip = (o: Record<string, string> | undefined) => o && Object.fromEntries(Object.entries(o).map(([k, v]) => [k, stripAll(v)]));
  return { ...raw, ...(raw.env ? { env: strip(raw.env)! } : {}), ...(raw.headers ? { headers: strip(raw.headers)! } : {}) };
}

/** `~/.claude.json`, parsed once per change of its size or modification time
 *  (it can be tens of MB, and the drawer asks often). */
let claudeJsonCache: { file: string; mtimeMs: number; size: number; value: unknown } | null = null;

async function readClaudeJson(file: string): Promise<unknown> {
  let s: Awaited<ReturnType<typeof stat>>;
  try {
    s = await stat(file);
  } catch {
    return null; // absent: no servers
  }
  try {
    if (!s.isFile() || s.size > MAX_CLAUDE_JSON_BYTES) return UNREADABLE;
    if (claudeJsonCache && claudeJsonCache.file === file && claudeJsonCache.mtimeMs === s.mtimeMs && claudeJsonCache.size === s.size) {
      return claudeJsonCache.value;
    }
    const value = await readBounded(file, MAX_CLAUDE_JSON_BYTES);
    if (value === null) return UNREADABLE; // a partial write, or not JSON
    claudeJsonCache = { file, mtimeMs: s.mtimeMs, size: s.size, value };
    return value;
  } catch {
    return UNREADABLE;
  }
}

/** A file in the workdir, only if it resolves inside it (no symlink out of it):
 *  null when there's none, UNREADABLE when it's there but can't be read now. */
async function readInside(workdir: string, file: string): Promise<unknown> {
  let real: string;
  let root: string;
  try {
    [root, real] = await Promise.all([realpath(workdir), realpath(file)]);
  } catch {
    return null; // absent (or a dangling link): no servers
  }
  if (real !== root && !real.startsWith(root + path.sep)) return null;
  try {
    const value = await readBounded(real, MAX_REPO_FILE_BYTES);
    return value === null ? UNREADABLE : value;
  } catch {
    return UNREADABLE;
  }
}

/** Read and parse at most `max` bytes, measured on the open file (it can't grow past the check). */
async function readBounded(file: string, max: number): Promise<unknown> {
  const fh = await open(file, "r");
  try {
    const s = await fh.stat();
    if (!s.isFile() || s.size > max) return null;
    const buf = Buffer.alloc(s.size);
    const { bytesRead } = await fh.read(buf, 0, s.size, 0);
    return JSON.parse(buf.subarray(0, bytesRead).toString("utf8"));
  } catch {
    return null;
  } finally {
    await fh.close();
  }
}

function asObject(x: unknown): Record<string, unknown> | null {
  return x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : null;
}

function strings(x: unknown): string[] {
  return Array.isArray(x) ? x.filter((v): v is string => typeof v === "string") : [];
}

/**
 * The project files each backend reads MCP servers from itself, beside
 * codeoid's mount: a tool from a server declared there may be the repo's,
 * whatever codeoid's entry of a like name is trusted with. Claude Code merges
 * `.mcp.json` from the workdir and every directory above it (but `/`);
 * Qwen reads the workdir's `.mcp.json` and `.qwen/settings.json`; the Gemini
 * CLI its `.gemini/settings.json`. Codex can take servers from a project's
 * `.codex/config.toml` (TOML, not read here): one anywhere up the tree means
 * nothing can be ruled out.
 */
function projectMcpFiles(workdir: string, backendId: string): { json: string[]; opaque: string[] } {
  // From where the CLI runs: its cwd is the physical directory.
  let start = path.resolve(workdir);
  try {
    start = realpathSync(start);
  } catch {}
  const up: string[] = [];
  for (let d = start; d !== path.dirname(d); d = path.dirname(d)) up.push(d);
  switch (backendId) {
    case "claude":
      return { json: up.map((d) => path.join(d, ".mcp.json")), opaque: [] };
    case "qwen":
      return { json: [path.join(workdir, ".mcp.json"), path.join(workdir, ".qwen", "settings.json")], opaque: [] };
    case "gemini-cli":
      return { json: [path.join(workdir, ".gemini", "settings.json")], opaque: [] };
    case "codex": {
      // The user's own Codex config (CODEX_HOME, ~/.codex) isn't a project's.
      const own = path.join(process.env.CODEX_HOME || path.join(homedir(), ".codex"), "config.toml");
      return { json: [], opaque: up.map((d) => path.join(d, ".codex", "config.toml")).filter((f) => f !== own) };
    }
    default:
      return { json: [], opaque: [] };
  }
}

/** A file changed this recently isn't trusted to its cache: file times are coarse. */
const RACY_MS = 2000;

/** By the file's identity and change time too: an agent can set mtime back, not ctime. */
const declaredCache = new Map<string, { stamp: string; names: ReadonlySet<string> | null }>();

/**
 * The server names `backendId`'s own project files for `workdir` declare, as
 * they are now (cached per file by identity, size and times) — or null when
 * one is there but can't be read, so nothing can be ruled out.
 */
export function projectDeclaredNames(workdir: string, backendId: string): ReadonlySet<string> | null {
  const { json, opaque } = projectMcpFiles(workdir, backendId);
  for (const file of opaque) {
    try {
      statSync(file);
      return null; // there, and not read here
    } catch {}
  }
  const out = new Set<string>();
  for (const file of json) {
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(file);
    } catch {
      continue; // absent
    }
    const stamp = `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
    const hit = declaredCache.get(file);
    let names: ReadonlySet<string> | null;
    if (hit && hit.stamp === stamp) {
      names = hit.names;
    } else {
      names = null;
      try {
        if (st.isFile() && st.size <= MAX_REPO_FILE_BYTES) {
          // The CLIs' settings files allow comments (JSONC).
          const text = readFileSync(file, "utf8");
          names = new Set(Object.keys(asObject(asObject(JSON.parse(withoutJsonComments(text)))?.mcpServers) ?? {}));
        }
      } catch {}
      // A file changed within the clock's grain could change again with the
      // same times (as git treats a "racy" entry): what was read of it then isn't kept.
      if (Date.now() - Math.max(st.mtimeMs, st.ctimeMs) > RACY_MS) declaredCache.set(file, { stamp, names });
      else declaredCache.delete(file);
    }
    if (!names) return null;
    for (const n of names) out.add(n);
  }
  return out;
}

/** JSON with `//` and `/* *\/` comments made plain JSON; strings left alone. Trailing
 *  commas aren't JSON to the CLIs either: such a file fails to parse (nothing ruled out). */
function withoutJsonComments(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 1;
    } else {
      out += c;
    }
  }
  return out;
}
