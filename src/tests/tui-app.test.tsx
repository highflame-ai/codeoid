/**
 * App-level slash handling and dialog lifetime for the backend pickers.
 *
 * Driven through the real App + store with a fake daemon client injected via
 * `createClient`, so the tests type commands into the prompt and read the
 * status bar exactly as a user would.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { PassThrough } from "node:stream";
import React from "react";
import { render } from "ink";
import { App } from "../tui/App.js";
import { TuiStoreProvider } from "../tui/store.js";
import type { CodeoidConfig } from "../config.js";
import type { DaemonMessage, SessionInfo } from "../protocol/types.js";
import type { TuiAction } from "../tui/types.js";
import type { TuiWsClient } from "../tui/ws.js";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

const info = (id: string, name: string, extra: Partial<SessionInfo> = {}): SessionInfo => ({
  id, name, workdir: "/tmp", status: "idle", createdBy: "user:me", createdAt: "2026-10-20T00:00:00Z",
  attachedClients: 1, providerId: "claude", effectiveClaudeAccount: "default", ...extra,
});

const ok = { type: "response.ok", requestId: "r" } as unknown as DaemonMessage;

class FakeClient {
  calls: Array<[string, ...unknown[]]> = [];
  reply: DaemonMessage = ok;
  constructor(public dispatch: React.Dispatch<TuiAction>) {}
  async start() {}
  stop() {}
  async attachSession() { return ok; }
  async setModel(sessionId: string, model: string) { this.calls.push(["setModel", sessionId, model]); return this.reply; }
  /** Like the daemon: a switch broadcasts the session's new info BEFORE the reply. */
  async setProvider(sessionId: string, providerId: string) {
    this.calls.push(["setProvider", sessionId, providerId]);
    if (this.reply.type === "response.ok") this.dispatch({ type: "session.info", session: info(sessionId, "alpha", { providerId }) });
    await Bun.sleep(20);
    return this.reply;
  }
  async createSession(name: string) {
    this.calls.push(["createSession", name]);
    await Bun.sleep(150);
    return { type: "response.ok", requestId: "r", data: info("s9", name) } as unknown as DaemonMessage;
  }
  async send(sessionId: string, text: string) { this.calls.push(["send", sessionId, text]); return ok; }
  async setClaudeAccount(sessionId: string, account: string | null) { this.calls.push(["setClaudeAccount", sessionId, account]); return this.reply; }
  async listClaudeAccounts() { return { defaultAccount: "default", accounts: [] }; }
  async listModels() { return { live: true, models: [] }; }
}

async function waitFor(predicate: () => boolean, frame = () => "") {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for TUI; last frame:\n${frame()}`);
    await Bun.sleep(10);
  }
}

async function mountApp() {
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => input, ref: () => input, unref: () => input });
  const output = Object.assign(new PassThrough(), { columns: 160, rows: 40, isTTY: true });
  let frame = "";
  output.on("data", (data: Buffer) => { frame = data.toString(); });
  // The scrollback writer prints session banners through console.log; keep
  // them out of the test output.
  const log = console.log;
  console.log = () => {};
  cleanups.push(() => { console.log = log; });
  let client!: FakeClient;
  const createClient = (_config: CodeoidConfig, dispatch: React.Dispatch<TuiAction>) => {
    client = new FakeClient(dispatch);
    return client as unknown as TuiWsClient;
  };
  const instance = render(
    <TuiStoreProvider>
      <App config={{} as CodeoidConfig} createClient={createClient} />
    </TuiStoreProvider>,
    {
      stdin: input as unknown as NodeJS.ReadStream,
      stdout: output as unknown as NodeJS.WriteStream,
      stderr: output as unknown as NodeJS.WriteStream,
      debug: true,
      patchConsole: false,
      exitOnCtrlC: false,
    },
  );
  cleanups.push(() => { instance.cleanup(); input.destroy(); output.destroy(); });
  await Bun.sleep(30);
  const act = async (action: TuiAction) => { client.dispatch(action); await Bun.sleep(30); };
  await act({ type: "connection.change", state: "connected" });
  await waitFor(() => frame.includes("● connected"), () => frame);
  /** Dispatch a session list and wait until the focused one is on screen. */
  const sessions = async (list: SessionInfo[]) => {
    await act({ type: "sessions.set", sessions: list });
    await waitFor(() => frame.includes(list[0]!.name), () => frame);
    // The prompt's input handler is (re)armed in an effect after that paint.
    await Bun.sleep(50);
  };
  return {
    client: () => client,
    frame: () => frame,
    act,
    sessions,
    press: async (key: string) => { input.write(key); await Bun.sleep(30); },
    run: async (command: string) => {
      input.write(command);
      await waitFor(() => frame.includes(command), () => frame);
      input.write("\r");
      await Bun.sleep(50);
    },
  };
}

describe("TUI App — backend slash commands", () => {
  it("/provider <id> switches the focused session's backend", async () => {
    const ui = await mountApp();
    await ui.sessions([info("s1", "alpha")]);
    await ui.run("/provider oai:box");
    expect(ui.client().calls).toEqual([["setProvider", "s1", "oai:box"]]);
  });

  it("/account --follow-default clears the pin (sends null)", async () => {
    const ui = await mountApp();
    await ui.sessions([info("s1", "alpha", { claudeAccount: "work" })]);
    await ui.run("/account --follow-default");
    expect(ui.client().calls).toEqual([["setClaudeAccount", "s1", null]]);
  });

  it("/account on a non-Claude session is refused with a visible error", async () => {
    const ui = await mountApp();
    await ui.sessions([info("s1", "alpha", { providerId: "oai:box", effectiveClaudeAccount: undefined })]);
    await ui.run("/account work");
    expect(ui.client().calls).toEqual([]);
    expect(ui.frame()).toContain("Claude accounts apply to Claude sessions");
  });

  it("a daemon refusal reaches the error display", async () => {
    const ui = await mountApp();
    await ui.sessions([info("s1", "alpha")]);
    ui.client().reply = { type: "response.error", requestId: "r", error: "Unknown provider: nope" } as unknown as DaemonMessage;
    await ui.run("/provider nope");
    await waitFor(() => ui.frame().includes("Unknown provider: nope"));
  });

  it("says so when no session is focused instead of doing nothing", async () => {
    // The prompt is disabled with no session, so the only way here is a
    // command typed while the last session is destroyed from elsewhere.
    const ui = await mountApp();
    for (const command of ["/model", "/provider", "/account"]) {
      await ui.act({ type: "error", message: "" });
      await ui.sessions([info("s1", "alpha")]);
      await ui.press(command);
      await ui.act({ type: "session.remove", sessionId: "s1" });
      await ui.press("\r");
      expect(ui.frame()).toContain("No session focused");
    }
    expect(ui.client().calls).toEqual([]);
  });
});

describe("TUI App — a dialog owns the keyboard", () => {
  it("a successful provider pick closes the picker, though the info update lands first", async () => {
    const ui = await mountApp();
    await ui.act({ type: "providers.set", providers: [
      { id: "claude", displayName: "Claude", kind: "builtin", isDefault: true },
      { id: "oai:box", displayName: "GPU box", kind: "endpoint", isDefault: false },
    ] });
    await ui.sessions([info("s1", "alpha")]);
    await ui.run("/provider");
    await waitFor(() => ui.frame().includes("Select provider for alpha"));
    await ui.press("\u001b[B");
    await ui.press("\r");
    await waitFor(() => !ui.frame().includes("Select provider"), ui.frame);
    expect(ui.client().calls).toEqual([["setProvider", "s1", "oai:box"]]);
  });

  it("arrows and Enter in a picker never recall or re-send prompt history", async () => {
    const ui = await mountApp();
    await ui.sessions([info("s1", "alpha")]);
    await ui.run("hello world");
    expect(ui.client().calls).toEqual([["send", "s1", "hello world"]]);
    await ui.run("/provider");
    await waitFor(() => ui.frame().includes("Select provider for alpha"));
    await ui.press("\u001b[A");
    await ui.press("\u001b[A");
    await ui.press("\r");
    await Bun.sleep(50);
    expect(ui.client().calls.filter(([call]) => call === "send")).toHaveLength(1);
  });

  it("typing and Enter in the new-session dialog never reach the focused session", async () => {
    const ui = await mountApp();
    await ui.sessions([info("s1", "alpha")]);
    await ui.press("\u000e"); // Ctrl-N
    await ui.press("abc");
    await ui.press("\r");
    await Bun.sleep(50);
    expect(ui.client().calls.filter(([call]) => call === "send")).toEqual([]);
  });
});

describe("TUI App — Esc during a create", () => {
  it("the session is still created, but focus stays where the user went", async () => {
    const ui = await mountApp();
    await ui.sessions([info("s1", "alpha")]);
    await ui.press("\u000e"); // Ctrl-N
    await ui.press("late");
    await ui.press("\t");
    await ui.press("/tmp");
    await ui.press("\r");
    await waitFor(() => ui.frame().includes("Creating…"), ui.frame);
    await ui.press("\u001b");
    await waitFor(() => !ui.frame().includes("New Session"), ui.frame);
    await Bun.sleep(250);
    expect(ui.client().calls).toEqual([["createSession", "late"]]);
    expect(ui.frame()).toContain("alpha ·");
  });
});

describe("TUI App — dialogs survive a focus change", () => {
  it("a new-session dialog opened before the session list arrives keeps its input", async () => {
    const ui = await mountApp();
    await ui.press("\u000e"); // Ctrl-N
    await ui.press("draft-name");
    expect(ui.frame()).toContain("draft-name");
    await ui.sessions([info("s1", "alpha")]);
    expect(ui.frame()).toContain("New Session");
    expect(ui.frame()).toContain("draft-name");
  });

  it("a picker stays on the session it was opened for when focus moves", async () => {
    const ui = await mountApp();
    await ui.act({ type: "providers.set", providers: [
      { id: "claude", displayName: "Claude", kind: "builtin", isDefault: true },
      { id: "oai:box", displayName: "GPU box", kind: "endpoint", isDefault: false },
    ] });
    await ui.sessions([info("s1", "alpha"), info("s2", "beta")]);
    await ui.run("/provider");
    await waitFor(() => ui.frame().includes("Select provider for alpha"));
    await ui.act({ type: "focus", sessionId: "s2" });
    expect(ui.frame()).toContain("Select provider for alpha");
    await ui.press("\u001b[B");
    await ui.press("\r");
    expect(ui.client().calls).toEqual([["setProvider", "s1", "oai:box"]]);
  });
});
