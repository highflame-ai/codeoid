// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

const request = vi.fn();
vi.mock("./connection", () => ({
  getClient: () => ({ request }),
  newRequestId: () => "req-1",
}));

import { _resetMcpOAuthForTest, adoptAndSignIn, mcpOAuthState } from "./mcp-oauth";
import { settingsState } from "./settings";

afterEach(() => {
  request.mockReset();
  _resetMcpOAuthForTest();
});

const snapshot = { values: {}, secrets: {}, configPath: "", envPath: "", mcpServers: [] };

describe("adoptAndSignIn (#390)", () => {
  it("adopts the server, then starts codeoid's sign-in for it", async () => {
    request
      .mockResolvedValueOnce({ type: "mcp.adopt.result", requestId: "req-1", server: "notes", alreadyAdopted: false, snapshot })
      .mockResolvedValueOnce({ type: "mcp.oauth.begin.result", requestId: "req-1", status: "redirect", url: "https://auth.example.com/authorize?x=1" });
    await adoptAndSignIn("notes", "s1", "https://notes.example.com/mcp");
    expect(request.mock.calls.map((c) => c[0])).toEqual([
      { type: "mcp.adopt", id: "req-1", server: "notes", sessionId: "s1", url: "https://notes.example.com/mcp" },
      { type: "mcp.oauth.begin", id: "req-1", server: "notes" },
    ]);
    expect(settingsState().snapshot).toEqual(snapshot);
    expect(mcpOAuthState()).toMatchObject({ server: "notes", phase: "awaiting_redirect", url: "https://auth.example.com/authorize?x=1" });
  });

  it("stops at a refused adopt, saying why", async () => {
    request.mockRejectedValueOnce(new Error("legacy uses the older SSE transport"));
    await adoptAndSignIn("legacy", null, null);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[0]).toEqual({ type: "mcp.adopt", id: "req-1", server: "legacy" });
    expect(mcpOAuthState()).toMatchObject({ server: "legacy", phase: "idle", error: "legacy uses the older SSE transport" });
  });
});
