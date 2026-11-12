/**
 * Codex under workstream isolation (docs/workstreams-design.md §6.1, G1).
 *
 * Codex loads MCP servers of its own besides the ones codeoid passes with
 * `-c mcp_servers.*`: from its user config (`$CODEX_HOME/config.toml`), from
 * a project's `.codex/config.toml`, and its apps (ChatGPT connectors). A `-c
 * mcp_servers={}` override does not clear them (measured: codex 0.166 merges
 * the override into the table), but `-c mcp_servers.<name>.enabled=false`
 * turns one off. So every server any of those files declares, that codeoid
 * didn't add, is turned off by name, and apps and plugins with them.
 *
 * Each one also gets a placeholder transport of its own kind (a dead loopback
 * URL, a no-op command): a project file codex doesn't trust isn't loaded, and
 * an override naming only `enabled` would then be a server with no transport,
 * which codex refuses to start with (measured). The placeholder keeps the
 * entry valid either way — and no server's real URL ever reaches argv.
 *
 * Fails closed: a declared name that can't be written as a config key, or a
 * config file that can't be read, refuses the start — a server codeoid can't
 * name is a server it can't keep out.
 */

import { closeSync, constants as fsc, fstatSync, openSync, readSync } from "node:fs";
import { dirname, join } from "node:path";
import { codexKeySafe } from "./shell-env.js";

const MAX_CONFIG_BYTES = 1_000_000;
const MAX_WALK = 64;

export class CodexIsolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexIsolationError";
  }
}

/**
 * A small regular file's text, never blocking; undefined if absent. A final
 * link is followed only where the owner put one (`followLink`: codex's own
 * home, where account overlays and dotfile managers link config.toml), never
 * in the workdir walk.
 */
function readConfig(path: string, followLink = false): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, fsc.O_RDONLY | fsc.O_NONBLOCK | (followLink ? 0 : fsc.O_NOFOLLOW));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT" || (e as NodeJS.ErrnoException).code === "ENOTDIR") return undefined;
    throw new CodexIsolationError(`codex config ${path} can't be read (${(e as NodeJS.ErrnoException).code}): refusing to start without knowing its MCP servers`);
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > MAX_CONFIG_BYTES) throw new CodexIsolationError(`codex config ${path} isn't a small regular file: refusing to start without knowing its MCP servers`);
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = readSync(fd, buf, off, st.size - off, off);
      if (n <= 0) break;
      off += n;
    }
    return buf.subarray(0, off).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/** Every server of every `mcp_servers` table anywhere in a parsed config (profiles included), by transport kind. */
function serverNames(doc: unknown, out: Map<string, "url" | "command">, depth = 0): void {
  if (depth > 8 || typeof doc !== "object" || doc === null || Array.isArray(doc)) return;
  for (const [k, v] of Object.entries(doc as Record<string, unknown>)) {
    if (k === "mcp_servers" && typeof v === "object" && v !== null && !Array.isArray(v)) {
      for (const [name, entry] of Object.entries(v as Record<string, unknown>)) {
        const kind = typeof entry === "object" && entry !== null && "url" in entry ? "url" : "command";
        const seen = out.get(name);
        if (seen && seen !== kind) {
          throw new CodexIsolationError(`codex configs declare MCP server "${name}" both as a URL and as a command: refusing to start without knowing which codex runs`);
        }
        out.set(name, kind);
      }
    } else serverNames(v, out, depth + 1);
  }
}

/** The config files codex may load for a session in `workdir`: system layers, its home's, a project's. */
export function codexConfigFiles(codexHome: string, workdir: string): string[] {
  const files = ["/etc/codex/config.toml", "/etc/codex/managed_config.toml", join(codexHome, "config.toml")];
  let cur = workdir;
  for (let i = 0; i < MAX_WALK; i += 1) {
    files.push(join(cur, ".codex", "config.toml"));
    const up = dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return files;
}

/**
 * The `-c` arguments that keep codex to codeoid's servers: each server its
 * own configs declare, other than `own`, turned off; apps off.
 */
export function codexIsolationArgs(codexHome: string, workdir: string, own: ReadonlySet<string>): string[] {
  const declared = new Map<string, "url" | "command">();
  const followed = new Set(["/etc/codex/config.toml", "/etc/codex/managed_config.toml", join(codexHome, "config.toml")]);
  for (const file of codexConfigFiles(codexHome, workdir)) {
    const text = readConfig(file, followed.has(file));
    if (text === undefined) continue;
    let doc: unknown;
    // Held to its table headers first: a runtime's TOML parser may take a malformed one (Bun 1.3.x reads
    // `[mcp_servers.x` as a table), where codex itself would read something else, or refuse.
    const malformed = tomlStructureProblem(text);
    try {
      if (malformed) throw new Error(malformed);
      doc = Bun.TOML.parse(text);
    } catch {
      throw new CodexIsolationError(`codex config ${file} isn't valid TOML: refusing to start without knowing its MCP servers`);
    }
    serverNames(doc, declared);
  }
  const args: string[] = [];
  for (const [name, kind] of [...declared].sort(([a], [b]) => a.localeCompare(b))) {
    if (own.has(name)) {
      // codex MERGES codeoid's `-c mcp_servers.<name>.*` into a same-named
      // entry of its own config (measured): codeoid's server would be called
      // with that entry's headers, env or bearer. Refused, not merged.
      throw new CodexIsolationError(`codex's own config also declares an MCP server named "${name}": it would lend its headers or env to codeoid's — rename one to start codex under workstream isolation`);
    }
    if (!codexKeySafe(name)) {
      throw new CodexIsolationError(`codex config declares an MCP server named ${JSON.stringify(name)}, which codeoid can't turn off by name: rename it to start codex under workstream isolation`);
    }
    args.push(
      "-c",
      kind === "url" ? `mcp_servers.${name}.url="http://127.0.0.1:9/codeoid-disabled"` : `mcp_servers.${name}.command="codeoid-disabled"`,
      "-c",
      `mcp_servers.${name}.enabled=false`,
    );
  }
  // Apps (ChatGPT connectors) and plugins bring servers of their own, which
  // can't be turned off by name (measured: a plugin server named as
  // `enabled=false` is refused as "invalid transport"): both off whole.
  args.push("-c", "features.apps=false", "-c", "features.plugins=false");
  return args;
}

/** The server names a set of `-c mcp_servers.<name>.…` arguments adds. */
export function codexMountedNames(args: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const a of args) {
    const m = /^mcp_servers\.([A-Za-z0-9_-]+)\./.exec(a);
    if (m) out.add(m[1]!);
  }
  return out;
}

const TOML_KEY = String.raw`(?:[A-Za-z0-9_-]+|"(?:[^"\\\n]|\\.)*"|'[^'\n]*')`;
const TOML_HEADER = new RegExp(String.raw`^\s*(?:\[\[\s*${TOML_KEY}(?:\s*\.\s*${TOML_KEY})*\s*\]\]|\[\s*${TOML_KEY}(?:\s*\.\s*${TOML_KEY})*\s*\])\s*(?:#.*)?$`);

/**
 * Why a TOML document's structure can't be trusted, or undefined: a table
 * header that isn't well-formed, or a string, array or inline table left
 * open at its end. Not a parser — only the shape every table header must
 * have, found as a parser would find it: a line that starts with `[` outside
 * any string and any open value (a multi-line array's `[1, 2],` is a value).
 */
export function tomlStructureProblem(text: string): string | undefined {
  let depth = 0;
  let multiline: string | null = null;
  const lines = text.split(/\r?\n/);
  for (const [n, line] of lines.entries()) {
    let i = 0;
    if (multiline) {
      const end = line.indexOf(multiline);
      if (end < 0) continue;
      i = end + 3;
      multiline = null;
    } else if (depth === 0 && line.trimStart().startsWith("[")) {
      if (!TOML_HEADER.test(line)) return `line ${n + 1}: a table header that isn't well-formed`;
      continue;
    }
    while (i < line.length) {
      const c = line[i]!;
      if (c === "#") break;
      if (line.startsWith('"""', i) || line.startsWith("'''", i)) {
        const q = line.slice(i, i + 3);
        const end = line.indexOf(q, i + 3);
        if (end < 0) {
          multiline = q;
          break;
        }
        i = end + 3;
        continue;
      }
      if (c === '"' || c === "'") {
        let j = i + 1;
        while (j < line.length && line[j] !== c) j += c === '"' && line[j] === "\\" ? 2 : 1;
        if (j >= line.length) return `line ${n + 1}: a string left open`;
        i = j + 1;
        continue;
      }
      if (c === "[" || c === "{") depth++;
      else if (c === "]" || c === "}") depth = Math.max(0, depth - 1);
      i++;
    }
  }
  if (multiline) return "a multi-line string left open";
  if (depth > 0) return "an array or inline table left open";
  return undefined;
}
