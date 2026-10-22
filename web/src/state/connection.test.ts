import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * connection.ts wires the daemon's broadcasts and the client's status into the
 * stores. A fake CodeoidClient captures the handlers bootstrap() registers, so
 * a test can play a broadcast or a reconnect without a socket.
 */
const fake = vi.hoisted(() => ({
  onMessage: null as ((m: unknown) => void) | null,
  onStatus: null as ((s: { kind: string }) => void) | null,
  request: vi.fn(async (msg: { type: string; id: string }) => {
    if (msg.type === "session.list") return { type: "session.list.result", requestId: msg.id, sessions: [] };
    if (msg.type === "providers.list") return { type: "providers.result", requestId: msg.id, providers: [] };
    throw new Error(`unexpected ${msg.type}`);
  }),
}));
vi.mock("../lib/ws", () => ({
  CodeoidClient: class {
    onStatus(f: (s: { kind: string }) => void) {
      fake.onStatus = f;
    }
    onMessage(f: (m: unknown) => void) {
      fake.onMessage = f;
    }
    connect() {
      return Promise.resolve({ type: "auth.ok", identity: { sub: "u", type: "human" }, scopes: [] });
    }
    request(msg: { type: string; id: string }) {
      return fake.request(msg);
    }
    nextId() {
      return "r";
    }
    send() {}
    shutdown() {}
  },
}));
vi.mock("../lib/auth", () => ({
  resolveToken: async () => ({ token: "t" }),
  forgetOAuthToken: vi.fn(),
  jwtExpiryMs: () => null,
  readLocalModeToken: () => null,
  refreshAccessToken: vi.fn(),
  rememberedApiKey: () => null,
  rememberedOAuthToken: () => null,
  rememberedRefreshToken: () => null,
}));
const accounts = vi.hoisted(() => ({ refreshAccounts: vi.fn(), resumeAccountLogin: vi.fn() }));
vi.mock("./accounts", () => accounts);
const providers = vi.hoisted(() => ({ setProviders: vi.fn(), ingestAuthProviders: vi.fn() }));
vi.mock("./providers", () => providers);
vi.mock("./models", () => ({ fetchModels: vi.fn() }));

import { _setClientForTest, bootstrap } from "./connection";

beforeEach(async () => {
  await bootstrap({});
  accounts.refreshAccounts.mockClear();
  accounts.resumeAccountLogin.mockClear();
  providers.setProviders.mockClear();
});

afterEach(() => {
  _setClientForTest(null);
});

describe("connection routing — accounts", () => {
  it("accounts.changed refetches the account list", async () => {
    fake.onMessage!({ type: "accounts.changed", backend: "codex" });
    await vi.waitFor(() => expect(accounts.refreshAccounts).toHaveBeenCalledTimes(1));
    expect(providers.setProviders).not.toHaveBeenCalled();
  });

  it("providers.changed replaces the backend list and refetches accounts (an endpoint is a backend with accounts)", async () => {
    const list = [{ id: "oai:local", displayName: "local" }];
    fake.onMessage!({ type: "providers.changed", providers: list });
    expect(providers.setProviders).toHaveBeenCalledWith(list);
    await vi.waitFor(() => expect(accounts.refreshAccounts).toHaveBeenCalledTimes(1));
  });

  it("a reconnect refetches accounts and resumes a device sign-in's wait", async () => {
    fake.onStatus!({ kind: "connected" });
    await vi.waitFor(() => expect(accounts.resumeAccountLogin).toHaveBeenCalledTimes(1));
    expect(accounts.refreshAccounts).toHaveBeenCalledTimes(1);
  });

  it("no resume while the socket is still down", async () => {
    fake.onStatus!({ kind: "reconnecting" });
    await new Promise((r) => setTimeout(r, 0));
    expect(accounts.resumeAccountLogin).not.toHaveBeenCalled();
  });
});
