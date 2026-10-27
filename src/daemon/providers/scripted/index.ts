/**
 * ScriptedProvider — a backend that replays a written conversation, for the
 * end-to-end suite (#429). It drives the REAL session machinery: its tool
 * calls go through the session's approval gate (so approvals, the autonomous
 * budget and audit are real), an allowed `Write` really writes into the
 * workdir (so checkpoints, fork and rewind have something to restore), and its
 * text, usage and errors take the same paths a model's would.
 *
 * Registered only when `CODEOID_E2E_SCRIPT` names a script file — never in a
 * normal install. The script is read on every turn, so a test can rewrite it
 * between steps.
 *
 * Script (JSON):
 *
 *   { "rules": [ { "match": "<regex on the user message>", "steps": [ ... ] } ] }
 *
 * The first rule whose `match` finds the user message runs; with none, the
 * turn replies `scripted: <message>`. Steps, in order:
 *
 *   { "text": "..." }                       streamed word by word; `{{message}}` is the user message
 *   { "thinking": "..." }
 *   { "tool": "Write", "input": { "file_path": "a.txt", "content": "..." } }
 *   { "tool": "<any>", "input": { ... }, "output": "..." }   gated, never executed
 *   { "sleep": 500 }                        milliseconds; an interrupt cuts it short
 *   { "error": "..." }                      the turn fails with this message
 *   { "usage": { "inputTokens": 1, "outputTokens": 1, "costUsd": 0.01 } }
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { AsyncQueue } from "../../async-queue.js";
import type { AgentProvider, ModelInfo, NormalizedTurnResult, ProviderEvent, TurnOpts, TurnRun } from "../interface.js";

export const SCRIPTED_PROVIDER_ID = "scripted";
export const SCRIPTED_MODEL = "scripted-model";
/** The variable that names the script and, by being set, registers the backend. */
export const SCRIPTED_ENV = "CODEOID_E2E_SCRIPT";

export type ScriptStep =
  | { text: string }
  | { thinking: string }
  | { tool: string; input?: Record<string, unknown>; output?: string }
  | { sleep: number }
  | { error: string }
  | { usage: { inputTokens?: number; outputTokens?: number; costUsd?: number } };

export interface ScriptRule {
  match: string;
  steps: ScriptStep[];
}

export interface Script {
  rules: ScriptRule[];
}

/** Read and check a script file. Throws with the file and what's wrong. */
export function loadScript(path: string): Script {
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  const rules = (raw as { rules?: unknown })?.rules;
  if (!Array.isArray(rules)) throw new Error(`${path}: expected { "rules": [...] }`);
  for (const [i, rule] of rules.entries()) {
    const r = rule as Partial<ScriptRule>;
    if (typeof r.match !== "string" || !Array.isArray(r.steps)) throw new Error(`${path}: rule ${i} needs "match" (string) and "steps" (array)`);
    new RegExp(r.match); // throws on a bad pattern
  }
  return { rules: rules as ScriptRule[] };
}

/** The steps for `message`: the first matching rule's, else an echo. */
export function stepsFor(script: Script, message: string): ScriptStep[] {
  const rule = script.rules.find((r) => new RegExp(r.match).test(message));
  return rule ? rule.steps : [{ text: "scripted: {{message}}" }];
}

export class ScriptedProvider implements AgentProvider {
  readonly id = SCRIPTED_PROVIDER_ID;
  readonly displayName = "Scripted (end-to-end tests)";
  readonly #scriptPath: string;

  constructor(scriptPath: string) {
    this.#scriptPath = scriptPath;
  }

  async listModels(): Promise<ModelInfo[]> {
    return [{ id: SCRIPTED_MODEL, displayName: "Scripted model", isDefault: true }];
  }

  async dispose(): Promise<void> {}

  runTurn(opts: TurnOpts): TurnRun {
    const queue = new AsyncQueue<ProviderEvent>();
    const abort = new AbortController();
    void this.#play(opts, queue, abort.signal).finally(() => queue.close());
    return {
      events: queue,
      interrupt: async () => {
        abort.abort();
        queue.close();
      },
    };
  }

  async #play(opts: TurnOpts, queue: AsyncQueue<ProviderEvent>, signal: AbortSignal): Promise<void> {
    const started = Date.now();
    const result: NormalizedTurnResult = {
      providerId: this.id,
      model: SCRIPTED_MODEL,
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalCostUsd: 0,
      durationMs: 0,
    };
    const emit = (e: ProviderEvent): boolean => {
      if (signal.aborted) return false;
      try {
        queue.push(e);
        return true;
      } catch {
        return false; // closed by an interrupt
      }
    };
    // Let the session start reading before the first event.
    await Promise.resolve();

    let steps: ScriptStep[];
    try {
      steps = stepsFor(loadScript(this.#scriptPath), opts.userMessage);
    } catch (err) {
      const message = `scripted backend: ${err instanceof Error ? err.message : String(err)}`;
      emit({ type: "error", message });
      emit({ type: "turn_done", result: { ...result, isError: true, errorMessage: message, durationMs: Date.now() - started } });
      return;
    }

    for (const step of steps) {
      if (signal.aborted) return;
      if ("text" in step) {
        const text = step.text.replaceAll("{{message}}", opts.userMessage);
        for (const word of text.split(/(?<=\s)/)) emit({ type: "text_delta", content: word });
        emit({ type: "text_done", content: text });
      } else if ("thinking" in step) {
        emit({ type: "thinking_delta", content: step.thinking, blockIndex: 0 });
        emit({ type: "thinking_done", blockIndex: 0 });
      } else if ("tool" in step) {
        await this.#tool(step, opts, emit);
      } else if ("sleep" in step) {
        await sleep(step.sleep, signal);
      } else if ("error" in step) {
        emit({ type: "error", message: step.error });
        emit({ type: "turn_done", result: { ...result, isError: true, errorMessage: step.error, durationMs: Date.now() - started } });
        return;
      } else if ("usage" in step) {
        result.inputTokens = step.usage.inputTokens ?? result.inputTokens;
        result.outputTokens = step.usage.outputTokens ?? result.outputTokens;
        result.totalCostUsd = step.usage.costUsd ?? result.totalCostUsd;
      }
    }
    emit({ type: "turn_done", result: { ...result, durationMs: Date.now() - started } });
  }

  /** One tool call: announced, put to the session's gate, run only if allowed. */
  async #tool(step: { tool: string; input?: Record<string, unknown>; output?: string }, opts: TurnOpts, emit: (e: ProviderEvent) => boolean): Promise<void> {
    const toolId = randomUUID();
    const input = step.input ?? {};
    if (!emit({ type: "tool_start", toolId, sdkToolUseId: toolId, name: step.tool, input, approvalId: `scripted-${toolId}` })) return;
    // Let the session register the call before the gate is asked about it.
    await new Promise<void>((r) => setTimeout(r, 0));
    let verdict: Awaited<ReturnType<TurnOpts["canUseTool"]>>;
    try {
      verdict = await opts.canUseTool(toolId, `scripted-${toolId}`, step.tool, input);
    } catch (err) {
      emit({ type: "tool_complete", sdkToolUseId: toolId, output: `gate failed: ${err instanceof Error ? err.message : String(err)}`, success: false });
      return;
    }
    if (verdict.behavior === "deny") {
      emit({ type: "tool_complete", sdkToolUseId: toolId, output: verdict.message ?? "denied", success: false });
      return;
    }
    const ran = verdict.updatedInput ?? input;
    try {
      const output = step.tool === "Write" ? writeInWorkdir(opts.workdir, ran) : (step.output ?? "ok");
      emit({ type: "tool_complete", sdkToolUseId: toolId, output, success: true });
    } catch (err) {
      emit({ type: "tool_complete", sdkToolUseId: toolId, output: err instanceof Error ? err.message : String(err), success: false });
    }
  }
}

/** The scripted `Write`: a file under the workdir, never outside it. */
function writeInWorkdir(workdir: string, input: Record<string, unknown>): string {
  const path = input.file_path;
  const content = input.content;
  if (typeof path !== "string" || typeof content !== "string") throw new Error("Write needs file_path and content");
  const target = resolve(workdir, path);
  const rel = relative(resolve(workdir), target);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) throw new Error(`refusing to write outside the workdir: ${path}`);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
  return `wrote ${rel}`;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((done) => {
    if (signal.aborted) return done();
    const timer = setTimeout(done, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        done();
      },
      { once: true },
    );
  });
}
