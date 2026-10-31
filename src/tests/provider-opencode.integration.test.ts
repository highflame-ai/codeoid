/**
 * REAL `opencode serve` integration tests — opt-in.
 *
 * The offline suite (provider-opencode.test.ts) runs against fake-opencode,
 * which mirrors what real 2.2.2 and 2.2.5 servers were seen to do but can't
 * catch where a future one differs. These tests drive codeoid's real
 * OpencodeServer + OpencodeProvider against the installed binary.
 *
 * Gated: skipped unless CODEOID_OPENCODE_INTEGRATION=1 AND opencode resolves
 * (CODEOID_OPENCODE_COMMAND picks a binary). The turn tests need a model:
 *
 *   - CODEOID_OPENCODE_MODEL=scripted: a local scripted chat model
 *     (fixtures/scripted-chat-model.ts) configured into opencode. The whole
 *     real server runs — tools, permission engine, sessions, feed — with no
 *     key, no cost and no outside service. Every case runs.
 *   - CODEOID_OPENCODE_MODEL=provider/model with its credential in the env
 *     (e.g. openai/gpt-5-mini with OPENAI_API_KEY): a real model, real cost.
 *     Prompts are short; cases that depend on scripting a model exactly
 *     (marked "scripted only") are skipped.
 *
 * The database is a temp one unless CODEOID_OPENCODE_DB names one.
 *
 *   I1  the server starts: version in range, password, the agent check, the DB where codeoid put it
 *   I2  catalogs decode: models (provider/model ids, variants), agents, commands
 *   I3  a text turn: text_done, turn_done with real cost and tokens, nativeRef — promptly
 *   I4  a shell call reaches the gate as Bash with the command; `once` runs it
 *   I5  a denial is fed back and the turn still completes
 *   I6  resume by ses_ id, and a native fork at the first turn
 *   I7  a question: the gate, then a form through requestUserInput; the answer reaches the model
 *   I8  a background subagent: background work, its call gated as its own agent, opencode's follow-up adopted
 *   I9  steering a running reply: one absorbed boundary, then the steered answer
 *   I10 a model + effort switch lands on the opencode session
 *   I11 interrupt mid-reply ends the turn promptly
 *   I12 (scripted only) Code Mode is hidden: a script's fetch can't get past the gate (2.2.2 runs it unasked)
 *   I13 (scripted only) a model error opencode doesn't retry ends the turn promptly, with its status
 *   I14 (scripted only) the title opencode generates is billed, once
 *   I15 a session deleted on the server while attached: the next turn goes on in a new one, from codeoid's history
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpencodeProvider } from "../daemon/providers/opencode/index.js";
import { OpencodeServer } from "../daemon/providers/opencode/server.js";
import { resolveOpencodeCommand } from "../daemon/providers/opencode/resolve.js";
import type { ProviderEvent, ToolApprovalFn, TurnOpts, TurnRun, UiRequest } from "../daemon/providers/interface.js";
import type { Store } from "../daemon/store.js";

const resolved = resolveOpencodeCommand(process.env.CODEOID_OPENCODE_COMMAND);
const RUN = process.env.CODEOID_OPENCODE_INTEGRATION === "1" && resolved !== null;
const SCRIPTED = process.env.CODEOID_OPENCODE_MODEL === "scripted";
const MODEL = SCRIPTED ? "scripted/scripted-1" : process.env.CODEOID_OPENCODE_MODEL;
const maybe = RUN ? it : it.skip;
const maybeTurn = RUN && MODEL ? it : it.skip;
const maybeScripted = RUN && SCRIPTED ? it : it.skip;

if (!RUN) {
  console.log(
    `[opencode integration] SKIPPED — set CODEOID_OPENCODE_INTEGRATION=1 and install opencode 2.2 to run (resolved=${resolved ? resolved.command : "none"}).`,
  );
} else if (!MODEL) {
  console.log("[opencode integration] turn tests SKIPPED — set CODEOID_OPENCODE_MODEL=scripted, or provider/model (with its credential).");
}

const WORK = RUN ? mkdtempSync(join(tmpdir(), "codeoid-opencode-it-")) : "/tmp";
const DB = process.env.CODEOID_OPENCODE_DB ?? join(WORK, "data", "opencode", "opencode.db");
let server: OpencodeServer | null = null;
let scripted: ReturnType<typeof Bun.spawn> | null = null;

beforeAll(async () => {
  if (!RUN) return;
  let modelProviders: Record<string, unknown> | undefined;
  if (SCRIPTED) {
    scripted = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures", "scripted-chat-model.ts")], { stdout: "pipe", stderr: "inherit" });
    const reader = (scripted.stdout as ReadableStream<Uint8Array>).getReader();
    const { url } = JSON.parse(new TextDecoder().decode((await reader.read()).value)) as { url: string };
    reader.releaseLock();
    modelProviders = {
      scripted: {
        name: "Scripted",
        package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL: url, apiKey: "scripted" },
        models: {
          "scripted-1": {
            name: "Scripted 1",
            capabilities: { tools: true, reasoning: { supported: true, effort: ["low", "high"] } },
            cost: { input: 1, output: 2 },
            limit: { context: 64_000, output: 4_096 },
          },
        },
      },
    };
  }
  server = new OpencodeServer({ command: resolved!.command, argsPrefix: resolved!.argsPrefix, dbPath: DB, ...(modelProviders ? { modelProviders } : {}) });
});

afterAll(async () => {
  await server?.stop();
  scripted?.kill();
  if (RUN) rmSync(WORK, { recursive: true, force: true });
});

/** The prompt for this run: plain words for a real model, the script for the scripted one. */
function ask(words: string, script: string): string {
  return SCRIPTED ? script : words;
}

function provider(over: Partial<ConstructorParameters<typeof OpencodeProvider>[0]> = {}): OpencodeProvider {
  return new OpencodeProvider({
    sessionId: `it-${Math.random().toString(36).slice(2)}`,
    initialBackingId: "it",
    server: server!,
    store: { setClaudeCodeSessionId: () => {} } as unknown as Store,
    ...over,
  });
}

function opts(userMessage: string, over: Partial<TurnOpts> = {}): TurnOpts {
  return {
    history: [],
    userMessage,
    workdir: WORK,
    ...(MODEL ? { model: MODEL } : {}),
    canUseTool: async () => ({ behavior: "allow" }),
    ...over,
  };
}

async function collect(run: TurnRun, until: (e: ProviderEvent) => boolean = (e) => e.type === "turn_done" || e.type === "error"): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const e of run.events) {
    events.push(e);
    if (until(e)) break;
  }
  return events;
}

function done(events: ProviderEvent[]) {
  const d = events.filter((e) => e.type === "turn_done");
  return d.length > 0 ? (d[d.length - 1] as Extract<ProviderEvent, { type: "turn_done" }>).result : undefined;
}

/** The server's own API, as codeoid's client authenticates to it (for what codeoid never does itself). */
let serverAuth = "";
const clientFetch = globalThis.fetch;
globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const auth = (init?.headers as Record<string, string> | undefined)?.authorization;
  if (auth) serverAuth = auth;
  return clientFetch(input, init);
}) as typeof fetch;

function texts(events: ProviderEvent[]): string[] {
  return events.flatMap((e) => (e.type === "text_done" ? [e.content] : []));
}

describe("opencode (real binary)", () => {
  maybe("I1 starts a private server: version in range, password, agent check, codeoid's DB", async () => {
    const conn = await server!.ensure();
    expect(new URL(conn.client.baseUrl).hostname).toBe("127.0.0.1");
    expect((await conn.client.info()).version).toMatch(/^2\.2\./);
    const anonymous = await fetch(`${conn.client.baseUrl}/api/agent`);
    expect(anonymous.status).toBe(401);
    expect(existsSync(DB)).toBe(true);
  }, 60_000);

  maybe("I2 catalogs decode", async () => {
    const conn = await server!.ensure();
    const agents = await conn.client.agents(WORK);
    expect(agents.some((a) => a.id === "build")).toBe(true);
    expect(agents.every((a) => Array.isArray(a.permissions))).toBe(true);
    const models = await conn.client.models(WORK);
    expect(models.every((m) => typeof m.providerID === "string" && Array.isArray(m.variants))).toBe(true);
    expect(Array.isArray(await conn.client.commands(WORK))).toBe(true);
    if (SCRIPTED) {
      const p = provider();
      await collect(p.runTurn(opts("[[text:ok]]")));
      const listed = (await p.listModels()).find((m) => m.id === MODEL);
      expect(listed).toMatchObject({ contextWindow: 64_000, efforts: ["low", "high"] });
      await p.teardown();
    }
  }, 60_000);

  maybeTurn("I3 a text turn streams, ends promptly with real cost and tokens, and records where it ends", async () => {
    const p = provider();
    const started = Date.now();
    const events = await collect(p.runTurn(opts(ask("Reply with exactly the word: pong", "[[text:pong]]"))));
    const r = done(events);
    expect(events.find((e) => e.type === "error")).toBeUndefined();
    expect(events.some((e) => e.type === "text_done" && /pong/i.test(e.content))).toBe(true);
    expect(r!.inputTokens + r!.cacheReadTokens).toBeGreaterThan(0);
    expect(r!.totalCostUsd).toBeGreaterThan(0);
    expect(r!.nativeRef?.ref).toMatch(/^msg_/);
    expect(p.backingSessionId).toMatch(/^ses/);
    // No waiting on opencode's durable log (it never answers).
    if (SCRIPTED) expect(Date.now() - started).toBeLessThan(8_000);
    await p.teardown();
  }, 180_000);

  maybeTurn("I4 a shell call reaches the gate as Bash with its command, and `once` runs it", async () => {
    const asked: Array<[string, Record<string, unknown>]> = [];
    const gate: ToolApprovalFn = async (_t, _a, name, input) => {
      asked.push([name, input]);
      return { behavior: "allow" };
    };
    const p = provider();
    const events = await collect(
      p.runTurn(opts(ask("Use your shell tool to run: echo codeoid-it-ok — then say done.", '[[tool:shell {"command":"echo codeoid-it-ok","description":"Print a marker"}]]'), { canUseTool: gate })),
    );
    const shell = asked.find(([name]) => name === "Bash");
    expect(shell?.[1].command).toContain("echo codeoid-it-ok");
    const complete = events.find((e) => e.type === "tool_complete") as Extract<ProviderEvent, { type: "tool_complete" }> | undefined;
    expect(complete?.success).toBe(true);
    expect(complete?.output).toContain("codeoid-it-ok");
    expect(done(events)).toBeDefined();
    await p.teardown();
  }, 180_000);

  maybeTurn("I5 a denial reaches the model as feedback and the turn completes", async () => {
    const p = provider();
    const events = await collect(
      p.runTurn(
        opts(ask("Use your shell tool to run: echo nope — if you can't, say blocked.", '[[tool:shell {"command":"echo nope"}]]'), {
          canUseTool: async () => ({ behavior: "deny", message: "Blocked by the integration test" }),
        }),
      ),
    );
    expect(events.find((e) => e.type === "error")).toBeUndefined();
    expect(done(events)?.stopReason).toBe("stop");
    expect(events.some((e) => e.type === "tool_complete" && e.success)).toBe(false);
    if (SCRIPTED) expect(texts(events).join(" ")).toContain("Blocked by the integration test");
    await p.teardown();
  }, 180_000);

  maybeTurn("I6 resumes by id, and forks natively at a turn", async () => {
    const p = provider();
    const first = await collect(p.runTurn(opts(ask("Remember the number 41. Reply ok.", "Remember the number 41. [[text:ok]]"))));
    const ref = done(first)!.nativeRef!;
    const id = p.backingSessionId;
    await p.teardown();
    const resumed = provider({ initialBackingId: id });
    expect(done(await collect(resumed.runTurn(opts(ask("Reply ok again.", "[[text:ok again]]")))))).toBeDefined();
    expect(resumed.backingSessionId).toBe(id);
    await resumed.teardown();
    const fork = provider();
    expect(await fork.continueNatively({ history: [], forkFrom: ref, maxChars: 10_000, workdir: WORK })).toEqual({ via: "fork" });
    const answer = await collect(fork.runTurn(opts(ask("What number did I ask you to remember? Reply with just the number.", "[[recall]]"))));
    expect(answer.some((e) => e.type === "text_done" && e.content.includes("41"))).toBe(true);
    expect(fork.backingSessionId).not.toBe(id);
    await fork.teardown();
  }, 300_000);

  maybeTurn("I7 a question is gated, then asked through requestUserInput; the answer reaches the model", async () => {
    const gated: string[] = [];
    const asked: UiRequest[] = [];
    const p = provider();
    const question = { questions: [{ question: "Pick a color", header: "Color", options: [{ label: "Red", description: "warm" }, { label: "Blue", description: "cool" }] }] };
    const events = await collect(
      p.runTurn(
        opts(ask("Use your question tool to ask me to pick a color, Red or Blue, then repeat my choice.", `[[tool:question ${JSON.stringify(question)}]]`), {
          canUseTool: async (_t, _a, name) => {
            gated.push(name);
            return { behavior: "allow" };
          },
          requestUserInput: async (req) => {
            asked.push(req);
            return { cancelled: false, value: req.method === "select" ? (req.options?.find((o) => o === "Blue") ?? req.options?.[0]) : "Blue" };
          },
        }),
      ),
    );
    expect(gated).toContain("opencode_question");
    expect(asked[0]).toMatchObject({ method: "select" });
    expect(asked[0]!.options).toContain("Blue");
    expect(texts(events).join(" ")).toContain("Blue");
    await p.teardown();
  }, 180_000);

  maybeTurn("I8 a background subagent is background work, gated as its own agent; opencode's follow-up turn is adopted", async () => {
    const gated: Array<[string, string | undefined]> = [];
    const gate: ToolApprovalFn = async (_t, _a, name, _input, _signal, agentId) => {
      gated.push([name, agentId]);
      return { behavior: "allow" };
    };
    const p = provider();
    const levels: Array<readonly unknown[]> = [];
    const adopted: TurnRun[] = [];
    p.onSessionEvent = (e) => {
      if (e.type === "background_tasks") levels.push(e.tasks);
      if (e.type === "turn_started") adopted.push(e.run);
    };
    const sub = { agent: "general", description: "child work", prompt: '[[tool:shell {"command":"echo from-child"}]]', background: true };
    const events = await collect(
      p.runTurn(
        opts(ask("Start a background subagent (general) that runs `echo from-child` in its shell, then say launched.", `[[tool:subagent ${JSON.stringify(sub)}]]`), { canUseTool: gate }),
      ),
    );
    expect(done(events)).toBeDefined();
    expect(events.some((e) => e.type === "subagent_start")).toBe(true);
    for (let i = 0; i < 600 && adopted.length === 0; i++) await Bun.sleep(100);
    expect(adopted).toHaveLength(1);
    expect(levels.some((l) => l.length === 1)).toBe(true);
    expect(levels.at(-1)).toEqual([]);
    expect(gated.find(([n]) => n === "Task")?.[1]).toBeUndefined();
    const childShell = gated.find(([n]) => n === "Bash");
    expect(childShell?.[1]).toMatch(/^ses/);
    adopted[0]!.bindGate?.({ canUseTool: gate });
    expect(done(await collect(adopted[0]!))).toBeDefined();
    await p.teardown();
  }, 180_000);

  maybeTurn("I9 steering a running reply: one absorbed boundary, then the steered answer", async () => {
    const p = provider();
    const run = p.runTurn(opts(ask("Count slowly from one to forty in words, one per line.", "[[slow:250]] [[text:one two three four five six seven eight nine ten]]")));
    const events: ProviderEvent[] = [];
    let pushed = false;
    let dones = 0;
    for await (const e of run.events) {
      events.push(e);
      if (!pushed && e.type === "text_delta") {
        pushed = true;
        run.pushMidTurn?.(ask("Stop counting. Just reply: steered", "[[text:steered]]"), "now");
      }
      if (e.type === "turn_done" && ++dones === 2) break;
      if (e.type === "error") break;
    }
    const results = events.filter((e) => e.type === "turn_done") as Array<Extract<ProviderEvent, { type: "turn_done" }>>;
    expect(results.map((d) => d.result.stopReason)).toEqual(["steered", "stop"]);
    expect(texts(events).at(-1)).toMatch(/steered/i);
    await p.teardown();
  }, 180_000);

  maybeTurn("I10 a model and effort switch lands on the opencode session", async () => {
    const p = provider();
    await collect(p.runTurn(opts(ask("Reply ok.", "[[text:ok]]"))));
    const listed = (await p.listModels()).find((m) => m.id === MODEL);
    const effort = listed?.efforts?.at(-1);
    if (!effort) {
      console.log(`[opencode integration] I10: ${MODEL} has no reasoning variants — only the model is checked`);
    }
    const events = await collect(p.runTurn(opts(ask("Reply ok.", "[[text:ok]]"), effort ? { effort } : {})));
    expect(done(events)).toBeDefined();
    const conn = await server!.ensure();
    const info = await conn.client.getSession(p.backingSessionId);
    expect(`${info.model?.providerID}/${info.model?.id}`).toBe(MODEL!);
    if (effort) expect(info.model?.variant).toBe(effort);
    await p.teardown();
  }, 180_000);

  maybeTurn("I11 interrupt mid-reply ends the turn promptly", async () => {
    const p = provider();
    const run = p.runTurn(opts(ask("Write the numbers from 1 to 400, one per line.", "[[slow:300]] [[text:a b c d e f g h i j k l m n o p q r s t]]")));
    const events: ProviderEvent[] = [];
    let at = 0;
    for await (const e of run.events) {
      events.push(e);
      if (!at && e.type === "text_delta") {
        at = Date.now();
        void run.interrupt();
      }
      if (e.type === "turn_done" || e.type === "error") break;
    }
    expect(done(events)?.stopReason).toBe("interrupted");
    expect(Date.now() - at).toBeLessThan(4_000);
    await p.teardown();
  }, 180_000);

  maybeScripted("I12 Code Mode is hidden: a script can't run, so its fetch can't get past the gate", async () => {
    // On 2.2.2 a Code Mode script's fetch runs without asking anything. The
    // session rules deny `execute`, which takes the tool away on 2.2.x.
    let hits = 0;
    const target = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => {
        hits++;
        return new Response("reached");
      },
    });
    const asked: string[] = [];
    const p = provider();
    const code = `const r = await fetch('http://127.0.0.1:${target.port}/x', { method: 'POST', body: 'secret' }); return 'status ' + r.status;`;
    try {
      const events = await collect(
        p.runTurn(
          opts(`[[tool:execute ${JSON.stringify({ code })}]]`, {
            canUseTool: async (_t, _a, name) => {
              asked.push(name);
              return { behavior: "allow" };
            },
          }),
        ),
      );
      expect(hits).toBe(0);
      expect(asked).toEqual([]);
      const card = events.find((e) => e.type === "tool_start") as Extract<ProviderEvent, { type: "tool_start" }> | undefined;
      expect(card?.name).toBe("opencode_execute");
      expect(events.find((e) => e.type === "tool_complete")).toMatchObject({ success: false, output: expect.stringContaining("No tool named") });
      expect(done(events)).toBeDefined();
    } finally {
      target.stop(true);
      await p.teardown();
    }
  }, 180_000);

  maybeScripted("I13 a model error opencode doesn't retry ends the turn promptly, with its status", async () => {
    const p = provider();
    const started = Date.now();
    const events = await collect(p.runTurn(opts("[[fail:400]]")));
    const error = events.find((e) => e.type === "error") as Extract<ProviderEvent, { type: "error" }> | undefined;
    expect(error?.detail).toMatchObject({ type: "provider.invalid-request", status: 400 });
    expect(Date.now() - started).toBeLessThan(8_000);
    // The session is usable after it.
    expect(texts(await collect(p.runTurn(opts("[[text:recovered]]"))))).toEqual(["recovered"]);
    await p.teardown();
  }, 180_000);

  maybeScripted("I14 the title opencode generates is billed, once", async () => {
    const p = provider();
    const turns: number[] = [];
    for (const text of ["[[text:one]]", "[[text:two]]", "[[text:three]]"]) turns.push(done(await collect(p.runTurn(opts(text))))!.totalCostUsd);
    const conn = await server!.ensure();
    const info = await conn.client.getSession(p.backingSessionId);
    // Everything opencode billed this session, counted exactly once across the turns.
    expect(turns.reduce((a, b) => a + b, 0)).toBeCloseTo(info.cost ?? 0, 9);
    await p.teardown();
  }, 180_000);

  maybeTurn("I15 a session deleted on the server while attached: the next turn goes on in a new one, from codeoid's history", async () => {
    const p = provider();
    let lost = 0;
    p.onHistoryLost = () => {
      lost++;
      p.seedText("Earlier you said: one.");
    };
    await collect(p.runTurn(opts(ask("Reply: one", "[[text:one]]"))));
    const gone = p.backingSessionId;
    const conn = await server!.ensure();
    const res = await fetch(`${conn.client.baseUrl}/api/session/${gone}`, { method: "DELETE", headers: { authorization: serverAuth } });
    expect(res.status).toBe(204);
    await Bun.sleep(300);
    for (const word of ["two", "three"]) {
      const events = await collect(p.runTurn(opts(ask(`Reply: ${word}`, `[[text:${word}]]`))));
      expect(events.find((e) => e.type === "error")).toBeUndefined();
      if (SCRIPTED) expect(texts(events)).toEqual([word]);
    }
    expect(lost).toBe(1);
    expect(p.backingSessionId).not.toBe(gone);
    expect(p.backingSessionId).toMatch(/^ses/);
    await p.teardown();
  }, 180_000);
});
