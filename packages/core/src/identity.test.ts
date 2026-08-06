import { describe, it, expect } from "bun:test";
import {
  identityLabel,
  sessionAgentLabel,
  shortSub,
  truncateWimseUri,
} from "./identity.js";
import type { MessageIdentity, SessionInfo } from "@highflame/codeoid-protocol";

describe("shortSub", () => {
  it("extracts the trailing segment of a SPIFFE URI", () => {
    expect(shortSub("spiffe://highflame.ai/acct/proj/agent/codeoid-session-abc")).toBe(
      "codeoid-session-abc",
    );
  });

  it("handles anonymous markers", () => {
    expect(shortSub("anonymous:session:abcdef")).toBe("abcdef");
    expect(shortSub("anonymous:subagent:tool-7")).toBe("tool-7");
  });

  it("passes through bare strings unchanged", () => {
    expect(shortSub("you@example.com")).toBe("you@example.com");
    expect(shortSub("system:codeoid")).toBe("system:codeoid");
  });

  it("handles missing input", () => {
    expect(shortSub(null)).toBe("—");
    expect(shortSub(undefined)).toBe("—");
    expect(shortSub("")).toBe("—");
  });
});

describe("identityLabel", () => {
  it("uses name when present and non-empty", () => {
    const id: MessageIdentity = { sub: "spiffe://x/y/agent/n", name: "Alice", type: "human" };
    expect(identityLabel(id)).toBe("Alice");
  });

  it("trims whitespace-only names back to the short sub", () => {
    const id: MessageIdentity = {
      sub: "spiffe://x/y/agent/codeoid-session-zzz",
      name: "   ",
      type: "agent",
    };
    expect(identityLabel(id)).toBe("codeoid-session-zzz");
  });

  it("falls back to short sub when no name", () => {
    const id: MessageIdentity = { sub: "anonymous:session:fallback", type: "agent" };
    expect(identityLabel(id)).toBe("fallback");
  });
});

describe("truncateWimseUri", () => {
  it("returns shorter URIs unchanged", () => {
    expect(truncateWimseUri("spiffe://x/y", 24, 28)).toBe("spiffe://x/y");
  });

  it("ellipsizes long URIs while keeping head + tail visible", () => {
    const uri =
      "spiffe://highflame.ai/acct/long-account-id/proj/long-project-id/agent/codeoid-session-12345";
    const out = truncateWimseUri(uri, 24, 28);
    expect(out.startsWith(uri.slice(0, 24))).toBe(true);
    expect(out.endsWith(uri.slice(-28))).toBe(true);
    expect(out).toContain("…");
  });
});

describe("sessionAgentLabel", () => {
  const base: SessionInfo = {
    id: "s1",
    name: "demo",
    workdir: "/tmp",
    status: "idle",
    createdBy: "you",
    createdAt: "2026-05-04T08:00:00Z",
    attachedClients: 1,
  };

  it("returns the short sub when an agent URI is present", () => {
    const s = { ...base, agentUri: "spiffe://x/y/agent/codeoid-session-abc" };
    expect(sessionAgentLabel(s)).toBe("codeoid-session-abc");
  });

  it("flags anonymous URIs", () => {
    const s = { ...base, agentUri: "anonymous:session:abc" };
    expect(sessionAgentLabel(s)).toBe("anonymous session");
  });

  it("flags missing URI as anonymous", () => {
    expect(sessionAgentLabel(base)).toBe("anonymous session");
  });
});
