/**
 * ProviderRegistry — the daemon's provider catalog (factories, not
 * instances). Covers registration invariants, resolve() fallback semantics
 * (resume must survive unknown provider ids from a newer codeoid), and the
 * default catalog's stateless factories. The claude factory is registered
 * but not exercised here — constructing ClaudeProvider is covered by
 * provider-claude.test.ts; these tests stay SDK-free.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  createDefaultProviderRegistry,
  DefaultProviderError,
  defaultProviderProblem,
  ProviderRegistry,
  type ProviderFactory,
  type ProviderSessionInit,
} from "../daemon/providers/registry.js";
import { MockSessionProvider } from "../daemon/providers/mock/session-provider.js";
import { Store } from "../daemon/store.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function mockFactory(id: string): ProviderFactory {
  return {
    id,
    displayName: `Mock ${id}`,
    create: () => new MockSessionProvider(id),
  };
}

function makeInit(store: Store): ProviderSessionInit {
  // sessionId and initialBackingId deliberately differ so assertions prove
  // WHICH field feeds each provider surface (stateless providers label
  // themselves with the codeoid session id, not the backing id).
  return {
    sessionId: "s1",
    workspaceId: "ws1",
    model: null,
    initialBackingId: "backing-9",
    store,
  };
}

describe("ProviderRegistry", () => {
  // The API backends (openai/gemini) register only when their key is in the
  // env. Save + restore so tests are hermetic regardless of the CI env.
  const savedOpenAI = process.env.OPENAI_API_KEY;
  const savedGoogle = process.env.GOOGLE_API_KEY;
  beforeEach(() => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
  });
  afterEach(() => {
    if (savedOpenAI === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = savedOpenAI;
    if (savedGoogle === undefined) delete process.env.GOOGLE_API_KEY;
    else process.env.GOOGLE_API_KEY = savedGoogle;
  });
  const withApiKeys = () => {
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.GOOGLE_API_KEY = "gk-test";
  };
  it("registers, lists, and resolves factories", () => {
    const registry = new ProviderRegistry("alpha");
    registry.register(mockFactory("alpha"));
    registry.register(mockFactory("beta"));

    expect(registry.ids().sort()).toEqual(["alpha", "beta"]);
    expect(registry.has("beta")).toBe(true);
    expect(registry.get("beta")?.displayName).toBe("Mock beta");
    expect(registry.getOrThrow("alpha").id).toBe("alpha");
    expect(registry.list()).toHaveLength(2);
  });

  it("rejects duplicate registration", () => {
    const registry = new ProviderRegistry();
    registry.register(mockFactory("claude"));
    expect(() => registry.register(mockFactory("claude"))).toThrow(/already registered/);
  });

  it("getOrThrow names the registered ids on a miss", () => {
    const registry = new ProviderRegistry();
    registry.register(mockFactory("alpha"));
    expect(() => registry.getOrThrow("nope")).toThrow(/alpha/);
  });

  it("resolve() falls back to the default for unknown ids (resume forward-compat)", () => {
    const registry = new ProviderRegistry("alpha");
    registry.register(mockFactory("alpha"));
    registry.register(mockFactory("beta"));

    expect(registry.resolve("beta", "test").id).toBe("beta");
    expect(registry.resolve(undefined, "test").id).toBe("alpha");
    // Unknown → warn + default, never throw.
    expect(registry.resolve("pi-from-the-future", "test").id).toBe("alpha");
  });

  it("default catalog registers claude, gemini, openai, pi, gemini-cli with claude as default", () => {
    withApiKeys();
    const registry = createDefaultProviderRegistry();
    // pi + gemini-cli are BUNDLED (always activate); codex is PATH-dependent,
    // so assert membership rather than the exact machine-dependent set.
    for (const id of ["claude", "gemini", "openai", "pi", "gemini-cli"]) {
      expect(registry.has(id)).toBe(true);
    }
    expect(registry.defaultId).toBe("claude");
  });

  // session.defaultProvider (#339). A config literal is enough — the registry
  // reads only `session.defaultProvider` and `providers.*`.
  const withDefault = (defaultProvider: string, extra: Record<string, unknown> = {}) =>
    ({ session: { defaultProvider }, ...extra }) as unknown as Parameters<typeof createDefaultProviderRegistry>[0];

  it("session.defaultProvider makes another backend the default", () => {
    const registry = createDefaultProviderRegistry(withDefault("qwen"));
    expect(registry.defaultId).toBe("qwen");
    // A session carrying no provider selection lands on it.
    expect(registry.resolve(undefined, "test").id).toBe("qwen");
  });

  it("a misspelled defaultProvider fails startup instead of reverting to claude", () => {
    // Its own class, so the CLI prints it as a config mistake, not a crash.
    expect(() => createDefaultProviderRegistry(withDefault("claud"))).toThrow(DefaultProviderError);
    expect(() => createDefaultProviderRegistry(withDefault("claud"))).toThrow(
      /session\.defaultProvider "claud" is not a registered backend \(registered: claude,/,
    );
  });

  it("a disabled defaultProvider fails startup and names the switch", () => {
    expect(() =>
      createDefaultProviderRegistry(withDefault("pi", { providers: { pi: { enabled: false, command: "pi" } } })),
    ).toThrow(/providers\.pi\.enabled is false/);
  });

  it("an unavailable defaultProvider fails startup with that backend's own hint", () => {
    // Keys deleted by beforeEach, so openai is supported but not activatable.
    expect(() => createDefaultProviderRegistry(withDefault("openai"))).toThrow(
      /"openai" is not available on this daemon: .*OPENAI_API_KEY/,
    );
  });

  it("defaultProviderProblem accepts exactly the registered backends", () => {
    const registry = createDefaultProviderRegistry();
    expect(defaultProviderProblem(registry, "claude")).toBeUndefined();
    expect(defaultProviderProblem(registry, "qwen")).toBeUndefined();
    expect(defaultProviderProblem(registry, "nope")).toMatch(/not a registered backend/);
  });

  it("config can disable the pi backend", () => {
    withApiKeys();
    const registry = createDefaultProviderRegistry({
      providers: { pi: { enabled: false, command: "pi" } },
    } as unknown as Parameters<typeof createDefaultProviderRegistry>[0]);
    expect(registry.has("pi")).toBe(false);
    for (const id of ["claude", "gemini", "openai"]) {
      expect(registry.has(id)).toBe(true);
    }
  });

  it("gates openai/gemini on their API key — marked unavailable with a hint when unset", () => {
    // Keys deleted by beforeEach.
    const registry = createDefaultProviderRegistry();
    expect(registry.has("openai")).toBe(false);
    expect(registry.has("gemini")).toBe(false);
    // Not advertised, but the reason is available for the catalog / UI.
    expect(registry.unavailableHint("openai")).toMatch(/OPENAI_API_KEY/);
    expect(registry.unavailableHint("gemini")).toMatch(/GOOGLE_API_KEY/);
    // claude is always available.
    expect(registry.has("claude")).toBe(true);
  });

  it("registers openai/gemini once their keys are present", () => {
    withApiKeys();
    const registry = createDefaultProviderRegistry();
    expect(registry.has("openai")).toBe(true);
    expect(registry.has("gemini")).toBe(true);
    expect(registry.unavailableHint("openai")).toBeUndefined();
  });

  it("an unregistered API backend resolves to the default (existing sessions survive resume)", () => {
    // No keys: openai unavailable. A resumed openai session must fall back
    // to claude rather than crash.
    const registry = createDefaultProviderRegistry();
    const factory = registry.resolve("openai", "test");
    expect(factory.id).toBe("claude");
  });

  it("the pi factory constructs a provider labeled with the codeoid session id", () => {
    const tmp = mkdtempSync(join(tmpdir(), "codeoid-registry-pi-"));
    const store = new Store(join(tmp, "codeoid.db"));
    try {
      const registry = createDefaultProviderRegistry();
      const pi = registry.getOrThrow("pi").create(makeInit(store));
      expect(pi.id).toBe("pi");
      // No pi session file yet — the backing id starts as the init value
      // and is replaced by the real file on first spawn.
      expect(pi.backingSessionId).toBe("backing-9");
    } finally {
      try { store.close(); } catch {}
      try { rmSync(tmp, { recursive: true, force: true }); } catch {}
    }
  });

  it("stateless factories construct providers with the right ids", () => {
    withApiKeys();
    const tmp = mkdtempSync(join(tmpdir(), "codeoid-registry-"));
    const store = new Store(join(tmp, "codeoid.db"));
    try {
      const registry = createDefaultProviderRegistry();
      const init = makeInit(store);

      const gemini = registry.getOrThrow("gemini").create(init);
      expect(gemini.id).toBe("gemini");
      // Stateless providers use the codeoid session id as their display
      // label — NOT initialBackingId (that's for warm providers).
      expect(gemini.backingSessionId).toBe("s1");

      const openai = registry.getOrThrow("openai").create(init);
      expect(openai.id).toBe("openai");
    } finally {
      try { store.close(); } catch {}
      try { rmSync(tmp, { recursive: true, force: true }); } catch {}
    }
  });
});
