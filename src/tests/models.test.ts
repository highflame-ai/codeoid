/**
 * Model catalog + resolver tests — the layer everything else sits on.
 * Also covers Store persistence of session.model / fallback_model so the
 * choice survives daemon restart.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MODEL_CATALOG,
  findModel,
  resolveModelId,
  resolveModelIdForProvider,
  CLAUDE_PROVIDER_ID,
  DEFAULT_MODEL_ALIAS,
  fallbackModelInfos,
  resolveAgainstList,
  stripVariantSuffix,
} from "../daemon/models.js";
import { Store } from "../daemon/store.js";
import { SessionManager, DEFAULT_PROVIDER_ID } from "../daemon/session-manager.js";
import { TranscriptStore } from "../daemon/transcript.js";

describe("resolveAgainstList (live-backend resolution)", () => {
  // Verbatim from `supportedModels()` on claude-agent-sdk 0.3.258. The
  // previous fixture said the Opus entry's displayName was "Opus", which made
  // the alias resolve by display-name match; the backend actually reports
  // "Opus (1M context)", so `opus` matched nothing and silently fell through
  // to the baked-in catalog. Keep this fixture honest to the real payload.
  const live = [
    { value: "default", displayName: "Default (recommended)", isDefault: true },
    { value: "opus[1m]", displayName: "Opus (1M context)" },
    { value: "claude-fable-5-1[1m]", displayName: "Fable" },
    { value: "sonnet", displayName: "Sonnet" },
    { value: "haiku", displayName: "Haiku" },
  ];

  it("matches an exact value", () => {
    expect(resolveAgainstList("opus[1m]", live)).toBe("opus[1m]");
    expect(resolveAgainstList("sonnet", live)).toBe("sonnet");
  });
  it("matches a bare alias against a variant-suffixed value", () => {
    expect(resolveAgainstList("opus", live)).toBe("opus[1m]");
    expect(resolveAgainstList("OPUS", live)).toBe("opus[1m]");
  });
  it("matches a display name case-insensitively", () => {
    expect(resolveAgainstList("fable", live)).toBe("claude-fable-5-1[1m]");
    expect(resolveAgainstList("Default (recommended)", live)).toBe("default");
  });
  it("prefers an exact value over a suffix-stripped match", () => {
    const both = [{ value: "opus[1m]", displayName: "Opus (1M context)" }, { value: "opus", displayName: "Opus" }];
    expect(resolveAgainstList("opus", both)).toBe("opus");
  });
  it("matches a bare full id against its variant-suffixed entry", () => {
    // Typing the plain id resolves to the 1M variant the backend actually
    // offers, rather than falling through to the claude-* passthrough.
    expect(resolveAgainstList("claude-fable-5-1", live)).toBe("claude-fable-5-1[1m]");
  });
  it("passes through a claude-* id the backend didn't advertise", () => {
    // The catalog and the live list both go stale between releases; the
    // passthrough is what keeps a brand-new id reachable in the meantime.
    expect(resolveAgainstList("claude-opus-6", live)).toBe("claude-opus-6");
  });
  it("returns null for an unknown value", () => {
    expect(resolveAgainstList("o", live)).toBeNull();
    expect(resolveAgainstList("", live)).toBeNull();
  });
});

describe("stripVariantSuffix", () => {
  it("strips a bracketed context-window variant", () => {
    expect(stripVariantSuffix("opus[1m]")).toBe("opus");
    expect(stripVariantSuffix("claude-fable-5[1m]")).toBe("claude-fable-5");
  });
  it("leaves an unsuffixed value alone", () => {
    expect(stripVariantSuffix("sonnet")).toBe("sonnet");
    expect(stripVariantSuffix("")).toBe("");
  });
});

describe("fallbackModelInfos", () => {
  it("renders the built-in catalog as ModelInfo with a default", () => {
    const infos = fallbackModelInfos();
    expect(infos.length).toBe(MODEL_CATALOG.length);
    expect(infos.some((m) => m.isDefault)).toBe(true);
    expect(infos.every((m) => m.value && m.displayName)).toBe(true);
  });
});

describe("MODEL_CATALOG shape", () => {
  // The catalog is only the pre-first-report fallback, but a stale entry here
  // is not harmless: it silently pins the alias to a superseded model on every
  // path that misses the live list. `opus` sat on claude-opus-4-8 well after
  // Opus 5 shipped. This asserts the generation, not the point release, so a
  // real bump stays a one-line edit while a whole generation going stale fails.
  it("maps the premium alias to the current Opus generation", () => {
    expect(resolveModelId("opus")).toBe("claude-opus-5");
  });

  it("covers the three canonical tiers", () => {
    expect(MODEL_CATALOG.length).toBeGreaterThanOrEqual(3);
    const tiers = new Set(MODEL_CATALOG.map((m) => m.tier));
    expect(tiers.has("premium")).toBe(true);
    expect(tiers.has("balanced")).toBe(true);
    expect(tiers.has("fast")).toBe(true);
  });

  it("all entries have distinct aliases + ids", () => {
    const aliases = new Set(MODEL_CATALOG.map((m) => m.alias));
    const ids = new Set(MODEL_CATALOG.map((m) => m.id));
    expect(aliases.size).toBe(MODEL_CATALOG.length);
    expect(ids.size).toBe(MODEL_CATALOG.length);
  });

  it("default alias resolves to a real model", () => {
    expect(findModel(DEFAULT_MODEL_ALIAS)).not.toBeNull();
  });
});

describe("findModel + resolveModelId", () => {
  it("resolves known aliases case-insensitively", () => {
    expect(findModel("opus")?.id).toMatch(/^claude-opus-/);
    expect(findModel("OPUS")?.id).toMatch(/^claude-opus-/);
    expect(findModel("Opus")?.id).toMatch(/^claude-opus-/);
  });

  it("resolves full ids to themselves", () => {
    const known = MODEL_CATALOG[0]!;
    expect(findModel(known.id)?.id).toBe(known.id);
    expect(resolveModelId(known.id)).toBe(known.id);
  });

  it("returns null only for empty input; otherwise passes through", () => {
    // resolveModelId no longer gatekeeps unknown values — the daemon validates
    // against the live backend catalog (resolveAgainstList) instead. Unknown
    // non-empty input passes through; the SDK is the final validator.
    expect(findModel("gpt-5")).toBeNull(); // still not in the built-in catalog
    expect(resolveModelId("gpt-5")).toBe("gpt-5");
    expect(resolveModelId("")).toBeNull();
    expect(resolveModelId("   ")).toBeNull();
  });

  it("passthrough accepts any claude-* id not in our catalog", () => {
    // Hypothetical future model — don't gatekeep.
    expect(resolveModelId("claude-opus-4-9-hypothetical")).toBe(
      "claude-opus-4-9-hypothetical",
    );
    expect(findModel("claude-opus-4-9-hypothetical")).toBeNull(); // but not in catalog
  });

  it("handles empty / whitespace input", () => {
    expect(resolveModelId("")).toBeNull();
    expect(resolveModelId("   ")).toBeNull();
    expect(findModel("")).toBeNull();
  });

  it("trims whitespace around aliases", () => {
    expect(resolveModelId("  sonnet  ")).toMatch(/^claude-sonnet-/);
  });
});

describe("resolveModelIdForProvider (per-child backend resolution)", () => {
  it("behaves exactly like resolveModelId on the claude backend", () => {
    for (const input of ["opus", "sonnet", "haiku", "claude-opus-4-9-hypothetical"]) {
      expect(resolveModelIdForProvider(input, CLAUDE_PROVIDER_ID)).toBe(
        resolveModelId(input),
      );
    }
  });

  it("treats an unspecified provider as claude", () => {
    expect(resolveModelIdForProvider("opus")).toBe(resolveModelId("opus"));
    expect(resolveModelIdForProvider("opus", undefined)).toMatch(/^claude-opus-/);
  });

  // The regression this function exists for: config.session.defaultModel is a
  // global, so a Claude alias must not expand onto a non-Claude backend.
  it("does NOT leak a claude alias onto a non-claude backend", () => {
    expect(resolveModelIdForProvider("opus", "gemini")).toBeNull();
    expect(resolveModelIdForProvider("sonnet", "openai")).toBeNull();
    expect(resolveModelIdForProvider("haiku", "codex")).toBeNull();
  });

  it("does NOT forward a full claude id onto a non-claude backend", () => {
    expect(resolveModelIdForProvider("claude-opus-4-8", "gemini")).toBeNull();
    expect(resolveModelIdForProvider("claude-anything-at-all", "pi")).toBeNull();
  });

  it("passes a provider-native model through untouched", () => {
    expect(resolveModelIdForProvider("gemini-2.5-pro", "gemini")).toBe("gemini-2.5-pro");
    expect(resolveModelIdForProvider("gpt-5-codex", "openai")).toBe("gpt-5-codex");
    expect(resolveModelIdForProvider("  gpt-5-codex  ", "openai")).toBe("gpt-5-codex");
  });

  it("returns null on empty / whitespace regardless of provider", () => {
    expect(resolveModelIdForProvider("", "gemini")).toBeNull();
    expect(resolveModelIdForProvider("   ", "gemini")).toBeNull();
    expect(resolveModelIdForProvider("", CLAUDE_PROVIDER_ID)).toBeNull();
  });

  it("keeps CLAUDE_PROVIDER_ID in lockstep with DEFAULT_PROVIDER_ID", () => {
    expect(DEFAULT_PROVIDER_ID).toBe(CLAUDE_PROVIDER_ID);
  });
});

describe("Store session.model persistence", () => {
  let tmp: string;
  let store: Store;
  const sessionId = "sess_model_test";

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "codeoid-model-"));
    store = new Store(join(tmp, "codeoid.db"));
    store.createSession({
      id: sessionId,
      name: "test",
      workdir: "/tmp",
      status: "idle",
      createdBy: "user",
      createdAt: new Date().toISOString(),
      attachedClients: 0,
      accountId: "acc",
      projectId: "proj",
    });
  });

  afterEach(() => {
    try { store.close(); } catch {}
    try { rmSync(tmp, { recursive: true, force: true }); } catch {}
  });

  it("initial state: both null", () => {
    const { model, fallbackModel } = store.getSessionModel(sessionId);
    expect(model).toBeNull();
    expect(fallbackModel).toBeNull();
  });

  it("setSessionModel(id, model) leaves fallback untouched", () => {
    store.setSessionModel(sessionId, "claude-opus-4-7", "claude-sonnet-4-6");
    expect(store.getSessionModel(sessionId).fallbackModel).toBe("claude-sonnet-4-6");
    // Update ONLY the primary — fallback preserved.
    store.setSessionModel(sessionId, "claude-haiku-4-5-20251001");
    const after = store.getSessionModel(sessionId);
    expect(after.model).toBe("claude-haiku-4-5-20251001");
    expect(after.fallbackModel).toBe("claude-sonnet-4-6");
  });

  it("setSessionModel(id, model, null) clears fallback", () => {
    store.setSessionModel(sessionId, "claude-opus-4-7", "claude-sonnet-4-6");
    store.setSessionModel(sessionId, "claude-opus-4-7", null);
    expect(store.getSessionModel(sessionId).fallbackModel).toBeNull();
  });

  it("setSessionModel(id, null) clears the primary model", () => {
    store.setSessionModel(sessionId, "claude-opus-4-7");
    store.setSessionModel(sessionId, null);
    expect(store.getSessionModel(sessionId).model).toBeNull();
  });

  it("survives daemon restart (reopen = same state)", () => {
    store.setSessionModel(sessionId, "claude-opus-4-7", "claude-sonnet-4-6");
    store.close();

    const reopened = new Store(join(tmp, "codeoid.db"));
    const got = reopened.getSessionModel(sessionId);
    expect(got.model).toBe("claude-opus-4-7");
    expect(got.fallbackModel).toBe("claude-sonnet-4-6");
    reopened.close();
  });
});

// ── Persisted live model catalog (models.list fallback tiering) ──────────────

describe("model catalog persistence (Store)", () => {
  let tmp: string;
  let store: Store;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "codeoid-modelcat-"));
    store = new Store(join(tmp, "codeoid.db"));
  });

  afterEach(() => {
    try { store.close(); } catch {}
    try { rmSync(tmp, { recursive: true, force: true }); } catch {}
  });

  it("returns null before any catalog was saved", () => {
    expect(store.getModelCatalog("claude")).toBeNull();
  });

  it("round-trips a saved catalog per provider", () => {
    const models = [
      { value: "default", displayName: "Default (recommended)", isDefault: true },
      { value: "fable", displayName: "Fable 5", isDefault: false },
    ];
    store.saveModelCatalog("claude", models);
    expect(store.getModelCatalog("claude")).toEqual(models);
    expect(store.getModelCatalog("gemini")).toBeNull(); // no cross-provider leak
  });

  it("providers are isolated rows; upsert per provider — latest save wins", () => {
    store.saveModelCatalog("claude", [{ value: "a", displayName: "A", isDefault: false }]);
    store.saveModelCatalog("gemini", [{ value: "g", displayName: "G", isDefault: true }]);
    store.saveModelCatalog("claude", [{ value: "b", displayName: "B", isDefault: true }]);
    expect(store.getModelCatalog("claude")?.[0]?.value).toBe("b");
    expect(store.getModelCatalog("gemini")?.[0]?.value).toBe("g");
  });

  it("survives a store reopen (new daemon lifetime)", () => {
    store.saveModelCatalog("claude", [
      { value: "opus", displayName: "Opus 4.8", isDefault: true },
    ]);
    store.close();
    const reopened = new Store(join(tmp, "codeoid.db"));
    expect(reopened.getModelCatalog("claude")?.[0]?.displayName).toBe("Opus 4.8");
    reopened.close();
  });
});

describe("models.list serves live → persisted → baked-in fallback, per provider", () => {
  let tmp: string;
  let store: Store;

  const AUTH = {
    sub: "user:models-test",
    scopes: [],
    delegationDepth: 0,
    accountId: "acc",
    projectId: "proj",
  };

  const LIVE = [
    { value: "default", displayName: "Default (recommended)" },
    { value: "fable", displayName: "Fable 5" },
    { value: "opus", displayName: "Opus 4.8" },
  ];

  type CacheModels = {
    _cacheModels(providerId: string, m: { value: string; displayName: string }[]): void;
  };

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "codeoid-modeltier-"));
    store = new Store(join(tmp, "codeoid.db"));
  });

  afterEach(() => {
    try { store.close(); } catch {}
    try { rmSync(tmp, { recursive: true, force: true }); } catch {}
  });

  async function listModels(manager: SessionManager, provider?: string) {
    const client = { id: "client-models-test", auth: AUTH, send: () => {} };
    const res = (await manager.handle(
      { type: "models.list", id: "req-models", ...(provider ? { provider } : {}) },
      AUTH,
      client,
    )) as {
      type: string;
      models: { value: string; displayName: string }[];
      live: boolean;
      provider: string;
    };
    expect(res.type).toBe("models.list.result");
    return res;
  }

  it("first-ever boot: baked-in fallback for the default provider, live=false", async () => {
    const manager = new SessionManager(store, new TranscriptStore(join(tmp, "t")));
    const res = await listModels(manager);
    expect(res.live).toBe(false);
    expect(res.provider).toBe(DEFAULT_PROVIDER_ID);
    expect(res.models.map((m) => m.value)).toEqual(
      fallbackModelInfos().map((m) => m.value),
    );
  });

  it("non-default provider with no reports yet: empty list, not the claude fallback", async () => {
    const manager = new SessionManager(store, new TranscriptStore(join(tmp, "t")));
    const res = await listModels(manager, "gemini");
    expect(res.live).toBe(false);
    expect(res.provider).toBe("gemini");
    expect(res.models).toEqual([]);
  });

  it("after a provider reports: live=true and the list is persisted under that provider", async () => {
    const manager = new SessionManager(store, new TranscriptStore(join(tmp, "t")));
    (manager as unknown as CacheModels)._cacheModels("claude", LIVE);

    const res = await listModels(manager);
    expect(res.live).toBe(true);
    expect(res.models.map((m) => m.value)).toEqual(["default", "fable", "opus"]);
    expect(store.getModelCatalog("claude")?.map((m) => m.value)).toEqual([
      "default",
      "fable",
      "opus",
    ]);
    expect(store.getModelCatalog("gemini")).toBeNull();
  });

  it("catalogs are per-provider: one provider going live does not leak into another", async () => {
    const manager = new SessionManager(store, new TranscriptStore(join(tmp, "t")));
    const cache = manager as unknown as CacheModels;
    cache._cacheModels("claude", LIVE);
    cache._cacheModels("gemini", [{ value: "gemini-pro", displayName: "Gemini Pro" }]);

    expect((await listModels(manager, "claude")).models.map((m) => m.value)).toEqual([
      "default",
      "fable",
      "opus",
    ]);
    expect((await listModels(manager, "gemini")).models.map((m) => m.value)).toEqual([
      "gemini-pro",
    ]);
  });

  it("next boot before any turn: persisted list served, live=false", async () => {
    const first = new SessionManager(store, new TranscriptStore(join(tmp, "t")));
    (first as unknown as CacheModels)._cacheModels("claude", LIVE);

    // Fresh manager = fresh daemon lifetime, same store.
    const second = new SessionManager(store, new TranscriptStore(join(tmp, "t")));
    const res = await listModels(second);
    expect(res.live).toBe(false); // clients keep refetching until live
    expect(res.models.map((m) => m.value)).toEqual(["default", "fable", "opus"]);
  });

  // Providers report on every query-loop build, so the newest report is the
  // most current view of what the backend serves — a model added to a gateway
  // must appear on the next session, not after a daemon restart.
  it("latest live report wins per provider; empty reports ignored", async () => {
    const manager = new SessionManager(store, new TranscriptStore(join(tmp, "t")));
    const cache = manager as unknown as CacheModels;
    cache._cacheModels("claude", []);
    expect((await listModels(manager)).live).toBe(false);
    cache._cacheModels("claude", LIVE);
    cache._cacheModels("claude", [{ value: "other", displayName: "Other" }]);
    expect((await listModels(manager)).models.map((m) => m.value)).toEqual(["other"]);
  });

  it("an empty report never clobbers an already-cached catalog", async () => {
    const manager = new SessionManager(store, new TranscriptStore(join(tmp, "t")));
    const cache = manager as unknown as CacheModels;
    cache._cacheModels("claude", LIVE);
    cache._cacheModels("claude", []);
    const res = await listModels(manager);
    expect(res.models.map((m) => m.value)).toEqual(["default", "fable", "opus"]);
    expect(res.live).toBe(true);
  });
});
