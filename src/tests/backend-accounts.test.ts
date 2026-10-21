/**
 * Accounts for every backend, end to end: an endpoint backend against a real
 * OpenAI-compatible server (the real OpenAIProvider, no mocks on the wire),
 * the account homes process backends run in, and the sign-ins that create
 * login accounts.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyCodexAccount,
  applyGeminiCliAccount,
  applyPiAccount,
  ensureOverlayHome,
  geminiProjectOverride,
} from "../daemon/account-apply.js";
import { AccountStore } from "../daemon/accounts.js";
import { BackendLoginBroker, CODEX_LOGIN_FLOW } from "../daemon/auth/backend-login.js";
import { EndpointStore } from "../daemon/openai-endpoints.js";
import { createDefaultProviderRegistry, registerAccountBackends } from "../daemon/providers/registry.js";
import { SessionManager } from "../daemon/session-manager.js";
import { Store } from "../daemon/store.js";
import { TranscriptStore } from "../daemon/transcript.js";
import { ALL_SCOPES } from "../protocol/scopes.js";
import type { AuthContext, DaemonMessage, SessionInfo } from "../protocol/types.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codeoid-backend-accounts-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const accountsAt = () => new AccountStore({ path: join(dir, "accounts.json"), homesRoot: join(dir, "homes"), legacyClaudePath: null });

/** Set env vars for one test, restoring them after. */
function withEnv(vars: Record<string, string | undefined>): () => void {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

// ── A real OpenAI-compatible server that knows two keys ──────────────────────

let server: ReturnType<typeof Bun.serve>;
const seen: Array<{ auth: string | null; team: string | null }> = [];
beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "GET") return Response.json({ data: [{ id: "m" }] });
      seen.push({ auth: req.headers.get("authorization"), team: req.headers.get("x-team") });
      const who = req.headers.get("authorization") === "Bearer sk-personal" ? "personal" : req.headers.get("authorization") === "Bearer sk-team" ? "team" : "endpoint";
      const body = (await req.json()) as { model: string };
      const chunk = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
      void url;
      return new Response(
        `${chunk({ id: "c", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: { role: "assistant", content: `as ${who}` }, finish_reason: "stop" }] })}data: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
});
afterAll(() => {
  server.stop(true);
});
const baseUrl = () => `http://127.0.0.1:${server.port}/v1`;

describe("daemon: accounts on an endpoint backend", () => {
  setDefaultTimeout(20_000);
  const AUTH: AuthContext = { sub: "user:acc", scopes: [...ALL_SCOPES] as AuthContext["scopes"], delegationDepth: 0, accountId: "a", projectId: "p" };
  let store: Store;
  let transcript: TranscriptStore;
  let accounts: AccountStore;
  let endpoints: EndpointStore;
  let manager: SessionManager;
  let pushed: DaemonMessage[];

  beforeEach(() => {
    seen.length = 0;
    store = new Store(join(dir, "codeoid.db"));
    transcript = new TranscriptStore(join(dir, "transcripts"));
    accounts = accountsAt();
    endpoints = new EndpointStore(join(dir, "endpoints.json"));
    manager = new SessionManager(store, transcript, undefined, undefined, undefined, { endpoints, accounts });
    pushed = [];
  });
  afterEach(async () => {
    try {
      await transcript.flush();
    } catch {}
    try {
      store.close();
    } catch {}
  });

  const client = () => ({ id: "c1", auth: AUTH, send: (m: DaemonMessage) => pushed.push(m) });
  const handle = (msg: Parameters<SessionManager["handle"]>[0], auth: AuthContext = AUTH) =>
    manager.handle(msg, auth, { ...client(), auth }) as Promise<DaemonMessage & Record<string, unknown>>;
  const replies = () => {
    const byId = new Map<string, string>();
    for (const m of pushed) if (m.type === "session.message" && m.role === "assistant") byId.set(m.messageId, String(m.content));
    return [...byId.values()];
  };
  const errors = () => pushed.flatMap((m) => (m.type === "session.message" && m.role === "system" ? [String(m.content)] : []));
  const waitFor = async (pred: () => boolean, ms = 5000) => {
    const end = Date.now() + ms;
    while (!pred()) {
      if (Date.now() > end) throw new Error(`timed out; replies=${JSON.stringify(replies())} errors=${JSON.stringify(errors())}`);
      await Bun.sleep(20);
    }
  };
  const turn = async (sessionId: string, text: string) => {
    const before = replies().length + errors().length;
    await handle({ type: "session.send", id: `s-${text}`, sessionId, text });
    await waitFor(() => replies().length + errors().length > before);
    await Bun.sleep(80);
  };

  const setup = async () => {
    await handle({ type: "endpoints.set", id: "e", name: "box", baseUrl: baseUrl(), apiKey: "sk-endpoint", models: [{ id: "m" }] });
    for (const [name, key] of [["personal", "sk-personal"], ["team", "sk-team"]] as const) {
      const r = await handle({ type: "accounts.set", id: `a-${name}`, backend: "oai:box", name, kind: "api-key", token: key });
      expect(r.type).toBe("accounts.result");
    }
  };

  test("a session switches account mid-conversation; each turn uses its account's key", async () => {
    await setup();
    const created = (await handle({ type: "session.create", id: "c", name: "s", workdir: dir, providerId: "oai:box", account: "personal" })) as { data?: SessionInfo };
    const sid = created.data!.id;
    expect(created.data).toMatchObject({ account: "personal", effectiveAccount: "personal" });
    await handle({ type: "session.attach", id: "at", sessionId: sid });
    await turn(sid, "one");
    expect(replies().at(-1)).toBe("as personal");
    const switched = await handle({ type: "session.set_account", id: "sw", sessionId: sid, account: "team" });
    expect(switched).toMatchObject({ type: "response.ok", data: { account: "team", effectiveAccount: "team" } });
    await turn(sid, "two");
    expect(replies().at(-1)).toBe("as team");
    // Back to following the default — the endpoint's own key.
    await handle({ type: "session.set_account", id: "sw2", sessionId: sid, account: null });
    await turn(sid, "three");
    expect(replies().at(-1)).toBe("as endpoint");
    // A backend default moves every follower.
    await handle({ type: "accounts.set_default", id: "d", backend: "oai:box", name: "team" });
    await turn(sid, "four");
    expect(replies().at(-1)).toBe("as team");
  });

  test("a removed account makes its sessions refuse; it never falls back to another credential", async () => {
    await setup();
    const created = (await handle({ type: "session.create", id: "c", name: "s", workdir: dir, providerId: "oai:box", account: "personal" })) as { data?: SessionInfo };
    const sid = created.data!.id;
    await handle({ type: "session.attach", id: "at", sessionId: sid });
    await handle({ type: "accounts.remove", id: "r", backend: "oai:box", name: "personal" });
    const info = (await handle({ type: "session.list", id: "l" })) as unknown as { sessions: SessionInfo[] };
    expect(info.sessions.find((x) => x.id === sid)?.effectiveAccount).toBe("personal (missing)");
    const sent = await handle({ type: "session.send", id: "x", sessionId: sid, text: "hi" });
    expect(JSON.stringify(sent).concat(errors().join(" "))).toMatch(/no longer exists/);
    expect(seen).toHaveLength(0);
  });

  test("an endpoint account stays with its server: moving the endpoint makes it refuse", async () => {
    await setup();
    const created = (await handle({ type: "session.create", id: "c", name: "s", workdir: dir, providerId: "oai:box", account: "team" })) as { data?: SessionInfo };
    const sid = created.data!.id;
    await handle({ type: "session.attach", id: "at", sessionId: sid });
    // Same server, another origin (localhost vs 127.0.0.1) — re-entering the endpoint's own key.
    await handle({ type: "endpoints.set", id: "e2", name: "box", baseUrl: `http://localhost:${server.port}/v1`, apiKey: "sk-endpoint" });
    await turn(sid, "hi");
    expect(errors().join(" ")).toMatch(/was entered for http:\/\/127\.0\.0\.1/);
    expect(seen.filter((r) => r.auth === "Bearer sk-team")).toHaveLength(0);
  });

  test("listing never carries a secret; names are refused unless replaced explicitly", async () => {
    await setup();
    const listed = await handle({ type: "accounts.list", id: "l", backend: "oai:box" });
    expect(JSON.stringify(listed)).not.toContain("sk-personal");
    expect(listed).toMatchObject({ backends: [{ backend: "oai:box", defaultAccount: "default", accounts: [{ name: "personal" }, { name: "team" }] }] });
    const again = await handle({ type: "accounts.set", id: "x", backend: "oai:box", name: "team", kind: "api-key", token: "sk-other" });
    expect(again).toMatchObject({ type: "response.error", error: expect.stringContaining("already exists") });
    const replaced = await handle({ type: "accounts.set", id: "y", backend: "oai:box", name: "team", kind: "api-key", token: "sk-other", replace: true });
    expect(replaced.type).toBe("accounts.result");
    expect(accounts.get("oai:box", "team")?.token).toBe("sk-other");
  });

  test("scopes: listing needs settings:read; changes need undelegated settings:write", async () => {
    await setup();
    const reader = { ...AUTH, scopes: ["settings:read"] as AuthContext["scopes"] };
    const delegated = { ...AUTH, delegationDepth: 1 };
    expect((await handle({ type: "accounts.list", id: "l" }, reader)).type).toBe("accounts.result");
    for (const auth of [reader, delegated]) {
      for (const msg of [
        { type: "accounts.set", id: "s", backend: "openai", name: "x", kind: "api-key", token: "k" },
        { type: "accounts.remove", id: "r", backend: "oai:box", name: "team" },
        { type: "accounts.set_default", id: "d", backend: "oai:box", name: "team" },
      ] as const) {
        expect(await handle(msg, auth)).toMatchObject({ type: "response.error", code: "forbidden" });
      }
    }
    const created = (await handle({ type: "session.create", id: "c", name: "s", workdir: dir, providerId: "oai:box" })) as { data?: SessionInfo };
    expect(await handle({ type: "session.set_account", id: "sa", sessionId: created.data!.id, account: "team" }, delegated)).toMatchObject({ code: "forbidden" });
    // Creating on an account needs settings:write.
    const sessionOnly = { ...AUTH, scopes: ["session:create"] as AuthContext["scopes"] };
    expect(await handle({ type: "session.create", id: "c2", name: "s2", workdir: dir, providerId: "oai:box", account: "team" }, sessionOnly)).toMatchObject({ code: "forbidden" });
  });

  test("a fork keeps its parent's accounts; an unknown account is refused at create", async () => {
    await setup();
    const parent = (await handle({ type: "session.create", id: "c", name: "p", workdir: dir, providerId: "oai:box", account: "team" })) as { data?: SessionInfo };
    const fork = (await handle({ type: "session.fork", id: "f", sessionId: parent.data!.id, name: "child" })) as { data?: SessionInfo };
    expect(fork.data).toMatchObject({ account: "team" });
    expect(await handle({ type: "session.create", id: "c3", name: "q", workdir: dir, providerId: "oai:box", account: "nope" })).toMatchObject({ code: "invalid_request" });
  });

  test("choices are per backend and survive a daemon restart", async () => {
    await setup();
    const created = (await handle({ type: "session.create", id: "c", name: "s", workdir: dir, providerId: "oai:box", account: "team" })) as { data?: SessionInfo };
    await handle({ type: "session.set_account", id: "x", sessionId: created.data!.id, account: "personal", backend: "openai" }).catch(() => undefined);
    await transcript.flush();
    const manager2 = new SessionManager(store, transcript, undefined, undefined, undefined, { endpoints: new EndpointStore(join(dir, "endpoints.json")), accounts: accountsAt() });
    await manager2.resumeSessions();
    const list = (await manager2.handle({ type: "session.list", id: "l" }, AUTH, client())) as unknown as { sessions: SessionInfo[] };
    expect(list.sessions.find((x) => x.id === created.data!.id)).toMatchObject({ account: "team", effectiveAccount: "team" });
  });
});

describe("keyed backends: registered by accounts as well as by an environment key", () => {
  test("openai appears once it has an account, without OPENAI_API_KEY", () => {
    const restore = withEnv({ OPENAI_API_KEY: undefined });
    try {
      const accounts = accountsAt();
      const registry = createDefaultProviderRegistry(undefined, { ...process.env, OPENAI_API_KEY: undefined }, undefined, accounts);
      expect(registry.has("openai")).toBe(false);
      accounts.upsert({ backend: "openai", name: "team", kind: "api-key", token: "k" });
      expect(registerAccountBackends(registry, accounts, { ...process.env, OPENAI_API_KEY: undefined })).toBe(true);
      expect(registry.has("openai")).toBe(true);
      expect(registry.unavailableHint("openai")).toBeUndefined();
      expect(registerAccountBackends(registry, accounts)).toBe(false);
    } finally {
      restore();
    }
  });
});

// ── Account homes for process backends ────────────────────────────────────────

describe("account homes", () => {
  test("an overlay links everything but the account's own files, follows new entries and drops stale ones", () => {
    const source = join(dir, "vendor");
    mkdirSync(join(source, "sessions"), { recursive: true });
    writeFileSync(join(source, "config.toml"), "model = 'x'");
    writeFileSync(join(source, "auth.json"), "{\"daemon\":true}");
    const target = join(dir, "acct");
    ensureOverlayHome({ source, target, own: ["auth.json"] });
    expect(readlinkSync(join(target, "config.toml"))).toBe(join(source, "config.toml"));
    expect(lstatSync(join(target, "sessions")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(target, "auth.json"))).toBe(false); // never the daemon's login
    writeFileSync(join(target, "auth.json"), "{\"account\":true}");
    writeFileSync(join(source, "state.sqlite"), "");
    rmSync(join(source, "config.toml"));
    ensureOverlayHome({ source, target, own: ["auth.json"] });
    expect(lstatSync(join(target, "state.sqlite")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(target, "config.toml"))).toBe(false);
    expect(readFileSync(join(target, "auth.json"), "utf8")).toContain("account");
    expect(lstatSync(target).mode & 0o777).toBe(0o700);
  });

  test("Codex: an API-key account signs in with codex's own command into its home; no daemon key reaches the child", () => {
    const codexHome = join(dir, "codex-default");
    mkdirSync(codexHome);
    writeFileSync(join(codexHome, "config.toml"), "");
    const fake = join(dir, "codex");
    let runs = 0;
    writeFileSync(fake, `#!/usr/bin/env bash\n[ "$1 $2" = "login --with-api-key" ] || exit 9\nread -r key\nprintf '{"auth_mode":"apikey","OPENAI_API_KEY":"%s"}' "$key" > "$CODEX_HOME/auth.json"\necho run >> "${join(dir, "runs")}"\n`);
    chmodSync(fake, 0o755);
    const restore = withEnv({ CODEX_HOME: codexHome });
    try {
      const accounts = accountsAt();
      accounts.upsert({ backend: "codex", name: "work", kind: "api-key", token: "sk-work" });
      const resolved = accounts.resolve("codex", "work")!;
      const env = applyCodexAccount(resolved, { PATH: process.env.PATH ?? "", OPENAI_API_KEY: "sk-daemon", CODEX_API_KEY: "x" }, { command: fake, argsPrefix: [] });
      expect(env.CODEX_HOME).toBe(resolved.home);
      expect(env.OPENAI_API_KEY).toBeUndefined();
      expect(env.CODEX_API_KEY).toBeUndefined();
      expect(readFileSync(join(resolved.home, "auth.json"), "utf8")).toContain("sk-work");
      expect(readlinkSync(join(resolved.home, "config.toml"))).toBe(join(codexHome, "config.toml"));
      // Once per generation of the key.
      applyCodexAccount(resolved, { PATH: process.env.PATH ?? "" }, { command: fake, argsPrefix: [] });
      runs = readFileSync(join(dir, "runs"), "utf8").trim().split("\n").length;
      expect(runs).toBe(1);
      accounts.upsert({ backend: "codex", name: "work", kind: "api-key", token: "sk-work-2", replace: true });
      applyCodexAccount(accounts.resolve("codex", "work"), { PATH: process.env.PATH ?? "" }, { command: fake, argsPrefix: [] });
      expect(readFileSync(join(resolved.home, "auth.json"), "utf8")).toContain("sk-work-2");
      // A ChatGPT account without its sign-in refuses.
      accounts.upsert({ backend: "codex", name: "chat", kind: "chatgpt-login" });
      expect(() => applyCodexAccount(accounts.resolve("codex", "chat"), {}, { command: fake, argsPrefix: [] })).toThrow(/sign it in again/);
      // No account: the daemon's own environment, untouched.
      expect(applyCodexAccount(null, { OPENAI_API_KEY: "sk-daemon" }, { command: fake, argsPrefix: [] })).toEqual({ OPENAI_API_KEY: "sk-daemon" });
    } finally {
      restore();
    }
  });

  test("Gemini CLI: the account's home selects its auth type; an API key replaces every Google credential", () => {
    const root = join(dir, "gemini-root");
    mkdirSync(join(root, ".gemini"), { recursive: true });
    writeFileSync(join(root, ".gemini", "settings.json"), JSON.stringify({ security: { auth: { selectedType: "oauth-personal" } }, mcpServers: { a: {} } }));
    writeFileSync(join(root, ".gemini", "oauth_creds.json"), "{\"daemon\":true}");
    const restore = withEnv({ GEMINI_CLI_HOME: root });
    try {
      const accounts = accountsAt();
      accounts.upsert({ backend: "gemini-cli", name: "key", kind: "api-key", token: "AIza-account" });
      const resolved = accounts.resolve("gemini-cli", "key")!;
      const env = applyGeminiCliAccount(resolved, { GOOGLE_API_KEY: "daemon", GOOGLE_CLOUD_PROJECT: "p", GEMINI_API_KEY: "daemon" });
      expect(env).toMatchObject({ GEMINI_API_KEY: "AIza-account", GEMINI_CLI_HOME: resolved.home });
      expect(env.GOOGLE_API_KEY).toBeUndefined();
      expect(env.GOOGLE_CLOUD_PROJECT).toBeUndefined();
      const settings = JSON.parse(readFileSync(join(resolved.home, ".gemini", "settings.json"), "utf8"));
      expect(settings).toMatchObject({ security: { auth: { selectedType: "gemini-api-key" } }, mcpServers: { a: {} } });
      expect(existsSync(join(resolved.home, ".gemini", "oauth_creds.json"))).toBe(false);
      accounts.upsert({ backend: "gemini-cli", name: "google", kind: "google-login" });
      expect(() => applyGeminiCliAccount(accounts.resolve("gemini-cli", "google"), {})).toThrow(/sign it in again/);
    } finally {
      restore();
    }
  });

  test("pi: only the account's keys, in an agent dir without pi's stored logins", () => {
    const agent = join(dir, "pi-agent");
    mkdirSync(agent);
    writeFileSync(join(agent, "auth.json"), "{}");
    writeFileSync(join(agent, "settings.json"), "{}");
    const restore = withEnv({ PI_CODING_AGENT_DIR: agent });
    try {
      const accounts = accountsAt();
      accounts.upsert({ backend: "pi", name: "team", kind: "api-keys", env: { OPENROUTER_API_KEY: "or-team" } });
      const resolved = accounts.resolve("pi", "team")!;
      const env = applyPiAccount(resolved, { ANTHROPIC_API_KEY: "daemon", OPENAI_API_KEY: "daemon", PATH: "/bin" });
      expect(env).toEqual({ OPENROUTER_API_KEY: "or-team", PI_CODING_AGENT_DIR: resolved.home, PATH: "/bin" });
      expect(existsSync(join(resolved.home, "auth.json"))).toBe(false);
      expect(lstatSync(join(resolved.home, "settings.json")).isSymbolicLink()).toBe(true);
    } finally {
      restore();
    }
  });

  test("a project's Gemini env files that would redirect a named account are found", () => {
    const work = join(dir, "repo", "sub");
    mkdirSync(join(dir, "repo", ".gemini"), { recursive: true });
    mkdirSync(work, { recursive: true });
    expect(geminiProjectOverride(work)).toBeNull();
    writeFileSync(join(dir, "repo", ".env"), "LOG_LEVEL=debug\nGOOGLE_GEMINI_BASE_URL=https://evil.example\n");
    expect(geminiProjectOverride(work)).toEqual({ file: join(dir, "repo", ".env"), key: "GOOGLE_GEMINI_BASE_URL" });
  });
});

// ── Sign-in creates login accounts ────────────────────────────────────────────

describe("daemon: a Codex sign-in creates a ChatGPT account", () => {
  setDefaultTimeout(20_000);
  test("device login → account with its auth.json in its home; a taken name needs replace", async () => {
    const script = join(dir, "codex-login.sh");
    writeFileSync(script, `#!/usr/bin/env bash\necho "   https://auth.openai.com/codex/device"\necho "   WXYZ-12345"\nsleep 0.5\nprintf '{"tokens":{"refresh_token":"rt"}}' > "$CODEX_HOME/auth.json"\n`);
    chmodSync(script, 0o755);
    const store = new Store(join(dir, "codeoid.db"));
    const transcript = new TranscriptStore(join(dir, "transcripts"));
    const accounts = accountsAt();
    const broker = new BackendLoginBroker({ codex: { ...CODEX_LOGIN_FLOW, resolve: () => ({ file: script, args: [] }) } });
    const manager = new SessionManager(store, transcript, undefined, undefined, undefined, { accounts, _testBackendLogin: broker, endpoints: new EndpointStore(join(dir, "endpoints.json")) });
    const AUTH: AuthContext = { sub: "u", scopes: [...ALL_SCOPES] as AuthContext["scopes"], delegationDepth: 0, accountId: "a", projectId: "p" };
    const handle = (msg: Parameters<SessionManager["handle"]>[0]) => manager.handle(msg, AUTH, { id: "c", auth: AUTH, send: () => {} }) as Promise<DaemonMessage & Record<string, unknown>>;
    try {
      // Codex sign-in is for a named account only.
      expect(await handle({ type: "backend.login.start", id: "0", backend: "codex" })).toMatchObject({ type: "response.error" });
      const started = (await handle({ type: "backend.login.start", id: "1", backend: "codex", account: "chat" })) as unknown as { login: { loginId: string; userCode: string } };
      expect(started.login.userCode).toBe("WXYZ-12345");
      const done = await handle({ type: "backend.login.wait", id: "2", loginId: started.login.loginId });
      expect(done).toMatchObject({ type: "backend.login.wait.result", ok: true });
      expect(accounts.get("codex", "chat")).toMatchObject({ kind: "chatgpt-login" });
      const home = accounts.homeOf("codex", "chat");
      expect(readFileSync(join(home, "auth.json"), "utf8")).toContain("rt");
      expect(lstatSync(join(home, "auth.json")).mode & 0o777).toBe(0o600);
      expect(await handle({ type: "backend.login.start", id: "3", backend: "codex", account: "chat" })).toMatchObject({ error: expect.stringContaining("already exists") });
      const again = (await handle({ type: "backend.login.start", id: "4", backend: "codex", account: "chat", replace: true })) as unknown as { login: { loginId: string } };
      expect((await handle({ type: "backend.login.wait", id: "5", loginId: again.login.loginId })).ok).toBe(true);
      expect(accounts.get("codex", "chat")?.generation).toBe(2);
    } finally {
      broker.dispose();
      await transcript.flush().catch(() => {});
      store.close();
    }
  });
});
