/**
 * A workdir's own Claude MCP servers, in full (#395): what a session's view
 * adds to the daemon-wide registry so they reach every backend in that
 * workdir, not just Claude.
 *
 * Read from where Claude Code keeps them:
 *  - the user's own `~/.claude.json` → `projects[<workdir>].mcpServers`
 *    (`claude mcp add`'s default, local scope) — the user's choice;
 *  - the workdir's `.mcp.json` and `.claude/settings{,.local}.json` — the
 *    repo's choice, so each carries Claude's own approval of it
 *    (`enabledMcpjsonServers` / `disabledMcpjsonServers` /
 *    `enableAllProjectMcpServers`), read from `~/.claude.json`'s project
 *    entry and from the project's `settings.local.json` — but that one only
 *    when git says it isn't part of the repo: Claude Code writes the user's
 *    approvals there, and a repo that committed its own could otherwise
 *    approve its own servers.
 *
 * Unlike the drawer's reader (claude-config.ts), values are kept — env,
 * headers — since a backend dials these. Nothing here leaves the daemon.
 */

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { RawMcpServerConfig } from "../../config.js";
import { mapEntry } from "./import-claude.js";

/** The user's home as the rest of the daemon reads it (claude-config.ts):
 *  `os.homedir()` caches at process start, so HOME is read first. */
function homedir(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? os.homedir();
}

/** A repo's file read at most this big (as in claude-config.ts). */
const MAX_REPO_FILE_BYTES = 1_000_000;
/** The user's own `~/.claude.json`, which also holds Claude Code's history. */
const MAX_CLAUDE_JSON_BYTES = 64_000_000;

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

/** Every server the workdir adds, before consent or precedence is applied. */
export async function readWorkdirServers(workdir: string, home: string = homedir()): Promise<WorkdirServer[]> {
  const claudeJsonPath = path.join(home, ".claude.json");
  const claudeJson = asObject(await readJson(claudeJsonPath, MAX_CLAUDE_JSON_BYTES));
  const project = asObject(asObject(claudeJson?.projects)?.[workdir]);

  const settingsPaths = [path.join(workdir, ".claude", "settings.json"), path.join(workdir, ".claude", "settings.local.json")];
  const settings = await Promise.all(settingsPaths.map((p) => readJson(p, MAX_REPO_FILE_BYTES).then(asObject)));
  const mcpJsonPath = path.join(workdir, ".mcp.json");
  const mcpJson = asObject(await readJson(mcpJsonPath, MAX_REPO_FILE_BYTES));

  // Claude's approval of the repo's servers: the user's project entry, and the
  // project's local settings when they are the user's (untracked), never the
  // shared settings.json, which is the repo's own.
  const localIsUsers = settings[1] !== null && (await untrackedInGit(workdir, ".claude/settings.local.json"));
  const approvals = [project, localIsUsers ? settings[1] : null];
  const enabled = new Set(approvals.flatMap((a) => strings(a?.enabledMcpjsonServers)));
  const disabled = new Set(approvals.flatMap((a) => strings(a?.disabledMcpjsonServers)));
  const enableAll = approvals.some((a) => a?.enableAllProjectMcpServers === true);
  const approval = (name: string): WorkdirServer["claudeApproval"] =>
    disabled.has(name) ? "denied" : enabled.has(name) || enableAll ? "approved" : "unset";

  const out: WorkdirServer[] = [];
  const add = (block: unknown, origin: WorkdirServer["origin"], file: string) => {
    for (const [name, def] of Object.entries(asObject(block) ?? {})) {
      if (name.startsWith("_")) continue;
      const raw = mapEntry(def);
      if (!raw) continue;
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
  settings.forEach((s, i) => add(s?.mcpServers, "claude-repo", settingsPaths[i]!));
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

/** Whether git reports `rel` as not tracked in the repo at `workdir`. False
 *  when it can't tell (not a repo, no git): then it isn't trusted as the user's. */
async function untrackedInGit(workdir: string, rel: string): Promise<boolean> {
  try {
    const inRepo = Bun.spawn(["git", "-C", workdir, "rev-parse", "--is-inside-work-tree"], { stdout: "ignore", stderr: "ignore" });
    if ((await withTimeout(inRepo.exited, 2_000, inRepo)) !== 0) return false;
    const tracked = Bun.spawn(["git", "-C", workdir, "ls-files", "--error-unmatch", "--", rel], { stdout: "ignore", stderr: "ignore" });
    // Exactly 1 is "not tracked"; anything else (tracked, a timeout, an error) isn't trusted.
    return (await withTimeout(tracked.exited, 2_000, tracked)) === 1;
  } catch {
    return false;
  }
}

function withTimeout(p: Promise<number>, ms: number, proc: { kill(): void }): Promise<number> {
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      proc.kill();
      resolve(-1);
    }, ms);
    p.then((code) => {
      clearTimeout(t);
      resolve(code);
    });
  });
}

async function readJson(file: string, max: number): Promise<unknown> {
  try {
    const s = await stat(file);
    if (!s.isFile() || s.size > max) return null;
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

function asObject(x: unknown): Record<string, unknown> | null {
  return x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : null;
}

function strings(x: unknown): string[] {
  return Array.isArray(x) ? x.filter((v): v is string => typeof v === "string") : [];
}
