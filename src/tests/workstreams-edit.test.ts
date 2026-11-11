/**
 * Editing workstreams and credentials live (W2): written to config.json /
 * .env through the settings store (whole config validated, nothing written
 * otherwise), applied to the running daemon at once, and announced.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config.js";
import { MockSessionProvider } from "../daemon/providers/mock/session-provider.js";
import { ProviderRegistry } from "../daemon/providers/registry.js";
import { SessionManager } from "../daemon/session-manager.js";
import { Store } from "../daemon/store.js";
import { TranscriptStore } from "../daemon/transcript.js";
import { FolderReader } from "../daemon/workstreams/folder.js";
import { ALL_SCOPES, SCOPES } from "../protocol/scopes.js";
import type { AuthContext, DaemonMessage, SessionInfo } from "../protocol/types.js";

const OWNER: AuthContext = { sub: "user:edit", scopes: [...ALL_SCOPES] as AuthContext["scopes"], delegationDepth: 0, accountId: "acc", projectId: "proj" };
const pushed: DaemonMessage[] = [];
const client = { id: "c-edit", auth: OWNER, send: (m: DaemonMessage) => void pushed.push(m) };

let tmp: string;
let store: Store;
let transcript: TranscriptStore;
let savedXdg: string | undefined;
let manager: SessionManager;

function configJson(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(tmp, "config", "codeoid", "config.json"), "utf8"));
}

beforeEach(async () => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "codeoid-ws-edit-")));
  savedXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = join(tmp, "config");
  mkdirSync(join(tmp, "config", "codeoid"), { recursive: true });
  mkdirSync(join(tmp, "home", "acme"), { recursive: true });
  writeFileSync(join(tmp, "config", "codeoid", "config.json"), JSON.stringify({ dbPath: join(tmp, "codeoid.db"), transcriptDir: join(tmp, "transcripts") }));
  store = new Store(join(tmp, "codeoid.db"));
  transcript = new TranscriptStore(join(tmp, "transcripts"));
  manager = new SessionManager(store, transcript, undefined, undefined, undefined, {
    config: loadConfig({ env: {}, quiet: true }),
    _testProviderFactory: () => new MockSessionProvider(),
    _testFolderReader: new FolderReader({ home: join(tmp, "home"), sshConfig: "" }),
  });
  // Subscribe the client to provider/workstream broadcasts, as a web client does.
  await manager.handle({ type: "providers.list", id: "sub" } as never, OWNER, client);
  pushed.length = 0;
});

afterEach(async () => {
  try {
    await manager.drain(2_000);
  } catch {}
  try {
    await transcript.flush();
  } catch {}
  store.close();
  if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedXdg;
  for (const k of Object.keys(process.env)) if (k.startsWith("CODEOID_CRED_")) delete process.env[k];
  rmSync(tmp, { recursive: true, force: true });
});

const h = (msg: Record<string, unknown>, auth: AuthContext = OWNER) => manager.handle(msg as never, auth, client);

describe("editing workstreams", () => {
  it("an upsert is validated, written, applied at once and announced; a create there gets it", async () => {
    const r = await h({ type: "workstream.upsert", id: "u1", item: { id: "acme", claim: "exclusive", match: { paths: ["~/acme"] } } });
    expect(r).toMatchObject({ type: "workstream.list.result", workstreams: [{ id: "acme", claim: "exclusive" }] });
    expect((configJson().workstreams as { items: unknown[] }).items).toEqual([{ id: "acme", claim: "exclusive", match: { paths: ["~/acme"] } }]);
    expect(pushed.some((m) => m.type === "workstreams.changed")).toBe(true);
    const made = (await h({ type: "session.create", id: "c1", name: "s", workdir: join(tmp, "home", "acme") })) as { data: SessionInfo };
    expect(made.data.workstream).toMatchObject({ id: "acme", source: "matched" });
  });

  it("an invalid item writes nothing and says why", async () => {
    const before = readFileSync(join(tmp, "config", "codeoid", "config.json"), "utf8");
    const r = await h({ type: "workstream.upsert", id: "u2", item: { id: "Bad Id" } });
    expect(r).toMatchObject({ type: "response.error", code: "invalid_request" });
    if (r.type === "response.error") expect(r.error).toContain("workstream id");
    expect(readFileSync(join(tmp, "config", "codeoid", "config.json"), "utf8")).toBe(before);
  });

  it("settings and delete; a deleted default is removed with it", async () => {
    await h({ type: "workstream.upsert", id: "u3", item: { id: "acme" } });
    const s = await h({ type: "workstream.settings", id: "u4", isolateGlobalServers: true, default: "acme" });
    expect(s).toMatchObject({ isolateGlobalServers: true, default: "acme" });
    const d = await h({ type: "workstream.delete", id: "u5", workstream: "acme" });
    expect(d).toMatchObject({ type: "workstream.list.result", workstreams: [] });
    expect((d as { default?: string }).default).toBeUndefined();
  });

  it("needs settings:write on an undelegated token", async () => {
    expect(await h({ type: "workstream.upsert", id: "u6", item: { id: "x" } }, { ...OWNER, scopes: [SCOPES.SETTINGS_READ] as AuthContext["scopes"] })).toMatchObject({ code: "forbidden" });
    expect(await h({ type: "workstream.upsert", id: "u7", item: { id: "x" } }, { ...OWNER, delegationDepth: 1 })).toMatchObject({ code: "forbidden" });
  });
});

describe("editing credentials", () => {
  it("declare, set a value (never returned), see it used, refuse deleting it while used, then delete", async () => {
    const up = await h({ type: "credential.upsert", id: "k1", item: { id: "gh-acme", kind: "env" } });
    expect(up).toMatchObject({ type: "credential.list.result", store: { kind: "env-file", writable: true }, credentials: [{ id: "gh-acme", status: { set: false }, usedBy: [] }] });
    const set = await h({ type: "credential.set_value", id: "k2", credential: "gh-acme", value: "ghp_secret_value" });
    expect(JSON.stringify(set)).not.toContain("ghp_secret_value");
    expect(set).toMatchObject({ credentials: [{ id: "gh-acme", status: { set: true, source: "CODEOID_CRED_GH_ACME" } }] });
    expect(readFileSync(join(tmp, "config", "codeoid", ".env"), "utf8")).toContain("CODEOID_CRED_GH_ACME=ghp_secret_value");
    await h({ type: "workstream.upsert", id: "k3", item: { id: "acme", env: { GH_TOKEN: { secret: "gh-acme" } } } });
    expect(await h({ type: "credential.list", id: "k4" })).toMatchObject({ credentials: [{ usedBy: ["acme"] }] });
    const blocked = await h({ type: "credential.delete", id: "k5", credential: "gh-acme" });
    expect(blocked).toMatchObject({ type: "response.error" });
    if (blocked.type === "response.error") expect(blocked.error).toContain("used by acme");
    await h({ type: "workstream.delete", id: "k6", workstream: "acme" });
    expect(await h({ type: "credential.delete", id: "k7", credential: "gh-acme" })).toMatchObject({ credentials: [] });
    expect(readFileSync(join(tmp, "config", "codeoid", ".env"), "utf8")).not.toContain("CODEOID_CRED_GH_ACME");
  });

  it("a multi-line value, an undeclared one, or an OAuth one's value is refused", async () => {
    await h({ type: "credential.upsert", id: "m1", item: { id: "e", kind: "env" } });
    await h({ type: "credential.upsert", id: "m2", item: { id: "o", kind: "oauth", server: "slack" } });
    expect(await h({ type: "credential.set_value", id: "m3", credential: "e", value: "a\nb" })).toMatchObject({ type: "response.error" });
    expect(await h({ type: "credential.set_value", id: "m4", credential: "nope", value: "x" })).toMatchObject({ type: "response.error" });
    const o = await h({ type: "credential.set_value", id: "m5", credential: "o", value: "x" });
    if (o.type === "response.error") expect(o.error).toContain("codeoid mcp signin slack --credential o");
  });
});

describe("live edits after the W2 audit", () => {
  it("a hand edit to the other block since boot is applied too, never shadowed", async () => {
    const path = join(tmp, "config", "codeoid", "config.json");
    writeFileSync(path, JSON.stringify({ ...configJson(), credentials: [{ id: "hand", kind: "env" }] }));
    await h({ type: "workstream.upsert", id: "a1", item: { id: "acme", env: { GH_TOKEN: { secret: "hand" } } } });
    expect(await h({ type: "credential.list", id: "a2" })).toMatchObject({ credentials: [{ id: "hand", usedBy: ["acme"] }] });
    expect(await h({ type: "credential.set_value", id: "a3", credential: "hand", value: "v" })).toMatchObject({ type: "credential.list.result" });
  });

  it("deleting an undeclared or malformed credential is refused, touching nothing", async () => {
    writeFileSync(join(tmp, "config", "codeoid", ".env"), "CODEOID_CRED_GHOST=keep\n");
    expect(await h({ type: "credential.delete", id: "d1", credential: "ghost" })).toMatchObject({ type: "response.error" });
    expect(readFileSync(join(tmp, "config", "codeoid", ".env"), "utf8")).toContain("CODEOID_CRED_GHOST=keep");
  });

  it("a write-only token gets its edit's reply", async () => {
    const r = await h({ type: "workstream.upsert", id: "w1", item: { id: "acme" } }, { ...OWNER, scopes: [SCOPES.SETTINGS_WRITE] as AuthContext["scopes"] });
    expect(r).toMatchObject({ type: "workstream.list.result" });
  });

  it("a value from the daemon's real environment is refused: it would win at the next start", async () => {
    await h({ type: "credential.upsert", id: "e1", item: { id: "real", kind: "env" } });
    process.env.CODEOID_CRED_REAL = "from-env";
    const r = await h({ type: "credential.set_value", id: "e2", credential: "real", value: "x" });
    expect(r).toMatchObject({ type: "response.error" });
    if (r.type === "response.error") expect(r.error).toContain("daemon's own environment");
  });

  it("a live session's backend env follows the workstream: a cleared credential is gone at its next start", async () => {
    const seen: Array<Record<string, string>> = [];
    const registry = new ProviderRegistry("rec");
    registry.register({
      id: "rec",
      displayName: "rec",
      create: (init) => {
        seen.push(init.extraEnv as Record<string, string>);
        return new MockSessionProvider("rec", []);
      },
    });
    const m = new SessionManager(store, transcript, undefined, undefined, undefined, {
      config: loadConfig({ env: {}, quiet: true }),
      providers: registry,
      _testFolderReader: new FolderReader({ home: join(tmp, "home"), sshConfig: "" }),
    });
    const hm = (msg: Record<string, unknown>) => m.handle(msg as never, OWNER, client);
    await hm({ type: "credential.upsert", id: "l1", item: { id: "gh", kind: "env" } });
    await hm({ type: "credential.set_value", id: "l2", credential: "gh", value: "tok-1" });
    await hm({ type: "workstream.upsert", id: "l3", item: { id: "acme", match: { paths: ["~/acme"] }, env: { GH_TOKEN: { secret: "gh" } } } });
    expect((await hm({ type: "session.create", id: "l4", name: "s", workdir: join(tmp, "home", "acme") })).type).toBe("response.ok");
    const env = seen.at(-1)!;
    expect({ ...env }.GH_TOKEN).toBe("tok-1");
    await hm({ type: "credential.set_value", id: "l5", credential: "gh", value: "tok-2" });
    expect({ ...env }.GH_TOKEN).toBe("tok-2");
    await hm({ type: "credential.set_value", id: "l6", credential: "gh", value: null });
    expect({ ...env }.GH_TOKEN).toBeUndefined();
    await m.drain(2_000);
  });
});

