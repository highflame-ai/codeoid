/**
 * Thinking effort (#417): one scale for every backend, set per session —
 * kept like its model, applied live where the backend can take it, from the
 * next turn otherwise, by a rebuild before the next turn where it's a
 * startup setting (the Gemini CLI) — and each backend's own reading of it.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseClientMessage } from "@highflame/codeoid-protocol/schemas";
import type { CodeoidConfig } from "../config.js";
import { applyGeminiCliEffort, applyPiSettingsOverlay, geminiEffortSettings, piDefaultThinkingLevel } from "../daemon/account-apply.js";
import { AccountStore } from "../daemon/accounts.js";
import { geminiThinkingConfig } from "../daemon/providers/gemini/index.js";
import { llamaCppEffortParams } from "../daemon/providers/llamacpp/index.js";
import { MockSessionProvider } from "../daemon/providers/mock/session-provider.js";
import { qwenEffort } from "../daemon/providers/qwen/index.js";
import { ProviderRegistry } from "../daemon/providers/registry.js";
import { Session } from "../daemon/session.js";
import { SessionManager } from "../daemon/session-manager.js";
import { Store } from "../daemon/store.js";
import { TranscriptStore } from "../daemon/transcript.js";
import { SCOPES } from "../protocol/scopes.js";
import type { AuthContext, EffortChangeResult, EffortLevel, SessionInfo } from "../protocol/types.js";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "codeoid-effort-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("each backend's reading of the scale", () => {
  it("Qwen has no Off or Minimal: both are its lowest", () => {
    expect([qwenEffort("off"), qwenEffort("minimal"), qwenEffort("medium"), qwenEffort("max")]).toEqual(["low", "low", "medium", "max"]);
  });

  it("llama.cpp: through the chat template, clamped to low / medium / high", () => {
    expect(llamaCppEffortParams("off")).toEqual({ chat_template_kwargs: { enable_thinking: false } });
    expect(llamaCppEffortParams("max")).toEqual({ chat_template_kwargs: { enable_thinking: true, reasoning_effort: "high" }, reasoning_effort: "high" });
    expect(llamaCppEffortParams("minimal")).toMatchObject({ reasoning_effort: "low" });
  });

  it("Gemini: a budget for 2.5 within each model's range, a level for 3.x within each model's set, nothing for others", () => {
    expect(geminiThinkingConfig("gemini-2.5-flash", "off")).toEqual({ thinkingBudget: 0 });
    expect(geminiThinkingConfig("gemini-2.5-pro", "off")).toEqual({ thinkingBudget: 128 }); // Pro can't turn it off
    expect(geminiThinkingConfig("gemini-2.5-flash-lite", "off")).toEqual({ thinkingBudget: 0 });
    expect(geminiThinkingConfig("gemini-2.5-flash-lite", "minimal")).toEqual({ thinkingBudget: 512 });
    expect(geminiThinkingConfig("gemini-2.5-flash", "max")).toEqual({ thinkingBudget: 24576 });
    expect(geminiThinkingConfig("gemini-2.5-pro", "max")).toEqual({ thinkingBudget: 32768 });
    expect(geminiThinkingConfig("gemini-3-pro-preview", "medium")).toEqual({ thinkingLevel: "high" }); // Pro: Low or High
    expect(geminiThinkingConfig("gemini-3-pro-preview", "minimal")).toEqual({ thinkingLevel: "low" });
    expect(geminiThinkingConfig("gemini-3-flash", "off")).toEqual({ thinkingLevel: "minimal" });
    expect(geminiThinkingConfig("gemini-3-flash", "medium")).toEqual({ thinkingLevel: "medium" });
    expect(geminiThinkingConfig("gemini-1.5-pro", "high")).toBeNull();
  });

  it("the Gemini CLI: its chat aliases redefined in settings, everything else kept", () => {
    const out = JSON.parse(geminiEffortSettings(JSON.stringify({ theme: "dark", modelConfigs: { customAliases: { mine: { extends: "base" } } } }), "low"));
    expect(out.theme).toBe("dark");
    expect(out.modelConfigs.customAliases.mine).toEqual({ extends: "base" });
    expect(out.modelConfigs.customAliases["chat-base-2.5"]).toEqual({
      extends: "chat-base",
      modelConfig: { generateContentConfig: { thinkingConfig: { thinkingBudget: 2048 } } },
    });
    expect(out.modelConfigs.customAliases["chat-base-3"].modelConfig.generateContentConfig.thinkingConfig).toEqual({ thinkingLevel: "LOW" });
    // Values every model of the family takes: the settings can't know which runs.
    const off = JSON.parse(geminiEffortSettings(undefined, "off"));
    expect(off.modelConfigs.customAliases["chat-base-2.5"].modelConfig.generateContentConfig.thinkingConfig.thinkingBudget).toBe(512);
    const medium = JSON.parse(geminiEffortSettings(undefined, "medium"));
    expect(medium.modelConfigs.customAliases["chat-base-3"].modelConfig.generateContentConfig.thinkingConfig.thinkingLevel).toBe("HIGH");
    expect(JSON.parse(geminiEffortSettings("not json", "max")).modelConfigs.customAliases["chat-base-2.5"].modelConfig.generateContentConfig.thinkingConfig.thinkingBudget).toBe(24576);
  });

  it("the Gemini CLI runs from an overlay of its usual home — logins and chats linked, settings its own", () => {
    const base = join(tmp, "base");
    mkdirSync(join(base, ".gemini", "tmp"), { recursive: true });
    writeFileSync(join(base, ".gemini", "oauth_creds.json"), "{}");
    writeFileSync(join(base, ".gemini", "settings.json"), JSON.stringify({ theme: "dark" }));
    const homes = join(tmp, "homes");
    const env = applyGeminiCliEffort("high", { GEMINI_CLI_HOME: base, PATH: "/bin" }, homes);
    const home = env.GEMINI_CLI_HOME!;
    expect(home.startsWith(join(homes, "gemini-cli-effort"))).toBe(true);
    expect(env.PATH).toBe("/bin");
    expect(readlinkSync(join(home, ".gemini", "oauth_creds.json"))).toBe(join(base, ".gemini", "oauth_creds.json"));
    expect(lstatSync(join(home, ".gemini", "tmp")).isSymbolicLink()).toBe(true);
    const settings = JSON.parse(readFileSync(join(home, ".gemini", "settings.json"), "utf8"));
    expect(settings.theme).toBe("dark");
    expect(settings.modelConfigs.customAliases["chat-base-3"].modelConfig.generateContentConfig.thinkingConfig.thinkingLevel).toBe("HIGH");
    // One home per effort; no effort, no overlay.
    expect(applyGeminiCliEffort("low", { GEMINI_CLI_HOME: base }, homes).GEMINI_CLI_HOME).not.toBe(home);
    expect(applyGeminiCliEffort(undefined, { GEMINI_CLI_HOME: base }, homes)).toEqual({ GEMINI_CLI_HOME: base });
  });
});

describe("pi's settings overlay", () => {
  it("links the user's logins — made if missing, as pi would — and copies only settings.json; locks never linked", () => {
    const base = join(tmp, "pi");
    mkdirSync(join(base, "auth.json.lock"), { recursive: true }); // another pi holds the lock right now
    writeFileSync(join(base, "settings.json"), JSON.stringify({ defaultThinkingLevel: "high" }));
    const homes = join(tmp, "homes");
    const home = applyPiSettingsOverlay({ PI_CODING_AGENT_DIR: base }, homes).PI_CODING_AGENT_DIR!;
    expect(readlinkSync(join(home, "auth.json"))).toBe(join(base, "auth.json")); // made in the base, then linked
    expect(lstatSync(join(home, "settings.json")).isSymbolicLink()).toBe(false);
    expect(() => lstatSync(join(home, "auth.json.lock"))).toThrow();
    expect(piDefaultThinkingLevel({ PI_CODING_AGENT_DIR: base })).toBe("high");
    // An overlay that took an empty auth.json of its own before gets the user's linked instead.
    rmSync(join(home, "auth.json"));
    writeFileSync(join(home, "auth.json"), "{}");
    applyPiSettingsOverlay({ PI_CODING_AGENT_DIR: base }, homes);
    expect(lstatSync(join(home, "auth.json")).isSymbolicLink()).toBe(true);
  });

  it("a dangling auth.json link is left to pi; a permanent lock FILE (codex's) is still linked", () => {
    const base = join(tmp, "pi2");
    mkdirSync(base, { recursive: true });
    symlinkSync(join(tmp, "nowhere", "auth.json"), join(base, "auth.json"));
    writeFileSync(join(base, ".sqlite-maintenance.lock"), "");
    const home = applyPiSettingsOverlay({ PI_CODING_AGENT_DIR: base }, join(tmp, "homes")).PI_CODING_AGENT_DIR!;
    expect(readlinkSync(join(home, ".sqlite-maintenance.lock"))).toBe(join(base, ".sqlite-maintenance.lock"));
  });

  it("pi's Default is the user's own — never a repo's .pi/settings.json, which pi honours only for a trusted project", () => {
    const agent = join(tmp, "agent");
    const work = join(tmp, "proj");
    mkdirSync(join(work, ".pi"), { recursive: true });
    mkdirSync(agent, { recursive: true });
    writeFileSync(join(agent, "settings.json"), JSON.stringify({ defaultThinkingLevel: "low" }));
    writeFileSync(join(work, ".pi", "settings.json"), JSON.stringify({ defaultThinkingLevel: "xhigh" }));
    expect(piDefaultThinkingLevel({ PI_CODING_AGENT_DIR: agent })).toBe("low");
  });

  it("reads a ~ path as pi does", () => {
    mkdirSync(join(tmp, "h", "x"), { recursive: true });
    writeFileSync(join(tmp, "h", "x", "settings.json"), JSON.stringify({ defaultThinkingLevel: "minimal" }));
    expect(piDefaultThinkingLevel({ PI_CODING_AGENT_DIR: "~/x", HOME: join(tmp, "h") })).toBe("minimal");
    expect(piDefaultThinkingLevel({ PI_CODING_AGENT_DIR: join(tmp, "none") })).toBe("medium");
  });

  it("an account's overlays go with the account", () => {
    const homes = join(tmp, "homes");
    const accounts = new AccountStore({ path: join(tmp, "accounts.json"), homesRoot: homes, legacyClaudePath: null });
    accounts.upsert({ backend: "pi", name: "work", kind: "api-keys", env: { OPENAI_API_KEY: "sk-test" } } as never);
    const home = accounts.homeOf("pi", "work");
    mkdirSync(home, { recursive: true });
    const piOverlay = applyPiSettingsOverlay({ PI_CODING_AGENT_DIR: home }, homes).PI_CODING_AGENT_DIR!;
    mkdirSync(join(home, ".gemini"), { recursive: true });
    const geminiOverlay = applyGeminiCliEffort("high", { GEMINI_CLI_HOME: home }, homes).GEMINI_CLI_HOME!;
    accounts.setDefault("pi", "default"); // a backend's default can't be removed
    expect(accounts.remove("pi", "work")).toBe(true);
    expect(() => lstatSync(piOverlay)).toThrow();
    expect(() => lstatSync(geminiOverlay)).toThrow();
  });
});

// ── through the session manager ──────────────────────────────────────────────

const ALL = [SCOPES.SESSION_CREATE, SCOPES.SESSION_SEND, SCOPES.SESSION_LIST];
const auth = (scopes: string[] = ALL, accountId = "acc-1"): AuthContext => ({
  sub: "user:a",
  scopes: scopes as AuthContext["scopes"],
  delegationDepth: 0,
  accountId,
  projectId: "proj-1",
});
const client = { id: "c1", auth: auth(), send: () => {} };

/** A backend that takes a new effort live. */
class LiveProvider extends MockSessionProvider {
  readonly applied: Array<EffortLevel | null> = [];
  async applyEffort(effort: EffortLevel | null): Promise<boolean> {
    this.applied.push(effort);
    return true;
  }
}
/** A backend that takes its effort only at startup (as the Gemini CLI). */
class RestartProvider extends MockSessionProvider {
  readonly effortChange = "restart" as const;
}

function manager(make: () => MockSessionProvider, providerId = "claude", defaultEffort?: EffortLevel): { m: SessionManager; store: Store; providers: MockSessionProvider[] } {
  const store = new Store(join(tmp, "codeoid.db"));
  const providers: MockSessionProvider[] = [];
  const registry = new ProviderRegistry(providerId);
  registry.register({
    id: providerId,
    displayName: providerId,
    create: () => {
      const p = make();
      providers.push(p);
      return p;
    },
  });
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
    session: defaultEffort ? { defaultEffort } : {},
    conductor: { enabled: false, name: "conductor", provider: "claude" },
  } as CodeoidConfig;
  const m = new SessionManager(store, new TranscriptStore(join(tmp, "t")), undefined, undefined, undefined, { config, providers: registry });
  return { m, store, providers };
}

async function create(m: SessionManager, effort?: EffortLevel): Promise<string> {
  const work = join(tmp, "work");
  mkdirSync(work, { recursive: true });
  const r = (await m.handle({ type: "session.create", id: "c", name: "w", workdir: work, ...(effort ? { effort } : {}) }, auth(), client)) as {
    type: string;
    data: { id: string };
  };
  expect(r.type).toBe("response.ok");
  return r.data.id;
}

const setEffort = async (m: SessionManager, sessionId: string, effort: EffortLevel | null, a = auth()) =>
  (await m.handle({ type: "session.set_effort", id: "e", sessionId, effort }, a, client)) as { type: string; data?: EffortChangeResult; code?: string };

async function turn(m: SessionManager, sid: string, text = "go"): Promise<void> {
  const s = m._sessionForTest(sid)!;
  await s.send(text, auth());
  for (let i = 0; i < 200 && s.status !== "idle"; i++) await Bun.sleep(5);
  await Bun.sleep(10);
}

describe("a session's thinking effort", () => {
  it("is set at creation, kept with the session, and handed to the backend on every turn", async () => {
    const { m, store, providers } = manager(() => new MockSessionProvider("claude", []));
    const sid = await create(m, "high");
    expect((m._sessionForTest(sid)!.toInfo() as SessionInfo).effort).toBe("high");
    expect(store.getSessionEffort(sid)).toBe("high");
    await turn(m, sid);
    expect(providers[0]!.capturedOpts.at(-1)?.effort).toBe("high");
  });

  it("changes from the next turn on a backend that takes it per turn — on the record, and shown to clients", async () => {
    const { m, store, providers } = manager(() => new MockSessionProvider("claude", []));
    const sid = await create(m);
    await turn(m, sid);
    expect(providers[0]!.capturedOpts.at(-1)?.effort).toBeUndefined(); // the backend's default
    expect(await setEffort(m, sid, "low")).toMatchObject({ type: "response.ok", data: { effort: "low", applies: "next-turn" } });
    expect(m._sessionForTest(sid)!.toInfo().effort).toBe("low");
    await turn(m, sid);
    expect(providers[0]!.capturedOpts.at(-1)?.effort).toBe("low");
    expect(await setEffort(m, sid, null)).toMatchObject({ data: { effort: null } });
    expect(store.getSessionEffort(sid)).toBeNull();
    await turn(m, sid);
    expect(providers[0]!.capturedOpts.at(-1)?.effort).toBeUndefined();
    store.close();
    const db = new Database(join(tmp, "codeoid.db"), { readonly: true });
    const rows = db.query("SELECT detail FROM audit_log WHERE action = 'session.set_effort' ORDER BY id").all() as Array<{ detail: string }>;
    db.close();
    expect(rows.map((r) => r.detail)).toEqual(["effort=low from=(default)", "effort=(default) from=low"]);
  });

  it("applies live where the backend can take it", async () => {
    const { m, providers } = manager(() => new LiveProvider("claude", []));
    const sid = await create(m);
    await turn(m, sid);
    expect(await setEffort(m, sid, "max")).toMatchObject({ data: { applies: "now" } });
    expect((providers[0] as LiveProvider).applied).toEqual(["max"]);
  });

  it("rebuilds a backend that takes it only at startup — before the next turn, never under a running one", async () => {
    const { m, providers } = manager(() => new RestartProvider("gemini-cli", []), "gemini-cli");
    const sid = await create(m);
    await turn(m, sid);
    expect(await setEffort(m, sid, "high")).toMatchObject({ data: { applies: "restart" } });
    expect(providers[0]!.teardownCount).toBe(0); // not at once
    await turn(m, sid);
    expect(providers[0]!.teardownCount).toBe(1); // before the turn
    expect(providers[0]!.capturedOpts.at(-1)?.effort).toBe("high");
    await turn(m, sid);
    expect(providers[0]!.teardownCount).toBe(1); // once
    // The same level again while a restart is still to come says so.
    expect(await setEffort(m, sid, "low")).toMatchObject({ data: { applies: "restart" } });
    expect(await setEffort(m, sid, "low")).toMatchObject({ data: { applies: "restart" } });
  });

  it("created at Default explicitly, a session takes the backend's default, not the config's", async () => {
    const { m } = manager(() => new MockSessionProvider("claude", []), "claude", "max");
    mkdirSync(join(tmp, "work"), { recursive: true });
    const r = (await m.handle({ type: "session.create", id: "c", name: "d", workdir: join(tmp, "work"), effort: null }, auth(), client)) as { data: { id: string } };
    expect(m._sessionForTest(r.data.id)!.toInfo().effort).toBeUndefined();
    expect(parseClientMessage({ type: "session.create", id: "c", name: "d", workdir: "/w", effort: null }).ok).toBe(true);
  });

  it("a fork of a session at Default stays at Default, whatever the config default", async () => {
    const { m } = manager(() => new MockSessionProvider("claude", []), "claude", "high");
    const sid = await create(m);
    expect(await setEffort(m, sid, null)).toMatchObject({ type: "response.ok" });
    await turn(m, sid);
    const r = (await m.handle({ type: "session.fork", id: "f", sessionId: sid, name: "f" }, auth([...ALL, SCOPES.SESSION_READ]), client)) as {
      data?: { id?: string; session?: { id: string } };
    };
    expect(m._sessionForTest((r.data?.session?.id ?? r.data?.id)!)!.toInfo().effort).toBeUndefined();
  });

  it("a fork thinks as hard as the session it came from", async () => {
    const { m } = manager(() => new MockSessionProvider("claude", []));
    const sid = await create(m, "xhigh");
    await turn(m, sid);
    const r = (await m.handle({ type: "session.fork", id: "f", sessionId: sid, name: "f" }, auth([...ALL, SCOPES.SESSION_READ]), client)) as {
      type: string;
      data?: { id?: string; session?: { id: string } };
      error?: string;
    };
    expect(r.type).toBe("response.ok");
    const forkId = r.data?.session?.id ?? r.data?.id;
    expect(m._sessionForTest(forkId!)!.toInfo().effort).toBe("xhigh");
  });

  it("on the record at creation, and marked when a delegated token changes it", async () => {
    const { m, store } = manager(() => new MockSessionProvider("claude", []));
    const sid = await create(m, "max");
    expect(await setEffort(m, sid, "low", { ...auth(), delegationDepth: 1 })).toMatchObject({ type: "response.ok" });
    store.close();
    const db = new Database(join(tmp, "codeoid.db"), { readonly: true });
    const created = db.query("SELECT detail FROM audit_log WHERE action = 'session.create'").get() as { detail: string };
    const changed = db.query("SELECT detail FROM audit_log WHERE action = 'session.set_effort'").get() as { detail: string };
    db.close();
    expect(created.detail).toBe("name=w effort=max");
    expect(changed.detail).toBe("effort=low from=max delegated=1");
  });

  it("is the session owner's to change: session:send, their own session", async () => {
    const { m } = manager(() => new MockSessionProvider("claude", []));
    const sid = await create(m);
    expect(await setEffort(m, sid, "high", auth([SCOPES.SESSION_LIST]))).toMatchObject({ code: "forbidden" });
    expect(await setEffort(m, sid, "high", auth(ALL, "acc-2"))).toMatchObject({ code: "not_found" });
    expect(parseClientMessage({ type: "session.set_effort", id: "e", sessionId: sid, effort: "turbo" }).ok).toBe(false);
  });

  it("a new session takes the config default; a resumed one keeps its own", async () => {
    const { m, store } = manager(() => new MockSessionProvider("claude", []), "claude", "medium");
    const sid = await create(m);
    expect(store.getSessionEffort(sid)).toBe("medium");
    expect(m._sessionForTest(sid)!.toInfo().effort).toBe("medium");
    // Resumed: the persisted one — none set means the backend's default, not the config's.
    store.setSessionEffort(sid, null);
    const registry = new ProviderRegistry("claude");
    registry.register({ id: "claude", displayName: "claude", create: () => new MockSessionProvider("claude", []) });
    const resumed = new Session({
      name: "w",
      workdir: join(tmp, "work"),
      auth: auth(),
      store,
      transcriptStore: new TranscriptStore(join(tmp, "t")),
      existingId: sid,
      providers: registry,
      config: { session: { defaultEffort: "max" } } as CodeoidConfig,
    });
    expect(resumed.toInfo().effort).toBeUndefined();
    store.setSessionEffort(sid, "xhigh");
    const again = new Session({ name: "w", workdir: join(tmp, "work"), auth: auth(), store, transcriptStore: new TranscriptStore(join(tmp, "t")), existingId: sid, providers: registry });
    expect(again.toInfo().effort).toBe("xhigh");
  });

  it("the model list carries the levels each model takes", async () => {
    const { m } = manager(() => new MockSessionProvider("claude", []));
    (m as unknown as { _cacheModels: (p: string, r: unknown[]) => void })._cacheModels("claude", [
      { value: "opus", displayName: "Opus", efforts: ["off", "low", "high"], defaultEffort: "high" },
      { value: "other", displayName: "Other" },
    ]);
    const r = (await m.handle({ type: "models.list", id: "m", provider: "claude" }, auth(), client)) as { models: Array<{ value: string; efforts?: string[]; defaultEffort?: string }> };
    expect(r.models.find((x) => x.value === "opus")).toMatchObject({ efforts: ["off", "low", "high"], defaultEffort: "high" });
    expect(r.models.find((x) => x.value === "other")?.efforts).toBeUndefined();
  });
});
