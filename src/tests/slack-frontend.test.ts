/**
 * Slack frontend (S1): sign-in by slash command, a DM to the conductor,
 * approval cards only their own user can press, and "needs you" notices —
 * against a real SessionManager and a scripted backend, with Slack's side a
 * recording fake.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodeoidConfig } from "../config.js";
import type { ProviderEvent } from "../daemon/providers/interface.js";
import { MockSessionProvider } from "../daemon/providers/mock/session-provider.js";
import { SessionManager } from "../daemon/session-manager.js";
import { Store } from "../daemon/store.js";
import { TranscriptStore } from "../daemon/transcript.js";
import type { TokenVerifier } from "../daemon/verifier.js";
import { SlackFrontend, esc, looksLikeSecret } from "../frontends/slack/index.js";
import type { SlackTransport, SocketLike } from "../frontends/slack/socket.js";
import type { FrontendContext } from "../frontends/types.js";
import { ALL_SCOPES } from "../protocol/scopes.js";
import type { AuthContext } from "../protocol/types.js";

const OWNER = "U_OWNER";
const OTHER = "U_OTHER";
const STRANGER = "U_STRANGER";
const AUTH: Record<string, AuthContext> = {
  "tok-owner": { sub: "user:owner", name: "Owner", scopes: [...ALL_SCOPES] as AuthContext["scopes"], delegationDepth: 0, accountId: "acc", projectId: "proj" },
  "tok-other": { sub: "user:other", name: "Other", scopes: [...ALL_SCOPES] as AuthContext["scopes"], delegationDepth: 0, accountId: "acc", projectId: "proj" },
  "tok-expired": { sub: "user:owner", name: "Owner", scopes: [...ALL_SCOPES] as AuthContext["scopes"], delegationDepth: 0, accountId: "acc", projectId: "proj", exp: 1 },
};
const done: ProviderEvent = { type: "turn_done", result: { providerId: "mock", model: "m", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, totalCostUsd: 0, durationMs: 1 } } as ProviderEvent;

let tmp: string;
let store: Store;
let transcript: TranscriptStore;
let manager: SessionManager;
let script: ProviderEvent[][];
let providers: MockSessionProvider[];
let calls: Array<{ method: string; body: Record<string, unknown> }>;
let frontend: SlackFrontend;

function transport(): SlackTransport {
  return {
    fetch: async (url, init) => {
      const method = String(url).split("/api/")[1] ?? "";
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      calls.push({ method, body });
      if (method === "apps.connections.open") return Response.json({ ok: true, url: "wss://test" });
      if (method === "conversations.open") return Response.json({ ok: true, channel: { id: `D-${String(body.users)}` } });
      return Response.json({ ok: true, ts: `${calls.length}.0` });
    },
    connect: () => ({ send() {}, close() {}, onopen: null, onmessage: null, onclose: null, onerror: null }) as SocketLike,
  };
}

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "codeoid-slack-"));
  store = new Store(join(tmp, "codeoid.db"));
  transcript = new TranscriptStore(join(tmp, "transcripts"));
  providers = [];
  calls = [];
  script = [[{ type: "text_done", content: "Hello from the conductor." } as ProviderEvent, done]];
  const config = {
    daemonUrl: "ws://127.0.0.1:7400",
    dbPath: join(tmp, "codeoid.db"),
    transcriptDir: join(tmp, "transcripts"),
    auth: { baseUrl: "http://localhost:1" },
    zeroidUrl: "http://localhost:1",
    workspaceIndex: { enabled: false, episodeThreshold: 5, timeThresholdMs: 60_000, debounceMs: 15_000 },
    compress: { enabled: false, excludeCommands: [], excludePatterns: [], compressPipes: false, minBytes: 1024 },
    labeling: {},
    telemetry: { osc8: "auto" },
    autoRotate: { enabled: false, warnPct: 0.6, rotatePct: 0.8, hardRotatePct: 0.9, minTurnsBeforeRotate: 3, strategy: "task-anchor" },
    session: {},
    conductor: { enabled: true, name: "conductor", provider: "claude" },
  } as unknown as CodeoidConfig;
  manager = new SessionManager(store, transcript, undefined, undefined, undefined, {
    config,
    _testProviderFactory: () => {
      const p = new MockSessionProvider("mock", script);
      providers.push(p);
      return p;
    },
  });
  const verifier = {
    mode: "zeroid",
    verify: async (token: string) => {
      const a = AUTH[token];
      if (!a) throw new Error("invalid token");
      return a;
    },
  } as unknown as TokenVerifier;
  frontend = new SlackFrontend("xapp-test", "xoxb-test", [OWNER, OTHER], { transport: transport() });
  await frontend.start({ manager, store, auth: { baseUrl: "http://localhost:1" }, verifier, httpServer: null as never, host: "127.0.0.1", port: 0 } as FrontendContext);
});

afterEach(async () => {
  await frontend.stop();
  try {
    await manager.drain(2_000);
  } catch {}
  try {
    await transcript.flush();
  } catch {}
  store.close();
  rmSync(tmp, { recursive: true, force: true });
});

const slash = (user: string, text: string) =>
  frontend.handleEnvelope({ envelope_id: "e", type: "slash_commands", payload: { command: "/codeoid", user_id: user, text, channel_id: "D1" }, accepts_response_payload: true });
const dm = (user: string, text: string, channel = `D-${user}`) =>
  frontend.handleEnvelope({ envelope_id: "e", type: "events_api", payload: { event: { type: "message", channel_type: "im", user, text, channel } } });
const press = (user: string, action: "approve" | "deny", approvalId: string) =>
  frontend.handleEnvelope({ envelope_id: "e", type: "interactive", payload: { type: "block_actions", user: { id: user }, actions: [{ action_id: action, value: approvalId }], channel: { id: `D-${OWNER}` }, message: { ts: "9.0" } } });
const posts = () => calls.filter((c) => c.method === "chat.postMessage").map((c) => String(c.body.text));

async function until(cond: () => boolean, ms = 3_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("condition not reached");
    await Bun.sleep(5);
  }
}

describe("sign-in", () => {
  it("only allowlisted Slack users; a key signs them in, and the sign-in is audited", async () => {
    expect(await slash(STRANGER, "auth tok-owner")).toMatchObject({ text: expect.stringContaining("allowlist") });
    expect(await slash(OWNER, "ls")).toMatchObject({ text: expect.stringContaining("Not signed in") });
    expect(await slash(OWNER, "auth bad")).toMatchObject({ text: expect.stringContaining("failed") });
    expect(await slash(OWNER, "auth tok-owner")).toMatchObject({ text: expect.stringContaining("Signed in as Owner") });
    const audit = store.database.prepare("SELECT action, detail FROM audit_log WHERE action = 'slack.auth'").all() as Array<{ detail: string }>;
    expect(audit[0]?.detail).toContain(`slack_user_id=${OWNER}`);
  });

  it("an expired sign-in is refused, and lets go of what it held", async () => {
    await slash(OWNER, "auth tok-expired");
    expect(await slash(OWNER, "ls")).toMatchObject({ text: expect.stringContaining("expired") });
  });

  it("a stranger's DM is refused and never reaches a session", async () => {
    await dm(STRANGER, "hi");
    await until(() => posts().some((t) => t.includes("allowlist")));
    expect(providers.length).toBe(0);
  });
});

describe("talking to the conductor", () => {
  it("a DM goes to the conductor (made on first use) and its reply comes back to the DM", async () => {
    await slash(OWNER, "auth tok-owner");
    await dm(OWNER, "what's going on?");
    await until(() => posts().includes("Hello from the conductor."));
    const reply = calls.find((c) => c.body.text === "Hello from the conductor.");
    expect(reply?.body.channel).toBe(`D-${OWNER}`);
    expect(await slash(OWNER, "who")).toMatchObject({ text: expect.stringContaining("conductor") });
  });

  it("only the user's own DM messages count: a bot's, an edit or a channel message is ignored", async () => {
    await slash(OWNER, "auth tok-owner");
    await frontend.handleEnvelope({ envelope_id: "e", type: "events_api", payload: { event: { type: "message", channel_type: "im", user: OWNER, text: "x", channel: "D", bot_id: "B1" } } });
    await frontend.handleEnvelope({ envelope_id: "e", type: "events_api", payload: { event: { type: "message", channel_type: "channel", user: OWNER, text: "x", channel: "C1" } } });
    await frontend.handleEnvelope({ envelope_id: "e", type: "events_api", payload: { event: { type: "message", subtype: "message_changed", channel_type: "im", user: OWNER, text: "x", channel: "D" } } });
    await Bun.sleep(50);
    expect(providers.length).toBe(0);
  });
});

describe("approvals", () => {
  it("a card with Approve and Deny; another user can't press it; the owner's press decides", async () => {
    script = [[{ type: "tool_start", toolId: "t1", sdkToolUseId: "s1", name: "Write", input: { file_path: join(tmp, "a.txt"), content: "x" }, approvalId: "ap-1" } as ProviderEvent, done]];
    await slash(OWNER, "auth tok-owner");
    await slash(OTHER, "auth tok-other");
    await dm(OWNER, "write it");
    await until(() => calls.some((c) => c.method === "chat.postMessage" && Array.isArray(c.body.blocks)));
    const card = calls.find((c) => Array.isArray(c.body.blocks))!;
    const section = JSON.stringify(card.body.blocks);
    expect(section).toContain("Approval needed");
    expect(section).toContain("approve");
    await press(OTHER, "approve", "ap-1");
    await until(() => calls.some((c) => c.method === "chat.update" && String(c.body.text).includes("isn't yours")));
    expect(providers.at(-1)!.canUseToolResults.length).toBe(0);
    await press(OWNER, "approve", "ap-1");
    await until(() => (providers.at(-1)?.canUseToolResults.length ?? 0) > 0);
    expect(providers.at(-1)!.canUseToolResults[0]!.behavior).toBe("allow");
    await until(() => calls.some((c) => c.method === "chat.update" && String(c.body.text).includes("Approved")));
    // Pressed once: a second press finds nothing waiting.
    await press(OWNER, "approve", "ap-1");
    await until(() => calls.some((c) => c.method === "chat.update" && String(c.body.text).includes("no longer waiting")));
  });

  it("another session of yours waiting on you is told in your DM", async () => {
    await slash(OWNER, "auth tok-owner");
    await dm(OWNER, "hello");
    await until(() => posts().includes("Hello from the conductor."));
    script = [[{ type: "tool_start", toolId: "t2", sdkToolUseId: "s2", name: "Write", input: { file_path: join(tmp, "b.txt"), content: "x" }, approvalId: "ap-2" } as ProviderEvent, done]];
    const made = (await manager.handle({ type: "session.create", id: "c", name: "worker-x", workdir: tmp } as never, AUTH["tok-owner"]!, { id: "cli", auth: AUTH["tok-owner"]!, send: () => {} })) as { type: string };
    expect(made.type).toBe("response.ok");
    const session = manager.findByName("worker-x", AUTH["tok-owner"]!)!;
    void session.send("go", AUTH["tok-owner"]!);
    await until(() => posts().some((t) => t.includes("worker-x") && t.includes("waiting for you")));
  });
});

describe("text", () => {
  it("Slack's control characters are escaped, so a name can't make a mention or a link", () => {
    expect(esc("<!channel> & <https://x|y>")).toBe("&lt;!channel&gt; &amp; &lt;https://x|y&gt;");
  });
});

describe("audit round 1", () => {
  it("a key pasted into the DM is never sent on", async () => {
    await slash(OWNER, "auth tok-owner");
    await dm(OWNER, "here it is zid_sk_live_SECRET1234567890");
    await until(() => posts().some((t) => t.includes("looks like a key")));
    expect(providers.length).toBe(0);
    expect(looksLikeSecret("eyJhbGciOiJFUzI1.eyJzdWIiOiJ1c2Vy.c2lnbmF0dXJlMTI")).toBe(true);
    expect(looksLikeSecret("xoxb-1234567890-abcdefgh")).toBe(true);
    expect(looksLikeSecret("please fix the zid parsing")).toBe(false);
  });

  it("a card raised under one sign-in is never answered under another", async () => {
    script = [[{ type: "tool_start", toolId: "t1", sdkToolUseId: "s1", name: "Write", input: { file_path: join(tmp, "a.txt"), content: "x" }, approvalId: "ap-h1" } as ProviderEvent, done]];
    await slash(OWNER, "auth tok-owner");
    await dm(OWNER, "write it");
    await until(() => calls.some((c) => Array.isArray(c.body.blocks)));
    // The same Slack user signs in as someone else: the card they held is let go.
    await slash(OWNER, "auth tok-other");
    await press(OWNER, "approve", "ap-h1");
    await until(() => calls.some((c) => c.method === "chat.update" && String(c.body.text).includes("no longer waiting")));
    expect(providers.at(-1)!.canUseToolResults.length).toBe(0);
  });

  it("attaching to a session already waiting shows its card; one answered elsewhere closes", async () => {
    await slash(OWNER, "auth tok-owner");
    script = [[{ type: "tool_start", toolId: "t3", sdkToolUseId: "s3", name: "Write", input: { file_path: join(tmp, "c.txt"), content: "x" }, approvalId: "ap-m1" } as ProviderEvent, done]];
    await manager.handle({ type: "session.create", id: "c", name: "waiter", workdir: tmp } as never, AUTH["tok-owner"]!, { id: "cli", auth: AUTH["tok-owner"]!, send: () => {} });
    const session = manager.findByName("waiter", AUTH["tok-owner"]!)!;
    void session.send("go", AUTH["tok-owner"]!);
    await until(() => session.pendingToolApprovals().length > 0);
    await slash(OWNER, "attach waiter");
    await until(() => calls.some((c) => Array.isArray(c.body.blocks) && JSON.stringify(c.body.blocks).includes("ap-m1")));
    // Answered from elsewhere (the CLI): the card's buttons go.
    await manager.handle({ type: "session.approve", id: "a", sessionId: session.id, approvalId: "ap-m1", approved: false } as never, AUTH["tok-owner"]!, { id: "cli2", auth: AUTH["tok-owner"]!, send: () => {} });
    await until(() => calls.some((c) => c.method === "chat.update" && String(c.body.text).includes("Answered elsewhere")));
  });

  it("model text is escaped and links don't unfurl", async () => {
    script = [[{ type: "text_done", content: "<!channel> look <https://evil|Approve here>" } as ProviderEvent, done]];
    await slash(OWNER, "auth tok-owner");
    await dm(OWNER, "hi");
    await until(() => posts().some((t) => t.includes("&lt;!channel&gt;")));
    const post = calls.find((c) => String(c.body.text).includes("&lt;!channel&gt;"))!;
    expect(post.body.unfurl_links).toBe(false);
    expect(String(post.body.text)).not.toContain("<!channel>");
  });

  it("signing in opens the DM, so replies have somewhere to go before the first message", async () => {
    await slash(OWNER, "auth tok-owner");
    expect(calls.some((c) => c.method === "conversations.open" && c.body.users === OWNER)).toBe(true);
  });
});

describe("one workspace", () => {
  it("with a workspace id set, another workspace's events are ignored", async () => {
    await frontend.stop();
    frontend = new SlackFrontend("xapp-test", "xoxb-test", [OWNER], { transport: transport(), teamId: "T1" });
    const verifier = { mode: "zeroid", verify: async (t: string) => AUTH[t] ?? Promise.reject(new Error("bad")) } as unknown as TokenVerifier;
    await frontend.start({ manager, store, auth: { baseUrl: "http://localhost:1" }, verifier, httpServer: null as never, host: "127.0.0.1", port: 0 } as FrontendContext);
    expect(await frontend.handleEnvelope({ envelope_id: "e", type: "slash_commands", payload: { team_id: "T2", user_id: OWNER, text: "auth tok-owner" } })).toBeUndefined();
    expect(await frontend.handleEnvelope({ envelope_id: "e", type: "slash_commands", payload: { team_id: "T1", user_id: OWNER, text: "auth tok-owner" } })).toMatchObject({ text: expect.stringContaining("Signed in") });
  });
});
