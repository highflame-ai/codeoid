/**
 * Settings — manifest integrity, the config.json/.env store, and the daemon
 * RPC handlers' scope gating. All offline; the config dir is redirected to a
 * temp dir via XDG_CONFIG_HOME so nothing touches the real ~/.codeoid.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SETTINGS_MANIFEST, manifestFields } from "../daemon/settings/manifest.js";
import { getSnapshot, applyPatches } from "../daemon/settings/store.js";
import { validateConfigObject, configFilePaths } from "../config.js";
import { SessionManager } from "../daemon/session-manager.js";
import { Store } from "../daemon/store.js";
import { TranscriptStore } from "../daemon/transcript.js";
import { SCOPES } from "../protocol/scopes.js";
import type { ClientMessage, McpServerStatus, SettingKind } from "../protocol/types.js";
import { McpRegistry } from "../daemon/mcp/registry.js";
import { McpHub } from "../daemon/mcp/hub.js";
import type { RawMcpServerConfig } from "../config.js";

// ── Manifest integrity (no daemon, no IO) ─────────────────────────────────────

describe("settings manifest", () => {
  it("field keys are unique across all tabs", () => {
    const keys = manifestFields().map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("group + tab ids are unique", () => {
    const tabIds = SETTINGS_MANIFEST.tabs.map((t) => t.id);
    expect(new Set(tabIds).size).toBe(tabIds.length);
    const groupIds = SETTINGS_MANIFEST.tabs.flatMap((t) => t.groups.map((g) => `${t.id}/${g.id}`));
    expect(new Set(groupIds).size).toBe(groupIds.length);
  });

  it("backing invariants hold (config⇒path, env⇒envVar, secret⇒env)", () => {
    for (const f of manifestFields()) {
      if (f.backing === "config") expect(f.path, f.key).toBeString();
      if (f.backing === "env") expect(f.envVar, f.key).toBeString();
      if (f.secret) {
        expect(f.backing, f.key).toBe("env");
        expect(f.kind, f.key).toBe("secret");
      }
      if (f.kind === "enum") expect(f.options?.length, f.key).toBeGreaterThan(0);
    }
  });

  it("every config-backed path is a real, correctly-typed schema location (drift guard)", () => {
    // Set a deliberately WRONG-typed value at each config path. If the path is
    // real the schema rejects it (ok:false). A typo'd path would be an unknown
    // key — stripped by zod, leaving a valid object (ok:true) — which fails
    // this assertion and flags the drift.
    for (const f of manifestFields()) {
      if (f.backing !== "config") continue;
      const obj = {};
      setByPath(obj, f.path!, wrongValueFor(f.kind));
      const res = validateConfigObject(obj);
      expect(res.ok, `config path "${f.path}" (${f.key}) should be schema-known`).toBe(false);
    }
  });
});

// ── Store: read + write ────────────────────────────────────────────────────────

describe("settings store", () => {
  let tmp: string;
  let prevXdg: string | undefined;
  const managed = [
    "OPENAI_API_KEY",
    "GOOGLE_API_KEY",
    "ANTHROPIC_API_KEY",
    "CODEOID_MEMORY",
    "CODEOID_CONTEXT_STRATEGY",
    "TELEGRAM_ALLOWED_USER_IDS",
    "CODEOID_FS_BROWSE_ROOT",
  ];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "codeoid-settings-"));
    prevXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = tmp; // configFilePaths() → tmp/codeoid
    for (const k of managed) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    for (const k of managed) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  it("empty install: defaults, provenance, secrets unset, resolved paths", () => {
    const s = getSnapshot();
    expect(s.values["memory.enabled"]).toEqual({ value: true, source: "default" });
    expect(s.values.CODEOID_CONTEXT_STRATEGY).toEqual({ value: "transcript", source: "default" });
    expect(s.secrets.OPENAI_API_KEY).toEqual({ set: false, source: "unset" });
    expect(s.configPath).toContain(tmp);
    expect(s.envPath).toContain(tmp);
    // Secret values are never surfaced as regular values.
    expect(s.values).not.toHaveProperty("OPENAI_API_KEY");
  });

  it("writes config patches, validated, and reads them back as source=config", () => {
    const r = applyPatches([
      { key: "memory.enabled", value: false },
      { key: "session.turnStallTimeoutMs", value: 200_000 }, // stays above the mcp-timeout default
    ]);
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.restartRequired).toBe(true); // config fields apply at restart

    const s = getSnapshot();
    expect(s.values["memory.enabled"]).toEqual({ value: false, source: "config" });
    expect(s.values["session.turnStallTimeoutMs"]).toEqual({ value: 200_000, source: "config" });

    // Persisted to disk as real JSON.
    const onDisk = JSON.parse(readFileSync(configFilePaths().configPath, "utf8"));
    expect(onDisk.memory.enabled).toBe(false);
    expect(onDisk.session.turnStallTimeoutMs).toBe(200_000);
  });

  it("rejects an out-of-range value and writes NOTHING", () => {
    applyPatches([{ key: "memory.enabled", value: false }]); // establish a file
    const before = readFileSync(configFilePaths().configPath, "utf8");

    const r = applyPatches([{ key: "autoRotate.warnPct", value: 5 }]); // bound is 0..1
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.key).toBe("autoRotate.warnPct");

    // The file is byte-identical — the bad batch never touched disk.
    expect(readFileSync(configFilePaths().configPath, "utf8")).toBe(before);
  });

  it("enforces the cross-field refine (mcpToolTimeout < turnStallTimeout)", () => {
    const r = applyPatches([{ key: "session.mcpToolTimeoutMs", value: 999_999_999 }]);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.key === "session.mcpToolTimeoutMs")).toBe(true);
  });

  it("an unknown key rejects the whole batch, nothing written", () => {
    const r = applyPatches([
      { key: "memory.enabled", value: false },
      { key: "does.not.exist", value: 1 },
    ]);
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.message).toMatch(/unknown/i);
    expect(existsSync(configFilePaths().configPath)).toBe(false);
  });

  it("writes a secret to .env, reports presence only, updates process.env live", () => {
    const r = applyPatches([{ key: "OPENAI_API_KEY", value: "sk-secret-123" }]);
    expect(r.ok).toBe(true);
    expect(r.restartRequired).toBe(true);

    const s = getSnapshot();
    expect(s.secrets.OPENAI_API_KEY).toEqual({ set: true, source: "env-file" });
    expect(s.values).not.toHaveProperty("OPENAI_API_KEY"); // value never echoed
    expect(process.env.OPENAI_API_KEY).toBe("sk-secret-123"); // live
    expect(readFileSync(configFilePaths().envPath, "utf8")).toContain("OPENAI_API_KEY=sk-secret-123");
  });

  it("clears a secret (null value removes the .env line + process.env)", () => {
    applyPatches([{ key: "OPENAI_API_KEY", value: "sk-x" }]);
    const r = applyPatches([{ key: "OPENAI_API_KEY", value: null }]);
    expect(r.ok).toBe(true);
    expect(getSnapshot().secrets.OPENAI_API_KEY).toEqual({ set: false, source: "unset" });
    expect(process.env.OPENAI_API_KEY).toBeUndefined();
  });

  it("preserves comments + unrelated keys when writing .env", () => {
    const envPath = configFilePaths().envPath;
    mkdirSync(join(tmp, "codeoid"), { recursive: true });
    writeFileSync(envPath, "# my notes\nUNRELATED=keepme\n");
    applyPatches([{ key: "OPENAI_API_KEY", value: "sk-1" }]);
    const text = readFileSync(envPath, "utf8");
    expect(text).toContain("# my notes");
    expect(text).toContain("UNRELATED=keepme");
    expect(text).toContain("OPENAI_API_KEY=sk-1");
  });

  it("env-backed non-secret string[] round-trips through .env", () => {
    const r = applyPatches([{ key: "TELEGRAM_ALLOWED_USER_IDS", value: ["111", "222"] }]);
    expect(r.ok).toBe(true);
    expect(getSnapshot().values.TELEGRAM_ALLOWED_USER_IDS).toEqual({
      value: ["111", "222"],
      source: "env",
    });
    expect(readFileSync(configFilePaths().envPath, "utf8")).toContain("TELEGRAM_ALLOWED_USER_IDS=111,222");
  });

  it("a next-session env knob does not require a restart", () => {
    const r = applyPatches([{ key: "CODEOID_CONTEXT_STRATEGY", value: "vws" }]);
    expect(r.ok).toBe(true);
    expect(r.restartRequired).toBe(false);
    expect(getSnapshot().values.CODEOID_CONTEXT_STRATEGY).toEqual({ value: "vws", source: "env" });
  });

  it("distinguishes an external secret (real env, not .env) from an env-file one", () => {
    process.env.GOOGLE_API_KEY = "from-the-shell";
    expect(getSnapshot().secrets.GOOGLE_API_KEY).toEqual({ set: true, source: "external" });
  });

  it("rejects a multi-line env value instead of corrupting .env", () => {
    const r = applyPatches([{ key: "CODEOID_FS_BROWSE_ROOT", value: "/a\n/b" }]);
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.message).toMatch(/single line/i);
    expect(existsSync(configFilePaths().envPath)).toBe(false); // nothing written
  });

  it("quotes an env value with spaces (round-trips through the loader)", () => {
    const r = applyPatches([{ key: "CODEOID_FS_BROWSE_ROOT", value: "/path with space" }]);
    expect(r.ok).toBe(true);
    // Wrapped in double quotes, NOT escaped — loadDotEnv strips the pair back.
    expect(readFileSync(configFilePaths().envPath, "utf8")).toContain(
      'CODEOID_FS_BROWSE_ROOT="/path with space"',
    );
  });
});

// ── RPC handlers: scope gating (through SessionManager.handle) ─────────────────

describe("settings RPC handlers", () => {
  let tmp: string;
  let prevXdg: string | undefined;
  let store: Store;

  const auth = (scopes: string[]) => ({
    sub: "user:settings-test",
    scopes: scopes as never,
    delegationDepth: 0,
    accountId: "acc",
    projectId: "proj",
  });
  const client = { id: "c1", auth: auth([]), send: () => {} };

  const mgr = () => new SessionManager(store, new TranscriptStore(join(tmp, "t")));

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "codeoid-settings-rpc-"));
    prevXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = tmp;
    store = new Store(join(tmp, "codeoid.db"));
  });

  afterEach(() => {
    try { store.close(); } catch { /* ignore */ }
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("settings.schema requires settings:read", async () => {
    const denied = await mgr().handle({ type: "settings.schema", id: "1" }, auth([]), client);
    expect(denied).toMatchObject({ type: "response.error", code: "forbidden" });

    const ok = (await mgr().handle(
      { type: "settings.schema", id: "2" },
      auth([SCOPES.SETTINGS_READ]),
      client,
    )) as { type: string; manifest: { tabs: unknown[] } };
    expect(ok.type).toBe("settings.schema.result");
    expect(ok.manifest.tabs.length).toBeGreaterThan(0);
  });

  it("settings.get requires settings:read and returns a snapshot", async () => {
    const denied = await mgr().handle({ type: "settings.get", id: "1" }, auth([]), client);
    expect(denied).toMatchObject({ type: "response.error", code: "forbidden" });

    const ok = await mgr().handle({ type: "settings.get", id: "2" }, auth([SCOPES.SETTINGS_READ]), client);
    expect(ok.type).toBe("settings.get.result");
  });

  it("settings.get surfaces registry MCP servers + health (read-only)", async () => {
    const raw = (p: Partial<RawMcpServerConfig>): RawMcpServerConfig =>
      ({ args: [], env: {}, headers: {}, trust: "prompt", scope: "session", enabled: true, native: false, ...p }) as RawMcpServerConfig;
    const m = mgr();
    m.setMcp(
      new McpRegistry({ github: raw({ command: "npx", args: ["-y", "@mcp/gh"] }) }, { memoryEnabled: true }),
      new McpHub({}),
    );
    const ok = (await m.handle({ type: "settings.get", id: "3" }, auth([SCOPES.SETTINGS_READ]), client)) as {
      snapshot: { mcpServers?: McpServerStatus[] };
    };
    const servers = ok.snapshot.mcpServers ?? [];
    const mem = servers.find((s) => s.name === "codeoid_memory");
    expect(mem).toMatchObject({ builtin: true, transport: "in-process", trust: "readonly" });
    const gh = servers.find((s) => s.name === "github");
    // Configured but never used this run → idle, no tools yet.
    expect(gh).toMatchObject({ builtin: false, transport: "stdio", health: "idle", toolCount: 0 });
  });

  it("settings.set requires settings:write (read alone is not enough)", async () => {
    const denied = await mgr().handle(
      { type: "settings.set", id: "1", patches: [{ key: "memory.enabled", value: false }] },
      auth([SCOPES.SETTINGS_READ]),
      client,
    );
    expect(denied).toMatchObject({ type: "response.error", code: "forbidden" });
  });

  it("settings.set with settings:write persists and returns the new snapshot", async () => {
    const res = (await mgr().handle(
      { type: "settings.set", id: "1", patches: [{ key: "memory.enabled", value: false }] },
      auth([SCOPES.SETTINGS_WRITE]),
      client,
    )) as { type: string; ok: boolean; snapshot: { values: Record<string, { value: unknown }> } };
    expect(res.type).toBe("settings.set.result");
    expect(res.ok).toBe(true);
    expect(res.snapshot.values["memory.enabled"]?.value).toBe(false);
  });

  // ── Interactive backend sign-in ─────────────────────────────────────────────
  // Gated on settings:write, because a completed login writes a credential to
  // the same `.env` that scope already governs. These pin the gate; the flow
  // itself is covered in backend-login.test.ts against a real pty.

  it.each([
    ["backend.login.start", { type: "backend.login.start", backend: "claude" }],
    ["backend.login.submit", { type: "backend.login.submit", loginId: "L", code: "c" }],
    ["backend.login.cancel", { type: "backend.login.cancel", loginId: "L" }],
  ] as const)("%s requires settings:write (read alone is not enough)", async (_name, msg) => {
    const denied = await mgr().handle(
      { ...msg, id: "1" } as ClientMessage,
      auth([SCOPES.SETTINGS_READ]),
      client,
    );
    expect(denied).toMatchObject({ type: "response.error", code: "forbidden" });
  });

  it("cancelling an unknown login is a clean no-op, not an error", async () => {
    const res = await mgr().handle(
      { type: "backend.login.cancel", id: "1", loginId: "never-existed" },
      auth([SCOPES.SETTINGS_WRITE]),
      client,
    );
    expect(res).toMatchObject({ type: "backend.login.cancel.result", ok: false });
  });

  it("submitting against an unknown login reports it plainly, without writing", async () => {
    const res = (await mgr().handle(
      { type: "backend.login.submit", id: "1", loginId: "never-existed", code: "abc" },
      auth([SCOPES.SETTINGS_WRITE]),
      client,
    )) as { type: string; ok: boolean; error?: string };
    expect(res.type).toBe("backend.login.submit.result");
    expect(res.ok).toBe(false);
    expect(res.error).toContain("no longer open");
  });
});

// ── Local helpers for the drift guard ──────────────────────────────────────────

function setByPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i]!;
    if (typeof cur[k] !== "object" || cur[k] === null) cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]!] = value;
}

/** A value of the WRONG type for the given kind — should fail schema validation. */
function wrongValueFor(kind: SettingKind): unknown {
  switch (kind) {
    case "boolean":
      return "not-a-boolean";
    case "int":
    case "float":
      return "not-a-number";
    case "string[]":
      return "not-an-array";
    case "enum":
      return "__not_a_valid_enum_option__";
    default:
      return 12345; // a number where a string is expected
  }
}
