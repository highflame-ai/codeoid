import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderEvent, TurnOpts } from "../interface.js";
import { createDefaultProviderRegistry } from "../registry.js";
import { SCRIPTED_ENV, SCRIPTED_PROVIDER_ID, ScriptedProvider, loadScript, stepsFor } from "./index.js";

let tmp: string;
let work: string;
let scriptPath: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "codeoid-scripted-"));
  work = join(tmp, "work");
  mkdirSync(work);
  scriptPath = join(tmp, "script.json");
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function script(rules: unknown[]): void {
  writeFileSync(scriptPath, JSON.stringify({ rules }));
}

type Verdict = { behavior: "allow" | "deny"; message?: string; updatedInput?: Record<string, unknown> };

/** Run one turn and collect its events; `gate` answers each tool call. */
async function turn(message: string, gate: (tool: string) => Verdict = () => ({ behavior: "allow" })): Promise<ProviderEvent[]> {
  const asked: string[] = [];
  const run = new ScriptedProvider(scriptPath).runTurn({
    history: [],
    userMessage: message,
    workdir: work,
    canUseTool: async (_id, _approval, tool) => {
      asked.push(tool);
      return gate(tool);
    },
  } as TurnOpts);
  const events: ProviderEvent[] = [];
  for await (const e of run.events) events.push(e);
  return events;
}

describe("the scripted backend (#429)", () => {
  it("echoes a message no rule matches, and ends the turn", async () => {
    script([]);
    const events = await turn("hello there");
    expect(events.filter((e) => e.type === "text_done")).toEqual([{ type: "text_done", content: "scripted: hello there" }]);
    expect(events.at(-1)?.type).toBe("turn_done");
  });

  it("runs the first rule that matches, step by step", async () => {
    script([
      { match: "^nope", steps: [{ text: "wrong rule" }] },
      { match: "^go", steps: [{ text: "one" }, { thinking: "hmm" }, { text: "two {{message}}" }, { usage: { inputTokens: 7, outputTokens: 3, costUsd: 0.25 } }] },
    ]);
    const events = await turn("go now");
    expect(events.filter((e) => e.type === "text_done").map((e) => (e as { content: string }).content)).toEqual(["one", "two go now"]);
    expect(events.some((e) => e.type === "thinking_done")).toBe(true);
    const done = events.at(-1) as Extract<ProviderEvent, { type: "turn_done" }>;
    expect(done.result).toMatchObject({ providerId: SCRIPTED_PROVIDER_ID, inputTokens: 7, outputTokens: 3, totalCostUsd: 0.25 });
  });

  it("puts every tool call to the gate; an allowed Write writes, a denied one doesn't", async () => {
    script([{ match: ".", steps: [{ tool: "Write", input: { file_path: "a/b.txt", content: "hi" } }] }]);
    const allowed = await turn("write");
    expect(readFileSync(join(work, "a", "b.txt"), "utf8")).toBe("hi");
    expect(allowed.find((e) => e.type === "tool_complete")).toMatchObject({ success: true, output: "wrote a/b.txt" });

    rmSync(join(work, "a"), { recursive: true });
    const denied = await turn("write", () => ({ behavior: "deny", message: "no" }));
    expect(existsSync(join(work, "a", "b.txt"))).toBe(false);
    expect(denied.find((e) => e.type === "tool_complete")).toMatchObject({ success: false, output: "no" });
  });

  it("runs the input the gate approved, not the one it proposed", async () => {
    script([{ match: ".", steps: [{ tool: "Write", input: { file_path: "x.txt", content: "proposed" } }] }]);
    await turn("write", () => ({ behavior: "allow", updatedInput: { file_path: "x.txt", content: "approved" } }));
    expect(readFileSync(join(work, "x.txt"), "utf8")).toBe("approved");
  });

  it("never writes outside the workdir", async () => {
    script([{ match: ".", steps: [{ tool: "Write", input: { file_path: "../escape.txt", content: "x" } }] }]);
    const events = await turn("write");
    expect(existsSync(join(tmp, "escape.txt"))).toBe(false);
    expect(events.find((e) => e.type === "tool_complete")).toMatchObject({ success: false });
  });

  it("an error step fails the turn with that message", async () => {
    script([{ match: ".", steps: [{ text: "partial" }, { error: "boom" }, { text: "never" }] }]);
    const events = await turn("x");
    expect(events.find((e) => e.type === "error")).toEqual({ type: "error", message: "boom" });
    expect(events.at(-1)).toMatchObject({ type: "turn_done", result: { isError: true, errorMessage: "boom" } });
    expect(events.some((e) => e.type === "text_done" && e.content === "never")).toBe(false);
  });

  it("a bad script fails the turn and says why, instead of hanging", async () => {
    writeFileSync(scriptPath, JSON.stringify({ rules: [{ match: "(", steps: [] }] }));
    const events = await turn("x");
    expect(events.at(-1)).toMatchObject({ type: "turn_done", result: { isError: true } });
    expect(() => loadScript(scriptPath)).toThrow();
  });

  it("an interrupt cuts a sleep short and ends the turn", async () => {
    script([{ match: ".", steps: [{ sleep: 60_000 }, { text: "too late" }] }]);
    const run = new ScriptedProvider(scriptPath).runTurn({ history: [], userMessage: "x", workdir: work, canUseTool: async () => ({ behavior: "allow" }) } as unknown as TurnOpts);
    const started = Date.now();
    setTimeout(() => void run.interrupt(), 50);
    const events: ProviderEvent[] = [];
    for await (const e of run.events) events.push(e);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(events.some((e) => e.type === "text_done")).toBe(false);
  });

  it("stepsFor falls back to the echo", () => {
    expect(stepsFor({ rules: [] }, "m")).toEqual([{ text: "scripted: {{message}}" }]);
  });

  it("is registered only when a script is named — never in a normal install", () => {
    const off = createDefaultProviderRegistry(undefined, { PATH: "" });
    expect(off.has(SCRIPTED_PROVIDER_ID)).toBe(false);
    const on = createDefaultProviderRegistry(undefined, { PATH: "", [SCRIPTED_ENV]: scriptPath });
    expect(on.has(SCRIPTED_PROVIDER_ID)).toBe(true);
  });
});
