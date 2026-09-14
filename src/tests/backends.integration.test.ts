/**
 * Cross-backend session integration — opt-in, against REAL backends.
 *
 * Proves the two things a meta-harness must never get wrong, with the actual
 * agent binaries/SDKs (not fakes), through the real SessionManager verbs:
 *
 *   FRESH   — a brand-new session on each backend takes a turn and replies.
 *   RESUME  — a conversation STARTED on backend S, then forked onto a
 *             DIFFERENT backend T, carries its history: T answers a question
 *             about a fact only established during S's turn. This is codeoid's
 *             headline promise ("branch claude, continue on codex") and it
 *             exercises the exact seedFromHistory path fork/switch use.
 *
 * Gated: skipped unless CODEOID_INTEGRATION=1. The backends exercised come
 * from CODEOID_INTEGRATION_BACKENDS (comma list, default "claude,codex") and
 * MUST be installed + authenticated on the runner. Example:
 *
 *   CODEOID_INTEGRATION=1 CODEOID_INTEGRATION_BACKENDS=claude,codex,pi \
 *     bun test src/tests/backends.integration.test.ts
 *
 * Verified locally against claude (Agent SDK) + codex (@openai/codex@0.144.1):
 * fresh turns reply, and claude↔codex resume carries the fact both ways.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../daemon/store.js";
import { TranscriptStore } from "../daemon/transcript.js";
import { SessionManager } from "../daemon/session-manager.js";
import { createDefaultProviderRegistry } from "../daemon/providers/registry.js";
import { MemoryEngine } from "@highflame/codeoid-memory/engine.js";
import { SqliteEpisodeStore } from "@highflame/codeoid-memory/store.js";
import { createEmbedder } from "@highflame/codeoid-memory/embedder.js";
import { MemoryMcpHttp, MEMORY_MCP_PATH } from "@highflame/codeoid-memory/mcp-http.js";
import { ALL_SCOPES } from "../protocol/scopes.js";
import type { AuthContext, DaemonMessage } from "../protocol/types.js";

const RUN = process.env.CODEOID_INTEGRATION === "1";
const BACKENDS = (process.env.CODEOID_INTEGRATION_BACKENDS ?? "claude,codex")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const AUTH: AuthContext = {
  sub: "user:it",
  scopes: [...ALL_SCOPES] as AuthContext["scopes"],
  delegationDepth: 0,
  accountId: "acc-it",
  projectId: "proj-it",
};

let tmp: string;
let store: Store;
let transcript: TranscriptStore;
let manager: SessionManager;
let available: string[] = [];

beforeAll(() => {
  if (!RUN) {
    // eslint-disable-next-line no-console
    console.log("[backends integration] SKIPPED — set CODEOID_INTEGRATION=1 (+ authed backends) to run.");
    return;
  }
  tmp = mkdtempSync(join(tmpdir(), "codeoid-backends-it-"));
  store = new Store(join(tmp, "codeoid.db"));
  transcript = new TranscriptStore(join(tmp, "transcripts"));
  // Enable the binary backends; claude is always registered, gemini/openai
  // gate on their keys inside createDefaultProviderRegistry.
  const registry = createDefaultProviderRegistry({
    providers: { codex: { enabled: true }, pi: { enabled: true } },
  } as never);
  manager = new SessionManager(store, transcript, undefined, undefined, undefined, {
    providers: registry,
  } as never);
  available = BACKENDS.filter((id) => registry.has(id));
  const missing = BACKENDS.filter((id) => !registry.has(id));
  if (missing.length > 0) {
    // eslint-disable-next-line no-console
    console.log(`[backends integration] requested but NOT available (skipping those): ${missing.join(", ")}`);
  }
});

afterAll(async () => {
  if (!RUN) return;
  // No arbitrary settle delay: every turn was awaited to idle via
  // sendAndSettle, and flush() drains queued transcript writes.
  try {
    await transcript.flush();
  } catch {}
  try {
    store.close();
  } catch {}
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {}
});

// ── Harness ────────────────────────────────────────────────────────────────

function makeClient(): { id: string; auth: AuthContext; received: DaemonMessage[]; send: (m: DaemonMessage) => void } {
  const received: DaemonMessage[] = [];
  return { id: randomUUID(), auth: AUTH, received, send: (m) => received.push(m) };
}

type Client = ReturnType<typeof makeClient>;

async function createOn(c: Client, providerId: string): Promise<string> {
  const resp = await manager.handle(
    { type: "session.create", id: randomUUID(), name: providerId, workdir: tmp, providerId } as never,
    AUTH,
    c as never,
  );
  expect((resp as { type: string }).type).toBe("response.ok");
  return (resp as { data: { id: string } }).data.id;
}

/** Send a turn and wait for the session to return to idle (or error). */
async function sendAndSettle(c: Client, sessionId: string, text: string): Promise<void> {
  await manager.handle({ type: "session.attach", id: randomUUID(), sessionId } as never, AUTH, c as never);
  const start = c.received.length;
  await manager.handle({ type: "session.send", id: randomUUID(), sessionId, text } as never, AUTH, c as never);
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const settled = c.received
      .slice(start)
      .some((m) => m.type === "session.status_change" && ((m as { status: string }).status === "idle" || (m as { status: string }).status === "error"));
    if (settled) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`[${sessionId}] never settled after send`);
}

function partText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p) => (typeof p === "string" ? p : ((p as { text?: string }).text ?? ""))).join("");
  return "";
}

/** All assistant text broadcast for `sessionId` after index `since`. */
function assistantText(c: Client, sessionId: string, since: number): string {
  return c.received
    .slice(since)
    .filter((m) => m.type === "session.message" && (m as { sessionId: string }).sessionId === sessionId && (m as { role?: string }).role === "assistant")
    .map((m) => partText((m as { content: unknown }).content))
    .join("\n");
}

function assertNoError(c: Client, sessionId: string, since: number): void {
  const errs = c.received
    .slice(since)
    .filter(
      (m) =>
        m.type === "session.status_change" &&
        (m as { sessionId: string }).sessionId === sessionId &&
        (m as { status: string }).status === "error",
    );
  expect(errs.length, `backend errored during turn: ${JSON.stringify(errs)}`).toBe(0);
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("backends integration (real)", () => {
  (RUN ? it : it.skip)(
    "at least one requested backend is available",
    () => {
      expect(available.length).toBeGreaterThan(0);
    },
  );

  // FRESH: every enabled backend takes a brand-new turn and replies.
  for (const backend of BACKENDS) {
    (RUN ? it : it.skip)(
      `FRESH: ${backend} — a new session takes a turn and replies`,
      async () => {
        if (!available.includes(backend)) return; // requested but unavailable
        const c = makeClient();
        const sid = await createOn(c, backend);
        const since = c.received.length;
        await sendAndSettle(c, sid, "Reply with exactly the word: ok");
        assertNoError(c, sid, since);
        expect(assistantText(c, sid, since).toLowerCase()).toContain("ok");
      },
      150_000,
    );
  }

  // RESUME: fork a conversation from S onto a DIFFERENT backend T; T must
  // answer using the fact only established during S's turn.
  for (const source of BACKENDS) {
    for (const target of BACKENDS) {
      if (source === target) continue;
      (RUN ? it : it.skip)(
        `RESUME: ${source} → ${target} — forked backend recalls the fact`,
        async () => {
          if (!available.includes(source) || !available.includes(target)) return;
          const c = makeClient();
          const sid = await createOn(c, source);
          await sendAndSettle(c, sid, "My favorite number is 42. Reply with just: noted");

          const fork = await manager.handle(
            { type: "session.fork", id: randomUUID(), sessionId: sid, providerId: target } as never,
            AUTH,
            c as never,
          );
          expect((fork as { type: string }).type).toBe("response.ok");
          const forkData = (fork as { data: { id: string; providerId?: string } }).data;
          expect(forkData.providerId).toBe(target);

          const since = c.received.length;
          await sendAndSettle(c, forkData.id, "What is my favorite number? Reply with ONLY the number.");
          assertNoError(c, forkData.id, since);
          expect(assistantText(c, forkData.id, since)).toContain("42");
        },
        200_000,
      );
    }
  }
});

// ── RESUME-BEYOND-BUDGET (#178 Phase 1) — the strategy selector ────────────────
//
// The headline case: a session grows past the seed budget, so a forked backend
// seeded with a rendered transcript LOSES the oldest turns. The fact under test
// lives ONLY in the first turn — dropped by the transcript seed. Under the VWS
// strategy the fork is seeded with a compact session map instead, and the model
// pages the dropped turn back verbatim via the memory tools (recall/get_episode/
// timeline). This proves losslessness: dropped-from-context ≠ lost.
//
// Runs both strategies on the SAME beyond-budget history and forks onto claude
// (Phase 1 = the backend with the tools mounted). The flip criterion is:
//   VWS recalls the dropped fact  ∧  transcript does not.
// Incoming first-turn tokens are logged for the cost side of the comparison —
// the strict cost gate wants a full-window large history and is validated in the
// operator's env; here CODEOID_SEED_BUDGET_CHARS forces truncation cheaply.
//
// Gated: CODEOID_INTEGRATION=1 AND "claude" in CODEOID_INTEGRATION_BACKENDS.

const RUN_VWS = RUN && BACKENDS.includes("claude");
// A unique, unguessable token so a pass means genuine retrieval, not a lucky
// guess or a hallucination.
const SECRET = "CRIMSON-OTTER-8842";
const FILLERS = [
  "Summarize what a binary search does, in two sentences.",
  "Name three common HTTP status codes and what each means.",
  "What is the difference between a process and a thread? Keep it short.",
  "Give one reason to prefer composition over inheritance.",
  "In one sentence, what is idempotency in an HTTP API?",
];

/** Send a turn on a specific manager and wait for idle/error. */
async function sendAndSettleOn(mgr: SessionManager, c: Client, sessionId: string, text: string): Promise<void> {
  await mgr.handle({ type: "session.attach", id: randomUUID(), sessionId } as never, AUTH, c as never);
  const start = c.received.length;
  await mgr.handle({ type: "session.send", id: randomUUID(), sessionId, text } as never, AUTH, c as never);
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const settled = c.received
      .slice(start)
      .some((m) => m.type === "session.status_change" && ((m as { status: string }).status === "idle" || (m as { status: string }).status === "error"));
    if (settled) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`[${sessionId}] never settled after send`);
}

/** Largest lastTurnInputTokens broadcast for `sessionId` after index `since` (or -1). */
function firstTurnInputTokens(c: Client, sessionId: string, since: number): number {
  let max = -1;
  for (const m of c.received.slice(since)) {
    if (m.type !== "session.info_update") continue;
    const s = (m as { session?: { id?: string; usage?: { lastTurnInputTokens?: number } } }).session;
    if (s?.id !== sessionId) continue;
    const n = s.usage?.lastTurnInputTokens;
    if (typeof n === "number" && n > max) max = n;
  }
  return max;
}

interface StrategyOutcome {
  recalled: boolean;
  incomingInputTokens: number;
  answer: string;
}

/**
 * Build an isolated manager+memory, grow a beyond-budget claude session whose
 * first turn holds SECRET, fork onto `target` under `strategy` with a tiny seed
 * budget, then ask the fork for SECRET. Returns whether it was recovered.
 *
 * The source is always claude (it ingests every turn into memory); `target` is
 * the incoming backend under test. For URL-mounting targets (gemini-cli) the
 * shared MCP endpoint is served on a real loopback port and handed to the
 * manager, exactly as the daemon does — that is the mount the forked backend
 * pages the verbatim store through.
 */
async function runBeyondBudget(strategy: "transcript" | "vws", target = "claude"): Promise<StrategyOutcome> {
  const wd = mkdtempSync(join(tmpdir(), `codeoid-rbb-${strategy}-`));
  const st = new Store(join(wd, "codeoid.db"));
  const tr = new TranscriptStore(join(wd, "transcripts"));
  const memory = new MemoryEngine({ store: new SqliteEpisodeStore(join(wd, "mem.db")), embedder: await createEmbedder() });
  await memory.init();
  const registry = createDefaultProviderRegistry({ providers: { geminiCli: { enabled: true }, codex: { enabled: true } } } as never);
  const mgr = new SessionManager(st, tr, undefined, undefined, memory, { providers: registry } as never);

  // Serve the shared memory MCP endpoint on a real loopback port, like the
  // daemon does, so a URL-mounting fork target (gemini-cli) can page memory.
  const endpoint = new MemoryMcpHttp(memory);
  const mcpServer = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => endpoint.handle(req) });
  mgr.setMemoryMcp({ endpoint, url: `http://127.0.0.1:${mcpServer.port}${MEMORY_MCP_PATH}` });

  const prevStrategy = process.env.CODEOID_CONTEXT_STRATEGY;
  const prevBudget = process.env.CODEOID_SEED_BUDGET_CHARS;
  const prevMem = process.env.CODEOID_MEMORY;
  try {
    process.env.CODEOID_MEMORY = "1";
    const c = makeClient();

    // Source session on claude — memory ingests every turn.
    const create = await mgr.handle(
      { type: "session.create", id: randomUUID(), name: "rbb-source", workdir: wd, providerId: "claude" } as never,
      AUTH,
      c as never,
    );
    const sid = (create as { data: { id: string } }).data.id;

    // Turn 1 (oldest) — the ONLY place SECRET appears.
    await sendAndSettleOn(mgr, c, sid, `Please remember this exactly: the vault passphrase is ${SECRET}. Reply with just: stored`);
    // Filler turns push turn 1 outside the tiny seed budget.
    for (const q of FILLERS) await sendAndSettleOn(mgr, c, sid, q);

    // Fork onto the target under the chosen strategy, with a seed budget so small
    // the transcript keeps only the last turn or two — dropping the SECRET turn.
    process.env.CODEOID_CONTEXT_STRATEGY = strategy;
    process.env.CODEOID_SEED_BUDGET_CHARS = "600";
    const fork = await mgr.handle(
      { type: "session.fork", id: randomUUID(), sessionId: sid, providerId: target, isolate: false } as never,
      AUTH,
      c as never,
    );
    const forkId = (fork as { data: { id: string } }).data.id;

    const since = c.received.length;
    await sendAndSettleOn(
      mgr,
      c,
      forkId,
      "Earlier in this session I gave you a vault passphrase. It is preserved verbatim in codeoid memory — use recall/timeline/get_episode to retrieve it. Reply with ONLY the passphrase token.",
    );
    const answer = assistantText(c, forkId, since);
    return { recalled: answer.includes(SECRET), incomingInputTokens: firstTurnInputTokens(c, forkId, since), answer };
  } finally {
    if (prevStrategy === undefined) delete process.env.CODEOID_CONTEXT_STRATEGY; else process.env.CODEOID_CONTEXT_STRATEGY = prevStrategy;
    if (prevBudget === undefined) delete process.env.CODEOID_SEED_BUDGET_CHARS; else process.env.CODEOID_SEED_BUDGET_CHARS = prevBudget;
    if (prevMem === undefined) delete process.env.CODEOID_MEMORY; else process.env.CODEOID_MEMORY = prevMem;
    try { mcpServer.stop(true); } catch {}
    try { await memory.close(); } catch {}
    try { await tr.flush(); } catch {}
    try { st.close(); } catch {}
    try { rmSync(wd, { recursive: true, force: true }); } catch {}
  }
}

describe("resume-beyond-budget (real)", () => {
  (RUN_VWS ? it : it.skip)(
    "claude: VWS recovers a dropped early fact that the transcript seed loses",
    async () => {
      const transcript = await runBeyondBudget("transcript", "claude");
      const vws = await runBeyondBudget("vws", "claude");
      // eslint-disable-next-line no-console
      console.log(
        `[resume-beyond-budget claude] transcript: recalled=${transcript.recalled} incomingInputTokens=${transcript.incomingInputTokens} | ` +
          `vws: recalled=${vws.recalled} incomingInputTokens=${vws.incomingInputTokens}`,
      );
      // The flip criterion: VWS recovers the dropped fact …
      expect(vws.recalled).toBe(true);
      // … and the tiny budget genuinely dropped it from the transcript seed.
      expect(transcript.recalled).toBe(false);
    },
    600_000,
  );

  // Phase 2: same case with gemini-cli as the incoming backend — it pages the
  // verbatim store through the shared HTTP MCP endpoint mounted via ACP. Gated
  // additionally on gemini-cli being requested + authed.
  (RUN && BACKENDS.includes("gemini-cli") ? it : it.skip)(
    "gemini-cli: VWS recovers a dropped early fact via the mounted memory endpoint",
    async () => {
      if (!available.includes("gemini-cli")) return;
      const transcript = await runBeyondBudget("transcript", "gemini-cli");
      const vws = await runBeyondBudget("vws", "gemini-cli");
      // eslint-disable-next-line no-console
      console.log(
        `[resume-beyond-budget gemini-cli] transcript: recalled=${transcript.recalled} incomingInputTokens=${transcript.incomingInputTokens} | ` +
          `vws: recalled=${vws.recalled} incomingInputTokens=${vws.incomingInputTokens}`,
      );
      expect(vws.recalled).toBe(true);
      expect(transcript.recalled).toBe(false);
    },
    600_000,
  );

  // Phase 3: same case with codex as the incoming backend — it pages the
  // verbatim store through the shared HTTP MCP endpoint mounted via `-c
  // mcp_servers.*` overrides + a token env var. Gated on codex requested + authed.
  (RUN && BACKENDS.includes("codex") ? it : it.skip)(
    "codex: VWS recovers a dropped early fact via the mounted memory endpoint",
    async () => {
      if (!available.includes("codex")) return;
      const transcript = await runBeyondBudget("transcript", "codex");
      const vws = await runBeyondBudget("vws", "codex");
      // eslint-disable-next-line no-console
      console.log(
        `[resume-beyond-budget codex] transcript: recalled=${transcript.recalled} incomingInputTokens=${transcript.incomingInputTokens} | ` +
          `vws: recalled=${vws.recalled} incomingInputTokens=${vws.incomingInputTokens}`,
      );
      expect(vws.recalled).toBe(true);
      expect(transcript.recalled).toBe(false);
    },
    600_000,
  );
});
