/**
 * REAL `opencode serve` integration tests — opt-in.
 *
 * The offline suite (provider-opencode.test.ts) runs against fake-opencode,
 * which is built from opencode 2.2.2's OpenAPI spec and source but can't
 * catch where the real server differs. These tests drive codeoid's real
 * OpencodeServer + OpencodeProvider against the installed binary.
 *
 * Gated: skipped unless CODEOID_OPENCODE_INTEGRATION=1 AND opencode resolves.
 * The turn tests also need a model with a credential opencode can use:
 *
 *   CODEOID_OPENCODE_INTEGRATION=1 CODEOID_OPENCODE_MODEL=anthropic/claude-sonnet-4 \
 *     ANTHROPIC_API_KEY=… bun test src/tests/provider-opencode.integration.test.ts
 *
 * The database is a temp one unless CODEOID_OPENCODE_DB names one (stored
 * sign-ins live in opencode's database, so point it at codeoid's own to use
 * them: `OPENCODE_DB=<that path> opencode auth login` first).
 *
 *   I1  the server starts: version in range, password, the agent check, the DB where codeoid put it
 *   I2  catalogs decode: models (provider/model ids, variants), agents, commands
 *   I3  a text turn: text_done, turn_done with real cost and tokens, nativeRef
 *   I4  a shell call reaches the gate as Bash with the command; `once` runs it
 *   I5  a denial is fed back and the turn still completes
 *   I6  resume by ses_ id, and a native fork at the first turn
 */

import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpencodeProvider } from "../daemon/providers/opencode/index.js";
import { OpencodeServer } from "../daemon/providers/opencode/server.js";
import { resolveOpencodeCommand } from "../daemon/providers/opencode/resolve.js";
import type { ProviderEvent, ToolApprovalFn, TurnOpts, TurnRun } from "../daemon/providers/interface.js";
import type { Store } from "../daemon/store.js";

const resolved = resolveOpencodeCommand(process.env.CODEOID_OPENCODE_COMMAND);
const RUN = process.env.CODEOID_OPENCODE_INTEGRATION === "1" && resolved !== null;
const MODEL = process.env.CODEOID_OPENCODE_MODEL;
const maybe = RUN ? it : it.skip;
const maybeTurn = RUN && MODEL ? it : it.skip;

if (!RUN) {
  console.log(
    `[opencode integration] SKIPPED — set CODEOID_OPENCODE_INTEGRATION=1 and install opencode 2.2 to run (resolved=${resolved ? resolved.command : "none"}).`,
  );
} else if (!MODEL) {
  console.log("[opencode integration] turn tests SKIPPED — set CODEOID_OPENCODE_MODEL=provider/model (with its credential).");
}

const WORK = RUN ? mkdtempSync(join(tmpdir(), "codeoid-opencode-it-")) : "/tmp";
const DB = process.env.CODEOID_OPENCODE_DB ?? join(WORK, "data", "opencode", "opencode.db");
const server = RUN ? new OpencodeServer({ command: resolved!.command, argsPrefix: resolved!.argsPrefix, dbPath: DB }) : null;

afterAll(async () => {
  await server?.stop();
  if (RUN) rmSync(WORK, { recursive: true, force: true });
});

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

async function collect(run: TurnRun): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const e of run.events) {
    events.push(e);
    if (e.type === "turn_done" || e.type === "error") break;
  }
  return events;
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
  }, 60_000);

  maybeTurn("I3 a text turn streams, ends with real cost and tokens, and records where it ends", async () => {
    const p = provider();
    const events = await collect(p.runTurn(opts("Reply with exactly the word: pong")));
    const done = events.find((e) => e.type === "turn_done") as Extract<ProviderEvent, { type: "turn_done" }> | undefined;
    expect(events.find((e) => e.type === "error")).toBeUndefined();
    expect(events.some((e) => e.type === "text_done" && /pong/i.test(e.content))).toBe(true);
    expect(done!.result.inputTokens + done!.result.cacheReadTokens).toBeGreaterThan(0);
    expect(done!.result.totalCostUsd).toBeGreaterThanOrEqual(0);
    expect(done!.result.nativeRef?.ref).toMatch(/^msg_/);
    expect(p.backingSessionId).toMatch(/^ses/);
    await p.teardown();
  }, 180_000);

  maybeTurn("I4 a shell call reaches the gate as Bash with its command, and `once` runs it", async () => {
    const asked: Array<[string, Record<string, unknown>]> = [];
    const gate: ToolApprovalFn = async (_t, _a, name, input) => {
      asked.push([name, input]);
      return { behavior: "allow" };
    };
    const p = provider();
    const events = await collect(p.runTurn(opts("Use your shell tool to run: echo codeoid-it-ok — then say done.", { canUseTool: gate })));
    const shell = asked.find(([name]) => name === "Bash");
    expect(shell?.[1].command).toContain("echo codeoid-it-ok");
    const done = events.find((e) => e.type === "tool_complete") as Extract<ProviderEvent, { type: "tool_complete" }> | undefined;
    expect(done?.success).toBe(true);
    expect(done?.output).toContain("codeoid-it-ok");
    await p.teardown();
  }, 180_000);

  maybeTurn("I5 a denial reaches the model as feedback and the turn completes", async () => {
    const p = provider();
    const events = await collect(
      p.runTurn(opts("Use your shell tool to run: echo nope — if you can't, say blocked.", { canUseTool: async () => ({ behavior: "deny", message: "Blocked by the integration test" }) })),
    );
    expect(events.find((e) => e.type === "turn_done")).toBeDefined();
    expect(events.some((e) => e.type === "tool_complete" && e.success)).toBe(false);
    await p.teardown();
  }, 180_000);

  maybeTurn("I6 resumes by id, and forks natively at a turn", async () => {
    const p = provider();
    const first = await collect(p.runTurn(opts("Remember the number 41. Reply ok.")));
    const ref = (first.find((e) => e.type === "turn_done") as Extract<ProviderEvent, { type: "turn_done" }>).result.nativeRef!;
    const id = p.backingSessionId;
    await p.teardown();
    const resumed = provider({ initialBackingId: id });
    await collect(resumed.runTurn(opts("Reply ok again.")));
    expect(resumed.backingSessionId).toBe(id);
    await resumed.teardown();
    const fork = provider();
    expect(await fork.continueNatively({ history: [], forkFrom: ref, maxChars: 10_000, workdir: WORK })).toEqual({ via: "fork" });
    const answer = await collect(fork.runTurn(opts("What number did I ask you to remember? Reply with just the number.")));
    expect(answer.some((e) => e.type === "text_done" && e.content.includes("41"))).toBe(true);
    expect(fork.backingSessionId).not.toBe(id);
    await fork.teardown();
  }, 300_000);
});
