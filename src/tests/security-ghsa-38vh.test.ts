/**
 * GHSA-38vh regression coverage — local privilege escalation to the root
 * ZeroID key. Two of the three vectors are exercised here end-to-end (the
 * third, the provider env allowlist, is unit-tested as buildAgentEnv in
 * provider-claude.test.ts; the fs.read/workdir deny-list lives in fs.test.ts):
 *
 *   V1  session.export must NOT embed a pinned file that escapes the workdir.
 *   V2  session.create must reject a workdir inside a protected directory
 *       (the daemon's own config/secret store).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../daemon/store.js";
import { TranscriptStore } from "../daemon/transcript.js";
import { SessionManager } from "../daemon/session-manager.js";
import { packSession } from "../daemon/share/index.js";
import { getConfigDir } from "../config.js";
import type { AuthContext } from "../protocol/types.js";
import { ALL_SCOPES } from "../protocol/scopes.js";

const AUTH: AuthContext = {
  sub: "user:ghsa",
  scopes: [...ALL_SCOPES] as AuthContext["scopes"],
  delegationDepth: 0,
  accountId: "acc",
  projectId: "proj",
};
const CLIENT = { id: "client", auth: AUTH, send: () => {} };

let tmp: string;
let store: Store;
let transcript: TranscriptStore;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "codeoid-ghsa38vh-"));
  store = new Store(join(tmp, "codeoid.db"));
  transcript = new TranscriptStore(join(tmp, "transcripts"));
});

afterEach(async () => {
  try { await transcript.flush(); } catch {}
  try { store.close(); } catch {}
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
});

// ── V1: pinned-file export containment ────────────────────────────────────────

describe("session.export pinned-file containment (vector 1)", () => {
  it("captures an in-workdir pin but skips one that escapes the workdir", async () => {
    const workdir = join(tmp, "project");
    const secretDir = join(tmp, "secrets");
    mkdirSync(workdir, { recursive: true });
    mkdirSync(secretDir, { recursive: true });
    writeFileSync(join(workdir, "inside.txt"), "IN-WORKDIR-CONTENT");
    // The attacker-pinned host secret (e.g. ~/.codeoid/config.json).
    const secretPath = join(secretDir, "config.json");
    writeFileSync(secretPath, "ROOT-ZEROID-KEY-SECRET");

    const bundle = await packSession(
      {
        session: {
          id: "s1",
          name: "s",
          workdir,
          createdAt: new Date(0).toISOString(),
          pinnedFiles: ["inside.txt", secretPath],
        },
        exporter: AUTH,
        includeMemory: false,
        includePinnedFiles: true,
      },
      { transcript, store, memory: null, workspaceIdFor: () => "ws" },
    );

    const contents = Object.values(bundle.pinnedFiles ?? {}).map((s) => s.content);
    expect(contents.some((c) => c.includes("IN-WORKDIR-CONTENT"))).toBe(true);
    // The escaping pin is refused — its content never lands in the bundle.
    expect(contents.some((c) => c.includes("ROOT-ZEROID-KEY-SECRET"))).toBe(false);
    expect(bundle.manifest.counts.pinnedFiles).toBe(1);
  });
});

// ── V2: workdir containment at session creation ───────────────────────────────

describe("session.create workdir containment (vector 2)", () => {
  let savedXdg: string | undefined;
  let manager: SessionManager;

  beforeEach(() => {
    savedXdg = process.env.XDG_CONFIG_HOME;
    manager = new SessionManager(store, transcript);
  });
  afterEach(() => {
    if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = savedXdg;
  });

  it("rejects a workdir inside the daemon's protected config dir", async () => {
    // Point the config dir under tmp so the test is hermetic.
    process.env.XDG_CONFIG_HOME = join(tmp, "xdg");
    const configDir = getConfigDir(); // <tmp>/xdg/codeoid
    mkdirSync(configDir, { recursive: true });

    const res = (await manager.handle(
      { type: "session.create", id: "c1", name: "evil", workdir: configDir },
      AUTH,
      CLIENT,
    )) as { type: string; code?: string };

    expect(res.type).toBe("response.error");
    expect(res.code).toBe("invalid_request");
  });

  it("accepts a normal workdir outside any protected directory", async () => {
    process.env.XDG_CONFIG_HOME = join(tmp, "xdg");
    const workdir = join(tmp, "project");
    mkdirSync(workdir, { recursive: true });

    const res = (await manager.handle(
      { type: "session.create", id: "c2", name: "ok", workdir },
      AUTH,
      CLIENT,
    )) as { type: string; data?: { id: string } };

    expect(res.type).toBe("response.ok");
    expect(res.data?.id).toBeDefined();
  });

  it("enforces CODEOID_FS_BROWSE_ROOT as a workdir safe-root when set", async () => {
    process.env.XDG_CONFIG_HOME = join(tmp, "xdg");
    const savedRoot = process.env.CODEOID_FS_BROWSE_ROOT;
    const root = join(tmp, "allowed");
    const outside = join(tmp, "elsewhere");
    mkdirSync(join(root, "proj"), { recursive: true });
    mkdirSync(outside, { recursive: true });
    process.env.CODEOID_FS_BROWSE_ROOT = root;
    try {
      const inside = (await manager.handle(
        { type: "session.create", id: "c3", name: "in", workdir: join(root, "proj") },
        AUTH,
        CLIENT,
      )) as { type: string };
      expect(inside.type).toBe("response.ok");

      const out = (await manager.handle(
        { type: "session.create", id: "c4", name: "out", workdir: outside },
        AUTH,
        CLIENT,
      )) as { type: string; code?: string };
      expect(out.type).toBe("response.error");
      expect(out.code).toBe("invalid_request");
    } finally {
      if (savedRoot === undefined) delete process.env.CODEOID_FS_BROWSE_ROOT;
      else process.env.CODEOID_FS_BROWSE_ROOT = savedRoot;
    }
  });

  it("keeps the host-wide folder browser away from a read-only watcher (fs:read without session:create)", async () => {
    const watcher: AuthContext = { ...AUTH, scopes: ["session:list", "session:watch", "fs:read"] as AuthContext["scopes"] };
    const refused = (await manager.handle({ type: "fs.browse_dir", id: "w1", path: "/" }, watcher, CLIENT)) as {
      type: string;
      code?: string;
      error?: string;
    };
    expect(refused).toMatchObject({ type: "response.error", code: "forbidden", error: "Missing scope: session:create" });
    const allowed = (await manager.handle({ type: "fs.browse_dir", id: "w2", path: tmp }, AUTH, CLIENT)) as { type: string };
    expect(allowed.type).toBe("fs.browse_dir.result");
  });
});
