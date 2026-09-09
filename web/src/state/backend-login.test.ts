// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";

const clientRequestMock = vi.hoisted(() => vi.fn());
vi.mock("./connection", () => ({
  newRequestId: () => "r",
  getClient: () => ({ request: clientRequestMock }),
}));

import {
  backendLoginState,
  cancelBackendLogin,
  dismissBackendLogin,
  startBackendLogin,
  submitBackendLoginCode,
  _resetBackendLoginForTest,
} from "./backend-login";
import { settingsState, _resetSettingsForTest } from "./settings";

afterEach(() => {
  _resetBackendLoginForTest();
  _resetSettingsForTest();
  clientRequestMock.mockReset();
});

const LOGIN = {
  loginId: "L1",
  backend: "claude" as const,
  verificationUrl: "https://claude.com/cai/oauth/authorize?code=true",
  expiresAt: Date.now() + 600_000,
  codeHint: "Paste the code the page shows.",
};

const SNAPSHOT = {
  values: {},
  secrets: { CLAUDE_CODE_OAUTH_TOKEN: { set: true, source: "env-file" as const } },
  configPath: "/home/u/.codeoid/config.json",
  envPath: "/home/u/.codeoid/.env",
};

function startResult() {
  return { type: "backend.login.start.result", requestId: "r", login: LOGIN };
}

describe("backend login", () => {
  it("holds the URL to show once the daemon has one", async () => {
    clientRequestMock.mockResolvedValueOnce(startResult());
    await startBackendLogin("claude");
    expect(backendLoginState().phase).toBe("awaiting_code");
    expect(backendLoginState().login?.verificationUrl).toBe(LOGIN.verificationUrl);
    expect(backendLoginState().error).toBeNull();
  });

  it("a start that fails leaves the panel usable, with the reason", async () => {
    clientRequestMock.mockRejectedValueOnce(new Error("claude is not installed"));
    await startBackendLogin("claude");
    // Back to idle, not stuck in `starting` — the button must be pressable again.
    expect(backendLoginState().phase).toBe("idle");
    expect(backendLoginState().error).toContain("not installed");
  });

  it("a successful submit adopts the snapshot, so the credential shows as set", async () => {
    clientRequestMock
      .mockResolvedValueOnce(startResult())
      .mockResolvedValueOnce({
        type: "backend.login.submit.result",
        requestId: "r",
        ok: true,
        snapshot: SNAPSHOT,
      });

    await startBackendLogin("claude");
    expect(await submitBackendLoginCode("the-code")).toBe(true);

    expect(backendLoginState().phase).toBe("done");
    expect(backendLoginState().login).toBeNull();
    // No second round trip: the snapshot rode back on the submit result.
    expect(clientRequestMock).toHaveBeenCalledTimes(2);
    expect(settingsState().snapshot?.secrets.CLAUDE_CODE_OAUTH_TOKEN?.set).toBe(true);
  });

  it("a rejected code ends the attempt and surfaces the daemon's reason", async () => {
    clientRequestMock.mockResolvedValueOnce(startResult()).mockResolvedValueOnce({
      type: "backend.login.submit.result",
      requestId: "r",
      ok: false,
      error: "OAuth error: status code 400. Start the sign-in again.",
      snapshot: SNAPSHOT,
    });

    await startBackendLogin("claude");
    expect(await submitBackendLoginCode("wrong")).toBe(false);

    expect(backendLoginState().phase).toBe("idle");
    // The attempt is spent — the URL must go, or the user retries into a dead one.
    expect(backendLoginState().login).toBeNull();
    expect(backendLoginState().error).toContain("OAuth error");
  });

  it("submitting with nothing in flight is a no-op, not a request", async () => {
    expect(await submitBackendLoginCode("code")).toBe(false);
    expect(clientRequestMock).not.toHaveBeenCalled();
  });

  it("cancel clears locally even when the daemon never answers", async () => {
    clientRequestMock
      .mockResolvedValueOnce(startResult())
      .mockRejectedValueOnce(new Error("socket closed"));

    await startBackendLogin("claude");
    await cancelBackendLogin();
    // A user who pressed cancel must not be left staring at a dead URL because
    // the cancel message did not land; the daemon's TTL covers its side.
    expect(backendLoginState().phase).toBe("idle");
    expect(backendLoginState().login).toBeNull();
  });

  it("dismiss clears the panel without talking to the daemon", async () => {
    clientRequestMock.mockResolvedValueOnce(startResult()).mockResolvedValueOnce({
      type: "backend.login.submit.result",
      requestId: "r",
      ok: true,
      snapshot: SNAPSHOT,
    });
    await startBackendLogin("claude");
    await submitBackendLoginCode("the-code");
    clientRequestMock.mockClear();

    dismissBackendLogin();
    expect(backendLoginState().phase).toBe("idle");
    expect(clientRequestMock).not.toHaveBeenCalled();
  });
});
