/**
 * What the Claude CLI's own file tools keep outside a native sandbox as
 * context, never as code (#448 round 9): the gate's carve-outs from the
 * sandbox's bounds, which hold a host-side file tool in autonomous mode
 * (sandbox/host-file-tools.ts). Each location is the one the bundled CLI
 * (2.1.281) uses itself, read from its own allow rules ("auto memory files
 * are allowed for writing", "Plan files for current session …", "User
 * agents files are allowed for reading", …) and checked on the real binary:
 *
 *   - `.md` files written, the dirs read (`markdown`): its auto-memory dir,
 *     `<config>/projects/<project>/memory/`, where `<project>` is named after
 *     the repository's top (its main checkout's for a linked worktree) or,
 *     outside one, the cwd; the user-scope agent memory
 *     (`<config>/agent-memory/`); the plan files (`<config>/plans/`, its
 *     `plansDirectory` default; one set in a project's settings must be
 *     inside the project, which is writable anyway);
 *   - read and written (`writable`): this session's project temp dir under
 *     `CLAUDE_CODE_TMPDIR` (`claude-<uid>/<cwd's name>/`: each session's
 *     background shells' and agents' output, `tasks/<id>.output`, which the
 *     CLI tells the model to Read, its scratchpad); the task lists and todos
 *     (`<config>/tasks/`, `<config>/todos/`);
 *   - read only (`readable`): the user tier's `CLAUDE.md`, `agents/`,
 *     `commands/`, `rules/`, `output-styles/`; installed plugins' `skills/`
 *     and `commands/` (an `installPath` in `plugins/installed_plugins.json`
 *     under `<config>/plugins/`); the CLI's bundled skills' reference files
 *     (`claude-<uid>/bundled-skills/`).
 *
 * Never: its credentials (`.credentials.json`), its settings files (env,
 * hooks), hooks, MCP server configs, anything a plugin runs (its hooks,
 * `.mcp.json`, scripts outside `skills/` and `commands/`), the rest of its
 * temp dir (its sockets, its plugin-tool staging). A custom
 * `autoMemoryDirectory` isn't followed: outside the workspace its writes
 * stay refused in autonomous mode.
 */

import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { BackendHostFiles } from "../../sandbox/host-file-tools.js";
import { claudeProjectDirName } from "./native-history.js";

/** The user tier's dirs the CLI reads back as context. */
const USER_CONTEXT_DIRS = ["agents", "commands", "rules", "output-styles"] as const;
/** In an installed plugin: what the CLI hands the model to read (its skills' reference files, its commands). */
const PLUGIN_CONTEXT_DIRS = ["skills", "commands"] as const;

export interface ClaudeHostFilesInputs {
  /** The CLI's config dir (`CLAUDE_CONFIG_DIR`, else `~/.claude`). */
  configDir: string;
  /** `CLAUDE_CODE_TMPDIR`, when the session sets one (Claude native: claudeTemp().cli). */
  cliTempDir?: string | null;
  /** The session's cwd. */
  workdir: string;
  uid?: number;
}

/** What the CLI's file tools keep outside the sandbox, by how the gate lets them reach it. */
export function claudeHostFiles(i: ClaudeHostFilesInputs): Required<Pick<BackendHostFiles, "readable" | "writable" | "markdown">> {
  const cfg = resolve(i.configDir);
  const uid = i.uid ?? (typeof process.getuid === "function" ? process.getuid() : 0);
  const projects = memoryProjects(i.workdir);
  const readable = [join(cfg, "CLAUDE.md"), ...USER_CONTEXT_DIRS.map((d) => join(cfg, d)), ...installedPluginDirs(cfg)];
  const writable = [join(cfg, "tasks"), join(cfg, "todos")];
  if (i.cliTempDir && isAbsolute(i.cliTempDir)) {
    const temp = join(resolve(i.cliTempDir), `claude-${uid}`);
    readable.push(join(temp, "bundled-skills"));
    for (const cwd of spellings(i.workdir)) writable.push(join(temp, claudeProjectDirName(cwd)));
  }
  return {
    readable,
    writable,
    markdown: [...projects.map((p) => join(cfg, "projects", claudeProjectDirName(p), "memory")), join(cfg, "agent-memory"), join(cfg, "plans")],
  };
}

/** A path as given and physical. */
function spellings(p: string): string[] {
  const out = new Set([resolve(p)]);
  try {
    out.add(realpathSync(p));
  } catch {
    /* missing: as given */
  }
  return [...out];
}

/**
 * The dirs the CLI may name a session's auto-memory after: the repository's
 * top (and its main checkout's, for a linked worktree, which the CLI keys
 * memory by), and the cwd itself; each as given and physical. No side
 * effects.
 */
export function memoryProjects(workdir: string): string[] {
  const out = new Set<string>(spellings(workdir));
  for (const start of spellings(workdir)) for (const p of repositoryTops(start)) out.add(p);
  return [...out];
}

/** The repository `start` is in, by its top (as given and physical), and its main checkout's for a linked worktree. */
function repositoryTops(start: string): string[] {
  const out = new Set<string>();
  for (let dir = start; ; dir = dirname(dir)) {
    const dotgit = join(dir, ".git");
    let st: ReturnType<typeof lstatSync> | null = null;
    try {
      st = lstatSync(dotgit);
    } catch {
      /* none here */
    }
    if (st) {
      for (const s of spellings(dir)) out.add(s);
      // A linked worktree: `gitdir: <common>/worktrees/<name>`; its main checkout is beside `<common>`.
      if (st.isFile()) {
        try {
          const named = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotgit, "utf8"))?.[1];
          const gitDir = named ? resolve(dir, named) : null;
          if (gitDir && dirname(gitDir).endsWith(`${sep}worktrees`)) for (const s of spellings(dirname(dirname(dirname(gitDir))))) out.add(s);
        } catch {
          /* unreadable: the checkout's own name stands */
        }
      }
      break;
    }
    if (dirname(dir) === dir) break;
  }
  return [...out];
}

/** Each installed plugin's `skills/` and `commands/`, for an `installPath` under `<config>/plugins/` (V1 and V2 records). */
export function installedPluginDirs(configDir: string): string[] {
  const plugins = join(configDir, "plugins");
  let record: unknown;
  try {
    record = JSON.parse(readFileSync(join(plugins, "installed_plugins.json"), "utf8"));
  } catch {
    return [];
  }
  const entries = (record as { plugins?: unknown })?.plugins;
  if (!entries || typeof entries !== "object") return [];
  const out: string[] = [];
  for (const v of Object.values(entries as Record<string, unknown>)) {
    for (const install of Array.isArray(v) ? v : [v]) {
      const at = (install as { installPath?: unknown } | null)?.installPath;
      if (typeof at !== "string" || !isAbsolute(at)) continue;
      const rel = relative(plugins, resolve(at));
      if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) continue;
      for (const d of PLUGIN_CONTEXT_DIRS) out.push(join(resolve(at), d));
    }
  }
  return out;
}

/** What a Claude permission rule's path can't carry literally (its rules are gitignore-style patterns). */
const PATTERN_CHARS = /[*?[\]{}()\\!]/;

/**
 * The hidden paths inside what a sandboxed session's commands see (its
 * workspace, temp dir, writable dirs, the home's allowlist), as the Read
 * deny rules that leave them out of the CLI's Grep and Glob results
 * (checked on the real CLI 2.1.281: a `Read(//<path>)` and
 * `Read(//<path>/**)` deny drops a file and a dir's contents from both),
 * so a search at the workspace's top needn't be refused (#448 round 9).
 * Each as written and physical; a path a rule can't spell literally isn't
 * excluded (a search reaching it stays refused). A hidden path holding
 * something shown (the home, holding the workspace) never is: its deny
 * would take that with it.
 */
export function claudeSearchExclusions(
  spec: { workspace: string; tempDir: string; writable: readonly string[]; reexposed: readonly string[]; hidden: readonly string[] },
  tempDir: string = spec.tempDir,
): { paths: string[]; rules: string[] } {
  const shown = [spec.workspace, tempDir, ...spec.writable, ...spec.reexposed].flatMap(spellings);
  const inside = (child: string, parent: string) => {
    const rel = relative(parent, child);
    return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  };
  const paths = new Set<string>();
  for (const h of spec.hidden.flatMap(spellings)) {
    if (PATTERN_CHARS.test(h)) continue;
    if (!shown.some((s) => inside(h, s))) continue;
    if (shown.some((s) => s === h || inside(s, h))) continue;
    paths.add(h);
  }
  const list = [...paths].sort();
  return { paths: list, rules: list.flatMap((p) => [`Read(/${p})`, `Read(/${p}/**)`]) };
}
