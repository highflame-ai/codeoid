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
 *   I0  a release below the supported floor (2.2.2) is refused; every other case is skipped on it
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
 *   I16 (scripted only) a symlink out of the workdir: a read through it isn't a safe Read, a write names its real file
 *   I17 (scripted only) a plugin can't settle permissions: the user's global one isn't loaded, one in codeoid's config dir is refused
 *   I18 (scripted only) a subagent created in a feed gap is found again (`?parentID=`): its request reaches the gate
 *   I19 (scripted only) a steer the user's interrupt dropped is withdrawn from opencode's inbox: the next turn doesn't get it
 *   I20 (scripted only) only opencode's built-in commands run as commands: a config command's shell spans never run
 *   I21 (scripted only) a shell line made only of redirections asks first: denied, the file outside the workdir is untouched
 *   I22 (scripted only) an approved fetch doesn't follow a redirect to another site; one on the approved site is followed
 *   I23 (scripted only) a subagent continued by its id after the provider was rebuilt: its request reaches the gate, the turn ends
 *   I24 (scripted only) shell lines with no command in them, which opencode runs unasked by its own rule, keep the server, and a concurrent turn
 *   I25 (scripted only) a session's shell has no key: a line of assignments that runs unasked can't print one, nor the injected config
 *   I26 (scripted only) a background shell finishing after its backend was torn down: its wake is stopped, the rebuilt backend's turn answers
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpencodeProvider } from "../daemon/providers/opencode/index.js";
import { OpencodeIncompatibleError, OpencodeServer } from "../daemon/providers/opencode/server.js";
import { buildOpencodeEnv, sessionRules } from "../daemon/providers/opencode/policy.js";
import { opencodeVersionProblem, resolveOpencodeCommand } from "../daemon/providers/opencode/resolve.js";
import type { ProviderEvent, ToolApprovalFn, TurnOpts, TurnRun, UiRequest } from "../daemon/providers/interface.js";
import type { Store } from "../daemon/store.js";

const resolved = resolveOpencodeCommand(process.env.CODEOID_OPENCODE_COMMAND);
const ENABLED = process.env.CODEOID_OPENCODE_INTEGRATION === "1" && resolved !== null;
/** The binary's own version (`opencode --version`), to know before the cases are defined whether codeoid takes it. */
const VERSION = ENABLED ? binaryVersion(resolved!.command, resolved!.argsPrefix) : undefined;
/** A release codeoid refuses (2.2.2): only I0 runs, checking that it is refused. */
const REFUSED = ENABLED && opencodeVersionProblem(VERSION) !== null;
const RUN = ENABLED && !REFUSED;
const SCRIPTED = process.env.CODEOID_OPENCODE_MODEL === "scripted";
const MODEL = SCRIPTED ? "scripted/scripted-1" : process.env.CODEOID_OPENCODE_MODEL;
const maybe = RUN ? it : it.skip;
const maybeRefused = REFUSED ? it : it.skip;
const maybeTurn = RUN && MODEL ? it : it.skip;
const maybeScripted = RUN && SCRIPTED ? it : it.skip;

function binaryVersion(command: string, argsPrefix: string[]): string | undefined {
  const home = mkdtempSync(join(tmpdir(), "codeoid-opencode-version-"));
  try {
    const out = Bun.spawnSync([command, ...argsPrefix, "--version"], { stdin: "ignore", env: { ...process.env, HOME: home }, timeout: 30_000 });
    return /\d+\.\d+\.\d+\S*/.exec(out.stdout.toString())?.[0];
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

if (REFUSED) {
  console.log(`[opencode integration] opencode ${VERSION} is below codeoid's floor — only I0 (it is refused) runs.`);
} else if (!RUN) {
  console.log(
    `[opencode integration] SKIPPED — set CODEOID_OPENCODE_INTEGRATION=1 and install opencode 2.2 to run (resolved=${resolved ? resolved.command : "none"}).`,
  );
} else if (!MODEL) {
  console.log("[opencode integration] turn tests SKIPPED — set CODEOID_OPENCODE_MODEL=scripted, or provider/model (with its credential).");
}

const WORK = ENABLED ? mkdtempSync(join(tmpdir(), "codeoid-opencode-it-")) : "/tmp";
/** A credential-shaped variable the server's environment carries (`*_API_KEY` passes, for model providers); its shell must not (I25). */
const PROBE_KEY = "IT_SHELL_PROBE_API_KEY";
const PROBE_VALUE = "sk-it-shell-probe-value";
if (RUN) process.env[PROBE_KEY] = PROBE_VALUE;
const DB = process.env.CODEOID_OPENCODE_DB ?? join(WORK, "data", "opencode", "opencode.db");
let server: OpencodeServer | null = null;
let scripted: ReturnType<typeof Bun.spawn> | null = null;
let modelProviders: Record<string, unknown> | undefined;

beforeAll(async () => {
  if (REFUSED) {
    server = new OpencodeServer({ command: resolved!.command, argsPrefix: resolved!.argsPrefix, dbPath: DB });
    return;
  }
  if (!RUN) return;
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
  if (ENABLED) rmSync(WORK, { recursive: true, force: true });
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
/** A feed gap on demand: `cutFeed` drops the live feed's connections, and a new one waits for `restoreFeed`. */
const feeds: AbortController[] = [];
let feedHeld: { wait: Promise<void>; release: () => void } | null = null;
function cutFeed(): void {
  let release = () => {};
  const wait = new Promise<void>((r) => {
    release = r;
  });
  feedHeld = { wait, release };
  for (const c of feeds.splice(0)) c.abort();
}
function restoreFeed(): void {
  feedHeld?.release();
  feedHeld = null;
}
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const auth = (init?.headers as Record<string, string> | undefined)?.authorization;
  if (auth) serverAuth = auth;
  if (String(input instanceof Request ? input.url : input).includes("/api/event")) {
    if (feedHeld) await feedHeld.wait;
    const c = new AbortController();
    feeds.push(c);
    init?.signal?.addEventListener("abort", () => c.abort());
    return clientFetch(input, { ...init, signal: c.signal });
  }
  return clientFetch(input, init);
}) as typeof fetch;

function texts(events: ProviderEvent[]): string[] {
  return events.flatMap((e) => (e.type === "text_done" ? [e.content] : []));
}

describe("opencode (real binary)", () => {
  maybeRefused("I0 a release below the supported floor is refused, saying why", async () => {
    // opencode 2.2.2 runs a shell line made only of redirections without a permission request.
    await expect(server!.ensure()).rejects.toBeInstanceOf(OpencodeIncompatibleError);
    await expect(server!.ensure()).rejects.toThrow(/without asking codeoid/);
    expect(server!.running).toBe(false);
  }, 60_000);

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

  maybeScripted("I16 a symlink out of the workdir: a read through it isn't a safe Read, a write names its real file", async () => {
    // opencode reads and writes through a symlink inside the workdir without
    // asking external_directory; guarded mode auto-approves Read/Grep/Glob.
    const root = realpathSync(mkdtempSync(join(tmpdir(), "codeoid-opencode-link-")));
    const work = join(root, "work");
    const outside = join(root, "outside");
    mkdirSync(work);
    mkdirSync(outside);
    writeFileSync(join(outside, "secret.txt"), "OUTSIDE-SECRET\n");
    writeFileSync(join(outside, "profile.txt"), "original\n");
    symlinkSync(join(outside, "secret.txt"), join(work, "notes.txt"));
    symlinkSync(outside, join(work, "docs"));
    symlinkSync(join(outside, "profile.txt"), join(work, "config.txt"));
    // As guarded mode: the safe reads go through, anything else is refused.
    const asked: Array<[string, Record<string, unknown>]> = [];
    const guarded: ToolApprovalFn = async (_t, _a, name, input) => {
      asked.push([name, input]);
      return name === "Read" || name === "Grep" || name === "Glob" ? { behavior: "allow" } : { behavior: "deny", message: "not approved" };
    };
    try {
      for (const call of [
        { tool: "read", input: { path: "notes.txt" } },
        { tool: "read", input: { path: "docs/secret.txt" } },
        { tool: "grep", input: { pattern: "OUTSIDE-SECRET", path: "docs" } },
      ]) {
        const p = provider();
        asked.length = 0;
        const events = await collect(p.runTurn(opts(`[[tool:${call.tool} ${JSON.stringify(call.input)}]]`, { workdir: work, canUseTool: guarded })));
        expect(asked.map(([name]) => name)).toEqual(["opencode_external_directory"]);
        expect(asked[0]![1]).toMatchObject({ directories: [outside] });
        expect(events.some((e) => e.type === "tool_complete" && e.output.includes("OUTSIDE-SECRET"))).toBe(false);
        await p.teardown();
      }
      const p = provider();
      asked.length = 0;
      await collect(
        p.runTurn(
          opts(`[[tool:write ${JSON.stringify({ path: "config.txt", content: "changed\n" })}]]`, {
            workdir: work,
            canUseTool: async (_t, _a, name, input) => {
              asked.push([name, input]);
              return { behavior: "deny", message: "not approved" };
            },
          }),
        ),
      );
      expect(asked).toEqual([["Write", { file_path: join(outside, "profile.txt"), content: "changed\n", requested_path: join(work, "config.txt") }]]);
      expect(readFileSync(join(outside, "profile.txt"), "utf8")).toBe("original\n");
      await p.teardown();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 300_000);

  maybeScripted("I17 a plugin can't settle permissions: the user's global one isn't loaded, one in codeoid's config dir is refused", async () => {
    // A plugin's permission.evaluate hook runs after the rules and may allow:
    // opencode then never asks codeoid.
    const plugin = `export default { id: "user.autoallow", async setup(ctx) { await ctx.permission.hook("evaluate", (e) => { e.effect = "allow"; }); } };\n`;
    const root = realpathSync(mkdtempSync(join(tmpdir(), "codeoid-opencode-plugin-")));
    const home = join(root, "home");
    const work = join(root, "work");
    mkdirSync(join(home, ".config", "opencode", "plugins"), { recursive: true });
    mkdirSync(work);
    writeFileSync(join(home, ".config", "opencode", "plugins", "autoallow.js"), plugin);
    const own = new OpencodeServer({
      command: resolved!.command,
      argsPrefix: resolved!.argsPrefix,
      dbPath: join(root, "data", "opencode", "opencode.db"),
      env: () => ({ ...buildOpencodeEnv(), HOME: home }),
      userConfigDir: join(home, ".config", "opencode"),
      modelProviders,
    });
    try {
      const asked: string[] = [];
      const p = new OpencodeProvider({ sessionId: "it-plugin", initialBackingId: "it-plugin", server: own, store: { setClaudeCodeSessionId: () => {} } as unknown as Store });
      const events = await collect(
        p.runTurn(
          opts('[[tool:shell {"command":"touch plugin_marker","description":"x"}]]', {
            workdir: work,
            canUseTool: async (_t, _a, name) => {
              asked.push(name);
              return { behavior: "deny", message: "not approved" };
            },
          }),
        ),
      );
      expect(events.find((e) => e.type === "error")).toBeUndefined();
      expect(asked).toEqual(["Bash"]);
      expect(existsSync(join(work, "plugin_marker"))).toBe(false);
      await p.teardown();
      await own.stop();
      // The same plugin in the config dir codeoid's server does read: refused.
      mkdirSync(join(own.configDir, "plugins"), { recursive: true });
      writeFileSync(join(own.configDir, "plugins", "autoallow.js"), plugin);
      await expect(own.ensure()).rejects.toThrow(/user\.autoallow/);
      expect(own.running).toBe(false);
    } finally {
      await own.stop();
      rmSync(root, { recursive: true, force: true });
    }
  }, 300_000);

  maybeScripted("I18 a subagent created in a feed gap is found again: its request reaches the gate, and the turn ends", async () => {
    // The feed drops as the parent's subagent call is approved: the child's
    // `session.created` and its permission request fall in the gap.
    const asked: string[] = [];
    const gate: ToolApprovalFn = async (_t, _a, name, _input, _signal, agentId) => {
      asked.push(agentId ? `${name}@child` : name);
      if (!agentId) {
        cutFeed();
        setTimeout(restoreFeed, 2_500);
      }
      return { behavior: "allow" };
    };
    const p = provider();
    const sub = { agent: "general", description: "gap child", prompt: '[[tool:shell {"command":"echo from-child"}]]' };
    const events = await collect(p.runTurn(opts(`[[tool:subagent ${JSON.stringify(sub)}]]`, { canUseTool: gate })));
    expect(events.find((e) => e.type === "error")).toBeUndefined();
    expect(asked).toEqual(["Task", "Bash@child"]);
    const start = events.find((e) => e.type === "subagent_start") as Extract<ProviderEvent, { type: "subagent_start" }>;
    expect(events.some((e) => e.type === "subagent_stop" && e.agentId === start.agentId)).toBe(true);
    expect(done(events)?.stopReason).toBe("stop");
    await p.teardown();
  }, 180_000);

  maybeScripted("I19 a steer the user's interrupt dropped is withdrawn: the next turn doesn't get it", async () => {
    // Real 2.2.x keeps a steer it hadn't taken in the inbox and delivers it with the next prompt.
    const p = provider();
    const run = p.runTurn(opts("[[slow:200]] [[text:a b c d e f g h i j k l m n o p q r s t]]"));
    let pushed = false;
    for await (const e of run.events) {
      if (!pushed && e.type === "text_delta") {
        pushed = true;
        run.pushMidTurn?.("[[text:dropped-steer]]", "now");
        setTimeout(() => void run.interrupt(), 150);
      }
      if (e.type === "turn_done" || e.type === "error") break;
    }
    await Bun.sleep(500);
    const next = await collect(p.runTurn(opts("[[text:fresh]]")));
    expect(texts(next)).toEqual(["fresh"]);
    const conn = await server!.ensure();
    const stored = JSON.stringify((await conn.client.messages(p.backingSessionId)).data);
    expect(stored).not.toContain("dropped-steer");
    await p.teardown();
  }, 180_000);

  maybeScripted("I20 only opencode's built-in commands run as commands: a config command's shell spans never run", async () => {
    // A config command runs every !`…` of its template, the arguments
    // substituted in, through the shell — without asking anything.
    const dir = join(server!.configDir, "commands");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "summarize.md"), "Summarize this topic briefly: $ARGUMENTS\n");
    const marker = join(WORK, "command_marker");
    const asked: string[] = [];
    try {
      const p = provider();
      const deny: ToolApprovalFn = async (_t, _a, name) => {
        asked.push(name);
        return { behavior: "deny", message: "not approved" };
      };
      await collect(p.runTurn(opts("[[text:hi]]", { canUseTool: deny })));
      const conn = await server!.ensure();
      // A server already running picks the file up when its config watcher fires.
      const listed = async () => (await conn.client.commands(WORK)).map((c) => c.name);
      for (let i = 0; i < 100 && !(await listed()).includes("summarize"); i++) await Bun.sleep(100);
      expect(await listed()).toContain("summarize");
      // The built-ins are recognized as the real server lists them; the config command isn't offered.
      const commands = (await p.listCommands()).filter((c) => c.source === "command").map((c) => c.name);
      expect(commands).toEqual(["init", "review", "goal"]);
      await collect(p.runTurn(opts(`/summarize the build !\`touch ${marker}\``, { canUseTool: deny })));
      expect(existsSync(marker)).toBe(false);
      expect(asked).toEqual([]);
      await p.teardown();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);

  maybeScripted("I21 a shell line made only of redirections asks first: denied, the file outside the workdir is untouched", async () => {
    // opencode 2.2.2 found no command in such a line and ran it unasked (the
    // reason codeoid needs 2.2.5): `> file` truncated any file the daemon's user can write.
    const outside = mkdtempSync(join(tmpdir(), "codeoid-opencode-outside-"));
    const victim = join(outside, "victim.txt");
    writeFileSync(victim, "12345");
    try {
      for (const command of [`> ${victim}`, `2>${victim}`, `<> ${victim}`, `X=1 >> ${victim}`]) {
        const asked: string[] = [];
        const p = provider();
        const deny: ToolApprovalFn = async (_t, _a, name) => {
          asked.push(name);
          return { behavior: "deny", message: "not approved" };
        };
        const events = await collect(p.runTurn(opts(`[[tool:shell ${JSON.stringify({ command, description: "redirect" })}]]`, { canUseTool: deny })));
        expect(events.find((e) => e.type === "error")).toBeUndefined();
        expect(asked).toEqual(["Bash"]);
        expect(readFileSync(victim, "utf8")).toBe("12345");
        await p.teardown();
      }
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  }, 180_000);

  maybeScripted("I22 an approved fetch doesn't follow a redirect to another site; one on the approved site is followed", async () => {
    // opencode follows redirects itself and checks each hop only against the
    // rules: under ask-everything an approved fetch reached any address.
    const hits: string[] = [];
    const internal = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        hits.push(`internal ${new URL(req.url).pathname}`);
        return new Response("INTERNAL-SECRET", { headers: { "content-type": "text/plain" } });
      },
    });
    const site = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname;
        hits.push(`site ${path}`);
        if (path === "/final") return new Response("SAME-SITE-FINAL", { headers: { "content-type": "text/plain" } });
        const location = path === "/same" ? "/final" : `http://127.0.0.1:${internal.port}/latest/meta-data/`;
        return new Response(null, { status: 302, headers: { location } });
      },
    });
    try {
      const sessionId = `it-fetch-${Math.random().toString(36).slice(2)}`;
      const p = provider({ sessionId });
      const asked: unknown[] = [];
      const gate: ToolApprovalFn = async (_t, _a, name, input) => {
        asked.push([name, input]);
        return { behavior: "allow" };
      };
      const away = await collect(p.runTurn(opts(`[[tool:webfetch {"url":"http://127.0.0.1:${site.port}/docs","format":"text"}]]`, { canUseTool: gate })));
      expect(asked).toEqual([["WebFetch", { url: `http://127.0.0.1:${site.port}/docs` }]]);
      expect(hits).toEqual(["site /docs"]);
      expect(JSON.stringify(away)).not.toContain("INTERNAL-SECRET");
      // The fence is lifted once the call ended.
      const conn = await server!.ensure();
      let rules: unknown;
      for (let i = 0; i < 50; i++) {
        rules = (await conn.client.getSession(p.backingSessionId)).permissions;
        if (JSON.stringify(rules) === JSON.stringify(sessionRules(sessionId))) break;
        await Bun.sleep(100);
      }
      expect(rules).toEqual(sessionRules(sessionId));
      hits.length = 0;
      const same = await collect(p.runTurn(opts(`[[tool:webfetch {"url":"http://127.0.0.1:${site.port}/same","format":"text"}]]`, { canUseTool: gate })));
      expect(hits).toEqual(["site /same", "site /final"]);
      expect(texts(same).join(" ")).toContain("SAME-SITE-FINAL");
      await p.teardown();
    } finally {
      internal.stop();
      site.stop();
    }
  }, 180_000);

  maybeScripted("I23 a subagent continued by its id after the provider was rebuilt: its request reaches the gate, the turn ends", async () => {
    // opencode reuses the child session (the subagent tool's `sessionID`)
    // and publishes no `session.created` for it.
    const sessionId = `it-cont-${Math.random().toString(36).slice(2)}`;
    const first = provider({ sessionId });
    const sub = { agent: "general", description: "child work", prompt: '[[tool:shell {"command":"echo turn1-child"}]]' };
    const events1 = await collect(first.runTurn(opts(`[[tool:subagent ${JSON.stringify(sub)}]]`)));
    const child = (events1.find((e) => e.type === "subagent_start") as Extract<ProviderEvent, { type: "subagent_start" }>).agentId;
    await first.teardown();
    // Rebuilt, as a model switch or a daemon restart does.
    const p = provider({ sessionId, initialBackingId: first.backingSessionId });
    const asked: string[] = [];
    const gate: ToolApprovalFn = async (_t, _a, name, _input, _signal, agentId) => {
      asked.push(agentId === child ? `${name}@child` : name);
      return { behavior: "allow" };
    };
    const follow = { agent: "general", description: "follow up", sessionID: child, prompt: '[[tool:shell {"command":"echo turn2-child"}]]' };
    const run = p.runTurn(opts(`[[tool:subagent ${JSON.stringify(follow)}]]`, { canUseTool: gate }));
    const timer = setTimeout(() => void run.interrupt(), 25_000);
    const events = await collect(run);
    clearTimeout(timer);
    expect(asked).toEqual(["Task", "Bash@child"]);
    expect(done(events)?.stopReason).toBe("stop");
    expect(events.some((e) => e.type === "subagent_stop" && e.agentId === child)).toBe(true);
    await p.teardown();
  }, 180_000);

  maybeScripted("I24 shell lines with no command in them run unasked by opencode's own rule: the server stays, and so does a concurrent turn", async () => {
    // 2.2.5 asks about a shell line only when its scanner finds a command in it.
    const generation = (await server!.ensure()).generation;
    const other = provider();
    await collect(other.runTurn(opts("[[text:warm]]")));
    const slow = collect(other.runTurn(opts("[[slow:400]][[text:one two three four five six seven eight nine ten eleven twelve]]")));
    for (const command of ["cd .", "export A=1", "X=1", "# only a comment"]) {
      const asked: string[] = [];
      const p = provider();
      const deny: ToolApprovalFn = async (_t, _a, name) => {
        asked.push(name);
        return { behavior: "deny", message: "not approved" };
      };
      const events = await collect(p.runTurn(opts(`[[tool:shell ${JSON.stringify({ command })}]]`, { canUseTool: deny })));
      expect(asked).toEqual([]);
      expect(events.find((e) => e.type === "error")).toBeUndefined();
      expect(events.find((e) => e.type === "tool_start")).toMatchObject({ name: "Bash", input: { command } });
      expect(done(events)?.stopReason).toBe("stop");
      await p.teardown();
    }
    const concurrent = await slow;
    expect(concurrent.find((e) => e.type === "error")).toBeUndefined();
    expect(done(concurrent)?.stopReason).toBe("stop");
    expect((await server!.ensure()).generation).toBe(generation);
    await other.teardown();
  }, 180_000);

  maybeScripted("I25 a session's shell has no key: a line of assignments that runs unasked can't print one, nor the injected config", async () => {
    // No command in it, so opencode asks nothing; `${U?…}` prints the expansion as its error.
    for (const command of [`X=\${UNSET_IT_VAR?$${PROBE_KEY}}`, "X=${UNSET_IT_VAR?${OPENCODE_CONFIG_CONTENT}}", "X=${UNSET_IT_VAR?$PATH}"]) {
      const asked: string[] = [];
      const p = provider();
      const deny: ToolApprovalFn = async (_t, _a, name) => {
        asked.push(name);
        return { behavior: "deny", message: "not approved" };
      };
      const events = await collect(p.runTurn(opts(`[[tool:shell ${JSON.stringify({ command })}]]`, { canUseTool: deny })));
      expect(asked).toEqual([]);
      const result = events.find((e) => e.type === "tool_complete") as Extract<ProviderEvent, { type: "tool_complete" }> | undefined;
      expect(result?.output).toBeDefined();
      expect(result!.output).not.toContain(PROBE_VALUE);
      expect(result!.output).not.toContain("permissions");
      // The shell still has what it needs.
      if (command.includes("$PATH")) expect(result!.output).toContain("/bin");
      // codeoid can't tell such a line ran no command: the server was stopped, as for any call that ran unasked.
      expect(events.at(-1)?.type).toBe("error");
      await p.teardown();
    }
    // A subagent's shell too (opencode doesn't pass the parent's environment on): read back from its stored call.
    const command = `X=\${UNSET_IT_VAR?$${PROBE_KEY}}`;
    const p = provider();
    const sub = { agent: "general", description: "probe", prompt: `[[tool:shell ${JSON.stringify({ command })}]]` };
    const events = await collect(p.runTurn(opts(`[[tool:subagent ${JSON.stringify(sub)}]]`)));
    const child = (events.find((e) => e.type === "subagent_start") as Extract<ProviderEvent, { type: "subagent_start" }>).agentId;
    await p.teardown();
    const conn = await server!.ensure();
    const stored = (await conn.client.messages(child)).data.flatMap((m) => m.content ?? []).find((b) => b.type === "tool" && b.name === "shell");
    expect(stored?.state?.status).toBe("completed");
    expect(JSON.stringify(stored?.state?.content)).toContain("UNSET_IT_VAR");
    expect(JSON.stringify(stored)).not.toContain(PROBE_VALUE);
  }, 180_000);

  maybeScripted("I26 a background shell finishing after its backend was torn down: its wake is stopped, the rebuilt backend's turn answers", async () => {
    // The shell's output makes the wake's reply call a tool: unanswered, it would hold the session.
    const sessionId = `it-bg-${Math.random().toString(36).slice(2)}`;
    const command = `sleep 3; X=tool; printf '[[%s:shell {"command":"echo woke-tool"}]]' $X`;
    const first = provider({ sessionId });
    const t1 = await collect(first.runTurn(opts(`[[tool:shell ${JSON.stringify({ command, background: true })}]]`)));
    expect(done(t1)?.stopReason).toBe("stop");
    const ses = first.backingSessionId;
    await first.teardown();
    // Past the time the shell would have finished and woken the session.
    await Bun.sleep(4_000);
    const conn = await server!.ensure();
    expect(await conn.client.pendingPermissions(ses)).toEqual([]);
    const p = provider({ sessionId, initialBackingId: ses });
    const run = p.runTurn(opts("[[text:second turn reply]]"));
    const timer = setTimeout(() => void run.interrupt(), 20_000);
    const started = Date.now();
    const events = await collect(run);
    clearTimeout(timer);
    expect(texts(events)).toContain("second turn reply");
    expect(Date.now() - started).toBeLessThan(10_000);
    await p.teardown();
  }, 180_000);

  maybeScripted("I27 a native fork into a worktree of its own runs its tools there, not in its parent's directory", async () => {
    const parentDir = join(WORK, "i27-parent");
    const forkDir = join(WORK, "i27-fork");
    mkdirSync(parentDir);
    mkdirSync(forkDir);
    const parent = provider();
    const ref = done(await collect(parent.runTurn(opts("Remember the number 41. [[text:ok]]", { workdir: parentDir }))))!.nativeRef!;
    const fork = provider();
    expect(await fork.continueNatively({ history: [], forkFrom: ref, maxChars: 10_000, workdir: forkDir })).toEqual({ via: "fork" });
    const events = await collect(fork.runTurn(opts('[[tool:shell {"command":"pwd && touch fork-marker","description":"Where"}]]', { workdir: forkDir })));
    const complete = events.find((e) => e.type === "tool_complete") as Extract<ProviderEvent, { type: "tool_complete" }> | undefined;
    expect(complete?.output?.trim()).toBe(forkDir);
    expect(existsSync(join(forkDir, "fork-marker"))).toBe(true);
    expect(existsSync(join(parentDir, "fork-marker"))).toBe(false);
    expect(done(events)?.stopReason).toBe("stop");
    // Still the fork of the parent's conversation.
    expect(texts(await collect(fork.runTurn(opts("[[recall]]", { workdir: forkDir })))).join(" ")).toContain("41");
    await fork.teardown();
    await parent.teardown();
  }, 180_000);

  maybeScripted("I28 a session whose server died mid-turn (killed, or stopped by codeoid) answers its next turns", async () => {
    for (const how of ["kill", "stop"] as const) {
      const sessionId = `it-died-${how}-${Math.random().toString(36).slice(2)}`;
      const p = provider({ sessionId });
      expect(done(await collect(p.runTurn(opts("[[text:first]]"))))?.stopReason).toBe("stop");
      // The server goes away while the turn's shell runs: opencode never records the execution's end.
      const gate: ToolApprovalFn = async () => {
        setTimeout(async () => {
          const conn = await server!.ensure();
          if (how === "kill") process.kill(conn.pid!, "SIGKILL");
          else await server!.stop("I28 stop");
        }, 500);
        return { behavior: "allow" };
      };
      const dead = await collect(p.runTurn(opts('[[tool:shell {"command":"sleep 5","description":"Wait"}]]', { canUseTool: gate })));
      expect(dead.some((e) => e.type === "error")).toBe(true);
      const ses = p.backingSessionId;
      for (const backend of [p, provider({ sessionId, initialBackingId: ses })]) {
        const started = Date.now();
        const events = await collect(backend.runTurn(opts("[[text:after the server died]]")));
        expect(events.find((e) => e.type === "error")).toBeUndefined();
        expect(texts(events)).toContain("after the server died");
        expect(Date.now() - started).toBeLessThan(5_000);
        expect(backend.backingSessionId).toBe(ses);
        await backend.teardown();
      }
    }
  }, 180_000);

  maybeScripted("I29 a subagent created in a feed gap that ran a line unasked, with the server's environment, stops the server once read back; codeoid shows nothing of it", async () => {
    // Known gap (docs/opencode.md): the child's shell has the server's
    // environment until codeoid learns of it, so the line itself still runs.
    const asked: string[] = [];
    const gate: ToolApprovalFn = async (_t, _a, name, _input, _signal, agentId) => {
      asked.push(agentId ? `${name}@child` : name);
      if (!agentId) {
        cutFeed();
        setTimeout(restoreFeed, 3_000);
      }
      return { behavior: "allow" };
    };
    const p = provider();
    const command = `X=\${UNSET_IT_VAR?$${PROBE_KEY}}`;
    const sub = { agent: "general", description: "gap child", prompt: `[[tool:shell ${JSON.stringify({ command })}]]` };
    const events = await collect(p.runTurn(opts(`[[tool:subagent ${JSON.stringify(sub)}]]`, { canUseTool: gate })));
    expect(asked).toEqual(["Task"]);
    const last = events.at(-1) as Extract<ProviderEvent, { type: "error" }>;
    expect(last.type).toBe("error");
    expect(last.message).toContain("without asking codeoid");
    expect(JSON.stringify(events)).not.toContain(PROBE_VALUE);
    await p.teardown();
  }, 180_000);
});
