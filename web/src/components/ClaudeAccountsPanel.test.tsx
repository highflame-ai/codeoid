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

  it("typing into a gateway header row keeps the same input and every character", async () => {
    clientRequestMock.mockResolvedValue(result([]));
    const { getByText, getByPlaceholderText } = render(() => <ClaudeAccountsPanel />);
    fireEvent.click(getByText("+ Gateway"));
    fireEvent.click(getByText("+ Header"));
    for (const ph of ["x-workspace", "value"]) {
      const el = getByPlaceholderText(ph) as HTMLInputElement;
      el.focus();
      for (const ch of "ws-1") {
        el.value += ch;
        fireEvent.input(el);
      }
      expect(el.isConnected).toBe(true);
      expect(document.activeElement).toBe(el);
      expect((getByPlaceholderText(ph) as HTMLInputElement).value).toBe("ws-1");
    }
  });

  it("won't add an account under a name that's already taken (the daemon would replace it)", async () => {
    clientRequestMock.mockResolvedValue(result([WORK]));
    const { getByText, getByPlaceholderText, findByText, container } = render(() => <ClaudeAccountsPanel />);
    await findByText("work");
    fireEvent.click(getByText("+ API key"));
    fireEvent.input(getByPlaceholderText("company-max"), { target: { value: "work" } });
    fireEvent.input(container.querySelector<HTMLInputElement>('input[type="password"]')!, { target: { value: "sk-ant-x" } });
    expect((getByText("Add account") as HTMLButtonElement).disabled).toBe(true);
    getByText(/already exists/);
    fireEvent.click(getByText("Cancel"));

    // The subscription sign-in refuses it too.
    fireEvent.click(getByText("+ Sign in a subscription"));
    fireEvent.input(getByPlaceholderText("company-max"), { target: { value: "work" } });
    expect((getByText("Get sign-in link") as HTMLButtonElement).disabled).toBe(true);
    getByText(/already exists/);
    expect(sent().some((m) => m.type === "claude.accounts.set" || m.type === "backend.login.start")).toBe(false);
  });

  it("after a successful sign-in, a second one starts from a fresh form", async () => {
    const LOGIN = { loginId: "L1", verificationUrl: "https://claude.ai/oauth/x", codeHint: "paste the code" };
    clientRequestMock.mockImplementation(async (msg) => {
      if (msg.type === "backend.login.start") return { type: "backend.login.start.result", requestId: "r", login: LOGIN };
      if (msg.type === "backend.login.submit") return { type: "backend.login.submit.result", requestId: "r", ok: true };
      return result([]);
    });
    const { getByText, getByPlaceholderText, findByText, queryByText } = render(() => <ClaudeAccountsPanel />);
    fireEvent.click(getByText("+ Sign in a subscription"));
    fireEvent.input(getByPlaceholderText("company-max"), { target: { value: "team-max" } });
    fireEvent.click(getByText("Get sign-in link"));
    await findByText(LOGIN.verificationUrl);
    fireEvent.input(getByPlaceholderText("Paste the code"), { target: { value: "code-1" } });
    fireEvent.click(getByText("Finish"));
    await findByText("+ Sign in a subscription");

    fireEvent.click(getByText("+ Sign in a subscription"));
    expect(getByPlaceholderText("company-max")).toBeTruthy();
    expect(queryByText("Get sign-in link")).not.toBeNull();
  });

  it("Cancel while the sign-in is starting drops the late link and cancels the daemon's attempt", async () => {
    const LOGIN = { loginId: "L9", verificationUrl: "https://claude.ai/oauth/late", codeHint: "" };
    let resolveStart!: (v: unknown) => void;
    clientRequestMock.mockImplementation((msg) => {
      if (msg.type === "backend.login.start") return new Promise((r) => (resolveStart = r));
      if (msg.type === "backend.login.cancel") return Promise.resolve({ type: "backend.login.cancel.result", requestId: "r" });
      return Promise.resolve(result([]));
    });
    const { getByText, getByPlaceholderText, queryByText } = render(() => <ClaudeAccountsPanel />);
    fireEvent.click(getByText("+ Sign in a subscription"));
    fireEvent.input(getByPlaceholderText("company-max"), { target: { value: "team-max" } });
    fireEvent.click(getByText("Get sign-in link"));
    getByText("Starting…");
    fireEvent.click(getByText("Cancel"));
    resolveStart({ type: "backend.login.start.result", requestId: "r", login: LOGIN });
    await waitFor(() => expect(sent()).toContainEqual(expect.objectContaining({ type: "backend.login.cancel", loginId: "L9" })));

    // Nothing came back to life: a new sign-in shows the name form, not the stale link.
    fireEvent.click(getByText("+ Sign in a subscription"));
    expect(queryByText(LOGIN.verificationUrl)).toBeNull();
    expect(getByText("Get sign-in link")).toBeTruthy();
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
