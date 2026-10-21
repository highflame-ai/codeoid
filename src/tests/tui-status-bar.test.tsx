/**
 * The TUI status bar is one truncating line. Adding the provider and Claude
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
    expect(missing(120)).toContain("account: gone (missing)");
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
    expect(bar(session({ claudeAccount: "gone", effectiveClaudeAccount: "gone (missing)" }), 300)).toContain("account: gone (missing)");
    expect(bar(session({ effectiveClaudeAccount: "? (missing)" }), 300)).toContain("(following default, missing)");
  });

  it("shows no account for a non-Claude session", () => {
    const out = bar(session({ providerId: "oai:box", effectiveClaudeAccount: undefined }), 300);
    expect(out).toContain("oai:box");
    expect(out).not.toContain("account:");
  });
});
