import { describe, expect, it } from "bun:test";
import type { SessionSandboxInfo } from "@highflame/codeoid-protocol";
import { approvalSandboxLine, sandboxBadge, sandboxSummary } from "./sandbox.js";
import { dispatchSlash, parseSlash } from "./slash.js";

const on: SessionSandboxInfo = { choice: "auto", state: "on", provider: "bwrap", providerName: "bubblewrap", network: "off", confinement: "native", via: "Claude Code's sandbox (bubblewrap) with codeoid's policy", enforced: true };

describe("sandbox display (#448)", () => {
  it("the header badge: sandboxed, partly, off, not sandboxed (with why), no shell; nothing without sandboxing", () => {
    expect(sandboxBadge(on)).toMatchObject({ text: "sandboxed", tone: "on" });
    expect(sandboxBadge(on)?.title).toContain("network off");
    expect(sandboxBadge({ ...on, network: "on", networkRequested: "off", enforced: false, limits: ["pi needs the network"] })).toMatchObject({ text: "sandboxed, partly", tone: "warn" });
    expect(sandboxBadge({ choice: "off", state: "off", network: "on", enforced: false })).toMatchObject({ text: "sandbox off", tone: "off" });
    const un = sandboxBadge({ choice: "auto", state: "unavailable", reason: "bubblewrap (bwrap) is not installed", network: "on", enforced: false });
    expect(un).toMatchObject({ text: "not sandboxed", tone: "warn" });
    expect(un?.title).toContain("bubblewrap (bwrap) is not installed");
    expect(sandboxBadge({ choice: "auto", state: "no-shell", network: "on", enforced: true })?.text).toBe("no shell");
    expect(sandboxBadge(undefined)).toBeNull();
  });

  it("the one-line summary", () => {
    expect(sandboxSummary(on)).toBe("sandbox: bubblewrap, network off");
    expect(sandboxSummary({ ...on, network: "allowlist", allowedHosts: ["github.com"] })).toBe("sandbox: bubblewrap, network allowlist [github.com]");
    expect(sandboxSummary({ choice: "auto", state: "unavailable", reason: "x", network: "on", enforced: false })).toBe("not sandboxed: x");
  });

  it("the approval card's line", () => {
    expect(approvalSandboxLine({ sandboxed: true, sandboxNote: "sandboxed: bubblewrap, network on" })).toBe("🛡 sandboxed: bubblewrap, network on");
    expect(approvalSandboxLine({ sandboxed: false, sandboxNote: "asks to run outside the sandbox" })).toBe("⚠️ asks to run outside the sandbox");
    expect(approvalSandboxLine({})).toBeNull();
  });

  it("/sandbox: a provider, a network, an allowlist, off", () => {
    expect(parseSlash("/sandbox off")).toEqual({ kind: "sandbox", sandbox: { provider: "off" } });
    expect(parseSlash("/sandbox auto off")).toEqual({ kind: "sandbox", sandbox: { provider: "auto", network: "off" } });
    expect(parseSlash("/sandbox docker on")).toEqual({ kind: "sandbox", sandbox: { provider: "docker", network: "on" } });
    expect(parseSlash("/sandbox auto allow:github.com,*.npmjs.org")).toEqual({
      kind: "sandbox",
      sandbox: { provider: "auto", network: "allowlist", allowedHosts: ["github.com", "*.npmjs.org"] },
    });
    expect(() => parseSlash("/sandbox")).toThrow();
    const sent: unknown[] = [];
    dispatchSlash({ kind: "sandbox", sandbox: { network: "off" } }, { sessionId: "s1", newRequestId: () => "r1", send: (m: unknown) => sent.push(m) } as never);
    expect(sent).toEqual([{ type: "session.set_sandbox", id: "r1", sessionId: "s1", sandbox: { network: "off" } }]);
  });
});
