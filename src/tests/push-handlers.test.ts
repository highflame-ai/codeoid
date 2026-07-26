/**
 * push.register / push.unregister routed through the real SessionManager.handle()
 * — persistence keyed to the CALLER's identity (never a body-supplied owner) and
 * owner-scoped delete, over the wire.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "../daemon/session-manager.js";
import { Store } from "../daemon/store.js";
import { TranscriptStore } from "../daemon/transcript.js";
import { ALL_SCOPES } from "../protocol/scopes.js";
import type { AuthContext } from "../protocol/types.js";

const AUTH: AuthContext = {
  sub: "user:t",
  scopes: [...ALL_SCOPES] as AuthContext["scopes"],
  delegationDepth: 0,
  accountId: "acc",
  projectId: "proj",
};
const CLIENT = { id: "c", auth: AUTH, send: () => {} };

let tmp: string;
let store: Store;
let transcript: TranscriptStore;
let manager: SessionManager;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "codeoid-push-h-"));
  store = new Store(join(tmp, "codeoid.db"));
  transcript = new TranscriptStore(join(tmp, "transcripts"));
  manager = new SessionManager(store, transcript, undefined, undefined, undefined, {});
});

afterEach(async () => {
  try {
    await manager.drain(2_000);
  } catch {
    // best-effort
  }
  store.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("push.register / push.unregister handlers", () => {
  test("push.register persists the token under the CALLER's identity + tenant", async () => {
    const r = await manager.handle(
      { type: "push.register", id: "1", token: "ExponentPushToken[z]", platform: "ios" },
      AUTH,
      CLIENT,
    );
    expect(r.type).toBe("response.ok");
    expect(store.listPushForOwner("user:t", "acc", "proj")).toEqual([
      { token: "ExponentPushToken[z]", platform: "ios" },
    ]);
    // Not visible to another tenant.
    expect(store.listPushForOwner("user:t", "other", "proj")).toEqual([]);
  });

  test("push.unregister removes only the caller's own token", async () => {
    await manager.handle(
      { type: "push.register", id: "1", token: "tok", platform: "android" },
      AUTH,
      CLIENT,
    );
    // A different user owns a different token in the same tenant.
    store.registerPush("tok-other", "ios", "user:other", "acc", "proj");

    const r = await manager.handle({ type: "push.unregister", id: "2", token: "tok" }, AUTH, CLIENT);
    expect(r.type).toBe("response.ok");
    expect(store.listPushForOwner("user:t", "acc", "proj")).toEqual([]);
    // The other user's token is untouched.
    expect(store.listPushForOwner("user:other", "acc", "proj")).toHaveLength(1);
  });
});
