/**
 * Regressions from the first audit of accounts for every backend: a switch
 * keeps a Gemini CLI conversation, only a real credential change releases a
 * backend, a hand edit reaches running sessions, the legacy import happens
 * once, a project or user Qwen setting can't redirect an account's key, and
 * a device sign-in can be waited on again after a dropped connection.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureQwenHome, qwenAccountSettings, qwenProjectOverride } from "../daemon/account-apply.js";
import { AccountStore } from "../daemon/accounts.js";
import { BackendLoginBroker, CODEX_LOGIN_FLOW } from "../daemon/auth/backend-login.js";
import { EndpointStore } from "../daemon/openai-endpoints.js";
import { MockSessionProvider, mockResult } from "../daemon/providers/mock/session-provider.js";
import type { ProviderEvent } from "../daemon/providers/interface.js";
import { ProviderRegistry } from "../daemon/providers/registry.js";
import { Session } from "../daemon/session.js";
import { SessionManager } from "../daemon/session-manager.js";
import { Store } from "../daemon/store.js";
import { TranscriptStore } from "../daemon/transcript.js";
import { ALL_SCOPES } from "../protocol/scopes.js";
import type { AuthContext, DaemonMessage } from "../protocol/types.js";

const AUTH: AuthContext = { sub: "user:r1", scopes: [...ALL_SCOPES] as AuthContext["scopes"], delegationDepth: 0, accountId: "a", projectId: "p" };

let dir: string;
let store: Store;
let transcript: TranscriptStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codeoid-accounts-r1-"));
  store = new Store(join(dir, "codeoid.db"));
  transcript = new TranscriptStore(join(dir, "transcripts"));
});
afterEach(async () => {
  await Bun.sleep(50);
  try {
    await transcript.flush();
  } catch {}
  try {
    store.close();
  } catch {}
  rmSync(dir, { recursive: true, force: true });
});

const accountsAt = (legacy: string | null = null) =>
  new AccountStore({ path: join(dir, "accounts.json"), homesRoot: join(dir, "homes"), legacyClaudePath: legacy });
const textTurn = (text: string): ProviderEvent[] => [
  { type: "text_done", content: text },
  { type: "turn_done", result: mockResult() },
];

/** A Gemini CLI session on a mock provider (a process backend that can't resume its own conversation). */
function geminiCliSession(accounts: AccountStore) {
  const provider = new MockSessionProvider("gemini-cli", [textTurn("first answer"), textTurn("second answer")]);
  const registry = new ProviderRegistry("gemini-cli");
  registry.register({ id: "gemini-cli", displayName: "Gemini CLI", create: () => provider });
  const session = new Session({
    name: "g",
    workdir: dir,
    auth: AUTH,
    store,
    transcriptStore: transcript,
    existingId: randomUUID(),
    providers: registry,
    providerId: "gemini-cli",
    accounts,
    _testProvider: provider,
  });
  return { session, provider };
}

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(10);
  }
}

describe("switching a process backend's account", () => {
  test("a Gemini CLI session keeps its conversation: released when idle, then handed the history", async () => {
    const accounts = accountsAt();
    accounts.upsert({ backend: "gemini-cli", name: "a", kind: "api-key", token: "AIza-a" });
    accounts.upsert({ backend: "gemini-cli", name: "b", kind: "api-key", token: "AIza-b" });
    const { session, provider } = geminiCliSession(accounts);
    session.setAccount("a", AUTH);
    await session.send("hello", AUTH);
    await until(() => session.toInfo().status === "idle" && provider.teardownCount >= 1);
    const before = provider.teardownCount;
    session.setAccount("b", AUTH);
    await until(() => provider.teardownCount === before + 1 && provider.seededHistory !== null);
    expect(provider.seededHistory?.map((t) => t.content)).toContain("first answer");
    expect(session.toInfo()).toMatchObject({ account: "b", effectiveAccount: "b" });
  });

  test("only a real change releases it: the same account again, or another backend's default, does nothing", async () => {
    const accounts = accountsAt();
    accounts.upsert({ backend: "gemini-cli", name: "a", kind: "api-key", token: "AIza-a" });
    accounts.upsert({ backend: "codex", name: "c", kind: "api-key", token: "sk-c" });
    const { session, provider } = geminiCliSession(accounts);
    session.setAccount("a", AUTH);
    await until(() => provider.teardownCount >= 1);
    const settled = provider.teardownCount;
    session.setAccount("a", AUTH);
    accounts.setDefault("codex", "c");
    session.refreshAccount();
    await Bun.sleep(100);
    expect(provider.teardownCount).toBe(settled);
  });

  test("a hand edit of accounts.json reaches the running session through the manager", async () => {
    const accounts = accountsAt();
    accounts.upsert({ backend: "oai:box", name: "a", kind: "api-key", token: "k1", origin: "http://127.0.0.1:1" });
    const endpoints = new EndpointStore(join(dir, "endpoints.json"));
    endpoints.upsert({ name: "box", baseUrl: "http://127.0.0.1:1/v1" });
    const manager = new SessionManager(store, transcript, undefined, undefined, undefined, { endpoints, accounts });
    const pushed: DaemonMessage[] = [];
    const client = { id: "c", auth: AUTH, send: (m: DaemonMessage) => pushed.push(m) };
    await manager.handle({ type: "providers.list", id: "p" }, AUTH, client);
    const created = (await manager.handle({ type: "session.create", id: "c", name: "s", workdir: dir, providerId: "oai:box", account: "a" }, AUTH, client)) as unknown as {
      data: { id: string };
    };
    await manager.handle({ type: "session.attach", id: "at", sessionId: created.data.id }, AUTH, client);
    pushed.length = 0;
    // The account is removed by hand while the daemon runs.
    const path = join(dir, "accounts.json");
    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    onDisk.backends["oai:box"].accounts = [];
    writeFileSync(path, JSON.stringify(onDisk));
    const later = new Date(Date.now() + 5_000);
    utimesSync(path, later, later);
    await manager.handle({ type: "accounts.list", id: "l" }, AUTH, client); // any read notices it
    expect(pushed).toContainEqual({ type: "accounts.changed", backend: "oai:box" });
    const info = pushed.find((m) => m.type === "session.info_update") as { session?: { effectiveAccount?: string } } | undefined;
    expect(info?.session?.effectiveAccount).toBe("a (missing)");
  });
});

describe("the legacy Claude import happens once", () => {
  test("deleting accounts.json doesn't bring back accounts removed since the import", () => {
    const legacy = join(dir, "claude-accounts.json");
    writeFileSync(legacy, JSON.stringify({ version: 1, defaultAccount: "old", accounts: [{ name: "old", kind: "api-key", token: "k", createdAt: "", updatedAt: "" }] }));
    const first = accountsAt(legacy);
    expect(first.getDefault("claude")).toBe("old");
    first.setDefault("claude", "default");
    first.remove("claude", "old");
    rmSync(join(dir, "accounts.json"));
    const again = accountsAt(legacy);
    expect(again.list("claude")).toEqual([]);
    expect(again.getDefault("claude")).toBe("default");
  });
});

describe("Qwen accounts can't be redirected", () => {
  test("a project's .qwen/settings.json provider entry or .env is refused for a named account", () => {
    const work = join(dir, "repo", "src");
    mkdirSync(join(dir, "repo", ".qwen"), { recursive: true });
    mkdirSync(work, { recursive: true });
    expect(qwenProjectOverride(work)).toBeNull();
    writeFileSync(join(dir, "repo", ".qwen", "settings.json"), JSON.stringify({ modelProviders: { openai: [{ id: "m", baseUrl: "http://evil" }] } }));
    expect(qwenProjectOverride(work)).toEqual({ file: join(dir, "repo", ".qwen", "settings.json"), key: "modelProviders" });
    writeFileSync(join(dir, "repo", ".qwen", "settings.json"), JSON.stringify({ ui: { theme: "dark" } }));
    writeFileSync(join(dir, "repo", ".env"), "OPENAI_BASE_URL=http://evil/v1\n");
    expect(qwenProjectOverride(work)).toEqual({ file: join(dir, "repo", ".env"), key: "OPENAI_BASE_URL" });
  });

  test("a named Qwen account refuses to run in such a workdir", async () => {
    const accounts = accountsAt();
    accounts.upsert({ backend: "qwen", name: "team", kind: "api-key", token: "sk-team", baseUrl: "dashscope-intl" });
    const provider = new MockSessionProvider("qwen", [textTurn("x")]);
    const registry = new ProviderRegistry("qwen");
    registry.register({ id: "qwen", displayName: "Qwen", create: () => provider });
    mkdirSync(join(dir, ".qwen"), { recursive: true });
    writeFileSync(join(dir, ".qwen", "settings.json"), JSON.stringify({ modelProviders: {} }));
    const session = new Session({ name: "q", workdir: dir, auth: AUTH, store, transcriptStore: transcript, existingId: randomUUID(), providers: registry, providerId: "qwen", accounts, _testProvider: provider });
    session.setAccount("team", AUTH);
    await expect(session.send("hi", AUTH)).rejects.toThrow(/would redirect qwen account "team"/);
  });

  test("the account's Qwen home drops every setting that would route its key elsewhere", () => {
    expect(
      JSON.parse(
        qwenAccountSettings(
          JSON.stringify({ modelProviders: { openai: [] }, providerProtocol: "x", security: { auth: { selectedType: "qwen-oauth" }, folderTrust: true }, model: { baseUrl: "http://evil", name: "q" }, ui: { theme: "dark" } }),
        ),
      ),
    ).toEqual({ security: { folderTrust: true }, model: { name: "q" }, ui: { theme: "dark" } });
    const defaultHome = join(dir, "qwen-default");
    mkdirSync(defaultHome);
    writeFileSync(join(defaultHome, "settings.json"), JSON.stringify({ modelProviders: { openai: [] } }));
    writeFileSync(join(defaultHome, "oauth_creds.json"), "{}");
    mkdirSync(join(defaultHome, "projects"));
    const saved = process.env.QWEN_HOME;
    process.env.QWEN_HOME = defaultHome;
    try {
      const home = ensureQwenHome({ home: join(dir, "acct") });
      expect(JSON.parse(readFileSync(join(home, "settings.json"), "utf8"))).toEqual({});
      expect(() => readFileSync(join(home, "oauth_creds.json"))).toThrow();
      expect(readFileSync(join(defaultHome, "settings.json"), "utf8")).toContain("modelProviders"); // the default is untouched
    } finally {
      if (saved === undefined) delete process.env.QWEN_HOME;
      else process.env.QWEN_HOME = saved;
    }
  });
});

describe("a device sign-in survives a dropped connection", () => {
  test("waiting again gets the same outcome, and the account is stored once", async () => {
    const script = join(dir, "codex-login.sh");
    writeFileSync(script, `#!/usr/bin/env bash\necho "   https://auth.openai.com/codex/device"\necho "   ABCD-12345"\nsleep 0.4\nprintf '{"tokens":{}}' > "$CODEX_HOME/auth.json"\n`);
    chmodSync(script, 0o755);
    const accounts = accountsAt();
    const broker = new BackendLoginBroker({ codex: { ...CODEX_LOGIN_FLOW, resolve: () => ({ file: script, args: [] }) } });
    const manager = new SessionManager(store, transcript, undefined, undefined, undefined, { accounts, _testBackendLogin: broker, endpoints: new EndpointStore(join(dir, "endpoints.json")) });
    const handle = (msg: Parameters<SessionManager["handle"]>[0]) => manager.handle(msg, AUTH, { id: "c", auth: AUTH, send: () => {} }) as Promise<DaemonMessage & Record<string, unknown>>;
    try {
      const started = (await handle({ type: "backend.login.start", id: "1", backend: "codex", account: "chat" })) as unknown as { login: { loginId: string } };
      // Two waits: the first client's connection "dropped", it waits again.
      const [a, b] = await Promise.all([
        handle({ type: "backend.login.wait", id: "2", loginId: started.login.loginId }),
        handle({ type: "backend.login.wait", id: "3", loginId: started.login.loginId }),
      ]);
      expect(a).toMatchObject({ ok: true });
      expect(b).toMatchObject({ ok: true });
      // And again after it finished.
      expect(await handle({ type: "backend.login.wait", id: "4", loginId: started.login.loginId })).toMatchObject({ ok: true });
      expect(accounts.get("codex", "chat")?.generation).toBe(1);
    } finally {
      broker.dispose();
    }
  });
});
