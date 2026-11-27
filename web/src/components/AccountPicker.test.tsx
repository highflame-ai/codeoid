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

import { createSignal } from "solid-js";

import { AccountPicker } from "./AccountPicker";
import { _resetAccountsForTest } from "../state/accounts";
import { accountKindsFor } from "../protocol/types";
import type { AccountInfo, BackendAccountsInfo } from "../protocol/types";

const backend = (id: string, accounts: Partial<AccountInfo>[], defaultAccount = "default"): BackendAccountsInfo => ({
  backend: id,
  displayName: id,
  defaultAccount,
  accounts: accounts.map((a) => ({ backend: id, kind: "api-key", createdAt: "", updatedAt: "", name: "", ...a }) as AccountInfo),
  kinds: accountKindsFor(id),
});
const result = (...backends: BackendAccountsInfo[]) => ({ type: "accounts.result", requestId: "r", backends });
const ACCOUNTS = result(
  backend("claude", [{ name: "personal-max", kind: "subscription" }, { name: "gw-a", kind: "gateway", baseUrl: "https://gw.example" }], "personal-max"),
  backend("qwen", [{ name: "team", baseUrl: "dashscope-intl" }]),
  backend("codex", []),
  backend("openai", []),
);

afterEach(() => {
  cleanup();
  _resetAccountsForTest();
  requestMock.mockReset();
  clientRequestMock.mockReset();
});

describe("AccountPicker", () => {
  it("stays hidden for a backend with no named accounts and nothing to sign in", async () => {
    clientRequestMock.mockResolvedValue(ACCOUNTS);
    const { queryByText } = render(() => <AccountPicker sessionId="s" backend="openai" effective="default" />);
    await waitFor(() => expect(clientRequestMock).toHaveBeenCalled());
    await Promise.resolve();
    expect(queryByText(/account/i)).toBeNull();
  });

  it("shows for a sign-in backend with no accounts yet, pointing to Settings", async () => {
    clientRequestMock.mockResolvedValue(ACCOUNTS);
    const onManage = vi.fn();
    const { findByTitle, getByText } = render(() => <AccountPicker sessionId="s" backend="codex" effective="default" onManage={onManage} />);
    fireEvent.click(await findByTitle("Switch this session's codex account"));
    fireEvent.click(getByText("Add or sign in an account…"));
    expect(onManage).toHaveBeenCalledWith("codex");
  });

  it("shows the effective account and switches, pinning or following the default", async () => {
    clientRequestMock.mockResolvedValue(ACCOUNTS);
    requestMock.mockResolvedValue({ type: "response.ok", requestId: "r", data: { id: "s", account: "gw-a" } });
    const [chosen, setChosen] = createSignal<string | undefined>(undefined);
    const { getByTitle, getByText, findByText, queryByText } = render(() => (
      <AccountPicker sessionId="s" backend="claude" chosen={chosen()} effective="personal-max" />
    ));
    await findByText("personal-max");
    fireEvent.click(getByTitle("Switch this session's claude account"));
    fireEvent.click(getByText("gw-a"));
    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: "session.set_account", sessionId: "s", backend: "claude", account: "gw-a" }),
      ),
    );
    await waitFor(() => expect(queryByText("Follow daemon default")).toBeNull());
    await new Promise((r) => setTimeout(r, 0)); // the switch settles (no longer busy)
    // The session now pins gw-a (the info update); following the default again sends null.
    setChosen("gw-a");
    fireEvent.click(getByTitle("Switch this session's claude account"));
    fireEvent.click(getByText("Follow daemon default"));
    await waitFor(() =>
      expect(requestMock).toHaveBeenLastCalledWith(expect.objectContaining({ type: "session.set_account", backend: "claude", account: null })),
    );
  });

  it("on a non-Claude session, lists that backend's accounts and sets the account for it", async () => {
    clientRequestMock.mockResolvedValue(ACCOUNTS);
    requestMock.mockResolvedValue({ type: "response.ok", requestId: "r", data: { id: "s", account: "team" } });
    const { findByTitle, getByText, queryByText } = render(() => <AccountPicker sessionId="s" backend="qwen" effective="default" />);
    fireEvent.click(await findByTitle("Switch this session's qwen account"));
    expect(queryByText("gw-a")).toBeNull();
    fireEvent.click(getByText("team"));
    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith(expect.objectContaining({ type: "session.set_account", sessionId: "s", backend: "qwen", account: "team" })),
    );
  });

  it("follows the session onto another backend: the list and the target backend change with it", async () => {
    clientRequestMock.mockResolvedValue(ACCOUNTS);
    const [b, setB] = createSignal("claude");
    const { findByTitle, getByText, queryByText } = render(() => <AccountPicker sessionId="s" backend={b()} effective="default" />);
    await findByTitle("Switch this session's claude account");
    setB("qwen");
    fireEvent.click(await findByTitle("Switch this session's qwen account"));
    getByText("team");
    expect(queryByText("personal-max")).toBeNull();
  });

  it("marks a removed account and offers the fix", async () => {
    clientRequestMock.mockResolvedValue(ACCOUNTS);
    const { findByTitle } = render(() => <AccountPicker sessionId="s" backend="openai" chosen="gone" effective="gone (missing)" />);
    const chip = await findByTitle(/was removed/);
    expect(chip.className).toContain("text-danger");
    expect(chip.textContent).toContain("gone (missing)");
  });

  it("shows the daemon's refusal (e.g. missing settings:write) in the menu", async () => {
    clientRequestMock.mockResolvedValue(ACCOUNTS);
    requestMock.mockRejectedValue(new Error("Missing scope: settings:write"));
    const { findByTitle, getByText, findByRole } = render(() => <AccountPicker sessionId="s" backend="claude" effective="personal-max" />);
    fireEvent.click(await findByTitle("Switch this session's claude account"));
    fireEvent.click(getByText("gw-a"));
    expect((await findByRole("alert")).textContent).toContain("settings:write");
  });
});
