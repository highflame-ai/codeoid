import { afterEach, describe, expect, it } from "bun:test";
import { PassThrough } from "node:stream";
import React from "react";
import { Box, render } from "ink";
import type { ProviderInfo } from "../protocol/types.js";
import { BackendPicker } from "../tui/components/BackendPicker.js";
import { NewSessionModal } from "../tui/components/NewSessionModal.js";
import type { TuiWsClient } from "../tui/ws.js";

const providers: ProviderInfo[] = [
  { id: "claude", displayName: "Claude", kind: "builtin", isDefault: true },
  { id: "oai:box", displayName: "GPU box", kind: "endpoint", isDefault: false },
];
const withCodex: ProviderInfo[] = [...providers, { id: "codex", displayName: "Codex", kind: "builtin", isDefault: false }, { id: "mock", displayName: "Mock", kind: "builtin", isDefault: false }];

/** A client whose daemon lists `names` (and `defaultAccount`) for every backend asked about. */
function accountsClient(names: Record<string, string[]>, defaultAccount = "default", requested: string[] = []) {
  return {
    listAccounts: async (backend: string) => {
      requested.push(backend);
      return { backend, displayName: backend, defaultAccount, kinds: [], accounts: (names[backend] ?? []).map((name) => ({ backend, name, kind: "api-key" })) };
    },
  } as unknown as TuiWsClient;
}
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
    const client = accountsClient({ claude: ["work"] }, "work");
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
    const client = accountsClient({ claude: ["work"] });
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
  it("closes on Esc while a switch is in flight and ignores its late result", async () => {
    let finish!: () => void;
    let closes = 0;
    const client = { listModels: async () => ({ live: true, models: [{ value: "m1", displayName: "Model one" }] }) } as unknown as TuiWsClient;
    const ui = await mount(<BackendPicker kind="model" provider="claude" current="" providers={providers} client={client}
      onPick={() => new Promise<void>((resolve) => { finish = resolve; })} onCancel={() => { closes++; }} />);
    await waitFor(() => ui.frame().includes("Model one"));
    await ui.press("\r");
    expect(ui.frame()).toContain("Switching…");
    await ui.press("\u001b");
    expect(closes).toBe(1);
    // The parent unmounts the closed picker; the switch then lands.
    ui.rerender(<Box />);
    finish();
    await Bun.sleep(30);
    expect(closes).toBe(1);
  });

  it("offers a retry only for an endpoint whose /models failed", async () => {
    const client = { listModels: async () => ({ live: false, models: [{ value: "m1", displayName: "Model one" }] }) } as unknown as TuiWsClient;
    const builtin = await mount(<BackendPicker kind="model" provider="codex" sessionName="feature-auth" current="" providers={providers} client={client}
      onPick={async () => {}} onCancel={() => {}} />);
    await waitFor(() => builtin.frame().includes("Model one"));
    expect(builtin.frame()).toContain("for feature-auth");
    expect(builtin.frame()).toContain("appears after this backend's next turn");
    expect(builtin.frame()).not.toContain("press r to retry");
    const endpoint = await mount(<BackendPicker kind="model" provider="oai:box" current="" providers={providers} client={client}
      onPick={async () => {}} onCancel={() => {}} />);
    await waitFor(() => endpoint.frame().includes("Model one"));
    expect(endpoint.frame()).toContain("press r to retry");
  });

  it("says a name is required instead of ignoring Enter", async () => {
    const submissions: unknown[] = [];
    const ui = await mount(<NewSessionModal providers={providers} client={null} onCancel={() => {}}
      onSubmit={async (name) => { submissions.push(name); }} />);
    await ui.press("\t");
    await ui.press("\r");
    expect(ui.frame()).toContain("Name required");
    expect(ui.frame()).toContain("▸ name:");
    expect(submissions).toEqual([]);
    await ui.press("x");
    expect(ui.frame()).not.toContain("Name required");
  });

  it("closes the new-session dialog on Esc mid-create and ignores the late result", async () => {
    let fail!: (cause: Error) => void;
    let closes = 0;
    const ui = await mount(<NewSessionModal providers={providers} client={null} onCancel={() => { closes++; }}
      onSubmit={() => new Promise<void>((_resolve, reject) => { fail = reject; })} />);
    await ui.press("draft");
    await ui.press("\t");
    await ui.press("\r");
    expect(ui.frame()).toContain("Creating…");
    await ui.press("\u001b");
    expect(closes).toBe(1);
    ui.rerender(<Box />);
    fail(new Error("too late"));
    await Bun.sleep(30);
    expect(closes).toBe(1);
  });

  it("sends the chosen Claude account when Claude is the provider", async () => {
    const submissions: unknown[] = [];
    const client = accountsClient({ claude: ["work"] });
    const ui = await mount(<NewSessionModal providers={providers} client={client} onCancel={() => {}}
      onSubmit={async (name, workdir, options) => { submissions.push({ name, workdir, ...options }); }} />);
    await ui.press("claude-work");
    await ui.press("\t");
    await ui.press("\t");
    await ui.press("\u001b[C");
    expect(ui.frame()).toContain("provider: Claude (claude)");
    await ui.press("\t");
    await waitFor(() => ui.frame().includes("Follow daemon default (default)"));
    await ui.press("\u001b[D");
    expect(ui.frame()).toContain("account: work");
    await ui.press("\r");
    expect(submissions).toEqual([{ name: "claude-work", workdir: process.cwd(), providerId: "claude", account: "work" }]);
  });

  it("offers the selected backend's own accounts and sends the one chosen for a Codex session", async () => {
    const submissions: unknown[] = [];
    const requested: string[] = [];
    const client = accountsClient({ claude: ["work"], codex: ["chatgpt-home"] }, "default", requested);
    const ui = await mount(<NewSessionModal providers={withCodex} client={client} onCancel={() => {}}
      onSubmit={async (name, workdir, options) => { submissions.push({ name, workdir, ...options }); }} />);
    await ui.press("codex-work");
    await ui.press("\t");
    await ui.press("\t");
    // A Claude account picked first must not follow the session to Codex.
    await ui.press("\t");
    await waitFor(() => ui.frame().includes("Follow daemon default"));
    await ui.press("\u001b[D");
    expect(ui.frame()).toContain("account: work");
    await ui.press("\u001b[Z");
    for (let i = 0; i < 3; i++) await ui.press("\u001b[C");
    expect(ui.frame()).toContain("provider: Codex (codex)");
    await waitFor(() => requested.includes("codex"));
    expect(ui.frame()).toContain("account: Follow daemon default (default)");
    expect(ui.frame()).not.toContain("account: work");
    await ui.press("\t");
    await ui.press("\u001b[D");
    expect(ui.frame()).toContain("account: chatgpt-home");
    await ui.press("\r");
    expect(submissions).toEqual([{ name: "codex-work", workdir: process.cwd(), providerId: "codex", account: "chatgpt-home" }]);
  });

  it("has no account field for a backend without accounts", async () => {
    const submissions: unknown[] = [];
    const requested: string[] = [];
    const ui = await mount(<NewSessionModal providers={withCodex} client={accountsClient({}, "default", requested)} onCancel={() => {}}
      onSubmit={async (name, workdir, options) => { submissions.push({ name, workdir, ...options }); }} />);
    await ui.press("mocked");
    await ui.press("\t");
    await ui.press("\t");
    await ui.press("\u001b[D");
    expect(ui.frame()).toContain("provider: Mock (mock)");
    expect(ui.frame()).not.toContain("account:");
    // Tab wraps straight back to the name: there is no account field to land on.
    await ui.press("\t");
    expect(ui.frame()).toContain("▸ name:");
    await ui.press("\u001b[Z");
    await ui.press("\r");
    expect(submissions).toEqual([{ name: "mocked", workdir: process.cwd(), providerId: "mock" }]);
    expect(requested).not.toContain("mock");
  });

  it("marks a selected provider that disappears as removed and shows the daemon's refusal", async () => {
    const props = {
      client: null,
      onCancel: () => {},
      onSubmit: async () => { throw new Error("Unknown provider: oai:box"); },
    };
    const ui = await mount(<NewSessionModal {...props} providers={providers} />);
    await ui.press("gpu");
    await ui.press("\t");
    await ui.press("\t");
    await ui.press("\u001b[D");
    expect(ui.frame()).toContain("GPU box");
    ui.rerender(<NewSessionModal {...props} providers={providers.slice(0, 1)} />);
    await waitFor(() => ui.frame().includes("oai:box (removed)"));
    await ui.press("\r");
    expect(ui.frame()).toContain("Unknown provider: oai:box");
  });
});
