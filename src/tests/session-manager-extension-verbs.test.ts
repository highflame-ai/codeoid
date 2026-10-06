/**
 * SessionManager handler coverage for the provider extension surface verbs:
 * `session.commands`, `session.ui_response`, `session.part_action`.
 *
 * The Session-level semantics are proven in
 * session-extension-surface.test.ts; here we drive the verbs through
 * `handle()` so scope enforcement, ownership checks, and the wire result
 * shapes can't silently regress.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../daemon/store.js";
import { TranscriptStore } from "../daemon/transcript.js";
import { SessionManager } from "../daemon/session-manager.js";
import { MockSessionProvider } from "../daemon/providers/mock/session-provider.js";
import type { AttachedClient } from "../daemon/session.js";
import type { AuthContext, DaemonMessage, SessionCommandsResultMsg } from "../protocol/types.js";
import { ALL_SCOPES, SCOPES, type Scope } from "../protocol/scopes.js";

const OWNER: AuthContext = {
  sub: "user:ext-verbs",
  scopes: [...ALL_SCOPES] as AuthContext["scopes"],
  delegationDepth: 0,
  accountId: "acc-ext",
  projectId: "proj-ext",
};

function scoped(scopes: Scope[]): AuthContext {
  return { ...OWNER, scopes };
}

function client(auth: AuthContext): AttachedClient {
  return { id: `client-${auth.sub}`, auth, send: () => {} };
}

let tmp: string;
let store: Store;
let transcript: TranscriptStore;
let manager: SessionManager;
let mock: MockSessionProvider;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "codeoid-mgr-ext-"));
  store = new Store(join(tmp, "codeoid.db"));
  transcript = new TranscriptStore(join(tmp, "transcripts"));
  mock = new MockSessionProvider("mock");
  manager = new SessionManager(store, transcript, undefined, undefined, undefined, {
    _testProviderFactory: () => mock,
    _testDialogNoClientGraceMs: 40,
  });
});

afterEach(async () => {
  try { await transcript.flush(); } catch {}
  try { store.close(); } catch {}
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
});

async function createSession(): Promise<string> {
  const resp = await manager.handle(
    { type: "session.create", id: "c1", name: "ext", workdir: tmp },
    OWNER,
    client(OWNER),
  );
  expect(resp.type).toBe("response.ok");
  // #create responds with data = session.toInfo().
  return (resp as { data: { id: string } }).data.id;
}

describe("session.create provider selection", () => {
  it("rejects an unknown providerId fail-closed", async () => {
    const resp = await manager.handle(
      {
        type: "session.create",
        id: "cp1",
        name: "pi-sess",
        workdir: tmp,
        providerId: "harness-from-the-future",
      },
      OWNER,
      client(OWNER),
    );
    expect(resp).toMatchObject({ type: "response.error", code: "invalid_request" });
    if (resp.type === "response.error") {
      expect(resp.error).toContain("harness-from-the-future");
      expect(resp.error).toContain("claude");
    }
  });

  it("accepts a registered providerId", async () => {
    // "pi" is in the default registry; _testProviderFactory still supplies
    // the runtime mock, so nothing spawns.
    const resp = await manager.handle(
      { type: "session.create", id: "cp2", name: "pi-sess", workdir: tmp, providerId: "pi" },
      OWNER,
      client(OWNER),
    );
    expect(resp.type).toBe("response.ok");
  });

  it("providerIds() advertises the catalog with the default first", () => {
    const ids = manager.providerIds();
    expect(ids[0]).toBe("claude");
    expect(ids).toContain("pi");
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// `session.create.model` (docs/role-model-binding.md §6.2): the operator's
// explicit model choice, validated provider-aware at create. The pack-role
// resolution chain for an OMITTED model is covered in collaboration.test.ts,
// next to the pack fixture it needs.
describe("session.create model selection", () => {
  it("resolves an alias against the provider and stamps the session", async () => {
    const resp = await manager.handle(
      { type: "session.create", id: "cm1", name: "with-model", workdir: tmp, model: "opus" },
      OWNER,
      client(OWNER),
    );
    expect(resp.type).toBe("response.ok");
    if (resp.type !== "response.ok") return;
    expect((resp.data as { model?: string }).model).toMatch(/^claude-opus-/);
  });

  it("rejects a Claude-shaped model on a non-Claude backend fail-closed", async () => {
    const resp = await manager.handle(
      {
        type: "session.create",
        id: "cm2",
        name: "wrong-vendor",
        workdir: tmp,
        providerId: "pi",
        model: "opus",
      },
      OWNER,
      client(OWNER),
    );
    expect(resp).toMatchObject({ type: "response.error", code: "invalid_request" });
    if (resp.type === "response.error") {
      expect(resp.error).toMatch(/Model "opus" is not valid for provider "pi"/);
    }
  });
});

describe("session.commands", () => {
  it("returns the provider catalog with providerId", async () => {
    mock.commands = [{ name: "review", description: "Review the diff", source: "extension" }];
    const sessionId = await createSession();
    const resp = (await manager.handle(
      { type: "session.commands", id: "r1", sessionId },
      OWNER,
      client(OWNER),
    )) as SessionCommandsResultMsg;
    expect(resp.type).toBe("session.commands.result");
    expect(resp.sessionId).toBe(sessionId);
    expect(resp.providerId).toBe("mock");
    expect(resp.commands).toEqual([
      { name: "review", description: "Review the diff", source: "extension" },
    ]);
  });

  it("requires session:list scope and an owned session", async () => {
    const sessionId = await createSession();
    const noScope = scoped([SCOPES.SESSION_SEND]);
    const denied = await manager.handle(
      { type: "session.commands", id: "r2", sessionId },
      noScope,
      client(noScope),
    );
    expect(denied).toMatchObject({ type: "response.error", code: "forbidden" });

    const missing = await manager.handle(
      { type: "session.commands", id: "r3", sessionId: "nope" },
      OWNER,
      client(OWNER),
    );
    expect(missing).toMatchObject({ type: "response.error", code: "not_found" });
  });
});

describe("session.ui_response", () => {
  it("routes an answer to the pending request; second answer is not_found", async () => {
    const sessionId = await createSession();
    const session = manager.findByName("ext", OWNER)!;
    const answer = session.requestUserInput({ method: "confirm", title: "OK?" });
    const requestId = (() => {
      // The request id is broadcast to capable clients; grab it via a probe
      // attach rather than reaching into private state.
      let seen: string | null = null;
      const probe: AttachedClient = {
        id: "probe",
        auth: OWNER,
        capabilities: ["ui.dialogs"],
        send: (m: DaemonMessage) => {
          if (m.type === "session.ui_request") seen = m.requestId;
        },
      };
      session.attach(probe);
      session.detach("probe");
      return seen!;
    })();
    expect(requestId).toBeTruthy();

    const ok = await manager.handle(
      { type: "session.ui_response", id: "u1", sessionId, requestId, confirmed: true },
      OWNER,
      client(OWNER),
    );
    expect(ok).toMatchObject({ type: "response.ok" });
    expect(await answer).toEqual({ confirmed: true, cancelled: false });

    const stale = await manager.handle(
      { type: "session.ui_response", id: "u2", sessionId, requestId, confirmed: false },
      OWNER,
      client(OWNER),
    );
    expect(stale).toMatchObject({ type: "response.error", code: "not_found" });
  });

  it("requires session:approve scope", async () => {
    const sessionId = await createSession();
    const noScope = scoped([SCOPES.SESSION_LIST]);
    const denied = await manager.handle(
      { type: "session.ui_response", id: "u3", sessionId, requestId: "x", confirmed: true },
      noScope,
      client(noScope),
    );
    expect(denied).toMatchObject({ type: "response.error", code: "forbidden" });
  });
});

describe("session.part_action", () => {
  it("requires session:send scope and validates via the session", async () => {
    const sessionId = await createSession();
    const noScope = scoped([SCOPES.SESSION_LIST]);
    const denied = await manager.handle(
      { type: "session.part_action", id: "p1", sessionId, messageId: "m", action: "a" },
      noScope,
      client(noScope),
    );
    expect(denied).toMatchObject({ type: "response.error", code: "forbidden" });

    // Owned session but no such message → the session's not_found surfaces.
    const missing = await manager.handle(
      { type: "session.part_action", id: "p2", sessionId, messageId: "m", action: "a" },
      OWNER,
      client(OWNER),
    );
    expect(missing).toMatchObject({ type: "response.error", code: "not_found" });
  });
});

// #348: a dialog is answerable while a capable approver is connected anywhere
// in the tenant — the web UI attaches only the session in focus.
describe("dialog deadline follows connected approvers", () => {
  const raise = (session: NonNullable<ReturnType<SessionManager["findByName"]>>) => {
    const state = { settled: false };
    const answer = session.requestUserInput({ method: "confirm", title: "Allow?" }).then((r) => {
      state.settled = true;
      return r;
    });
    return { state, answer };
  };

  it("a connected web client, not attached, holds the deadline; disconnecting re-arms it", async () => {
    await createSession();
    const session = manager.findByName("ext", OWNER)!;
    manager.clientConnected("web-1", OWNER, ["ui.dialogs"]);
    const { state, answer } = raise(session);
    await Bun.sleep(150);
    expect(state.settled).toBe(false);
    manager.disconnectClient("web-1");
    expect(await answer).toEqual({ cancelled: true, reason: "no_client" });
  });

  it("does not count a client of another tenant, a watch-only client, or one without ui.dialogs", async () => {
    await createSession();
    const session = manager.findByName("ext", OWNER)!;
    manager.clientConnected("other-tenant", { ...OWNER, accountId: "acc-other" }, ["ui.dialogs"]);
    manager.clientConnected("watcher", scoped([SCOPES.SESSION_WATCH]), ["ui.dialogs"]);
    manager.clientConnected("cli", OWNER, undefined);
    const { answer } = raise(session);
    expect(await answer).toEqual({ cancelled: true, reason: "no_client" });
  });

  it("a capable client connecting lifts a deadline already running", async () => {
    await createSession();
    const session = manager.findByName("ext", OWNER)!;
    const { state, answer } = raise(session);
    manager.clientConnected("web-late", OWNER, ["ui.dialogs"]);
    await Bun.sleep(150);
    expect(state.settled).toBe(false);
    await session.interrupt(OWNER);
    expect(await answer).toEqual({ cancelled: true, reason: "interrupted" });
  });
});
