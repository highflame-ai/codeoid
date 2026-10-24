/**
 * session.fork — branch a conversation into a new independent session,
 * optionally onto a different backend. Two layers:
 *
 *   Part A (primitive): Session.primeFromFork / canonicalHistory directly —
 *     the child gets a COPY of the parent's canonical history (not shared),
 *     the warm provider is seeded, and the transcript replays into scrollback.
 *
 *   Part B (wiring): SessionManager.handle("session.fork") end-to-end — new
 *     id + "(fork)" name, history carried, the "fork onto a different
 *     provider in one call" path, parent untouched, and fail-closed rules
 *     (unknown provider, foreign tenant, conductor).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Store } from "../daemon/store.js";
import { TranscriptStore } from "../daemon/transcript.js";
import { Session, type AttachedClient } from "../daemon/session.js";
import { SessionManager } from "../daemon/session-manager.js";
import { MockSessionProvider } from "../daemon/providers/mock/session-provider.js";
import { mockResult } from "../daemon/providers/mock/index.js";
import { ProviderRegistry } from "../daemon/providers/registry.js";
import type { CanonicalTurn } from "../daemon/providers/canonical.js";
import type { AuthContext, DaemonMessage } from "../protocol/types.js";
import { ALL_SCOPES } from "../protocol/scopes.js";
import { loadConfig } from "../config.js";

const AUTH: AuthContext = {
  sub: "user:fork",
  scopes: [...ALL_SCOPES] as AuthContext["scopes"],
  delegationDepth: 0,
  accountId: "acc-fork",
  projectId: "proj-fork",
};
const OTHER: AuthContext = { ...AUTH, sub: "user:other", accountId: "acc-other" };

let tmp: string;
let store: Store;
let transcript: TranscriptStore;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "codeoid-fork-"));
  store = new Store(join(tmp, "codeoid.db"));
  transcript = new TranscriptStore(join(tmp, "transcripts"));
});

afterEach(async () => {
  await new Promise<void>((r) => setTimeout(r, 50));
  try {
    await transcript.flush();
  } catch {}
  try {
    store.close();
  } catch {}
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {}
});

// ── Part A: the primitive ───────────────────────────────────────────────────

describe("Session.primeFromFork", () => {
  it("copies canonical history, seeds the warm provider, replays scrollback", async () => {
    const id = randomUUID();
    store.createSession({
      id,
      name: "fork",
      workdir: tmp,
      status: "idle",
      createdBy: AUTH.sub,
      createdAt: new Date().toISOString(),
      attachedClients: 0,
      accountId: AUTH.accountId!,
      projectId: AUTH.projectId!,
    });
    const provider = new MockSessionProvider("mock-session", []);
    const session = new Session({
      name: "fork",
      workdir: tmp,
      auth: AUTH,
      store,
      transcriptStore: transcript,
      existingId: id,
      _testProvider: provider,
    });

    const history: CanonicalTurn[] = [
      { role: "user", content: "parent q" },
      { role: "assistant", content: "parent a", providerId: "claude", model: "opus" },
    ];
    const transcriptRows: DaemonMessage[] = [
      {
        type: "session.message",
        sessionId: "parent",
        message: {
          messageId: "m1",
          role: "user",
          content: "parent q",
          identity: { sub: AUTH.sub, name: "u", type: "human" },
          timestamp: new Date().toISOString(),
        },
      } as unknown as DaemonMessage,
    ];

    await session.primeFromFork(history, transcriptRows);

    // Canonical history copied — and it's a COPY (mutating ours doesn't leak).
    expect(session.canonicalHistory).toEqual(history);
    history[0] = { role: "user", content: "MUTATED" };
    expect(session.canonicalHistory[0]).toEqual({ role: "user", content: "parent q" });

    // Warm provider was seeded with the forked history.
    expect(provider.seededHistory).toHaveLength(2);
    expect(provider.seededHistory?.[0]).toEqual({ role: "user", content: "parent q" });

    // A fork's fresh backend must run its first turn as a create, NOT a
    // resume — scrollback replay must NOT flip hasQueried.
    expect(provider.hasQueried).toBe(false);
  });
});

// ── Part B: the manager handler ─────────────────────────────────────────────

/** 2-backend registry; created instances captured for inspection. */
function makeRegistry() {
  const created: Record<string, MockSessionProvider[]> = { "mock-a": [], "mock-b": [] };
  const registry = new ProviderRegistry("mock-a");
  for (const id of ["mock-a", "mock-b"] as const) {
    registry.register({
      id,
      displayName: id,
      create: () => {
        // One scripted turn so a send produces an assistant turn in history.
        const p = new MockSessionProvider(id, [
          [
            { type: "text_done", content: `${id} reply` },
            { type: "turn_done", result: mockResult({ providerId: id }) },
          ],
        ]);
        created[id]!.push(p);
        return p;
      },
    });
  }
  return { registry, created };
}

function makeManager(registry: ProviderRegistry): SessionManager {
  return new SessionManager(store, transcript, undefined, undefined, undefined, {
    providers: registry,
  });
}

function client(auth: AuthContext): AttachedClient & { received: DaemonMessage[] } {
  const received: DaemonMessage[] = [];
  return { id: randomUUID(), auth, received, send: (m) => received.push(m) };
}

async function createSession(
  manager: SessionManager,
  c: AttachedClient,
  providerId?: string,
): Promise<string> {
  const resp = await manager.handle(
    { type: "session.create", id: "c1", name: "parent", workdir: tmp, ...(providerId ? { providerId } : {}) },
    AUTH,
    c,
  );
  expect(resp.type).toBe("response.ok");
  return (resp as { data: { id: string } }).data.id;
}

/** Send a turn and wait for the session to return to idle. */
async function sendAndSettle(
  manager: SessionManager,
  c: AttachedClient & { received: DaemonMessage[] },
  sessionId: string,
  text: string,
): Promise<void> {
  // Attach so the session's status broadcasts reach this client.
  await manager.handle({ type: "session.attach", id: "a1", sessionId }, AUTH, c);
  // Only count settles AFTER this send — otherwise a second turn on the same
  // client returns instantly on a PRIOR turn's stale `idle` (missing the gate).
  const start = c.received.length;
  await manager.handle({ type: "session.send", id: "s1", sessionId, text }, AUTH, c);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (
      c.received
        .slice(start)
        .some(
          (m) => m.type === "session.status_change" && (m.status === "idle" || m.status === "error"),
        )
    ) {
      return;
    }
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error("session never settled after send");
}

describe("SessionManager session.fork", () => {
  it("F1: forks with history carried, a new id, and the (fork) name", async () => {
    const { registry } = makeRegistry();
    const manager = makeManager(registry);
    const c = client(AUTH);
    const parentId = await createSession(manager, c);
    await sendAndSettle(manager, c, parentId, "hello parent");

    const resp = await manager.handle(
      { type: "session.fork", id: "f1", sessionId: parentId },
      AUTH,
      c,
    );
    expect(resp.type).toBe("response.ok");
    const fork = (resp as { data: { id: string; name: string; providerId?: string } }).data;
    expect(fork.id).not.toBe(parentId);
    expect(fork.name).toBe("parent (fork)");
    expect(fork.providerId).toBe("mock-a"); // inherits parent's backend

    // Lineage: the fork knows its parent + the branch point (1 user turn
    // "hello parent" was carried over).
    const forkInfo = fork as unknown as {
      forkedFrom?: { sessionId: string; name: string; atTurn: number };
    };
    expect(forkInfo.forkedFrom).toEqual({
      sessionId: parentId,
      name: "parent",
      atTurn: 1,
    });

    // The fork's history matches the parent's [user, assistant] turn.
    const info = await manager.handle({ type: "session.list", id: "l1" }, AUTH, c);
    const ids = (info as { sessions: Array<{ id: string }> }).sessions.map((s) => s.id);
    expect(ids).toContain(parentId);
    expect(ids).toContain(fork.id);

    // The replayed scrollback is persisted to the fork's OWN transcript and
    // restamped with the fork's id (survives restart; no foreign session id).
    await transcript.flush();
    const rows = await transcript.loadTranscript(fork.id, {});
    const msgs = rows.map((r) => r.message).filter((m) => m.type === "session.message");
    expect(msgs.length).toBeGreaterThan(0);
    for (const m of msgs) expect((m as { sessionId: string }).sessionId).toBe(fork.id);
    expect(msgs.some((m) => (m as { role: string }).role === "user")).toBe(true);
  });

  it("F1b: fork lineage is persisted in the transcript meta (survives restart)", async () => {
    const { registry } = makeRegistry();
    const manager = makeManager(registry);
    const c = client(AUTH);
    const parentId = await createSession(manager, c);
    await sendAndSettle(manager, c, parentId, "one");

    const resp = await manager.handle(
      { type: "session.fork", id: "f1b", sessionId: parentId },
      AUTH,
      c,
    );
    const fork = (resp as { data: { id: string; forkedFrom?: { atTurn: number } } }).data;
    await transcript.flush();

    // The fork's meta on disk carries the lineage — this is what a restart
    // reads back to repopulate SessionInfo.forkedFrom. It must round-trip
    // exactly what the live SessionInfo reported.
    const metas = await transcript.loadAllMeta();
    const meta = metas.find((m) => m.sessionId === fork.id);
    expect(meta?.forkedFrom).toBeDefined();
    expect(meta?.forkedFrom?.sessionId).toBe(parentId);
    expect(meta?.forkedFrom?.name).toBe("parent");
    expect(meta?.forkedFrom?.atTurn).toBe(fork.forkedFrom?.atTurn);
    expect(meta?.forkedFrom?.atTurn).toBeGreaterThanOrEqual(1);
  });

  it("F2: forks onto a DIFFERENT backend in one call, parent untouched", async () => {
    const { registry, created } = makeRegistry();
    const manager = makeManager(registry);
    const c = client(AUTH);
    const parentId = await createSession(manager, c, "mock-a");
    await sendAndSettle(manager, c, parentId, "hello");

    const resp = await manager.handle(
      { type: "session.fork", id: "f2", sessionId: parentId, providerId: "mock-b" },
      AUTH,
      c,
    );
    expect(resp.type).toBe("response.ok");
    const fork = (resp as { data: { id: string; providerId?: string } }).data;
    expect(fork.providerId).toBe("mock-b");

    // The mock-b provider (built for the fork) was seeded with the parent's
    // conversation — this is "branch claude, continue on codex" in miniature.
    const forkProvider = created["mock-b"]![0]!;
    expect(forkProvider.seededHistory?.length).toBeGreaterThanOrEqual(2);
    expect(forkProvider.seededHistory?.[0]).toMatchObject({ role: "user", content: "hello" });

    // Parent stays on mock-a, unchanged.
    const list = await manager.handle({ type: "session.list", id: "l2" }, AUTH, c);
    const sessions = (list as { sessions: Array<{ id: string; providerId?: string }> }).sessions;
    expect(sessions.find((s) => s.id === parentId)?.providerId).toBe("mock-a");
  });

  it("F3: unknown provider is rejected fail-closed", async () => {
    const { registry } = makeRegistry();
    const manager = makeManager(registry);
    const c = client(AUTH);
    const parentId = await createSession(manager, c);

    const resp = await manager.handle(
      { type: "session.fork", id: "f3", sessionId: parentId, providerId: "backend-from-the-future" },
      AUTH,
      c,
    );
    expect(resp).toMatchObject({ type: "response.error", code: "invalid_request" });
    if (resp.type === "response.error") expect(resp.error).toContain("backend-from-the-future");
  });

  it("F4: forking another tenant's session is not_found (no cross-tenant leak)", async () => {
    const { registry } = makeRegistry();
    const manager = makeManager(registry);
    const parentId = await createSession(manager, client(AUTH));

    const resp = await manager.handle(
      { type: "session.fork", id: "f4", sessionId: parentId },
      OTHER,
      client(OTHER),
    );
    expect(resp).toMatchObject({ type: "response.error", code: "not_found" });
  });

  it("F5: forking an unknown session is not_found", async () => {
    const { registry } = makeRegistry();
    const manager = makeManager(registry);
    const resp = await manager.handle(
      { type: "session.fork", id: "f5", sessionId: randomUUID() },
      AUTH,
      client(AUTH),
    );
    expect(resp).toMatchObject({ type: "response.error", code: "not_found" });
  });

  it("F6: a fork inherits the parent's execution mode (autonomous parent → autonomous fork)", async () => {
    const { registry } = makeRegistry();
    const manager = makeManager(registry);
    const c = client(AUTH);
    const parentId = await createSession(manager, c);

    // Put the parent in unbounded autonomous mode.
    const set = await manager.handle(
      { type: "session.set_mode", id: "m6", sessionId: parentId, mode: "autonomous" },
      AUTH,
      c,
    );
    expect(set.type).toBe("response.ok");

    const resp = await manager.handle(
      { type: "session.fork", id: "f6", sessionId: parentId },
      AUTH,
      c,
    );
    expect(resp.type).toBe("response.ok");
    const fork = (resp as { data: { mode?: string; turnsRemaining?: number } }).data;
    // Regression: forks used to always start `guarded` (the Session default),
    // so an autonomous parent's fork silently blocked its own writes/exec on
    // approval prompts that, unattended, got auto-denied ("Denied by user").
    expect(fork.mode).toBe("autonomous");
    expect(fork.turnsRemaining).toBeUndefined(); // unbounded budget carried over
  });

  it("F6b: a fork carries the parent's remaining autonomous budget", async () => {
    const { registry } = makeRegistry();
    const manager = makeManager(registry);
    const c = client(AUTH);
    const parentId = await createSession(manager, c);
    await manager.handle(
      { type: "session.set_mode", id: "m6b", sessionId: parentId, mode: "autonomous", maxTurns: 5 },
      AUTH,
      c,
    );

    const resp = await manager.handle(
      { type: "session.fork", id: "f6b", sessionId: parentId },
      AUTH,
      c,
    );
    const fork = (resp as { data: { mode?: string; turnsRemaining?: number } }).data;
    expect(fork.mode).toBe("autonomous");
    expect(fork.turnsRemaining).toBe(5);
  });

  it("F6c: mode is inherited even when the fork targets a DIFFERENT backend", async () => {
    const { registry } = makeRegistry();
    const manager = makeManager(registry);
    const c = client(AUTH);
    const parentId = await createSession(manager, c, "mock-a");
    await manager.handle(
      { type: "session.set_mode", id: "m6c", sessionId: parentId, mode: "autonomous" },
      AUTH,
      c,
    );

    // "Branch claude, continue on codex" style: switch provider AND carry mode.
    // The fork's target backend then applies that mode via its own native
    // policy path (e.g. codex → approvalPolicy "never"), identical to a
    // non-fork autonomous session on that backend.
    const resp = await manager.handle(
      { type: "session.fork", id: "f6c", sessionId: parentId, providerId: "mock-b" },
      AUTH,
      c,
    );
    expect(resp.type).toBe("response.ok");
    const fork = (resp as { data: { providerId?: string; mode?: string } }).data;
    expect(fork.providerId).toBe("mock-b"); // different backend
    expect(fork.mode).toBe("autonomous"); // mode carried across the provider switch
  });
});

// ── Git worktree isolation (real git) ────────────────────────────────────────

const execFileP = promisify(execFile);
const gitIn = (args: string[], cwd: string) =>
  execFileP("git", args, { cwd }).then((r) => r.stdout.trim());

async function makeGitRepoWithDirtyEdit(): Promise<string> {
  const repo = join(tmp, "repo");
  await execFileP("git", ["init", "-b", "main", repo]);
  await gitIn(["config", "user.email", "t@t.dev"], repo);
  await gitIn(["config", "user.name", "t"], repo);
  writeFileSync(join(repo, "file.txt"), "committed\n");
  await gitIn(["add", "."], repo);
  await gitIn(["commit", "-m", "init"], repo);
  writeFileSync(join(repo, "file.txt"), "committed\nWIP\n"); // dirty tracked edit
  return repo;
}

async function createIn(manager: SessionManager, c: AttachedClient, workdir: string): Promise<string> {
  const resp = await manager.handle(
    { type: "session.create", id: randomUUID(), name: "parent", workdir },
    AUTH,
    c,
  );
  expect(resp.type).toBe("response.ok");
  return (resp as { data: { id: string } }).data.id;
}

describe("SessionManager session.fork — git worktree isolation", () => {
  it("W1: fork of a git-repo session gets its own worktree+branch carrying the parent's dirty edit; parent untouched; destroy cleans up", async () => {
    const repo = await makeGitRepoWithDirtyEdit();
    const parentHead = await gitIn(["rev-parse", "HEAD"], repo);
    const { registry } = makeRegistry();
    const manager = makeManager(registry);
    const c = client(AUTH);
    const parentId = await createIn(manager, c, repo);
    await sendAndSettle(manager, c, parentId, "hello");

    const resp = await manager.handle(
      { type: "session.fork", id: "w1", sessionId: parentId },
      AUTH,
      c,
    );
    expect(resp.type).toBe("response.ok");
    const fork = (resp as { data: { id: string; workdir: string; worktree?: { path: string; branch: string; createdByCodeoid: boolean } } }).data;

    // The fork runs in its OWN worktree, on a codeoid branch, that codeoid owns.
    expect(fork.worktree).toBeDefined();
    expect(fork.worktree!.createdByCodeoid).toBe(true);
    expect(fork.worktree!.branch).toMatch(/^codeoid\//);
    expect(fork.workdir).toBe(fork.worktree!.path);
    expect(fork.workdir).not.toBe(repo);
    expect(existsSync(fork.workdir)).toBe(true);

    // It carries the parent's UNCOMMITTED edit, as uncommitted work (tip == parent HEAD).
    expect(readFileSync(join(fork.workdir, "file.txt"), "utf8")).toBe("committed\nWIP\n");
    expect(await gitIn(["rev-parse", "HEAD"], fork.workdir)).toBe(parentHead);
    expect(await gitIn(["status", "--porcelain"], fork.workdir)).toContain("file.txt");

    // Parent's checkout is untouched: same HEAD, same branch, same dirty file.
    expect(await gitIn(["rev-parse", "HEAD"], repo)).toBe(parentHead);
    expect(await gitIn(["rev-parse", "--abbrev-ref", "HEAD"], repo)).toBe("main");
    expect(readFileSync(join(repo, "file.txt"), "utf8")).toBe("committed\nWIP\n");

    // Destroy the fork → worktree dir removed, branch KEPT (work recoverable).
    const wtPath = fork.workdir;
    const branch = fork.worktree!.branch;
    await manager.handle({ type: "session.destroy", id: "d1", sessionId: fork.id }, AUTH, c);
    await new Promise((r) => setTimeout(r, 100));
    expect(existsSync(wtPath)).toBe(false);
    expect(await gitIn(["branch", "--list", branch], repo)).toContain(branch);
  });

  it("W2: isolate:false shares the parent's workdir (no worktree)", async () => {
    const repo = await makeGitRepoWithDirtyEdit();
    const { registry } = makeRegistry();
    const manager = makeManager(registry);
    const c = client(AUTH);
    const parentId = await createIn(manager, c, repo);
    await sendAndSettle(manager, c, parentId, "hello");

    const resp = await manager.handle(
      { type: "session.fork", id: "w2", sessionId: parentId, isolate: false },
      AUTH,
      c,
    );
    const fork = (resp as { data: { workdir: string; worktree?: unknown } }).data;
    expect(fork.worktree).toBeUndefined();
    expect(fork.workdir).toBe(repo);
  });

  it("W3: forking a non-git workdir shares it and surfaces a collision warning", async () => {
    // `tmp` (the beforeEach temp dir) is a plain directory, not a git repo.
    const { registry } = makeRegistry();
    const manager = makeManager(registry);
    const c = client(AUTH);
    const parentId = await createIn(manager, c, tmp);
    await sendAndSettle(manager, c, parentId, "hello");

    const resp = await manager.handle(
      { type: "session.fork", id: "w3", sessionId: parentId },
      AUTH,
      c,
    );
    const fork = (resp as { data: { id: string; workdir: string; worktree?: unknown } }).data;
    expect(fork.worktree).toBeUndefined();
    expect(fork.workdir).toBe(tmp);

    // A visible collision warning is persisted in the fork's own scrollback.
    await transcript.flush();
    const rows = await transcript.loadTranscript(fork.id, {});
    const warn = rows
      .map((r) => r.message)
      .find((m) => m.type === "session.message" && (m as { metadata?: { event?: string } }).metadata?.event === "fork.workdir");
    expect(warn).toBeDefined();
  });

  it("W4: a fork of a session working in a repo SUBDIR opens in the equivalent worktree subdir", async () => {
    const repo = await makeGitRepoWithDirtyEdit();
    const sub = join(repo, "packages", "api");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, "x.txt"), "a\n");
    await gitIn(["add", "."], repo);
    await gitIn(["commit", "-m", "subdir"], repo);

    const { registry } = makeRegistry();
    const manager = makeManager(registry);
    const c = client(AUTH);
    const parentId = await createIn(manager, c, sub); // parent runs in the subdir
    await sendAndSettle(manager, c, parentId, "hello");

    const resp = await manager.handle({ type: "session.fork", id: "w4", sessionId: parentId }, AUTH, c);
    const fork = (resp as { data: { workdir: string; worktree?: { path: string } } }).data;
    expect(fork.worktree).toBeDefined();
    // Fork opens in <worktree-root>/packages/api; the stored worktree path is the ROOT.
    expect(fork.workdir).toBe(join(fork.worktree!.path, "packages", "api"));
    expect(fork.workdir).not.toBe(fork.worktree!.path);
    expect(existsSync(fork.workdir)).toBe(true);
  });

  it("W5: bind mode (workdir) validates the path like session.create", async () => {
    const repo = await makeGitRepoWithDirtyEdit();
    const { registry } = makeRegistry();
    const manager = makeManager(registry);
    const c = client(AUTH);
    const parentId = await createIn(manager, c, repo);
    await sendAndSettle(manager, c, parentId, "hello");

    // A non-existent bind workdir is REJECTED (was previously accepted raw).
    const bad = await manager.handle(
      { type: "session.fork", id: "w5a", sessionId: parentId, workdir: join(tmp, "does-not-exist") },
      AUTH,
      c,
    );
    expect(bad).toMatchObject({ type: "response.error", code: "invalid_request" });

    // A valid dir binds: branch recorded, createdByCodeoid false (never removed).
    const ok = await manager.handle(
      { type: "session.fork", id: "w5b", sessionId: parentId, workdir: repo },
      AUTH,
      c,
    );
    expect(ok.type).toBe("response.ok");
    const fork = (ok as { data: { worktree?: { createdByCodeoid: boolean; branch: string } } }).data;
    expect(fork.worktree?.createdByCodeoid).toBe(false);
    expect(fork.worktree?.branch).toBe("main");
  });

  it("W6: baseBranch forks CLEAN from the base via the manager; unknown base errors", async () => {
    const repo = await makeGitRepoWithDirtyEdit();
    // Divergent base branch with different content.
    await gitIn(["checkout", "-b", "release"], repo);
    writeFileSync(join(repo, "file.txt"), "release-content\n");
    await gitIn(["commit", "-am", "release"], repo);
    await gitIn(["checkout", "main"], repo);

    const { registry } = makeRegistry();
    const manager = makeManager(registry);
    const c = client(AUTH);
    const parentId = await createIn(manager, c, repo);
    await sendAndSettle(manager, c, parentId, "hello");

    const ok = await manager.handle(
      { type: "session.fork", id: "w6", sessionId: parentId, baseBranch: "release" },
      AUTH,
      c,
    );
    expect(ok.type).toBe("response.ok");
    const fork = (ok as { data: { workdir: string; worktree?: { branch: string; createdByCodeoid: boolean } } }).data;
    expect(fork.worktree?.createdByCodeoid).toBe(true);
    expect(fork.worktree?.branch).toMatch(/^codeoid\//);
    // Clean checkout of the base, not the parent's state.
    expect(readFileSync(join(fork.workdir, "file.txt"), "utf8")).toBe("release-content\n");

    // Unknown base ref is a user error.
    const bad = await manager.handle(
      { type: "session.fork", id: "w6b", sessionId: parentId, baseBranch: "no-such-branch" },
      AUTH,
      c,
    );
    expect(bad).toMatchObject({ type: "response.error", code: "invalid_request" });
  });

  it("W7: fork.setup runs in the new worktree and the first turn WAITS for it", async () => {
    const repo = await makeGitRepoWithDirtyEdit();
    const { registry } = makeRegistry();
    // A full defaults config (loadConfig applies schema defaults) with only
    // fork.setup overridden — a partial config would break other config reads.
    const config = { ...loadConfig(), fork: { setup: "touch .setup-ran" } };
    const manager = new SessionManager(store, transcript, undefined, undefined, undefined, {
      providers: registry,
      config,
    } as never);
    const c = client(AUTH);
    const parentId = await createIn(manager, c, repo);
    await sendAndSettle(manager, c, parentId, "hello");

    const resp = await manager.handle({ type: "session.fork", id: "w7", sessionId: parentId }, AUTH, c);
    const fork = (resp as { data: { id: string; workdir: string } }).data;

    // The first turn gates on setup; once it settles, setup has finished →
    // the marker exists (proving both that setup ran AND that the turn waited).
    await sendAndSettle(manager, c, fork.id, "go");
    expect(existsSync(join(fork.workdir, ".setup-ran"))).toBe(true);

    // Setup start + completion are surfaced in the fork's scrollback.
    await transcript.flush();
    const events = (await transcript.loadTranscript(fork.id, {}))
      .map((r) => r.message)
      .filter((m) => m.type === "session.message")
      .map((m) => (m as { metadata?: { event?: string } }).metadata?.event);
    expect(events).toContain("fork.setup.start");
    expect(events).toContain("fork.setup.done");
  });

  it("W8: the repository's setup recipe prepares the fork's worktree before its first turn, and destroy takes it back out", async () => {
    const repo = await makeGitRepoWithDirtyEdit();
    mkdirSync(join(repo, ".codeoid"));
    writeFileSync(join(repo, ".codeoid", "setup.yaml"), "copy: [.env]\ncommand: cat .env > .recipe-ran\n");
    writeFileSync(join(repo, ".gitignore"), ".env\n.recipe-ran\n");
    await gitIn(["add", ".codeoid", ".gitignore"], repo);
    await gitIn(["commit", "-m", "recipe"], repo);
    writeFileSync(join(repo, ".env"), "TOKEN=1\n");
    const { registry } = makeRegistry();
    const config = { ...loadConfig(), worktree: { setup: { runCommands: "trusted-repos" as const, trustedRepos: [repo] } } };
    const manager = new SessionManager(store, transcript, undefined, undefined, undefined, {
      providers: registry,
      config,
    } as never);
    const c = client(AUTH);
    const parentId = await createIn(manager, c, repo);
    await sendAndSettle(manager, c, parentId, "hello");

    const resp = await manager.handle({ type: "session.fork", id: "w8", sessionId: parentId }, AUTH, c);
    const fork = (resp as { data: { id: string; workdir: string; worktree: { path: string; branch: string } } }).data;
    await sendAndSettle(manager, c, fork.id, "go");
    expect(readFileSync(join(fork.workdir, ".recipe-ran"), "utf8")).toBe("TOKEN=1\n");

    // Recorded on the session (checkpoint exclusions, cleanup) and surfaced.
    const info = (await manager.handle({ type: "session.list", id: "l8" }, AUTH, c)) as {
      sessions: { id: string; worktree?: { setup?: { copied: string[] } } }[];
    };
    expect(info.sessions.find((s) => s.id === fork.id)?.worktree?.setup?.copied).toEqual([".env"]);
    await transcript.flush();
    const done = (await transcript.loadTranscript(fork.id, {}))
      .map((r) => r.message)
      .filter((m) => m.type === "session.message")
      .find((m) => (m as { metadata?: { event?: string } }).metadata?.event === "worktree.setup.done") as
      | { content?: string; metadata?: { copied?: string[] } }
      | undefined;
    expect(done?.metadata?.copied).toEqual([".env"]);

    await manager.handle({ type: "session.destroy", id: "d8", sessionId: fork.id }, AUTH, c);
    expect(existsSync(fork.worktree.path)).toBe(false);
    const kept = (await gitIn(["ls-tree", "-r", "--name-only", fork.worktree.branch], repo)).split("\n");
    expect(kept).not.toContain(".env");
    expect(readFileSync(join(repo, ".env"), "utf8")).toBe("TOKEN=1\n");
  });
});
