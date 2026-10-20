// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library";

const requestMock = vi.hoisted(() => vi.fn<(msg: unknown) => Promise<unknown>>());
const clientRequestMock = vi.hoisted(() => vi.fn<(msg: { type: string; id: string }) => Promise<unknown>>());
vi.mock("../state/connection", () => ({
  request: requestMock,
  newRequestId: () => "r",
  getClient: () => ({ request: clientRequestMock }),
}));

import { AccountPicker } from "./AccountPicker";
import { _resetClaudeAccountsForTest } from "../state/claude-accounts";

const ACCOUNTS = {
  type: "claude.accounts.result",
  requestId: "r",
  defaultAccount: "personal-max",
  accounts: [
    { name: "personal-max", kind: "subscription", createdAt: "", updatedAt: "" },
    { name: "gw-a", kind: "gateway", baseUrl: "https://gw.example", createdAt: "", updatedAt: "" },
  ],
};

afterEach(() => {
  cleanup();
  _resetClaudeAccountsForTest();
  requestMock.mockReset();
  clientRequestMock.mockReset();
});

describe("AccountPicker", () => {
  it("stays hidden when there are no named accounts", async () => {
    clientRequestMock.mockResolvedValue({ ...ACCOUNTS, accounts: [], defaultAccount: "default" });
    const { queryByText } = render(() => <AccountPicker sessionId="s" effective="default" />);
    await waitFor(() => expect(clientRequestMock).toHaveBeenCalled());
    expect(queryByText(/account/i)).toBeNull();
  });

  it("shows the effective account and switches, pinning or following the default", async () => {
    clientRequestMock.mockResolvedValue(ACCOUNTS);
    requestMock.mockResolvedValue({ type: "response.ok", requestId: "r", data: { id: "s", claudeAccount: "gw-a" } });
    const { getByTitle, getByText, findByText } = render(() => <AccountPicker sessionId="s" effective="personal-max" />);
    await findByText("personal-max");
    fireEvent.click(getByTitle("Switch this session's Claude account"));
    fireEvent.click(getByText("gw-a"));
    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith(expect.objectContaining({ type: "session.set_claude_account", sessionId: "s", account: "gw-a" })),
    );
  });

  it("marks a removed account and offers the fix", async () => {
    clientRequestMock.mockResolvedValue({ ...ACCOUNTS, accounts: [] });
    const { findByTitle } = render(() => <AccountPicker sessionId="s" chosen="gone" effective="gone (missing)" />);
    expect(await findByTitle(/was removed/)).toBeTruthy();
  });

  it("shows the daemon's refusal (e.g. missing settings:write) in the menu", async () => {
    clientRequestMock.mockResolvedValue(ACCOUNTS);
    requestMock.mockRejectedValue(new Error("Missing scope: settings:write (needed to choose a session's Claude account)"));
    const { getByTitle, getByText, findByRole } = render(() => <AccountPicker sessionId="s" effective="personal-max" />);
    await waitFor(() => expect(clientRequestMock).toHaveBeenCalled());
    fireEvent.click(getByTitle("Switch this session's Claude account"));
    fireEvent.click(getByText("gw-a"));
    expect((await findByRole("alert")).textContent).toContain("settings:write");
  });
});
