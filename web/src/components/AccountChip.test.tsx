// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@solidjs/testing-library";

import { AccountChip } from "./AccountChip";
import type { SessionInfo } from "../protocol/types";

const base = { id: "s", name: "s", workdir: "/tmp", status: "idle", createdBy: "u", createdAt: "", attachedClients: 0 } as SessionInfo;

afterEach(cleanup);

describe("AccountChip", () => {
  it("shows a named account on a Claude session", () => {
    const { getByText } = render(() => <AccountChip session={{ ...base, providerId: "claude", effectiveAccount: "work" }} />);
    expect(getByText(/work/)).toBeTruthy();
  });

  it("shows a named account on any backend with accounts", () => {
    const { getByText } = render(() => <AccountChip session={{ ...base, providerId: "codex", account: "team", effectiveAccount: "team" }} />);
    expect(getByText(/team/)).toBeTruthy();
  });

  it("hides on the built-in account", () => {
    const { container } = render(() => <AccountChip session={{ ...base, providerId: "claude", effectiveAccount: "default" }} />);
    expect(container.textContent).toBe("");
  });

  it("is red when the account is gone", () => {
    const { getByText } = render(() => <AccountChip session={{ ...base, providerId: "qwen", account: "old", effectiveAccount: "old (missing)" }} />);
    expect(getByText(/old \(missing\)/).className).toContain("text-danger");
  });

  it("hides on a backend without accounts, even with a stale account field", () => {
    const { container } = render(() => <AccountChip session={{ ...base, providerId: "mock", effectiveAccount: "work" }} />);
    expect(container.textContent).toBe("");
  });
});
