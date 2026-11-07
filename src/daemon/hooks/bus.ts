/**
 * HookBus — dispatches config-declared hooks at Session's seams.
 *
 * Built once at daemon startup (like ProviderRegistry / CompressionRegistry)
 * and shared by every session. Session consults it at well-defined points:
 * the tool approval gate (`tool_call`), tool completion (`tool_result`),
 * turn start (`before_turn`), and fire-and-forget lifecycle points.
 *
 * SECURITY: hook commands run arbitrary user-configured code by design, but
 * they run in the DAEMON's trust context — whose environment carries the
 * ZeroID root key and other codeoid secrets. Every command therefore gets
 * the hardened subprocess environment (`buildSubprocessEnv`, shared basics
 * only), never a raw `process.env` inherit. Hook-specific data travels on
 * stdin as JSON, not in env vars. The `CODEOID_AGENT_ENV_ALLOW` escape
 * hatch applies as it does for provider subprocesses.
 *
 * Error contract: dispatch methods never throw. Infra failures (spawn
 * error, timeout, bad JSON, non-2xx, network error) are logged and the
 * hook is ignored — fail-open, so a broken hook script can't brick every
 * session. Blocking is always an explicit hook decision: exit code 2 or
 * `{"decision":"block"}`.
 */

import { spawn } from "node:child_process";
import type { CodeoidConfig } from "../../config.js";
import { buildSubprocessEnv } from "../providers/env.js";
import type {
  HookEntryConfig,
  HookEvent,
  HookOutcome,
  HookSessionContext,
  ToolCallHookResult,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 10_000;
/** Hard cap on captured stdout/stderr and webhook bodies — a hook that
 *  streams gigabytes must not OOM the daemon. */
const MAX_OUTPUT_BYTES = 1024 * 1024;

interface CompiledEntry {
  config: HookEntryConfig;
  /** Compiled `matcher` (validated at config load; null = match all). */
  matcher: RegExp | null;
  name: string;
  timeoutMs: number;
}

export class HookBus {
  #byEvent = new Map<HookEvent, CompiledEntry[]>();
  /** Env base for command hooks — injectable so tests control the inherit. */
  #envBase: Record<string, string | undefined>;

  constructor(
    entries: readonly HookEntryConfig[],
    opts: { env?: Record<string, string | undefined> } = {},
  ) {
    this.#envBase = opts.env ?? process.env;
    entries.forEach((config, i) => {
      let matcher: RegExp | null = null;
      if (config.matcher !== undefined) {
        try {
          matcher = new RegExp(config.matcher);
        } catch (err) {
          // Config-schema validation rejects bad regexes at load; this
          // guards direct construction. Skip rather than match-all — a
          // typo'd matcher silently applying to every tool is worse.
          console.error(
            `[codeoid/hooks] invalid matcher ${JSON.stringify(config.matcher)} — entry skipped: ${err instanceof Error ? err.message : String(err)}`,
          );
          return;
        }
      }
      const compiled: CompiledEntry = {
        config,
        matcher,
        name: config.name ?? `${config.type}:${config.event}#${i}`,
        timeoutMs: Math.min(config.timeoutMs ?? DEFAULT_TIMEOUT_MS, 60_000),
      };
      const list = this.#byEvent.get(config.event) ?? [];
      list.push(compiled);
      this.#byEvent.set(config.event, list);
    });
  }

  /** Total configured entries (post-compilation) — for startup logging. */
  get size(): number {
    let n = 0;
    for (const list of this.#byEvent.values()) n += list.length;
    return n;
  }

  /**
   * True when at least one hook would fire for this event (and tool, for
   * tool events). Callers gate their dispatch on this so sessions with no
   * matching hooks pay zero latency on the hot paths.
   */
  hasHooks(event: HookEvent, toolName?: string): boolean {
    return this.#matching(event, toolName).length > 0;
  }

  /**
   * `tool_call` — the policy gate, run BEFORE the approval gate. Hooks run
   * in declaration order; the first block short-circuits (a policy deny
   * should not even prompt the user). `updatedInput` chains — each hook
   * sees the previous hook's mutation and full replacement wins.
   */
  async dispatchToolCall(
    ctx: HookSessionContext,
    tool: { toolName: string; toolId: string; input: Record<string, unknown> },
  ): Promise<ToolCallHookResult> {
    const result: ToolCallHookResult = { mutatedBy: [] };
    let input = tool.input;
    for (const entry of this.#matching("tool_call", tool.toolName)) {
      const outcome = await this.#run(entry, ctx, {
        event: "tool_call",
        toolName: tool.toolName,
        toolId: tool.toolId,
        input,
      });
      if (!outcome) continue;
      if (outcome.decision === "block") {
        result.blocked = {
          reason: outcome.reason ?? "blocked by hook",
          hookName: entry.name,
        };
        return result;
      }
      if (outcome.updatedInput) {
        input = outcome.updatedInput;
        result.updatedInput = input;
        result.mutatedBy.push(entry.name);
      }
    }
    return result;
  }

  /**
   * `tool_result` — observe or patch the recorded output. NOTE: the native
   * backend has already consumed the ORIGINAL output inside its own agent
   * loop by the time the daemon sees `tool_complete`; `updatedOutput`
   * affects what codeoid persists, displays, and carries in the canonical
   * history (and therefore what a switched-to backend sees) — not what the
   * current backend's model saw. Redaction of transcripts is the use case.
   */
  async dispatchToolResult(
    ctx: HookSessionContext,
    tool: { toolName: string; output: string; success: boolean },
  ): Promise<{ updatedOutput?: string }> {
    let output = tool.output;
    let patched = false;
    for (const entry of this.#matching("tool_result", tool.toolName)) {
      const outcome = await this.#run(entry, ctx, {
        event: "tool_result",
        toolName: tool.toolName,
        output,
        success: tool.success,
      });
      if (outcome?.updatedOutput !== undefined) {
        output = outcome.updatedOutput;
        patched = true;
      }
    }
    return patched ? { updatedOutput: output } : {};
  }

  /**
   * `before_turn` — fired when a fresh turn starts (not for mid-turn
   * injections into a running turn). Each hook may contribute a
   * `systemPromptAppend`; contributions concatenate in declaration order.
   */
  async dispatchBeforeTurn(
    ctx: HookSessionContext,
    turn: { prompt: string },
  ): Promise<{ systemPromptAppend?: string }> {
    const appends: string[] = [];
    for (const entry of this.#matching("before_turn")) {
      const outcome = await this.#run(entry, ctx, {
        event: "before_turn",
        prompt: turn.prompt,
      });
      if (outcome?.systemPromptAppend) appends.push(outcome.systemPromptAppend);
    }
    return appends.length > 0 ? { systemPromptAppend: appends.join("\n\n") } : {};
  }

  /**
   * Fire-and-forget dispatch for observe-only events (`after_turn` +
   * lifecycle). Outcomes are ignored; failures are logged by #run. Never
   * blocks the caller — lifecycle seams (constructor, destroy) are not
   * places to await user scripts. The returned promise settles once every
   * hook ran (never rejects), for a caller that must not cut them off: a
   * turn's end, waited for at shutdown (`Session.turnEndWork`).
   */
  emit(
    event: HookEvent,
    ctx: HookSessionContext,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const entries = this.#matching(event);
    if (entries.length === 0) return Promise.resolve();
    return (async () => {
      for (const entry of entries) {
        await this.#run(entry, ctx, { event, ...payload });
      }
    })();
  }

  #matching(event: HookEvent, toolName?: string): CompiledEntry[] {
    const list = this.#byEvent.get(event);
    if (!list) return [];
    return list.filter((e) => {
      if (!e.matcher) return true;
      // A tool-matcher entry never fires when the tool name is unknown —
      // matching a named filter against nothing would be a silent lie.
      if (toolName === undefined) return false;
      return e.matcher.test(toolName);
    });
  }

  /** Run one hook. Never throws; infra failures log and return null. */
  async #run(
    entry: CompiledEntry,
    ctx: HookSessionContext,
    payload: Record<string, unknown>,
  ): Promise<HookOutcome | null> {
    const body = JSON.stringify({ ...payload, ...ctx });
    try {
      if (entry.config.type === "command") {
        return await this.#runCommand(entry, ctx, body);
      }
      return await this.#runWebhook(entry, body);
    } catch (err) {
      console.error(
        `[codeoid/hooks] ${entry.name} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  async #runCommand(
    entry: CompiledEntry,
    ctx: HookSessionContext,
    body: string,
  ): Promise<HookOutcome | null> {
    // command is schema-required for type "command"; guard for direct construction.
    const command = entry.config.command;
    if (!command) return null;
    return await new Promise((resolve) => {
      const proc = spawn("/bin/sh", ["-c", command], {
        cwd: ctx.workdir,
        // Hardened env — shared basics only, never the daemon's secrets.
        env: buildSubprocessEnv({}, this.#envBase),
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const finish = (outcome: HookOutcome | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(outcome);
      };
      const timer = setTimeout(() => {
        console.error(
          `[codeoid/hooks] ${entry.name} timed out after ${entry.timeoutMs}ms — killed (non-blocking)`,
        );
        proc.kill("SIGKILL");
        finish(null);
      }, entry.timeoutMs);
      proc.stdout.on("data", (chunk: Buffer) => {
        if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk.toString("utf8");
      });
      proc.stderr.on("data", (chunk: Buffer) => {
        if (stderr.length < MAX_OUTPUT_BYTES) stderr += chunk.toString("utf8");
      });
      proc.on("error", (err) => {
        console.error(`[codeoid/hooks] ${entry.name} spawn failed: ${err.message}`);
        finish(null);
      });
      proc.on("close", (code) => {
        if (settled) return;
        // Exit 2 = explicit block (mirrors Claude Code's hook contract);
        // stderr carries the reason.
        if (code === 2) {
          finish({ decision: "block", reason: stderr.trim() || "blocked by hook" });
          return;
        }
        if (code !== 0) {
          console.error(
            `[codeoid/hooks] ${entry.name} exited ${code} (non-blocking)${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
          );
          finish(null);
          return;
        }
        finish(parseOutcome(entry.name, stdout));
      });
      proc.stdin.on("error", () => {
        /* hook may exit without reading stdin — EPIPE is fine */
      });
      proc.stdin.write(body);
      proc.stdin.end();
    });
  }

  async #runWebhook(entry: CompiledEntry, body: string): Promise<HookOutcome | null> {
    const url = entry.config.url;
    if (!url) return null;
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: AbortSignal.timeout(entry.timeoutMs),
      });
    } catch (err) {
      console.error(
        `[codeoid/hooks] ${entry.name} webhook failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
    if (!res.ok) {
      console.error(
        `[codeoid/hooks] ${entry.name} webhook returned ${res.status} (non-blocking)`,
      );
      return null;
    }
    // Stream the body and stop reading at the cap — `res.text()` would
    // buffer an arbitrarily large response in full BEFORE any slice,
    // letting a misbehaving webhook exhaust daemon memory.
    let text = "";
    if (res.body) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      try {
        while (text.length < MAX_OUTPUT_BYTES) {
          const { done, value } = await reader.read();
          if (done) break;
          text += decoder.decode(value, { stream: true });
        }
      } finally {
        reader.cancel().catch(() => {});
      }
      text = text.slice(0, MAX_OUTPUT_BYTES);
    }
    return parseOutcome(entry.name, text);
  }
}

/**
 * Parse a hook's JSON outcome, keeping only known, correctly-typed fields.
 * Empty / non-JSON output is a normal "no opinion" — only log when the
 * hook produced something that LOOKS like JSON but doesn't parse.
 */
function parseOutcome(name: string, raw: string): HookOutcome | null {
  const text = raw.trim();
  if (!text) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    if (text.startsWith("{")) {
      console.error(`[codeoid/hooks] ${name} produced malformed JSON — ignored`);
    }
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const o = parsed as Record<string, unknown>;
  const outcome: HookOutcome = {};
  if (o.decision === "block") outcome.decision = "block";
  if (typeof o.reason === "string") outcome.reason = o.reason;
  if (
    typeof o.updatedInput === "object" &&
    o.updatedInput !== null &&
    !Array.isArray(o.updatedInput)
  ) {
    outcome.updatedInput = o.updatedInput as Record<string, unknown>;
  }
  if (typeof o.updatedOutput === "string") outcome.updatedOutput = o.updatedOutput;
  if (typeof o.systemPromptAppend === "string") {
    outcome.systemPromptAppend = o.systemPromptAppend;
  }
  return outcome;
}

/**
 * Build the daemon's HookBus from config. Returns undefined when hooks are
 * disabled or none are configured — callers guard with `?.` so sessions
 * without hooks pay nothing.
 */
export function createHookBus(config?: CodeoidConfig): HookBus | undefined {
  const hooks = config?.hooks;
  if (!hooks || hooks.enabled === false || hooks.entries.length === 0) {
    return undefined;
  }
  return new HookBus(hooks.entries);
}
