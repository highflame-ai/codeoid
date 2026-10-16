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
import { mkdirSync } from "node:fs";
import { rename, rm, writeFile } from "node:fs/promises";
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
export function claudeConfigDir(env: Record<string, string | undefined> = process.env): string {
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
