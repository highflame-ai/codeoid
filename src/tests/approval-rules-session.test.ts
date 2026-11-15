/**
 * Saved approval rules (docs/secrets-and-memory-design.md §4.1), through a
 * real SessionManager, Session and MockSessionProvider (which calls the gate
 * as a backend does): a card offers the rules its call could be saved as;
 * only the owner's own token saves them; a saved rule runs the next call in
 * its scope unasked in guarded mode only, never one that always asks; a deny
 * rule refuses in every mode; the rules are listed, added and removed with
 * the settings scopes; a session's own rules end with it.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodeoidConfig } from "../config.js";
import type { ProviderEvent } from "../daemon/providers/interface.js";
import { McpHub } from "../daemon/mcp/hub.js";
import { McpRegistry } from "../daemon/mcp/registry.js";
import { MockSessionProvider } from "../daemon/providers/mock/session-provider.js";
import { workstreamsSchema } from "../daemon/workstreams/schema.js";
import { SessionManager } from "../daemon/session-manager.js";
import { loadShellParser } from "../daemon/shell/parse.js";
import { Store } from "../daemon/store.js";
import { TranscriptStore } from "../daemon/transcript.js";
import type { ApprovalRuleInfo, AuthContext, Scope, SessionInfo, SessionMode } from "../protocol/types.js";

const SCOPES: Scope[] = ["session:create", "session:list", "session:attach", "session:send", "session:approve", "session:destroy", "settings:read", "settings:write"];
const AUTH: AuthContext = { sub: "owner", scopes: SCOPES, delegationDepth: 0, accountId: "a", projectId: "p" };
const DELEGATED: AuthContext = { ...AUTH, delegationDepth: 1 };
const OTHER: AuthContext = { ...AUTH, sub: "someone-else" };
const CLIENT = { id: "c1", send: () => {} } as never;

let tmp: string;
let repo: string;
let store: Store;
let transcript: TranscriptStore;
let manager: SessionManager;
let script: ProviderEvent[][];
let providers: MockSessionProvider[] = [];
let audits: Array<{ action: string; detail?: string }> = [];

beforeAll(async () => {
  await loadShellParser();
});

beforeEach(() => {
  providers = [];
  audits = [];
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "codeoid-rules-")));
  repo = join(tmp, "repo");
  mkdirSync(join(repo, "sub"), { recursive: true });
  store = new Store(join(tmp, "codeoid.db"));
  const audit = store.audit.bind(store);
  store.audit = (subject, action, sessionId, detail) => {
    audits.push({ action, ...(detail ? { detail } : {}) });
    audit(subject, action, sessionId, detail);
  };
  transcript = new TranscriptStore(join(tmp, "transcripts"));
  const config = {
    daemonUrl: "ws://127.0.0.1:7400",
    dbPath: join(tmp, "codeoid.db"),
    transcriptDir: join(tmp, "transcripts"),
    auth: { baseUrl: "http://localhost:8899" },
    zeroidUrl: "http://localhost:8899",
    workspaceIndex: { enabled: false, episodeThreshold: 5, timeThresholdMs: 60_000, debounceMs: 15_000 },
    compress: { enabled: false, excludeCommands: [], excludePatterns: [], compressPipes: false, minBytes: 1024 },
    labeling: {},
    telemetry: { osc8: "auto" },
    autoRotate: { enabled: false, warnPct: 0.6, rotatePct: 0.8, hardRotatePct: 0.9, minTurnsBeforeRotate: 3, strategy: "task-anchor" },
    session: {},
    approvals: { autoAllowLowRisk: false, askOnUnknown: true, sessionGrantHours: 8 },
    workstreams: workstreamsSchema.parse({ items: [{ id: "proj", match: { paths: [repo] } }] }),
  } as unknown as CodeoidConfig;
  manager = new SessionManager(store, transcript, undefined, undefined, undefined, {
    config,
    _testProviderFactory: () => {
      const p = new MockSessionProvider("mock", script);
      providers.push(p);
      return p;
    },
  });
});

afterEach(async () => {
  try {
    await manager.drain(3000);
  } catch {}
  await transcript.flush();
  store.close();
  rmSync(tmp, { recursive: true, force: true });
});

function call(name: string, input: Record<string, unknown>, shellCwd?: string | null): ProviderEvent[] {
  return [
    {
      type: "tool_start",
      toolId: "t1",
      sdkToolUseId: "sdk-t1",
      name,
      input,
      approvalId: `ap-${Math.random().toString(36).slice(2)}`,
      ...(shellCwd !== undefined ? { shellCwd } : {}),
    },
    { type: "tool_complete", sdkToolUseId: "sdk-t1", output: "ok", success: true },
    {
      type: "turn_done",
      result: { providerId: "mock", model: "m", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, totalCostUsd: 0, durationMs: 1 },
    },
  ];
}

async function until(cond: () => boolean, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await Bun.sleep(5);
  }
}

async function create(mode: SessionMode = "guarded", dir = repo, auth = AUTH) {
  const made = (await manager.handle({ type: "session.create", id: "c", name: "s", workdir: dir } as never, auth, CLIENT)) as { data: SessionInfo };
  const session = manager._sessionForTest(made.data.id)!;
  if (mode !== "guarded") session.setMode(mode, ...(mode === "autonomous" ? [10] : []) as [number?]);
  return session;
}

/** Run one call in a new session: whether it asked, what the card offered, and how the gate ended. */
async function run(name: string, input: Record<string, unknown>, opts: { mode?: SessionMode; dir?: string; shellCwd?: string | null; auth?: AuthContext } = {}) {
  script = [call(name, input, opts.shellCwd)];
  const session = await create(opts.mode, opts.dir, opts.auth);
  const sending = session.send("go", AUTH);
  const provider = providers.at(-1)!;
  await until(() => provider.canUseToolResults.length > 0 || session.pendingToolApprovals().length > 0);
  const pending = session.pendingToolApprovals();
  return { session, provider, pending, asked: pending.length > 0, sending };
}

async function finish(r: Awaited<ReturnType<typeof run>>) {
  if (r.asked) await r.session.interrupt(AUTH);
  await r.sending.catch(() => {});
}

function result(r: { provider: MockSessionProvider }) {
  return r.provider.canUseToolResults[0] as { behavior?: string; message?: string } | undefined;
}

async function rules(auth = AUTH): Promise<ApprovalRuleInfo[]> {
  const res = (await manager.handle({ type: "approval_rules.list", id: "l" } as never, auth, CLIENT)) as { rules: ApprovalRuleInfo[] };
  return res.rules;
}

async function add(rule: string, scope: string, extra: Record<string, unknown> = {}, effect = "allow", auth = AUTH) {
  return (await manager.handle({ type: "approval_rules.add", id: "a", rule, effect, scope, ...extra } as never, auth, CLIENT)) as {
    type: string;
    rule?: ApprovalRuleInfo;
    error?: string;
  };
}

describe("a card offers its call as a rule, and the owner saves it", () => {
  test("allow in this repository: the next session there runs it unasked", async () => {
    const first = await run("Bash", { command: "npm test" });
    expect(first.asked).toBe(true);
    expect(first.pending[0]!.ruleOffer).toMatchObject({ rules: ["Bash(npm test:*)"], scopes: ["session", "repository"], repository: repo });
    const res = await manager.handle(
      { type: "session.approve", id: "ap", sessionId: first.session.id, approvalId: first.pending[0]!.approvalId, approved: true, save: "repository" } as never,
      AUTH,
      CLIENT,
    );
    expect(res).toMatchObject({ type: "response.ok", data: { outcome: "settled", savedRules: ["Bash(npm test:*)"] } });
    await first.sending;
    expect(result(first)?.behavior).toBe("allow");
    expect(audits.some((a) => a.action === "approval_rule.add" && a.detail?.includes("scope=repository"))).toBe(true);

    const second = await run("Bash", { command: "npm test -- --watch=false 2>&1 | tail -20" });
    expect(second.asked).toBe(false);
    expect(result(second)?.behavior).toBe("allow");
    await second.sending;
    expect(audits.some((a) => a.action === "session.rule_allow" && a.detail?.includes("scope=repository"))).toBe(true);
    const [saved] = await rules();
    expect(saved).toMatchObject({ rule: "Bash(npm test:*)", effect: "allow", scope: { kind: "repository", label: repo }, useCount: 1 });
    expect(saved!.lastUsedAt).toBeGreaterThan(0);
  });

  test("allow for this session: another session still asks, and the rule ends with the session", async () => {
    const first = await run("Bash", { command: "make lint" });
    const approvalId = first.pending[0]!.approvalId;
    await manager.handle({ type: "session.approve", id: "ap", sessionId: first.session.id, approvalId, approved: true, save: "session" } as never, AUTH, CLIENT);
    await first.sending;
    const [saved] = await rules();
    expect(saved).toMatchObject({ rule: "Bash(make lint:*)", scope: { kind: "session", key: first.session.id } });
    expect(saved!.expiresAt! - saved!.createdAt).toBe(8 * 3_600_000);

    // The same session, next turn: unasked.
    script.push(call("Bash", { command: "make lint" }));
    const provider = providers.at(-1)!;
    await first.session.send("again", AUTH);
    expect(provider.canUseToolResults.at(-1)).toMatchObject({ behavior: "allow" });

    const other = await run("Bash", { command: "make lint" });
    expect(other.asked).toBe(true);
    await finish(other);

    await manager.handle({ type: "session.destroy", id: "d", sessionId: first.session.id } as never, AUTH, CLIENT);
    expect(await rules()).toEqual([]);
  });

  test("a delegated token can allow once but not save; the card stays open", async () => {
    const r = await run("Bash", { command: "npm test" });
    const approvalId = r.pending[0]!.approvalId;
    const refused = await manager.handle(
      { type: "session.approve", id: "ap", sessionId: r.session.id, approvalId, approved: true, save: "repository" } as never,
      DELEGATED,
      CLIENT,
    );
    expect(refused).toMatchObject({ type: "response.error", code: "forbidden" });
    expect(r.session.pendingToolApprovals()).toHaveLength(1);
    expect(audits.some((a) => a.action === "approval_rule.save_refused")).toBe(true);
    expect(await rules()).toEqual([]);
    await manager.handle({ type: "session.approve", id: "ap2", sessionId: r.session.id, approvalId, approved: true } as never, DELEGATED, CLIENT);
    await r.sending;
    expect(result(r)?.behavior).toBe("allow");
  });

  test("a denial saves nothing", async () => {
    const r = await run("Bash", { command: "npm test" });
    const res = await manager.handle(
      { type: "session.approve", id: "ap", sessionId: r.session.id, approvalId: r.pending[0]!.approvalId, approved: false, save: "session" } as never,
      AUTH,
      CLIENT,
    );
    expect(res).toMatchObject({ type: "response.error" });
    await finish(r);
  });
});

describe("what rules never run", () => {
  test("a high-risk command asks whatever rule matches it, and offers none", async () => {
    expect((await add("Bash(git push:*)", "everywhere")).type).toBe("approval_rules.add.result");
    const r = await run("Bash", { command: "git push --force origin main" });
    expect(r.asked).toBe(true);
    expect(r.pending[0]!.ruleOffer).toBeUndefined();
    await finish(r);
  });

  test("a credential read is refused in every mode, rules or not", async () => {
    await add("Bash(cat:*)", "everywhere");
    const r = await run("Bash", { command: "cat ~/.codeoid/config.json" });
    expect(result(r)?.behavior).toBe("deny");
    await finish(r);
  });

  test("interactive mode asks whatever rules say", async () => {
    await add("Bash(npm test:*)", "everywhere");
    const r = await run("Bash", { command: "npm test" }, { mode: "interactive" });
    expect(r.asked).toBe(true);
    expect(r.pending[0]!.ruleOffer).toBeUndefined();
    await finish(r);
  });

  test("a line with a command no rule covers asks", async () => {
    await add("Bash(npm test:*)", "everywhere");
    const r = await run("Bash", { command: "npm test && npm publish" });
    expect(r.asked).toBe(true);
    // The offer is only what isn't covered yet.
    expect(r.pending[0]!.ruleOffer?.rules).toEqual(["Bash(npm publish)"]);
    await finish(r);
  });

  test("another user's rules don't apply", async () => {
    await add("Bash(npm test:*)", "everywhere", {}, "allow", OTHER);
    const r = await run("Bash", { command: "npm test" });
    expect(r.asked).toBe(true);
    await finish(r);
    expect(await rules()).toEqual([]);
    expect(await rules(OTHER)).toHaveLength(1);
  });

  test("a rule for another repository doesn't apply here", async () => {
    const elsewhere = join(tmp, "elsewhere");
    mkdirSync(elsewhere);
    await add("Bash(npm test:*)", "repository", { workdir: elsewhere });
    const r = await run("Bash", { command: "npm test" });
    expect(r.asked).toBe(true);
    await finish(r);
  });
});

describe("deny rules", () => {
  test("refuse in guarded mode, with the rule named", async () => {
    await add("Bash(npm publish:*)", "everywhere", {}, "deny");
    const r = await run("Bash", { command: "sudo npm publish --tag next" });
    expect(r.asked).toBe(false);
    expect(result(r)).toMatchObject({ behavior: "deny" });
    expect(result(r)?.message).toContain("Bash(npm publish:*)");
    await r.sending;
    expect(audits.some((a) => a.action === "session.rule_deny")).toBe(true);
  });

  test("refuse in autonomous mode too", async () => {
    await add("WebFetch(domain:evil.example)", "everywhere", {}, "deny");
    const r = await run("WebFetch", { url: "https://evil.example/x", prompt: "read" }, { mode: "autonomous" });
    expect(result(r)).toMatchObject({ behavior: "deny" });
    await r.sending;
  });
});

describe("rules for MCP tools and fetches", () => {
  test("a fetch of a saved host runs unasked; another host asks", async () => {
    await add("WebFetch(domain:docs.rs)", "everywhere");
    const ok = await run("WebFetch", { url: "https://docs.rs/serde", prompt: "read" });
    expect(ok.asked).toBe(false);
    await ok.sending;
    const other = await run("WebFetch", { url: "https://docs.rs.example/serde", prompt: "read" });
    expect(other.asked).toBe(true);
    expect(other.pending[0]!.ruleOffer?.rules).toEqual(["WebFetch(domain:docs.rs.example)"]);
    await finish(other);
  });

  test("an MCP tool by name, where codeoid manages the session's MCP servers", async () => {
    manager.setMcp(new McpRegistry({}, { memoryEnabled: false }), new McpHub({}));
    await add("mcp__linear__list_issues", "everywhere");
    const ok = await run("mcp__linear__list_issues", { q: "x" });
    expect(ok.asked).toBe(false);
    await ok.sending;
    const other = await run("mcp__linear__create_issue", { title: "x" });
    expect(other.asked).toBe(true);
    await finish(other);
  });
});

describe("round 1: what else keeps a rule from running or saving", () => {
  test("a shell whose directory the backend can't say runs on no rule, and offers none", async () => {
    await add("Bash(npm test:*)", "everywhere");
    const r = await run("Bash", { command: "npm test" }, { shellCwd: null });
    expect(r.asked).toBe(true);
    expect(r.pending[0]!.ruleOffer).toBeUndefined();
    await finish(r);
  });

  test("a workstream's rule runs in its sessions only", async () => {
    await add("Bash(npm test:*)", "workstream", { workstream: "proj" });
    const inside = await run("Bash", { command: "npm test" });
    expect(inside.asked).toBe(false);
    await inside.sending;
    const elsewhere = join(tmp, "elsewhere");
    mkdirSync(elsewhere);
    const outside = await run("Bash", { command: "npm test" }, { dir: elsewhere });
    expect(outside.asked).toBe(true);
    await finish(outside);
  });

  test("a session an agent made (a delegated token) offers no save", async () => {
    const r = await run("Bash", { command: "npm test" }, { auth: DELEGATED });
    expect(r.asked).toBe(true);
    expect(r.pending[0]!.ruleOffer).toBeUndefined();
    await finish(r);
  });

  test("a save whose rules differ from what the card showed is refused, and the card stays", async () => {
    const r = await run("Bash", { command: "npm test" });
    const approvalId = r.pending[0]!.approvalId;
    const res = await manager.handle(
      { type: "session.approve", id: "ap", sessionId: r.session.id, approvalId, approved: true, save: "repository", rules: ["Bash(npm:*)"] } as never,
      AUTH,
      CLIENT,
    );
    expect(res).toMatchObject({ type: "response.error", code: "invalid_request" });
    expect(r.session.pendingToolApprovals()).toHaveLength(1);
    expect(await rules()).toEqual([]);
    await finish(r);
  });

  test("saving a call another rule covers by now succeeds and saves nothing more", async () => {
    const r = await run("Bash", { command: "npm test" });
    await add("Bash(npm test:*)", "everywhere");
    const res = await manager.handle(
      { type: "session.approve", id: "ap", sessionId: r.session.id, approvalId: r.pending[0]!.approvalId, approved: true, save: "session" } as never,
      AUTH,
      CLIENT,
    );
    expect(res).toMatchObject({ type: "response.ok", data: { savedRules: [] } });
    await r.sending;
    expect(await rules()).toHaveLength(1);
  });

  test("a deny rule refuses a command however its options are placed, in autonomous mode", async () => {
    await add("Bash(npm publish:*)", "everywhere", {}, "deny");
    const r = await run("Bash", { command: "npm --registry=https://r.example publish" }, { mode: "autonomous" });
    expect(result(r)).toMatchObject({ behavior: "deny" });
    await r.sending;
  });
});

describe("approval_rules.* messages", () => {
  test("adding needs settings:write and the caller's own token", async () => {
    expect(await add("Bash(npm test:*)", "everywhere", {}, "allow", { ...AUTH, scopes: ["settings:read"] })).toMatchObject({ type: "response.error", code: "forbidden" });
    expect(await add("Bash(npm test:*)", "everywhere", {}, "allow", DELEGATED)).toMatchObject({ type: "response.error", code: "forbidden" });
    expect(await add("Bash(bash:*)", "everywhere")).toMatchObject({ type: "response.error", code: "invalid_request" });
    expect(await add("Bash(npm test:*)", "workstream", { workstream: "nope" })).toMatchObject({ type: "response.error", code: "not_found" });
    expect(await add("Bash(npm test:*)", "session")).toMatchObject({ type: "response.error", code: "invalid_request" });
    expect(await rules()).toEqual([]);
  });

  test("a session scope must be the caller's own session", async () => {
    const theirs = await create("guarded", repo, OTHER);
    expect(await add("Bash(npm test:*)", "session", { sessionId: theirs.id })).toMatchObject({ type: "response.error", code: "not_found" });
  });

  test("saving the same rule twice keeps one; removing takes it out of use", async () => {
    const a = await add("Bash(npm test:*)", "everywhere");
    const b = await add("Bash(npm test:*)", "everywhere");
    expect(a.rule!.id).toBe(b.rule!.id);
    expect(await rules()).toHaveLength(1);
    expect(await manager.handle({ type: "approval_rules.remove", id: "r", ruleId: a.rule!.id } as never, OTHER, CLIENT)).toMatchObject({ type: "response.error", code: "not_found" });
    expect(await manager.handle({ type: "approval_rules.remove", id: "r", ruleId: a.rule!.id } as never, AUTH, CLIENT)).toMatchObject({ type: "response.ok" });
    expect(await rules()).toEqual([]);
    const r = await run("Bash", { command: "npm test" });
    expect(r.asked).toBe(true);
    await finish(r);
    // The second add changed nothing: one audit row.
    expect(audits.filter((x) => x.action.startsWith("approval_rule.")).map((x) => x.action)).toEqual(["approval_rule.add", "approval_rule.remove"]);
  });
});
