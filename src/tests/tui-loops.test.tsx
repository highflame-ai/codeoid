/**
 * `/loops` in the TUI: the run list, a run's detail, and its controls, driven
 * through the real component (and, for the slash commands, the real App) with
 * a fake daemon client.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { PassThrough } from "node:stream";
import React from "react";
import { render } from "ink";
import { App } from "../tui/App.js";
import { LoopsModal, type LoopsClient } from "../tui/components/LoopsModal.js";
import { TuiStoreProvider } from "../tui/store.js";
import type { CodeoidConfig } from "../config.js";
import type { DaemonMessage, LoopAttemptWire, LoopRunWire, SessionInfo } from "../protocol/types.js";
import type { TuiAction } from "../tui/types.js";
import type { TuiWsClient } from "../tui/ws.js";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

const RUN_ID = "loop_0a1b2c3d-0000-4000-8000-000000000001";

function run(over: Partial<LoopRunWire> = {}): LoopRunWire {
  return {
    id: RUN_ID, recipe: "repair", objective: "Fix the checkout test", workdir: "/repo",
    checks: [{ id: "unit", command: "bun test src/checkout", timeoutSec: 600 }],
    limits: { attempts: 3, attemptMinutes: 10, runMinutes: 30 }, toolBudget: 60,
    status: "running", reason: "attempt 1 started", waitingOn: null, waitingKind: null, baseRevision: "0123456789abcdef",
    branch: "codeoid/loop-0a1b2c3d", worktreePath: "/wt", workerSessionId: "sess-worker", acceptedAttemptId: null,
    deliveredCommit: null, attempts: 1, activeMs: 30_000, costUsd: 0.12,
    createdAt: "2026-10-25T10:00:00.000Z", updatedAt: "2026-10-25T10:00:30.000Z", endedAt: null, ...over,
  };
}

const attempt: LoopAttemptWire = {
  id: "att_1", ordinal: 1, status: "done", result: "unverified", note: "1 of 1 checks failed",
  report: { outcome: "ready_for_verification", summary: "Rounded before tax" }, candidateTree: "t",
  evidenceIds: ["ev_abc"], workerSessionId: "sess-worker", provider: "claude", model: null,
  startedAt: "2026-10-25T10:00:00.000Z", endedAt: "2026-10-25T10:01:00.000Z", costUsd: 0.1,
};

class FakeLoops implements LoopsClient {
  calls: unknown[][] = [];
  current: LoopRunWire;
  constructor(r: LoopRunWire = run()) { this.current = r; }
  snapshot(): DaemonMessage {
    return { type: "loop.snapshot", requestId: "r", run: this.current, attempts: [attempt] } as DaemonMessage;
  }
  async loopList() { return { type: "loop.list.result", requestId: "r", runs: [this.current] } as DaemonMessage; }
  async loopGet(runId: string, events?: boolean) {
    this.calls.push(["get", runId, events === true]);
    return { ...this.snapshot(), ...(events ? { events: [{ seq: 1, at: "2026-10-25T10:00:00.000Z", actor: "u", type: "run.started", detail: "" }] } : {}) } as DaemonMessage;
  }
  async loopControl(verb: string, runId: string) {
    this.calls.push([verb, runId]);
    this.current = { ...this.current, status: verb === "pause" ? "paused" : verb === "cancel" ? "cancelled" : "running" };
    return this.snapshot();
  }
  async loopSteer(runId: string, text: string) {
    this.calls.push(["steer", runId, text]);
    return this.snapshot();
  }
}

async function waitFor(predicate: () => boolean, frame = () => "") {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for TUI; last frame:\n${frame()}`);
    await Bun.sleep(10);
  }
}

function streams() {
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => input, ref: () => input, unref: () => input });
  const output = Object.assign(new PassThrough(), { columns: 160, rows: 50, isTTY: true });
  return { input, output };
}

async function mount(element: React.ReactElement) {
  const { input, output } = streams();
  let frame = "";
  output.on("data", (data: Buffer) => { frame = data.toString(); });
  const instance = render(element, {
    stdin: input as unknown as NodeJS.ReadStream,
    stdout: output as unknown as NodeJS.WriteStream,
    stderr: output as unknown as NodeJS.WriteStream,
    debug: true, patchConsole: false, exitOnCtrlC: false,
  });
  cleanups.push(() => { instance.cleanup(); input.destroy(); output.destroy(); });
  await Bun.sleep(30);
  return {
    frame: () => frame,
    press: async (key: string) => { input.write(key); await Bun.sleep(30); },
  };
}

describe("TUI loops view", () => {
  it("lists runs and opens one on Enter with its contract, attempts and evidence", async () => {
    const client = new FakeLoops();
    const ui = await mount(<LoopsModal client={client} onOpenSession={() => {}} onCancel={() => {}} />);
    await waitFor(() => ui.frame().includes("Fix the checkout test"), ui.frame);
    expect(ui.frame()).toContain("1/3");
    await ui.press("\r");
    await waitFor(() => ui.frame().includes("codeoid/loop-0a1b2c3d"), ui.frame);
    const f = ui.frame();
    expect(f).toContain("#1 unverified");
    expect(f).toContain("Rounded before tax");
    expect(f).toContain("ev_abc");
    expect(f).toContain("p pause");
    await ui.press("h");
    await waitFor(() => ui.frame().includes("run.started"), ui.frame);
    expect(client.calls).toContainEqual(["get", RUN_ID, true]);
  });

  it("answers the worker's question with s", async () => {
    const client = new FakeLoops(run({ status: "waiting", waitingOn: "the owner's answer: Keep the v1 API?" }));
    const ui = await mount(<LoopsModal client={client} initialRunId={RUN_ID} onOpenSession={() => {}} onCancel={() => {}} />);
    await waitFor(() => ui.frame().includes("The worker asks: Keep the v1 API?"), ui.frame);
    expect(ui.frame()).toContain("s answer");
    await ui.press("s");
    await waitFor(() => ui.frame().includes("Your answer:"), ui.frame);
    await ui.press("Yes, keep it");
    await ui.press("\r");
    await waitFor(() => client.calls.some((c) => c[0] === "steer"), ui.frame);
    expect(client.calls).toContainEqual(["steer", RUN_ID, "Yes, keep it"]);
    await waitFor(() => ui.frame().includes("Answer sent."), ui.frame);
  });

  it("pauses, resumes, and cancels only after y", async () => {
    const client = new FakeLoops();
    const ui = await mount(<LoopsModal client={client} initialRunId={RUN_ID} onOpenSession={() => {}} onCancel={() => {}} />);
    await waitFor(() => ui.frame().includes("p pause"), ui.frame);
    await ui.press("p");
    await waitFor(() => ui.frame().includes("r resume"), ui.frame);
    await ui.press("r");
    await waitFor(() => ui.frame().includes("p pause"), ui.frame);
    await ui.press("c");
    await waitFor(() => ui.frame().includes("Stop the run now?"), ui.frame);
    expect(client.calls.filter((c) => c[0] === "cancel")).toHaveLength(0);
    await ui.press("y");
    await waitFor(() => ui.frame().includes("Cancelled by you."), ui.frame);
    expect(client.calls.filter((c) => c[0] !== "get")).toEqual([["pause", RUN_ID], ["resume", RUN_ID], ["cancel", RUN_ID]]);
    expect(ui.frame()).not.toContain("p pause");
  });

  it("says a verified run apart from one out of budget", async () => {
    const done = await mount(<LoopsModal client={new FakeLoops(run({ status: "completed", deliveredCommit: "abc123def4567890" }))} initialRunId={RUN_ID} onOpenSession={() => {}} onCancel={() => {}} />);
    await waitFor(() => done.frame().includes("Verified: every check passed"), done.frame);
    expect(done.frame()).toContain("delivered  abc123def456");
    const spent = await mount(<LoopsModal client={new FakeLoops(run({ status: "budget_exhausted" }))} initialRunId={RUN_ID} onOpenSession={() => {}} onCancel={() => {}} />);
    await waitFor(() => spent.frame().includes("Out of budget"), spent.frame);
  });

  it("opens a run from a shortened id and focuses its worker on o", async () => {
    const opened: string[] = [];
    const ui = await mount(<LoopsModal client={new FakeLoops()} initialRunId="0a1b2c" onOpenSession={(id) => opened.push(id)} onCancel={() => {}} />);
    await waitFor(() => ui.frame().includes("o open worker session"), ui.frame);
    await ui.press("o");
    expect(opened).toEqual(["sess-worker"]);
  });
});

describe("TUI App — /loops and /loop", () => {
  class FakeClient extends FakeLoops {
    constructor(public dispatch: React.Dispatch<TuiAction>) { super(); }
    async start() {}
    stop() {}
    async attachSession() { return { type: "response.ok", requestId: "r" } as DaemonMessage; }
  }

  async function mountApp() {
    const { input, output } = streams();
    let frame = "";
    output.on("data", (data: Buffer) => { frame = data.toString(); });
    const log = console.log;
    console.log = () => {};
    cleanups.push(() => { console.log = log; });
    let client!: FakeClient;
    const instance = render(
      <TuiStoreProvider>
        <App config={{} as CodeoidConfig} createClient={(_c, dispatch) => { client = new FakeClient(dispatch); return client as unknown as TuiWsClient; }} />
      </TuiStoreProvider>,
      { stdin: input as unknown as NodeJS.ReadStream, stdout: output as unknown as NodeJS.WriteStream, stderr: output as unknown as NodeJS.WriteStream, debug: true, patchConsole: false, exitOnCtrlC: false },
    );
    cleanups.push(() => { instance.cleanup(); input.destroy(); output.destroy(); });
    await Bun.sleep(30);
    client.dispatch({ type: "connection.change", state: "connected" });
    const session: SessionInfo = { id: "s1", name: "alpha", workdir: "/tmp", status: "idle", createdBy: "user:me", createdAt: "2026-10-20T00:00:00Z", attachedClients: 1, providerId: "claude" };
    client.dispatch({ type: "sessions.set", sessions: [session] });
    await waitFor(() => frame.includes("alpha"), () => frame);
    await Bun.sleep(50);
    return {
      frame: () => frame,
      run: async (command: string) => {
        input.write(command);
        await waitFor(() => frame.includes(command), () => frame);
        input.write("\r");
        await Bun.sleep(50);
      },
    };
  }

  it("/loops opens the run list", async () => {
    const ui = await mountApp();
    await ui.run("/loops");
    await waitFor(() => ui.frame().includes("Fix the checkout test"), ui.frame);
    expect(ui.frame()).toContain("Loops");
  });

  it("/loop start points at the CLI instead of guessing the checks", async () => {
    const ui = await mountApp();
    await ui.run("/loop start fix it");
    await waitFor(() => ui.frame().includes("codeoid loop start"), ui.frame);
  });
});
