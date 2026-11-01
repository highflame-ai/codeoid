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
 *   - CODEOID_OPENCODE_MODEL=provider/model: a real hosted model, real cost,
 *     its credential mapped from codeoid's own config and environment as the
 *     daemon does it (credentials.ts; loadConfig, so XDG_CONFIG_HOME picks the
 *     config dir). E.g. codeoid's Qwen backend on a Bailian plan key:
 *     `providers.qwen = {authType: "openai", baseUrl: "bailian-plan-intl",
 *     model: "qwen3.8-max"}`, OPENAI_API_KEY in the environment, and
 *     CODEOID_OPENCODE_MODEL=qwen/qwen3.8-max. Prompts are short; cases that
 *     depend on scripting a model exactly (marked "scripted only") are skipped.
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
 *   I27 (scripted only) a native fork into a worktree of its own runs its tools there
 *   I28 (scripted only) a session whose server died mid-turn answers its next turns
 *   I29 (scripted only) a subagent created in a feed gap runs a line unasked with the server's environment: no key is in it
 *   I30 (scripted only) a subagent running when its server died isn't picked up again by a later feed gap
 *   I31 (scripted only) codeoid's credentials reach opencode from 0600 files (built-in, Qwen and endpoint providers), never its environment; its files stay in codeoid's data dir; a session's shell keeps the user's own dirs
 *   I32 the user's own opencode data, state, cache and temp (`$TMPDIR/opencode`) dirs are untouched by the whole run
 *   I35 (scripted only) another daemon sharing the config starts while the server runs: the server's key files stay, and a location it loads afterwards (2.2.5 reads `{file:}` again for it) still has the key
 *   I36 (scripted only) a `~/` path (grep, glob, a shell's workdir) is the server's home on the card, so its credential files are refused; a `"true"` flag is shown as opencode runs it
 *   I37 (scripted only) the user's own opencode config: a provider package opencode doesn't bundle never loads into codeoid's server; a relative `{file:}` is read from the user's config dir, not the session's workdir
 *   I38 (scripted only) an execution that fails while a steer waits in the inbox says why; opencode runs the steer next
 *   I39 (scripted only) an effort reset reaches a session a new provider resumed on a higher effort (a daemon restart)
 *   I40 (scripted only) a workdir inside a git checkout: a read or search elsewhere in the checkout (opencode doesn't ask) is asked as an external directory; outside every boundary, opencode's own question is enough
 *   I41 (scripted only) an execution that fails while a `later` message waits says why; opencode answers the message next, still in the turn
 *   I42 (scripted only) arguments sent as a JSON string: a search through a workspace symlink is asked as an external directory; a write's card shows its content
 *   I43 (scripted only) a background subagent's question is withdrawn when the subagent is stopped: opencode settled it, no dialog is left
 *   I44 (scripted only) a workspace symlink to /proc/self/cwd, codeoid started inside the workdir: a read, search or write through it is refused
 *   I45 (scripted only) a write through a link whose target goes up out of another link's target: the card names the file opencode really creates
 *   I46 (scripted only) an interrupt in a feed gap longer than the interrupt's settle wait: the turn is read back, its card settled and its step billed to it
 *   I47 (scripted only) a provider error opencode retries: the first retry is attempt 1, and the failed request bills nothing
 *   I48 (scripted only) a model opencode prices at $0: the turn's $0 isn't a price (no cost source: Session prices the tokens), as on Claude
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type CodeoidConfig, loadConfig } from "../config.js";
import { opencodeCredentialInputs } from "../daemon/providers/opencode/credentials.js";
import { OpencodeProvider } from "../daemon/providers/opencode/index.js";
import { OpencodeIncompatibleError, OpencodeServer } from "../daemon/providers/opencode/server.js";
import { buildOpencodeEnv, sessionRules } from "../daemon/providers/opencode/policy.js";
import { opencodeSecretLocations, opencodeVersionProblem, resolveOpencodeCommand } from "../daemon/providers/opencode/resolve.js";
import type { ProviderEvent, ToolApprovalFn, TurnOpts, TurnRun, UiRequest } from "../daemon/providers/interface.js";
import { secretPathVerdict } from "../daemon/secret-paths.js";
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
/** A hosted model: its credential comes from codeoid's own config and environment, as the daemon maps it. */
const HOSTED = RUN && MODEL !== undefined && !SCRIPTED;
/** Providers codeoid configures carry no price (Qwen's gateway prices nothing; codeoid's own Qwen backend reports $0 too). */
const UNPRICED = MODEL !== undefined && /^(qwen|oai-[^/]+)\//.test(MODEL);

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
/**
 * The daemon's (the user's) TMPDIR for the run: fresh, so opencode making its
 * `$TMPDIR/opencode` there shows (I32), as a shared `/tmp/opencode` an
 * earlier run left would not.
 */
const USER_TMP = join(WORK, "user-tmp");
if (ENABLED) {
  mkdirSync(USER_TMP);
  process.env.TMPDIR = USER_TMP;
}
/** A credential-shaped variable the server's environment carries (`*_API_KEY` passes, for model providers); its shell must not (I25). */
const PROBE_KEY = "IT_SHELL_PROBE_API_KEY";
const PROBE_VALUE = "sk-it-shell-probe-value";
if (RUN) process.env[PROBE_KEY] = PROBE_VALUE;
const DB = process.env.CODEOID_OPENCODE_DB ?? join(WORK, "data", "opencode", "opencode.db");
/** opencode's data, logs, state and caches: codeoid's (`providers.opencode.dataDir`). */
const DATA = join(WORK, "data", "opencode-files");

/** The user's own opencode dirs as opencode finds them, listed with sizes and times: compared after the run (I32). */
function userOpencodeDirs(): string {
  const home = process.env.HOME || homedir();
  const dirs = [
    join(process.env.XDG_DATA_HOME || join(home, ".local", "share"), "opencode"),
    join(process.env.XDG_STATE_HOME || join(home, ".local", "state"), "opencode"),
    join(process.env.XDG_CACHE_HOME || join(home, ".cache"), "opencode"),
    join(USER_TMP, "opencode"),
  ];
  const out: string[] = [];
  const walk = (d: string) => {
    let names: string[];
    try {
      names = readdirSync(d);
    } catch {
      out.push(`${d}: absent`);
      return;
    }
    for (const n of names.sort()) {
      const p = join(d, n);
      const st = statSync(p, { throwIfNoEntry: false });
      if (!st) continue;
      if (st.isDirectory()) walk(p);
      else out.push(`${p} ${st.size} ${st.mtimeMs}`);
    }
  };
  for (const d of dirs) walk(d);
  return out.join("\n");
}
const USER_DIRS_BEFORE = ENABLED ? userOpencodeDirs() : "";

/** Every file under `dir`. */
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const n of (() => {
      try {
        return readdirSync(d);
      } catch {
        return [];
      }
    })()) {
      const p = join(d, n);
      if (statSync(p, { throwIfNoEntry: false })?.isDirectory()) walk(p);
      else out.push(p);
    }
  };
  walk(dir);
  return out;
}

/** The server process's environment (Linux), or null where it can't be read. */
function serverEnviron(pid: number | undefined): string | null {
  try {
    return pid ? readFileSync(`/proc/${pid}/environ`, "latin1") : null;
  } catch {
    return null;
  }
}
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
          // Priced at $0 in its catalog, as a subscription sign-in or a free hosted model is (I44).
          "scripted-free": {
            name: "Scripted free",
            capabilities: { tools: true },
            cost: { input: 0, output: 0 },
            limit: { context: 64_000, output: 4_096 },
          },
        },
      },
    };
  }
  server = new OpencodeServer({
    command: resolved!.command,
    argsPrefix: resolved!.argsPrefix,
    dbPath: DB,
    dataDir: DATA,
    ...(modelProviders ? { modelProviders } : {}),
    // A turn with no model picked stays on the scripted model, never opencode's own (hosted) default.
    ...(SCRIPTED ? { defaultModel: "scripted/scripted-1" } : {}),
    // As the daemon does: codeoid's config and environment, mapped to opencode providers whose keys are files.
    ...(HOSTED ? { credentials: () => opencodeCredentialInputs(loadConfig(), process.env) } : {}),
  });
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
    // Its log is in codeoid's data dir.
    expect(filesUnder(join(DATA, "data")).some((f) => f.includes(join("opencode", "log")))).toBe(true);
    // No credential in the server's environment: not the probe key, not a hosted model's.
    const environ = serverEnviron(conn.pid);
    if (environ !== null) {
      const names = environ.split("\0").map((kv) => kv.slice(0, kv.indexOf("=")));
      expect(names.filter((n) => /_API_KEY$|_API_TOKEN$|^(ANTHROPIC|OPENAI|GOOGLE|GEMINI|CODEOID|ZEROID)_/.test(n))).toEqual([]);
      expect(environ.includes(PROBE_VALUE)).toBe(false);
      const hostedKey = process.env.OPENAI_API_KEY;
      if (hostedKey) expect(environ.includes(hostedKey)).toBe(false);
      expect(names).toContain("XDG_DATA_HOME");
    }
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
    if (UNPRICED) expect(r!.totalCostUsd).toBe(0);
    else expect(r!.totalCostUsd).toBeGreaterThan(0);
    // opencode's own figure (#430); a $0 with tokens isn't one, and Session prices those tokens.
    expect(r!.costSource).toBe(UNPRICED ? undefined : "backend");
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
    // Stopped while the model answered: opencode bills that step nothing, so the turn's cost is unknown (#430).
    if (SCRIPTED) expect(done(events)?.costSource).toBe("unknown");
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
    // The failed turn's own spend rides its error (#430): the refused request billed nothing, and that is known.
    expect(error?.result).toMatchObject({ isError: true, costSource: "backend" });
    expect(Date.now() - started).toBeLessThan(8_000);
    // The session is usable after it.
    expect(texts(await collect(p.runTurn(opts("[[text:recovered]]"))))).toEqual(["recovered"]);
    await p.teardown();
  }, 180_000);

  maybeScripted("I14 the title opencode generates is billed, once", async () => {
    const p = provider();
    const turns: number[] = [];
    for (const text of ["[[text:one]]", "[[text:two]]", "[[text:three]]"]) {
      const r = done(await collect(p.runTurn(opts(text))))!;
      expect(r.costSource).toBe("backend");
      turns.push(r.totalCostUsd);
    }
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
      // Not `goal`: its reviewer requests are spend opencode reports nowhere.
      expect(commands).toEqual(["init", "review"]);
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
    // A comment runs nothing, whatever it holds.
    const marker = join(WORK, "i24-comment-marker");
    for (const command of ["cd .", "export A=1", "X=1", "# only a comment", `# $(touch ${marker})\nX=1`]) {
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
    expect(existsSync(marker)).toBe(false);
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
    // environment until codeoid learns of it, so the line itself still runs —
    // but that environment holds no credential.
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
    const ses = p.backingSessionId;
    await p.teardown();
    // What the line printed, as opencode stored it: the server's environment holds no key.
    const conn = await server!.ensure();
    const [child] = await conn.client.childSessions(ses);
    const stored = (await conn.client.messages(child!.id)).data.flatMap((m) => m.content ?? []).find((b) => b.type === "tool" && b.name === "shell");
    expect(JSON.stringify(stored?.state?.content)).toContain("UNSET_IT_VAR");
    expect(JSON.stringify(stored)).not.toContain(PROBE_VALUE);
  }, 180_000);

  maybeScripted("I30 a subagent running when its server died isn't picked up again by a later feed gap; a running one is listed active", async () => {
    const sessionId = `it-deadchild-${Math.random().toString(36).slice(2)}`;
    const listed: boolean[] = [];
    const killing: ToolApprovalFn = async (_t, _a, _name, _input, _signal, agentId) => {
      if (agentId) {
        const conn = await server!.ensure();
        // What a gap's read-back goes by: a running child is in `/active`.
        listed.push(agentId in (await conn.client.activeSessions()));
        setTimeout(() => process.kill(conn.pid!, "SIGKILL"), 500);
      }
      return { behavior: "allow" };
    };
    const p = provider({ sessionId });
    const sub = { agent: "general", description: "dies", prompt: '[[tool:shell {"command":"sleep 5","description":"Wait"}]]' };
    const dead = await collect(p.runTurn(opts(`[[tool:subagent ${JSON.stringify(sub)}]]`, { canUseTool: killing })));
    expect(dead.some((e) => e.type === "error")).toBe(true);
    expect(listed).toEqual([true]);
    const ses = p.backingSessionId;
    await p.teardown();
    const rebuilt = provider({ sessionId, initialBackingId: ses });
    const gapping: ToolApprovalFn = async () => {
      cutFeed();
      setTimeout(restoreFeed, 800);
      return { behavior: "allow" };
    };
    const events = await collect(rebuilt.runTurn(opts('[[tool:shell {"command":"echo after","description":"After"}]]', { canUseTool: gapping })));
    expect(events.find((e) => e.type === "error")).toBeUndefined();
    expect(events.filter((e) => e.type === "subagent_start" || e.type === "subagent_stop")).toEqual([]);
    expect(done(events)?.stopReason).toBe("stop");
    await rebuilt.teardown();
  }, 180_000);

  maybeScripted("I31 codeoid's credentials reach opencode from 0600 files, never its environment; its files stay in codeoid's data dir; a shell keeps the user's own dirs", async () => {
    const KEY = `sk-it-file-${Math.random().toString(36).slice(2)}`;
    const root = realpathSync(mkdtempSync(join(tmpdir(), "codeoid-opencode-creds-")));
    const home = join(root, "home");
    const work = join(root, "work");
    const dataDir = join(root, "oc-files");
    mkdirSync(home);
    mkdirSync(work);
    // A model that answers 401 unless the request carries KEY.
    const keyed = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures", "scripted-chat-model.ts")], {
      stdout: "pipe",
      stderr: "inherit",
      env: { ...process.env, SCRIPTED_API_KEY: KEY },
    });
    const reader = (keyed.stdout as ReadableStream<Uint8Array>).getReader();
    const { url } = JSON.parse(new TextDecoder().decode((await reader.read()).value)) as { url: string };
    reader.releaseLock();
    const own = new OpencodeServer({
      command: resolved!.command,
      argsPrefix: resolved!.argsPrefix,
      dbPath: join(root, "data", "opencode", "opencode.db"),
      dataDir,
      env: () => ({ ...buildOpencodeEnv(), HOME: home }),
      userConfigDir: null,
      // codeoid's Qwen backend on its key, an endpoint, and an Anthropic key, as the daemon would have them.
      credentials: () => ({
        env: { OPENAI_API_KEY: KEY, ANTHROPIC_API_KEY: "sk-ant-it-not-a-real-key" },
        qwen: { enabled: true, authType: "openai", baseUrl: url, model: "scripted-1" },
        endpoints: [{ name: "lab", baseUrl: url, apiKey: KEY, models: [{ id: "scripted-1", name: "Lab scripted" }] }],
        qwenOauthCredsPath: join(root, "no-qwen-login"),
      }),
    });
    const make = () => new OpencodeProvider({ sessionId: `it-creds-${Math.random().toString(36).slice(2)}`, initialBackingId: "it-creds", server: own, store: { setClaudeCodeSessionId: () => {} } as unknown as Store });
    try {
      const conn = await own.ensure();
      const creds = own.credentialsDir;
      expect(statSync(creds).mode & 0o777).toBe(0o700);
      expect(readdirSync(creds).sort()).toEqual(["anthropic.key", "oai-lab.key", "qwen.key"]);
      for (const f of readdirSync(creds)) expect(statSync(join(creds, f)).mode & 0o777).toBe(0o600);
      const environ = serverEnviron(conn.pid);
      if (environ !== null) {
        expect(environ.includes(KEY)).toBe(false);
        expect(environ.includes("sk-ant-it-not-a-real-key")).toBe(false);
      }
      const models = await conn.client.models(work);
      expect(models.some((m) => m.providerID === "qwen" && m.id === "scripted-1")).toBe(true);
      expect(models.some((m) => m.providerID === "oai-lab" && m.id === "scripted-1")).toBe(true);
      // The Anthropic key is opencode's built-in provider's (it lists models only with a credential).
      expect(models.some((m) => m.providerID === "anthropic")).toBe(true);
      // Qwen's key is not OpenAI's.
      expect(models.some((m) => m.providerID === "openai")).toBe(false);
      // The key reached each provider from its file: the model refuses a request without it.
      for (const model of ["qwen/scripted-1", "oai-lab/scripted-1"]) {
        const p = make();
        const events = await collect(p.runTurn(opts("[[text:keyed]]", { workdir: work, model })));
        expect([model, texts(events)]).toEqual([model, ["keyed"]]);
        await p.teardown();
      }
      // A session's shell: no key, no server password, not opencode's data dir.
      const p = make();
      const events = await collect(p.runTurn(opts('[[tool:shell {"command":"env","description":"Environment"}]]', { workdir: work, model: "qwen/scripted-1" })));
      const out = (events.find((e) => e.type === "tool_complete") as Extract<ProviderEvent, { type: "tool_complete" }> | undefined)?.output ?? "";
      expect(out).toContain("PATH=");
      expect(out).not.toContain(KEY);
      expect(out).not.toContain("OPENCODE_PASSWORD");
      expect(out).not.toContain(dataDir);
      await p.teardown();
      // opencode wrote nothing in the user's home; its log is in codeoid's data dir.
      expect(filesUnder(home)).toEqual([]);
      expect(filesUnder(join(dataDir, "data")).some((f) => f.includes(join("opencode", "log")))).toBe(true);
      // No file but the key files holds the key: not its log, state, cache or database.
      const holders = [...filesUnder(dataDir), ...filesUnder(join(root, "data"))].filter((f) => !f.startsWith(`${creds}/`) && readFileSync(f).includes(KEY));
      expect(holders).toEqual([]);
    } finally {
      await own.stop();
      keyed.kill();
      rmSync(root, { recursive: true, force: true });
    }
  }, 180_000);

  maybeScripted("I33 a key codeoid uses with a gateway (ANTHROPIC_BASE_URL, OPENAI_BASE_URL, GOOGLE_GEMINI_BASE_URL) goes to that gateway, never the vendor's API", async () => {
    const KEY = `gw-it-${Math.random().toString(36).slice(2)}`;
    const root = realpathSync(mkdtempSync(join(tmpdir(), "codeoid-opencode-gw-")));
    const home = join(root, "home");
    const work = join(root, "work");
    mkdirSync(home);
    mkdirSync(work);
    const seen: string[] = [];
    // The gateway: records where each request went and with which key, answers 401.
    const gw = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const key = req.headers.get("x-api-key") ?? req.headers.get("x-goog-api-key") ?? req.headers.get("authorization")?.replace(/^Bearer /, "");
        seen.push(`${req.method} ${new URL(req.url).pathname} ${key === KEY ? "key" : "no-key"}`);
        return Response.json({ error: { type: "authentication_error", message: "it-gateway", code: 401 } }, { status: 401 });
      },
    });
    // Anything else goes through a proxy that records and never forwards: nothing leaves the machine.
    const tunnels: string[] = [];
    const proxy = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        data(sock, b) {
          tunnels.push(b.toString().split("\r\n")[0] ?? "");
          sock.end("HTTP/1.1 403 Forbidden\r\n\r\n");
        },
      },
    });
    const proxyUrl = `http://127.0.0.1:${proxy.port}`;
    const base = `http://127.0.0.1:${gw.port}`;
    const own = new OpencodeServer({
      command: resolved!.command,
      argsPrefix: resolved!.argsPrefix,
      dbPath: join(root, "data", "opencode", "opencode.db"),
      dataDir: join(root, "oc-files"),
      env: () => ({ ...buildOpencodeEnv(), HOME: home, HTTPS_PROXY: proxyUrl, HTTP_PROXY: proxyUrl, https_proxy: proxyUrl, http_proxy: proxyUrl, NO_PROXY: "127.0.0.1", no_proxy: "127.0.0.1" }),
      userConfigDir: null,
      // As the daemon has them: each key with the gateway codeoid's own backends use it with; Qwen not set up.
      credentials: () => ({
        env: {
          ANTHROPIC_API_KEY: KEY,
          ANTHROPIC_BASE_URL: base,
          OPENAI_API_KEY: KEY,
          OPENAI_BASE_URL: `${base}/v1`,
          GEMINI_API_KEY: KEY,
          GOOGLE_GEMINI_BASE_URL: base,
        },
        qwen: { enabled: true },
        qwenOauthCredsPath: join(root, "no-qwen-login"),
      }),
    });
    try {
      const conn = await own.ensure();
      const models = await conn.client.models(work);
      for (const [provider, path] of [
        ["anthropic", /^POST \/v1\/messages key$/],
        // 2.2.5 also sends a GET to the endpoint before it posts (seen on the wire).
        ["openai", /^(?:GET|POST) \/v1\/responses key$/],
        ["google", /^POST \/v1beta\/models\/[^/]+:streamGenerateContent key$/],
      ] as const) {
        const model = models.find((m) => m.providerID === provider);
        expect([provider, model !== undefined]).toEqual([provider, true]);
        seen.length = 0;
        const p = new OpencodeProvider({ sessionId: `it-gw-${provider}`, initialBackingId: "it-gw", server: own, store: { setClaudeCodeSessionId: () => {} } as unknown as Store });
        const events = await collect(p.runTurn(opts("hi", { workdir: work, model: `${provider}/${model!.id}`, canUseTool: async () => ({ behavior: "deny", message: "no" }) })));
        await p.teardown();
        expect(events.find((e) => e.type === "error")).toMatchObject({ message: expect.stringContaining("it-gateway") });
        expect([provider, seen.length > 0 && seen.every((r) => path.test(r))]).toEqual([provider, true]);
      }
      // The proxy saw no vendor API (opencode's own catalog fetch is all it may see).
      expect(tunnels.filter((t) => /api\.anthropic\.com|api\.openai\.com|googleapis\.com/.test(t))).toEqual([]);
    } finally {
      await own.stop();
      gw.stop(true);
      proxy.stop(true);
      rmSync(root, { recursive: true, force: true });
    }
  }, 300_000);

  maybeScripted("I34 a default model holding a substitution isn't handed to opencode: no file is read into the model id", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "codeoid-opencode-dm-")));
    const home = join(root, "home");
    const work = join(root, "work");
    mkdirSync(home);
    mkdirSync(work);
    const secret = join(root, "secret.txt");
    writeFileSync(secret, "scripted-1-TOPSECRET", { mode: 0o600 });
    const scriptedProvider = (modelProviders as { scripted: { models: Record<string, unknown> } }).scripted;
    const own = new OpencodeServer({
      command: resolved!.command,
      argsPrefix: resolved!.argsPrefix,
      dbPath: join(root, "data", "opencode", "opencode.db"),
      dataDir: join(root, "oc-files"),
      env: () => ({ ...buildOpencodeEnv(), HOME: home }),
      userConfigDir: null,
      defaultModel: `scripted/{file:${secret}}`,
      // A model named as the file reads: 2.2.5 would pick it as the default, and send its id.
      modelProviders: { scripted: { ...scriptedProvider, models: { ...scriptedProvider.models, "scripted-1-TOPSECRET": { name: "named by the file", capabilities: { tools: true } } } } },
    });
    try {
      const conn = await own.ensure();
      expect((await conn.client.defaultModel(work))?.id).not.toBe("scripted-1-TOPSECRET");
      const p = new OpencodeProvider({ sessionId: "it-dm", initialBackingId: "it-dm", server: own, store: { setClaudeCodeSessionId: () => {} } as unknown as Store });
      const events = await collect(p.runTurn({ history: [], userMessage: "[[text:hello]]", workdir: work, canUseTool: async () => ({ behavior: "deny", message: "no" }) }));
      await p.teardown();
      expect(JSON.stringify(events)).not.toContain("TOPSECRET");
    } finally {
      await own.stop();
      rmSync(root, { recursive: true, force: true });
    }
  }, 180_000);

  maybeScripted("I35 another daemon sharing the config starts while the server runs: a location the server loads afterwards still has the key", async () => {
    const KEY = `sk-it-second-${Math.random().toString(36).slice(2)}`;
    const root = realpathSync(mkdtempSync(join(tmpdir(), "codeoid-opencode-second-")));
    const home = join(root, "home");
    mkdirSync(home);
    const works = [join(root, "work-1"), join(root, "work-2")];
    for (const w of works) mkdirSync(w);
    // A model that answers 401 unless the request carries KEY.
    const keyed = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures", "scripted-chat-model.ts")], {
      stdout: "pipe",
      stderr: "inherit",
      env: { ...process.env, SCRIPTED_API_KEY: KEY },
    });
    const reader = (keyed.stdout as ReadableStream<Uint8Array>).getReader();
    const { url } = JSON.parse(new TextDecoder().decode((await reader.read()).value)) as { url: string };
    reader.releaseLock();
    const dbPath = join(root, "data", "opencode", "opencode.db");
    const own = new OpencodeServer({
      command: resolved!.command,
      argsPrefix: resolved!.argsPrefix,
      dbPath,
      dataDir: join(root, "oc-files"),
      env: () => ({ ...buildOpencodeEnv(), HOME: home }),
      userConfigDir: null,
      credentials: () => ({ env: {}, endpoints: [{ name: "lab", baseUrl: url, apiKey: KEY, models: [{ id: "scripted-1" }] }] }),
    });
    const turn = async (workdir: string) => {
      const p = new OpencodeProvider({ sessionId: `it-second-${Math.random().toString(36).slice(2)}`, initialBackingId: "it-second", server: own, store: { setClaudeCodeSessionId: () => {} } as unknown as Store });
      const events = await collect(p.runTurn(opts("[[text:keyed]]", { workdir, model: "oai-lab/scripted-1" })));
      await p.teardown();
      return [texts(events), events.find((e) => e.type === "error")];
    };
    try {
      expect(await turn(works[0]!)).toEqual([["keyed"], undefined]);
      // The second daemon, in a process of its own, at its start: what it clears.
      const second = join(root, "second-daemon.ts");
      const roots = opencodeSecretLocations({ providers: { opencode: { enabled: true, command: "opencode", dbPath } } } as unknown as CodeoidConfig).dirs;
      writeFileSync(second, `import { clearStaleOpencodeCredentials } from ${JSON.stringify(join(import.meta.dir, "..", "daemon", "providers", "opencode", "credentials.ts"))};\nclearStaleOpencodeCredentials(${JSON.stringify(roots)});\n`);
      expect(Bun.spawnSync([process.execPath, second]).exitCode).toBe(0);
      expect(readdirSync(own.credentialsDir)).toEqual(["oai-lab.key"]);
      // A new location: 2.2.5 reads the key file again for it.
      expect(await turn(works[1]!)).toEqual([["keyed"], undefined]);
    } finally {
      await own.stop();
      keyed.kill();
      rmSync(root, { recursive: true, force: true });
    }
  }, 180_000);

  maybeScripted("I36 a `~/` path and a stringified flag are shown as opencode runs them: the server's credential files are refused", async () => {
    // opencode expands `~/` to its home and its input repair turns `"true"`
    // into `true`, both before the tool and its permission request run.
    const root = realpathSync(mkdtempSync(join(tmpdir(), "codeoid-opencode-tilde-")));
    const home = join(root, "home");
    const work = join(root, "work");
    const configDir = join(home, ".codeoid");
    mkdirSync(configDir, { recursive: true });
    mkdirSync(work);
    writeFileSync(join(configDir, "config.json"), '{"apiKey":"zid_sk_IT_TILDE"}\n');
    const own = new OpencodeServer({
      command: resolved!.command,
      argsPrefix: resolved!.argsPrefix,
      dbPath: join(root, "data", "opencode", "opencode.db"),
      dataDir: join(root, "oc-files"),
      env: () => ({ ...buildOpencodeEnv(), HOME: home }),
      userConfigDir: null,
      modelProviders,
    });
    // As an autonomous session's gate: the secret-path verdict, then allow.
    const asked: Array<[string, Record<string, unknown>, string | undefined]> = [];
    const gate: ToolApprovalFn = async (_t, _a, name, input) => {
      const secret = secretPathVerdict(name, input, { workdir: work, configDir })?.action;
      asked.push([name, input, secret]);
      return secret === "deny" ? { behavior: "deny", message: "holds credentials" } : { behavior: "allow" };
    };
    const call = async (tool: string, input: Record<string, unknown>) => {
      const p = new OpencodeProvider({ sessionId: `it-tilde-${Math.random().toString(36).slice(2)}`, initialBackingId: "it-tilde", server: own, store: { setClaudeCodeSessionId: () => {} } as unknown as Store });
      asked.length = 0;
      const events = await collect(p.runTurn(opts(`[[tool:${tool} ${JSON.stringify(input)}]]`, { workdir: work, canUseTool: gate })));
      await p.teardown();
      return events.filter((e) => e.type === "tool_complete").map((e) => (e as Extract<ProviderEvent, { type: "tool_complete" }>).output).join("\n");
    };
    try {
      expect(await call("grep", { pattern: "apiKey", path: "~/.codeoid/config.json" })).not.toContain("zid_sk_IT_TILDE");
      expect(asked).toEqual([
        ["opencode_external_directory", { directories: [configDir], tool: "grep" }, "ask"],
        ["Grep", { pattern: "apiKey", path: join(configDir, "config.json") }, "deny"],
      ]);
      await call("glob", { pattern: "*", path: "~/.codeoid" });
      expect(asked.map(([name, input, secret]) => [name, input.path ?? input.directories, secret])).toEqual([
        ["opencode_external_directory", [configDir], "ask"],
        ["Glob", configDir, "ask"],
      ]);
      expect(await call("shell", { command: "pwd", description: "where", workdir: "~/.codeoid" })).toContain(configDir);
      expect(asked.at(-1)?.[1]).toMatchObject({ command: "pwd", cwd: configDir });
      expect(await call("shell", { command: "pwd", description: "where", background: "true" })).toContain("background");
      expect(asked).toEqual([["Bash", { command: "pwd", description: "where", run_in_background: true }, undefined]]);
    } finally {
      await own.stop();
      rmSync(root, { recursive: true, force: true });
    }
  }, 300_000);

  maybeScripted("I37 the user's own opencode config: a provider package opencode doesn't bundle never loads; a relative `{file:}` is the user's, not the workdir's", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "codeoid-opencode-usercfg-")));
    const user = join(root, "user-config");
    const work = join(root, "work");
    mkdirSync(user);
    mkdirSync(work);
    const marker = join(root, "module-loaded");
    // Loaded into the server, it would leave the marker.
    writeFileSync(join(user, "module.mjs"), `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(marker)}, "loaded\\n");\nexport function createX() {}\n`);
    const url = (modelProviders!.scripted as { settings: { baseURL: string } }).settings.baseURL;
    writeFileSync(join(user, "gw-url"), `${url}\n`);
    // A repository's file of the same name: nothing answers there.
    writeFileSync(join(work, "gw-url"), "http://127.0.0.1:1/v1\n");
    const models = { "scripted-1": { name: "Scripted 1", capabilities: { tools: true }, limit: { context: 64_000, output: 4_096 } } };
    writeFileSync(
      join(user, "opencode.json"),
      JSON.stringify({
        providers: {
          gw: { name: "Gateway", package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: "{file:gw-url}", apiKey: "scripted" }, models },
          local: { name: "Local", package: `file://${join(user, "module.mjs")}`, settings: { baseURL: url, apiKey: "scripted" }, models },
        },
      }),
    );
    const own = new OpencodeServer({
      command: resolved!.command,
      argsPrefix: resolved!.argsPrefix,
      dbPath: join(root, "data", "opencode", "opencode.db"),
      dataDir: join(root, "oc-files"),
      userConfigDir: user,
    });
    const turn = async (model: string) => {
      const p = new OpencodeProvider({ sessionId: `it-usercfg-${Math.random().toString(36).slice(2)}`, initialBackingId: "it-usercfg", server: own, store: { setClaudeCodeSessionId: () => {} } as unknown as Store });
      const events = await collect(p.runTurn(opts("[[text:from the user's gateway]]", { workdir: work, model })));
      await p.teardown();
      return [texts(events), events.find((e) => e.type === "error") !== undefined];
    };
    try {
      expect(await turn("gw/scripted-1")).toEqual([["from the user's gateway"], false]);
      expect((await turn("local/scripted-1"))[1]).toBe(true);
      expect(existsSync(marker)).toBe(false);
    } finally {
      await own.stop();
      rmSync(root, { recursive: true, force: true });
    }
  }, 180_000);

  maybeScripted("I38 an execution that fails while a steer waits says why, and opencode runs the steer next", async () => {
    const p = provider();
    await collect(p.runTurn(opts("[[text:warm]]")));
    const run = p.runTurn(opts("[[slow:2500]] [[fail:400]]"));
    setTimeout(() => run.pushMidTurn?.("[[text:steered]]", "now"), 800);
    const events = await collect(run, (e) => e.type === "error" || (e.type === "turn_done" && e.result.stopReason !== "steered"));
    const kinds = events.filter((e) => e.type === "custom_message" || e.type === "turn_done" || e.type === "error");
    expect(kinds.map((e) => (e.type === "turn_done" ? e.result.stopReason : e.type))).toEqual(["custom_message", "steered", "stop"]);
    expect((kinds[0] as Extract<ProviderEvent, { type: "custom_message" }>).metadata).toMatchObject({
      event: "opencode.execution_failed",
      detail: { type: "provider.invalid-request", status: 400 },
    });
    expect(texts(events).at(-1)).toBe("steered");
    await p.teardown();
  }, 180_000);

  maybeScripted("I41 an execution that fails while a `later` message waits says why, and opencode answers the message in the same turn", async () => {
    const p = provider();
    const adopted: string[] = [];
    p.onSessionEvent = (e) => adopted.push(e.type);
    await collect(p.runTurn(opts("[[text:warm]]")));
    const run = p.runTurn(opts("[[slow:2500]] [[fail:400]]"));
    setTimeout(() => run.pushMidTurn?.("[[text:queued]]", "later"), 800);
    const events = await collect(run, (e) => e.type === "error" || e.type === "turn_done");
    const kinds = events.filter((e) => e.type === "custom_message" || e.type === "turn_done" || e.type === "error");
    expect(kinds.map((e) => (e.type === "turn_done" ? e.result.stopReason : e.type))).toEqual(["custom_message", "stop"]);
    expect((kinds[0] as Extract<ProviderEvent, { type: "custom_message" }>).metadata).toMatchObject({
      event: "opencode.execution_failed",
      detail: { status: 400 },
    });
    expect(texts(events).at(-1)).toBe("queued");
    await Bun.sleep(500);
    expect(adopted.filter((t) => t === "turn_started")).toEqual([]);
    await p.teardown();
  }, 180_000);

  maybeScripted("I39 an effort reset reaches an opencode session resumed on a higher effort", async () => {
    const a = provider();
    await collect(a.runTurn(opts("[[text:one]]")));
    const effort = (await a.listModels()).find((m) => m.id === MODEL)?.efforts?.at(-1);
    expect(effort).toBeDefined();
    await collect(a.runTurn(opts("[[text:two]]", { effort })));
    const ses = a.backingSessionId;
    await a.teardown();
    const conn = await server!.ensure();
    expect((await conn.client.getSession(ses)).model?.variant).toBe(effort);
    // As after a daemon restart: a new provider resumes it, on the default
    // effort and with no model picked (the session's own model stands).
    const b = provider({ initialBackingId: ses });
    await collect(b.runTurn(opts("[[text:three]]", { model: undefined })));
    expect((await conn.client.getSession(ses)).model?.variant).toBe("default");
    await b.teardown();
  }, 180_000);

  maybeScripted("I40 a workdir inside a git checkout: a read or search elsewhere in it isn't a safe Read; an approved directory isn't asked twice", async () => {
    // opencode asks external_directory only outside the git checkout the
    // workdir is in; guarded mode auto-approves Read/Grep/Glob.
    const root = realpathSync(mkdtempSync(join(tmpdir(), "codeoid-opencode-checkout-")));
    const asked: string[] = [];
    const guarded: ToolApprovalFn = async (_t, _a, name) => {
      asked.push(name);
      return name === "Read" || name === "Grep" || name === "Glob" ? { behavior: "allow" } : { behavior: "deny", message: "not approved" };
    };
    const layout = (name: string, git: boolean) => {
      const home = join(root, name);
      mkdirSync(join(home, "projects", "app"), { recursive: true });
      mkdirSync(join(home, ".ssh"));
      writeFileSync(join(home, ".ssh", "id_ed25519"), "KEY-DECOY\n");
      if (git) expect(Bun.spawnSync(["git", "init", "-q", home]).exitCode).toBe(0);
      return join(home, "projects", "app");
    };
    try {
      const work = layout("git-home", true);
      for (const call of [
        { tool: "read", input: { path: "../../.ssh/id_ed25519" } },
        { tool: "grep", input: { pattern: "KEY-DECOY", path: "../.." } },
      ]) {
        const p = provider();
        asked.length = 0;
        const events = await collect(p.runTurn(opts(`[[tool:${call.tool} ${JSON.stringify(call.input)}]]`, { workdir: work, canUseTool: guarded })));
        expect(asked).toEqual(["opencode_external_directory"]);
        expect(events.some((e) => e.type === "tool_complete" && e.output.includes("KEY-DECOY"))).toBe(false);
        await p.teardown();
      }
      // Outside every boundary opencode asks first; approving that is enough.
      const plain = layout("plain-home", false);
      const p = provider();
      asked.length = 0;
      const events = await collect(
        p.runTurn(
          opts(`[[tool:read ${JSON.stringify({ path: "../../.ssh/id_ed25519" })}]]`, {
            workdir: plain,
            canUseTool: async (_t, _a, name) => {
              asked.push(name);
              return { behavior: "allow" };
            },
          }),
        ),
      );
      expect(asked).toEqual(["opencode_external_directory", "Read"]);
      expect(events.some((e) => e.type === "tool_complete" && e.output.includes("KEY-DECOY"))).toBe(true);
      await p.teardown();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 300_000);

  maybeScripted("I42 arguments sent as a JSON string: a search through a workspace symlink is still asked as an external directory, and a write's card shows its content", async () => {
    // opencode announces such a call's input as `{ value: "<json>" }` and runs the object it holds.
    const root = realpathSync(mkdtempSync(join(tmpdir(), "codeoid-opencode-strargs-")));
    const outside = join(root, "outside");
    const work = join(root, "work");
    mkdirSync(outside);
    mkdirSync(work);
    writeFileSync(join(outside, "id_ed25519"), "KEY-DECOY\n");
    symlinkSync(outside, join(work, "docs"));
    const cards: Array<{ name: string; input: Record<string, unknown> }> = [];
    const guarded: ToolApprovalFn = async (_t, _a, name, input) => {
      cards.push({ name, input });
      return name === "Read" || name === "Grep" || name === "Glob" ? { behavior: "allow" } : { behavior: "deny", message: "not approved" };
    };
    try {
      for (const [tool, input] of [
        ["grep", { pattern: "KEY-DECOY", path: "docs" }],
        ["glob", { pattern: "*", path: "docs" }],
      ] as const) {
        const p = provider();
        cards.length = 0;
        const events = await collect(p.runTurn(opts(`[[tool:${tool} ${JSON.stringify(JSON.stringify(input))}]]`, { workdir: work, canUseTool: guarded })));
        expect(cards.map((c) => c.name)).toEqual(["opencode_external_directory"]);
        expect(events.some((e) => e.type === "tool_complete" && /KEY-DECOY|id_ed25519/.test(e.output))).toBe(false);
        await p.teardown();
      }
      const p = provider();
      cards.length = 0;
      await collect(p.runTurn(opts(`[[tool:write ${JSON.stringify(JSON.stringify({ path: "a.txt", content: "THE-CONTENT" }))}]]`, { workdir: work, canUseTool: guarded })));
      expect(cards).toEqual([{ name: "Write", input: { file_path: join(work, "a.txt"), content: "THE-CONTENT" } }]);
      await p.teardown();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 300_000);

  maybeScripted("I43 a background subagent's question is withdrawn when the subagent is stopped: opencode settled it, no dialog is left", async () => {
    const question = { questions: [{ question: "Pick a color", header: "Color", options: [{ label: "Red", description: "warm" }, { label: "Blue", description: "cool" }] }] };
    const sub = { agent: "general", description: "child asks", prompt: `[[tool:question ${JSON.stringify(question)}]]`, background: true };
    const p = provider();
    const signals: AbortSignal[] = [];
    await collect(
      p.runTurn(
        opts(`[[tool:subagent ${JSON.stringify(sub)}]]`, {
          requestUserInput: (req) =>
            new Promise((resolve) => {
              signals.push(req.signal!);
              req.signal?.addEventListener("abort", () => resolve({ cancelled: true, reason: "withdrawn" }));
            }),
        }),
      ),
    );
    for (let i = 0; i < 100 && signals.length === 0; i++) await Bun.sleep(100);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.aborted).toBe(false);
    const conn = await server!.ensure();
    const children = await conn.client.childSessions(p.backingSessionId);
    expect(await p.stopBackgroundTasks(children.map((c) => c.id))).toEqual([]);
    for (let i = 0; i < 50 && !signals[0]!.aborted; i++) await Bun.sleep(100);
    expect(signals[0]!.aborted).toBe(true);
    for (const c of children) expect(await conn.client.pendingForms(c.id)).toEqual([]);
    await p.teardown();
  }, 180_000);

  maybeScripted("I44 a workspace symlink to /proc/self/cwd, codeoid started inside the workdir: a read, search or write through it is refused, never a Read on the server's files", async () => {
    // In codeoid's process the link leads into the workdir; in opencode's, to its own cwd (beside the database).
    const root = realpathSync(mkdtempSync(join(tmpdir(), "codeoid-opencode-procself-")));
    const work = join(root, "work");
    const decoy = join(dirname(DB), "codeoid-i44-decoy.key");
    mkdirSync(work);
    mkdirSync(dirname(DB), { recursive: true });
    writeFileSync(decoy, "PROC-DECOY\n");
    symlinkSync("/proc/self/cwd", join(work, "docs"));
    // Round 15: `..` in a link's target is taken physically, after the link (/proc/sys, up to /proc, then self/cwd) …
    symlinkSync("/proc/sys", join(work, "sub"));
    symlinkSync("sub/../self/cwd", join(work, "x"));
    // … and up out of a link into the server's cwd (its config dir is always there).
    mkdirSync(join(dirname(DB), "config"), { recursive: true });
    symlinkSync("/proc/self/cwd/config", join(work, "a"));
    symlinkSync("a/..", join(work, "l"));
    symlinkSync("a/../codeoid-i44-decoy.key", join(work, "lf"));
    writeFileSync(join(work, "plain.txt"), "PLAIN\n");
    const cards: Array<{ name: string; input: Record<string, unknown> }> = [];
    const guarded: ToolApprovalFn = async (_t, _a, name, input) => {
      cards.push({ name, input });
      return name === "Read" || name === "Grep" || name === "Glob" ? { behavior: "allow" } : { behavior: "deny", message: "not approved" };
    };
    const cwd = process.cwd();
    process.chdir(work);
    try {
      // An absolute path with `..` after a missing component: opencode collapses it, and so does the judge.
      const missing = `${work}/nonexist/../docs`;
      for (const [tool, input] of [
        ["read", { path: "docs/codeoid-i44-decoy.key" }],
        ["grep", { pattern: "PROC-DECOY", path: "docs" }],
        ["glob", { pattern: "*.key", path: "docs" }],
        ["write", { path: "docs/codeoid-i44-planted.txt", content: "planted" }],
        ["grep", { pattern: "PROC-DECOY", path: missing }],
        ["glob", { pattern: "*.key", path: missing }],
        ["shell", { command: "ls", workdir: missing, description: "list" }],
        ["read", { path: "x/codeoid-i44-decoy.key" }],
        ["grep", { pattern: "PROC-DECOY", path: "x" }],
        ["write", { path: "x/codeoid-i44-planted.txt", content: "planted" }],
        ["shell", { command: "ls", workdir: "x", description: "list" }],
        ["read", { path: "l/codeoid-i44-decoy.key" }],
        ["read", { path: "lf" }],
        ["grep", { pattern: "PROC-DECOY", path: "l" }],
        ["glob", { pattern: "*.key", path: "l" }],
        ["write", { path: "l/codeoid-i44-planted.txt", content: "planted" }],
        ["shell", { command: "ls", workdir: "l", description: "list" }],
      ] as const) {
        const p = provider();
        cards.length = 0;
        const events = await collect(p.runTurn(opts(`[[tool:${tool} ${JSON.stringify(input)}]]`, { workdir: work, canUseTool: guarded })));
        expect(cards).toEqual([]);
        expect(events.some((e) => e.type === "tool_complete" && e.output.includes("somewhere else in opencode's process"))).toBe(true);
        expect(events.some((e) => e.type === "tool_complete" && !e.output.startsWith("Declined") && /PROC-DECOY|codeoid-i44-decoy/.test(e.output))).toBe(false);
        await p.teardown();
      }
      expect(existsSync(join(dirname(DB), "codeoid-i44-planted.txt"))).toBe(false);
      // A path that can't be resolved for certain is asked, with the reason, never shown as a Read.
      const p = provider();
      cards.length = 0;
      await collect(p.runTurn(opts(`[[tool:grep ${JSON.stringify({ pattern: "PLAIN", path: `${work}/nonexist/../plain.txt` })}]]`, { workdir: work, canUseTool: guarded })));
      expect(cards.map((c) => c.name)).toEqual(["opencode_unresolved_path"]);
      expect(cards[0]!.input).toMatchObject({ tool: "grep", paths: [join(work, "plain.txt")] });
      await p.teardown();
    } finally {
      process.chdir(cwd);
      rmSync(decoy, { force: true });
      rmSync(root, { recursive: true, force: true });
    }
  }, 300_000);

  maybeScripted("I45 a write through a link whose target goes up out of another link's target: the card names the file opencode really creates", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "codeoid-opencode-linkup-")));
    const work = join(root, "work");
    const outside = join(root, "outside");
    mkdirSync(work);
    mkdirSync(outside);
    symlinkSync(outside, join(work, "out"));
    // The kernel takes `..` after following `out`: <root>/i45-planted.txt, outside the workdir.
    symlinkSync("out/../i45-planted.txt", join(work, "lw"));
    const cards: Array<{ name: string; input: Record<string, unknown> }> = [];
    const allow: ToolApprovalFn = async (_t, _a, name, input) => {
      cards.push({ name, input });
      return { behavior: "allow" };
    };
    try {
      const p = provider();
      await collect(p.runTurn(opts(`[[tool:write ${JSON.stringify({ path: "lw", content: "planted" })}]]`, { workdir: work, canUseTool: allow })));
      expect(cards).toEqual([{ name: "Write", input: { file_path: join(root, "i45-planted.txt"), content: "planted", requested_path: join(work, "lw") } }]);
      expect(readFileSync(join(root, "i45-planted.txt"), "utf8")).toBe("planted");
      await p.teardown();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 180_000);

  maybeScripted("I46 an interrupt in a feed gap longer than the interrupt's settle wait: the turn is read back, its card settled and its step billed to it", async () => {
    const p = provider();
    await collect(p.runTurn(opts("[[text:warm]]")));
    const conn = await server!.ensure();
    const ses = p.backingSessionId;
    const before = (await conn.client.getSession(ses)).cost ?? 0;
    let run: TurnRun | null = null;
    // The feed is cut while the call waits at the gate, the turn interrupted, and the feed kept down past the settle wait (5s).
    const gate: ToolApprovalFn = () => {
      cutFeed();
      setTimeout(() => void run?.interrupt(), 300);
      setTimeout(restoreFeed, 9_000);
      return new Promise(() => {});
    };
    run = p.runTurn(opts(`[[tool:shell ${JSON.stringify({ command: "echo never", description: "x" })}]]`, { canUseTool: gate }));
    const events = await collect(run);
    restoreFeed();
    const result = done(events)!;
    expect(result.stopReason).toBe("interrupted");
    const card = events.find((e) => e.type === "tool_start");
    expect(card).toBeDefined();
    expect(events.some((e) => e.type === "tool_complete" && e.sdkToolUseId === (card as Extract<ProviderEvent, { type: "tool_start" }>).sdkToolUseId)).toBe(true);
    // The aborted step is this turn's, not the next one's.
    const after = (await conn.client.getSession(ses)).cost ?? 0;
    expect(after - before).toBeGreaterThan(0);
    expect(result.totalCostUsd).toBeCloseTo(after - before, 9);
    const next = done(await collect(p.runTurn(opts("[[text:after]]"))))!;
    expect(next.totalCostUsd).toBeCloseTo(((await conn.client.getSession(ses)).cost ?? 0) - after, 9);
    await p.teardown();
  }, 180_000);

  maybeScripted("I47 a provider error opencode retries: the first retry is attempt 1, and the failed request bills nothing", async () => {
    const p = provider();
    await collect(p.runTurn(opts("[[text:warm]]")));
    const conn = await server!.ensure();
    const before = (await conn.client.getSession(p.backingSessionId)).cost ?? 0;
    const run = p.runTurn(opts("[[fail:503]]"));
    const events = await collect(run, (e) => {
      if (e.type === "api_retry") void run.interrupt();
      return e.type === "turn_done" || e.type === "error";
    });
    expect(events.find((e) => e.type === "api_retry")).toMatchObject({ attempt: 1, errorStatus: 503 });
    expect(done(events)?.totalCostUsd ?? 0).toBe(0);
    expect(((await conn.client.getSession(p.backingSessionId)).cost ?? 0) - before).toBe(0);
    await p.teardown();
  }, 180_000);

  maybeScripted("I48 a model opencode prices at $0: its $0 isn't a price — Session prices the tokens (#430)", async () => {
    const p = provider();
    const model = "scripted/scripted-free";
    await collect(p.runTurn(opts("[[text:first]]", { model })));
    // Past the first prompt's title: every step of the turn is on the $0 model.
    const r = done(await collect(p.runTurn(opts("[[text:second]]", { model }))))!;
    expect(r.model).toBe(model);
    expect(r.totalCostUsd).toBe(0);
    expect(r.inputTokens).toBeGreaterThan(0);
    expect(r.costSource).toBeUndefined();
    await p.teardown();
  }, 180_000);

  maybe("I32 the user's own opencode data, state, cache and temp dirs are untouched by the whole run", () => {
    expect(userOpencodeDirs()).toBe(USER_DIRS_BEFORE);
  });
});
