/**
 * fake-opencode — offline stand-in for `opencode serve --stdio --port 0`
 * (opencode 2.2.x), enough of its HTTP API to drive a codeoid session.
 *
 * Lifecycle like the real one: listens on 127.0.0.1, prints one JSON line
 * `{"url": ...}`, requires HTTP Basic `opencode:$OPENCODE_PASSWORD` on every
 * route, exits when stdin closes.
 *
 * Streams as the real 2.2.2 / 2.2.5 servers behave (see the real-binary
 * notes in provider-opencode.integration.test.ts):
 *   - the live feed (`/api/event`, `server.connected` first) carries
 *     everything: each session's durable events with their
 *     `durable: {aggregateID, seq}` envelope, and the ephemeral ones (deltas,
 *     permission asks, forms, `session.usage.updated` running totals);
 *   - the per-session durable log (`/api/experimental/session/:id/log`)
 *     replays nothing: without `follow` it sends only `log.synced`, with
 *     `follow=true` only heartbeats.
 * Like the real server, a session's first prompt also bills a title request
 * that no step reports (only the running total shows it, after the
 * execution ends), a queued input runs inside the running execution, a bare
 * reject interrupts the execution, a child session inherits its parent's
 * rules, and a background child's result resumes the parent through a
 * synthetic inbox item (a stopped one's too). An input still in the inbox
 * when an execution is interrupted stays there and is delivered with the
 * next prompt, unless it is withdrawn (`DELETE /api/session/:id/inbox/:inboxID`).
 * An interrupt drops the session's waiting permission requests (a
 * foreground child's too) without a `permission.replied`: each call fails
 * `aborted` "Tool execution interrupted", its step fails (billed), and the
 * execution ends interrupted.
 *
 * Turn behavior is keyed off the prompt text:
 *   default        → text deltas + text.ended, one step with cost/tokens
 *   "think"        → reasoning deltas + reasoning.ended first
 *   "use-shell"    → shell call; permission.asked; runs or fails per the reply
 *   "use-edit"     → edit call (path/oldString/newString) asking "edit"
 *   "use-webfetch" → a webfetch of https://docs.example/start, which redirects
 *                    to another site (169.254.169.254); "use-webfetch-same" to
 *                    the same one. As real 2.2.x: the hop is checked only
 *                    against the session's rules, never asked about
 *   "use-mcp"      → a call to this session's mounted codeoid_memory `recall`
 *   "foreign-mcp"  → a call to ANOTHER session's mount (must be rejected)
 *   "unknown-action" → a permission action codeoid doesn't know
 *   "ask-user"     → a question form; answers echoed back
 *   "subagent"     → foreground subagent in a child session (with a cost)
 *   "subagent-fail" → its child's step fails after the model answered (billed)
 *   "subagent-gapstart" → the child is created, starts and asks in a feed gap
 *   "subagent-gapend" → the feed drops once the child's call is approved, over
 *                    the rest of the child's run; back while the parent runs
 *   "background-gap" → a background child whose call is approved, then the
 *                    feed drops over the rest of its run and the parent's
 *                    follow-up execution, and is back after both ended
 *   "background"   → background subagent; opencode resumes the parent itself
 *   "slow"         → keeps stepping until interrupted
 *   "steer"        → waits for a steered input, then answers it
 *   "steer-gap"    → the feed drops after the first step; the steer is
 *                    delivered and answered in the gap, which closes while
 *                    the execution still runs
 *   "retry"        → session.retry.scheduled before answering
 *   "fail"         → execution.failed with a structured rate-limit error
 *   "costly"       → three steps of $2 each
 *   "compact"      → a step, an auto compaction of two requests ($0.002 +
 *                    $0.001, billed in the running total), another step
 *   "echo-state"   → reports model/agent/synthetic/prompt text it received
 *   "die-asking"   → asks a permission, then the process dies
 *   "use-codemode" → a Code Mode `execute` call. A session rule denying
 *                    `execute` hides the tool, so the call fails unrun (as on
 *                    real 2.2.x); with FAKE_OPENCODE_CODEMODE=1 it runs as on
 *                    2.2.5: asks nothing itself, its script fetches twice
 *                    (two `webfetch` asks naming the script's call)
 *   "gap"          → the live feed is cut (subscribers dropped) mid-turn and
 *                    the execution ends while nobody is connected
 *   "midgap"       → the feed is cut after a call is approved, over its
 *                    result and a whole step, and back while the execution
 *                    still runs
 *   "gap-open"     → a block ends in the gap, the feed is back while its
 *                    step still runs (a call follows in the same message)
 *   "gap-ask"      → a shell call and its permission request fall in the gap
 *   "lag-settle"   → the feed drops after a call is approved and comes back
 *                    behind: the call's result is stored before the late feed
 *                    delivers it
 *
 * Knobs (env): FAKE_OPENCODE_VERSION (default 2.2.5), FAKE_OPENCODE_STARTS
 * (append a line per start), FAKE_OPENCODE_UNSAFE_AGENT=1 (an `explore`
 * subagent that allows shell unless overridden), FAKE_OPENCODE_STUBBORN=1
 * (ignore agent overrides), FAKE_OPENCODE_SAVED=1 (one saved "always" rule),
 * FAKE_OPENCODE_CONFIG_COMMANDS=1|shadow (commands from a config dir, see
 * `commandsAt`), FAKE_OPENCODE_STEER_REPLY_MS (answer a steer's prompt request that long
 * after taking it, so its delivery comes first), FAKE_OPENCODE_STEER_FAIL=1
 * (refuse a steer request with a 500), FAKE_OPENCODE_SLOW_SYNTHETIC_MS
 * (answer a synthetic input that late), FAKE_OPENCODE_PLUGIN=1|late (a
 * plugin that isn't a built-in, listed from the start or once a prompt was
 * posted), FAKE_OPENCODE_AUTOALLOW=1|child (every permission request — or a
 * child session's only — is settled "once" without being published, as
 * such a plugin's hook does).
 * `GET /__fake/state` (test-only, no auth) returns everything recorded;
 * `POST /__fake/delete/<id>[?quiet=1]` deletes a session (quiet: no event);
 * `POST /__fake/tamper/<id>` sets its rules to allow-all and saves an "always".
 */

import { appendFileSync } from "node:fs";

const password = process.env.OPENCODE_PASSWORD ?? "";
const version = process.env.FAKE_OPENCODE_VERSION ?? "2.2.5";
const config = (() => {
  try {
    return JSON.parse(process.env.OPENCODE_CONFIG_CONTENT ?? "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
})();
if (process.env.FAKE_OPENCODE_STARTS) appendFileSync(process.env.FAKE_OPENCODE_STARTS, `${process.pid}\n`);

type Json = Record<string, unknown>;

interface Ses {
  id: string;
  parentID?: string;
  directory: string;
  permissions: Json[];
  agent?: string;
  model?: Json;
  messages: Array<{ id: string; type: string; content?: Json[]; time?: Json; [k: string]: unknown }>;
  log: Json[];
  seq: number;
  executing: boolean;
  cancel: (() => void) | null;
  inbox: Array<{ id: string; text: string; delivery: string }>;
  title?: string;
  fork?: Json;
  /** The running total `session.usage.updated` reports. */
  usage: { cost: number; input: number; output: number; reasoning: number; read: number; write: number };
  titled: boolean;
  /** A subagent's child session its parent's call waits on: the parent's interrupt stops it too. */
  foreground?: boolean;
  outcome?: string;
  busy?: number;
  idle?: number;
  created: number;
}

const state = {
  env: {
    OPENCODE_DB: process.env.OPENCODE_DB,
    OPENCODE_CONFIG_DIR: process.env.OPENCODE_CONFIG_DIR,
    OPENCODE_DISABLE_PROJECT_CONFIG: process.env.OPENCODE_DISABLE_PROJECT_CONFIG,
    OPENCODE_DISABLE_CLAUDE_CODE: process.env.OPENCODE_DISABLE_CLAUDE_CODE,
    passwordSet: password.length > 0,
    leakedUserVar: process.env.OPENCODE_USER_SETTING,
    leakedSecret: process.env.CODEOID_API_KEY,
  },
  config,
  argv: process.argv.slice(2),
  requests: [] as string[],
  replies: [] as Json[],
  formReplies: [] as Json[],
  modelSwitches: [] as Json[],
  agentSwitches: [] as Json[],
  synthetic: [] as Json[],
  prompts: [] as Json[],
  commands: [] as Json[],
  mcp: [] as Json[],
  mcpRemoved: [] as Json[],
  patches: [] as Json[],
  forks: [] as Json[],
  interrupts: [] as string[],
  inboxCancels: [] as string[],
  mcpPromptCalls: [] as Json[],
  shellRan: [] as string[],
  /** URLs a webfetch call really fetched (each redirect hop too). */
  fetched: [] as string[],
  saved: process.env.FAKE_OPENCODE_SAVED === "1" ? [{ id: "prm_1", action: "shell", resource: "git *" }] : ([] as Json[]),
  savedRemoved: [] as string[],
};

const sessions = new Map<string, Ses>();
const mounts = new Map<string, Map<string, Json>>(); // directory → name → config
const pendingPerms = new Map<string, { req: Json; resolve: (r: { decision: string; message?: string }) => void }>();
const pendingForms = new Map<string, { form: Json; resolve: (r: { answer?: Json; cancelled?: string }) => void }>();
let counter = 0;
const nextId = (p: string) => `${p}_${String(++counter).padStart(6, "0")}`;

// ── Streams ────────────────────────────────────────────────────────────────

const enc = new TextEncoder();
const liveSubs = new Set<{ push: (e: Json) => void; types: Set<string> | null; close: () => void }>();
/** "gap": while set, the live feed is down — nobody is subscribed and new connections wait. */
let feedDown: Promise<void> | null = null;

function sseResponse(start: (push: (e: Json) => void, close: () => void) => () => void): Response {
  let stop = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const push = (e: Json) => {
        try {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
        } catch {
          /* closed */
        }
      };
      const close = () => {
        try {
          controller.close();
        } catch {
          /* closed */
        }
      };
      stop = start(push, close);
    },
    cancel() {
      stop();
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream" } });
}

function publishLive(e: Json): void {
  if (backlog) {
    backlog.push(e);
    return;
  }
  for (const s of liveSubs) if (!s.types || s.types.has(String(e.type))) s.push(e);
}

/** "lag": what the feed holds back — a reconnected server-wide feed can be behind a direct read. */
let backlog: Json[] | null = null;
const LAG_MS = 400;

/**
 * Drop the feed as `dropFeed` does, but lose nothing: what is published until
 * the feed is back, and for LAG_MS after, reaches the new connection late.
 */
function lagFeed(): () => void {
  const up = dropFeed();
  backlog = [];
  return () => {
    up();
    setTimeout(() => {
      const held = backlog ?? [];
      backlog = null;
      for (const e of held) publishLive(e);
    }, LAG_MS);
  };
}

/** A durable session event. The real log endpoint never delivers these: the live feed does. */
function durable(ses: Ses, type: string, data: Json): void {
  ses.seq++;
  const e = { id: nextId("evt"), type, created: Date.now(), location: { directory: ses.directory }, data: { sessionID: ses.id, ...data }, durable: { aggregateID: ses.id, seq: ses.seq, version: 1 } };
  ses.log.push(e);
  publishLive(e);
}

/** Add to a session's running total and publish it, as opencode does after each step. */
function bill(ses: Ses, cost: number, tokens: Json): void {
  const t = tokens as { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } };
  ses.usage.cost += cost;
  ses.usage.input += t.input ?? 0;
  ses.usage.output += t.output ?? 0;
  ses.usage.reasoning += t.reasoning ?? 0;
  ses.usage.read += t.cache?.read ?? 0;
  ses.usage.write += t.cache?.write ?? 0;
  const u = ses.usage;
  ephemeral("session.usage.updated", { sessionID: ses.id, cost: u.cost, tokens: { input: u.input, output: u.output, reasoning: u.reasoning, cache: { read: u.read, write: u.write } } });
}

/** What opencode bills for the title it generates on a session's first prompt. */
const TITLE_COST = 0.0007;
const TITLE_TOKENS = { input: 40, output: 6, reasoning: 0, cache: { read: 0, write: 0 } };

/** An ephemeral event: live feed only. */
function ephemeral(type: string, data: Json): void {
  publishLive({ id: nextId("evt"), type, created: Date.now(), data });
}

// ── Model catalog ─────────────────────────────────────────────────────────

const MODELS = [
  {
    id: "claude-sonnet-4",
    providerID: "anthropic",
    name: "Claude Sonnet 4",
    variants: [{ id: "high" }, { id: "max" }],
    enabled: true,
    status: "active",
    limit: { context: 200_000, output: 64_000 },
    capabilities: { tools: true, input: ["text"], output: ["text"] },
  },
  {
    id: "gpt-5",
    providerID: "openai",
    name: "GPT-5",
    variants: [{ id: "minimal" }, { id: "low" }, { id: "medium" }, { id: "high" }, { id: "fancy" }],
    enabled: true,
    status: "active",
    limit: { context: 400_000, output: 128_000 },
    capabilities: { tools: true, input: ["text"], output: ["text"] },
  },
  {
    id: "no-key",
    providerID: "mistral",
    name: "Mistral (no credential)",
    variants: [],
    enabled: false,
    status: "active",
    limit: { context: 32_000, output: 8_000 },
    capabilities: { tools: true, input: ["text"], output: ["text"] },
  },
];

function agents(): Json[] {
  const global = (config.permissions as Json[] | undefined) ?? [];
  const overrides = (config.agents as Record<string, { permissions?: Json[] }> | undefined) ?? {};
  const own = (id: string) => (process.env.FAKE_OPENCODE_STUBBORN === "1" ? [] : (overrides[id]?.permissions ?? []));
  const list: Json[] = [
    { id: "build", name: "Build", mode: "primary", hidden: false, permissions: [{ action: "*", resource: "*", effect: "allow" }, ...global, ...own("build")] },
    { id: "plan", name: "Plan", mode: "primary", hidden: false, permissions: [...global, { action: "edit", resource: "*", effect: "deny" }, ...own("plan")] },
  ];
  list.push({
    id: "explore",
    name: "Explore",
    mode: "subagent",
    hidden: false,
    permissions:
      process.env.FAKE_OPENCODE_UNSAFE_AGENT === "1"
        ? [...global, { action: "*", resource: "*", effect: "deny" }, { action: "shell", resource: "*", effect: "allow" }, { action: "read", resource: "*", effect: "allow" }, ...own("explore")]
        : [...global, { action: "*", resource: "*", effect: "deny" }, ...own("explore")],
  });
  return list;
}

// ── Scenarios ──────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TOKENS = { input: 100, output: 20, reasoning: 5, cache: { read: 30, write: 10 } };

const COMPACTION_TOKENS = { input: 1000, output: 20, reasoning: 0, cache: { read: 0, write: 0 } };

class Cancelled extends Error {}

/** opencode's `Wildcard.match`: `*` matches any run, the rest is literal. */
function wildcardMatch(value: string, pattern: string): boolean {
  return new RegExp(`^${pattern.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "s").test(value);
}

/** What the session's rules say about an action on a resource: the last match wins; none is `ask`. */
function ruleEffect(ses: Ses, action: string, resource: string): string {
  const rule = ses.permissions.findLast((r) => wildcardMatch(action, String(r.action)) && wildcardMatch(resource, String(r.resource)));
  return rule ? String(rule.effect) : "ask";
}

function askPermission(ses: Ses, req: Json): Promise<{ decision: string; message?: string }> {
  const id = nextId("per");
  const full = { id, sessionID: ses.id, ...req };
  // A plugin's `permission.evaluate` hook settled it: never published.
  const auto = process.env.FAKE_OPENCODE_AUTOALLOW;
  if (auto === "1" || (auto === "child" && ses.parentID)) return Promise.resolve({ decision: "once" });
  return new Promise((resolve) => {
    pendingPerms.set(id, { req: full, resolve });
    ephemeral("permission.asked", full);
  });
}

/** As an interrupt does on real 2.2.x: the session's waiting requests are gone, with no `permission.replied`. */
function dropAsks(sessionID: string): void {
  for (const [id, p] of [...pendingPerms]) {
    if (p.req.sessionID !== sessionID) continue;
    pendingPerms.delete(id);
    p.resolve({ decision: "interrupted" });
  }
}

/** A call whose request an interrupt dropped: it fails, its step fails (billed), and the execution is interrupted. */
function interruptedCall(ses: Ses, msg: string, id: string): never {
  const block = toolBlock(ses, msg, id);
  const error = { type: "aborted", message: "Tool execution interrupted" };
  if (block) block.state = { ...(block.state as Json), status: "error", error };
  durable(ses, "session.tool.failed", { assistantMessageID: msg, id, error, executed: false });
  durable(ses, "session.step.failed", { assistantMessageID: msg, error: { type: "aborted", message: "Step interrupted" }, cost: 0.0123, tokens: TOKENS });
  bill(ses, 0.0123, TOKENS);
  throw new Cancelled();
}

function askForm(ses: Ses, form: Json): Promise<{ answer?: Json; cancelled?: string }> {
  const id = nextId("frm");
  const full = { id, sessionID: ses.id, ...form };
  return new Promise((resolve) => {
    pendingForms.set(id, { form: full, resolve });
    ephemeral("form.created", { form: full });
  });
}

async function say(ses: Ses, msg: string, text: string, ordinal = 0): Promise<void> {
  ses.messages.find((x) => x.id === msg)?.content?.push({ type: "text", text });
  durable(ses, "session.text.started", { assistantMessageID: msg, ordinal });
  const half = Math.ceil(text.length / 2);
  ephemeral("session.text.delta", { sessionID: ses.id, assistantMessageID: msg, ordinal, delta: text.slice(0, half) });
  await sleep(5);
  ephemeral("session.text.delta", { sessionID: ses.id, assistantMessageID: msg, ordinal, delta: text.slice(half) });
  durable(ses, "session.text.ended", { assistantMessageID: msg, ordinal, text });
}

function step(ses: Ses): string {
  const msg = nextId("msg");
  ses.messages.push({ id: msg, type: "assistant", content: [], time: { created: Date.now() } });
  durable(ses, "session.step.started", { assistantMessageID: msg, agent: ses.agent ?? "build", model: ses.model ?? { providerID: "anthropic", id: "claude-sonnet-4" }, started: Date.now() });
  return msg;
}

function endStep(ses: Ses, msg: string, cost = 0.0123, tokens: Json = TOKENS, finish = "stop"): void {
  // As stored: the response ended (`streamed`), then the step (`completed`, finish, cost).
  const m = ses.messages.find((x) => x.id === msg);
  if (m) Object.assign(m, { cost, tokens, finish, time: { ...m.time, streamed: Date.now(), completed: Date.now() } });
  durable(ses, "session.step.ended", { assistantMessageID: msg, finish, cost, tokens });
  bill(ses, cost, tokens);
}

/** The message's stored tool block, as real 2.2.x keeps it (`state.input` from the moment it's called). */
function toolBlock(ses: Ses, msg: string, id: string): Json | undefined {
  return ses.messages.find((x) => x.id === msg)?.content?.find((b) => b.type === "tool" && b.id === id);
}

/** Deliver a pending input into the running execution: stored as a user message, then announced. */
function deliver(ses: Ses, item: { id: string; text: string }): void {
  ses.messages.push({ id: item.id, type: "user", text: item.text, time: { created: Date.now() } });
  durable(ses, "session.inbox.delivered", { inboxID: item.id });
}

/** Drop every live-feed subscriber; until `up()`, events reach nobody and new connections wait. */
function dropFeed(): () => void {
  let up!: () => void;
  feedDown = new Promise<void>((r) => {
    up = r;
  });
  for (const sub of [...liveSubs]) sub.close();
  liveSubs.clear();
  return () => {
    feedDown = null;
    up();
  };
}

async function toolCall(ses: Ses, msg: string, name: string, input: Json, req: Json, afterReply?: () => void): Promise<{ ok: boolean; message?: string; decision: string }> {
  const id = nextId("call");
  ses.messages.find((x) => x.id === msg)?.content?.push({ type: "tool", id, name, state: { status: "running", input, metadata: {} } });
  durable(ses, "session.tool.input.started", { assistantMessageID: msg, id, name });
  durable(ses, "session.tool.called", { assistantMessageID: msg, id, input, executed: false });
  const reply = await askPermission(ses, { ...req, source: { type: "tool", messageID: msg, id } });
  if (reply.decision === "interrupted") interruptedCall(ses, msg, id);
  afterReply?.();
  const block = toolBlock(ses, msg, id);
  if (reply.decision === "once" || reply.decision === "always") {
    const content = [{ type: "text", text: name === "shell" ? `${name} ran: ${String(input.command ?? "")}` : `${name} ran` }];
    if (block) block.state = { status: "completed", input, content };
    durable(ses, "session.tool.success", { assistantMessageID: msg, id, content, executed: true });
    return { ok: true, decision: reply.decision };
  }
  const error = reply.message ? { type: "permission.rejected", message: reply.message } : { type: "aborted", message: "The user declined this tool call" };
  if (block) block.state = { status: "error", input, error };
  durable(ses, "session.tool.failed", { assistantMessageID: msg, id, error, executed: false });
  return { ok: false, message: reply.message, decision: reply.decision };
}

async function runScenario(ses: Ses, text: string, signal: { cancelled: boolean }): Promise<"succeeded" | "failed" | "interrupted"> {
  const check = () => {
    if (signal.cancelled) throw new Cancelled();
  };
  if (text.includes("die-asking")) {
    const msg = step(ses);
    void toolCall(ses, msg, "shell", { command: "sleep 100" }, { action: "shell", resources: ["sleep 100"] });
    await sleep(150);
    process.exit(1);
  }
  if (text.includes("think")) {
    const msg = step(ses);
    durable(ses, "session.reasoning.started", { assistantMessageID: msg, ordinal: 0 });
    ephemeral("session.reasoning.delta", { sessionID: ses.id, assistantMessageID: msg, ordinal: 0, delta: "pondering" });
    durable(ses, "session.reasoning.ended", { assistantMessageID: msg, ordinal: 0, text: "pondering" });
    await say(ses, msg, "thought about it", 1);
    endStep(ses, msg);
    return "succeeded";
  }
  if (text.includes("use-shell")) {
    const msg = step(ses);
    const r = await toolCall(ses, msg, "shell", { command: "ls -la /tmp", description: "list tmp" }, { action: "shell", resources: ["ls -la /tmp"], save: ["ls *"] });
    // A bare reject (no feedback) aborts the step, and the execution ends interrupted.
    if (!r.ok && !r.message) {
      durable(ses, "session.step.failed", { assistantMessageID: msg, error: { type: "aborted", message: "Step interrupted" } });
      return "interrupted";
    }
    endStep(ses, msg);
    const msg2 = step(ses);
    await say(ses, msg2, r.ok ? "listed it" : `not allowed: ${r.message}`);
    endStep(ses, msg2);
    return "succeeded";
  }
  if (text.includes("use-webfetch")) {
    const msg = step(ses);
    const start = "https://docs.example/start";
    const hop = text.includes("use-webfetch-same") ? "https://docs.example/final" : "http://169.254.169.254/latest/meta-data/";
    const id = nextId("call");
    const input = { url: start, format: "text" };
    ses.messages.find((x) => x.id === msg)?.content?.push({ type: "tool", id, name: "webfetch", state: { status: "running", input, metadata: {} } });
    durable(ses, "session.tool.input.started", { assistantMessageID: msg, id, name: "webfetch" });
    durable(ses, "session.tool.called", { assistantMessageID: msg, id, input, executed: false });
    const reply = await askPermission(ses, { action: "webfetch", resources: [start], save: ["*"], metadata: input, source: { type: "tool", messageID: msg, id } });
    let fetched = false;
    if (reply.decision === "once") {
      state.fetched.push(start);
      // opencode follows the redirect itself: the hop is checked against the rules (`assertNotDenied`), never asked.
      if (ruleEffect(ses, "webfetch", hop) === "deny") {
        durable(ses, "session.tool.failed", { assistantMessageID: msg, id, error: { type: "permission.rejected", message: "Permission denied: webfetch" }, executed: true });
      } else {
        state.fetched.push(hop);
        fetched = true;
        durable(ses, "session.tool.success", { assistantMessageID: msg, id, content: [{ type: "text", text: `fetched ${hop}` }], executed: true });
      }
    } else {
      durable(ses, "session.tool.failed", { assistantMessageID: msg, id, error: { type: "permission.rejected", message: reply.message ?? "" }, executed: false });
    }
    endStep(ses, msg);
    const msg2 = step(ses);
    await say(ses, msg2, fetched ? "fetched it" : "couldn't fetch it");
    endStep(ses, msg2);
    return "succeeded";
  }
  if (text.includes("use-edit")) {
    const msg = step(ses);
    await toolCall(ses, msg, "edit", { path: "src/a.ts", oldString: "a", newString: "b" }, { action: "edit", resources: ["src/a.ts"], metadata: { files: [{ file: "src/a.ts", patch: "@@" }] } });
    endStep(ses, msg);
    return "succeeded";
  }
  if (text.includes("use-mcp") || text.includes("foreign-mcp")) {
    const msg = step(ses);
    const mounted = [...(mounts.get(ses.directory)?.keys() ?? [])].find((n) => n.endsWith("_codeoid_memory"));
    const server = text.includes("foreign-mcp") ? "coid0000000000_codeoid_memory" : (mounted ?? "none");
    const r = await toolCall(ses, msg, `${server}_recall`, { query: "auth" }, { action: `${server}_recall`, resources: ["*"], metadata: { input: { query: "auth" } } });
    endStep(ses, msg);
    const msg2 = step(ses);
    await say(ses, msg2, r.ok ? "recalled" : `refused: ${r.message}`);
    endStep(ses, msg2);
    return "succeeded";
  }
  if (text.includes("unknown-action")) {
    const msg = step(ses);
    const r = await toolCall(ses, msg, "frobnicate", {}, { action: "frobnicate", resources: ["*"] });
    endStep(ses, msg);
    const msg2 = step(ses);
    await say(ses, msg2, r.ok ? "frobnicated" : `refused: ${r.message}`);
    endStep(ses, msg2);
    return "succeeded";
  }
  if (text.includes("ask-user")) {
    const msg = step(ses);
    const call = nextId("call");
    durable(ses, "session.tool.input.started", { assistantMessageID: msg, id: call, name: "question" });
    durable(ses, "session.tool.called", { assistantMessageID: msg, id: call, input: { questions: [{ question: "Which?", header: "Pick" }] }, executed: false });
    const perm = await askPermission(ses, { action: "question", resources: ["*"], source: { type: "tool", messageID: msg, id: call } });
    if (perm.decision !== "once") {
      durable(ses, "session.tool.failed", { assistantMessageID: msg, id: call, error: { type: "permission.rejected", message: "no" }, executed: false });
      endStep(ses, msg);
      return "succeeded";
    }
    const r = await askForm(ses, {
      title: "Questions",
      metadata: { kind: "question" },
      fields: [
        { key: "q0", type: "string", title: "Pick", description: "Which?", options: [{ value: "A", label: "Option A" }, { value: "B", label: "Option B" }], custom: true },
        { key: "q1", type: "boolean", title: "Sure?" },
      ],
    });
    durable(ses, "session.tool.success", { assistantMessageID: msg, id: call, content: [{ type: "text", text: "answered" }], executed: true });
    endStep(ses, msg);
    const msg2 = step(ses);
    await say(ses, msg2, r.cancelled !== undefined ? `dismissed: ${r.cancelled}` : `answers: ${JSON.stringify(r.answer)}`);
    endStep(ses, msg2);
    return "succeeded";
  }
  if (text === "__background-result") {
    const msg = step(ses);
    await say(ses, msg, "background result received");
    endStep(ses, msg);
    return "succeeded";
  }
  if (text.includes("subagent") || text.includes("background")) {
    const background = text.includes("background");
    const msg = step(ses);
    const call = nextId("call");
    durable(ses, "session.tool.input.started", { assistantMessageID: msg, id: call, name: "subagent" });
    durable(ses, "session.tool.called", { assistantMessageID: msg, id: call, input: { agent: "explore", description: "look around", prompt: "find it", ...(background ? { background: true } : {}) }, executed: false });
    const perm = await askPermission(ses, { action: "subagent", resources: ["explore"], source: { type: "tool", messageID: msg, id: call } });
    if (perm.decision === "interrupted") interruptedCall(ses, msg, call);
    if (perm.decision !== "once") {
      durable(ses, "session.tool.failed", { assistantMessageID: msg, id: call, error: { type: "permission.rejected", message: perm.message ?? "" }, executed: false });
      endStep(ses, msg);
      return "succeeded";
    }
    // "subagent-gapstart": the child is created, starts and asks in a feed gap.
    if (text.includes("subagent-gapstart")) setTimeout(dropFeed(), 400);
    const child = createSession({ parentID: ses.id, directory: ses.directory, title: "look around", agent: "explore" });
    child.foreground = !background;
    await sleep(20);
    // "subagent-gapend" / "background-gap": the feed drops once the child's call is approved,
    // over the rest of the child's run (and, for a background one, the parent's follow-up).
    const gap: { up?: () => void } = {};
    const gapEnd =
      text.includes("subagent-gapend") || text.includes("background-gap")
        ? () => {
            gap.up = dropFeed();
          }
        : undefined;
    const runChild = async (afterReply?: () => void): Promise<boolean | "interrupted"> => {
      child.busy = Date.now();
      child.executing = true;
      durable(child, "session.execution.started", {});
      try {
        return await childTurn(afterReply);
      } catch (err) {
        if (!(err instanceof Cancelled)) throw err;
        child.idle = Date.now();
        child.outcome = "interrupted";
        durable(child, "session.execution.interrupted", { reason: "user" });
        return "interrupted";
      } finally {
        child.executing = false;
      }
    };
    const childTurn = async (afterReply?: () => void) => {
      const cm = step(child);
      if (text.includes("subagent-fail")) {
        // Billed although it failed: the model answered before the step did.
        durable(child, "session.step.failed", { assistantMessageID: cm, error: { type: "aborted", message: "Step interrupted" }, cost: 0.25, tokens: TOKENS });
        durable(child, "session.execution.failed", { error: { type: "aborted", message: "Step interrupted" } });
        child.idle = Date.now();
        child.outcome = "failed";
        return false;
      }
      // The child asks too, under its own session id.
      const cr = await toolCall(child, cm, "shell", { command: "grep -r auth ." }, { action: "shell", resources: ["grep -r auth ."] }, afterReply);
      endStep(child, cm, 0.5);
      child.idle = Date.now();
      child.outcome = "succeeded";
      durable(child, "session.execution.succeeded", {});
      return cr.ok;
    };
    if (background) {
      durable(ses, "session.tool.success", { assistantMessageID: msg, id: call, content: [{ type: "text", text: "working in the background" }], metadata: { sessionID: child.id, status: "running" }, executed: true });
      endStep(ses, msg);
      const msg2 = step(ses);
      await say(ses, msg2, "launched");
      endStep(ses, msg2);
      void (async () => {
        await sleep(150);
        const ran = await runChild(gapEnd);
        // opencode notifies the parent itself (a synthetic inbox item) and runs its main agent — a stopped child too.
        await sleep(50);
        const inboxID = nextId("msg");
        const childState = ran === "interrupted" ? "interrupted" : "completed";
        durable(ses, "session.inbox.enqueued", { inboxID, item: { type: "synthetic", payload: { text: "<subagent>…</subagent>", metadata: { source: "subagent", childID: child.id, state: childState } }, delivery: "steer" } });
        await startExecution(ses, "__background-result", inboxID);
        gap.up?.();
      })();
      return "succeeded";
    }
    const ran = await runChild(gapEnd);
    // Stopped with its parent: the parent's call fails as interrupted, and so does its execution.
    if (ran === "interrupted") interruptedCall(ses, msg, call);
    const ok = ran;
    const block = { type: "tool", id: call, name: "subagent", state: { status: "completed", input: {}, content: [{ type: "text", text: ok ? "found it" : "child refused" }], metadata: { sessionID: child.id, status: "completed" } } };
    ses.messages.find((x) => x.id === msg)?.content?.push(block);
    durable(ses, "session.tool.success", { assistantMessageID: msg, id: call, content: block.state.content, metadata: block.state.metadata, executed: true });
    endStep(ses, msg);
    if (gap.up) {
      // Back while the parent still runs.
      gap.up();
      await sleep(600);
    }
    const msg2 = step(ses);
    await say(ses, msg2, "subagent done");
    endStep(ses, msg2);
    return "succeeded";
  }
  if (text.includes("slow")) {
    for (let i = 0; i < 60; i++) {
      const msg = step(ses);
      await sleep(50);
      check();
      endStep(ses, msg);
    }
    return "succeeded";
  }
  if (text.includes("steer-gap")) {
    // The steer is delivered and answered in a feed gap that closes while
    // the execution still runs.
    const msg = step(ses);
    await say(ses, msg, "first part");
    endStep(ses, msg);
    const up = dropFeed();
    for (let i = 0; i < 100 && ses.inbox.length === 0; i++) await sleep(20);
    const steered = ses.inbox.shift();
    if (steered) {
      deliver(ses, steered);
      const msg2 = step(ses);
      await say(ses, msg2, `steered: ${steered.text}`);
      endStep(ses, msg2);
    }
    up();
    await sleep(600);
    check();
    const msg3 = step(ses);
    await say(ses, msg3, "after the gap");
    endStep(ses, msg3);
    return "succeeded";
  }
  if (text.includes("steer")) {
    const msg = step(ses);
    await say(ses, msg, "first part");
    endStep(ses, msg);
    for (let i = 0; i < 100 && ses.inbox.length === 0; i++) {
      await sleep(20);
      check();
    }
    const steered = ses.inbox.shift();
    if (steered) {
      deliver(ses, steered);
      const msg2 = step(ses);
      await say(ses, msg2, `steered: ${steered.text} (${steered.delivery})`);
      endStep(ses, msg2);
    }
    return "succeeded";
  }
  if (text.includes("retry")) {
    const msg = step(ses);
    durable(ses, "session.retry.scheduled", { assistantMessageID: msg, attempt: 1, at: Date.now() + 1000, error: { type: "provider.overloaded", message: "overloaded", status: 529 } });
    await say(ses, msg, "after retry");
    endStep(ses, msg);
    return "succeeded";
  }
  if (text.includes("fail")) {
    const msg = step(ses);
    durable(ses, "session.step.failed", { assistantMessageID: msg, error: { type: "provider.rate-limit", message: "Rate limit reached", status: 429, retryAfterMs: 5000 }, cost: 0.25, tokens: TOKENS });
    durable(ses, "session.execution.failed", { error: { type: "provider.rate-limit", message: "Rate limit reached", status: 429, retryAfterMs: 5000 } });
    return "failed";
  }
  if (text.includes("compact")) {
    // As real 2.2.x compacts: each of its requests is billed in the running
    // total as it happens; its end reports their sum.
    const msg = step(ses);
    await say(ses, msg, "before compaction");
    endStep(ses, msg);
    durable(ses, "session.compaction.started", { reason: "auto" });
    bill(ses, 0.002, COMPACTION_TOKENS);
    bill(ses, 0.001, COMPACTION_TOKENS);
    const sum = { input: 2 * COMPACTION_TOKENS.input, output: 2 * COMPACTION_TOKENS.output, reasoning: 0, cache: { read: 0, write: 0 } };
    durable(ses, "session.compaction.ended", { reason: "auto", cost: 0.003, tokens: sum });
    const msg2 = step(ses);
    await say(ses, msg2, "after compaction");
    endStep(ses, msg2);
    return "succeeded";
  }
  if (text.includes("costly")) {
    for (let i = 0; i < 3; i++) {
      const msg = step(ses);
      await sleep(60);
      check();
      endStep(ses, msg, 2);
    }
    return "succeeded";
  }
  if (text.includes("use-codemode")) {
    const msg = step(ses);
    const call = nextId("call");
    const code = "const a = await fetch('https://example.com/a'); const b = await fetch('https://example.com/b', { method: 'POST' }); return [a.status, b.status];";
    durable(ses, "session.tool.input.started", { assistantMessageID: msg, id: call, name: "execute" });
    durable(ses, "session.tool.called", { assistantMessageID: msg, id: call, input: { code }, executed: false });
    const hidden = ses.permissions.some((r) => r.action === "execute" && r.effect === "deny");
    if (hidden && process.env.FAKE_OPENCODE_CODEMODE !== "1") {
      const message = 'No tool named "execute" is currently available. Please use a tool from the available tool list.';
      durable(ses, "session.tool.failed", { assistantMessageID: msg, id: call, error: { type: "tool.execution", message }, executed: false });
      endStep(ses, msg);
      const msg2 = step(ses);
      await say(ses, msg2, "no code mode");
      endStep(ses, msg2);
      return "succeeded";
    }
    // The script asks nothing for itself; each fetch asks webfetch, naming the script's call.
    const statuses: string[] = [];
    for (const [url, method] of [["https://example.com/a", "GET"], ["https://example.com/b", "POST"]] as const) {
      const r = await askPermission(ses, { action: "webfetch", resources: [url], save: ["*"], metadata: { method, url }, source: { type: "tool", messageID: msg, id: call } });
      statuses.push(r.decision === "once" ? "200" : "rejected");
    }
    durable(ses, "session.tool.success", { assistantMessageID: msg, id: call, content: [{ type: "text", text: statuses.join(",") }], metadata: { toolCalls: [] }, executed: false });
    endStep(ses, msg);
    const msg2 = step(ses);
    await say(ses, msg2, `fetched: ${statuses.join(",")}`);
    endStep(ses, msg2);
    return "succeeded";
  }
  if (text.includes("midgap")) {
    // The feed drops and comes back while the execution is still running:
    // a call's result, a whole step and its text fall in the gap.
    const msg = step(ses);
    await say(ses, msg, "before the gap");
    let up = () => {};
    await toolCall(ses, msg, "shell", { command: "echo in-gap", description: "x" }, { action: "shell", resources: ["echo in-gap"] }, () => {
      up = dropFeed();
    });
    endStep(ses, msg);
    const msg2 = step(ses);
    await say(ses, msg2, "said in the gap");
    endStep(ses, msg2, 0.5);
    up();
    await sleep(600); // reconnected; the execution keeps going
    check();
    const msg3 = step(ses);
    await say(ses, msg3, "after the gap");
    endStep(ses, msg3);
    return "succeeded";
  }
  if (text.includes("lag-settle")) {
    // The feed drops after a call is approved and comes back behind: the
    // call's result is read back first, then the late feed delivers it too.
    const msg = step(ses);
    let up = () => {};
    await toolCall(ses, msg, "shell", { command: "echo lagged", description: "x" }, { action: "shell", resources: ["echo lagged"] }, () => {
      up = lagFeed();
    });
    await say(ses, msg, "after the call");
    endStep(ses, msg);
    up();
    await sleep(LAG_MS + 500);
    check();
    const msg2 = step(ses);
    await say(ses, msg2, "after the lag");
    endStep(ses, msg2);
    return "succeeded";
  }
  if (text.includes("gap-open")) {
    // A block ends in the gap; the feed is back while its step still runs
    // (a call follows in the same message), so the block is the last one
    // stored when codeoid reads back.
    const msg = step(ses);
    const up = dropFeed();
    await say(ses, msg, "said in the gap");
    up();
    await sleep(600);
    check();
    await toolCall(ses, msg, "shell", { command: "echo after", description: "x" }, { action: "shell", resources: ["echo after"] });
    endStep(ses, msg);
    const msg2 = step(ses);
    await say(ses, msg2, "after the gap");
    endStep(ses, msg2);
    return "succeeded";
  }
  if (text.includes("gap-ask")) {
    // The call and its permission request fall in the gap; the request is
    // re-offered once the feed is back.
    const msg = step(ses);
    await say(ses, msg, "about to run a shell");
    const up = dropFeed();
    setTimeout(up, 400);
    const r = await toolCall(ses, msg, "shell", { command: "echo gap-ok", description: "x" }, { action: "shell", resources: ["echo gap-ok"] });
    endStep(ses, msg);
    const msg2 = step(ses);
    await say(ses, msg2, r.ok ? "ran it" : `refused: ${r.message}`);
    endStep(ses, msg2);
    return "succeeded";
  }
  if (text.includes("gap")) {
    const msg = step(ses);
    await say(ses, msg, "before the gap");
    // A step that goes on to another ends `tool-calls`; only the last one says how the turn ended.
    endStep(ses, msg, 0.0123, TOKENS, "tool-calls");
    // The feed drops everyone; until it's back, events reach nobody.
    const up = dropFeed();
    const msg2 = step(ses);
    await say(ses, msg2, "said in the gap");
    endStep(ses, msg2, 0.5);
    setTimeout(up, 400);
    return "succeeded";
  }
  if (text.includes("echo-state")) {
    const msg = step(ses);
    await say(ses, msg, JSON.stringify({ model: ses.model ?? null, agent: ses.agent ?? null, synthetic: state.synthetic.filter((s) => s.sessionID === ses.id).map((s) => s.text), prompt: text, permissions: ses.permissions }));
    endStep(ses, msg);
    return "succeeded";
  }
  const msg = step(ses);
  await say(ses, msg, "Hello, world");
  endStep(ses, msg);
  return "succeeded";
}

async function startExecution(ses: Ses, text: string, inboxID?: string): Promise<void> {
  ses.executing = true;
  ses.busy = Date.now();
  const signal = { cancelled: false };
  ses.cancel = () => {
    signal.cancelled = true;
  };
  durable(ses, "session.execution.started", {});
  if (inboxID) durable(ses, "session.inbox.delivered", { inboxID });
  let outcome: "succeeded" | "failed" | "interrupted";
  try {
    outcome = await runScenario(ses, text, signal);
    // A queued input is delivered inside the running execution, after its reply.
    for (let i = ses.inbox.findIndex((x) => x.delivery === "queue"); outcome === "succeeded" && i >= 0; i = ses.inbox.findIndex((x) => x.delivery === "queue")) {
      const [item] = ses.inbox.splice(i, 1);
      deliver(ses, item!);
      outcome = await runScenario(ses, item!.text, signal);
    }
  } catch (err) {
    if (!(err instanceof Cancelled)) throw err;
    outcome = "interrupted";
  }
  if (signal.cancelled && outcome !== "failed") outcome = "interrupted";
  ses.executing = false;
  ses.cancel = null;
  ses.outcome = outcome;
  ses.idle = Date.now();
  if (outcome === "succeeded") durable(ses, "session.execution.succeeded", {});
  else if (outcome === "interrupted") durable(ses, "session.execution.interrupted", { reason: "user" });
  else if (!ses.log.some((e) => e.type === "session.execution.failed" && (e.durable as Json).seq === ses.seq)) {
    durable(ses, "session.execution.failed", { error: { type: "unknown", message: "the step failed" } });
  }
  ses.messages.push({ id: nextId("msg"), type: "idle", time: { created: Date.now() } });
  // The title opencode generates for a session's first prompt: billed, reported by no step.
  if (!ses.titled && !ses.parentID && !ses.fork) {
    ses.titled = true;
    bill(ses, TITLE_COST, TITLE_TOKENS);
  }
  // A steer that came after the last step runs next, in an execution of its own.
  const steer = outcome === "succeeded" ? ses.inbox.findIndex((x) => x.delivery === "steer") : -1;
  if (steer >= 0) {
    const [item] = ses.inbox.splice(steer, 1);
    ses.messages.push({ id: item!.id, type: "user", text: item!.text, time: { created: Date.now() } });
    setTimeout(() => void startExecution(ses, item!.text, item!.id), 5);
  }
}

function createSession(input: { directory: string; permissions?: Json[]; agent?: string; model?: Json; parentID?: string; title?: string }): Ses {
  const parent = input.parentID ? sessions.get(input.parentID) : undefined;
  const ses: Ses = {
    id: nextId("ses"),
    directory: input.directory,
    // A child inherits its parent's rules (2.2.2 and 2.2.5 both do).
    permissions: input.permissions ?? (parent ? [...parent.permissions] : []),
    agent: input.agent,
    model: input.model,
    parentID: input.parentID,
    title: input.title,
    messages: [],
    log: [],
    seq: 0,
    executing: false,
    cancel: null,
    inbox: [],
    usage: { cost: 0, input: 0, output: 0, reasoning: 0, read: 0, write: 0 },
    titled: false,
    created: Date.now(),
  };
  sessions.set(ses.id, ses);
  // Real servers number a session's creation 0, under its own aggregate.
  ses.seq = -1;
  durable(ses, "session.created", {
    projectID: "prj_1",
    location: { directory: ses.directory },
    slug: ses.id,
    version: version,
    permissions: ses.permissions,
    ...(ses.model ? { model: ses.model } : {}),
    ...(ses.parentID ? { parentID: ses.parentID } : {}),
    ...(ses.title ? { title: ses.title } : {}),
    ...(ses.agent ? { agent: ses.agent } : {}),
  });
  return ses;
}

/** As the real one: a running execution stops, and a durable `session.deleted` is published. */
function deleteSession(ses: Ses, quiet: boolean): void {
  ses.cancel?.();
  sessions.delete(ses.id);
  if (!quiet) durable(ses, "session.deleted", {});
}

function info(ses: Ses): Json {
  return {
    id: ses.id,
    ...(ses.parentID ? { parentID: ses.parentID } : {}),
    ...(ses.fork ? { fork: ses.fork } : {}),
    projectID: "prj_1",
    ...(ses.agent ? { agent: ses.agent } : {}),
    ...(ses.model ? { model: ses.model } : {}),
    cost: ses.usage.cost,
    tokens: { input: ses.usage.input, output: ses.usage.output, reasoning: ses.usage.reasoning, cache: { read: ses.usage.read, write: ses.usage.write } },
    ...(ses.outcome ? { outcome: ses.outcome } : {}),
    ...(ses.title ? { title: ses.title } : {}),
    time: { created: ses.created, updated: Date.now(), ...(ses.busy ? { busy: ses.busy } : {}), ...(ses.idle ? { idle: ses.idle } : {}) },
    permissions: ses.permissions,
    location: { directory: ses.directory },
  };
}

// ── Commands ───────────────────────────────────────────────────────────────

/** opencode's built-in commands, as 2.2.2 and 2.2.5 list them. */
const BUILTIN_COMMANDS: Record<string, string> = {
  init: "guided AGENTS.md setup",
  review: "review changes [commit|branch|pr], defaults to uncommitted",
  goal: "keep working until an objective is met [pause|resume|clear]",
};
const CONFIG_COMMAND_TEMPLATE = "Summarize this topic briefly:";

/**
 * What `GET /api/command` lists at a location: the built-ins, one prompt
 * (`<mount>:brief`) for every MCP server mounted there — whichever session
 * mounted it — and, with FAKE_OPENCODE_CONFIG_COMMANDS, commands from a
 * config dir: `1` a `summarize` one, `shadow` a `review` that replaces the
 * built-in (listed, as real 2.2.x does, without the built-in's description).
 */
function commandsAt(directory: string): Array<{ name: string; description?: string }> {
  const knob = process.env.FAKE_OPENCODE_CONFIG_COMMANDS;
  const list: Array<{ name: string; description?: string }> = Object.entries(BUILTIN_COMMANDS).map(([name, description]) =>
    knob === "shadow" && name === "review" ? { name } : { name, description },
  );
  if (knob === "1") list.push({ name: "summarize" });
  for (const mount of mounts.get(directory)?.keys() ?? []) list.push({ name: `${mount}:brief`, description: "a prompt of the server" });
  return list;
}

// ── HTTP ───────────────────────────────────────────────────────────────────

const json = (body: unknown, status = 200) => Response.json(body, { status });
const notFound = (tag: string, message: string) => json({ _tag: tag, message }, 404);

function authorized(req: Request): boolean {
  const m = /^Basic\s+(.+)$/i.exec(req.headers.get("authorization") ?? "");
  if (!m) return false;
  return Buffer.from(m[1]!, "base64").toString() === `opencode:${password}`;
}

function directoryOf(req: Request, url: URL): string {
  const header = req.headers.get("x-opencode-directory");
  return url.searchParams.get("location[directory]") ?? (header ? decodeURIComponent(header) : process.cwd());
}

/** The live feed's filterable types (what 2.2.2 and 2.2.5 accept); 1.x names like `message.updated` are refused. */
const KNOWN_TYPES = new Set([
  "session.created", "session.agent.selected", "session.model.selected", "session.renamed", "session.permissions",
  "session.usage.updated", "session.deleted", "session.forked", "session.inbox.enqueued", "session.inbox.delivered",
  "session.inbox.cancelled", "session.execution.started", "session.execution.succeeded", "session.execution.failed",
  "session.execution.interrupted", "session.step.started", "session.step.ended", "session.step.failed",
  "session.step.streamed", "session.text.started", "session.text.delta", "session.text.ended",
  "session.reasoning.started", "session.reasoning.delta", "session.reasoning.ended", "session.tool.input.started",
  "session.tool.input.delta", "session.tool.input.ended", "session.tool.called", "session.tool.progress",
  "session.tool.success", "session.tool.failed", "session.retry.scheduled", "session.compaction.started",
  "session.compaction.ended", "session.compaction.failed", "session.synthetic", "session.instructions.updated",
  "permission.asked", "permission.replied", "form.created", "form.replied", "form.cancelled",
]);

let port = 0;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  idleTimeout: 0,
  async fetch(req): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;
    state.requests.push(`${method} ${path}`);
    // Test-only, so tests can read it without the per-start password.
    // Test-only: delete a session as opencode's API (or a pruned database) would; `?quiet=1` as if the feed missed it.
    const del = /^\/__fake\/delete\/([^/]+)$/.exec(path);
    if (del) {
      const target = sessions.get(del[1]!);
      if (target) deleteSession(target, url.searchParams.get("quiet") === "1");
      return new Response(null, { status: target ? 204 : 404 });
    }
    // Test-only: what anything holding the password could do between turns — allow-all rules, a saved "always".
    const tamper = /^\/__fake\/tamper\/([^/]+)$/.exec(path);
    if (tamper) {
      const target = sessions.get(tamper[1]!);
      if (target) target.permissions = [{ action: "*", resource: "*", effect: "allow" }];
      state.saved.push({ id: nextId("prm"), action: "*", resource: "*" });
      return new Response(null, { status: target ? 204 : 404 });
    }
    if (path === "/__fake/state") return json({ ...state, sessions: [...sessions.values()].map(info), mounts: Object.fromEntries([...mounts].map(([d, m]) => [d, [...m.keys()]])) });
    // Every route needs the password, /api/info too (real 2.2.x answers 401 without it).
    if (!authorized(req)) return json({ _tag: "UnauthorizedError", message: "Authentication required" }, 401);
    if (path === "/api/info" && method === "GET") {
      return json({ version, pid: process.pid, urls: [`http://127.0.0.1:${port}`], paths: { tmp: "/tmp" } });
    }
    const body = method === "POST" || method === "PUT" || method === "PATCH" ? ((await req.json().catch(() => ({}))) as Json) : {};

    if (path === "/api/event") {
      const types = url.searchParams.getAll("types");
      if (types.some((t) => !KNOWN_TYPES.has(t))) return json({ _tag: "InvalidRequestError", message: "bad types" }, 400);
      if (feedDown) await feedDown;
      return sseResponse((push, close) => {
        const sub = { push, types: types.length > 0 ? new Set(types) : null, close };
        liveSubs.add(sub);
        push({ id: nextId("evt"), type: "server.connected", created: Date.now(), data: {} });
        return () => liveSubs.delete(sub);
      });
    }
    if (path === "/api/agent") return json({ location: { directory: directoryOf(req, url) }, data: agents() });
    if (path === "/api/plugin") {
      const builtin = ["opencode.tool.input.repair", "opencode.config.mcp"].map((id) => ({ id, source: { type: "builtin" }, features: { server: true }, state: { status: "active" } }));
      const foreign = { id: "user.autoallow", source: { type: "local", path: "/home/u/.config/opencode/plugins/autoallow.js" }, features: { server: true }, state: { status: "active" } };
      // FAKE_OPENCODE_PLUGIN: `1` from the start, `late` once a prompt was posted (dropped into a watched dir).
      const knob = process.env.FAKE_OPENCODE_PLUGIN;
      const listed = knob === "1" || (knob === "late" && state.prompts.length > 0);
      return json({ location: { directory: directoryOf(req, url) }, data: listed ? [...builtin, foreign] : builtin });
    }
    if (path === "/api/model") return json({ location: { directory: directoryOf(req, url) }, data: MODELS });
    if (path === "/api/model/default") return json({ location: { directory: directoryOf(req, url) }, data: MODELS[0] });
    if (path === "/api/command") {
      const dir = directoryOf(req, url);
      return json({ location: { directory: dir }, data: commandsAt(dir) });
    }
    if (path === "/api/skill") return json({ location: { directory: directoryOf(req, url) }, data: [{ id: "skl_1", name: "deploy", description: "Deploy it", path: "/x", content: "" }] });
    if (path === "/api/session/active") return json({ data: Object.fromEntries([...sessions.values()].filter((s) => s.executing).map((s) => [s.id, { type: "running" }])) });
    if (path === "/api/permission/saved") {
      if (method === "GET") return json({ data: state.saved });
    }
    let m = /^\/api\/permission\/saved\/([^/]+)$/.exec(path);
    if (m && method === "DELETE") {
      state.savedRemoved.push(m[1]!);
      state.saved = state.saved.filter((s) => s.id !== m![1]);
      return new Response(null, { status: 204 });
    }
    m = /^\/api\/experimental\/mcp\/([^/]+)$/.exec(path);
    if (m) {
      const dir = directoryOf(req, url);
      const set = mounts.get(dir) ?? new Map<string, Json>();
      mounts.set(dir, set);
      if (method === "PUT") {
        set.set(decodeURIComponent(m[1]!), body.config as Json);
        state.mcp.push({ directory: dir, name: decodeURIComponent(m[1]!), config: body.config });
      } else if (method === "DELETE") {
        set.delete(decodeURIComponent(m[1]!));
        state.mcpRemoved.push({ directory: dir, name: decodeURIComponent(m[1]!) });
      }
      return new Response(null, { status: 204 });
    }
    if (path === "/api/session" && method === "GET") {
      // `parentID` filters to one session's children (newest first, as `order=desc`).
      const parentID = url.searchParams.get("parentID");
      const list = [...sessions.values()].filter((x) => !parentID || x.parentID === parentID).reverse();
      return json({ data: list.map(info), cursor: {} });
    }
    if (path === "/api/session" && method === "POST") {
      const loc = body.location as { directory?: string } | undefined;
      const ses = createSession({ directory: loc?.directory ?? directoryOf(req, url), permissions: body.permissions as Json[], agent: body.agent as string, model: body.model as Json });
      return json({ data: info(ses) });
    }
    m = /^\/api\/experimental\/session\/([^/]+)\/log$/.exec(path);
    if (m) {
      const ses = sessions.get(m[1]!);
      if (!ses) return notFound("SessionNotFoundError", "Session not found");
      // As the real 2.2.x log behaves: no events, ever. Without follow, only the
      // synced marker; with follow, not even that (the real one sends heartbeats).
      const follow = url.searchParams.get("follow") === "true";
      return sseResponse((push, close) => {
        if (!follow) {
          push({ type: "log.synced", aggregateID: ses.id, seq: ses.seq });
          close();
        }
        return () => {};
      });
    }
    m = /^\/api\/experimental\/session\/([^/]+)\/instructions\/entries\/([^/]+)$/.exec(path);
    if (m) return new Response(null, { status: 204 });
    m = /^\/api\/session\/([^/]+)(\/.*)?$/.exec(path);
    if (!m) return notFound("NotFound", path);
    const ses = sessions.get(m[1]!);
    if (!ses) return notFound("SessionNotFoundError", `Session not found: ${m[1]}`);
    const rest = m[2] ?? "";
    if (rest === "" && method === "GET") return json({ data: info(ses) });
    if (rest === "" && method === "DELETE") {
      deleteSession(ses, false);
      return new Response(null, { status: 204 });
    }
    if (rest === "" && method === "PATCH") {
      if (Array.isArray(body.permissions)) ses.permissions = body.permissions as Json[];
      state.patches.push({ sessionID: ses.id, ...body });
      return new Response(null, { status: 204 });
    }
    if (rest === "/fork" && method === "POST") {
      const before = body.before as string | undefined;
      const idx = before ? ses.messages.findIndex((x) => x.id === before) : ses.messages.length;
      if (before && idx < 0) return notFound("MessageNotFoundError", "no such message");
      const forked = createSession({ directory: ses.directory, agent: ses.agent, model: ses.model });
      forked.fork = { sessionID: ses.id, boundary: before ? { type: "before", messageID: before } : { type: "through", messageID: ses.messages.at(-1)?.id } };
      forked.messages = ses.messages.slice(0, idx);
      state.forks.push({ source: ses.id, before: before ?? null, id: forked.id });
      return json({ data: info(forked) });
    }
    if (rest === "/model" && method === "POST") {
      ses.model = body.model as Json;
      state.modelSwitches.push({ sessionID: ses.id, model: body.model });
      return new Response(null, { status: 204 });
    }
    if (rest === "/agent" && method === "POST") {
      ses.agent = body.agent as string;
      state.agentSwitches.push({ sessionID: ses.id, agent: body.agent });
      return new Response(null, { status: 204 });
    }
    if (rest === "/synthetic" && method === "POST") {
      if (process.env.FAKE_OPENCODE_SLOW_SYNTHETIC_MS) await sleep(Number(process.env.FAKE_OPENCODE_SLOW_SYNTHETIC_MS));
      state.synthetic.push({ sessionID: ses.id, ...body });
      return json({ data: { id: nextId("msg"), sessionID: ses.id, type: "synthetic" } });
    }
    if (rest === "/prompt" && method === "POST") {
      const id = nextId("msg");
      const text = String(body.text ?? "");
      const delivery = String(body.delivery ?? "steer");
      if (ses.executing && delivery === "steer" && process.env.FAKE_OPENCODE_STEER_FAIL === "1") return json({ _tag: "UnknownError", message: "steer refused" }, 500);
      state.prompts.push({ sessionID: ses.id, id, ...body });
      durable(ses, "session.inbox.enqueued", { inboxID: id, item: { type: "user", payload: { text }, delivery } });
      // As real 2.2.x: an input becomes a user message (under its inbox id) when it is delivered.
      if (ses.executing) {
        ses.inbox.push({ id, text, delivery });
        // The reply can lag the steer's delivery (FAKE_OPENCODE_STEER_REPLY_MS): opencode takes it at the next step boundary.
        if (delivery === "steer" && process.env.FAKE_OPENCODE_STEER_REPLY_MS) await sleep(Number(process.env.FAKE_OPENCODE_STEER_REPLY_MS));
      } else {
        // Busy from admission: an input posted before the execution's first event joins it.
        ses.executing = true;
        // What an interrupted execution left in the inbox is delivered with this prompt, ahead of it.
        const left = ses.inbox.splice(0);
        for (const item of [...left, { id, text }]) ses.messages.push({ id: item.id, type: "user", text: item.text, time: { created: Date.now() } });
        setTimeout(() => void startExecution(ses, [...left.map((x) => x.text), text].join("\n"), id), 5);
      }
      return json({ data: { id, sessionID: ses.id, type: "user", payload: { text }, delivery, time: { created: Date.now() } } });
    }
    if (rest === "/command" && method === "POST") {
      const name = String(body.name ?? "");
      const input = String(body.text ?? "");
      const command = commandsAt(ses.directory).find((c) => c.name === name);
      if (!command) return notFound("CommandNotFoundError", "no such command");
      state.commands.push({ sessionID: ses.id, ...body });
      if (name.includes(":")) {
        // An MCP prompt: opencode calls the mount's server (`prompts/get`, with its credential), asking nothing.
        state.mcpPromptCalls.push({ sessionID: ses.id, mount: name.slice(0, name.indexOf(":")), config: mounts.get(ses.directory)?.get(name.slice(0, name.indexOf(":"))) });
      } else if (command.description !== BUILTIN_COMMANDS[name]) {
        // A config command: every !`…` of its template, arguments substituted in, runs through the shell unasked.
        const text = `${CONFIG_COMMAND_TEMPLATE} ${input}`;
        for (const m of text.matchAll(/!`([^`]+)`/g)) state.shellRan.push(m[1]!);
      }
      // `goal clear` only acts; everything else prompts the agent.
      if (!(name === "goal" && input === "clear")) setTimeout(() => void startExecution(ses, `${name} ${input}`), 5);
      return new Response(null, { status: 204 });
    }
    if (rest === "/interrupt" && method === "POST") {
      state.interrupts.push(ses.id);
      const running = ses.executing;
      ses.cancel?.();
      dropAsks(ses.id);
      for (const child of sessions.values()) if (child.parentID === ses.id && child.foreground && child.executing) dropAsks(child.id);
      return json({ interrupted: running });
    }
    const ib = /^\/inbox\/([^/]+)$/.exec(rest);
    if (ib && method === "DELETE") {
      // An input not delivered yet is withdrawn; a delivered one is left as it is (no error).
      const i = ses.inbox.findIndex((x) => x.id === ib[1]);
      if (i >= 0) {
        ses.inbox.splice(i, 1);
        state.inboxCancels.push(ib[1]!);
        durable(ses, "session.inbox.cancelled", { inboxID: ib[1] });
      }
      return new Response(null, { status: 204 });
    }
    const mm = /^\/message\/([^/]+)$/.exec(rest);
    if (mm && method === "GET") {
      const msg = ses.messages.find((x) => x.id === mm[1]);
      return msg ? json({ data: msg }) : notFound("MessageNotFoundError", "no such message");
    }
    if (rest === "/message" && method === "GET") {
      // One page (the fake never has more); `order=desc` is newest first.
      return json({ data: url.searchParams.get("order") === "desc" ? [...ses.messages].reverse() : ses.messages, cursor: {} });
    }
    if (rest === "/permission" && method === "GET") {
      return json({ data: [...pendingPerms.values()].filter((p) => p.req.sessionID === ses.id).map((p) => p.req) });
    }
    let pm = /^\/permission\/([^/]+)\/reply$/.exec(rest);
    if (pm && method === "POST") {
      const p = pendingPerms.get(pm[1]!);
      if (!p) return notFound("PermissionNotFoundError", "no such request");
      state.replies.push({ requestID: pm[1], sessionID: ses.id, action: p.req.action, ...body });
      pendingPerms.delete(pm[1]!);
      ephemeral("permission.replied", { sessionID: ses.id, requestID: pm[1], reply: body.decision });
      p.resolve({ decision: String(body.decision), ...(typeof body.message === "string" ? { message: body.message } : {}) });
      if (body.decision === "reject") {
        // A reject rejects the session's other pending requests too.
        for (const [id, other] of [...pendingPerms]) {
          if (other.req.sessionID !== ses.id) continue;
          pendingPerms.delete(id);
          ephemeral("permission.replied", { sessionID: ses.id, requestID: id, reply: "reject" });
          other.resolve({ decision: "reject", ...(typeof body.message === "string" ? { message: body.message } : {}) });
        }
      }
      return new Response(null, { status: 204 });
    }
    if (rest === "/form" && method === "GET") {
      return json({ data: [...pendingForms.values()].filter((f) => f.form.sessionID === ses.id).map((f) => f.form) });
    }
    pm = /^\/form\/([^/]+)(\/reply)?$/.exec(rest);
    if (pm) {
      const f = pendingForms.get(pm[1]!);
      if (!f) return notFound("FormNotFoundError", "no such form");
      pendingForms.delete(pm[1]!);
      if (pm[2] && method === "POST") {
        state.formReplies.push({ formID: pm[1], answer: body.answer });
        ephemeral("form.replied", { id: pm[1], sessionID: ses.id, answer: body.answer });
        f.resolve({ answer: body.answer as Json });
      } else if (method === "DELETE") {
        const message = url.searchParams.get("message") ?? "";
        state.formReplies.push({ formID: pm[1], cancelled: message });
        ephemeral("form.cancelled", { id: pm[1], sessionID: ses.id });
        f.resolve({ cancelled: message });
      }
      return new Response(null, { status: 204 });
    }
    return notFound("NotFound", `${method} ${path}`);
  },
});

port = server.port ?? 0;
process.stdout.write(`${JSON.stringify({ url: `http://127.0.0.1:${port}` })}\n`);
process.stdin.on("end", () => process.exit(0));
process.stdin.on("close", () => process.exit(0));
process.stdin.resume();
