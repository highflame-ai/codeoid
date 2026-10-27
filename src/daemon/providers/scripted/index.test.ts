import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

  it("never writes through a symlink that leads out of the workdir", async () => {
    mkdirSync(join(tmp, "outside"));
    symlinkSync(join(tmp, "outside"), join(work, "link"));
    symlinkSync(join(tmp, "outside", "f.txt"), join(work, "f.txt"));
    script([
      { match: "^dir", steps: [{ tool: "Write", input: { file_path: "link/pwned.txt", content: "x" } }] },
      { match: "^file", steps: [{ tool: "Write", input: { file_path: "f.txt", content: "x" } }] },
    ]);
    for (const m of ["dir", "file"]) {
      const events = await turn(m);
      expect(events.find((e) => e.type === "tool_complete")).toMatchObject({ success: false });
    }
    expect(existsSync(join(tmp, "outside", "pwned.txt"))).toBe(false);
    expect(existsSync(join(tmp, "outside", "f.txt"))).toBe(false);
  });

  it("never writes through a hardlink to a file outside the workdir", async () => {
    mkdirSync(join(tmp, "outside"));
    writeFileSync(join(tmp, "outside", "victim"), "keep");
    linkSync(join(tmp, "outside", "victim"), join(work, "hl"));
    script([{ match: ".", steps: [{ tool: "Write", input: { file_path: "hl", content: "pwned" } }] }]);
    const events = await turn("x");
    expect(events.find((e) => e.type === "tool_complete")).toMatchObject({ success: false });
    expect(readFileSync(join(tmp, "outside", "victim"), "utf8")).toBe("keep");
  });

  it("takes an absolute path through a symlink to the workdir — the daemon hands over the real path", async () => {
    symlinkSync(work, join(tmp, "worklink"));
    script([{ match: ".", steps: [{ tool: "Write", input: { file_path: join(tmp, "worklink", "abs.txt"), content: "ok" } }] }]);
    const events = await turn("x"); // runs in the real workdir
    expect(events.find((e) => e.type === "tool_complete")).toMatchObject({ success: true });
    expect(readFileSync(join(work, "abs.txt"), "utf8")).toBe("ok");
  });

  it("never writes to a FIFO (it would block the daemon) or anything but a regular file", async () => {
    expect(Bun.spawnSync(["mkfifo", join(work, "pipe")]).exitCode).toBe(0);
    script([{ match: ".", steps: [{ tool: "Write", input: { file_path: "pipe", content: "x" } }] }]);
    const events = await turn("x");
    expect(events.find((e) => e.type === "tool_complete")).toMatchObject({ success: false });
    // With something reading it the open succeeds: still refused, as not a regular file.
    const reader = Bun.spawn(["cat", join(work, "pipe")], { stdout: "pipe" });
    await Bun.sleep(100);
    const read = await turn("x");
    expect(read.find((e) => e.type === "tool_complete")).toMatchObject({ success: false });
    reader.kill();
  });

  it("takes a workdir handed over through a symlink, too", async () => {
    symlinkSync(work, join(tmp, "worklink"));
    script([{ match: ".", steps: [{ tool: "Write", input: { file_path: "via-link.txt", content: "ok" } }] }]);
    const run = new ScriptedProvider(scriptPath).runTurn({ history: [], userMessage: "x", workdir: join(tmp, "worklink"), canUseTool: async () => ({ behavior: "allow" }) } as unknown as TurnOpts);
    const events: ProviderEvent[] = [];
    for await (const e of run.events) events.push(e);
    expect(events.find((e) => e.type === "tool_complete")).toMatchObject({ success: true });
    expect(readFileSync(join(work, "via-link.txt"), "utf8")).toBe("ok");
  });

  it("streams a long text step whole, past the queue's bound", async () => {
    const long = Array.from({ length: 3000 }, (_, i) => `w${i}`).join(" ");
    script([{ match: ".", steps: [{ text: long }, { text: "after" }] }]);
    const events = await turn("x");
    expect(events.filter((e) => e.type === "text_done").map((e) => (e as { content: string }).content)).toEqual([long, "after"]);
    expect(events.at(-1)?.type).toBe("turn_done");
  });

  it("a reader that falls too far behind fails the turn loudly instead of losing its end", async () => {
    const long = Array.from({ length: 3000 }, (_, i) => `w${i}`).join(" ");
    script([{ match: ".", steps: [{ text: long }] }]);
    const run = new ScriptedProvider(scriptPath).runTurn({ history: [], userMessage: "x", workdir: work, canUseTool: async () => ({ behavior: "allow" }) } as unknown as TurnOpts);
    await Bun.sleep(300); // nobody reads meanwhile
    let thrown: unknown;
    try {
      for await (const _ of run.events) {
        // drain
      }
    } catch (err) {
      thrown = err;
    }
    expect(String(thrown)).toContain("scripted backend:");
  });

  it("an overflow with steps still to come ends the turn as a failure, never as a success missing its middle", async () => {
    const long = Array.from({ length: 3000 }, (_, i) => `w${i}`).join(" ");
    script([{ match: ".", steps: [{ text: long }, { sleep: 400 }, { text: "after" }] }]);
    const run = new ScriptedProvider(scriptPath).runTurn({ history: [], userMessage: "x", workdir: work, canUseTool: async () => ({ behavior: "allow" }) } as unknown as TurnOpts);
    await Bun.sleep(200); // a reader that falls behind
    let thrown: unknown;
    let done = false;
    try {
      // Read like the session: stop at turn_done.
      for await (const e of run.events) {
        if (e.type === "turn_done") {
          done = true;
          break;
        }
      }
    } catch (err) {
      thrown = err;
    }
    expect(done).toBe(false);
    expect(String(thrown)).toContain("scripted backend:");
  });

  it("a waitFor step holds the turn until the file exists", async () => {
    const gate = join(tmp, "gate");
    script([{ match: ".", steps: [{ text: "one" }, { waitFor: gate }, { text: "two" }] }]);
    let released = false;
    setTimeout(() => {
      released = true;
      writeFileSync(gate, "");
    }, 150);
    const events = await turn("x");
    expect(released).toBe(true);
    expect(events.filter((e) => e.type === "text_done").map((e) => (e as { content: string }).content)).toEqual(["one", "two"]);
  });

  it("a crash step ends the stream with an error and no turn_done, as a backend that died", async () => {
    script([{ match: ".", steps: [{ text: "before" }, { crash: "process exited" }, { text: "never" }] }]);
    const run = new ScriptedProvider(scriptPath).runTurn({ history: [], userMessage: "x", workdir: work, canUseTool: async () => ({ behavior: "allow" }) } as unknown as TurnOpts);
    const events: ProviderEvent[] = [];
    let thrown: unknown;
    try {
      for await (const e of run.events) events.push(e);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe("process exited");
    expect(events.some((e) => e.type === "turn_done")).toBe(false);
    expect(events.some((e) => e.type === "text_done" && e.content === "never")).toBe(false);
  });

  it("an error step carries the backend's structured detail", async () => {
    script([{ match: ".", steps: [{ error: "rate limited", detail: { codexErrorInfo: "usageLimitExceeded" } }] }]);
    const events = await turn("x");
    expect(events.find((e) => e.type === "error")).toEqual({ type: "error", message: "rate limited", detail: { codexErrorInfo: "usageLimitExceeded" } });
  });

  it("echoes a message with replacement patterns in it verbatim", async () => {
    script([]);
    const events = await turn("cost is $& and $1");
    expect(events.find((e) => e.type === "text_done")).toMatchObject({ content: "scripted: cost is $& and $1" });
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
