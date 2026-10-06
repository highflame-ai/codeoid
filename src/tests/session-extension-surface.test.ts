/**
 * Provider extension surface — integration tests over the MockSessionProvider
 * harness (same offline setup as session-integration.test.ts).
 *
 * Coverage:
 *
 *   U1  requestUserInput → session.ui_request broadcast to ui.dialogs-capable
 *       clients only; answered via resolveUiRequestFromClient; ui_resolved
 *       broadcast; second answer for the same id returns false.
 *   U2  timeoutMs auto-cancels (daemon-enforced) with reason "timeout".
 *   U3  interrupt() cancels pending dialogs with reason "interrupted".
 *   U4  attach re-delivers pending requests to capable clients only.
 *
 *   C1  custom_message provider events land as persisted info messages with
 *       parts + provider.message metadata.
 *
 *   P1  patchableKeys: approval updatedInput is filtered to the declared
 *       keys (foreign keys dropped) before reaching the provider.
 *   P2  without patchableKeys, non-AskUserQuestion patches are dropped
 *       entirely (existing hardening still holds).
 *
 *   A1  dispatchPartAction validates message + button existence, rejects
 *       providers without a handler, and forwards action + data when valid.
 *
 *   L1  listProviderCommands: [] without the capability, the catalog with
 *       it, [] (not a throw) when the provider errors.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../daemon/store.js";
import { TranscriptStore } from "../daemon/transcript.js";
import { Session, type AttachedClient } from "../daemon/session.js";
import { MockSessionProvider, mockResult } from "../daemon/providers/mock/session-provider.js";
import { SCOPES } from "../protocol/scopes.js";
import { CAPABILITIES } from "../protocol/types.js";
import type {
  AuthContext,
  DaemonMessage,
  SessionMessage,
  SessionUiRequestMsg,
  SessionUiResolvedMsg,
} from "../protocol/types.js";
import type { ProviderEvent } from "../daemon/providers/interface.js";

const TEST_AUTH: AuthContext = {
  sub: "user:test-ext-surface",
  scopes: [],
  delegationDepth: 0,
  accountId: "acc-ext",
  projectId: "proj-ext",
};

let tmp: string;
let store: Store;
let transcriptStore: TranscriptStore;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "codeoid-ext-"));
  store = new Store(join(tmp, "codeoid.db"));
  transcriptStore = new TranscriptStore(join(tmp, "transcripts"));
});

afterEach(async () => {
  await new Promise<void>((r) => setTimeout(r, 100));
  try { await transcriptStore.flush(); } catch {}
  try { store.close(); } catch {}
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
});

function makeSession(provider: MockSessionProvider, name = "ext-test"): Session {
  const id = randomUUID();
  store.createSession({
    id,
    name,
    workdir: tmp,
    status: "idle",
    createdBy: TEST_AUTH.sub,
    createdAt: new Date().toISOString(),
    attachedClients: 0,
    accountId: TEST_AUTH.accountId!,
    projectId: TEST_AUTH.projectId!,
  });
  return new Session({
    name,
    workdir: tmp,
    auth: TEST_AUTH,
    store,
    transcriptStore,
    existingId: id,
    _testProvider: provider,
  });
}

/** In-memory client that records everything it's sent. */
function makeClient(
  capabilities?: string[],
  scopes: string[] = [SCOPES.SESSION_APPROVE],
): AttachedClient & { received: DaemonMessage[] } {
  const received: DaemonMessage[] = [];
  return {
    id: randomUUID(),
    auth: { ...TEST_AUTH, scopes: scopes as AuthContext["scopes"] },
    capabilities,
    received,
    send: (m) => { received.push(m); },
  };
}

const uiRequestsIn = (msgs: DaemonMessage[]) =>
  msgs.filter((m): m is SessionUiRequestMsg => m.type === "session.ui_request");
const uiResolvedIn = (msgs: DaemonMessage[]) =>
  msgs.filter((m): m is SessionUiResolvedMsg => m.type === "session.ui_resolved");

async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise<void>((r) => setTimeout(r, 10));
  }
}

describe("provider dialogs (session.ui_request)", () => {
  it("U1: broadcasts to capable clients only, answers resolve the provider promise", async () => {
    const provider = new MockSessionProvider("mock");
    const session = makeSession(provider);
    const capable = makeClient([CAPABILITIES.UI_DIALOGS]);
    const legacy = makeClient(); // no capabilities
    session.attach(capable);
    session.attach(legacy);

    const answer = session.requestUserInput({
      method: "select",
      title: "Pick one",
      options: ["a", "b"],
    });
    expect(session.pendingUiRequestCount).toBe(1);

    // Only the capable client saw the request.
    expect(uiRequestsIn(capable.received)).toHaveLength(1);
    expect(uiRequestsIn(legacy.received)).toHaveLength(0);
    const req = uiRequestsIn(capable.received)[0]!;
    expect(req.method).toBe("select");
    expect(req.options).toEqual(["a", "b"]);

    const applied = session.resolveUiRequestFromClient(
      req.requestId,
      { value: "b" },
      TEST_AUTH,
    );
    expect(applied).toBe(true);

    const resolved = await answer;
    expect(resolved).toEqual({ value: "b", cancelled: false });
    expect(session.pendingUiRequestCount).toBe(0);

    // Everyone capable gets the resolved broadcast; the answer is final.
    expect(uiResolvedIn(capable.received)).toHaveLength(1);
    expect(uiResolvedIn(capable.received)[0]!.reason).toBe("answered");
    expect(
      session.resolveUiRequestFromClient(req.requestId, { value: "a" }, TEST_AUTH),
    ).toBe(false);

    await session.destroy(TEST_AUTH);
  });

  it("U2: timeoutMs auto-cancels with reason timeout", async () => {
    const provider = new MockSessionProvider("mock");
    const session = makeSession(provider);
    const client = makeClient([CAPABILITIES.UI_DIALOGS]);
    session.attach(client);

    const answer = session.requestUserInput({
      method: "confirm",
      title: "Quick?",
      timeoutMs: 30,
    });
    const resolved = await answer;
    expect(resolved).toEqual({ cancelled: true, reason: "timeout" });
    expect(uiResolvedIn(client.received)[0]!.reason).toBe("timeout");
    expect(session.pendingUiRequestCount).toBe(0);

    await session.destroy(TEST_AUTH);
  });

  it("U3: interrupt cancels pending dialogs with reason interrupted", async () => {
    const provider = new MockSessionProvider("mock");
    const session = makeSession(provider);
    const client = makeClient([CAPABILITIES.UI_DIALOGS]);
    session.attach(client);

    const answer = session.requestUserInput({ method: "input", title: "Name?" });
    await session.interrupt(TEST_AUTH);

    const resolved = await answer;
    expect(resolved).toEqual({ cancelled: true, reason: "interrupted" });
    expect(uiResolvedIn(client.received)[0]!.reason).toBe("interrupted");

    await session.destroy(TEST_AUTH);
  });

  it("U4: attach re-delivers pending requests to capable clients only", async () => {
    const provider = new MockSessionProvider("mock");
    const session = makeSession(provider);

    const answer = session.requestUserInput({ method: "confirm", title: "Anyone there?" });

    const late = makeClient([CAPABILITIES.UI_DIALOGS]);
    const lateLegacy = makeClient();
    session.attach(late);
    session.attach(lateLegacy);

    expect(uiRequestsIn(late.received)).toHaveLength(1);
    expect(uiRequestsIn(lateLegacy.received)).toHaveLength(0);

    const req = uiRequestsIn(late.received)[0]!;
    session.resolveUiRequestFromClient(req.requestId, { confirmed: true }, TEST_AUTH);
    const resolved = await answer;
    expect(resolved).toEqual({ confirmed: true, cancelled: false });

    await session.destroy(TEST_AUTH);
  });
});

// #348: a pending dialog waits for a human (no deadline), is visible to every
// surface through the session's info, and an unattended turn never prompts.
describe("provider dialogs: waiting, visibility, unattended", () => {
  const infoUpdates = (msgs: DaemonMessage[]) =>
    msgs.filter((m): m is Extract<DaemonMessage, { type: "session.info_update" }> => m.type === "session.info_update");

  it("U5: with nobody able to answer, the dialog waits — then a client that attaches answers it", async () => {
    const session = makeSession(new MockSessionProvider("mock"), "waits");
    const cli = makeClient(); // a one-shot / legacy client: cannot render dialogs
    session.attach(cli);
    let settled = false;
    const answer = session.requestUserInput({ method: "confirm", title: "Allow?" }).then((r) => {
      settled = true;
      return r;
    });
    await Bun.sleep(150);
    expect(settled).toBe(false);
    expect(session.pendingUiRequestCount).toBe(1);
    // Hours later, someone attaches from a surface that can render it.
    const web = makeClient([CAPABILITIES.UI_DIALOGS]);
    session.attach(web);
    const req = uiRequestsIn(web.received)[0]!;
    session.resolveUiRequestFromClient(req.requestId, { confirmed: true }, TEST_AUTH);
    expect(await answer).toEqual({ confirmed: true, cancelled: false });
    await session.destroy(TEST_AUTH);
  });

  it("U6: the pending dialog shows in the session's info for every client, and clears when answered", async () => {
    const session = makeSession(new MockSessionProvider("mock"), "visible");
    const cli = makeClient(); // no ui.dialogs — still sees what it waits on
    session.attach(cli);
    const answer = session.requestUserInput({ method: "select", title: "Pick a database", options: ["pg", "mysql"] });
    const raised = infoUpdates(cli.received).at(-1)!.session.pendingDialog;
    expect(raised).toMatchObject({ method: "select", title: "Pick a database", options: ["pg", "mysql"] });
    expect(session.toInfo().pendingDialog?.requestId).toBe(raised!.requestId);
    session.resolveUiRequestFromClient(raised!.requestId, { value: "pg" }, TEST_AUTH);
    expect(await answer).toEqual({ value: "pg", cancelled: false });
    expect(infoUpdates(cli.received).at(-1)!.session.pendingDialog).toBeUndefined();
    expect(session.toInfo().pendingDialog).toBeUndefined();
    await session.destroy(TEST_AUTH);
  });

  it("U7: an unattended turn never prompts — the dialog is answered at once as unattended", async () => {
    const session = makeSession(new MockSessionProvider("mock"), "unattended");
    const web = makeClient([CAPABILITIES.UI_DIALOGS]);
    session.attach(web);
    session.unattended = true;
    expect(await session.requestUserInput({ method: "confirm", title: "Allow?" })).toEqual({
      cancelled: true,
      reason: "unattended",
    });
    // Nothing was raised or left pending.
    expect(uiRequestsIn(web.received)).toHaveLength(0);
    expect(session.pendingUiRequestCount).toBe(0);
    // Attended again (the phase ended): dialogs work normally.
    session.unattended = false;
    const answer = session.requestUserInput({ method: "confirm", title: "Allow?" });
    expect(uiRequestsIn(web.received)).toHaveLength(1);
    session.resolveUiRequestFromClient(uiRequestsIn(web.received)[0]!.requestId, { confirmed: false }, TEST_AUTH);
    expect(await answer).toEqual({ confirmed: false, cancelled: false });
    await session.destroy(TEST_AUTH);
  });

  it("U8: a client's dismissal reports reason dismissed", async () => {
    const session = makeSession(new MockSessionProvider("mock"));
    const web = makeClient([CAPABILITIES.UI_DIALOGS]);
    session.attach(web);
    const answer = session.requestUserInput({ method: "confirm", title: "Allow?" });
    const req = uiRequestsIn(web.received)[0]!;
    session.resolveUiRequestFromClient(req.requestId, { cancelled: true }, TEST_AUTH);
    expect(await answer).toEqual({ cancelled: true, reason: "dismissed" });
    await session.destroy(TEST_AUTH);
  });
});

describe("custom_message provider events", () => {
  it("C1: lands as a persisted info message with parts + metadata", async () => {
    const provider = new MockSessionProvider("mock", [
      [
        {
          type: "custom_message",
          content: "Build finished",
          parts: [
            { kind: "text", text: "Build finished", markdown: false },
            { kind: "button", label: "Rerun", action: "rerun" },
          ],
          metadata: { source: "ci-extension" },
        } satisfies ProviderEvent,
        { type: "turn_done", result: mockResult() },
      ],
    ]);
    const session = makeSession(provider);
    const client = makeClient([CAPABILITIES.PARTS]);
    session.attach(client);

    await session.send("run the build", TEST_AUTH);
    await waitFor(() =>
      client.received.some(
        (m) => m.type === "session.message" && m.role === "info" && m.content === "Build finished",
      ),
    );

    const msg = client.received.find(
      (m): m is SessionMessage =>
        m.type === "session.message" && m.role === "info" && m.content === "Build finished",
    )!;
    expect(msg.parts).toHaveLength(2);
    expect(msg.parts![1]).toEqual({ kind: "button", label: "Rerun", action: "rerun" });
    expect(msg.metadata?.event).toBe("provider.message");
    expect(msg.metadata?.source).toBe("ci-extension");

    await session.destroy(TEST_AUTH);
  });
});

describe("approval patchableKeys", () => {
  const formTool = (patchableKeys?: string[]): ProviderEvent[] => [
    {
      type: "tool_start",
      toolId: "t1",
      sdkToolUseId: "sdk-t1",
      name: "custom_form",
      input: { question: "pick" },
      approvalId: "ap-1",
      ...(patchableKeys ? { patchableKeys } : {}),
    },
    { type: "tool_complete", sdkToolUseId: "sdk-t1", output: "ok", success: true },
    { type: "turn_done", result: mockResult() },
  ];

  it("P1: declared keys pass, foreign keys are dropped", async () => {
    const provider = new MockSessionProvider("mock", [formTool(["choice"])]);
    const session = makeSession(provider);
    session.setMode("interactive", undefined, TEST_AUTH);
    const client = makeClient();
    session.attach(client);

    const sent = session.send("go", TEST_AUTH);
    // Wait for the approval to be pending, then answer it with a patch that
    // mixes a declared key with a hostile one.
    await waitFor(() => session.status === "waiting_approval");
    session.approve("ap-1", true, TEST_AUTH, { choice: "b", question: "OVERWRITTEN" });
    await sent;
    await waitFor(() => provider.canUseToolResults.length === 1);

    const result = provider.canUseToolResults[0]!;
    expect(result.behavior).toBe("allow");
    expect(result.updatedInput?.choice).toBe("b");
    // The undeclared key must NOT override the audited input.
    expect(result.updatedInput?.question).toBe("pick");

    await session.destroy(TEST_AUTH);
  });

  it("P2: without patchableKeys a non-AskUserQuestion patch is ignored", async () => {
    const provider = new MockSessionProvider("mock", [formTool(undefined)]);
    const session = makeSession(provider);
    session.setMode("interactive", undefined, TEST_AUTH);
    session.attach(makeClient());

    const sent = session.send("go", TEST_AUTH);
    await waitFor(() => session.status === "waiting_approval");
    session.approve("ap-1", true, TEST_AUTH, { choice: "b" });
    await sent;
    await waitFor(() => provider.canUseToolResults.length === 1);

    expect(provider.canUseToolResults[0]!.updatedInput).toEqual({ question: "pick" });

    await session.destroy(TEST_AUTH);
  });
});

describe("part actions (session.part_action)", () => {
  async function sessionWithButtonMessage(provider: MockSessionProvider) {
    const session = makeSession(provider);
    const client = makeClient([CAPABILITIES.PARTS]);
    session.attach(client);
    await session.send("go", TEST_AUTH);
    await waitFor(() =>
      client.received.some((m) => m.type === "session.message" && m.role === "info"),
    );
    const msg = client.received.find(
      (m): m is SessionMessage => m.type === "session.message" && m.role === "info",
    )!;
    return { session, messageId: msg.messageId };
  }

  const buttonScript: ProviderEvent[][] = [
    [
      {
        type: "custom_message",
        content: "Deploy ready",
        parts: [{ kind: "button", label: "Deploy", action: "deploy", data: { env: "dev" } }],
      },
      { type: "turn_done", result: mockResult() },
    ],
  ];

  it("A1: validates and forwards; rejects unknown ids/actions and handler-less providers", async () => {
    const provider = new MockSessionProvider("mock", buttonScript.map((s) => [...s]));
    const { session, messageId } = await sessionWithButtonMessage(provider);

    // Unknown message.
    expect(
      (await session.dispatchPartAction("nope", "deploy", undefined, TEST_AUTH)),
    ).toMatchObject({ ok: false, code: "not_found" });
    // Known message, wrong action.
    expect(
      (await session.dispatchPartAction(messageId, "self-destruct", undefined, TEST_AUTH)),
    ).toMatchObject({ ok: false, code: "not_found" });

    // Valid: forwarded with data.
    const ok = await session.dispatchPartAction(messageId, "deploy", { confirm: true }, TEST_AUTH);
    expect(ok).toEqual({ ok: true });
    expect(provider.partActions).toEqual([{ action: "deploy", data: { confirm: true } }]);

    await session.destroy(TEST_AUTH);
  });

  it("A2: provider without handlePartAction is invalid_request", async () => {
    const provider = new MockSessionProvider("mock", buttonScript.map((s) => [...s]));
    // Shadow the mock's method to model a provider lacking the capability.
    (provider as unknown as Record<string, unknown>).handlePartAction = undefined;
    const { session, messageId } = await sessionWithButtonMessage(provider);

    const result = await session.dispatchPartAction(messageId, "deploy", undefined, TEST_AUTH);
    expect(result).toMatchObject({ ok: false, code: "invalid_request" });

    await session.destroy(TEST_AUTH);
  });
});

describe("provider commands (session.commands)", () => {
  it("L1: [] without capability, catalog with it, [] on provider error", async () => {
    const bare = new MockSessionProvider("mock");
    (bare as unknown as Record<string, unknown>).listCommands = undefined;
    const bareSession = makeSession(bare, "bare");
    expect(await bareSession.listProviderCommands()).toEqual([]);
    await bareSession.destroy(TEST_AUTH);

    const rich = new MockSessionProvider("mock");
    rich.commands = [
      { name: "review", description: "Review the diff", source: "extension" },
      { name: "fix-tests", source: "prompt", argumentHint: "<pattern>" },
    ];
    const richSession = makeSession(rich, "rich");
    const commands = await richSession.listProviderCommands();
    expect(commands).toHaveLength(2);
    expect(commands[0]!.name).toBe("review");
    await richSession.destroy(TEST_AUTH);

    const broken = new MockSessionProvider("mock");
    broken.commands = () => Promise.reject(new Error("boom"));
    const brokenSession = makeSession(broken, "broken");
    expect(await brokenSession.listProviderCommands()).toEqual([]);
    await brokenSession.destroy(TEST_AUTH);
  });
});

describe("turn interrupt signal", () => {
  it("turnInterrupted is set by interrupt() and cleared when the next turn starts", async () => {
    const session = makeSession(new MockSessionProvider("mock"));
    expect(session.turnInterrupted).toBe(false);
    // Interrupt leaves the session idle but flags the interrupt so a driver
    // (a pipeline phase) can stop instead of re-driving over the Stop.
    await session.interrupt(TEST_AUTH);
    expect(session.turnInterrupted).toBe(true);
    // Starting the next turn clears it.
    await session.send("go", TEST_AUTH);
    expect(session.turnInterrupted).toBe(false);
    await session.destroy(TEST_AUTH);
  });
});
