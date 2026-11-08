import { describe, expect, it } from "bun:test";
import type { SessionSandboxInfo } from "@highflame/codeoid-protocol";
import { approvalSandboxLine, approvalSandboxWarns, DOCKER_ACCESS_WHY, modeSummary, sandboxBadge, sandboxSummary } from "./sandbox.js";
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

  it("Docker access (#448 follow-up): the badge, the summary and every card say so, as a warning, with why", () => {
    const docker = { ...on, dockerSocket: true };
    expect(sandboxBadge(docker)).toMatchObject({ text: "sandboxed, Docker access", tone: "warn" });
    expect(sandboxBadge(docker)?.title).toContain(DOCKER_ACCESS_WHY);
    expect(sandboxBadge({ ...docker, enforced: false })?.text).toBe("sandboxed partly, Docker access");
    expect(sandboxSummary(docker)).toBe("sandbox: bubblewrap, network off, Docker access (can reach the whole machine)");
    const card = { sandboxed: true, sandboxDocker: true, sandboxNote: "sandboxed, Docker access: bubblewrap, network on" };
    expect(approvalSandboxLine(card)).toBe("⚠️ sandboxed, Docker access: bubblewrap, network on");
    expect(approvalSandboxWarns(card)).toBe(true);
    expect(approvalSandboxWarns({ sandboxed: true })).toBe(false);
    expect(approvalSandboxLine({ sandboxed: false, sandboxDocker: true, sandboxNote: "runs in the backend's own process, outside the sandbox" })).toBe("⚠️ runs in the backend's own process, outside the sandbox (the sandbox has Docker access)");
  });

  it("/sandbox … docker: Docker access after a provider; docker alone is the provider; nodocker takes it away", () => {
    expect(parseSlash("/sandbox auto docker")).toEqual({ kind: "sandbox", sandbox: { provider: "auto", dockerSocket: true } });
    expect(parseSlash("/sandbox bwrap on docker")).toEqual({ kind: "sandbox", sandbox: { provider: "bwrap", network: "on", dockerSocket: true } });
    expect(parseSlash("/sandbox docker docker")).toEqual({ kind: "sandbox", sandbox: { provider: "docker", dockerSocket: true } });
    expect(parseSlash("/sandbox docker")).toEqual({ kind: "sandbox", sandbox: { provider: "docker" } });
    expect(parseSlash("/sandbox nodocker")).toEqual({ kind: "sandbox", sandbox: { dockerSocket: false } });
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

describe("the mode line in a list (#448)", () => {
  it("says autonomous with what budget is left, and guarded because the autonomous budget ran out; nothing for a plain mode", () => {
    expect(modeSummary({ mode: "autonomous" })).toBe("mode: autonomous");
    expect(modeSummary({ mode: "autonomous", turnsRemaining: 3 })).toBe("mode: autonomous, 3 tool calls left");
    expect(modeSummary({ mode: "autonomous", turnsRemaining: 1 })).toBe("mode: autonomous, 1 tool call left");
    expect(modeSummary({ mode: "guarded", autonomousBudgetSpent: true })).toBe(
      "mode: guarded — autonomous budget spent: writes and commands will ask; raise the budget or switch back",
    );
    expect(modeSummary({ mode: "guarded", budgetExhausted: true })).toContain("this attempt ended");
    expect(modeSummary({ mode: "guarded" })).toBeNull();
    expect(modeSummary({ mode: "interactive" })).toBeNull();
    expect(modeSummary({})).toBeNull();
  });
});
