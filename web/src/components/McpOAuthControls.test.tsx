// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent } from "@solidjs/testing-library";

const request = vi.fn();
vi.mock("../state/connection", () => ({
  getClient: () => ({ request }),
  newRequestId: () => "req-1",
}));

import { McpOAuthControls } from "./McpOAuthControls";
import { _resetMcpOAuthForTest } from "../state/mcp-oauth";
import type { McpServerStatus } from "../protocol/types";

afterEach(() => {
  cleanup();
  request.mockReset();
  _resetMcpOAuthForTest();
});

function server(status: "connected" | "disconnected", unsupportedBackends: string[] = []): McpServerStatus {
  return {
    name: "notes",
    transport: "http",
    trust: "prompt",
    scope: "workspace",
    backends: null,
    enabled: true,
    builtin: false,
    health: "idle",
    toolCount: 0,
    tools: [],
    oauth: { status, unsupportedBackends },
  };
}

describe("McpOAuthControls", () => {
  it("offers Connect, then the sign-in link and the paste fallback", async () => {
    request.mockResolvedValueOnce({
      type: "mcp.oauth.begin.result",
      requestId: "req-1",
      status: "redirect",
      url: "https://auth.example.com/authorize?state=s",
      browserBinding: { cookie: "codeoid_mcp_oauth_s", value: "b1nd" },
    });
    const { getByText, findByText, getByPlaceholderText } = render(() => (
      <McpOAuthControls server={server("disconnected")} />
    ));
    expect(getByText("not signed in")).toBeTruthy();
    fireEvent.click(getByText("Connect"));
    expect(request.mock.calls[0]?.[0]).toEqual({ type: "mcp.oauth.begin", id: "req-1", server: "notes" });
    const link = (await findByText("https://auth.example.com/authorize?state=s")) as HTMLAnchorElement;
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(getByPlaceholderText(/mcp\/oauth\/callback/)).toBeTruthy();
    // This browser holds the binding the daemon's callback checks.
    expect(document.cookie).toContain("codeoid_mcp_oauth_s=b1nd");
  });

  it("finishes from a pasted callback address", async () => {
    request
      .mockResolvedValueOnce({ type: "mcp.oauth.begin.result", requestId: "req-1", status: "redirect", url: "https://a/x" })
      .mockResolvedValueOnce({ type: "mcp.oauth.complete.result", requestId: "req-1", server: "notes", snapshot: { values: {}, secrets: {}, configPath: "", envPath: "" } });
    const { getByText, findByPlaceholderText } = render(() => <McpOAuthControls server={server("disconnected")} />);
    fireEvent.click(getByText("Connect"));
    const input = await findByPlaceholderText(/mcp\/oauth\/callback/);
    fireEvent.input(input, { target: { value: "  http://127.0.0.1:7400/mcp/oauth/callback?code=c&state=s " } });
    fireEvent.click(getByText("Finish"));
    await Promise.resolve();
    expect(request.mock.calls[1]?.[0]).toEqual({
      type: "mcp.oauth.complete",
      id: "req-1",
      callbackUrl: "http://127.0.0.1:7400/mcp/oauth/callback?code=c&state=s",
    });
  });

  it("offers Disconnect when signed in, and names the backends it cannot reach yet", () => {
    request.mockResolvedValueOnce({ type: "mcp.oauth.disconnect.result", requestId: "req-1", snapshot: { values: {}, secrets: {}, configPath: "", envPath: "" } });
    const { getByText, container } = render(() => (
      <McpOAuthControls server={server("connected", ["claude", "codex"])} />
    ));
    expect(getByText("signed in")).toBeTruthy();
    expect(container.textContent).toContain("not mounted on claude, codex");
    fireEvent.click(getByText("Disconnect"));
    expect(request.mock.calls[0]?.[0]).toEqual({ type: "mcp.oauth.disconnect", id: "req-1", server: "notes" });
  });
});
