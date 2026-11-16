/**
 * Ambient pack capability-role gate (docs/pack-loading.md), driven through a real
 * Session + MockSessionProvider (which invokes canUseTool exactly like the SDK's
 * PreToolUse gate). Proves a read-only role (reviewer, write:false) DENIES a
 * write tool even in autonomous mode — the governance moat — while an
 * implementer (write:true) allows it and reads are always fine.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Session, type SessionCreateOptions } from "../daemon/session.js";
import { MockSessionProvider } from "../daemon/providers/mock/session-provider.js";
import { Store } from "../daemon/store.js";
import { TranscriptStore } from "../daemon/transcript.js";
import type { ProviderEvent } from "../daemon/providers/interface.js";
import type { PackActivation } from "../daemon/pipeline/index.js";
import type { AuthContext } from "../protocol/types.js";

const AUTH: AuthContext = { sub: "u", scopes: [], delegationDepth: 0, accountId: "a", projectId: "p" };

let tmp: string;
let store: Store;
let transcriptStore: TranscriptStore;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "codeoid-rolegate-"));
  store = new Store(join(tmp, "codeoid.db"));
  transcriptStore = new TranscriptStore(join(tmp, "transcripts"));
});
afterEach(async () => {
  try { await transcriptStore.flush(); } catch {}
  try { store.close(); } catch {}
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
});

const reviewer: PackActivation = {
  id: "aif-sdlc",
  constitution: "Review carefully; do not modify.",
  roleName: "reviewer",
  role: { name: "reviewer", write: false, network: "read-only", envelope: ["read", "grep", "glob", "bash"] },
  subagents: [],
};
const implementer: PackActivation = {
  id: "aif-sdlc",
  roleName: "implementer",
  role: { name: "implementer", write: true, network: "read-only", envelope: "all" },
  subagents: [],
};

function toolTurn(name: string): ProviderEvent[] {
  return [
    { type: "tool_start", toolId: "t1", sdkToolUseId: "sdk-t1", name, input: { file_path: "x", content: "y" }, approvalId: "ap-1" } as ProviderEvent,
    {
      type: "turn_done",
      result: { providerId: "mock", model: "m", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, totalCostUsd: 0, durationMs: 1 },
    } as ProviderEvent,
  ];
}

function makeSession(provider: MockSessionProvider, pack: PackActivation): Session {
  const id = randomUUID();
  store.createSession({
    id, name: "rg", workdir: tmp, status: "idle", createdBy: AUTH.sub,
    createdAt: new Date().toISOString(), attachedClients: 0, accountId: AUTH.accountId, projectId: AUTH.projectId,
  });
  const opts: SessionCreateOptions = { name: "rg", workdir: tmp, auth: AUTH, store, transcriptStore, existingId: id, pack, _testProvider: provider };
  return new Session(opts);
}

async function until(cond: () => boolean, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("capability-role gate", () => {
  test("reviewer (write:false) DENIES Write even in autonomous mode", async () => {
    const provider = new MockSessionProvider("mock", [toolTurn("Write")]);
    const session = makeSession(provider, reviewer);
    session.attach({ id: "c", auth: AUTH, send: () => {} });
    session.setMode("autonomous"); // would auto-approve a normal write — role must still deny
    await session.send("edit the file", AUTH);
    await until(() => provider.canUseToolResults.length >= 1);
    expect(provider.canUseToolResults[0]!.behavior).toBe("deny");
  });

  test("implementer (write:true) allows Write in autonomous mode", async () => {
    const provider = new MockSessionProvider("mock", [toolTurn("Write")]);
    const session = makeSession(provider, implementer);
    session.attach({ id: "c", auth: AUTH, send: () => {} });
    session.setMode("autonomous");
    await session.send("edit the file", AUTH);
    await until(() => provider.canUseToolResults.length >= 1);
    expect(provider.canUseToolResults[0]!.behavior).toBe("allow");
  });

  test("reviewer allows a read-only tool (Read)", async () => {
    const provider = new MockSessionProvider("mock", [toolTurn("Read")]);
    const session = makeSession(provider, reviewer);
    session.attach({ id: "c", auth: AUTH, send: () => {} });
    session.setMode("autonomous");
    await session.send("read the file", AUTH);
    await until(() => provider.canUseToolResults.length >= 1);
    expect(provider.canUseToolResults[0]!.behavior).toBe("allow");
  });
});
