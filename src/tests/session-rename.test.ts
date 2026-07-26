/**
 * session.rename regression coverage (#257).
 *
 * The bug: rename mutated only the in-memory Session. The sessions row was
 * never updated (store.ts had no `UPDATE sessions SET name`) and the transcript
 * meta — the restart-resume source of truth — was rewritten only by the
 * debounced status-persist path. So renaming an IDLE session and restarting the
 * daemon silently restored the old name, while the store row stayed stale
 * forever regardless of activity.
 *
 * These tests pin both persistence paths plus the conductor-name reservation,
 * which `#create` enforced but `#rename` did not.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../daemon/store.js";
import { TranscriptStore } from "../daemon/transcript.js";
import { SessionManager } from "../daemon/session-manager.js";
import { MockSessionProvider } from "../daemon/providers/mock/session-provider.js";
import type { AuthContext } from "../protocol/types.js";
import { ALL_SCOPES, SCOPES } from "../protocol/scopes.js";

const AUTH: AuthContext = {
  sub: "user:renamer",
  scopes: [...ALL_SCOPES] as AuthContext["scopes"],
  delegationDepth: 0,
  accountId: "acc-r",
  projectId: "proj-r",
};
const CLIENT = { id: "client-r", auth: AUTH, send: () => {} };

let tmp: string;
let store: Store;
let transcript: TranscriptStore;
let manager: SessionManager;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "codeoid-rename-"));
  store = new Store(join(tmp, "codeoid.db"));
  transcript = new TranscriptStore(join(tmp, "transcripts"));
  manager = new SessionManager(store, transcript, undefined, undefined, undefined, {
    _testProviderFactory: () => new MockSessionProvider("mock", []),
  });
});

afterEach(async () => {
  // Session creation and rename both fire-and-forget meta writes; drain them
  // before removing the dir so a pending atomic rename doesn't ENOENT.
  try { await transcript.flush(); } catch {}
  try { store.close(); } catch {}
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
});

async function createSession(name: string, role?: "conductor"): Promise<string> {
  const res = (await manager.handle(
    { type: "session.create", id: `req-${name}`, name, workdir: tmp, ...(role ? { role } : {}) },
    AUTH,
    CLIENT,
  )) as { type: string; data?: { id: string }; error?: string };
  expect(res.type).toBe("response.ok");
  return res.data!.id;
}

async function rename(sessionId: string, name: string, auth: AuthContext = AUTH) {
  return (await manager.handle(
    { type: "session.rename", id: "req-rename", sessionId, name },
    auth,
    CLIENT,
  )) as { type: string; error?: string; code?: string };
}

describe("session.rename persistence (#257)", () => {
  it("writes the new name through to the sessions row", async () => {
    const id = await createSession("before");
    expect(store.getSession(id)?.name).toBe("before");

    const res = await rename(id, "after");
    expect(res.type).toBe("response.ok");

    // The regression: this used to still read "before" — the name column was
    // only ever written by createSession's INSERT OR REPLACE.
    expect(store.getSession(id)?.name).toBe("after");
  });

  it("persists the rename of an IDLE session to the transcript meta, so it survives restart", async () => {
    const id = await createSession("idle-before");

    // No turns, no status changes — exactly the case that used to lose the
    // rename, because only the status-persist path rewrote the meta.
    expect((await rename(id, "idle-after")).type).toBe("response.ok");
    await transcript.flush();

    // loadAllMeta() is what daemon restart resume reads.
    const metas = await transcript.loadAllMeta();
    expect(metas.find((m) => m.sessionId === id)?.sessionName).toBe("idle-after");
  });

  it("does not bump lastActivityAt — a rename must not reorder the resumed session list", async () => {
    const id = await createSession("sortable");
    await transcript.flush();
    const before = (await transcript.loadAllMeta()).find((m) => m.sessionId === id)!.lastActivityAt;

    await new Promise((r) => setTimeout(r, 5));
    expect((await rename(id, "sortable-renamed")).type).toBe("response.ok");
    await transcript.flush();

    const after = (await transcript.loadAllMeta()).find((m) => m.sessionId === id)!;
    expect(after.sessionName).toBe("sortable-renamed");
    expect(after.lastActivityAt).toBe(before);
  });

  it("trims the name and rejects empty / whitespace-only", async () => {
    const id = await createSession("trimmed");

    expect((await rename(id, "  padded  ")).type).toBe("response.ok");
    expect(store.getSession(id)?.name).toBe("padded");

    const empty = await rename(id, "   ");
    expect(empty.type).toBe("response.error");
    expect(empty.code).toBe("invalid_request");
    expect(store.getSession(id)?.name).toBe("padded");
  });

  it("audits the rename with from/to, attributed to the caller", async () => {
    const id = await createSession("audit-before");
    expect((await rename(id, "audit-after")).type).toBe("response.ok");

    const entries = store.database
      .prepare("SELECT subject, detail FROM audit_log WHERE action = 'session.rename'")
      .all() as Array<{ subject: string; detail: string }>;
    expect(entries).toHaveLength(1);
    expect(entries[0]!.subject).toBe(AUTH.sub);
    expect(entries[0]!.detail).toContain("from=audit-before");
    expect(entries[0]!.detail).toContain("to=audit-after");
  });
});

describe("session.rename guards (#257)", () => {
  it("rejects renaming a session to the conductor's reserved name", async () => {
    const id = await createSession("ordinary");

    const res = await rename(id, "conductor");
    expect(res.type).toBe("response.error");
    expect(res.code).toBe("invalid_request");
    // Unchanged — the shadowing name never lands.
    expect(store.getSession(id)?.name).toBe("ordinary");
  });

  it("rejects renaming the conductor session itself", async () => {
    const conductorId = await createSession("conductor", "conductor");

    const res = await rename(conductorId, "not-the-conductor");
    expect(res.type).toBe("response.error");
    expect(res.code).toBe("invalid_request");
    expect(store.getSession(conductorId)?.name).toBe("conductor");
  });

  it("requires the session:approve scope", async () => {
    const id = await createSession("scoped");
    const weak: AuthContext = {
      ...AUTH,
      scopes: ALL_SCOPES.filter((s) => s !== SCOPES.SESSION_APPROVE) as AuthContext["scopes"],
    };

    const res = await rename(id, "should-not-apply", weak);
    expect(res.type).toBe("response.error");
    expect(res.code).toBe("forbidden");
    expect(store.getSession(id)?.name).toBe("scoped");
  });
});
