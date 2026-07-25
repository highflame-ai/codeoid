/**
 * Pack-management control-plane handlers — pipeline.pack.* / pipeline.registry.*
 * routed through the real SessionManager.handle(), covering scope enforcement
 * (read vs owner-tier manage) and the install → select → remove flow.
 *
 * XDG_CONFIG_HOME is pointed at a temp dir so the handlers' config.json writes
 * are isolated from the developer's real ~/.codeoid, and installs use a local
 * pack `dir` (no git / no network).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodeoidConfig } from "../config.js";
import { SessionManager } from "../daemon/session-manager.js";
import { Store } from "../daemon/store.js";
import { TranscriptStore } from "../daemon/transcript.js";
import { ALL_SCOPES, SCOPES, type Scope } from "../protocol/scopes.js";
import type { ClientMessage, AuthContext, DaemonMessage, PackListResultMsg } from "../protocol/types.js";

function auth(scopes: readonly Scope[]): AuthContext {
  return { sub: "user:t", scopes: [...scopes] as AuthContext["scopes"], delegationDepth: 0, accountId: "acc", projectId: "proj" };
}
const OWNER = auth(ALL_SCOPES);
/** Route a message through the real handler under a given identity. */
function run(msg: ClientMessage, a: AuthContext): Promise<DaemonMessage> {
  return manager.handle(msg, a, { id: "c", auth: a, send: () => {} });
}

function mkConfig(dbPath: string): CodeoidConfig {
  return {
    daemonUrl: "ws://127.0.0.1:7400",
    dbPath,
    transcriptDir: join(tmpdir(), "codeoid-pkh-transcripts"),
    auth: { baseUrl: "http://localhost:8899" },
    zeroidUrl: "http://localhost:8899",
    workspaceIndex: { enabled: false, episodeThreshold: 5, timeThresholdMs: 60_000, debounceMs: 15_000 },
    compress: { enabled: false, excludeCommands: [], excludePatterns: [], compressPipes: false, minBytes: 1024 },
    labeling: {},
    telemetry: { osc8: "auto" },
    autoRotate: { enabled: false, warnPct: 0.6, rotatePct: 0.8, hardRotatePct: 0.9, minTurnsBeforeRotate: 3, strategy: "task-anchor" },
    session: {},
    conductor: { enabled: false, name: "conductor", provider: "claude" },
    dispatch: { enabled: false, tickMs: 999_999, leaseMs: 60_000, failureLimit: 2, maxConcurrentWorkers: 2, workerToolBudget: 7, retryBaseMs: 0 },
    pipeline: { enabled: true, defaultPack: null, packs: [], registries: [] },
  };
}

function writePack(dir: string, id: string): void {
  mkdirSync(join(dir, "roles"), { recursive: true });
  writeFileSync(join(dir, "ETHOS.md"), "Be good.");
  writeFileSync(join(dir, "roles", "implementer.yaml"), "name: implementer\nwrite: true\nnetwork: read-only\nenvelope: all\n");
  writeFileSync(
    join(dir, "pack.yaml"),
    `schema: codeoid/pack@v1\nid: ${id}\nname: Pack ${id}\nversion: 1.0.0\nconstitution: ./ETHOS.md\nroles: [./roles/implementer.yaml]\nskills:\n  - { id: build, kind: prompt, template: "x" }\nphases:\n  - { id: impl, kind: skill, skill: build, role: implementer }\n`,
  );
}

function packs(m: DaemonMessage): PackListResultMsg {
  if (m.type !== "pipeline.pack.list.result") throw new Error(`expected pack.list.result, got ${m.type}`);
  return m;
}

let tmp: string;
let store: Store;
let transcript: TranscriptStore;
let manager: SessionManager;
let prevXdg: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "codeoid-pkh-"));
  mkdirSync(join(tmp, "repo"), { recursive: true });
  prevXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = join(tmp, "xdg"); // isolate config.json writes
  store = new Store(join(tmp, "codeoid.db"));
  transcript = new TranscriptStore(join(tmp, "transcripts"));
  manager = new SessionManager(store, transcript, undefined, undefined, undefined, { config: mkConfig(join(tmp, "codeoid.db")) });
});

afterEach(async () => {
  try {
    await manager.drain(3_000);
  } catch {}
  if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = prevXdg;
  rmSync(tmp, { recursive: true, force: true });
});

describe("scope enforcement", () => {
  test("pipeline.pack.list needs pipeline:read", async () => {
    const denied = await run({ type: "pipeline.pack.list", id: "r1" }, auth([]));
    expect(denied.type).toBe("response.error");
    if (denied.type === "response.error") expect(denied.code).toBe("forbidden");

    const ok = await run({ type: "pipeline.pack.list", id: "r2" }, auth([SCOPES.PIPELINE_READ]));
    expect(packs(ok).installed).toEqual([]);
  });

  test("mutating verbs need owner-tier pipeline:manage (read alone is rejected)", async () => {
    const dir = join(tmp, "p");
    writePack(dir, "x");
    const denied = await run({ type: "pipeline.pack.install", id: "r3", dir }, auth([SCOPES.PIPELINE_READ]));
    expect(denied.type).toBe("response.error");
    if (denied.type === "response.error") expect(denied.code).toBe("forbidden");
  });
});

describe("install → select → remove flow (local dir)", () => {
  test("install registers the pack, persists, and lists it active", async () => {
    const dir = join(tmp, "mypack");
    writePack(dir, "mypack");
    const res = packs(await run({ type: "pipeline.pack.install", id: "r4", dir }, OWNER));
    const p = res.installed.find((x) => x.id === "mypack")!;
    expect(p).toBeTruthy();
    expect(p.active).toBe(true); // pipeline is enabled → registered live
    expect(p.trusted).toBe(false); // untrusted by default
    // a fresh list reflects the persisted install
    const again = packs(await run({ type: "pipeline.pack.list", id: "r5" }, OWNER));
    expect(again.installed.map((x) => x.id)).toContain("mypack");
  });

  test("a created pipeline can use the just-installed pack, and select sets the default", async () => {
    const dir = join(tmp, "flow");
    writePack(dir, "flow");
    await run({ type: "pipeline.pack.install", id: "r6", dir }, OWNER);
    await run({ type: "pipeline.pack.select", id: "r7", packId: "flow" }, OWNER);

    const listed = packs(await run({ type: "pipeline.pack.list", id: "r8" }, OWNER));
    expect(listed.installed.find((x) => x.id === "flow")!.selected).toBe(true);

    // The pack is registered, so pipeline.create({ pack }) resolves it.
    const created = await run(
      { type: "pipeline.create", id: "r9", name: "run", pack: "flow", workdir: join(tmp, "repo") },
      OWNER,
    );
    expect(created.type).toBe("pipeline.snapshot");
  });

  test("remove unregisters + drops it from the list", async () => {
    const dir = join(tmp, "bye");
    writePack(dir, "bye");
    await run({ type: "pipeline.pack.install", id: "r10", dir }, OWNER);
    const after = packs(await run({ type: "pipeline.pack.remove", id: "r11", packId: "bye" }, OWNER));
    expect(after.installed.find((x) => x.id === "bye")).toBeUndefined();
  });

  test("trust toggles the pack's trust state", async () => {
    const dir = join(tmp, "trusty");
    writePack(dir, "trusty");
    await run({ type: "pipeline.pack.install", id: "r12", dir }, OWNER);
    const after = packs(await run({ type: "pipeline.pack.trust", id: "r13", packId: "trusty", trusted: true }, OWNER));
    expect(after.installed.find((x) => x.id === "trusty")!.trusted).toBe(true);
  });
});

describe("pipeline.registry.refresh", () => {
  test("needs pipeline:manage — read-only scope is rejected", async () => {
    const denied = await run(
      { type: "pipeline.registry.refresh", id: "ref1" },
      auth([SCOPES.PIPELINE_READ]),
    );
    expect(denied.type).toBe("response.error");
    if (denied.type === "response.error") expect(denied.code).toBe("forbidden");
  });

  test("refresh on an uncached registry name returns a valid pack list (no error)", async () => {
    // PackService.refresh() skips registries whose cache dir has no .git — so
    // refreshing a name that never existed is not an error.
    const res = await run({ type: "pipeline.registry.refresh", id: "ref2", name: "nonexistent" }, OWNER);
    expect(res.type).toBe("pipeline.pack.list.result");
    if (res.type === "pipeline.pack.list.result") expect(res.installed).toEqual([]);
  });

  test("refresh with no name succeeds when there are no registries", async () => {
    const res = await run({ type: "pipeline.registry.refresh", id: "ref3" }, OWNER);
    expect(res.type).toBe("pipeline.pack.list.result");
  });

  test("refresh with an installed pack returns that pack in the list result", async () => {
    const dir = join(tmp, "refreshable");
    writePack(dir, "refreshable");
    await run({ type: "pipeline.pack.install", id: "ref4", dir }, OWNER);
    const res = await run({ type: "pipeline.registry.refresh", id: "ref5" }, OWNER);
    expect(res.type).toBe("pipeline.pack.list.result");
    if (res.type === "pipeline.pack.list.result") {
      expect(res.installed.find((p) => p.id === "refreshable")).toBeTruthy();
    }
  });
});

describe("error + guard branches", () => {
  test("registry.add is rejected without pipeline:manage (before any git)", async () => {
    const denied = await run(
      { type: "pipeline.registry.add", id: "r14", url: "https://example.com/x.git" },
      auth([SCOPES.PIPELINE_READ]),
    );
    expect(denied.type).toBe("response.error");
    if (denied.type === "response.error") expect(denied.code).toBe("forbidden");
  });

  test("installing a non-pack directory returns an invalid_request error", async () => {
    const bad = join(tmp, "not-a-pack");
    mkdirSync(bad, { recursive: true }); // no pack.yaml
    const resp = await run({ type: "pipeline.pack.install", id: "r15", dir: bad }, OWNER);
    expect(resp.type).toBe("response.error");
    if (resp.type === "response.error") expect(resp.code).toBe("invalid_request");
  });

  test("selecting an uninstalled pack errors", async () => {
    const resp = await run({ type: "pipeline.pack.select", id: "r16", packId: "ghost" }, OWNER);
    expect(resp.type).toBe("response.error");
  });
});
