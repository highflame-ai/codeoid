/**
 * MCP OAuth through a real daemon: `mcp.oauth.begin` over the socket, the
 * provider's redirect into the daemon's own callback route, and the settings
 * snapshot reporting the tenant connected — the wiring the unit tests can't see.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config.js";
import { DaemonServer } from "../daemon/server.js";
import { mintLocalToken } from "../daemon/local-auth.js";
import type { DaemonMessage, McpServerStatus } from "../protocol/types.js";
import { FakeOAuthMcp } from "./fixtures/fake-oauth-mcp.js";

const TOKEN = mintLocalToken();

let dir: string;
let prevXdg: string | undefined;
let fake: FakeOAuthMcp;
let daemon: DaemonServer;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "codeoid-mcp-oauth-server-"));
  prevXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = dir;
  fake = new FakeOAuthMcp();
  const fullConfig = loadConfig({
    quiet: true,
    raw: { memory: { enabled: false }, mcpServers: { notes: { url: fake.mcpUrl, oauth: true } } },
  });
  daemon = new DaemonServer({
    port: 0,
    host: "127.0.0.1",
    dbPath: join(dir, "codeoid.db"),
    transcriptDir: join(dir, "transcripts"),
    auth: { baseUrl: "http://127.0.0.1:1/unreachable-issuer" },
    localMode: { token: TOKEN },
    fullConfig,
  });
  await daemon.start();
});

afterAll(async () => {
  await daemon.stop();
  fake.stop();
  if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = prevXdg;
  rmSync(dir, { recursive: true, force: true });
});

/** An authenticated socket that answers one request at a time. */
async function connect(): Promise<{ request: (msg: Record<string, unknown>) => Promise<DaemonMessage>; close: () => void }> {
  const ws = new WebSocket(`ws://127.0.0.1:${daemon.port}`);
  const waiting = new Map<string, (m: DaemonMessage) => void>();
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => ws.send(JSON.stringify({ type: "auth", token: TOKEN }));
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data)) as DaemonMessage & { requestId?: string };
      if (msg.type === "auth.ok") resolve();
      if (msg.requestId) waiting.get(msg.requestId)?.(msg);
    };
    ws.onclose = (ev) => reject(new Error(`closed ${ev.code} ${ev.reason}`));
  });
  let seq = 0;
  return {
    request: (msg) =>
      new Promise((resolve) => {
        const id = `r${++seq}`;
        waiting.set(id, resolve);
        ws.send(JSON.stringify({ ...msg, id }));
      }),
    close: () => ws.close(),
  };
}

const notesStatus = (m: DaemonMessage) =>
  (m as { snapshot: { mcpServers?: McpServerStatus[] } }).snapshot.mcpServers?.find((s) => s.name === "notes");

describe("MCP OAuth through the daemon", () => {
  it("signs in through the daemon's callback route", async () => {
    const c = await connect();
    try {
      expect(notesStatus(await c.request({ type: "settings.get" }))?.oauth?.status).toBe("disconnected");

      const begun = (await c.request({ type: "mcp.oauth.begin", server: "notes" })) as {
        status: string;
        url: string;
        browserBinding: { cookie: string; value: string };
      };
      expect(begun.status).toBe("redirect");
      // The redirect URI is the daemon's live port, not the configured 0.
      expect(new URL(begun.url).searchParams.get("redirect_uri")).toBe(
        `http://127.0.0.1:${daemon.port}/mcp/oauth/callback`,
      );

      // The browser that started it (holding the binding cookie the web UI
      // set): approve at the provider, then land on the daemon.
      const approved = await fetch(begun.url, { redirect: "manual" });
      const page = await fetch(approved.headers.get("location")!, {
        headers: { Cookie: `other=1; ${begun.browserBinding.cookie}=${begun.browserBinding.value}` },
      });
      expect(page.status).toBe(200);
      expect(page.headers.get("cache-control")).toBe("no-store");
      expect(page.headers.get("set-cookie")).toContain(`${begun.browserBinding.cookie}=; Path=/; Max-Age=0`);
      expect(await page.text()).toContain("notes is connected");

      expect(notesStatus(await c.request({ type: "settings.get" }))?.oauth?.status).toBe("connected");
    } finally {
      c.close();
    }
  });

  it("does not complete a sign-in for a browser that did not start it", async () => {
    const c = await connect();
    try {
      await c.request({ type: "mcp.oauth.disconnect", server: "notes" });
      const begun = (await c.request({ type: "mcp.oauth.begin", server: "notes" })) as { url: string };
      const approved = await fetch(begun.url, { redirect: "manual" });
      const callbackUrl = approved.headers.get("location")!;
      // Someone else's browser — no binding cookie.
      const page = await fetch(callbackUrl);
      expect(page.status).toBe(400);
      expect(await page.text()).toContain("did not start this sign-in");
      expect(notesStatus(await c.request({ type: "settings.get" }))?.oauth?.status).toBe("disconnected");
      // The starter can still finish by pasting the address.
      const done = await c.request({ type: "mcp.oauth.complete", callbackUrl });
      expect(done.type).toBe("mcp.oauth.complete.result");
      expect(notesStatus(done)?.oauth?.status).toBe("connected");
    } finally {
      c.close();
    }
  });

  it("shows a failure page — with the text escaped — for a forged or replayed callback", async () => {
    const page = await fetch(
      `http://127.0.0.1:${daemon.port}/mcp/oauth/callback?state=%3Cscript%3E&code=x`,
    );
    expect(page.status).toBe(400);
    const html = await page.text();
    expect(html).toContain("Sign-in did not complete");
    expect(html).not.toContain("<script>");
  });
});
