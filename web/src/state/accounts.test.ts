import { afterEach, describe, expect, it, vi } from "vitest";

const clientRequestMock = vi.hoisted(() => vi.fn<(msg: { type: string; loginId?: string }) => Promise<unknown>>());
const sendMock = vi.hoisted(() => vi.fn());
const conn = vi.hoisted(() => ({ kind: "connected" }));
vi.mock("./connection", () => ({
  request: vi.fn(),
  send: sendMock,
  newRequestId: () => "r",
  getClient: () => ({ request: clientRequestMock }),
  connectionStatus: () => ({ kind: conn.kind }),
}));

import {
  _resetAccountsForTest,
  _setAccountsForTest,
  accountDetail,
  accountLoginState,
  accountsState,
  backendOffersAccounts,
  cancelAccountLogin,
  fetchAccounts,
  isConnectionError,
  newAccountNameProblem,
  refreshAccounts,
  resumeAccountLogin,
  startAccountLogin,
  submitAccountLoginCode,
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
  sendMock.mockReset();
  conn.kind = "connected";
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

describe("device sign-in across a dropped connection", () => {
  const DEVICE = {
    loginId: "D1",
    backend: "codex" as const,
    verificationUrl: "https://auth.openai.com/codex/device",
    codeHint: "",
    mode: "device" as const,
    userCode: "ABCD-EFGH",
    expiresAt: Date.now() + 60_000,
  };
  const waits = () => clientRequestMock.mock.calls.filter((c) => c[0].type === "backend.login.wait");

  /** Start a device login whose waits are answered, in order, by `answers` (an Error rejects). */
  function startWith(...answers: unknown[]) {
    clientRequestMock.mockImplementation(async (msg) => {
      if (msg.type === "backend.login.start") return { type: "backend.login.start.result", requestId: "r", login: DEVICE };
      if (msg.type === "backend.login.wait") {
        const a = answers.shift();
        if (a instanceof Error) throw a;
        return a ?? new Promise(() => {});
      }
      if (msg.type === "backend.login.cancel") return { type: "backend.login.cancel.result", requestId: "r", ok: true };
      return OK;
    });
    return startAccountLogin("codex", "team");
  }

  it("keeps waiting through the drop and sends the wait again on reconnect, then finishes", async () => {
    conn.kind = "reconnecting";
    const done = startWith(new Error("connection lost (socket closed (code 1006))"), { type: "backend.login.wait.result", requestId: "r", ok: true });
    await vi.waitFor(() => expect(accountLoginState().reconnecting).toBe(true));
    // Still the same attempt: the link and code stay up, and Cancel can end it.
    expect(accountLoginState()).toMatchObject({ phase: "waiting", error: null, login: { loginId: "D1" } });
    expect(waits()).toHaveLength(1);

    conn.kind = "connected";
    resumeAccountLogin();
    expect(await done).toBe(true);
    expect(waits().map((c) => c[0].loginId)).toEqual(["D1", "D1"]);
    expect(accountLoginState()).toMatchObject({ phase: "idle", error: null, reconnecting: false });
    expect(clientRequestMock.mock.calls.some((c) => c[0].type === "accounts.list")).toBe(true);
  });

  it("a wait that timed out on a live socket simply asks again", async () => {
    const done = startWith(new Error("request r timed out"), { type: "backend.login.wait.result", requestId: "r", ok: true });
    expect(await done).toBe(true);
    expect(waits()).toHaveLength(2);
  });

  it("past expiry + the daemon's memory, a dropped wait gives up and points at the list", async () => {
    const OLD = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    clientRequestMock.mockImplementation(async (msg) => {
      if (msg.type === "backend.login.start") return { type: "backend.login.start.result", requestId: "r", login: DEVICE };
      if (msg.type === "backend.login.wait") {
        // The wait outlives the attempt and the daemon's memory of it.
        vi.setSystemTime(OLD + 60 * 60_000);
        throw new Error("request r timed out");
      }
      return OK;
    });
    const done = startAccountLogin("codex", "team");
    expect(await done).toBe(false);
    expect(accountLoginState().error).toMatch(/If you approved it, the account is listed/);
    vi.useRealTimers();
  });

  it("a wait woken past that deadline (a laptop that slept) gives up instead of asking again", async () => {
    const OLD = Date.now();
    conn.kind = "reconnecting";
    const done = startWith(new Error("connection lost (x)"));
    await vi.waitFor(() => expect(accountLoginState().reconnecting).toBe(true));
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(OLD + 60 * 60_000);
    conn.kind = "connected";
    resumeAccountLogin();
    expect(await done).toBe(false);
    vi.useRealTimers();
    expect(waits()).toHaveLength(1);
    expect(accountLoginState().error).toMatch(/If you approved it, the account is listed/);
  });

  it("times against the daemon's duration, not its clock: a browser 20 minutes ahead keeps waiting", async () => {
    const OLD = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(OLD + 20 * 60_000);
    // The daemon's absolute expiry is long past on this clock, but 10 minutes remain.
    const answers: unknown[] = [new Error("request r timed out"), { type: "backend.login.wait.result", requestId: "r", ok: true }];
    clientRequestMock.mockImplementation(async (msg) => {
      if (msg.type === "backend.login.start") {
        return { type: "backend.login.start.result", requestId: "r", login: { ...DEVICE, expiresAt: OLD + 60_000, expiresInMs: 10 * 60_000 } };
      }
      if (msg.type === "backend.login.wait") {
        const next = answers.shift();
        if (next instanceof Error) throw next;
        return next;
      }
      return OK;
    });
    const done = startAccountLogin("codex", "team");
    expect(await done).toBe(true);
    vi.useRealTimers();
  });

  it("a daemon refusal is not a dropped connection: it ends the attempt", async () => {
    const done = startWith(new Error("unknown sign-in attempt"));
    expect(await done).toBe(false);
    expect(accountLoginState()).toMatchObject({ phase: "idle", login: null, error: "unknown sign-in attempt" });
    expect(waits()).toHaveLength(1);
  });

  it("Cancel while disconnected queues the cancel for the reconnect and ends the parked wait", async () => {
    conn.kind = "reconnecting";
    const done = startWith(new Error("connection lost (x)"));
    await vi.waitFor(() => expect(accountLoginState().reconnecting).toBe(true));
    clientRequestMock.mockImplementation(async (msg) => {
      if (msg.type === "backend.login.cancel") throw new Error("cannot request while reconnecting");
      throw new Error("unexpected");
    });
    await cancelAccountLogin();
    expect(sendMock).toHaveBeenCalledWith(expect.objectContaining({ type: "backend.login.cancel", loginId: "D1" }));
    expect(await done).toBe(false);
    expect(accountLoginState().phase).toBe("idle");
    // Back online, nothing asks after the abandoned attempt.
    conn.kind = "connected";
    resumeAccountLogin();
    await Promise.resolve();
    expect(waits()).toHaveLength(1);
  });

  it("only the core client's transport failures count as a dropped connection", () => {
    for (const m of ["cannot request while reconnecting", "connection lost (bye)", "connection reset", "client shutdown", "request 1-2-x timed out"]) {
      expect(isConnectionError(new Error(m))).toBe(true);
    }
    expect(isConnectionError(new Error("That sign-in attempt was cancelled."))).toBe(false);
  });
});

describe("code sign-in — a rejected code", () => {
  const CODE = { loginId: "C1", backend: "claude" as const, verificationUrl: "https://claude.ai/x", codeHint: "", mode: "code" as const, expiresAt: 0 };

  async function submitWith(result: Record<string, unknown>) {
    clientRequestMock.mockImplementation(async (msg) => {
      if (msg.type === "backend.login.start") return { type: "backend.login.start.result", requestId: "r", login: CODE };
      if (msg.type === "backend.login.submit") return { type: "backend.login.submit.result", requestId: "r", ...result };
      return OK;
    });
    await startAccountLogin("claude", "personal");
    expect(accountLoginState().phase).toBe("awaiting_code");
    return submitAccountLoginCode("bad");
  }

  it("retryable: the attempt is still open, so the code form stays with the error", async () => {
    expect(await submitWith({ ok: false, retryable: true, error: "That doesn't look like a code." })).toBe(false);
    expect(accountLoginState()).toMatchObject({ phase: "awaiting_code", login: { loginId: "C1" }, error: "That doesn't look like a code." });
  });

  it("not retryable: the daemon ended the attempt, so the form starts over with the error", async () => {
    expect(await submitWith({ ok: false, error: "The code was rejected." })).toBe(false);
    expect(accountLoginState()).toMatchObject({ phase: "idle", login: null, error: "The code was rejected." });
  });
});
