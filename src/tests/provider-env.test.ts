/**
 * Subprocess env allowlists (GHSA-38vh vector 3) — the daemon's own
 * secrets must never reach an agent subprocess, while each provider's
 * credentials must pass through.
 */

import { describe, expect, it } from "bun:test";
import { buildPiEnv, buildSubprocessEnv, withGatewayCredential } from "../daemon/providers/env.js";
import { buildAgentEnv } from "../daemon/providers/claude/index.js";

const DAEMON_ENV: Record<string, string> = {
  // Safe basics that must survive for any provider.
  PATH: "/usr/bin",
  HOME: "/home/u",
  TERM: "xterm",
  HTTPS_PROXY: "http://proxy:3128",
  // codeoid's own secrets — must NEVER reach a subprocess.
  CODEOID_ZEROID_API_KEY: "zid_sk_root",
  TELEGRAM_BOT_TOKEN: "tg-secret",
  CODEOID_OAUTH_HMAC: "hmac-secret",
  DATABASE_URL: "postgres://secret",
  // Provider credentials.
  ANTHROPIC_API_KEY: "ant-key",
  OPENAI_API_KEY: "oai-key",
  GEMINI_API_KEY: "gem-key",
  GROQ_API_KEY: "groq-key",
  MISTRAL_API_TOKEN: "mst-token",
  PI_CONFIG_DIR: "/home/u/.pi-alt",
  CLAUDE_CODE_FLAG: "1",
  AWS_SECRET_ACCESS_KEY: "aws-secret",
};

describe("buildSubprocessEnv", () => {
  it("passes shared basics and drops everything unlisted", () => {
    const env = buildSubprocessEnv({}, DAEMON_ENV);
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/u");
    expect(env.HTTPS_PROXY).toBe("http://proxy:3128");
    expect(env.CODEOID_ZEROID_API_KEY).toBeUndefined();
    expect(env.TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
  });

  it("honors the CODEOID_AGENT_ENV_ALLOW escape hatch", () => {
    const env = buildSubprocessEnv(
      {},
      { ...DAEMON_ENV, CODEOID_AGENT_ENV_ALLOW: "AWS_SECRET_ACCESS_KEY, DATABASE_URL" },
    );
    expect(env.AWS_SECRET_ACCESS_KEY).toBe("aws-secret");
    expect(env.DATABASE_URL).toBe("postgres://secret");
    expect(env.TELEGRAM_BOT_TOKEN).toBeUndefined();
  });
});

describe("buildPiEnv", () => {
  it("passes provider credentials by prefix and credential-suffix", () => {
    const env = buildPiEnv(DAEMON_ENV);
    expect(env.ANTHROPIC_API_KEY).toBe("ant-key");
    expect(env.OPENAI_API_KEY).toBe("oai-key");
    expect(env.GEMINI_API_KEY).toBe("gem-key");
    // Not a listed prefix, but matches the *_API_KEY credential shape.
    expect(env.GROQ_API_KEY).toBe("groq-key");
    expect(env.MISTRAL_API_TOKEN).toBe("mst-token");
    expect(env.PI_CONFIG_DIR).toBe("/home/u/.pi-alt");
  });

  it("still drops codeoid's own secrets and unlisted namespaces", () => {
    const env = buildPiEnv(DAEMON_ENV);
    expect(env.TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(env.CODEOID_OAUTH_HMAC).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
    // AWS (Bedrock) is escape-hatch-only by design.
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  });

  it("the daemon deny-list beats pattern matches: CODEOID_API_KEY never rides *_API_KEY", () => {
    // CODEOID_API_KEY is the ZeroID root key AND matches the credential
    // suffix — the exact GHSA-38vh escalation the deny-list exists for.
    const env = buildPiEnv({ ...DAEMON_ENV, CODEOID_API_KEY: "zid_sk_root" });
    expect(env.CODEOID_API_KEY).toBeUndefined();
    expect(env.CODEOID_ZEROID_API_KEY).toBeUndefined();
  });

  it("only the explicit operator escape hatch can override the deny-list", () => {
    const env = buildPiEnv({
      ...DAEMON_ENV,
      CODEOID_API_KEY: "zid_sk_root",
      CODEOID_AGENT_ENV_ALLOW: "CODEOID_API_KEY",
    });
    expect(env.CODEOID_API_KEY).toBe("zid_sk_root");
    // The hatch is exact-name — other daemon vars stay denied.
    expect(env.CODEOID_OAUTH_HMAC).toBeUndefined();
  });
});

describe("buildAgentEnv (claude) delegation", () => {
  it("keeps the historical allowlist behavior", () => {
    const env = buildAgentEnv(DAEMON_ENV);
    expect(env.ANTHROPIC_API_KEY).toBe("ant-key");
    expect(env.CLAUDE_CODE_FLAG).toBe("1");
    expect(env.PATH).toBe("/usr/bin");
    // pi/other-provider keys don't leak into the Claude subprocess.
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.GROQ_API_KEY).toBeUndefined();
    expect(env.TELEGRAM_BOT_TOKEN).toBeUndefined();
  });
});

/**
 * forge#111 — a sandbox sent the BADGE on gateway LLM calls, and the badge
 * holds no `tools:*`, so Shield denied every request before detectors or Cedar
 * ran. The per-session identity with the right scopes existed and went unused.
 */
describe("withGatewayCredential (forge#111)", () => {
  const SANDBOX_ENV: Record<string, string> = {
    ANTHROPIC_BASE_URL: "https://gateway.highflame.ai",
    ANTHROPIC_CUSTOM_HEADERS: "x-highflame-apikey: zid_sk_badge",
    ANTHROPIC_AUTH_TOKEN: "zid_sk_badge",
  };

  it("sends the session credential, not the badge", () => {
    const env = withGatewayCredential(SANDBOX_ENV, "zid_sk_session");
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toBe("x-highflame-apikey: zid_sk_session");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("zid_sk_session");
  });

  it("leaves a BYOK auth token alone", () => {
    // Forge sets ANTHROPIC_AUTH_TOKEN to the badge ONLY when the user brought
    // no key. A different value means it is the user's own credential, riding
    // through the gateway to the provider — swapping it for an agent identity
    // would break the launch mode it belongs to.
    const env = withGatewayCredential(
      { ...SANDBOX_ENV, ANTHROPIC_AUTH_TOKEN: "sk-ant-users-own-key" },
      "zid_sk_session",
    );
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toBe("x-highflame-apikey: zid_sk_session");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("sk-ant-users-own-key");
  });

  it("adds nothing when the launch is not gateway-routed", () => {
    // No x-highflame-apikey = a local run or direct-to-provider mode. This must
    // never CREATE a credential path that was not already there.
    const plain = { ANTHROPIC_API_KEY: "ant-key" };
    expect(withGatewayCredential(plain, "zid_sk_session")).toEqual(plain);
  });

  it("is a no-op without a session credential", () => {
    // Identity registration is best-effort; when it failed there is nothing
    // better to send, so the launch-time credential is left exactly as-is.
    expect(withGatewayCredential(SANDBOX_ENV, undefined)).toEqual(SANDBOX_ENV);
  });

  it("rewrites only the gateway header, and matches it case-insensitively", () => {
    const env = withGatewayCredential(
      {
        ANTHROPIC_CUSTOM_HEADERS: "X-Highflame-Apikey: zid_sk_badge\nX-Trace-Id: abc123",
        ANTHROPIC_AUTH_TOKEN: "zid_sk_badge",
      },
      "zid_sk_session",
    );
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toBe(
      "X-Highflame-Apikey: zid_sk_session\nX-Trace-Id: abc123",
    );
  });

  it("does not mutate the env it was given", () => {
    const original = { ...SANDBOX_ENV };
    withGatewayCredential(SANDBOX_ENV, "zid_sk_session");
    expect(SANDBOX_ENV).toEqual(original);
  });

  it("reaches the claude subprocess through buildAgentEnv", () => {
    const env = buildAgentEnv(
      { ...SANDBOX_ENV, PATH: "/usr/bin" },
      { gatewayCredential: "zid_sk_session" },
    );
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toBe("x-highflame-apikey: zid_sk_session");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("zid_sk_session");
  });
});
