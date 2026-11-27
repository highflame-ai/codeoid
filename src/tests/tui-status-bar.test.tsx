/**
 * The TUI status bar is one truncating line. Adding the provider and
 * account ahead of the status pushed `waiting_approval`, the working timer, and
 * the cost off a 120-column terminal. Live state comes first now; the account
 * shows only when it says something (pinned, a non-default default, missing).
 */
import { describe, expect, it } from "bun:test";
import React from "react";
import { renderToString } from "ink";
import { StatusBar } from "../tui/components/StatusBar.js";
import type { SessionInfo } from "../protocol/types.js";
import type { TuiSession } from "../tui/types.js";

const session = (info: Partial<SessionInfo>): TuiSession => ({
  info: {
    id: "s1",
    name: "feature-auth",
    workdir: "/home/someone/Workspace/a-fairly-long-repository-name/packages/some-service",
    status: "idle",
    createdBy: "user:me",
    createdAt: "2026-10-20T00:00:00Z",
    attachedClients: 1,
    providerId: "claude",
    ...info,
  },
  committed: [],
  live: [],
  streaming: null,
  unread: 0,
  pendingApproval: null,
});

const bar = (focused: TuiSession, cols = 120) =>
  renderToString(
    <StatusBar connection="connected" focused={focused} lastError={null} workingSince={Date.now() - 12_000} cols={cols} />,
    { columns: cols },
  );

describe("TUI StatusBar", () => {
  it("keeps the status, timer, and cost visible at 120 columns with a pinned account", () => {
    const out = bar(session({
      status: "waiting_approval",
      claudeAccount: "work-subscription",
      effectiveClaudeAccount: "work-subscription",
      model: "claude-opus-4-8",
      usage: { inputTokens: 1200, outputTokens: 3400, cacheReadTokens: 0, cacheCreationTokens: 0, totalCostUsd: 1.23, numTurns: 4, durationMs: 1000 },
    }));
    expect(out.split("\n")).toHaveLength(1);
    expect(out).toContain("waiting_approval");
    expect(out).toContain("12s");
    expect(out).toContain("$1.23");
  });

  it("a missing account and the backend stay visible once the session has usage", () => {
    const usage = { inputTokens: 91_000, outputTokens: 12_000, cacheReadTokens: 80_000, cacheCreationTokens: 4_000, totalCostUsd: 3.21, numTurns: 9, durationMs: 1000 };
    const missing = (cols: number) => bar(session({ model: "claude-opus-4-8", claudeAccount: "gone", effectiveClaudeAccount: "gone (missing)", usage }), cols);
    expect(missing(120)).toContain("missing account: gone");
    expect(missing(100)).toContain("account: gone"); // narrower: the warning still beats usage
    const endpoint = bar(session({ providerId: "oai:box", model: "qwen3-coder", usage }), 120);
    expect(endpoint).toContain("on oai:box");
    expect(endpoint).toContain("$3.21");
  });

  it("shows a pinned account", () => {
    const out = bar(session({ claudeAccount: "work", effectiveClaudeAccount: "work" }), 300);
    expect(out).toContain("account: work");
    expect(out).not.toContain("following default");
  });

  it("omits the account when the session follows the default onto the machine login", () => {
    const out = bar(session({ effectiveClaudeAccount: "default" }), 300);
    expect(out).not.toContain("account:");
  });

  it("names a non-default daemon default the session follows", () => {
    const out = bar(session({ effectiveClaudeAccount: "team" }), 300);
    expect(out).toContain("account: team (following default)");
  });

  it("always shows a missing account, pinned or followed", () => {
    expect(bar(session({ claudeAccount: "gone", effectiveClaudeAccount: "gone (missing)" }), 300)).toContain("missing account: gone");
    expect(bar(session({ effectiveClaudeAccount: "? (missing)" }), 300)).toContain("⚠ missing default account: ?");
  });

  it("shows no account for a backend without accounts", () => {
    const out = bar(session({ providerId: "mock", effectiveClaudeAccount: undefined }), 300);
    expect(out).toContain("on mock");
    expect(out).not.toContain("account:");
  });

  it("shows a Codex session's pinned account near the workdir", () => {
    const out = bar(session({ providerId: "codex", model: "gpt-5.5-codex", account: "chatgpt-work", effectiveAccount: "chatgpt-work" }), 300);
    expect(out).toContain("account: chatgpt-work · @ /home/someone");
    expect(out.indexOf("account:")).toBeGreaterThan(out.indexOf("on codex"));
  });

  it("keeps a Codex session's missing account red next to the model, ahead of usage", () => {
    const usage = { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheCreationTokens: 0, totalCostUsd: 0.5, numTurns: 3, durationMs: 1000 };
    const out = bar(session({ providerId: "codex", model: "gpt-5.5-codex", account: "gone", effectiveAccount: "gone (missing)", usage }), 300);
    expect(out).toContain("idle · ⚠ missing account: gone · 12s · mode: interactive · gpt-5.5-codex on codex");
    expect(out.indexOf("missing account: gone")).toBeLessThan(out.indexOf("$"));
    expect(bar(session({ providerId: "codex", account: "gone", effectiveAccount: "gone (missing)", usage }), 110)).toContain("missing account: gone");
  });

  it("hides a Codex session following the default onto the built-in account, and names a non-default default", () => {
    expect(bar(session({ providerId: "codex", effectiveAccount: "default" }), 300)).not.toContain("account:");
    expect(bar(session({ providerId: "codex", effectiveAccount: "team" }), 300)).toContain("account: team (following default)");
    expect(bar(session({ providerId: "oai:box", effectiveAccount: "box-key (missing)" }), 300)).toContain("⚠ missing default account: box-key");
  });

  // ` on <provider>` and a long model id used to come first and push the
  // warning off a 100–120 column terminal on every non-Claude session.
  it("keeps a missing account visible at 100 and 120 columns behind a long model on any backend", () => {
    const usage = { inputTokens: 91_000, outputTokens: 12_000, cacheReadTokens: 80_000, cacheCreationTokens: 4_000, totalCostUsd: 3.21, numTurns: 9, durationMs: 1000 };
    const cases: Array<Partial<SessionInfo>> = [
      { providerId: "codex", model: "gpt-5.5-codex-max-high-reasoning-2026-09-15", account: "work", effectiveAccount: "work (missing)" },
      { providerId: "oai:gpu-box-in-the-basement", model: "qwen3-coder-480b-a35b-instruct-fp8-awq-gguf", account: "work", effectiveAccount: "work (missing)" },
      { providerId: "claude", model: "claude-opus-4-8", account: "work", effectiveAccount: "work (missing)" },
    ];
    for (const extra of cases) {
      for (const cols of [100, 120]) {
        const out = bar(session({ status: "waiting_approval", ...extra, usage }), cols);
        expect(out.split("\n")).toHaveLength(1);
        expect(out).toContain("waiting_approval");
        expect(out).toContain("⚠ missing account: work");
      }
    }
  });

  it("puts the missing-account warning right after the status, before the mode, model and backend", () => {
    const out = bar(session({ providerId: "codex", model: "gpt-5.5-codex", account: "work", effectiveAccount: "work (missing)" }), 300);
    expect(out).toContain("feature-auth · idle · ⚠ missing account: work · 12s · mode: interactive");
    expect(out.indexOf("⚠ missing account: work")).toBeLessThan(out.indexOf("gpt-5.5-codex"));
    expect(out.indexOf("⚠ missing account: work")).toBeLessThan(out.indexOf("on codex"));
    // Shown once: not again as a descriptor beside the workdir.
    expect(out.split("account:")).toHaveLength(2);
  });

  it("does not show Claude's account on a session that has moved to another backend", () => {
    const out = bar(session({ providerId: "mock", claudeAccount: "work", effectiveClaudeAccount: "work" }), 300);
    expect(out).not.toContain("account:");
  });

  it("at 80 columns a long missing-account warning still says it is missing", () => {
    const out = bar(session({ name: "a-rather-long-session-name", status: "waiting_approval", providerId: "codex", model: "gpt-5.5-codex", account: "work-subscription-for-the-team", effectiveAccount: "work-subscription-for-the-team (missing)" }), 80);
    expect(out).toContain("⚠ missing"); // the point survives even when the name is cut
  });
});
