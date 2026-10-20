import { afterEach, describe, expect, it } from "bun:test";
import { PassThrough } from "node:stream";
import React from "react";
import { render } from "ink";
import type { ProviderInfo } from "../protocol/types.js";
import { BackendPicker } from "../tui/components/BackendPicker.js";
import { NewSessionModal } from "../tui/components/NewSessionModal.js";
import type { TuiWsClient } from "../tui/ws.js";

const providers: ProviderInfo[] = [
  { id: "claude", displayName: "Claude", kind: "builtin", isDefault: true },
  { id: "oai:box", displayName: "GPU box", kind: "endpoint", isDefault: false },
];
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for TUI");
    await Bun.sleep(10);
  }
}

async function mount(element: React.ReactElement) {
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => input, ref: () => input, unref: () => input });
  const output = Object.assign(new PassThrough(), { columns: 140, rows: 40, isTTY: true });
  let frame = "";
  output.on("data", (data: Buffer) => { frame = data.toString(); });
  const instance = render(element, {
    stdin: input as unknown as NodeJS.ReadStream,
    stdout: output as unknown as NodeJS.WriteStream,
    stderr: output as unknown as NodeJS.WriteStream,
    debug: true,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  cleanups.push(() => { instance.cleanup(); input.destroy(); output.destroy(); });
  await Bun.sleep(30);
  return {
    frame: () => frame,
    rerender: instance.rerender,
    press: async (key: string) => { input.write(key); await Bun.sleep(30); },
  };
}

describe("TUI backend dialogs", () => {
  it("uses the endpoint model catalog and keeps a rejected switch open", async () => {
    const requested: string[] = [];
    const picked: string[] = [];
    let closed = false;
    const client = {
      listModels: async (provider: string) => {
        requested.push(provider);
        return { live: true, models: [{ value: "local-model", displayName: "Local model", contextWindow: 32768 }] };
      },
    } as unknown as TuiWsClient;
    const ui = await mount(<BackendPicker kind="model" provider="oai:box" current="" providers={providers} client={client}
      onPick={async (value) => { picked.push(value); throw new Error("Session is mid-turn"); }} onCancel={() => { closed = true; }} />);
    await waitFor(() => ui.frame().includes("Local model"));
    expect(requested).toEqual(["oai:box"]);
    expect(ui.frame()).not.toContain("Opus");
    await ui.press("\r");
    expect(picked).toEqual(["local-model"]);
    expect(ui.frame()).toContain("Session is mid-turn");
    expect(closed).toBe(false);
    await ui.press("\u001b");
    expect(closed).toBe(true);
  });

  it("distinguishes following the daemon default from pinning the machine login", async () => {
    const picked: string[] = [];
    const client = { listClaudeAccounts: async () => ({ defaultAccount: "work", accounts: [{ name: "work", kind: "subscription" }] }) } as unknown as TuiWsClient;
    const ui = await mount(<BackendPicker kind="account" provider="claude" current="work" providers={providers} client={client}
      onPick={async (value) => { picked.push(value); }} onCancel={() => {}} />);
    await waitFor(() => ui.frame().includes("Follow daemon default (work)"));
    await ui.press("\u001b[A");
    await ui.press("\r");
    expect(picked).toEqual(["default"]);
    await ui.press("\u001b[A");
    await ui.press("\r");
    expect(picked).toEqual(["default", ""]);
  });

  it("updates provider choices while the picker is open", async () => {
    const picked: string[] = [];
    const props = { kind: "provider" as const, provider: "claude", current: "claude", client: null, onPick: async (value: string) => { picked.push(value); }, onCancel: () => {} };
    const ui = await mount(<BackendPicker {...props} providers={providers.slice(0, 1)} />);
    ui.rerender(<BackendPicker {...props} providers={providers} />);
    await waitFor(() => ui.frame().includes("GPU box"));
    await ui.press("\u001b[B");
    await ui.press("\r");
    expect(picked).toEqual(["oai:box"]);
  });

  it("creates on a chosen endpoint without leaking a previously selected Claude account", async () => {
    const submissions: unknown[] = [];
    const client = { listClaudeAccounts: async () => ({ defaultAccount: "default", accounts: [{ name: "work", kind: "subscription" }] }) } as unknown as TuiWsClient;
    const ui = await mount(<NewSessionModal providers={providers} client={client} onCancel={() => {}}
      onSubmit={async (name, workdir, options) => { submissions.push({ name, workdir, ...options }); }} />);
    await ui.press("local-work");
    await ui.press("\t");
    await ui.press("\t");
    await ui.press("\t");
    await ui.press("\u001b[D");
    expect(ui.frame()).toContain("account: work");
    await ui.press("\u001b[Z");
    await ui.press("\u001b[D");
    expect(ui.frame()).toContain("GPU box");
    expect(ui.frame()).not.toContain("account: work");
    await ui.press("\r");
    expect(submissions).toEqual([{ name: "local-work", workdir: process.cwd(), providerId: "oai:box" }]);
  });

  it("preserves new-session input when creation is refused", async () => {
    let closed = false;
    const ui = await mount(<NewSessionModal providers={providers} client={null} onCancel={() => { closed = true; }}
      onSubmit={async () => { throw new Error("Endpoint was removed"); }} />);
    await ui.press("draft");
    await ui.press("\t");
    await ui.press("\r");
    expect(ui.frame()).toContain("Endpoint was removed");
    expect(ui.frame()).toContain("draft");
    expect(closed).toBe(false);
  });
});
