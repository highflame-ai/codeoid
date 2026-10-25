/**
 * classifyUsageLimit — the real message shapes each backend emits for a usage
 * or rate limit (sources cited in usage-limit.ts), and the ordinary errors that
 * must NOT be mistaken for one.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CLAUDE_USAGE_LIMIT_PREFIXES, classifyUsageLimit } from "../daemon/providers/usage-limit.js";

// 2026-10-25 12:00 UTC — 05:00 in Los Angeles (PDT, UTC-7: DST ends Nov 1).
const NOW = Date.UTC(2026, 9, 25, 12, 0);
const at = (input: unknown) => classifyUsageLimit(input, { now: NOW });

describe("classifyUsageLimit — usage limits", () => {
  test("Claude legacy `Claude AI usage limit reached|<epoch seconds>`", () => {
    const resetSec = Math.floor(NOW / 1000) + 3600;
    expect(at(`Claude AI usage limit reached|${resetSec}`)).toEqual({ kind: "usage_limit", resetAt: resetSec * 1000, provider: "claude" });
  });

  test("Claude Code: You've hit your session limit · resets 3pm (America/Los_Angeles)", () => {
    expect(at("You've hit your session limit · resets 3pm (America/Los_Angeles)")).toEqual({
      kind: "usage_limit",
      resetAt: Date.UTC(2026, 9, 25, 22, 0),
    });
  });

  test("Claude Code: weekly limit with a date and a minute, typographic apostrophe", () => {
    expect(at("You’ve hit your weekly limit · resets Oct 28, 9:30am (UTC)")?.resetAt).toBe(Date.UTC(2026, 9, 28, 9, 30));
  });

  test("a bare time already past today resets tomorrow", () => {
    // 4am UTC is 8 hours before NOW.
    expect(at("You've hit your Opus limit · resets 4am (UTC)")?.resetAt).toBe(Date.UTC(2026, 9, 26, 4, 0));
  });

  test("older CLI form: 5-hour limit reached ∙ resets 3pm (host time zone)", () => {
    const r = at("5-hour limit reached ∙ resets 3pm");
    expect(r?.kind).toBe("usage_limit");
    expect(new Date(r!.resetAt!).getHours()).toBe(15);
  });

  test("Claude org / seat usage messages", () => {
    expect(at("Your org is out of usage · add funds to continue")?.kind).toBe("usage_limit");
    expect(at("You're out of extra usage")?.kind).toBe("usage_limit");
    expect(at("You've hit your monthly spend limit.")?.kind).toBe("usage_limit");
  });

  test("Codex: You've hit your usage limit … try again at 3:30 PM (local time)", () => {
    const r = at(
      "codex: You've hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus), or try again at 3:30 PM.",
    );
    expect(r?.kind).toBe("usage_limit");
    expect(r?.provider).toBe("codex");
    const d = new Date(r!.resetAt!);
    expect([d.getHours(), d.getMinutes()]).toEqual([15, 30]);
  });

  test("Codex: a reset on another day", () => {
    const r = at("You've hit your usage limit. To get more access now, send a request to your admin or try again at Oct 28th, 2026 3:30 PM.");
    expect(r?.kind).toBe("usage_limit");
    expect(r?.resetAt).toBe(new Date(2026, 9, 28, 15, 30).getTime());
  });

  test("Codex structured error info", () => {
    expect(at({ message: "turn failed", codexErrorInfo: "usageLimitExceeded" })).toEqual({ kind: "usage_limit", provider: "codex" });
  });

  test("gemini-cli TerminalQuotaError (message, class name, retry delay)", () => {
    expect(at("gemini-cli: You have exhausted your daily quota on this model.")).toEqual({ kind: "usage_limit", provider: "gemini" });
    const err = Object.assign(new Error("quota"), { name: "TerminalQuotaError", retryDelayMs: 3_600_000 });
    expect(at(err)).toEqual({ kind: "usage_limit", resetAt: NOW + 3_600_000, provider: "gemini" });
  });

  test("Google daily quota metric", () => {
    expect(at("Quota exceeded for quota metric 'Gemini 2.5 Pro Requests' and limit 'Gemini 2.5 Pro Requests per day per user'")?.kind).toBe(
      "usage_limit",
    );
  });

  test("OpenAI billing quota", () => {
    expect(at("429 You exceeded your current quota, please check your plan and billing details.")?.kind).toBe("usage_limit");
    expect(at({ status: 429, error: { code: "insufficient_quota", message: "quota" } })?.kind).toBe("usage_limit");
  });

  test("Qwen / DashScope allocation quota", () => {
    expect(at("[API Error: Throttling.AllocationQuota: free allocated quota exceeded]")).toEqual({ kind: "usage_limit", provider: "qwen" });
    expect(at("Qwen OAuth quota exceeded: Your free daily quota has been reached.")?.kind).toBe("usage_limit");
  });

  test("the caller's provider wins over the one a shape implies", () => {
    expect(classifyUsageLimit("You've hit your usage limit.", { now: NOW, provider: "claude" })?.provider).toBe("claude");
  });

  test("an implausible reset (in the past, or months out) is dropped, the kind kept", () => {
    expect(at("Claude AI usage limit reached|1000")).toEqual({ kind: "usage_limit", provider: "claude" });
    expect(at(`Claude AI usage limit reached|${Math.floor(NOW / 1000) + 90 * 86_400}`)?.resetAt).toBeUndefined();
  });
});

describe("classifyUsageLimit — rate limits", () => {
  test("Anthropic API errors: 429 rate_limit_error and 529 overloaded_error", () => {
    expect(at('429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your per-minute rate limit"}}')).toEqual({
      kind: "rate_limit",
      provider: "claude",
    });
    expect(at('API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}')?.kind).toBe("rate_limit");
  });

  test("Claude CLI after its own retries", () => {
    expect(at("API Error: Repeated 529 Overloaded errors")?.kind).toBe("rate_limit");
    expect(at("API Error: Request rejected (429) · this may be a temporary capacity issue.")?.kind).toBe("rate_limit");
    // Says "usage limit" — but explicitly NOT one.
    expect(at("API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited")?.kind).toBe("rate_limit");
  });

  test("Gemini free tier: RESOURCE_EXHAUSTED with a short retry delay", () => {
    const body = JSON.stringify({
      error: {
        code: 429,
        message: "You exceeded your current quota, please check your plan and billing details. Please retry in 41.5s.",
        status: "RESOURCE_EXHAUSTED",
      },
    });
    expect(at(`GeminiProvider: ${body}`)).toEqual({ kind: "rate_limit", resetAt: NOW + 41_500 });
  });

  test("qwen-code formatted 429", () => {
    expect(
      at("[API Error: Requests rate limit exceeded, please try again later. (Status: RESOURCE_EXHAUSTED)]\nPossible quota limitations in place or slow response times detected. Please wait and try again later.")?.kind,
    ).toBe("rate_limit");
  });

  test("OpenAI rate limit with its retry hint", () => {
    expect(
      at("429 Rate limit reached for gpt-4.1 in organization org-x on tokens per min (TPM): Limit 30000, Used 29000, Requested 2000. Please try again in 2.5s."),
    ).toEqual({ kind: "rate_limit", resetAt: NOW + 2500 });
  });

  test("codex retry exhaustion and a bare structured 429", () => {
    expect(at("codex: exceeded retry limit, last status: 429 Too Many Requests")?.kind).toBe("rate_limit");
    expect(at({ status: 429, message: "request failed" })?.kind).toBe("rate_limit");
    expect(at({ message: "slow down", cause: { statusCode: 529 } })?.kind).toBe("rate_limit");
  });

  test("durations in several units", () => {
    expect(at("Rate limit exceeded. Try again in 1h 30m")?.resetAt).toBe(NOW + 90 * 60_000);
    expect(at("Too Many Requests\nRetry-After: 30")?.resetAt).toBe(NOW + 30_000);
  });
});

describe("classifyUsageLimit — ordinary errors are not limits", () => {
  const negatives: unknown[] = [
    "Error: 401 Invalid API key · Please run /login",
    "Prompt is too long: 210000 tokens > 200000 maximum",
    "Concurrent session limit reached (max 3)",
    "Context limit reached",
    "Budget limit reached ($5.00) — raise maxBudgetUsd to continue",
    "codex exited unexpectedly (code=1 signal=null)",
    "Build a rate limiter for the API",
    "You've hit your stride — keep going",
    "ECONNRESET socket hang up",
    "Turn ended with an error",
    "TypeError: cannot read properties of undefined (line 429)",
    "Qwen OAuth free tier has been discontinued as of 2026-04-15.",
    "Subagent nesting limit reached (depth 3)",
    { status: 500, message: "Internal server error" },
    "",
    null,
    undefined,
    {},
  ];
  for (const input of negatives) {
    test(`null for ${JSON.stringify(input)}`, () => {
      expect(at(input)).toBeNull();
    });
  }
});

describe("CLAUDE_USAGE_LIMIT_PREFIXES", () => {
  test("matches the installed Agent SDK's USAGE_LIMIT_ERROR_PREFIXES", () => {
    // Read from the SDK's declarations, not imported: another suite mocks the
    // module, and the export is @alpha (the copy exists so a bump can't break us).
    const dts = readFileSync(join(import.meta.dir, "..", "..", "node_modules", "@anthropic-ai", "claude-agent-sdk", "sdk.d.ts"), "utf8");
    const decl = /USAGE_LIMIT_ERROR_PREFIXES: readonly \[([^\]]*)\]/.exec(dts);
    expect(decl).not.toBeNull();
    const sdk = [...decl![1]!.matchAll(/"([^"]*)"|'([^']*)'/g)].map((m) => m[1] ?? m[2]);
    expect([...CLAUDE_USAGE_LIMIT_PREFIXES]).toEqual(sdk);
  });
});
