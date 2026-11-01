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
 * execution ends), a queued input runs inside the running execution (one
 * queued after its last step ended runs next, in one of its own), a bare
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
 *   "ask-shell:<json>" → a shell call of exactly that input (command, workdir),
 *                    asked first; nothing runs, an allowed one answers "ran it"
 *   "use-edit"     → edit call (path/oldString/newString) asking "edit"
 *   "use-patch-two" → patch call with two targets, asking "edit" once for both (as 2.2.5's patch.ts)
 *   "use-grep-home" → a grep of `~/.codeoid/config.json`: `~` is the server's
 *                    home (`OPENCODE_TEST_HOME`, else HOME), asked as an
 *                    external directory, then as the grep
 *   "use-webfetch" → a webfetch of https://docs.example/start, which redirects
 *                    to another site (169.254.169.254); "use-webfetch-same" to
 *                    the same one. As real 2.2.x: the hop is checked only
 *                    against the session's rules, never asked about
 *   "use-mcp"      → a call to this session's mounted codeoid_memory `recall`
 *   "foreign-mcp"  → a call to ANOTHER session's mount (must be rejected)
 *   "unknown-action" → a permission action codeoid doesn't know
 *   "ask-user"     → a question form; answers echoed back
 *   "subagent"     → foreground subagent in a child session (with a cost)
 *   "subagent-fail" → its child's step is aborted after the model answered (billed), its execution interrupted
 *   "subagent-gapstart" → the child is created, starts and asks in a feed gap
 *   "subagent-gapunasked:<line>" → the feed drops as the subagent call is
 *                    approved; the child, created in the gap, runs <line> as
 *                    an unasked shell call (as "unasked-shell:", with the
 *                    server's environment until its own was set), and its
 *                    output is the subagent's result; back while the parent runs
 *   "subagent-gapend" → the feed drops once the child's call is approved, over
 *                    the rest of the child's run; back while the parent runs
 *   "background-gap" → a background child whose call is approved, then the
 *                    feed drops over the rest of its run and the parent's
 *                    follow-up execution, and is back after both ended
 *   "background"   → background subagent; opencode resumes the parent itself
 *   "… free-child" (with "subagent") → the child runs on a model of its
 *                    own ("free/m-1"), whose step opencode bills $0
 *   "… continue:<ses_id>" (with "subagent" or "background") → the call
 *                    continues that existing child session: reused, no
 *                    `session.created` (as opencode's `sessionID` input)
 *   "slow"         → keeps stepping until interrupted
 *   "steer"        → waits for a steered input, then answers it
 *   "errs-awaiting-push" → waits for an input in the inbox, leaves it undelivered and
 *                    fails the step (a 400); opencode runs the input (steer or queue) next, as real 2.2.5
 *   "gap-tail"     → one step, then the execution waits for an input
 *                    pushed behind it (steer or queue) and the feed drops
 *                    over the execution's end; it is back before the
 *                    input's own execution starts (which waits a second)
 *   "steer-gap"    → the feed drops after the first step; the steer is
 *                    delivered and answered in the gap, which closes while
 *                    the execution still runs
 *   "retry"        → session.retry.scheduled before answering; "retry-after-text"
 *                    → after part of an answer, with no step.failed first
 *   "fail"         → a 429 retried once, then execution.failed with a structured
 *                    rate-limit error; the failed step bills nothing
 *   "transport:<kind>" → as real 2.2.5 fails a model endpoint it can't reach: a
 *                    `provider.transport` error with no status, retried once,
 *                    then the step and execution fail, billed nothing. <kind>:
 *                    "refused" (ECONNREFUSED: never connected), "reset"
 *                    (ECONNRESET), "refused-after-text" (the retry's attempt
 *                    streams some text first)
 *   "midstream:<error>:<then>" → as real 2.2.5 fails an attempt whose
 *                    response broke off after part of an answer: the step
 *                    fails with status 200, unbilled; the retry runs in a
 *                    new message. <error>: "invalid" (the stream ended
 *                    without finish_reason) or "reset" (ECONNRESET mid-body);
 *                    <then>: "ok" (the retry answers) or "refused" (it can't connect)
 *   "costly"       → three steps of $2 each; "costly-free" → three steps
 *                    that used tokens, each billed $0
 *   "zero-cost"    → a step that used tokens opencode billed $0 for (a
 *                    subscription sign-in, a model its catalog prices at $0);
 *                    "zero-cost-mixed" → a priced step, then such a step
 *   "no-usage"     → a step that ends reporting no usage at all
 *   "compact"      → a step, an auto compaction of two requests ($0.002 +
 *                    $0.001, billed in the running total), another step;
 *                    "compact-interrupt" → a step, then a compaction whose
 *                    request streams until interrupted: as on real 2.2.5 it
 *                    fails `compaction.interrupted`, nothing billed for it
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
 *   "interrupt-gap" → a shell call asks, the feed drops and stays down 7s:
 *                    an interrupt meanwhile ends the execution in the gap
 *   "startgap-ask" → the feed drops just after the execution's start, so the
 *                    step's start falls in the gap; its response is complete
 *                    (a shell call that asks, with usage), so an interrupt
 *                    fails the step with its tokens, as real 2.2.5 does
 *   "startgap-idle" → the feed drops just after the execution's start, a
 *                    whole step runs in the gap, then the execution waits,
 *                    no step open, until it is interrupted
 *   "gap-ask"      → a shell call and its permission request fall in the gap
 *   "gap-reason-ask" → reasoning starts on the feed; its end, then two
 *                    parallel shell calls and their requests, fall in the gap
 *   "lag-settle"   → the feed drops after a call is approved and comes back
 *                    behind: the call's result is stored before the late feed
 *                    delivers it
 *   "unasked-shell:<line>" → a shell call of the rest of the prompt that runs
 *                    without a permission request, as real 2.2.5 runs a line
 *                    its scanner finds no command in; its output is the
 *                    value of each `$NAME` in it, from the session's
 *                    environment (`PUT …/environment`) if one was set, else
 *                    the server's own, as the real shell expands them
 *   "bg-shell"     → a background shell call (asks first): its result says
 *                    `status: "running"` with a `shellID`, and it is listed
 *                    (`GET /api/shell`) until it finishes (FAKE_OPENCODE_BG_SHELL_MS,
 *                    default 400) or is removed (`DELETE /api/shell/:id`).
 *                    Either way opencode wakes the session itself (a
 *                    synthetic inbox item) and runs it: the wake calls
 *                    shell `echo woke-tool`, which asks
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
 * such a plugin's hook does), FAKE_OPENCODE_ENV_FAIL=child (setting a child
 * session's environment answers 500), FAKE_OPENCODE_SHELLS_UNLISTED=1
 * (`GET /api/shell` lists nothing), FAKE_OPENCODE_MOVE_FEED_LAG_MS (the
 * events of a session's move reach the feed that long after its reply),
 * FAKE_OPENCODE_MOVE_IGNORED=1 (a move answers 204 and leaves the session
 * where it was), FAKE_OPENCODE_FORM_CANCEL_UNSEEN=1 (a form an interrupt
 * cancels isn't announced, as if the feed dropped `form.cancelled`),
 * FAKE_OPENCODE_SLOW_START_MS (report the address, and answer `/api/info`,
 * that long late: a start a test can stop midway), FAKE_OPENCODE_SLOW_PROMPT_MS
 * (a prompt that starts an execution is admitted that long after it arrives,
 * as a loaded server stores one: an interrupt meanwhile finds nothing running),
 * FAKE_OPENCODE_PERSIST=1 (its sessions — their messages, rules and inbox —
 * outlive the server, beside OPENCODE_DB, as real 2.2.5 keeps them in its
 * database: a server started on the same database finds them, and an input
 * still in a session's inbox when its server died is delivered with that
 * session's next prompt), FAKE_OPENCODE_SYSTEM_CONFIG / …_LATE (the JSON of a
 * system config document, `/etc/opencode/opencode.json`, which `GET
 * /api/config` lists above the injected config: from the start, or once a
 * prompt was posted).
 *
 * A location first loaded under a repository has its version control run
 * unasked, with the server's environment, as real 2.2.5 does (`loadVcs`).
 *
 * A fork keeps its source's directory, as real 2.2.5's does; `POST
 * …/move` rebinds a session to another (one that exists).
 * `GET /__fake/state` (test-only, no auth) returns everything recorded;
 * `POST /__fake/delete/<id>[?quiet=1]` deletes a session (quiet: no event);
 * `POST /__fake/tamper/<id>` sets its rules to allow-all and saves an "always";
 * `POST /__fake/died/<id>` leaves its record as a server that died
 * mid-execution does (busy, never idle again, nothing running).
 */

import { accessSync, appendFileSync, constants, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const password = process.env.OPENCODE_PASSWORD ?? "";
const version = process.env.FAKE_OPENCODE_VERSION ?? "2.2.5";
/**
 * The injected config as opencode 2.2.5 reads it: `{file:<path>}` replaced
 * in the JSON text by the file's trimmed content, JSON-escaped (a missing
 * file: empty; `~/` is the server's home, a relative path is the location's
 * directory's: `ConfigVariable.substitute` reads the injected config as
 * `virtual` in the location), `{env:NAME}` by the server's variable. Read
 * again for each location the server loads (a session's directory, the
 * first time one is used), as 2.2.5 does: a key file removed while the
 * server runs is empty for every location loaded after (`state.providersAt`).
 */
function readConfig(directory = process.cwd()): Record<string, unknown> {
  const raw = (process.env.OPENCODE_CONFIG_CONTENT ?? "{}")
    .replace(/\{env:([^}]+)\}/g, (_, name: string) => JSON.stringify(process.env[name] ?? "").slice(1, -1))
    .replace(/\{file:[^}]+\}/g, (token) => {
      let content = "";
      const path = token.slice("{file:".length, -1);
      try {
        content = readFileSync(path.startsWith("~/") ? join(homedir(), path.slice(2)) : resolve(directory, path), "utf8");
      } catch {
        /* missing: empty, as opencode */
      }
      return JSON.stringify(content.trim()).slice(1, -1);
    });
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}
const config = readConfig();
const SLOW_START_MS = Number(process.env.FAKE_OPENCODE_SLOW_START_MS ?? 0);
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
  /** Interrupted after its prompt was admitted, before its execution started: as real 2.2.5, that execution is stopped. */
  cancelPending?: boolean;
  inbox: Array<{ id: string; text: string; delivery: string }>;
  title?: string;
  fork?: Json;
  /** The running total `session.usage.updated` reports. */
  usage: { cost: number; input: number; output: number; reasoning: number; read: number; write: number };
  titled: boolean;
  /** "gap-tail": the execution's end falls in a feed gap, after an input waits behind it. */
  tailGap?: boolean;
  /** A subagent's child session its parent's call waits on: the parent's interrupt stops it too. */
  foreground?: boolean;
  /** What its shell commands run with (`PUT …/environment`); the server's own when unset. */
  env?: Record<string, string>;
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
    PATH: process.env.PATH,
    passwordSet: password.length > 0,
    leakedUserVar: process.env.OPENCODE_USER_SETTING,
    leakedSecret: process.env.CODEOID_API_KEY,
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
    XDG_STATE_HOME: process.env.XDG_STATE_HOME,
    XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
    /** Every variable the server was started with, by name. */
    names: Object.keys(process.env).sort(),
  },
  /** The injected config's text as the server got it (before substitution). */
  configText: process.env.OPENCODE_CONFIG_CONTENT ?? "",
  config,
  /** Each location's providers, as its config was read when the location was first used. */
  providersAt: {} as Record<string, unknown>,
  argv: process.argv.slice(2),
  /** The directory it was started in. */
  cwd: process.cwd(),
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
  /** `POST …/move` calls that moved a session. */
  moves: [] as Json[],
  interrupts: [] as string[],
  /** Executions interrupted before their first step, whose request real 2.2.5 may have sent: spend nobody reports. */
  unreported: 0,
  inboxCancels: [] as string[],
  mcpPromptCalls: [] as Json[],
  shellRan: [] as string[],
  /** URLs a webfetch call really fetched (each redirect hop too). */
  fetched: [] as string[],
  /** `PUT …/environment` calls, in order. */
  environments: [] as Json[],
  shellsRemoved: [] as string[],
  saved: process.env.FAKE_OPENCODE_SAVED === "1" ? [{ id: "prm_1", action: "shell", resource: "git *" }] : ([] as Json[]),
  savedRemoved: [] as string[],
};

const sessions = new Map<string, Ses>();
/** FAKE_OPENCODE_PERSIST=1: where the sessions outlive the server, as real 2.2.5's database keeps them. */
const PERSIST = process.env.FAKE_OPENCODE_PERSIST === "1" && process.env.OPENCODE_DB ? `${process.env.OPENCODE_DB}.fake-sessions.json` : null;
/** Background shells still running: id → its session, and how to end it. */
const shells = new Map<string, { sessionID: string; directory: string; command: string; finish: (state: string) => void }>();
const mounts = new Map<string, Map<string, Json>>(); // directory → name → config
const pendingPerms = new Map<string, { req: Json; resolve: (r: { decision: string; message?: string }) => void }>();
const pendingForms = new Map<string, { form: Json; resolve: (r: { answer?: Json; cancelled?: string; interrupted?: boolean }) => void }>();
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
  persistSoon();
}

let persisting = false;
/** Write the sessions out once the change being made is done (a server killed now keeps what it had stored). */
function persistSoon(): void {
  if (!PERSIST || persisting) return;
  persisting = true;
  queueMicrotask(() => {
    persisting = false;
    const keep = [...sessions.values()].map(({ cancel: _c, log: _l, executing: _e, cancelPending: _p, ...rest }) => rest);
    writeFileSync(PERSIST, JSON.stringify({ counter, sessions: keep }));
  });
}

/** The sessions an earlier server on this database stored (FAKE_OPENCODE_PERSIST=1). */
function restoreSessions(): void {
  if (!PERSIST || !existsSync(PERSIST)) return;
  const saved = JSON.parse(readFileSync(PERSIST, "utf8")) as { counter: number; sessions: Ses[] };
  counter = Math.max(counter, saved.counter);
  for (const ses of saved.sessions) sessions.set(ses.id, { ...ses, log: [], executing: false, cancel: null });
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
  // Stored as real 2.2.5 stores an aborted step: ended, with what it cost.
  const m = ses.messages.find((x) => x.id === msg);
  if (m) Object.assign(m, { cost: 0.0123, tokens: TOKENS, error: { type: "aborted", message: "Step interrupted" }, time: { ...m.time, completed: Date.now() } });
  durable(ses, "session.step.failed", { assistantMessageID: msg, error: { type: "aborted", message: "Step interrupted" }, cost: 0.0123, tokens: TOKENS });
  bill(ses, 0.0123, TOKENS);
  throw new Cancelled();
}

/**
 * As an interrupt does on real 2.2.5: the session's open forms are
 * cancelled, announced (`form.cancelled`) — unless FAKE_OPENCODE_FORM_CANCEL_UNSEEN=1,
 * as if the feed dropped that event (the call's end still comes).
 */
function dropForms(sessionID: string): void {
  for (const [id, f] of [...pendingForms]) {
    if (f.form.sessionID !== sessionID) continue;
    pendingForms.delete(id);
    if (process.env.FAKE_OPENCODE_FORM_CANCEL_UNSEEN !== "1") ephemeral("form.cancelled", { id, sessionID });
    f.resolve({ interrupted: true });
  }
}

function askForm(ses: Ses, form: Json): Promise<{ answer?: Json; cancelled?: string; interrupted?: boolean }> {
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
  const model = ses.model ?? { providerID: "anthropic", id: "claude-sonnet-4" };
  // As stored by real 2.2.5: each assistant message names its model.
  ses.messages.push({ id: msg, type: "assistant", model, content: [], time: { created: Date.now() } });
  durable(ses, "session.step.started", { assistantMessageID: msg, agent: ses.agent ?? "build", model, started: Date.now() });
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
  if (text.startsWith("unasked-shell:")) {
    const command = text.slice("unasked-shell:".length);
    const msg = step(ses);
    const id = nextId("call");
    const input = { command };
    ses.messages.find((x) => x.id === msg)?.content?.push({ type: "tool", id, name: "shell", state: { status: "running", input, metadata: {} } });
    durable(ses, "session.tool.input.started", { assistantMessageID: msg, id, name: "shell" });
    durable(ses, "session.tool.called", { assistantMessageID: msg, id, input, executed: false });
    // No command in it: real 2.2.5 asks nothing, and runs it with the session's environment.
    const env: Record<string, string | undefined> = ses.env ?? process.env;
    const output = [...command.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => env[m[1]!] ?? "").join("\n") || "(no output)";
    state.shellRan.push(command);
    const content = [{ type: "text", text: output }];
    const block = toolBlock(ses, msg, id);
    if (block) block.state = { status: "completed", input, content };
    durable(ses, "session.tool.success", { assistantMessageID: msg, id, content, executed: true });
    endStep(ses, msg);
    const msg2 = step(ses);
    await say(ses, msg2, "ran it");
    endStep(ses, msg2);
    return "succeeded";
  }
  if (text === "__shell-wake") {
    const msg = step(ses);
    const r = await toolCall(ses, msg, "shell", { command: "echo woke-tool" }, { action: "shell", resources: ["echo woke-tool"] });
    endStep(ses, msg);
    const msg2 = step(ses);
    await say(ses, msg2, r.ok ? "woke and ran it" : `woke, refused: ${r.message}`);
    endStep(ses, msg2);
    return "succeeded";
  }
  if (text.includes("bg-shell")) {
    const msg = step(ses);
    const command = "sleep 1; echo bg";
    const id = nextId("call");
    const input = { command, background: true };
    ses.messages.find((x) => x.id === msg)?.content?.push({ type: "tool", id, name: "shell", state: { status: "running", input, metadata: {} } });
    durable(ses, "session.tool.input.started", { assistantMessageID: msg, id, name: "shell" });
    durable(ses, "session.tool.called", { assistantMessageID: msg, id, input, executed: false });
    const reply = await askPermission(ses, { action: "shell", resources: [command], source: { type: "tool", messageID: msg, id } });
    if (reply.decision === "interrupted") interruptedCall(ses, msg, id);
    if (reply.decision !== "once") {
      durable(ses, "session.tool.failed", { assistantMessageID: msg, id, error: { type: "permission.rejected", message: reply.message ?? "" }, executed: false });
      endStep(ses, msg);
      return "succeeded";
    }
    const shellID = nextId("sh");
    const content = [{ type: "text", text: `Command moved to the background (shell ID: ${shellID}).` }];
    durable(ses, "session.tool.success", { assistantMessageID: msg, id, content, metadata: { status: "running", shellID }, executed: true });
    endStep(ses, msg);
    const msg2 = step(ses);
    await say(ses, msg2, "started it in the background");
    endStep(ses, msg2);
    let ended = false;
    const finish = (shellState: string) => {
      if (ended) return;
      ended = true;
      shells.delete(shellID);
      // As real 2.2.5 (`notifyWhenDone`): a finished, failed or removed job wakes its session.
      void (async () => {
        while (ses.executing) await sleep(10);
        const inboxID = nextId("msg");
        durable(ses, "session.inbox.enqueued", { inboxID, item: { type: "synthetic", payload: { text: `<shell id="${shellID}" state="${shellState}">`, metadata: { source: "shell" } }, delivery: "steer" } });
        ses.messages.push({ id: inboxID, type: "synthetic", time: { created: Date.now() } });
        await startExecution(ses, "__shell-wake", inboxID);
      })();
    };
    shells.set(shellID, { sessionID: ses.id, directory: ses.directory, command, finish });
    setTimeout(() => finish("completed"), Number(process.env.FAKE_OPENCODE_BG_SHELL_MS ?? 400));
    return "succeeded";
  }
  if (text.startsWith("ask-shell:")) {
    // A shell call of exactly this input (`{"command": …, "workdir": …}`), asked
    // first. Nothing runs here: an allowed call answers "ran it".
    const input = JSON.parse(text.slice("ask-shell:".length)) as Json;
    const msg = step(ses);
    const r = await toolCall(ses, msg, "shell", input, { action: "shell", resources: [String(input.command ?? "")] });
    endStep(ses, msg);
    const msg2 = step(ses);
    await say(ses, msg2, r.ok ? "ran it" : `not allowed: ${r.message}`);
    endStep(ses, msg2);
    return "succeeded";
  }
  if (text.includes("use-shell")) {
    const msg = step(ses);
    const r = await toolCall(ses, msg, "shell", { command: "ls -la /tmp", description: "list tmp" }, { action: "shell", resources: ["ls -la /tmp"], save: ["ls *"] });
    // A bare reject (no feedback) aborts the step, and the execution ends
    // interrupted. As on real 2.2.5 the model had answered: the step is billed.
    if (!r.ok && !r.message) {
      const m = ses.messages.find((x) => x.id === msg);
      if (m) Object.assign(m, { cost: 0.0123, tokens: TOKENS, error: { type: "aborted", message: "Step interrupted" }, time: { ...m.time, completed: Date.now() } });
      durable(ses, "session.step.failed", { assistantMessageID: msg, error: { type: "aborted", message: "Step interrupted" }, cost: 0.0123, tokens: TOKENS });
      bill(ses, 0.0123, TOKENS);
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
  if (text.includes("use-grep-home")) {
    // As real 2.2.5 (`FileAccess.resolve`): `~/…` is the server's home, asked
    // as an external directory first, then as the grep itself.
    const msg = step(ses);
    const id = nextId("call");
    const input = { pattern: "apiKey", path: "~/.codeoid/config.json" };
    const dir = join(process.env.OPENCODE_TEST_HOME ?? homedir(), ".codeoid");
    ses.messages.find((x) => x.id === msg)?.content?.push({ type: "tool", id, name: "grep", state: { status: "running", input, metadata: {} } });
    durable(ses, "session.tool.input.started", { assistantMessageID: msg, id, name: "grep" });
    durable(ses, "session.tool.called", { assistantMessageID: msg, id, input, executed: false });
    const source = { type: "tool", messageID: msg, id };
    let reply = await askPermission(ses, { action: "external_directory", resources: [`${dir}/*`], save: [`${dir}/*`], source });
    if (reply.decision === "once") reply = await askPermission(ses, { action: "grep", resources: [input.pattern], save: ["*"], metadata: { root: ".", path: input.path }, source });
    if (reply.decision === "once") durable(ses, "session.tool.success", { assistantMessageID: msg, id, content: [{ type: "text", text: "grep ran" }], executed: true });
    else durable(ses, "session.tool.failed", { assistantMessageID: msg, id, error: { type: "permission.rejected", message: reply.message ?? "" }, executed: false });
    endStep(ses, msg);
    return "succeeded";
  }
  if (text.includes("use-patch-two")) {
    // As real 2.2.5's patch tool (GPT-family models): one "edit" request
    // naming every target, relative to the workdir as written.
    const msg = step(ses);
    const patchText = "*** Begin Patch\n*** Add File: notes.txt\n+hi\n*** Update File: inner/link/config.json\n@@\n-a\n+b\n*** End Patch";
    const r = await toolCall(ses, msg, "patch", { patchText }, {
      action: "edit",
      resources: ["notes.txt", "inner/link/config.json"],
      metadata: { filepath: "notes.txt, inner/link/config.json", files: [{ file: "notes.txt" }, { file: "inner/link/config.json" }] },
    });
    endStep(ses, msg);
    const msg2 = step(ses);
    await say(ses, msg2, r.ok ? "patched" : `refused: ${r.message}`);
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
      metadata: { kind: "question", tool: { messageID: msg, id: call } },
      fields: [
        { key: "q0", type: "string", title: "Pick", description: "Which?", options: [{ value: "A", label: "Option A" }, { value: "B", label: "Option B" }], custom: true },
        { key: "q1", type: "boolean", title: "Sure?" },
      ],
    });
    if (r.interrupted) interruptedCall(ses, msg, call);
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
    // "subagent-gapunasked:<line>": the feed drops as the call is approved; the child, created in the gap, runs <line> unasked.
    const unaskedLine = /subagent-gapunasked:(.*)$/s.exec(text)?.[1];
    const gap: { up?: () => void } = {};
    if (unaskedLine !== undefined) gap.up = dropFeed();
    // Continuing an existing child (the call's `sessionID`): opencode reuses it and announces nothing.
    const continued = /continue:(ses_\w+)/.exec(text);
    const child = (continued ? sessions.get(continued[1]!) : undefined) ?? createSession({ parentID: ses.id, directory: ses.directory, title: "look around", agent: "explore" });
    child.foreground = !background;
    await sleep(20);
    // "subagent-gapend" / "background-gap": the feed drops once the child's call is approved,
    // over the rest of the child's run (and, for a background one, the parent's follow-up).
    let childOutput = "found it";
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
    // "… free-child": the subagent runs on a model of its own (the `subagent` tool's `model`), which opencode bills $0.
    if (text.includes("free-child")) child.model = { providerID: "free", id: "m-1" };
    const childTurn = async (afterReply?: () => void) => {
      const cm = step(child);
      if (text.includes("subagent-fail")) {
        // As real 2.2.5 aborts a step: billed (the model answered before it
        // was stopped), and the execution ends interrupted.
        const error = { type: "aborted", message: "Step interrupted" };
        const m = child.messages.find((x) => x.id === cm);
        if (m) Object.assign(m, { cost: 0.25, tokens: TOKENS, error, time: { ...m.time, completed: Date.now() } });
        durable(child, "session.step.failed", { assistantMessageID: cm, error, cost: 0.25, tokens: TOKENS });
        bill(child, 0.25, TOKENS);
        durable(child, "session.execution.interrupted", { reason: "user" });
        child.idle = Date.now();
        child.outcome = "interrupted";
        return false;
      }
      if (unaskedLine !== undefined) {
        // As real 2.2.5: no command in it, so nothing asks; it runs with the
        // child's environment — the server's own until codeoid sets one.
        const id = nextId("call");
        const input = { command: unaskedLine };
        const env: Record<string, string | undefined> = child.env ?? process.env;
        childOutput = [...unaskedLine.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => env[m[1]!] ?? "").join("\n") || "(no output)";
        state.shellRan.push(unaskedLine);
        const content = [{ type: "text", text: childOutput }];
        child.messages.find((x) => x.id === cm)?.content?.push({ type: "tool", id, name: "shell", state: { status: "completed", input, content } });
        durable(child, "session.tool.input.started", { assistantMessageID: cm, id, name: "shell" });
        durable(child, "session.tool.called", { assistantMessageID: cm, id, input, executed: false });
        durable(child, "session.tool.success", { assistantMessageID: cm, id, content, executed: true });
        endStep(child, cm, 0.5);
        child.idle = Date.now();
        child.outcome = "succeeded";
        durable(child, "session.execution.succeeded", {});
        return true;
      }
      // The child asks too, under its own session id.
      const cr = await toolCall(child, cm, "shell", { command: "grep -r auth ." }, { action: "shell", resources: ["grep -r auth ."] }, afterReply);
      endStep(child, cm, text.includes("free-child") ? 0 : 0.5);
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
    const block = { type: "tool", id: call, name: "subagent", state: { status: "completed", input: {}, content: [{ type: "text", text: ok ? childOutput : "child refused" }], metadata: { sessionID: child.id, status: "completed" } } };
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
  if (text.includes("errs-awaiting-push")) {
    const msg = step(ses);
    for (let i = 0; i < 100 && ses.inbox.length === 0; i++) {
      await sleep(20);
      check();
    }
    const error = { type: "provider.invalid-request", message: "The model rejected the request", status: 400 };
    // A provider error bills nothing on real 2.2.5.
    durable(ses, "session.step.failed", { assistantMessageID: msg, error });
    durable(ses, "session.execution.failed", { error });
    return "failed";
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
    // Not a shape real 2.2.5 was seen in (it fails an answered attempt first, "midstream:"): a retry straight after part of an answer.
    if (text.includes("retry-after-text")) ephemeral("session.text.delta", { sessionID: ses.id, assistantMessageID: msg, ordinal: 0, delta: "partial" });
    // As real 2.2.5 numbers it: the attempt being scheduled, so the first retry is attempt 2.
    durable(ses, "session.retry.scheduled", { assistantMessageID: msg, attempt: 2, at: Date.now() + 1000, error: { type: "provider.overloaded", message: "overloaded", status: 529 } });
    await say(ses, msg, "after retry");
    endStep(ses, msg);
    return "succeeded";
  }
  if (text.startsWith("midstream:")) {
    // As real 2.2.5 fails an attempt whose response broke off after the
    // model answered part of it: the step fails with status 200 (the
    // response's), unbilled, though the request was served; the retry
    // runs in a new message after a synthetic "continue" one.
    const [kind, then] = text.slice("midstream:".length).split(":");
    const error =
      kind === "reset"
        ? { type: "provider.transport", message: "Connection lost while reading the response: ECONNRESET: The socket connection was closed unexpectedly.", status: 200 }
        : { type: "provider.invalid-output", message: "OpenAI Chat stream ended without finish_reason", status: 200 };
    const msg = step(ses);
    await say(ses, msg, "partial answer words ");
    const m = ses.messages.find((x) => x.id === msg);
    if (m) Object.assign(m, { finish: "error", error, time: { ...m.time, streamed: Date.now(), completed: Date.now() } });
    durable(ses, "session.step.failed", { assistantMessageID: msg, error });
    durable(ses, "session.retry.scheduled", { assistantMessageID: msg, attempt: 2, at: Date.now() + 30, error });
    await sleep(30);
    ses.messages.push({ id: nextId("msg"), type: "synthetic", text: "The previous response was interrupted. Continue from where you left off without repeating completed content.", time: { created: Date.now() } });
    const retry = step(ses);
    if (then === "refused") {
      const refused = { type: "provider.transport", message: "ECONNREFUSED: Unable to connect. Is the computer able to access the url?" };
      durable(ses, "session.retry.scheduled", { assistantMessageID: retry, attempt: 3, at: Date.now() + 30, error: refused });
      await sleep(30);
      durable(ses, "session.step.started", { assistantMessageID: retry, agent: ses.agent ?? "build", model: ses.model ?? { providerID: "anthropic", id: "claude-sonnet-4" }, started: Date.now() });
      durable(ses, "session.step.failed", { assistantMessageID: retry, error: refused });
      durable(ses, "session.execution.failed", { error: refused });
      return "failed";
    }
    await say(ses, retry, "final words");
    endStep(ses, retry);
    return "succeeded";
  }
  if (text.startsWith("transport:")) {
    const kind = text.slice("transport:".length);
    const error = {
      type: "provider.transport",
      message: kind === "reset" ? "ECONNRESET: The socket connection was closed unexpectedly." : "ECONNREFUSED: Unable to connect. Is the computer able to access the url?",
    };
    const msg = step(ses);
    durable(ses, "session.retry.scheduled", { assistantMessageID: msg, attempt: 2, at: Date.now() + 30, error });
    await sleep(30);
    // opencode starts the same step again for the retry.
    durable(ses, "session.step.started", { assistantMessageID: msg, agent: ses.agent ?? "build", model: ses.model ?? { providerID: "anthropic", id: "claude-sonnet-4" }, started: Date.now() });
    if (kind === "refused-after-text") {
      ephemeral("session.text.delta", { sessionID: ses.id, assistantMessageID: msg, ordinal: 0, delta: "partial" });
      await sleep(5);
    }
    durable(ses, "session.step.failed", { assistantMessageID: msg, error });
    durable(ses, "session.execution.failed", { error });
    return "failed";
  }
  if (text.includes("fail")) {
    // As real 2.2.5 fails a provider error: a 429 is retried first, and the
    // failed step bills nothing (no cost, no tokens) — the model never answered.
    const msg = step(ses);
    const error = { type: "provider.rate-limit", message: "Rate limit reached", status: 429, retryAfterMs: 5000 };
    durable(ses, "session.retry.scheduled", { assistantMessageID: msg, attempt: 2, at: Date.now() + 50, error });
    await sleep(50);
    durable(ses, "session.step.failed", { assistantMessageID: msg, error });
    durable(ses, "session.execution.failed", { error });
    return "failed";
  }
  if (text.includes("compact-interrupt")) {
    const msg = step(ses);
    await say(ses, msg, "before compaction");
    endStep(ses, msg);
    // Real 2.2.5 announces no compaction start; a request's spend comes only as it finishes.
    for (let i = 0; i < 200 && !signal.cancelled; i++) await sleep(10);
    durable(ses, "session.compaction.failed", { reason: "auto", error: { type: "compaction.interrupted", message: "Compaction was interrupted" } });
    return "interrupted";
  }
  if (text.includes("compact")) {
    // As real 2.2.x compacts: each of its requests is billed in the running
    // total as it happens; its end reports their sum. It announces no start.
    const msg = step(ses);
    await say(ses, msg, "before compaction");
    endStep(ses, msg);
    bill(ses, 0.002, COMPACTION_TOKENS);
    bill(ses, 0.001, COMPACTION_TOKENS);
    const sum = { input: 2 * COMPACTION_TOKENS.input, output: 2 * COMPACTION_TOKENS.output, reasoning: 0, cache: { read: 0, write: 0 } };
    durable(ses, "session.compaction.ended", { reason: "auto", cost: 0.003, tokens: sum });
    const msg2 = step(ses);
    await say(ses, msg2, "after compaction");
    endStep(ses, msg2);
    return "succeeded";
  }
  if (text.includes("zero-cost")) {
    if (text.includes("mixed")) {
      const priced = step(ses);
      await say(ses, priced, "priced");
      endStep(ses, priced);
    }
    const msg = step(ses);
    await say(ses, msg, "free to opencode");
    endStep(ses, msg, 0);
    return "succeeded";
  }
  if (text.includes("no-usage")) {
    const msg = step(ses);
    await say(ses, msg, "no usage");
    const m = ses.messages.find((x) => x.id === msg);
    if (m) Object.assign(m, { finish: "stop", time: { ...m.time, streamed: Date.now(), completed: Date.now() } });
    durable(ses, "session.step.ended", { assistantMessageID: msg, finish: "stop" });
    return "succeeded";
  }
  if (text.includes("costly-free")) {
    // Three steps that used tokens opencode billed $0 for (a model its catalog doesn't price).
    for (let i = 0; i < 3; i++) {
      const msg = step(ses);
      await sleep(60);
      check();
      endStep(ses, msg, 0);
    }
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
  if (text.includes("gap-tail")) {
    const msg = step(ses);
    await say(ses, msg, "first part");
    endStep(ses, msg);
    ses.tailGap = true;
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
  if (text.includes("gap-reason-ask")) {
    const msg = step(ses);
    ses.messages.find((x) => x.id === msg)?.content?.push({ type: "reasoning", text: "pondering the calls" });
    durable(ses, "session.reasoning.started", { assistantMessageID: msg, ordinal: 0 });
    ephemeral("session.reasoning.delta", { sessionID: ses.id, assistantMessageID: msg, ordinal: 0, delta: "pondering" });
    await sleep(20);
    const up = dropFeed();
    setTimeout(up, 400);
    durable(ses, "session.reasoning.ended", { assistantMessageID: msg, ordinal: 0, text: "pondering the calls" });
    const [a, b] = await Promise.all([
      toolCall(ses, msg, "shell", { command: "echo one", description: "first" }, { action: "shell", resources: ["echo one"] }),
      toolCall(ses, msg, "shell", { command: "echo two", description: "second" }, { action: "shell", resources: ["echo two"] }),
    ]);
    endStep(ses, msg, 0.0123, TOKENS, "tool-calls");
    const msg2 = step(ses);
    await say(ses, msg2, a.ok && b.ok ? "ran both" : "refused");
    endStep(ses, msg2);
    return "succeeded";
  }
  if (text.includes("interrupt-gap")) {
    // The feed drops while the call waits at the gate, and stays down past
    // codeoid's interrupt settle wait: the interrupt's end falls in the gap.
    const msg = step(ses);
    let up: (() => void) | undefined;
    const timer = setTimeout(() => {
      up = dropFeed();
      setTimeout(() => up?.(), 7_000);
    }, 100);
    try {
      await toolCall(ses, msg, "shell", { command: "echo never", description: "x" }, { action: "shell", resources: ["echo never"] });
    } finally {
      clearTimeout(timer);
    }
    endStep(ses, msg);
    return "succeeded";
  }
  if (text.includes("startgap-idle")) {
    const up = dropFeed();
    const msg = step(ses);
    await say(ses, msg, "said in the gap");
    endStep(ses, msg);
    setTimeout(up, 200);
    while (!signal.cancelled) await sleep(20);
    throw new Cancelled();
  }
  if (text.includes("startgap-ask")) {
    const up = dropFeed();
    setTimeout(up, 400);
    const msg = step(ses);
    const m = ses.messages.find((x) => x.id === msg) as (Json & { answered?: { cost: number; tokens: Json } }) | undefined;
    if (m) m.answered = { cost: 0.0123, tokens: TOKENS };
    await toolCall(ses, msg, "shell", { command: "echo startgap", description: "x" }, { action: "shell", resources: ["echo startgap"] });
    endStep(ses, msg);
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

/** Between an execution's last step and its end. */
const END_WINDOW_MS = 30;

async function startExecution(ses: Ses, text: string, inboxID?: string): Promise<void> {
  ses.executing = true;
  ses.busy = Date.now();
  const signal = { cancelled: ses.cancelPending === true };
  ses.cancelPending = false;
  ses.cancel = () => {
    signal.cancelled = true;
  };
  durable(ses, "session.execution.started", {});
  if (inboxID) durable(ses, "session.inbox.delivered", { inboxID });
  let outcome: "succeeded" | "failed" | "interrupted";
  try {
    // Interrupted as its prompt was stored: as real 2.2.5, the step's request
    // has often gone out already, but no step is announced or stored, and
    // nothing reports its spend (`state.unreported`).
    if (signal.cancelled) {
      state.unreported++;
      throw new Cancelled();
    }
    outcome = await runScenario(ses, text, signal);
    // A queued input is delivered inside the running execution, after its reply.
    for (let i = ses.inbox.findIndex((x) => x.delivery === "queue"); outcome === "succeeded" && i >= 0; i = ses.inbox.findIndex((x) => x.delivery === "queue")) {
      const [item] = ses.inbox.splice(i, 1);
      deliver(ses, item!);
      outcome = await runScenario(ses, item!.text, signal);
    }
  } catch (err) {
    if (!(err instanceof Cancelled)) throw err;
    // As real 2.2.5 stops a step while the model still answers: it fails
    // with no usage (the response's usage never came), billed nothing. One
    // whose response had ended (`answered`: a call waiting on its request)
    // fails with what it used, billed.
    for (const m of ses.messages) {
      if (m.type !== "assistant" || m.time?.completed) continue;
      const error = { type: "aborted", message: "Step interrupted" };
      const answered = (m as { answered?: { cost: number; tokens: Json } }).answered;
      Object.assign(m, { error, time: { ...m.time, completed: Date.now() }, ...(answered ?? {}) });
      durable(ses, "session.step.failed", { assistantMessageID: m.id, error, ...(answered ?? {}) });
      if (answered) bill(ses, answered.cost, answered.tokens);
    }
    outcome = "interrupted";
  }
  // As real 2.2.x: the last step has ended, the execution hasn't yet. An
  // input queued from here on isn't taken by this execution; it runs next.
  let tail: (() => void) | null = null;
  if (ses.tailGap && outcome === "succeeded" && !signal.cancelled) {
    // "gap-tail": an input waits behind the last step, then the end falls in a feed gap.
    ses.tailGap = false;
    for (let i = 0; i < 100 && ses.inbox.length === 0; i++) await sleep(20);
    tail = dropFeed();
  } else if (outcome === "succeeded" && !signal.cancelled) {
    await sleep(END_WINDOW_MS);
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
  // A steer (or a queued input) that came after the last step runs next, in
  // an execution of its own, after a failed execution too (real 2.2.5).
  const steer = outcome === "succeeded" || outcome === "failed" ? ses.inbox.findIndex((x) => x.delivery === "steer" || x.delivery === "queue") : -1;
  if (steer >= 0) {
    const [item] = ses.inbox.splice(steer, 1);
    ses.messages.push({ id: item!.id, type: "user", text: item!.text, time: { created: Date.now() } });
    setTimeout(() => void startExecution(ses, item!.text, item!.id), tail ? TAIL_NEXT_START_MS : 5);
  }
  if (tail) setTimeout(tail, TAIL_UP_MS);
}

/** "gap-tail": the feed is back this long after the execution ended, the waiting input's execution starts this long after. */
const TAIL_UP_MS = 100;
const TAIL_NEXT_START_MS = 1_000;

/** Locations whose version control was looked at (once each, as 2.2.5 caches a project). */
const vcsLoaded = new Set<string>();

/**
 * What real 2.2.5 runs, unasked, in a location it loads under a repository
 * (`Project.root`: the first directory up holding a `.git` or `.hg`): git's
 * repo discovery, or hg's project id and — unless `opencode.vcs.hg` is
 * disabled — the hg plugin's branch. The `git`/`hg` on the server's PATH,
 * with its environment (`extendEnv`), hg's with `HGPLAIN=1` over it.
 */
function loadVcs(directory: string): void {
  if (vcsLoaded.has(directory)) return;
  vcsLoaded.add(directory);
  const run = (cmd: string, args: string[], cwd: string, extra: Record<string, string> = {}) => {
    // As real 2.2.5 resolves it: a relative PATH entry from the directory it runs in.
    const bin = (process.env.PATH ?? "")
      .split(":")
      .filter(Boolean)
      .map((dir) => resolve(cwd, dir, cmd))
      .find((f) => {
        try {
          accessSync(f, constants.X_OK);
          return true;
        } catch {
          return false;
        }
      });
    if (bin) Bun.spawnSync([bin, ...args], { cwd, env: { ...process.env, ...extra }, stdin: "ignore", timeout: 10_000 });
  };
  for (let at = directory; ; at = dirname(at)) {
    if (existsSync(join(at, ".git"))) {
      run("git", ["rev-parse", "--git-dir", "--git-common-dir", "--show-toplevel"], at);
      return;
    }
    if (existsSync(join(at, ".hg"))) {
      run("hg", ["log", "-r", "roots(all())", "-T", "{node}\n"], at, { HGPLAIN: "1" });
      if (!((config.plugins as string[] | undefined) ?? []).includes("-opencode.vcs.hg")) run("hg", ["branch"], at, { HGPLAIN: "1" });
      return;
    }
    if (dirname(at) === at) return;
  }
}

function createSession(input: { directory: string; permissions?: Json[]; agent?: string; model?: Json; parentID?: string; title?: string }): Ses {
  if (!(input.directory in state.providersAt)) state.providersAt[input.directory] = readConfig(input.directory).providers ?? null;
  loadVcs(input.directory);
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
    const died = /^\/__fake\/died\/([^/]+)$/.exec(path);
    if (died) {
      // What real 2.2.5 keeps of a session whose server died mid-execution:
      // `busy` past `idle` for good, though nothing runs (not in `/active`),
      // and an interrupt finds nothing to stop, so writes no `idle`.
      const target = sessions.get(died[1]!);
      if (target) {
        target.idle = Date.now() - 10;
        target.busy = Date.now();
      }
      return new Response(null, { status: target ? 204 : 404 });
    }
    if (path === "/__fake/state") return json({ ...state, sessions: [...sessions.values()].map(info), mounts: Object.fromEntries([...mounts].map(([d, m]) => [d, [...m.keys()]])) });
    // Every route needs the password, /api/info too (real 2.2.x answers 401 without it).
    if (!authorized(req)) return json({ _tag: "UnauthorizedError", message: "Authentication required" }, 401);
    if (path === "/api/info" && method === "GET") {
      await sleep(SLOW_START_MS);
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
    if (path === "/api/config" && method === "GET") {
      // As real 2.2.5, lowest priority first: codeoid's config dir (OPENCODE_CONFIG_DIR), the injected
      // config, then the system dir's documents (`/etc/opencode`), which outrank it.
      // FAKE_OPENCODE_SYSTEM_CONFIG: that document's JSON from the start; …_LATE: once a prompt was posted.
      const entries: Json[] = [];
      const dir = process.env.OPENCODE_CONFIG_DIR;
      if (dir && existsSync(join(dir, "opencode.json"))) {
        let info: Json = {};
        try {
          info = JSON.parse(readFileSync(join(dir, "opencode.json"), "utf8")) as Json;
        } catch {}
        entries.push({ type: "document", path: join(dir, "opencode.json"), info });
      }
      if (dir) entries.push({ type: "directory", path: dir });
      entries.push({ type: "document", info: readConfig(directoryOf(req, url)) });
      const system = process.env.FAKE_OPENCODE_SYSTEM_CONFIG ?? (state.prompts.length > 0 ? process.env.FAKE_OPENCODE_SYSTEM_CONFIG_LATE : undefined);
      if (system) entries.push({ type: "document", path: "/etc/opencode/opencode.json", info: JSON.parse(system) as Json }, { type: "directory", path: "/etc/opencode" });
      return json(entries);
    }
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
    if (path === "/api/shell" && method === "GET") {
      const dir = directoryOf(req, url);
      const list = process.env.FAKE_OPENCODE_SHELLS_UNLISTED === "1" ? [] : [...shells].filter(([, sh]) => sh.directory === dir);
      return json({ location: { directory: dir }, data: list.map(([id, sh]) => ({ id, status: "running", command: sh.command, cwd: sh.directory, shell: "/bin/bash", file: "/tmp/x.out", metadata: { sessionID: sh.sessionID }, time: { started: Date.now() } })) });
    }
    m = /^\/api\/shell\/([^/]+)$/.exec(path);
    if (m && method === "DELETE") {
      const sh = shells.get(m[1]!);
      state.shellsRemoved.push(m[1]!);
      sh?.finish("error");
      return new Response(null, { status: 204 });
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
    if (rest === "/environment" && method === "PUT") {
      if (process.env.FAKE_OPENCODE_ENV_FAIL === "child" && ses.parentID) return json({ _tag: "UnknownError", message: "environment refused" }, 500);
      ses.env = { ...(body.variables as Record<string, string>) };
      state.environments.push({ sessionID: ses.id, variables: body.variables });
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
    if (rest === "/move" && method === "POST") {
      // As real 2.2.5: a directory that doesn't exist is refused; an idle
      // session takes the move at once, in a short execution of its own (on
      // the feed after the reply with FAKE_OPENCODE_MOVE_FEED_LAG_MS).
      const directory = String(body.directory ?? "");
      if (!existsSync(directory)) return json({ _tag: "InvalidRequestError", message: `Directory does not exist: ${directory}` }, 400);
      if (process.env.FAKE_OPENCODE_MOVE_IGNORED !== "1") ses.directory = directory;
      state.moves.push({ sessionID: ses.id, directory });
      ses.busy = Date.now();
      ses.idle = Date.now();
      const lag = Number(process.env.FAKE_OPENCODE_MOVE_FEED_LAG_MS ?? 0);
      const announce = () => {
        durable(ses, "session.execution.started", {});
        durable(ses, "session.execution.succeeded", {});
      };
      if (lag > 0) setTimeout(announce, lag);
      else announce();
      return new Response(null, { status: 204 });
    }
    if (rest === "/model" && method === "POST") {
      // As real 2.2.5: a switch with no variant is stored as the base one, "default".
      const model = body.model as Json;
      ses.model = { ...model, variant: model.variant ?? "default" };
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
      if (!ses.executing && process.env.FAKE_OPENCODE_SLOW_PROMPT_MS) await sleep(Number(process.env.FAKE_OPENCODE_SLOW_PROMPT_MS));
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
      if (ses.cancel) ses.cancel();
      else if (running) ses.cancelPending = true;
      dropAsks(ses.id);
      dropForms(ses.id);
      for (const child of sessions.values()) {
        if (child.parentID !== ses.id || !child.foreground || !child.executing) continue;
        dropAsks(child.id);
        dropForms(child.id);
      }
      return json({ interrupted: running });
    }
    if (rest === "/inbox" && method === "GET") {
      // As real 2.2.5: what waits, oldest first (only user inputs here; it lists synthetic, compaction and move items too).
      return json({ data: ses.inbox.map((x) => ({ id: x.id, sessionID: ses.id, time: { created: ses.created }, type: "user", payload: { text: x.text }, delivery: x.delivery })) });
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
restoreSessions();
process.stdin.on("end", () => process.exit(0));
process.stdin.on("close", () => process.exit(0));
setTimeout(() => process.stdout.write(`${JSON.stringify({ url: `http://127.0.0.1:${port}` })}\n`), SLOW_START_MS);
process.stdin.resume();
