import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../daemon/store.js";
import { TranscriptStore } from "../daemon/transcript.js";
import { Session } from "../daemon/session.js";
import { MockSessionProvider } from "../daemon/providers/mock/session-provider.js";
import type { AuthContext } from "../protocol/types.js";

/**
 * A resumed session must keep the timestamps it was created with.
 *
 * `createdAt` and `lastActivityAt` were both stamped unconditionally in the
 * constructor, so every daemon restart re-dated every session to the restart
 * moment. Two consequences: a weeks-old session reported as brand new, and —
 * because the session list's recency key is `lastActivityAt ?? createdAt` —
 * every session tied on the same instant, collapsing the attention ordering
 * back to insertion order. Both values were already persisted in
 * `TranscriptMeta` and already read (SessionManager's `resumeSortKey` sorts the
 * resume pass by `meta.lastActivityAt`); the constructor just overwrote them.
 */

const TEST_AUTH: AuthContext = {
  sub: "user:test-timestamps",
  scopes: [],
  delegationDepth: 0,
  accountId: "acc-ts",
  projectId: "proj-ts",
};

let tmp: string;
let store: Store;
let transcriptStore: TranscriptStore;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "codeoid-ts-"));
  store = new Store(join(tmp, "codeoid.db"));
  transcriptStore = new TranscriptStore(join(tmp, "transcripts"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function make(opts: { createdAt?: string; lastActivityAt?: string } = {}): Session {
  const id = randomUUID();
  store.createSession({
    id,
    name: "ts-test",
    workdir: tmp,
    status: "idle",
    createdBy: TEST_AUTH.sub,
    createdAt: new Date().toISOString(),
    attachedClients: 0,
    accountId: TEST_AUTH.accountId!,
    projectId: TEST_AUTH.projectId!,
  });
  return new Session({
    name: "ts-test",
    workdir: tmp,
    auth: TEST_AUTH,
    store,
    transcriptStore,
    existingId: id,
    _testProvider: new MockSessionProvider(),
    ...opts,
  } as never);
}

describe("session timestamps across resume", () => {
  const ORIGIN = "2026-07-01T10:00:00.000Z";
  const ACTIVE = "2026-08-20T18:30:00.000Z";

  it("preserves createdAt and lastActivityAt when resumed from meta", () => {
    const s = make({ createdAt: ORIGIN, lastActivityAt: ACTIVE });
    expect(s.createdAt).toBe(ORIGIN);
    expect(s.toInfo().lastActivityAt).toBe(ACTIVE);
  });

  it("stamps both fresh for a genuinely new session", () => {
    const before = Date.now();
    const s = make();
    const created = Date.parse(s.createdAt);
    expect(created).toBeGreaterThanOrEqual(before - 1000);
    // A new session has no activity yet, so recency falls back to creation.
    expect(s.toInfo().lastActivityAt).toBe(s.createdAt);
  });

  it("falls back to createdAt when only createdAt is restored", () => {
    // Meta written before lastActivityAt existed — must not regress to `now`,
    // which would sort an ancient session as the most recently active one.
    const s = make({ createdAt: ORIGIN });
    expect(s.createdAt).toBe(ORIGIN);
    expect(s.toInfo().lastActivityAt).toBe(ORIGIN);
  });

  it("keeps distinct sessions distinguishable after a simulated restart", () => {
    // The actual regression: with both re-stamped to `now`, these collapse to
    // the same instant and the attention ordering loses its recency signal.
    const older = make({ createdAt: ORIGIN, lastActivityAt: "2026-08-01T00:00:00.000Z" });
    const newer = make({ createdAt: ORIGIN, lastActivityAt: "2026-08-25T00:00:00.000Z" });

    const a = Date.parse(older.toInfo().lastActivityAt!);
    const b = Date.parse(newer.toInfo().lastActivityAt!);
    expect(b).toBeGreaterThan(a);
  });
});
