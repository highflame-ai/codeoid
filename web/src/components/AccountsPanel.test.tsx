// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library";

const clientRequestMock = vi.hoisted(() => vi.fn<(msg: Record<string, unknown>) => Promise<unknown>>());
vi.mock("../state/connection", () => ({
  request: vi.fn(),
  newRequestId: () => "r",
  getClient: () => ({ request: clientRequestMock }),
}));

import { Show, createSignal } from "solid-js";

import { AccountsPanel, focusAccountsBackend } from "./AccountsPanel";
import { _resetAccountsForTest, accountLoginState } from "../state/accounts";
import { accountKindsFor } from "../protocol/types";
import type { AccountInfo, BackendAccountsInfo } from "../protocol/types";

/** A backend as the daemon lists it — kinds straight from the protocol's table. */
const backend = (id: string, displayName: string, accounts: Partial<AccountInfo>[] = [], defaultAccount = "default"): BackendAccountsInfo => ({
  backend: id,
  displayName,
  defaultAccount,
  accounts: accounts.map((a) => ({ backend: id, kind: "api-key", createdAt: "", updatedAt: "", name: "", ...a }) as AccountInfo),
  kinds: accountKindsFor(id),
});
const result = (backends: BackendAccountsInfo[]) => ({ type: "accounts.result", requestId: "r", backends });
const claude = (accounts: Partial<AccountInfo>[] = [], defaultAccount = "default") => backend("claude", "Claude", accounts, defaultAccount);
const WORK = { name: "work", kind: "subscription" as const };
const sent = () => clientRequestMock.mock.calls.map((c) => c[0]);
const ALL = [
  claude([WORK]),
  backend("codex", "Codex"),
  backend("gemini-cli", "Gemini CLI"),
  backend("qwen", "Qwen Code"),
  backend("pi", "pi"),
  backend("oai:local", "local"),
];

afterEach(() => {
  cleanup();
  _resetAccountsForTest();
  focusAccountsBackend("claude");
  clientRequestMock.mockReset();
});

describe("AccountsPanel — Claude", () => {
  it("lists accounts with the default marked, and makes another the default", async () => {
    clientRequestMock.mockResolvedValueOnce(result([claude([WORK])])).mockResolvedValueOnce(result([claude([WORK], "work")]));
    const { findByText, getAllByText } = render(() => <AccountsPanel />);
    await findByText("work");
    // Only the non-default rows offer "Make default".
    fireEvent.click(getAllByText("Make default")[0]!);
    await waitFor(() => expect(sent()[1]).toMatchObject({ type: "accounts.set_default", backend: "claude", name: "work" }));
  });

  it("adds a gateway with headers; the token goes once and is never shown", async () => {
    clientRequestMock
      .mockResolvedValueOnce(result([claude()]))
      .mockResolvedValueOnce(result([claude([{ name: "gw-a", kind: "gateway", baseUrl: "https://gw.example", headerNames: ["x-ws"] }])]));
    const { getByText, getByPlaceholderText, findByText, container } = render(() => <AccountsPanel />);
    await findByText("+ Anthropic-compatible gateway");
    fireEvent.click(getByText("+ Anthropic-compatible gateway"));
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
      type: "accounts.set",
      backend: "claude",
      name: "gw-a",
      kind: "gateway",
      token: "gw-secret",
      baseUrl: "https://gw.example",
      headers: { "x-ws": "ws-1" },
    });
    expect(sent()[1]).not.toHaveProperty("replace");
    expect(container.textContent).not.toContain("gw-secret");
  });

  it("typing into a gateway header row keeps the same input and every character", async () => {
    clientRequestMock.mockResolvedValue(result([claude()]));
    const { getByText, getByPlaceholderText, findByText } = render(() => <AccountsPanel />);
    fireEvent.click(await findByText("+ Anthropic-compatible gateway"));
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

  it("a taken name replaces the account only after an explicit confirmation, sent as replace: true", async () => {
    clientRequestMock.mockResolvedValue(result([claude([WORK])]));
    const { getByText, getByPlaceholderText, getByRole, findByText, container } = render(() => <AccountsPanel />);
    await findByText("work");
    fireEvent.click(getByText("+ Anthropic API key"));
    fireEvent.input(getByPlaceholderText("company-max"), { target: { value: "work" } });
    fireEvent.input(container.querySelector<HTMLInputElement>('input[type="password"]')!, { target: { value: "sk-ant-x" } });
    expect((getByText("Add account") as HTMLButtonElement).disabled).toBe(true);
    getByText(/already exists/);
    expect(sent().some((m) => m.type === "accounts.set")).toBe(false);
    // Confirmed: it goes through (renewing a credential under its name).
    fireEvent.click(getByRole("checkbox"));
    expect((getByText("Add account") as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(getByText("Add account"));
    await waitFor(() =>
      expect(sent()).toContainEqual(expect.objectContaining({ type: "accounts.set", name: "work", kind: "api-key", replace: true })),
    );
  });

  it("the subscription sign-in needs the same confirmation for a taken name", async () => {
    clientRequestMock.mockResolvedValue(result([claude([WORK])]));
    const { getByText, getByPlaceholderText, getByRole, findByText } = render(() => <AccountsPanel />);
    await findByText("work");
    fireEvent.click(getByText("+ Sign in: Pro/Max subscription"));
    fireEvent.input(getByPlaceholderText("company-max"), { target: { value: "work" } });
    expect((getByText("Get sign-in link") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(getByRole("checkbox"));
    expect((getByText("Get sign-in link") as HTMLButtonElement).disabled).toBe(false);
    // Editing the name drops the confirmation.
    fireEvent.input(getByPlaceholderText("company-max"), { target: { value: "wor" } });
    fireEvent.input(getByPlaceholderText("company-max"), { target: { value: "work" } });
    expect((getByText("Get sign-in link") as HTMLButtonElement).disabled).toBe(true);
    expect(sent().some((m) => m.type === "backend.login.start")).toBe(false);
  });

  it("after a successful sign-in, a second one starts from a fresh form", async () => {
    const LOGIN = { loginId: "L1", verificationUrl: "https://claude.ai/oauth/x", codeHint: "paste the code", expiresAt: 0 };
    clientRequestMock.mockImplementation(async (msg) => {
      if (msg.type === "backend.login.start") return { type: "backend.login.start.result", requestId: "r", login: LOGIN };
      if (msg.type === "backend.login.submit") return { type: "backend.login.submit.result", requestId: "r", ok: true };
      return result([claude()]);
    });
    const { getByText, getByPlaceholderText, findByText, queryByText } = render(() => <AccountsPanel />);
    fireEvent.click(await findByText("+ Sign in: Pro/Max subscription"));
    fireEvent.input(getByPlaceholderText("company-max"), { target: { value: "team-max" } });
    fireEvent.click(getByText("Get sign-in link"));
    await findByText(LOGIN.verificationUrl);
    expect(sent()).toContainEqual(expect.objectContaining({ type: "backend.login.start", backend: "claude", account: "team-max" }));
    fireEvent.input(getByPlaceholderText("Paste the code"), { target: { value: "code-1" } });
    fireEvent.click(getByText("Finish"));
    await findByText("+ Sign in: Pro/Max subscription");
    // Finishing unmounts the form; that's not an abandoned attempt.
    expect(sent().some((m) => m.type === "backend.login.cancel")).toBe(false);

    fireEvent.click(getByText("+ Sign in: Pro/Max subscription"));
    expect(getByPlaceholderText("company-max")).toBeTruthy();
    expect(queryByText("Get sign-in link")).not.toBeNull();
  });

  it("closing Settings mid sign-in cancels the daemon's attempt; reopening starts fresh", async () => {
    const LOGIN = { loginId: "L5", verificationUrl: "https://claude.ai/oauth/open", codeHint: "", expiresAt: 0 };
    clientRequestMock.mockImplementation(async (msg) => {
      if (msg.type === "backend.login.start") return { type: "backend.login.start.result", requestId: "r", login: LOGIN };
      if (msg.type === "backend.login.cancel") return { type: "backend.login.cancel.result", requestId: "r" };
      return result([claude()]);
    });
    const [open, setOpen] = createSignal(true);
    const { getByText, getByPlaceholderText, findByText, queryByText } = render(() => (
      <Show when={open()}>
        <AccountsPanel />
      </Show>
    ));
    fireEvent.click(await findByText("+ Sign in: Pro/Max subscription"));
    fireEvent.input(getByPlaceholderText("company-max"), { target: { value: "team-max" } });
    fireEvent.click(getByText("Get sign-in link"));
    await findByText(LOGIN.verificationUrl);

    setOpen(false);
    await waitFor(() => expect(sent()).toContainEqual(expect.objectContaining({ type: "backend.login.cancel", loginId: "L5" })));
    expect(accountLoginState().phase).toBe("idle");

    setOpen(true);
    fireEvent.click(getByText("+ Sign in: Pro/Max subscription"));
    expect(queryByText(LOGIN.verificationUrl)).toBeNull();
    getByText("Get sign-in link");
  });

  it("Cancel while the sign-in is starting drops the late link and cancels the daemon's attempt", async () => {
    const LOGIN = { loginId: "L9", verificationUrl: "https://claude.ai/oauth/late", codeHint: "", expiresAt: 0 };
    let resolveStart!: (v: unknown) => void;
    clientRequestMock.mockImplementation((msg) => {
      if (msg.type === "backend.login.start") return new Promise((r) => (resolveStart = r));
      if (msg.type === "backend.login.cancel") return Promise.resolve({ type: "backend.login.cancel.result", requestId: "r" });
      return Promise.resolve(result([claude()]));
    });
    const { getByText, getByPlaceholderText, queryByText, findByText } = render(() => <AccountsPanel />);
    fireEvent.click(await findByText("+ Sign in: Pro/Max subscription"));
    fireEvent.input(getByPlaceholderText("company-max"), { target: { value: "team-max" } });
    fireEvent.click(getByText("Get sign-in link"));
    getByText("Starting…");
    fireEvent.click(getByText("Cancel"));
    resolveStart({ type: "backend.login.start.result", requestId: "r", login: LOGIN });
    await waitFor(() => expect(sent()).toContainEqual(expect.objectContaining({ type: "backend.login.cancel", loginId: "L9" })));

    // Nothing came back to life: a new sign-in shows the name form, not the stale link.
    fireEvent.click(getByText("+ Sign in: Pro/Max subscription"));
    expect(queryByText(LOGIN.verificationUrl)).toBeNull();
    expect(getByText("Get sign-in link")).toBeTruthy();
  });

  it("asks before removing, then removes", async () => {
    clientRequestMock.mockResolvedValueOnce(result([claude([WORK])])).mockResolvedValueOnce(result([claude()]));
    const { findByText, getByText, getAllByText } = render(() => <AccountsPanel />);
    await findByText("work");
    fireEvent.click(getByText("Remove"));
    expect(clientRequestMock).toHaveBeenCalledTimes(1);
    await findByText(/stop until switched/);
    fireEvent.click(getAllByText("Remove")[0]!);
    await waitFor(() => expect(sent()[1]).toMatchObject({ type: "accounts.remove", backend: "claude", name: "work" }));
  });
});

describe("AccountsPanel — every backend, forms from the daemon's kinds", () => {
  /** Render on the full list, then switch to `name`'s tab. */
  async function openBackend(name: string) {
    const view = render(() => <AccountsPanel />);
    await view.findByText("work");
    fireEvent.click(view.getByRole("tab", { name: new RegExp(`^${name}`) }));
    return view;
  }

  it("lists every backend the daemon returns, each with its own accounts and default", async () => {
    clientRequestMock.mockResolvedValue(result([claude([WORK]), backend("codex", "Codex", [{ name: "team", kind: "chatgpt-login" }], "team")]));
    const { getByRole, findByText, queryByText, getByText } = render(() => <AccountsPanel />);
    await findByText("work");
    fireEvent.click(getByRole("tab", { name: /^Codex/ }));
    getByText("team");
    getByText("ChatGPT sign-in");
    expect(queryByText("work")).toBeNull();
    fireEvent.click(getByText("Make default"));
    await waitFor(() => expect(sent()).toContainEqual(expect.objectContaining({ type: "accounts.set_default", backend: "codex", name: "default" })));
  });

  it("Qwen: the endpoint is a preset select with a custom URL fallback", async () => {
    clientRequestMock.mockResolvedValue(result(ALL));
    const { getByText, getByPlaceholderText, getByLabelText, queryByPlaceholderText, container } = await openBackend("Qwen Code");
    fireEvent.click(getByText("+ API key"));
    fireEvent.input(getByPlaceholderText("company-max"), { target: { value: "plan" } });
    fireEvent.input(container.querySelector<HTMLInputElement>('input[type="password"]')!, { target: { value: "sk-sp-1" } });
    // The first preset is preselected; no free-text URL until "Custom URL…".
    expect(queryByPlaceholderText("https://gateway.example.com")).toBeNull();
    fireEvent.change(getByLabelText("Endpoint"), { target: { value: "bailian-plan-intl" } });
    fireEvent.click(getByText("Add account"));
    await waitFor(() =>
      expect(sent()).toContainEqual(
        expect.objectContaining({ type: "accounts.set", backend: "qwen", name: "plan", kind: "api-key", token: "sk-sp-1", baseUrl: "bailian-plan-intl" }),
      ),
    );
  });

  it("Qwen: a custom URL is required once chosen", async () => {
    clientRequestMock.mockResolvedValue(result(ALL));
    const { getByText, getByPlaceholderText, getByLabelText, container } = await openBackend("Qwen Code");
    fireEvent.click(getByText("+ API key"));
    fireEvent.input(getByPlaceholderText("company-max"), { target: { value: "own" } });
    fireEvent.input(container.querySelector<HTMLInputElement>('input[type="password"]')!, { target: { value: "k" } });
    fireEvent.change(getByLabelText("Endpoint"), { target: { value: "__custom__" } });
    expect((getByText("Add account") as HTMLButtonElement).disabled).toBe(true);
    getByText("Endpoint is required");
    fireEvent.input(getByPlaceholderText("https://gateway.example.com"), { target: { value: "https://dash.example/v1" } });
    fireEvent.click(getByText("Add account"));
    await waitFor(() => expect(sent()).toContainEqual(expect.objectContaining({ type: "accounts.set", backend: "qwen", baseUrl: "https://dash.example/v1" })));
  });

  it("pi: key variables come from the allowlist, each once, with secret values", async () => {
    clientRequestMock.mockResolvedValue(result(ALL));
    const { getByText, getByPlaceholderText, getAllByLabelText, container } = await openBackend("pi");
    fireEvent.click(getByText("+ Provider keys"));
    fireEvent.input(getByPlaceholderText("company-max"), { target: { value: "keys" } });
    // No token field: this kind is only key variables.
    expect(container.querySelectorAll('input[type="password"]')).toHaveLength(0);
    getByText("add at least one key");
    fireEvent.click(getByText("+ Key"));
    fireEvent.click(getByText("+ Key"));
    const [first, second] = getAllByLabelText("Key variable") as HTMLSelectElement[];
    expect(first!.value).toBe("ANTHROPIC_API_KEY");
    expect(second!.value).toBe("OPENAI_API_KEY");
    // A name another row has taken isn't offered again.
    expect([...second!.options].map((o) => o.value)).not.toContain("ANTHROPIC_API_KEY");
    fireEvent.change(second!, { target: { value: "GROQ_API_KEY" } });
    const values = container.querySelectorAll<HTMLInputElement>('input[type="password"]');
    fireEvent.input(values[0]!, { target: { value: "sk-ant" } });
    expect((getByText("Add account") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.input(values[1]!, { target: { value: "gsk" } });
    fireEvent.click(getByText("Add account"));
    await waitFor(() =>
      expect(sent()).toContainEqual(
        expect.objectContaining({ type: "accounts.set", backend: "pi", kind: "api-keys", env: { ANTHROPIC_API_KEY: "sk-ant", GROQ_API_KEY: "gsk" } }),
      ),
    );
    const set = sent().find((m) => m.type === "accounts.set")!;
    expect(set).not.toHaveProperty("token");
  });

  it("an endpoint takes headers alone — its key is optional", async () => {
    clientRequestMock.mockResolvedValue(result(ALL));
    const { getByText, getByPlaceholderText } = await openBackend("local");
    fireEvent.click(getByText("+ Key and headers"));
    getByText("API key (optional)");
    fireEvent.input(getByPlaceholderText("company-max"), { target: { value: "alt" } });
    getByText("enter a key or a header");
    fireEvent.click(getByText("+ Header"));
    fireEvent.input(getByPlaceholderText("x-workspace"), { target: { value: "x-team" } });
    fireEvent.input(getByPlaceholderText("value"), { target: { value: "t-2" } });
    fireEvent.click(getByText("Add account"));
    await waitFor(() =>
      expect(sent()).toContainEqual(expect.objectContaining({ type: "accounts.set", backend: "oai:local", headers: { "x-team": "t-2" } })),
    );
    expect(sent().find((m) => m.type === "accounts.set")).not.toHaveProperty("token");
  });

  it("a sign-in-only kind offers no typed form", async () => {
    clientRequestMock.mockResolvedValue(result(ALL));
    const { getByText, queryByText } = await openBackend("Codex");
    getByText("+ Sign in: ChatGPT sign-in");
    expect(queryByText("+ ChatGPT sign-in")).toBeNull();
    getByText("+ OpenAI API key");
  });
});

describe("AccountsPanel — device sign-in (Codex)", () => {
  const LOGIN = {
    loginId: "D1",
    backend: "codex",
    verificationUrl: "https://auth.openai.com/codex/device",
    codeHint: "Enter this code.",
    mode: "device",
    userCode: "8UP4-KHOLU",
    expiresAt: Date.now() + 60_000,
  };

  /** Start a Codex sign-in for `name`; the wait answers via `answerWait`. */
  async function startDevice(name = "team") {
    let answerWait!: (v: unknown) => void;
    clientRequestMock.mockImplementation((msg) => {
      if (msg.type === "backend.login.start") return Promise.resolve({ type: "backend.login.start.result", requestId: "r", login: LOGIN });
      if (msg.type === "backend.login.wait") return new Promise((r) => (answerWait = r));
      if (msg.type === "backend.login.cancel") return Promise.resolve({ type: "backend.login.cancel.result", requestId: "r", ok: true });
      return Promise.resolve(result(ALL));
    });
    const view = render(() => <AccountsPanel />);
    await view.findByText("work");
    fireEvent.click(view.getByRole("tab", { name: /^Codex/ }));
    fireEvent.click(view.getByText("+ Sign in: ChatGPT sign-in"));
    fireEvent.input(view.getByPlaceholderText("company-max"), { target: { value: name } });
    fireEvent.click(view.getByText("Get sign-in link"));
    await view.findByTestId("device-user-code");
    await waitFor(() => expect(sent()).toContainEqual(expect.objectContaining({ type: "backend.login.wait", loginId: "D1" })));
    return { ...view, answerWait: (v: unknown) => answerWait(v) };
  }

  it("shows the one-time code with the link, waits, and on approval returns to the list", async () => {
    const { getByTestId, getByText, findByText, answerWait } = await startDevice();
    expect(sent()).toContainEqual(expect.objectContaining({ type: "backend.login.start", backend: "codex", account: "team" }));
    expect(getByTestId("device-user-code").textContent).toBe("8UP4-KHOLU");
    getByText(LOGIN.verificationUrl);
    getByText("Waiting for you to approve…");
    // No code to paste in this mode.
    expect(sent().some((m) => m.type === "backend.login.submit")).toBe(false);
    const listsBefore = sent().filter((m) => m.type === "accounts.list").length;
    answerWait({ type: "backend.login.wait.result", requestId: "r", ok: true });
    await findByText("+ Sign in: ChatGPT sign-in");
    expect(sent().filter((m) => m.type === "accounts.list").length).toBe(listsBefore + 1);
    expect(sent().some((m) => m.type === "backend.login.cancel")).toBe(false);
  });

  it("a failed approval shows the daemon's reason and lets the user start again", async () => {
    const { findByRole, getByText, queryByTestId, answerWait } = await startDevice();
    answerWait({ type: "backend.login.wait.result", requestId: "r", ok: false, error: "The sign-in was not approved in time. Start again." });
    expect((await findByRole("alert")).textContent).toContain("not approved in time");
    expect(queryByTestId("device-user-code")).toBeNull();
    getByText("Get sign-in link");
  });

  it("Cancel while waiting ends the daemon's attempt, and the late answer changes nothing", async () => {
    const { getByText, findByText, queryByRole, answerWait } = await startDevice();
    fireEvent.click(getByText("Cancel"));
    await waitFor(() => expect(sent()).toContainEqual(expect.objectContaining({ type: "backend.login.cancel", loginId: "D1" })));
    await findByText("+ Sign in: ChatGPT sign-in");
    answerWait({ type: "backend.login.wait.result", requestId: "r", ok: false, error: "That sign-in attempt was cancelled." });
    await Promise.resolve();
    expect(queryByRole("alert")).toBeNull();
    expect(accountLoginState().phase).toBe("idle");
  });
});

describe("AccountsPanel — code sign-in (Claude subscription)", () => {
  it("starts the Claude sign-in for the name, takes the pasted code, and finishes", async () => {
    const LOGIN = { loginId: "C1", verificationUrl: "https://claude.com/cai/oauth/authorize?x=1", codeHint: "Paste the code.", mode: "code", expiresAt: 0 };
    clientRequestMock.mockImplementation(async (msg) => {
      if (msg.type === "backend.login.start") return { type: "backend.login.start.result", requestId: "r", login: LOGIN };
      if (msg.type === "backend.login.submit") return { type: "backend.login.submit.result", requestId: "r", ok: true };
      return result(ALL);
    });
    const { getByRole, getByText, getByPlaceholderText, findByText, queryByTestId } = render(() => <AccountsPanel />);
    await findByText("work");
    fireEvent.click(getByRole("tab", { name: /^Claude/ }));
    fireEvent.click(getByText("+ Sign in: Pro/Max subscription"));
    fireEvent.input(getByPlaceholderText("company-max"), { target: { value: "personal" } });
    fireEvent.click(getByText("Get sign-in link"));
    await findByText(LOGIN.verificationUrl);
    expect(queryByTestId("device-user-code")).toBeNull();
    fireEvent.input(getByPlaceholderText("Paste the code"), { target: { value: "code#abc" } });
    fireEvent.click(getByText("Finish"));
    await findByText("+ Sign in: Pro/Max subscription");
    expect(sent()).toContainEqual(expect.objectContaining({ type: "backend.login.start", backend: "claude", account: "personal" }));
    expect(sent()).toContainEqual(expect.objectContaining({ type: "backend.login.submit", loginId: "C1", code: "code#abc" }));
  });

  it("a taken name is signed in again only with replace: true", async () => {
    const LOGIN = { loginId: "C2", verificationUrl: "https://claude.com/cai/oauth/authorize?y=1", codeHint: "", mode: "code", expiresAt: 0 };
    clientRequestMock.mockImplementation(async (msg) => {
      if (msg.type === "backend.login.start") return { type: "backend.login.start.result", requestId: "r", login: LOGIN };
      return result(ALL);
    });
    const { getByRole, getByText, getByPlaceholderText, findByText } = render(() => <AccountsPanel />);
    await findByText("work");
    fireEvent.click(getByRole("tab", { name: /^Claude/ }));
    fireEvent.click(getByText("+ Sign in: Pro/Max subscription"));
    fireEvent.input(getByPlaceholderText("company-max"), { target: { value: "work" } });
    fireEvent.click(getByRole("checkbox"));
    fireEvent.click(getByText("Get sign-in link"));
    await findByText(LOGIN.verificationUrl);
    expect(sent()).toContainEqual(expect.objectContaining({ type: "backend.login.start", backend: "claude", account: "work", replace: true }));
  });

  it("the Gemini CLI offers only API keys — no Google sign-in", async () => {
    clientRequestMock.mockResolvedValue(result(ALL));
    const { getByRole, findByText, queryByText } = render(() => <AccountsPanel />);
    await findByText("work");
    fireEvent.click(getByRole("tab", { name: /^Gemini CLI/ }));
    expect(queryByText(/Sign in/)).toBeNull();
  });
});
