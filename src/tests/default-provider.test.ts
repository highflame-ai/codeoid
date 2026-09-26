/**
 * `session.defaultProvider` (#339) at the SessionManager layer.
 *
 * The registry-level rules (the configured id becomes `defaultId`; a typo,
 * a disabled backend or an uninstalled one fails startup) live in
 * provider-registry.test.ts. These tests pin what the daemon DOES with a
 * non-Claude default — the places that used to assume "no provider" meant
 * claude even though the session would be built on the registry default:
 *
 *   - a provider-less create lands on the default and validates its model
 *     against THAT backend, not Claude's catalog;
 *   - a legacy session meta with no provider resumes on claude, never on the
 *     new default (it would lose its backing conversation);
 *   - the settings write path refuses a default the next boot would refuse.
 *
 * The registry is real (not `_testProviderFactory`) so the provider a session
 * reports is the one the registry resolved, which is the thing under test.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Store } from "../daemon/store.js";
import { TranscriptStore } from "../daemon/transcript.js";
import { SessionManager } from "../daemon/session-manager.js";
import { ProviderRegistry, type ProviderFactory } from "../daemon/providers/registry.js";
import { MockSessionProvider } from "../daemon/providers/mock/session-provider.js";
import type { AttachedClient } from "../daemon/session.js";
import type { AuthContext, SettingsSetResultMsg } from "../protocol/types.js";
import { ALL_SCOPES } from "../protocol/scopes.js";
import { configFilePaths } from "../config.js";

const OWNER: AuthContext = {
  sub: "user:default-provider",
  scopes: [...ALL_SCOPES] as AuthContext["scopes"],
  delegationDepth: 0,
  accountId: "acc-dp",
  projectId: "proj-dp",
};
const client: AttachedClient = { id: "client-dp", auth: OWNER, send: () => {} };

function mockFactory(id: string): ProviderFactory {
  return { id, displayName: `Mock ${id}`, create: () => new MockSessionProvider(id) };
}

/** A daemon configured with `session.defaultProvider: "pi"`. */
function piDefaultRegistry(): ProviderRegistry {
  const registry = new ProviderRegistry("pi");
  registry.register(mockFactory("claude"));
  registry.register(mockFactory("pi"));
  return registry;
}

let tmp: string;
let store: Store;
let transcript: TranscriptStore;
// The next-boot check reads process.env: keep the shell's out of it, and give
// it a `pi` on PATH so the pi cases don't hinge on the bundled optional dep.
const ENV_KEYS = ["XDG_CONFIG_HOME", "CODEOID_DEFAULT_PROVIDER", "PATH"] as const;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "codeoid-default-provider-"));
  store = new Store(join(tmp, "codeoid.db"));
  transcript = new TranscriptStore(join(tmp, "transcripts"));
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  // settings.set writes config.json — keep it off the real ~/.codeoid.
  process.env.XDG_CONFIG_HOME = tmp;
  delete process.env.CODEOID_DEFAULT_PROVIDER;
  const bin = join(tmp, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "pi"), "#!/bin/sh\n");
  chmodSync(join(bin, "pi"), 0o755);
  process.env.PATH = `${bin}:${savedEnv.PATH ?? ""}`;
});

afterEach(async () => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  try { await transcript.flush(); } catch {}
  try { store.close(); } catch {}
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
});

const manager = () =>
  new SessionManager(store, transcript, undefined, undefined, undefined, { providers: piDefaultRegistry() });

describe("a non-claude default backend", () => {
  it("is advertised first, so clients preselect it", () => {
    expect(manager().providerIds()[0]).toBe("pi");
  });

  it("is what a provider-less session.create lands on", async () => {
    const resp = await manager().handle(
      { type: "session.create", id: "c1", name: "plain", workdir: tmp },
      OWNER,
      client,
    );
    expect(resp.type).toBe("response.ok");
    if (resp.type !== "response.ok") return;
    expect((resp.data as { providerId?: string }).providerId).toBe("pi");
  });

  it("validates a provider-less create's model against itself, not Claude's catalog", async () => {
    // Before #339 this resolved "opus" as a Claude alias and built a pi
    // session carrying claude-opus-*, which pi would reject on the first turn.
    const resp = await manager().handle(
      { type: "session.create", id: "c2", name: "opus-on-pi", workdir: tmp, model: "opus" },
      OWNER,
      client,
    );
    expect(resp).toMatchObject({ type: "response.error", code: "invalid_request" });
    if (resp.type === "response.error") {
      expect(resp.error).toMatch(/Model "opus" is not valid for provider "pi"/);
    }
  });

  it("still takes an explicit claude session and its alias", async () => {
    const resp = await manager().handle(
      { type: "session.create", id: "c3", name: "claude", workdir: tmp, providerId: "claude", model: "opus" },
      OWNER,
      client,
    );
    expect(resp.type).toBe("response.ok");
    if (resp.type !== "response.ok") return;
    const info = resp.data as { providerId?: string; model?: string };
    expect(info.providerId).toBe("claude");
    expect(info.model).toMatch(/^claude-opus-/);
  });
});

describe("resume under a non-claude default", () => {
  const legacyMeta = (sessionId: string, providerId?: string) => ({
    sessionId,
    sessionName: sessionId,
    workdir: tmp,
    createdBy: OWNER.sub,
    createdAt: new Date().toISOString(),
    lastStatus: "idle" as const,
    lastActivityAt: new Date().toISOString(),
    accountId: OWNER.accountId!,
    projectId: OWNER.projectId!,
    ...(providerId ? { providerId } : {}),
  });

  it("keeps a pre-provider meta on claude instead of moving it to the default", async () => {
    // A meta with no providerId predates multi-backend support: it IS a
    // claude session. Resolving it through the registry default would resume
    // it on pi and orphan its Claude backing conversation.
    await transcript.saveMeta(legacyMeta("legacy"));
    await transcript.saveMeta(legacyMeta("modern", "pi"));
    await transcript.flush();

    const m = manager();
    expect(await m.resumeSessions()).toBe(2);
    expect(m.findByName("legacy", OWNER)?.providerId).toBe("claude");
    expect(m.findByName("modern", OWNER)?.providerId).toBe("pi");
  });

  it("resumes a session whose backend is gone on claude, not on the default", async () => {
    // e.g. its API key was removed. Falling back to the configured default
    // would move it onto a backend it never ran on.
    await transcript.saveMeta(legacyMeta("orphan", "gemini"));
    await transcript.flush();

    const m = manager();
    expect(await m.resumeSessions()).toBe(1);
    expect(m.findByName("orphan", OWNER)?.providerId).toBe("claude");
  });
});

describe("dispatch under a non-claude default", () => {
  it("validates a provider-less spawn's model against the default, and pins it", () => {
    const deps = manager()._fleetDispatchDeps(OWNER.accountId!, OWNER.projectId!);
    // Pinned: a task left provider-less would spawn on whatever the default is
    // at claim time, which may have changed since this model was checked.
    expect(deps.resolveBackend(undefined, "gpt-5-codex")).toEqual({ ok: true, provider: "pi", model: "gpt-5-codex" });
    // A Claude alias is not valid for the backend the worker would run on.
    expect(deps.resolveBackend(undefined, "opus").ok).toBe(false);
  });
});

describe("settings.set session.defaultProvider", () => {
  const set = (value: string | null) =>
    manager().handle(
      { type: "settings.set", id: "s1", patches: [{ key: "session.defaultProvider", value }] },
      OWNER,
      client,
    ) as Promise<SettingsSetResultMsg>;

  it("refuses a backend the next boot would refuse, and writes nothing", async () => {
    const res = await set("claud");
    expect(res.type).toBe("settings.set.result");
    expect(res.ok).toBe(false);
    expect(res.restartRequired).toBe(false);
    expect(res.errors).toEqual([
      { key: "session.defaultProvider", message: expect.stringMatching(/"claud" is not a registered backend/) },
    ]);
    expect(existsSync(configFilePaths().configPath)).toBe(false);
  });

  it("accepts a registered backend and persists it for the next boot", async () => {
    const res = await set("claude");
    expect(res.ok).toBe(true);
    expect(res.restartRequired).toBe(true);
    const onDisk = JSON.parse(readFileSync(configFilePaths().configPath, "utf8"));
    expect(onDisk.session.defaultProvider).toBe("claude");
  });

  const setBatch = (patches: Array<{ key: string; value: string | boolean | null }>) =>
    manager().handle({ type: "settings.set", id: "sb", patches }, OWNER, client) as Promise<SettingsSetResultMsg>;
  const onDisk = () =>
    existsSync(configFilePaths().configPath) ? JSON.parse(readFileSync(configFilePaths().configPath, "utf8")) : {};

  // The check is against the registry the NEXT boot builds, not the live one:
  // these are the writes a live-registry check gets wrong in both directions.
  it("refuses a batch that makes a backend the default and disables it", async () => {
    const res = await setBatch([
      { key: "session.defaultProvider", value: "pi" },
      { key: "providers.pi.enabled", value: false },
    ]);
    expect(res.ok).toBe(false);
    expect(res.errors[0]).toMatchObject({ key: "session.defaultProvider" });
    expect(res.errors[0]!.message).toMatch(/set providers\.pi\.enabled to true/);
    expect(existsSync(configFilePaths().configPath)).toBe(false);
  });

  it("refuses disabling the backend that is already the default, blaming that patch", async () => {
    expect((await setBatch([{ key: "session.defaultProvider", value: "pi" }])).ok).toBe(true);
    const res = await setBatch([{ key: "providers.pi.enabled", value: false }]);
    expect(res.ok).toBe(false);
    expect(res.errors[0]).toMatchObject({ key: "providers.pi.enabled" });
    expect(onDisk().providers?.pi?.enabled).toBeUndefined();
  });

  it("accepts enabling a backend and making it the default in one batch", async () => {
    expect((await setBatch([{ key: "providers.pi.enabled", value: false }])).ok).toBe(true);
    const res = await setBatch([
      { key: "providers.pi.enabled", value: true },
      { key: "session.defaultProvider", value: "pi" },
    ]);
    expect(res.errors).toEqual([]);
    expect(res.ok).toBe(true);
    expect(onDisk().session.defaultProvider).toBe("pi");
  });

  it("refuses clearing the API key the default backend needs", async () => {
    const saved = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-test";
    try {
      expect((await setBatch([{ key: "session.defaultProvider", value: "openai" }])).ok).toBe(true);
      const res = await setBatch([{ key: "OPENAI_API_KEY", value: null }]);
      expect(res.ok).toBe(false);
      expect(res.errors[0]).toMatchObject({ key: "OPENAI_API_KEY" });
      expect(res.errors[0]!.message).toMatch(/"openai" is not available on this daemon: .*OPENAI_API_KEY/);
      expect(process.env.OPENAI_API_KEY).toBe("sk-test");
    } finally {
      if (saved === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = saved;
    }
  });

  // A default that broke AFTER boot (its binary vanished in an upgrade) must
  // not turn Settings into a wall: only a batch that causes the breakage, or
  // that picks the default itself, is refused.
  const brokenDefault = () => {
    const { configPath } = configFilePaths();
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({ session: { defaultProvider: "pi" }, providers: { pi: { command: "/nonexistent/pi" } } }),
    );
  };

  it("still accepts unrelated saves while the default is already broken", async () => {
    brokenDefault();
    const res = await setBatch([{ key: "TELEGRAM_ALLOWED_USER_IDS", value: "123" }]);
    expect(res.errors).toEqual([]);
    expect(res.ok).toBe(true);
    expect((await setBatch([{ key: "providers.codex.enabled", value: false }])).ok).toBe(true);
  });

  it("accepts the save that repairs a broken default", async () => {
    brokenDefault();
    expect((await setBatch([{ key: "providers.pi.command", value: "pi" }])).ok).toBe(true);
  });

  it("still checks a default the batch picks, even when the current one is broken", async () => {
    brokenDefault();
    const res = await setBatch([{ key: "session.defaultProvider", value: "claud" }]);
    expect(res.ok).toBe(false);
    expect(res.errors[0]).toMatchObject({ key: "session.defaultProvider" });
  });

  it("records a refused write in the audit log", async () => {
    await set("claud");
    // Store has no audit-read API on purpose; read the table directly.
    const { Database } = await import("bun:sqlite");
    const db = new Database(join(tmp, "codeoid.db"), { readonly: true });
    const row = db
      .prepare("SELECT subject, detail FROM audit_log WHERE action = 'settings.set' ORDER BY id DESC LIMIT 1")
      .get() as { subject: string; detail: string } | undefined;
    db.close();
    expect(row).toEqual({ subject: OWNER.sub, detail: "keys=session.defaultProvider ok=false reason=next-boot" });
  });

  it("lets the value be cleared back to the built-in default", async () => {
    await set("claude");
    const res = await set(null);
    expect(res.ok).toBe(true);
    const onDisk = JSON.parse(readFileSync(configFilePaths().configPath, "utf8"));
    expect(onDisk.session?.defaultProvider).toBeUndefined();
  });
});
