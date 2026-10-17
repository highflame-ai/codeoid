/**
 * Claude accounts (claude-accounts.ts): the store, the subprocess environment
 * an account produces, and the daemon surface (scopes, never a token on the
 * wire, per-session choice persisted, fail-closed on a missing account).
 *
 * The switch itself (query rebuilt on the new credential, same backing session
 * resumed) is pinned in provider-claude.test.ts; the isolated named-account
 * login in backend-login.test.ts.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyAccountEnv,
  CLAUDE_CREDENTIAL_ENV,
  ClaudeAccountError,
  ClaudeAccountStore,
} from "../daemon/claude-accounts.js";
import { SessionManager } from "../daemon/session-manager.js";
import { MockSessionProvider } from "../daemon/providers/mock/session-provider.js";
import { Store } from "../daemon/store.js";
import { TranscriptStore } from "../daemon/transcript.js";
import { ALL_SCOPES } from "../protocol/scopes.js";
import type { AuthContext, DaemonMessage, SessionInfo } from "../protocol/types.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codeoid-claude-accounts-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const storeAt = () => new ClaudeAccountStore(join(dir, "claude-accounts.json"));

describe("ClaudeAccountStore", () => {
  test("stores accounts 0600 and never lists a token or header value", () => {
    const store = storeAt();
    store.upsert({ name: "personal", kind: "subscription", token: "sk-ant-oat01-PERSONAL" });
    store.upsert({ name: "gw-a", kind: "gateway", token: "gw-secret", baseUrl: "https://gw.example", headers: { "x-workspace": "ws-a" } });
    expect(statSync(join(dir, "claude-accounts.json")).mode & 0o777).toBe(0o600);
    const listed = JSON.stringify(store.list());
    expect(listed).not.toContain("sk-ant-oat01-PERSONAL");
    expect(listed).not.toContain("gw-secret");
    expect(listed).not.toContain("ws-a");
    expect(store.list().find((a) => a.name === "gw-a")).toMatchObject({ baseUrl: "https://gw.example", headerNames: ["x-workspace"] });
    // Survives a reload from disk.
    expect(storeAt().get("personal")?.token).toBe("sk-ant-oat01-PERSONAL");
  });

  test("validates names, gateway URLs and headers", () => {
    const store = storeAt();
    expect(() => store.upsert({ name: "default", kind: "api-key", token: "k" })).toThrow(ClaudeAccountError);
    expect(() => store.upsert({ name: "Has Space", kind: "api-key", token: "k" })).toThrow(ClaudeAccountError);
    expect(() => store.upsert({ name: "gw", kind: "gateway", token: "t" })).toThrow(/base URL/);
    // The token rides every request: http only for loopback.
    expect(() => store.upsert({ name: "gw", kind: "gateway", token: "t", baseUrl: "http://gw.example" })).toThrow(/https/);
    expect(() => store.upsert({ name: "gw", kind: "gateway", token: "t", baseUrl: "http://127.0.0.1:9999" })).not.toThrow();
    // A line break in a header value would inject further headers.
    expect(() =>
      store.upsert({ name: "gw2", kind: "gateway", token: "t", baseUrl: "https://g.example", headers: { "x-a": "1\r\nx-evil: 2" } }),
    ).toThrow(/line break/);
    expect(() => store.upsert({ name: "k", kind: "api-key", token: "line1\nline2" })).toThrow(/single/);
    expect(() => store.upsert({ name: "k", kind: "subscription", token: "t", baseUrl: "https://x.example" })).toThrow(/no base URL/);
  });

  test("default handling: built-in until set; removing the default account clears it", () => {
    const store = storeAt();
    expect(store.getDefault()).toBe("default");
    expect(store.resolve(null)).toBeNull(); // the daemon's own environment
    store.upsert({ name: "work", kind: "subscription", token: "sk-ant-oat01-WORK" });
    store.setDefault("work");
    expect(store.resolve(null)?.name).toBe("work");
    expect(() => store.setDefault("nope")).toThrow(ClaudeAccountError);
    store.remove("work");
    expect(store.getDefault()).toBe("default");
  });

  test("a session pinned to a removed account throws — never falls back to another credential", () => {
    const store = storeAt();
    store.upsert({ name: "work", kind: "subscription", token: "sk-ant-oat01-WORK" });
    expect(store.resolve("work")?.name).toBe("work");
    store.remove("work");
    expect(() => store.resolve("work")).toThrow(/no longer exists/);
  });

  test("the fingerprint changes with the token (a re-login) and is stable otherwise", () => {
    const store = storeAt();
    store.upsert({ name: "work", kind: "subscription", token: "sk-ant-oat01-ONE" });
    const a = store.resolve("work")!.fingerprint;
    expect(store.resolve("work")!.fingerprint).toBe(a);
    store.upsert({ name: "work", kind: "subscription", token: "sk-ant-oat01-TWO" });
    expect(store.resolve("work")!.fingerprint).not.toBe(a);
    expect(a).not.toContain("ONE");
  });
});

describe("applyAccountEnv", () => {
  const competing = Object.fromEntries(CLAUDE_CREDENTIAL_ENV.map((k) => [k, `daemon-${k}`]));
  const base = { PATH: "/usr/bin", HOME: "/home/u", ...competing };

  test("subscription: only its token survives", () => {
    const env = applyAccountEnv(base, { name: "s", kind: "subscription", token: "sk-ant-oat01-X", createdAt: "", updatedAt: "" });
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat01-X");
    for (const k of CLAUDE_CREDENTIAL_ENV.filter((k) => k !== "CLAUDE_CODE_OAUTH_TOKEN")) expect(env[k]).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
  });

  test("api-key: only the key survives", () => {
    const env = applyAccountEnv(base, { name: "k", kind: "api-key", token: "sk-ant-api-X", createdAt: "", updatedAt: "" });
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-api-X");
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
  });

  test("gateway: base URL, token and headers; nothing else", () => {
    const env = applyAccountEnv(base, {
      name: "g",
      kind: "gateway",
      token: "gw",
      baseUrl: "https://gw.example",
      headers: { "x-a": "1", "x-b": "2" },
      createdAt: "",
      updatedAt: "",
    });
    expect(env.ANTHROPIC_BASE_URL).toBe("https://gw.example");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("gw");
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toBe("x-a: 1\nx-b: 2");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });
});

describe("daemon surface", () => {
  const AUTH: AuthContext = {
    sub: "user:accounts",
    scopes: [...ALL_SCOPES] as AuthContext["scopes"],
    delegationDepth: 0,
    accountId: "acc",
    projectId: "proj",
  };
  const client = { id: "c", auth: AUTH, send: () => {} };
  let store: Store;
  let transcript: TranscriptStore;
  let accounts: ClaudeAccountStore;
  let manager: SessionManager;

  beforeEach(() => {
    store = new Store(join(dir, "codeoid.db"));
    transcript = new TranscriptStore(join(dir, "transcripts"));
    accounts = storeAt();
    manager = new SessionManager(store, transcript, undefined, undefined, undefined, {
      // A provider reporting id "claude", so the Claude-account paths apply.
      _testProviderFactory: () => new MockSessionProvider("claude", []),
      claudeAccounts: accounts,
    });
  });
  afterEach(async () => {
    try {
      await transcript.flush();
    } catch {}
    try {
      store.close();
    } catch {}
  });

  const handle = (msg: Parameters<SessionManager["handle"]>[0], auth: AuthContext = AUTH) =>
    manager.handle(msg, auth, { ...client, auth }) as Promise<DaemonMessage & Record<string, unknown>>;
  const create = async (name: string, claudeAccount?: string) =>
    (await handle({ type: "session.create", id: `c-${name}`, name, workdir: dir, ...(claudeAccount ? { claudeAccount } : {}) })) as {
      type: string;
      data?: SessionInfo;
      error?: string;
    };

  test("set / list / default / remove — and the list never carries a token", async () => {
    const set = await handle({ type: "claude.accounts.set", id: "s1", name: "work", kind: "subscription", token: "sk-ant-oat01-WIRE" });
    expect(set.type).toBe("claude.accounts.result");
    expect(JSON.stringify(set)).not.toContain("sk-ant-oat01-WIRE");
    const def = await handle({ type: "claude.accounts.set_default", id: "s2", name: "work" });
    expect(def).toMatchObject({ type: "claude.accounts.result", defaultAccount: "work" });
    const rm = await handle({ type: "claude.accounts.remove", id: "s3", name: "work" });
    expect(rm).toMatchObject({ type: "claude.accounts.result", defaultAccount: "default", accounts: [] });
  });

  test("scopes: reading needs settings:read, changing needs settings:write", async () => {
    const reader = { ...AUTH, scopes: ["settings:read"] as AuthContext["scopes"] };
    expect((await handle({ type: "claude.accounts.list", id: "l" }, reader)).type).toBe("claude.accounts.result");
    const denied = await handle({ type: "claude.accounts.set", id: "s", name: "w", kind: "api-key", token: "k" }, reader);
    expect(denied).toMatchObject({ type: "response.error", code: "forbidden" });
    const none = { ...AUTH, scopes: [] as AuthContext["scopes"] };
    expect(await handle({ type: "claude.accounts.list", id: "l2" }, none)).toMatchObject({ code: "forbidden" });
  });

  test("a session runs on its chosen account; the choice is persisted for resume", async () => {
    accounts.upsert({ name: "work", kind: "subscription", token: "sk-ant-oat01-WORK" });
    const created = await create("s-work", "work");
    expect(created.data).toMatchObject({ claudeAccount: "work", effectiveClaudeAccount: "work" });
    await transcript.flush();
    const meta = JSON.parse(readFileSync(join(dir, "transcripts", `${created.data!.id}.meta.json`), "utf8"));
    expect(meta.claudeAccount).toBe("work");
  });

  test("creating on an unknown account is refused", async () => {
    const created = await create("s-x", "nope");
    expect(created).toMatchObject({ type: "response.error", code: "invalid_request" });
  });

  test("a session following the default moves with it; set_claude_account pins it", async () => {
    accounts.upsert({ name: "personal", kind: "subscription", token: "sk-ant-oat01-P" });
    accounts.upsert({ name: "work", kind: "subscription", token: "sk-ant-oat01-W" });
    const s = (await create("s-follow")).data!;
    expect(s.effectiveClaudeAccount).toBe("default");
    await handle({ type: "claude.accounts.set_default", id: "d", name: "personal" });
    const listed = (await handle({ type: "session.list", id: "ls" })) as unknown as { sessions: SessionInfo[] };
    expect(listed.sessions.find((x) => x.id === s.id)?.effectiveClaudeAccount).toBe("personal");

    const pinned = await handle({ type: "session.set_claude_account", id: "p", sessionId: s.id, account: "work" });
    expect((pinned as { data?: SessionInfo }).data).toMatchObject({ claudeAccount: "work", effectiveClaudeAccount: "work" });
    const unpinned = await handle({ type: "session.set_claude_account", id: "u", sessionId: s.id, account: null });
    expect((unpinned as { data?: SessionInfo }).data?.effectiveClaudeAccount).toBe("personal");
    const bad = await handle({ type: "session.set_claude_account", id: "b", sessionId: s.id, account: "nope" });
    expect(bad).toMatchObject({ type: "response.error", code: "invalid_request" });
  });

  test("a session whose account was removed refuses to send — it never falls back", async () => {
    accounts.upsert({ name: "work", kind: "subscription", token: "sk-ant-oat01-W" });
    const s = (await create("s-gone", "work")).data!;
    await handle({ type: "claude.accounts.remove", id: "r", name: "work" });
    const sent = await handle({ type: "session.send", id: "snd", sessionId: s.id, text: "hi" });
    expect(sent).toMatchObject({ type: "response.error", code: "invalid_request" });
    expect(String((sent as { error?: string }).error)).toContain("no longer exists");
  });
});
