// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@solidjs/testing-library";

import { SandboxChip } from "./SandboxChip";
import { SandboxLine } from "./transcript/ApprovalBar";
import type { SessionInfo } from "../protocol/types";

const base = { id: "s", name: "s", workdir: "/tmp", status: "idle", createdBy: "u", createdAt: "", attachedClients: 0 } as SessionInfo;

afterEach(cleanup);

describe("SandboxChip (#448)", () => {
  it("sandboxed: green, with how and the network in its title", () => {
    const { getByText } = render(() => (
      <SandboxChip session={{ ...base, sandbox: { choice: "auto", state: "on", provider: "bwrap", providerName: "bubblewrap", network: "off", via: "Claude Code's sandbox (bubblewrap)", enforced: true } }} />
    ));
    const chip = getByText(/sandboxed/);
    expect(chip.className).toContain("text-success");
    expect(chip.getAttribute("title")).toContain("network off");
  });

  it("not sandboxed: amber, and says why", () => {
    const { getByText } = render(() => <SandboxChip session={{ ...base, sandbox: { choice: "auto", state: "unavailable", reason: "bubblewrap (bwrap) is not installed", network: "on", enforced: false } }} />);
    const chip = getByText(/not sandboxed/);
    expect(chip.className).toContain("text-warn");
    expect(chip.getAttribute("title")).toContain("bubblewrap (bwrap) is not installed");
  });

  it("off: red; no sandboxing on the daemon: nothing", () => {
    expect(render(() => <SandboxChip session={{ ...base, sandbox: { choice: "off", state: "off", network: "on", enforced: false } }} />).getByText(/sandbox off/).className).toContain("text-danger");
    cleanup();
    expect(render(() => <SandboxChip session={base} />).container.textContent).toBe("");
  });
});

describe("SandboxLine on an approval", () => {
  it("says whether the call runs sandboxed", () => {
    expect(render(() => <SandboxLine sandboxed sandboxNote="sandboxed: bubblewrap, network on" />).getByText("🛡 sandboxed: bubblewrap, network on")).toBeTruthy();
    cleanup();
    const warn = render(() => <SandboxLine sandboxed={false} sandboxNote="asks to run outside the sandbox" />).getByText("⚠️ asks to run outside the sandbox");
    expect(warn.className).toContain("text-warn");
    cleanup();
    expect(render(() => <SandboxLine />).container.textContent).toBe("");
  });
});
