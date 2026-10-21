// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@solidjs/testing-library";

import { ClaudeAccountChip } from "./ClaudeAccountChip";
import type { SessionInfo } from "../protocol/types";

const base = { id: "s", name: "s", workdir: "/tmp", status: "idle", createdBy: "u", createdAt: "", attachedClients: 0 } as SessionInfo;

afterEach(cleanup);

describe("ClaudeAccountChip", () => {
  it("shows a named account on a Claude session", () => {
    const { getByText } = render(() => <ClaudeAccountChip session={{ ...base, providerId: "claude", effectiveClaudeAccount: "work" }} />);
    expect(getByText(/work/)).toBeTruthy();
  });

  it("hides on the built-in account", () => {
    const { container } = render(() => <ClaudeAccountChip session={{ ...base, providerId: "claude", effectiveClaudeAccount: "default" }} />);
    expect(container.textContent).toBe("");
  });

  it("hides once the session runs on another backend, even with a stale account field", () => {
    const { container } = render(() => <ClaudeAccountChip session={{ ...base, providerId: "codex", effectiveClaudeAccount: "work" }} />);
    expect(container.textContent).toBe("");
  });
});
