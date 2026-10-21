import { afterEach, describe, expect, it, vi } from "vitest";

const clientRequestMock = vi.hoisted(() => vi.fn<(msg: { type: string }) => Promise<unknown>>());
vi.mock("./connection", () => ({
  request: vi.fn(),
  newRequestId: () => "r",
  getClient: () => ({ request: clientRequestMock }),
}));

import {
  _resetAccountsForTest,
  _setAccountsForTest,
  accountDetail,
  accountsState,
  backendOffersAccounts,
  fetchAccounts,
  newAccountNameProblem,
  refreshAccounts,
} from "./accounts";
import type { BackendAccountsInfo } from "../protocol/types";

const WORK = { backend: "claude", name: "work", kind: "subscription" as const, createdAt: "", updatedAt: "" };
const CLAUDE: BackendAccountsInfo = {
  backend: "claude",
  displayName: "Claude",
  defaultAccount: "default",
  accounts: [WORK],
  kinds: [{ kind: "subscription", label: "Pro/Max subscription", login: "code" }],
};
const OK = { type: "accounts.result", requestId: "r", backends: [CLAUDE] };

afterEach(() => {
  _resetAccountsForTest();
  clientRequestMock.mockReset();
});

describe("accounts list", () => {
  it("a failed fetch isn't 'loaded': the next plain fetch tries again", async () => {
    clientRequestMock.mockRejectedValueOnce(new Error("socket closed")).mockResolvedValueOnce(OK);
    await fetchAccounts();
    expect(accountsState()).toMatchObject({ loaded: false, error: "socket closed" });
    await fetchAccounts();
    expect(clientRequestMock).toHaveBeenCalledTimes(2);
    expect(accountsState()).toMatchObject({ loaded: true, error: null, backends: [CLAUDE] });
  });

  it("a forced fetch during a load runs after it, so a just-added account shows up", async () => {
    const ADDED = { ...WORK, name: "added" };
    let answerFirst!: (v: unknown) => void;
    clientRequestMock
      .mockImplementationOnce(() => new Promise((r) => (answerFirst = r)))
      .mockResolvedValueOnce({ ...OK, backends: [{ ...CLAUDE, accounts: [WORK, ADDED] }] });
    const first = fetchAccounts();
    // A sign-in finishes while the (older) list is still on its way.
    const forced = fetchAccounts(true);
    const again = fetchAccounts(true);
    expect(clientRequestMock).toHaveBeenCalledTimes(1);
    answerFirst(OK);
    await first;
    await Promise.all([forced, again]);
    expect(clientRequestMock).toHaveBeenCalledTimes(2);
    expect(accountsState().backends[0]!.accounts.map((a) => a.name)).toEqual(["work", "added"]);
  });

  it("a (re)connect refetches a list that was loaded or failed, and nothing otherwise", async () => {
    refreshAccounts();
    expect(clientRequestMock).not.toHaveBeenCalled();

    clientRequestMock.mockRejectedValueOnce(new Error("socket closed")).mockResolvedValue(OK);
    await fetchAccounts();
    refreshAccounts();
    await vi.waitFor(() => expect(accountsState().loaded).toBe(true));

    refreshAccounts();
    await vi.waitFor(() => expect(clientRequestMock).toHaveBeenCalledTimes(3));
  });
});

describe("account helpers", () => {
  it("a name is taken per backend: the same name on another backend is free", () => {
    _setAccountsForTest([CLAUDE, { ...CLAUDE, backend: "codex", displayName: "Codex", accounts: [] }]);
    expect(newAccountNameProblem("claude", "work")).toMatch(/already exists/);
    expect(newAccountNameProblem("claude", "work", true)).toBeNull();
    expect(newAccountNameProblem("codex", "work")).toBeNull();
  });

  it("a backend offers accounts with a named one or a sign-in kind, not with only typed kinds and none", () => {
    _setAccountsForTest([
      CLAUDE,
      { ...CLAUDE, backend: "codex", accounts: [] },
      { backend: "openai", displayName: "OpenAI", defaultAccount: "default", accounts: [], kinds: [{ kind: "api-key", label: "OpenAI API key" }] },
    ]);
    expect(backendOffersAccounts("claude")).toBe(true);
    expect(backendOffersAccounts("codex")).toBe(true);
    expect(backendOffersAccounts("openai")).toBe(false);
    expect(backendOffersAccounts("llamacpp")).toBe(false);
  });

  it("details name the kind and the non-secret parts, never a value", () => {
    _setAccountsForTest([{ backend: "pi", displayName: "pi", defaultAccount: "default", accounts: [], kinds: [{ kind: "api-keys", label: "Provider keys" }] }]);
    expect(
      accountDetail({ backend: "pi", name: "p", kind: "api-keys", envNames: ["OPENAI_API_KEY", "GROQ_API_KEY"], createdAt: "", updatedAt: "" }),
    ).toBe("Provider keys · keys: OPENAI_API_KEY, GROQ_API_KEY");
  });
});
