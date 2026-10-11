/**
 * A backend can announce a tool call and settle it itself, never asking codeoid
 * (codex declining an approval it can't show, #369). The announce flips the
 * session to `waiting_approval`; when the call completes with nothing parked,
 * the session must move on — not keep showing "waiting approval" for the rest
 * of the turn (which also blocks a follow-up message).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Session } from "../daemon/session.js";
import { MockSessionProvider } from "../daemon/providers/mock/session-provider.js";
import type { ProviderEvent } from "../daemon/providers/interface.js";
import { Store } from "../daemon/store.js";
import { TranscriptStore } from "../daemon/transcript.js";
import type { AuthContext } from "../protocol/types.js";

const AUTH: AuthContext = { sub: "user:ungated", scopes: [], delegationDepth: 0, accountId: "acc", projectId: "proj" };

let tmp: string;
let store: Store;
let transcript: TranscriptStore;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "codeoid-ungated-"));
  store = new Store(join(tmp, "codeoid.db"));
  transcript = new TranscriptStore(join(tmp, "transcripts"));
});

afterEach(async () => {
  try { await transcript.flush(); } catch {}
  try { store.close(); } catch {}
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
});

async function until(cond: () => boolean, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await new Promise((r) => setTimeout(r, 5));
  }
}

function makeSession(provider: MockSessionProvider): Session {
  const id = randomUUID();
  store.createSession({
    id, name: "ungated", workdir: tmp, status: "idle", createdBy: AUTH.sub,
    createdAt: new Date().toISOString(), attachedClients: 0, accountId: AUTH.accountId, projectId: AUTH.projectId,
  });
  return new Session({ name: "ungated", workdir: tmp, auth: AUTH, store, transcriptStore: transcript, existingId: id, _testProvider: provider });
}

describe("a tool call the backend settles itself (#369)", () => {
  test("leaves waiting_approval once it completes with nothing parked", async () => {
    const events: ProviderEvent[] = [
      { type: "tool_start", toolId: "t1", sdkToolUseId: "t1", name: "codex_file_change", input: {}, approvalId: "codex-t1" } as ProviderEvent,
      { type: "tool_complete", sdkToolUseId: "t1", output: "Declined — not shown", success: false } as ProviderEvent,
    ];
    // Stall after the scripted events: the turn stays open, so the status
    // observed is the mid-turn one, not the idle a turn end would set.
    const provider = new MockSessionProvider("mock", [events], { stall: true });
    provider.ungatedToolIds.add("t1");
    const session = makeSession(provider);
    await session.send("edit it", AUTH);
    await until(() => provider.canUseToolResults.length === 0 && session.status !== "waiting_approval" && session.status !== "idle");
    expect(session.status).toBe("thinking");
    expect(session.pendingToolApprovals()).toEqual([]);
    await session.destroy(AUTH);
  });
});
