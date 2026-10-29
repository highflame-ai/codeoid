/**
 * Native history for the Claude backend (#387): codeoid's canonical
 * conversation written as a Claude Code session, so a fork, rewind or backend
 * switch onto Claude resumes a real conversation — tool calls as `tool_use` /
 * `tool_result` blocks — instead of reading a transcript in its first prompt.
 *
 * Claude Code keeps each session as JSONL under
 * `<config dir>/projects/<project>/<sessionId>.jsonl`: one entry per line,
 * chained by `uuid` / `parentUuid`. The writer below produces the subset of
 * that format the CLI needs to resume, and the caller verifies the result
 * with the SDK's own reader before trusting it, so a format change in a future
 * CLI fails closed (back to the transcript) instead of corrupting a session.
 *
 * What is not carried: reasoning. Claude's thinking blocks are signed and
 * other vendors' reasoning is opaque, so neither can be replayed; the text and
 * tool calls the reasoning produced are.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { type Dirent, mkdirSync, type Stats } from "node:fs";
import { lstat, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { type CanonicalTurn, canonicalTurnChars, fitTurnsToBudget, type HistorySeedResult } from "../canonical.js";

/** One line of a Claude Code session file. */
export interface ClaudeSessionEntry {
  type: "user" | "assistant";
  uuid: string;
  parentUuid: string | null;
  sessionId: string;
  cwd: string;
  timestamp: string;
  isSidechain: false;
  userType: "external";
  message: Record<string, unknown>;
}

/** Tool names the API accepts in a `tool_use` block. */
const toolName = (name: string): string => name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 128) || "tool";

/** A `toolu_` id in the API's shape. Tool ids from other backends (`call_…`) are not reused. */
const toolUseId = (): string => `toolu_${randomBytes(12).toString("hex")}`;

/**
 * Canonical history → Claude session entries, chained, oldest first.
 *
 * - A user turn is a user message. Consecutive user turns (a turn that got
 *   no reply) are merged, since the conversation must alternate.
 * - An assistant turn is, per tool call, an assistant `tool_use` message
 *   followed by a user `tool_result` message, then an assistant message with
 *   its text. The order of text against tool calls inside one turn isn't
 *   recorded, so the text comes last — it is the turn's answer.
 * - Tool names: the backend's own name when the turn ran on Claude, else the
 *   neutral canonical name; the API accepts history naming tools that aren't
 *   defined now (verified live).
 * - Dropped turns are announced in a leading user note, and the history
 *   always ends on an assistant message so the next prompt follows a reply.
 */
export function toClaudeSessionEntries(
  history: readonly CanonicalTurn[],
  opts: { sessionId: string; cwd: string; maxChars: number; now?: Date },
): { entries: ClaudeSessionEntry[]; truncation: HistorySeedResult } {
  const { turns, truncation } = fitTurnsToBudget(history, opts.maxChars, canonicalTurnChars);
  const at = (opts.now ?? new Date()).toISOString();
  const entries: ClaudeSessionEntry[] = [];
  let parent: string | null = null;
  const push = (type: ClaudeSessionEntry["type"], message: Record<string, unknown>) => {
    const uuid = randomUUID();
    entries.push({ type, uuid, parentUuid: parent, sessionId: opts.sessionId, cwd: opts.cwd, timestamp: at, isSidechain: false, userType: "external", message });
    parent = uuid;
  };
  const assistant = (content: unknown[], model: string, stop: "end_turn" | "tool_use") =>
    push("assistant", {
      id: `msg_${randomBytes(12).toString("hex")}`,
      type: "message",
      role: "assistant",
      model,
      content,
      stop_reason: stop,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    });

  // Pending user text, so consecutive user turns merge into one message.
  let userText: string[] = [];
  if (truncation.omittedTurns > 0) {
    userText.push(`[${truncation.omittedTurns} earlier turn(s) of this conversation were left out to fit the context window.]`);
  }
  const flushUser = () => {
    if (userText.length === 0) return;
    push("user", { role: "user", content: userText.join("\n\n") });
    userText = [];
  };
  let lastWasAssistant = false;

  for (const turn of turns) {
    if (turn.role === "user") {
      userText.push(turn.content);
      lastWasAssistant = false;
      continue;
    }
    const calls = turn.toolCalls ?? [];
    if (!turn.content && calls.length === 0) continue;
    // An assistant message must follow a user message.
    if (userText.length === 0 && (entries.length === 0 || lastWasAssistant)) {
      userText.push(entries.length === 0 ? "(continuing the conversation)" : "(continue)");
    }
    flushUser();
    const own = turn.providerId === "claude";
    for (const tc of calls) {
      const id = toolUseId();
      assistant([{ type: "tool_use", id, name: toolName(own && tc.originalName ? tc.originalName : tc.name), input: tc.input }], turn.model, "tool_use");
      push("user", { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: tc.output, ...(tc.success ? {} : { is_error: true }) }] });
    }
    assistant([{ type: "text", text: turn.content || "(done)" }], turn.model, "end_turn");
    lastWasAssistant = true;
  }
  // A last user turn with no reply (an interrupted turn) still belongs to the
  // conversation; close it so the next prompt follows an assistant message.
  if (userText.length > 0) {
    flushUser();
    assistant([{ type: "text", text: "(This turn ended before a reply was recorded.)" }], "unknown", "end_turn");
  }
  return { entries, truncation };
}

/** Claude Code's config dir, as the backend subprocess will see it. */
function claudeConfigDir(env: Record<string, string | undefined> = process.env): string {
  return env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

/**
 * The project directory Claude Code files a cwd's sessions under, exactly as
 * the SDK names it: every character outside [a-zA-Z0-9] becomes "-", and a
 * name over 200 characters is cut to 200 plus "-" and a base-36 hash of the
 * path (the SDK's 32-bit string hash). Must match, or the SDK's reader can't
 * find the file and every long-path session falls back to the transcript.
 */
export function claudeProjectDirName(cwd: string): string {
  const name = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  return name.length <= 200 ? name : `${name.slice(0, 200)}-${Math.abs(stringHash(cwd)).toString(36)}`;
}

/** `h = 31·h + c`, wrapped to int32 — the SDK's hash. */
function stringHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return h;
}

/** Write a session file atomically (tmp + rename). Returns its path. */
export async function writeClaudeSession(
  entries: readonly ClaudeSessionEntry[],
  opts: { sessionId: string; cwd: string; configDir?: string },
): Promise<string> {
  const dir = join(opts.configDir ?? claudeConfigDir(), "projects", claudeProjectDirName(opts.cwd));
  // Owner-only when we create it: project dir names reveal workdir paths.
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${opts.sessionId}.jsonl`);
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    // `wx`: never through a file someone placed there.
    await writeFile(tmp, `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`, { mode: 0o600, flag: "wx" });
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
  return path;
}

/** Remove a session file written by writeClaudeSession (after a failed verification). */
export async function removeClaudeSession(path: string): Promise<void> {
  await rm(path, { force: true });
}

/** A Claude session id: what the SDK's forkSession mints. */
const SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An fs error's code, if it has one. */
const errCode = (err: unknown): unknown => (err as { code?: unknown } | null)?.code;

/**
 * Refuse a forked session id that isn't one, or that is its source's: the
 * callers below remove files under it, and must never touch the parent's.
 */
function assertForkedId(sessionId: string, sourceSessionId: string): void {
  if (!SESSION_UUID.test(sessionId)) throw new Error(`the forked session id ${JSON.stringify(sessionId.slice(0, 64))} isn't a session id`);
  if (sessionId.toLowerCase() === sourceSessionId.toLowerCase()) throw new Error("the forked session id is its source's");
}

/**
 * The project dirs a forked session may live in: the CLI's for each of
 * `cwds` (where a resume from that workdir looks), and any holding the
 * forked JSONL (the source session's project dir). A missing projects dir
 * is none; any other error is thrown.
 */
async function forkProjectDirs(sessionId: string, cwds: readonly string[], configDir: string | undefined): Promise<string[]> {
  const projects = join(configDir ?? claudeConfigDir(), "projects");
  const dirs = new Set(cwds.map((cwd) => join(projects, claudeProjectDirName(cwd))));
  let entries: Dirent[];
  try {
    entries = await readdir(projects, { withFileTypes: true });
  } catch (err) {
    if (errCode(err) === "ENOENT") return [...dirs];
    throw err;
  }
  for (const e of entries) {
    const dir = join(projects, e.name);
    if (!e.isDirectory() || dirs.has(dir)) continue;
    if (await lstatOrAbsent(join(dir, `${sessionId}.jsonl`))) dirs.add(dir);
  }
  return [...dirs];
}

/** lstat, or null when the path doesn't exist (ENOENT only: any other error is thrown). */
async function lstatOrAbsent(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch (err) {
    if (errCode(err) === "ENOENT") return null;
    throw err;
  }
}

/** A real directory (true), absent (false), or anything else, a symlink included (thrown). */
async function realDirOrAbsent(path: string): Promise<boolean> {
  const s = await lstatOrAbsent(path);
  if (!s) return false;
  if (s.isSymbolicLink()) throw new Error(`${path} is a symlink`);
  if (!s.isDirectory()) throw new Error(`${path} isn't a directory`);
  return true;
}

/**
 * Clear a just-forked session of the cloud agents it inherited (fork-isolation.ts).
 *
 * The CLI keeps a cloud agent's registration beside the session, not in its
 * JSONL: `<project>/<sessionId>/remote-agents/remote-agent-<taskId>.meta.json`
 * (taskId, the cloud session it polls, spawnedAt, …). Resuming a session it
 * reads every registration there, re-registers each cloud agent that is
 * still running and polls it, and a finished one's result goes to that
 * session's main agent as a task notification, which starts a turn. A fork
 * that held its parent's registrations would act on the parent's cloud
 * results. The SDK's forkSession writes only the JSONL today, so there is
 * nothing to clear; this keeps that true if it ever copies the sidecar.
 *
 * A registration is the parent's when its task is `isForeign`, or it was
 * spawned before `boundaryMs` (the fork's own cloud agents come after), or
 * it can't be read. Only `sessionId`'s own directories are touched, never
 * the parent's session or its cloud session: `sessionId` must be a session
 * id other than `sourceSessionId`, the session and sidecar dirs must be real
 * directories (not symlinks), and the sidecar must resolve to where it
 * should. Each candidate project dir is checked (forkProjectDirs). Only a
 * missing dir counts as empty: any other error is thrown, as is a
 * registration still there after its removal, so the caller can refuse the
 * fork. Returns the task files removed.
 */
export async function clearInheritedRemoteAgents(
  sessionId: string,
  opts: { sourceSessionId: string; cwds: readonly string[]; boundaryMs: number; isForeign: (taskId: string) => boolean; configDir?: string },
): Promise<string[]> {
  assertForkedId(sessionId, opts.sourceSessionId);
  const removed: string[] = [];
  for (const dir of await forkProjectDirs(sessionId, opts.cwds, opts.configDir)) {
    if (!(await realDirOrAbsent(join(dir, sessionId)))) continue;
    const sidecar = join(dir, sessionId, "remote-agents");
    if (!(await realDirOrAbsent(sidecar))) continue;
    const [realSidecar, realProject] = await Promise.all([realpath(sidecar), realpath(dir)]);
    if (realSidecar !== join(realProject, sessionId, "remote-agents")) throw new Error(`${sidecar} resolves to ${realSidecar}, outside the forked session`);
    const gone: string[] = [];
    for (const name of await readdir(sidecar)) {
      if (!name.endsWith(".meta.json")) continue;
      const path = join(sidecar, name);
      let inherited = true;
      try {
        const meta = JSON.parse(await readFile(path, "utf8")) as { taskId?: unknown; spawnedAt?: unknown };
        const own = typeof meta.taskId === "string" && !opts.isForeign(meta.taskId) && typeof meta.spawnedAt === "number" && meta.spawnedAt >= opts.boundaryMs;
        inherited = !own;
      } catch {
        // Unreadable: the CLI skips it today, but nothing says it's the fork's.
      }
      if (!inherited) continue;
      await rm(path, { force: true });
      gone.push(name);
    }
    if (gone.length === 0) continue;
    const left = new Set(await readdir(sidecar));
    const stuck = gone.filter((n) => left.has(n));
    if (stuck.length > 0) throw new Error(`couldn't remove ${stuck.length} inherited cloud agent registration(s) from ${sidecar}`);
    removed.push(...gone);
  }
  return removed;
}

/**
 * Remove the JSONL of a native fork that was abandoned (the caller fell back
 * to building the history), so no stray copy of the parent's conversation is
 * left to resume. Only `sessionId`'s own file, never `sourceSessionId`'s.
 * Returns the paths removed.
 */
export async function removeForkedSession(
  sessionId: string,
  opts: { sourceSessionId: string; cwds: readonly string[]; configDir?: string },
): Promise<string[]> {
  assertForkedId(sessionId, opts.sourceSessionId);
  const removed: string[] = [];
  for (const dir of await forkProjectDirs(sessionId, opts.cwds, opts.configDir)) {
    const path = join(dir, `${sessionId}.jsonl`);
    const s = await lstatOrAbsent(path);
    if (!s?.isFile()) continue;
    await rm(path, { force: true });
    removed.push(path);
  }
  return removed;
}
