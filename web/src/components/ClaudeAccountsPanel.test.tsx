// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library";

const clientRequestMock = vi.hoisted(() => vi.fn<(msg: Record<string, unknown>) => Promise<unknown>>());
vi.mock("../state/connection", () => ({
  request: vi.fn(),
  newRequestId: () => "r",
  getClient: () => ({ request: clientRequestMock }),
}));

import { ClaudeAccountsPanel } from "./ClaudeAccountsPanel";
import { _resetClaudeAccountsForTest } from "../state/claude-accounts";

const result = (accounts: unknown[], defaultAccount = "default") => ({ type: "claude.accounts.result", requestId: "r", accounts, defaultAccount });
const WORK = { name: "work", kind: "subscription", createdAt: "", updatedAt: "" };
const sent = () => clientRequestMock.mock.calls.map((c) => c[0]);

afterEach(() => {
  cleanup();
  _resetClaudeAccountsForTest();
  clientRequestMock.mockReset();
});

describe("ClaudeAccountsPanel", () => {
  it("lists accounts with the default marked, and makes another the default", async () => {
    clientRequestMock.mockResolvedValueOnce(result([WORK])).mockResolvedValueOnce(result([WORK], "work"));
    const { findByText, getAllByText } = render(() => <ClaudeAccountsPanel />);
    await findByText("work");
    // Only the non-default rows offer "Make default".
    fireEvent.click(getAllByText("Make default")[0]!);
    await waitFor(() => expect(sent()[1]).toMatchObject({ type: "claude.accounts.set_default", name: "work" }));
  });

  it("adds a gateway with headers; the token goes once and is never shown", async () => {
    clientRequestMock.mockResolvedValueOnce(result([])).mockResolvedValueOnce(result([{ name: "gw-a", kind: "gateway", baseUrl: "https://gw.example", headerNames: ["x-ws"], createdAt: "", updatedAt: "" }]));
    const { getByText, getByPlaceholderText, findByText, container } = render(() => <ClaudeAccountsPanel />);
    await waitFor(() => expect(clientRequestMock).toHaveBeenCalledTimes(1));
    fireEvent.click(getByText("+ Gateway"));
    fireEvent.input(getByPlaceholderText("company-max"), { target: { value: "gw-a" } });
    fireEvent.input(getByPlaceholderText("https://gateway.example.com"), { target: { value: "https://gw.example" } });
    const [token] = container.querySelectorAll<HTMLInputElement>('input[type="password"]');
    fireEvent.input(token!, { target: { value: "gw-secret" } });
    fireEvent.click(getByText("+ Header"));
    fireEvent.input(getByPlaceholderText("x-workspace"), { target: { value: "x-ws" } });
    fireEvent.input(getByPlaceholderText("value"), { target: { value: "ws-1" } });
    fireEvent.click(getByText("Add account"));
    await findByText(/headers: x-ws/);
    expect(sent()[1]).toMatchObject({
      type: "claude.accounts.set",
      name: "gw-a",
      kind: "gateway",
      token: "gw-secret",
      baseUrl: "https://gw.example",
      headers: { "x-ws": "ws-1" },
    });
    expect(container.textContent).not.toContain("gw-secret");
  });

  it("asks before removing, then removes", async () => {
    clientRequestMock.mockResolvedValueOnce(result([WORK])).mockResolvedValueOnce(result([]));
    const { findByText, getByText, getAllByText } = render(() => <ClaudeAccountsPanel />);
    await findByText("work");
    fireEvent.click(getByText("Remove"));
    expect(clientRequestMock).toHaveBeenCalledTimes(1);
    await findByText(/stop until switched/);
    fireEvent.click(getAllByText("Remove")[0]!);
    await waitFor(() => expect(sent()[1]).toMatchObject({ type: "claude.accounts.remove", name: "work" }));
  });
});
