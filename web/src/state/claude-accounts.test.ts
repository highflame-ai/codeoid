import { afterEach, describe, expect, it, vi } from "vitest";

const clientRequestMock = vi.hoisted(() => vi.fn<(msg: { type: string }) => Promise<unknown>>());
vi.mock("./connection", () => ({
  request: vi.fn(),
  newRequestId: () => "r",
  getClient: () => ({ request: clientRequestMock }),
}));

import {
  _resetClaudeAccountsForTest,
  claudeAccountsState,
  fetchClaudeAccounts,
  refreshClaudeAccountsOnConnect,
} from "./claude-accounts";

const WORK = { name: "work", kind: "subscription", createdAt: "", updatedAt: "" };
const OK = { type: "claude.accounts.result", requestId: "r", accounts: [WORK], defaultAccount: "default" };

afterEach(() => {
  _resetClaudeAccountsForTest();
  clientRequestMock.mockReset();
});

describe("claude accounts list", () => {
  it("a failed fetch isn't 'loaded': the next plain fetch tries again", async () => {
    clientRequestMock.mockRejectedValueOnce(new Error("socket closed")).mockResolvedValueOnce(OK);
    await fetchClaudeAccounts();
    expect(claudeAccountsState()).toMatchObject({ loaded: false, error: "socket closed" });
    await fetchClaudeAccounts();
    expect(clientRequestMock).toHaveBeenCalledTimes(2);
    expect(claudeAccountsState()).toMatchObject({ loaded: true, error: null, accounts: [WORK] });
  });

  it("a (re)connect refetches a list that was loaded or failed, and nothing otherwise", async () => {
    refreshClaudeAccountsOnConnect();
    expect(clientRequestMock).not.toHaveBeenCalled();

    clientRequestMock.mockRejectedValueOnce(new Error("socket closed")).mockResolvedValue(OK);
    await fetchClaudeAccounts();
    refreshClaudeAccountsOnConnect();
    await vi.waitFor(() => expect(claudeAccountsState().loaded).toBe(true));

    refreshClaudeAccountsOnConnect();
    await vi.waitFor(() => expect(clientRequestMock).toHaveBeenCalledTimes(3));
  });
});
