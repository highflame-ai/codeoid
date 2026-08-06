/**
 * Config loader tests — exercise the layered precedence, env overrides,
 * path resolution, and failure modes. Tests pass a controlled env object
 * instead of touching process.env so we don't leak state between runs.
 */

import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  daemonPortFromUrl,
  getLocalTokenPath,
  loadConfig,
  resolveLocalToken,
  resolveZeroidUrl,
} from "../config.js";
import {
  mintLocalToken,
  removeLocalTokenFile,
  writeLocalTokenFile,
} from "../daemon/local-auth.js";

let tmp: string;
let configPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "codeoid-config-"));
  configPath = join(tmp, "config.json");
});

afterEach(() => {
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
});

function writeConfig(obj: unknown): void {
  writeFileSync(configPath, JSON.stringify(obj, null, 2));
}

describe("loadConfig — defaults", () => {
  it("returns sane defaults with no file + no env", () => {
    const c = loadConfig({ configPath, env: {} });
    expect(c.daemonUrl).toBe("ws://127.0.0.1:7400");
    // Ships pointing at the Highflame SaaS issuer (preset "highflame").
    expect(c.zeroidUrl).toBe("https://auth.highflame.ai");
    // Issuer claim is pinned to the resolved base URL by default.
    expect(c.auth.issuer).toBe("https://auth.highflame.ai");
    expect(c.compress.enabled).toBe(false);
    expect(c.compress.minBytes).toBe(1024);
    expect(c.workspaceIndex.enabled).toBe(true);
    expect(c.memory?.enabled).toBe(true);
    expect(c.memory?.clusters.enabled).toBe(false);
    expect(c.telemetry.osc8).toBe("auto");
    // Pipeline is ON by default (user-initiated + gate-halted + scope/trust
    // gated, so no off-by-default is warranted); the flag is an operator opt-out.
    expect(c.pipeline?.enabled).toBe(true);
    expect(c.pipeline?.defaultPack).toBe(null);
  });

  it("agentIdentity stays undefined when no file/env supplies it", () => {
    const c = loadConfig({ configPath, env: {} });
    expect(c.agentIdentity).toBeUndefined();
  });
});

describe("loadConfig — file values", () => {
  it("honors a full config file", () => {
    writeConfig({
      daemonUrl: "ws://10.0.0.1:9999",
      apiKey: "zid_sk_xxx",
      compress: { enabled: true, excludeCommands: ["curl"], minBytes: 2048 },
      memory: { enabled: false, dbPath: "/tmp/mem.db", clusters: { enabled: true } },
      workspaceIndex: { enabled: false, episodeThreshold: 99, timeThresholdMs: 5000, debounceMs: 1000 },
      telemetry: { osc8: "force" },
      agentIdentity: { accountId: "acme", projectId: "prod" },
    });
    const c = loadConfig({ configPath, env: {} });
    expect(c.daemonUrl).toBe("ws://10.0.0.1:9999");
    expect(c.apiKey).toBe("zid_sk_xxx");
    expect(c.compress.enabled).toBe(true);
    expect(c.compress.excludeCommands).toEqual(["curl"]);
    expect(c.compress.minBytes).toBe(2048);
    expect(c.memory?.enabled).toBe(false);
    expect(c.memory?.clusters.enabled).toBe(true);
    expect(c.workspaceIndex.enabled).toBe(false);
    expect(c.workspaceIndex.episodeThreshold).toBe(99);
    expect(c.telemetry.osc8).toBe("force");
    expect(c.agentIdentity).toEqual({ accountId: "acme", projectId: "prod" });
  });

  it("accepts a partial file (missing sections get defaults)", () => {
    writeConfig({ apiKey: "legacy_only" });
    const c = loadConfig({ configPath, env: {} });
    expect(c.apiKey).toBe("legacy_only");
    expect(c.compress.enabled).toBe(false);
    expect(c.workspaceIndex.enabled).toBe(true);
    expect(c.memory?.enabled).toBe(true);
  });
});

describe("loadConfig — registrar key + tenant", () => {
  it("ZEROID_REGISTRAR_KEY flows into agentIdentity.registrarKey (with an explicit tenant)", () => {
    const c = loadConfig({
      configPath,
      env: {
        ZEROID_REGISTRAR_KEY: "zid_sk_badge",
        ZEROID_ACCOUNT_ID: "acme",
        ZEROID_PROJECT_ID: "prod",
      },
    });
    expect(c.agentIdentity).toEqual({
      accountId: "acme",
      projectId: "prod",
      registrarKey: "zid_sk_badge",
    });
  });

  it("warns when the registrar key is set but the tenant fell back to personal/dev", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const c = loadConfig({
        configPath,
        env: { ZEROID_REGISTRAR_KEY: "zid_sk_badge" },
      });
      // The key still flows (best-effort), just into the default tenant...
      expect(c.agentIdentity?.registrarKey).toBe("zid_sk_badge");
      expect(c.agentIdentity?.accountId).toBe("personal");
      // ...and the misconfiguration is surfaced.
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain("ZEROID_REGISTRAR_KEY");
    } finally {
      warn.mockRestore();
    }
  });

  it("does NOT warn when the registrar key comes with an explicit tenant", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      loadConfig({
        configPath,
        env: {
          ZEROID_REGISTRAR_KEY: "zid_sk_badge",
          ZEROID_ACCOUNT_ID: "acme",
          ZEROID_PROJECT_ID: "prod",
        },
      });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("loadConfig — env precedence", () => {
  it("env overrides file on every field type", () => {
    writeConfig({
      daemonUrl: "ws://file",
      compress: { enabled: false, minBytes: 100, excludeCommands: ["a"] },
    });
    const c = loadConfig({
      configPath,
      env: {
        CODEOID_DAEMON_URL: "ws://env",
        CODEOID_COMPRESS: "1",
        CODEOID_COMPRESS_MIN_BYTES: "4096",
        CODEOID_COMPRESS_EXCLUDE: "curl, wget ,playwright",
      },
    });
    expect(c.daemonUrl).toBe("ws://env");
    expect(c.compress.enabled).toBe(true);
    expect(c.compress.minBytes).toBe(4096);
    // CSV parsing trims whitespace and drops empties.
    expect(c.compress.excludeCommands).toEqual(["curl", "wget", "playwright"]);
  });

  it("boolean env accepts 1/true, ignores empty", () => {
    writeConfig({ memory: { enabled: true } });
    const c1 = loadConfig({ configPath, env: { CODEOID_MEMORY: "1" } });
    expect(c1.memory?.enabled).toBe(true);

    const c2 = loadConfig({ configPath, env: { CODEOID_MEMORY: "true" } });
    expect(c2.memory?.enabled).toBe(true);

    const c3 = loadConfig({ configPath, env: { CODEOID_MEMORY: "0" } });
    expect(c3.memory?.enabled).toBe(false);

    // Empty string = no override — file value wins.
    const c4 = loadConfig({ configPath, env: { CODEOID_MEMORY: "" } });
    expect(c4.memory?.enabled).toBe(true);
  });

  it("ANTHROPIC_API_KEY flows into labeling", () => {
    const c = loadConfig({
      configPath,
      env: { ANTHROPIC_API_KEY: "sk-ant-test" },
    });
    expect(c.labeling.anthropicApiKey).toBe("sk-ant-test");
  });

  it("int env rejects non-numeric", () => {
    expect(() =>
      loadConfig({
        configPath,
        env: { CODEOID_COMPRESS_MIN_BYTES: "notanumber" },
      }),
    ).toThrow(/Expected integer/);
  });

  it("attachTailBytes: defaults to 512 KiB, honors config, rejects sub-1KiB", () => {
    const { writeFileSync } = require("node:fs") as typeof import("node:fs");
    expect(loadConfig({ configPath }).session.attachTailBytes).toBe(512 * 1024);

    writeFileSync(configPath, JSON.stringify({ session: { attachTailBytes: 32768 } }));
    expect(loadConfig({ configPath }).session.attachTailBytes).toBe(32768);

    // A window smaller than one message is a footgun — schema floor 1 KiB.
    writeFileSync(configPath, JSON.stringify({ session: { attachTailBytes: 16 } }));
    expect(() => loadConfig({ configPath })).toThrow();
  });

  it("CODEOID_TURN_STALL_TIMEOUT_MS overrides the stall watchdog timeout", () => {
    // 200000 stays above the 120000 MCP-timeout default so the cross-field
    // ordering refinement is satisfied.
    const c = loadConfig({
      configPath,
      env: { CODEOID_TURN_STALL_TIMEOUT_MS: "200000" },
    });
    expect(c.session.turnStallTimeoutMs).toBe(200000);
  });

  it("rejects a negative stall timeout (env override is re-validated, not just coerced)", () => {
    // Regression: env overrides are applied AFTER the initial safeParse, so a
    // negative value would otherwise bypass z.number().min(0) and silently
    // disable the stall watchdog (stallMs > 0 guard reads false).
    expect(() =>
      loadConfig({
        configPath,
        env: { CODEOID_TURN_STALL_TIMEOUT_MS: "-1" },
      }),
    ).toThrow(/environment overrides|turnStallTimeoutMs/);
  });

  it("defaults mcpToolTimeoutMs below turnStallTimeoutMs so the SDK signals first", () => {
    const c = loadConfig({ configPath, env: {} });
    expect(c.session.mcpToolTimeoutMs).toBe(120000);
    expect(c.session.mcpToolTimeoutMs!).toBeLessThan(c.session.turnStallTimeoutMs!);
  });

  it("CODEOID_MCP_TOOL_TIMEOUT_MS overrides the MCP tool timeout", () => {
    const c = loadConfig({
      configPath,
      env: { CODEOID_MCP_TOOL_TIMEOUT_MS: "30000" },
    });
    expect(c.session.mcpToolTimeoutMs).toBe(30000);
  });

  it("rejects an override pair where the MCP timeout is not below the stall timeout", () => {
    // 400000 (MCP) >= 300000 (default stall) would let the coarse watchdog fire
    // before the SDK's clean per-tool error — the cross-field refinement catches
    // it even though each value is individually valid.
    expect(() =>
      loadConfig({
        configPath,
        env: { CODEOID_MCP_TOOL_TIMEOUT_MS: "400000" },
      }),
    ).toThrow(/mcpToolTimeoutMs|turnStallTimeoutMs/);
  });

  it("allows MCP >= stall when the watchdog is disabled (turnStallTimeoutMs=0)", () => {
    const c = loadConfig({
      configPath,
      env: {
        CODEOID_TURN_STALL_TIMEOUT_MS: "0",
        CODEOID_MCP_TOOL_TIMEOUT_MS: "400000",
      },
    });
    expect(c.session.turnStallTimeoutMs).toBe(0);
    expect(c.session.mcpToolTimeoutMs).toBe(400000);
  });
});

describe("loadConfig — path resolution", () => {
  it("expands ~ in file paths", () => {
    writeConfig({ memory: { dbPath: "~/custom.db" } });
    const c = loadConfig({ configPath, env: {} });
    expect(c.memory?.dbPath.startsWith("/")).toBe(true);
    expect(c.memory?.dbPath.endsWith("custom.db")).toBe(true);
    expect(c.memory?.dbPath.includes("~")).toBe(false);
  });

  it("resolves relative paths against the config dir", () => {
    writeConfig({ dbPath: "codeoid.db" });
    const c = loadConfig({ configPath, env: {} });
    expect(c.dbPath).toMatch(/codeoid\.db$/);
    // Resolved to an absolute path.
    expect(c.dbPath.startsWith("/")).toBe(true);
  });

  it("preserves absolute paths verbatim", () => {
    writeConfig({ dbPath: "/tmp/explicit.db" });
    const c = loadConfig({ configPath, env: {} });
    expect(c.dbPath).toBe("/tmp/explicit.db");
  });
});

describe("loadConfig — failure modes", () => {
  it("loud-fails on malformed JSON", () => {
    writeFileSync(configPath, "{ not valid json");
    expect(() => loadConfig({ configPath, env: {} })).toThrow(/Failed to parse/);
  });

  it("loud-fails on schema violation", () => {
    writeConfig({ compress: { minBytes: -1 } }); // zod: nonnegative
    expect(() => loadConfig({ configPath, env: {} })).toThrow(/Invalid config/);
  });

  it("no file present — succeeds with defaults", () => {
    const c = loadConfig({ configPath: join(tmp, "missing.json"), env: {} });
    expect(c.compress.enabled).toBe(false);
  });
});

describe("loadConfig — collaboration.maxLiveChildren", () => {
  it("defaults to two full-size fleets", () => {
    const c = loadConfig({ configPath, env: {} });
    expect(c.collaboration?.maxLiveChildren).toBe(24);
  });

  it("accepts 0 (unlimited) and any value at or above the per-goal cap", () => {
    for (const n of [0, 12, 13, 100]) {
      writeConfig({ collaboration: { maxLiveChildren: n } });
      expect(loadConfig({ configPath, env: {} }).collaboration?.maxLiveChildren).toBe(n);
    }
  });

  it("loud-fails between 1 and 11, where it would contradict the per-goal cap", () => {
    // A tenant cap below MAX_COLLABORATION_CHILDREN (12) would reject a single
    // collaboration that planChildren explicitly permits — two bounds
    // disagreeing, with the user told "max 12" by one and "over the limit" by
    // the other. Refuse the config instead of shipping the contradiction.
    for (const n of [1, 6, 11]) {
      writeConfig({ collaboration: { maxLiveChildren: n } });
      expect(() => loadConfig({ configPath, env: {} })).toThrow(/Invalid config/);
    }
  });

  it("loud-fails on a negative value", () => {
    writeConfig({ collaboration: { maxLiveChildren: -1 } });
    expect(() => loadConfig({ configPath, env: {} })).toThrow(/Invalid config/);
  });
});

describe("resolveZeroidUrl", () => {
  it("maps known preset names to their URLs", () => {
    expect(resolveZeroidUrl("highflame")).toBe("https://auth.highflame.ai");
    expect(resolveZeroidUrl("highflame-dev")).toBe("https://auth-dev.highflame.dev");
    expect(resolveZeroidUrl("local")).toBe("http://localhost:8899");
  });

  it("passes through a full URL verbatim (trimming trailing slashes)", () => {
    expect(resolveZeroidUrl("https://zeroid.acme.com")).toBe("https://zeroid.acme.com");
    expect(resolveZeroidUrl("https://zeroid.acme.com/")).toBe("https://zeroid.acme.com");
    expect(resolveZeroidUrl("  http://10.0.0.1:8899  ")).toBe("http://10.0.0.1:8899");
  });

  it("assumes https:// for a bare host", () => {
    expect(resolveZeroidUrl("zeroid.acme.com")).toBe("https://zeroid.acme.com");
  });
});

describe("loadConfig — issuer presets + iss pinning", () => {
  it("resolves a preset name in the file to its URL and pins the issuer", () => {
    writeConfig({ zeroidUrl: "highflame-dev" });
    const c = loadConfig({ configPath, env: {} });
    expect(c.zeroidUrl).toBe("https://auth-dev.highflame.dev");
    expect(c.auth.baseUrl).toBe("https://auth-dev.highflame.dev");
    expect(c.auth.issuer).toBe("https://auth-dev.highflame.dev");
  });

  it("ZEROID_URL env (preset or URL) overrides the file", () => {
    writeConfig({ zeroidUrl: "highflame" });
    const c = loadConfig({ configPath, env: { ZEROID_URL: "local" } });
    expect(c.zeroidUrl).toBe("http://localhost:8899");
    expect(c.auth.issuer).toBe("http://localhost:8899");
  });

  it("an explicit issuer is NOT overwritten by the base-URL pin", () => {
    writeConfig({ zeroidUrl: "https://zeroid.acme.com", auth: { issuer: "https://id.acme.com" } });
    const c = loadConfig({ configPath, env: {} });
    expect(c.auth.baseUrl).toBe("https://zeroid.acme.com");
    expect(c.auth.issuer).toBe("https://id.acme.com");
  });

  it("ZEROID_ISSUER env overrides the pin", () => {
    writeConfig({ zeroidUrl: "highflame" });
    const c = loadConfig({ configPath, env: { ZEROID_ISSUER: "https://custom.issuer" } });
    expect(c.auth.issuer).toBe("https://custom.issuer");
  });
});

describe("loadConfig — oauth conditional", () => {
  it("populates oauth only when Google credentials are set", () => {
    const none = loadConfig({ configPath, env: {} });
    expect(none.oauth).toBeUndefined();

    const viaEnv = loadConfig({
      configPath,
      env: {
        GOOGLE_CLIENT_ID: "client-id.apps.googleusercontent.com",
        GOOGLE_CLIENT_SECRET: "secret",
      },
    });
    expect(viaEnv.oauth).toBeDefined();
    expect(viaEnv.oauth?.zeroidTokenEndpoint).toContain("/oauth2/token");
    expect(viaEnv.oauth?.clientId).toBe("codeoid");
  });
});

describe("loadConfig — workspace index tunables", () => {
  it("exposes regen thresholds as top-level knobs", () => {
    writeConfig({
      workspaceIndex: {
        enabled: true,
        episodeThreshold: 10,
        timeThresholdMs: 30000,
        debounceMs: 5000,
      },
    });
    const c = loadConfig({ configPath, env: {} });
    expect(c.workspaceIndex.episodeThreshold).toBe(10);
    expect(c.workspaceIndex.timeThresholdMs).toBe(30000);
    expect(c.workspaceIndex.debounceMs).toBe(5000);
  });

  it("env override beats file for regen knob", () => {
    writeConfig({ workspaceIndex: { episodeThreshold: 10 } });
    const c = loadConfig({
      configPath,
      env: { CODEOID_WORKSPACE_INDEX_EPISODE_THRESHOLD: "25" },
    });
    expect(c.workspaceIndex.episodeThreshold).toBe(25);
  });
});

describe("loadConfig — hooks", () => {
  it("defaults to enabled with no entries", () => {
    const c = loadConfig({ configPath, env: {} });
    expect(c.hooks).toEqual({ enabled: true, entries: [] });
  });

  it("parses configured hook entries", () => {
    writeConfig({
      hooks: {
        entries: [
          { event: "tool_call", matcher: "^Bash$", type: "command", command: "./guard.sh" },
          { event: "after_turn", type: "webhook", url: "https://example.com/hook", timeoutMs: 5000 },
        ],
      },
    });
    const c = loadConfig({ configPath, env: {} });
    expect(c.hooks?.enabled).toBe(true);
    expect(c.hooks?.entries).toHaveLength(2);
    expect(c.hooks?.entries[0]).toMatchObject({ event: "tool_call", type: "command", command: "./guard.sh" });
    expect(c.hooks?.entries[1]).toMatchObject({ event: "after_turn", type: "webhook", timeoutMs: 5000 });
  });

  it("CODEOID_PIPELINE_ENABLED=false opts out of the (default-on) pipeline runtime", () => {
    writeConfig({});
    const on = loadConfig({ configPath, env: {} });
    expect(on.pipeline?.enabled).toBe(true); // default
    const off = loadConfig({ configPath, env: { CODEOID_PIPELINE_ENABLED: "false" } });
    expect(off.pipeline?.enabled).toBe(false);
  });

  it("pipeline.modelTiers / modelRoles parse, default to {}, and reject a missing provider", () => {
    writeConfig({});
    const c = loadConfig({ configPath, env: {} });
    expect(c.pipeline?.modelTiers).toEqual({});
    expect(c.pipeline?.modelRoles).toEqual({});

    writeConfig({
      pipeline: {
        modelTiers: { "reasoning-max": { provider: "claude", model: "claude-fable-5" }, mechanical: { provider: "claude" } },
        modelRoles: { "yash-dev/navigator": { provider: "claude", model: "claude-fable-5" } },
      },
    });
    const filled = loadConfig({ configPath, env: {} });
    expect(filled.pipeline?.modelTiers?.["reasoning-max"]).toEqual({ provider: "claude", model: "claude-fable-5" });
    expect(filled.pipeline?.modelTiers?.mechanical).toEqual({ provider: "claude" });
    expect(filled.pipeline?.modelRoles?.["yash-dev/navigator"]).toMatchObject({ model: "claude-fable-5" });

    // A binding names a provider or it isn't a binding — model-only rejects.
    writeConfig({ pipeline: { modelTiers: { broken: { model: "m" } } } });
    expect(() => loadConfig({ configPath, env: {} })).toThrow(/provider/);
  });

  it("CODEOID_HOOKS_ENABLED=false kills every hook per-invocation", () => {
    writeConfig({
      hooks: {
        entries: [{ event: "tool_call", type: "command", command: "./guard.sh" }],
      },
    });
    const c = loadConfig({ configPath, env: { CODEOID_HOOKS_ENABLED: "false" } });
    expect(c.hooks?.enabled).toBe(false);
    expect(c.hooks?.entries).toHaveLength(1); // entries survive; the kill switch gates them
  });

  it("rejects a command hook without a command, a webhook without a url, and a bad matcher", () => {
    writeConfig({ hooks: { entries: [{ event: "tool_call", type: "command" }] } });
    expect(() => loadConfig({ configPath, env: {} })).toThrow(/command/);

    writeConfig({ hooks: { entries: [{ event: "tool_call", type: "webhook" }] } });
    expect(() => loadConfig({ configPath, env: {} })).toThrow(/url/);

    writeConfig({
      hooks: {
        entries: [{ event: "tool_call", type: "command", command: "x", matcher: "([unclosed" }],
      },
    });
    expect(() => loadConfig({ configPath, env: {} })).toThrow(/regular expression/);
  });

  it("rejects an unknown hook event and an out-of-range timeout", () => {
    writeConfig({ hooks: { entries: [{ event: "not_a_seam", type: "command", command: "x" }] } });
    expect(() => loadConfig({ configPath, env: {} })).toThrow();

    writeConfig({
      hooks: { entries: [{ event: "tool_call", type: "command", command: "x", timeoutMs: 120_000 }] },
    });
    expect(() => loadConfig({ configPath, env: {} })).toThrow();
  });
});

describe("loadConfig — mcpServers registry", () => {
  it("parses stdio + http servers and applies trust/scope/native defaults", () => {
    writeConfig({
      mcpServers: {
        github: { command: "npx", args: ["-y", "@mcp/github"], env: { TOKEN: "${GH_PAT}" } },
        linear: { url: "https://mcp.linear.app/mcp", bearerTokenEnv: "LINEAR_KEY", trust: "readonly", scope: "session" },
      },
    });
    const c = loadConfig({ configPath, env: {} });
    expect(c.mcpServers?.github).toMatchObject({ command: "npx", args: ["-y", "@mcp/github"], trust: "prompt", scope: "workspace", native: false });
    expect(c.mcpServers?.linear).toMatchObject({ url: "https://mcp.linear.app/mcp", bearerTokenEnv: "LINEAR_KEY", trust: "readonly", scope: "session" });
  });

  it("rejects a server that sets neither command nor url", () => {
    writeConfig({ mcpServers: { bad: { trust: "readonly" } } });
    expect(() => loadConfig({ configPath, env: {} })).toThrow();
  });

  it("rejects a server that sets BOTH command and url", () => {
    writeConfig({ mcpServers: { bad: { command: "x", url: "https://y/mcp" } } });
    expect(() => loadConfig({ configPath, env: {} })).toThrow();
  });

  it("defaults to an empty registry when omitted", () => {
    writeConfig({});
    expect(loadConfig({ configPath, env: {} }).mcpServers).toEqual({});
  });
});

describe("resolveLocalToken — client-side local-mode discovery", () => {
  // Precedence exists so `codeoid start --local` + `codeoid tui` needs zero
  // setup, AND so someone who ran --local once for a demo isn't stuck: the
  // published file is removed when that daemon shuts down, so it only outranks
  // a durable apiKey while a local daemon is actually listening.
  const XDG = "XDG_CONFIG_HOME";
  const URL_A = "ws://127.0.0.1:7400";
  const URL_B = "ws://127.0.0.1:7401";
  let prevXdg: string | undefined;

  beforeEach(() => {
    prevXdg = process.env[XDG];
    process.env[XDG] = tmp; // getConfigDir() → <tmp>/codeoid
  });
  afterEach(() => {
    if (prevXdg === undefined) delete process.env[XDG];
    else process.env[XDG] = prevXdg;
  });

  it("is null when no local daemon has published a token", () => {
    expect(resolveLocalToken(URL_A, {})).toBeNull();
  });

  it("reads the token a local daemon published for that port", () => {
    const token = mintLocalToken();
    writeLocalTokenFile(getLocalTokenPath(7400), token);
    expect(resolveLocalToken(URL_A, {})).toBe(token);
  });

  it("prefers CODEOID_LOCAL_TOKEN over the published file", () => {
    writeLocalTokenFile(getLocalTokenPath(7400), mintLocalToken());
    expect(resolveLocalToken(URL_A, { CODEOID_LOCAL_TOKEN: "codeoid_local_pinned" })).toBe(
      "codeoid_local_pinned",
    );
  });

  it("ignores an empty env override", () => {
    const token = mintLocalToken();
    writeLocalTokenFile(getLocalTokenPath(7400), token);
    expect(resolveLocalToken(URL_A, { CODEOID_LOCAL_TOKEN: "" })).toBe(token);
  });

  it("goes back to null once the daemon removes its token on shutdown", () => {
    const path = getLocalTokenPath(7400);
    writeLocalTokenFile(path, mintLocalToken());
    removeLocalTokenFile(path);
    // This is what makes the precedence safe: no lingering credential means a
    // ZeroID client is never hijacked by a stale local token.
    expect(resolveLocalToken(URL_A, {})).toBeNull();
  });

  it("honours XDG_CONFIG_HOME for the token path", () => {
    expect(getLocalTokenPath(7400)).toBe(join(tmp, "codeoid", "local-token-7400"));
  });

  // ── The multi-daemon regression ───────────────────────────────────────────
  // Both halves of this were REPRODUCED against a single global `local-token`
  // file: daemon B's startup overwrote daemon A's token (A's clients got a bare
  // 4003), and B's shutdown deleted the file outright (A's clients then got "No
  // API key configured" while A was still happily listening). Port-scoping is
  // what fixes it, so these lock it down.

  it("keeps two local daemons' tokens separate", () => {
    const tokenA = mintLocalToken();
    const tokenB = mintLocalToken();
    writeLocalTokenFile(getLocalTokenPath(7400), tokenA);
    writeLocalTokenFile(getLocalTokenPath(7401), tokenB);

    expect(getLocalTokenPath(7400)).not.toBe(getLocalTokenPath(7401));
    expect(resolveLocalToken(URL_A, {})).toBe(tokenA);
    expect(resolveLocalToken(URL_B, {})).toBe(tokenB);
  });

  it("one daemon's shutdown does not invalidate another's clients", () => {
    const tokenA = mintLocalToken();
    writeLocalTokenFile(getLocalTokenPath(7400), tokenA);
    writeLocalTokenFile(getLocalTokenPath(7401), mintLocalToken());

    removeLocalTokenFile(getLocalTokenPath(7401)); // daemon B stops
    expect(resolveLocalToken(URL_A, {})).toBe(tokenA); // A unaffected
    expect(resolveLocalToken(URL_B, {})).toBeNull();
  });

  it("does not hand a token to a client dialing a different port", () => {
    writeLocalTokenFile(getLocalTokenPath(7400), mintLocalToken());
    expect(resolveLocalToken(URL_B, {})).toBeNull();
  });
});

describe("daemonPortFromUrl", () => {
  it("reads the explicit port", () => {
    expect(daemonPortFromUrl("ws://127.0.0.1:7411")).toBe("7411");
    expect(daemonPortFromUrl("wss://host.example:8443/path")).toBe("8443");
  });

  it("falls back to codeoid's default when the URL omits one", () => {
    // Matches what the connection itself would do.
    expect(daemonPortFromUrl("ws://127.0.0.1")).toBe("7400");
  });

  it("returns null for an unparseable URL rather than guessing", () => {
    expect(daemonPortFromUrl("not a url")).toBeNull();
    expect(daemonPortFromUrl("")).toBeNull();
  });
});
