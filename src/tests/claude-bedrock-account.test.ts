/**
 * Claude `bedrock` accounts: a Bedrock bearer token (AWS, or a
 * Bedrock-compatible endpoint) plus the settings that go with it — region,
 * model mappings, telemetry. What the account puts in the CLI's environment,
 * what it refuses, what a client sees, the project-settings check, the CLI's
 * parsers, and — against a local stand-in endpoint — what the real Claude CLI
 * then sends.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  applyAccountEnv,
  ClaudeAccountError,
  ClaudeAccountStore,
  isClaudeCredentialVar,
  projectCredentialOverride,
  type StoredClaudeAccount,
} from "../daemon/claude-accounts.js";
import { MockSessionProvider } from "../daemon/providers/mock/session-provider.js";
import { SessionManager } from "../daemon/session-manager.js";
import { Store } from "../daemon/store.js";
import { TranscriptStore } from "../daemon/transcript.js";
import { ALL_SCOPES } from "../protocol/scopes.js";
import { accountKindsFor, type AuthContext, type DaemonMessage } from "../protocol/types.js";
import { bedrockFromSettings, formatAccounts, parseSettingFlags } from "../terminal/claude-accounts.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codeoid-bedrock-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const storeAt = () => new ClaudeAccountStore(join(dir, "claude-accounts.json"));

const bedrock = (over: Partial<StoredClaudeAccount> = {}): StoredClaudeAccount => ({
  name: "br",
  kind: "bedrock",
  token: "br-token",
  createdAt: "",
  updatedAt: "",
  ...over,
});

describe("applyAccountEnv — bedrock", () => {
  const daemonEnv = {
    PATH: "/usr/bin",
    ANTHROPIC_API_KEY: "daemon-key",
    CLAUDE_CODE_OAUTH_TOKEN: "daemon-oauth",
    ANTHROPIC_BASE_URL: "https://daemon.example.com",
    AWS_BEARER_TOKEN_BEDROCK: "daemon-bedrock-token",
    ANTHROPIC_BEDROCK_BASE_URL: "https://daemon-bedrock.example.com",
    CLAUDE_CODE_SKIP_BEDROCK_AUTH: "1",
    AWS_ACCESS_KEY_ID: "AKIADAEMON",
    AWS_SECRET_ACCESS_KEY: "daemon-secret",
    AWS_PROFILE: "daemon-profile",
  };

  test("selects Bedrock with the account's token, endpoint and settings; drops every other credential", () => {
    const env = applyAccountEnv(
      daemonEnv,
      bedrock({
        baseUrl: "https://bedrock.example.com/v1",
        env: { AWS_REGION: "us-west-2", ANTHROPIC_DEFAULT_OPUS_MODEL: "us.anthropic.claude-opus-5-5[1m]", CLAUDE_CODE_SKIP_BEDROCK_AUTH: "1" },
      }),
    );
    expect(env).toMatchObject({
      CLAUDE_CODE_USE_BEDROCK: "1",
      AWS_BEARER_TOKEN_BEDROCK: "br-token",
      ANTHROPIC_BEDROCK_BASE_URL: "https://bedrock.example.com/v1",
      AWS_REGION: "us-west-2",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "us.anthropic.claude-opus-5-5[1m]",
      CLAUDE_CODE_SKIP_BEDROCK_AUTH: "1",
    });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    // The bearer token wins over AWS keys and profiles in the CLI, so the
    // daemon's stay for the agent's own tools.
    expect(env.AWS_ACCESS_KEY_ID).toBe("AKIADAEMON");
    expect(env.AWS_PROFILE).toBe("daemon-profile");
  });

  test("no endpoint means AWS itself — never the daemon's endpoint; no settings means none of the daemon's", () => {
    const env = applyAccountEnv(daemonEnv, bedrock());
    expect(env.ANTHROPIC_BEDROCK_BASE_URL).toBeUndefined();
    expect(env.CLAUDE_CODE_SKIP_BEDROCK_AUTH).toBeUndefined();
    expect(env.AWS_BEARER_TOKEN_BEDROCK).toBe("br-token");
  });

  test("other kinds drop the daemon's Bedrock token", () => {
    expect(isClaudeCredentialVar("AWS_BEARER_TOKEN_BEDROCK")).toBe(true);
    const env = applyAccountEnv(daemonEnv, { name: "k", kind: "api-key", token: "sk-ant-api-X", createdAt: "", updatedAt: "" });
    expect(env.AWS_BEARER_TOKEN_BEDROCK).toBeUndefined();
    expect(env.ANTHROPIC_BEDROCK_BASE_URL).toBeUndefined();
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
  });
});

describe("validation", () => {
  test("token required; endpoint and settings optional", () => {
    const store = storeAt();
    expect(() => store.upsert({ name: "br", kind: "bedrock", token: "" })).toThrow(ClaudeAccountError);
    store.upsert({ name: "br", kind: "bedrock", token: "t" });
    expect(store.get("br")).toMatchObject({ kind: "bedrock", token: "t" });
    store.upsert({ name: "br2", kind: "bedrock", token: "t", env: {} });
    expect(store.get("br2")?.env).toBeUndefined();
  });

  test("the endpoint follows the gateway URL rules", () => {
    const store = storeAt();
    expect(() => store.upsert({ name: "br", kind: "bedrock", token: "t", baseUrl: "http://bedrock.example.com" })).toThrow(/https/);
    expect(() => store.upsert({ name: "br", kind: "bedrock", token: "t", baseUrl: "https://u:p@bedrock.example.com" })).toThrow(/credentials/);
    expect(() => store.upsert({ name: "br", kind: "bedrock", token: "t", baseUrl: "https://bedrock.example.com/?k=v" })).toThrow(/query/);
    store.upsert({ name: "br", kind: "bedrock", token: "t", baseUrl: "http://localhost:8080/v1" });
  });

  test("only Bedrock settings, single-line values; no headers; other kinds take no settings", () => {
    const store = storeAt();
    expect(() => store.upsert({ name: "br", kind: "bedrock", token: "t", env: { ANTHROPIC_API_KEY: "x" } })).toThrow(/not a key/);
    expect(() => store.upsert({ name: "br", kind: "bedrock", token: "t", env: { CLAUDE_CODE_USE_VERTEX: "1" } })).toThrow(/not a key/);
    expect(() => store.upsert({ name: "br", kind: "bedrock", token: "t", env: { AWS_REGION: "us\nx" } })).toThrow(/single/);
    expect(() => store.upsert({ name: "br", kind: "bedrock", token: "t", headers: { "x-a": "1" } })).toThrow(/headers/);
    expect(() => store.upsert({ name: "k", kind: "api-key", token: "t", env: { AWS_REGION: "us-east-1" } })).toThrow(/no settings/);
  });

  test("telemetry headers only go to an https (or local) telemetry endpoint", () => {
    const store = storeAt();
    const env = (endpoint: string) => ({ OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer x", OTEL_EXPORTER_OTLP_ENDPOINT: endpoint });
    expect(() => store.upsert({ name: "br", kind: "bedrock", token: "t", env: env("http://otel.example.com") })).toThrow(/telemetry endpoint/);
    store.upsert({ name: "br", kind: "bedrock", token: "t", env: env("https://otel.example.com") });
    store.upsert({ name: "br2", kind: "bedrock", token: "t", env: env("http://localhost:4318") });
    // Without headers there's nothing to protect.
    store.upsert({ name: "br3", kind: "bedrock", token: "t", env: { OTEL_EXPORTER_OTLP_ENDPOINT: "http://otel.example.com" } });
  });

  test("the kind descriptor: token required, endpoint and settings optional, only the telemetry headers secret", () => {
    const k = accountKindsFor("claude").find((x) => x.kind === "bedrock")!;
    expect(k.token?.required).toBe(true);
    expect(k.baseUrl?.required).toBe(false);
    expect(k.env).toMatchObject({ label: "Settings", required: false, secret: ["OTEL_EXPORTER_OTLP_HEADERS"] });
    expect(k.env?.names).not.toContain("CLAUDE_CODE_USE_BEDROCK");
    expect(k.env?.names).not.toContain("AWS_BEARER_TOKEN_BEDROCK");
  });
});

describe("daemon surface", () => {
  const AUTH: AuthContext = {
    sub: "user:bedrock",
    scopes: [...ALL_SCOPES] as AuthContext["scopes"],
    delegationDepth: 0,
    accountId: "acc",
    projectId: "proj",
  };
  let store: Store;
  let transcript: TranscriptStore;
  let accounts: ClaudeAccountStore;
  let manager: SessionManager;
  beforeEach(() => {
    store = new Store(join(dir, "codeoid.db"));
    transcript = new TranscriptStore(join(dir, "transcripts"));
    accounts = storeAt();
    manager = new SessionManager(store, transcript, undefined, undefined, undefined, {
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
  const handle = (msg: Parameters<SessionManager["handle"]>[0]) =>
    manager.handle(msg, AUTH, { id: "c", auth: AUTH, send: () => {} }) as Promise<DaemonMessage & Record<string, unknown>>;

  test("accounts.set stores the token and settings; clients see the setting names, never a value", async () => {
    const set = await handle({
      type: "accounts.set",
      id: "s",
      backend: "claude",
      name: "br",
      kind: "bedrock",
      token: "br-token-WIRE",
      baseUrl: "https://bedrock.example.com",
      env: { AWS_REGION: "eu-west-1", OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer otel-WIRE" },
    });
    expect(set.type).toBe("accounts.result");
    const wire = JSON.stringify(set);
    expect(wire).not.toContain("br-token-WIRE");
    expect(wire).not.toContain("otel-WIRE");
    expect(wire).not.toContain("eu-west-1");
    const claude = (set as { backends: Array<{ backend: string; accounts: Array<{ name: string; envNames?: string[] }> }> }).backends.find(
      (b) => b.backend === "claude",
    )!;
    expect(claude.accounts.find((a) => a.name === "br")).toMatchObject({
      kind: "bedrock",
      baseUrl: "https://bedrock.example.com",
      envNames: ["AWS_REGION", "OTEL_EXPORTER_OTLP_HEADERS"],
    });
    // What a session on it runs with.
    const env = accounts.resolve("br")!.apply({ PATH: "/usr/bin" });
    expect(env).toMatchObject({ CLAUDE_CODE_USE_BEDROCK: "1", AWS_BEARER_TOKEN_BEDROCK: "br-token-WIRE", AWS_REGION: "eu-west-1" });
    // The terminal list shows names only.
    const listed = formatAccounts((set as unknown as { backends: Parameters<typeof formatAccounts>[0] }).backends);
    expect(listed).toContain("Amazon Bedrock");
    expect(listed).toContain("settings: AWS_REGION, OTEL_EXPORTER_OTLP_HEADERS");
    expect(listed).not.toContain("otel-WIRE");
  });

  test("a changed setting is a changed credential: sessions on the account pick it up", () => {
    accounts.upsert({ name: "br", kind: "bedrock", token: "t", env: { ANTHROPIC_DEFAULT_SONNET_MODEL: "a" } });
    const before = accounts.resolve("br")!.fingerprint;
    accounts.upsert({ name: "br", kind: "bedrock", token: "t", env: { ANTHROPIC_DEFAULT_SONNET_MODEL: "b" } });
    expect(accounts.resolve("br")!.fingerprint).not.toBe(before);
  });
});

describe("project settings that would redirect a Bedrock account", () => {
  const settingsWith = (env: Record<string, string>) => {
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(join(dir, ".claude", "settings.json"), JSON.stringify({ env }));
  };
  for (const key of [
    "ANTHROPIC_BEDROCK_BASE_URL",
    "AWS_BEARER_TOKEN_BEDROCK",
    "CLAUDE_CODE_USE_BEDROCK",
    "AWS_ENDPOINT_URL",
    "AWS_ENDPOINT_URL_BEDROCK_RUNTIME",
    "AWS_CA_BUNDLE",
    "OTEL_EXPORTER_OTLP_ENDPOINT",
    "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
    "OTEL_EXPORTER_OTLP_HEADERS",
  ]) {
    test(`refused: env.${key}`, () => {
      settingsWith({ [key]: "https://repo.example.com" });
      expect(projectCredentialOverride(dir)?.key).toBe(`env.${key}`);
    });
  }
  test("allowed: region and model mappings", () => {
    settingsWith({ AWS_REGION: "us-east-1", ANTHROPIC_DEFAULT_OPUS_MODEL: "us.anthropic.claude-opus-5-5" });
    expect(projectCredentialOverride(dir)).toBeNull();
  });
});

describe("CLI parsers", () => {
  test("--set: NAME=value, or a bare NAME asked for; only Bedrock settings", () => {
    expect(parseSettingFlags(["AWS_REGION=us-east-1", "OTEL_EXPORTER_OTLP_HEADERS", "ANTHROPIC_MODEL = opus "])).toEqual({
      env: { AWS_REGION: "us-east-1", ANTHROPIC_MODEL: "opus" },
      ask: ["OTEL_EXPORTER_OTLP_HEADERS"],
    });
    expect(() => parseSettingFlags(["ANTHROPIC_API_KEY=x"])).toThrow(/--set/);
    expect(() => parseSettingFlags(["=x"])).toThrow(/--set/);
  });

  test("--from-settings: takes a Claude settings file's Bedrock setup and names what it leaves", () => {
    const out = bedrockFromSettings({
      env: {
        CLAUDE_CODE_USE_BEDROCK: "1",
        AWS_BEARER_TOKEN_BEDROCK: "tok",
        ANTHROPIC_BEDROCK_BASE_URL: "https://bedrock.example.com/v1",
        AWS_REGION: "us-east-1",
        ANTHROPIC_DEFAULT_HAIKU_MODEL: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
        DISABLE_TELEMETRY: "1",
        EMPTY: "",
      },
      extraKnownMarketplaces: {},
    });
    expect(out).toEqual({
      token: "tok",
      baseUrl: "https://bedrock.example.com/v1",
      env: { AWS_REGION: "us-east-1", ANTHROPIC_DEFAULT_HAIKU_MODEL: "us.anthropic.claude-haiku-4-5-20251001-v1:0" },
      ignored: ["DISABLE_TELEMETRY"],
    });
    expect(() => bedrockFromSettings({ env: { ANTHROPIC_MODEL: "opus" } })).toThrow(/doesn't set up Bedrock/);
    expect(() => bedrockFromSettings({})).toThrow(/no env block/);
  });
});

// The real Claude CLI against a stand-in Bedrock-compatible endpoint: the
// account's environment is enough for it to send the bearer token, to the
// account's endpoint, for the model ID the alias is mapped to.
const CLI = resolve(import.meta.dir, "../../node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude");
describe.skipIf(process.platform !== "linux" || process.arch !== "x64" || !existsSync(CLI))("the Claude CLI on a bedrock account", () => {
  test("sends the bearer token to the account's endpoint, for the mapped model", async () => {
    const seen: string[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const u = new URL(req.url);
        seen.push(`${req.method} ${decodeURIComponent(u.pathname)} ${req.headers.get("authorization") ?? "-"} sigv4=${req.headers.has("x-amz-date")}`);
        return new Response(JSON.stringify({ message: "stand-in" }), { status: 400, headers: { "content-type": "application/json" } });
      },
    });
    try {
      const home = join(dir, "home");
      mkdirSync(home);
      const env = applyAccountEnv(
        // A daemon with its own credentials, all of which must lose.
        { PATH: process.env.PATH ?? "/usr/bin", HOME: home, ANTHROPIC_API_KEY: "daemon-key", AWS_ACCESS_KEY_ID: "AKIADAEMON", AWS_SECRET_ACCESS_KEY: "s" },
        bedrock({
          baseUrl: `http://127.0.0.1:${server.port}/gw/v1`,
          env: { AWS_REGION: "us-east-1", ANTHROPIC_DEFAULT_SONNET_MODEL: "us.anthropic.claude-sonnet-5-5" },
        }),
      );
      await new Promise<void>((done) => {
        const child = spawn(CLI, ["-p", "hi", "--model", "sonnet"], { env, stdio: "ignore" });
        const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
        child.on("exit", () => {
          clearTimeout(timer);
          done();
        });
      });
      const invoke = seen.find((s) => s.includes("us.anthropic.claude-sonnet-5-5"));
      expect(invoke).toBeDefined();
      expect(invoke).toStartWith("POST /gw/v1/model/us.anthropic.claude-sonnet-5-5/");
      expect(invoke).toContain("Bearer br-token sigv4=false");
      expect(seen.join("\n")).not.toContain("daemon-key");
    } finally {
      server.stop(true);
    }
  }, 90_000);
});
