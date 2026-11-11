/**
 * Workstreams through SessionManager.handle (docs/workstreams-design.md, W0):
 * a session's home is decided at create, carried on SessionInfo and in its
 * meta, refused past an exclusive claim, and — for a session from before
 * workstreams — decided once on resume and kept.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CodeoidConfig, loadConfig } from "../config.js";
import { MockSessionProvider } from "../daemon/providers/mock/session-provider.js";
import { SessionManager } from "../daemon/session-manager.js";
import { Store } from "../daemon/store.js";
import { TranscriptStore } from "../daemon/transcript.js";
import { FolderReader } from "../daemon/workstreams/folder.js";
import { EnvFileSecretStore } from "../daemon/credentials/store.js";
import { ProviderRegistry } from "../daemon/providers/registry.js";
import { McpRegistry } from "../daemon/mcp/registry.js";
import { McpHub } from "../daemon/mcp/hub.js";
import { McpOAuth } from "../daemon/mcp/oauth.js";
import { ALL_SCOPES, SCOPES } from "../protocol/scopes.js";
import type { AuthContext, DaemonMessage, SessionInfo } from "../protocol/types.js";

const OWNER: AuthContext = {
  sub: "user:ws-owner",
  scopes: [...ALL_SCOPES] as AuthContext["scopes"],
  delegationDepth: 0,
  accountId: "acc-ws",
  projectId: "proj-ws",
};
const client = { id: "c-ws", auth: OWNER, send: () => {} };

let tmp: string;
let store: Store;
let transcript: TranscriptStore;
const managers: SessionManager[] = [];

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "codeoid-ws-mgr-")));
  store = new Store(join(tmp, "codeoid.db"));
  transcript = new TranscriptStore(join(tmp, "transcripts"));
  for (const d of ["client", "mine", "loose"]) mkdirSync(join(tmp, "home", d), { recursive: true });
});

afterEach(async () => {
  for (const m of managers.splice(0)) {
    try {
      await m.drain(2_000);
    } catch {}
  }
  try {
    await transcript.flush();
  } catch {}
  try {
    store.close();
  } catch {}
  rmSync(tmp, { recursive: true, force: true });
});

function manager(workstreams?: unknown, credentials: unknown[] = []): SessionManager {
  // A whole config, through the loader the daemon uses: the zod parse (and its
  // cross-item rules) runs exactly as at boot.
  const config: CodeoidConfig | undefined =
    workstreams === undefined
      ? undefined
      : loadConfig({ raw: { dbPath: join(tmp, "codeoid.db"), transcriptDir: join(tmp, "transcripts"), workstreams, credentials }, env: {}, quiet: true });
  const m = new SessionManager(store, transcript, undefined, undefined, undefined, {
    ...(config ? { config } : {}),
    _testProviderFactory: () => new MockSessionProvider(),
    _testFolderReader: new FolderReader({ home: join(tmp, "home"), sshConfig: "" }),
  });
  managers.push(m);
  return m;
}

const WS = {
  items: [
    { id: "client", name: "Client Co", color: "orange", claim: "exclusive", match: { paths: ["~/client/**"] } },
    { id: "mine", match: { paths: ["~/mine"] } },
  ],
};

async function create(m: SessionManager, name: string, dir: string, extra: Record<string, unknown> = {}): Promise<DaemonMessage> {
  return m.handle({ type: "session.create", id: `c-${name}`, name, workdir: join(tmp, "home", dir), ...extra } as never, OWNER, client);
}

async function metaOf(id: string): Promise<Record<string, unknown>> {
  await transcript.flush();
  return JSON.parse(readFileSync(join(tmp, "transcripts", `${id}.meta.json`), "utf8"));
}

describe("session.create picks the home", () => {
  it("by folder, onto SessionInfo and into the meta", async () => {
    const resp = await create(manager(WS), "a", "client");
    expect(resp.type).toBe("response.ok");
    const info = (resp as { data: SessionInfo }).data;
    expect(info.workstream).toEqual({ id: "client", name: "Client Co", color: "orange", source: "matched", matchedBy: "~/client/**" });
    expect((await metaOf(info.id)).workstream).toMatchObject({ id: "client", source: "matched" });
  });

  it("refuses an explicit choice past an exclusive claim, saying why", async () => {
    const resp = await create(manager(WS), "b", "client", { workstream: "mine" });
    expect(resp).toMatchObject({ type: "response.error", code: "invalid_request", detail: { kind: "workstream_conflict" } });
    if (resp.type === "response.error" && resp.detail?.kind === "workstream_conflict") {
      expect(resp.detail.resolution.conflict).toMatchObject({ folder: "client", chosen: "mine", overridable: true });
    }
  });

  it("refuses an unknown workstream", async () => {
    const resp = await create(manager(WS), "c", "mine", { workstream: "nope" });
    expect(resp).toMatchObject({ type: "response.error", detail: { kind: "workstream_unknown", workstream: "nope" } });
  });

  it("takes an explicit choice in a folder nothing claims", async () => {
    const resp = await create(manager(WS), "d", "loose", { workstream: "mine" });
    expect((resp as { data: SessionInfo }).data.workstream).toMatchObject({ id: "mine", source: "explicit" });
  });

  it("an unmatched folder with no default has no home — and says so", async () => {
    const resp = await create(manager(WS), "e", "loose");
    expect((resp as { data: SessionInfo }).data.workstream).toEqual({ source: "none" });
  });

  it("with no workstreams configured, nothing changes: no field, no refusal", async () => {
    const resp = await create(manager(), "f", "client");
    expect(resp.type).toBe("response.ok");
    expect((resp as { data: SessionInfo }).data.workstream).toBeUndefined();
    expect((await metaOf((resp as { data: SessionInfo }).data.id)).workstream).toBeUndefined();
  });
});

describe("who may choose (W0 audit)", () => {
  const DELEGATED: AuthContext = { ...OWNER, delegationDepth: 1 };

  it("a delegated token may confirm the folder's own home, never pick another", async () => {
    const m = manager(WS);
    const own = await m.handle({ type: "session.create", id: "d1", name: "own", workdir: join(tmp, "home", "mine"), workstream: "mine" } as never, DELEGATED, client);
    expect(own.type).toBe("response.ok");
    const other = await m.handle({ type: "session.create", id: "d2", name: "other", workdir: join(tmp, "home", "loose"), workstream: "client" } as never, DELEGATED, client);
    expect(other).toMatchObject({ type: "response.error", code: "forbidden" });
  });

  it("every create with a home is audited with how it was decided", async () => {
    const resp = await create(manager(WS), "aud", "client");
    const id = (resp as { data: SessionInfo }).data.id;
    const rows = store.database.prepare("SELECT action, detail FROM audit_log WHERE session_id = ? AND action = 'session.create'").all(id) as Array<{ detail: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.detail).toContain("workstream=client source=matched");
  });

  it("an unknown id, even malformed, gets the specific error rather than a schema rejection", async () => {
    const resp = await create(manager(WS), "bad", "mine", { workstream: "Not An Id" });
    expect(resp).toMatchObject({ type: "response.error", detail: { kind: "workstream_unknown" } });
  });
});

describe("forks keep their parent's home (W0 audit)", () => {
  it("a fork into another workstream's exclusive folder is refused", async () => {
    const m = manager({ items: [...WS.items.map((w) => (w.id === "client" ? { ...w, allowOverride: false } : w))] });
    const parent = await create(m, "p", "mine");
    const id = (parent as { data: SessionInfo }).data.id;
    const fork = await m.handle({ type: "session.fork", id: "f1", sessionId: id, providerId: "claude", workdir: join(tmp, "home", "client") } as never, OWNER, client);
    expect(fork).toMatchObject({ type: "response.error", detail: { kind: "workstream_conflict" } });
    const ok = await m.handle({ type: "session.fork", id: "f2", sessionId: id, providerId: "claude", workdir: join(tmp, "home", "loose") } as never, OWNER, client);
    expect(ok.type).toBe("response.ok");
    expect((ok as { data: SessionInfo }).data.workstream).toMatchObject({ id: "mine" });
  });

  it("a delegated token can't fork a session into a folder of another home", async () => {
    const m = manager(WS);
    const parent = await create(m, "p2", "mine");
    const id = (parent as { data: SessionInfo }).data.id;
    const fork = await m.handle(
      { type: "session.fork", id: "f3", sessionId: id, providerId: "claude", workdir: join(tmp, "home", "loose") } as never,
      { ...OWNER, delegationDepth: 1 },
      client,
    );
    expect(fork).toMatchObject({ type: "response.error", code: "forbidden" });
  });
});

describe("workstream.list and workstream.resolve", () => {
  it("list needs settings:read and shows env names only", async () => {
    const m = manager({ items: [{ id: "a", env: { GH_TOKEN: { secret: "gh-a" } } }] }, [{ id: "gh-a", kind: "env" }]);
    const denied = await m.handle({ type: "workstream.list", id: "l1" }, { ...OWNER, scopes: [SCOPES.SESSION_CREATE] as AuthContext["scopes"] }, client);
    expect(denied).toMatchObject({ type: "response.error", code: "forbidden" });
    const ok = await m.handle({ type: "workstream.list", id: "l2" }, OWNER, client);
    expect(ok).toMatchObject({ type: "workstream.list.result", isolateGlobalServers: false, workstreams: [{ id: "a", env: ["GH_TOKEN"] }] });
  });

  it("resolve answers what a create would, and needs session:create", async () => {
    const m = manager(WS);
    const denied = await m.handle(
      { type: "workstream.resolve", id: "r1", workdir: join(tmp, "home", "client") },
      { ...OWNER, scopes: [SCOPES.SETTINGS_READ] as AuthContext["scopes"] },
      client,
    );
    expect(denied).toMatchObject({ type: "response.error", code: "forbidden" });
    const r = await m.handle({ type: "workstream.resolve", id: "r2", workdir: join(tmp, "home", "client"), workstream: "mine" }, OWNER, client);
    expect(r).toMatchObject({
      type: "workstream.resolve.result",
      resolution: { home: "mine", source: "explicit", conflict: { folder: "client", chosen: "mine" } },
    });
    const missing = await m.handle({ type: "workstream.resolve", id: "r3", workdir: join(tmp, "nowhere") }, OWNER, client);
    expect(missing).toMatchObject({ type: "response.error", code: "invalid_request" });
  });
});

describe("resume (G5)", () => {
  it("a session from before workstreams is homed once by its folder, and the home is kept", async () => {
    // Created before any workstream was configured.
    const before = await create(manager(), "old", "client");
    const id = (before as { data: SessionInfo }).data.id;
    await transcript.flush();

    const m2 = manager(WS);
    await m2.resumeSessions();
    const info = await listOne(m2, id);
    expect(info?.workstream).toMatchObject({ id: "client", source: "migrated" });
    expect((await metaOf(id)).workstream).toMatchObject({ id: "client", source: "migrated" });

    // The rules change; the session's home doesn't.
    const m3 = manager({ items: [{ id: "client", match: { paths: ["~/elsewhere"] } }, { id: "mine", match: { paths: ["~/client"] } }] });
    await m3.resumeSessions();
    expect((await listOne(m3, id))?.workstream).toMatchObject({ id: "client", source: "migrated" });
  });

  it("migrating a session's home changes only that field of its meta (W0 audit)", async () => {
    const before = await create(manager(), "keep", "client");
    const id = (before as { data: SessionInfo }).data.id;
    await transcript.flush();
    const path = join(tmp, "transcripts", `${id}.meta.json`);
    const meta = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({ ...meta, redactedBackings: ["backing-1"], providerId: "a-backend-now-gone" }));

    const m2 = manager(WS);
    await m2.resumeSessions();
    const after = await metaOf(id);
    expect(after.workstream).toMatchObject({ id: "client", source: "migrated" });
    expect(after.redactedBackings).toEqual(["backing-1"]);
    expect(after.providerId).toBe("a-backend-now-gone");
  });

  it("a tampered home fails closed: no home, never the folder's", async () => {
    const created = await create(manager(WS), "tamper", "client");
    const id = (created as { data: SessionInfo }).data.id;
    await transcript.flush();
    const path = join(tmp, "transcripts", `${id}.meta.json`);
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), workstream: { id: "client" } }));
    const m2 = manager(WS);
    await m2.resumeSessions();
    expect((await listOne(m2, id))?.workstream).toEqual({ source: "none" });
  });

  it("a home removed from the config leaves the session orphaned, not re-homed", async () => {
    const created = await create(manager(WS), "g", "mine");
    const id = (created as { data: SessionInfo }).data.id;
    await transcript.flush();
    const m2 = manager({ items: [{ id: "client", match: { paths: ["~/client/**"] } }] });
    await m2.resumeSessions();
    expect((await listOne(m2, id))?.workstream).toEqual({ id: "mine", orphaned: true, source: "matched", matchedBy: "~/mine" });
  });
});

async function listOne(m: SessionManager, id: string): Promise<SessionInfo | undefined> {
  const r = await m.handle({ type: "session.list", id: "ls" }, OWNER, client);
  return r.type === "session.list.result" ? r.sessions.find((s) => s.id === id) : undefined;
}

describe("the home's environment reaches the backend (W1, §6.2)", () => {
  it("env credentials and git identity for sessions homed there, nothing for others", async () => {
    const seen: Array<{ name: string; env: Record<string, string> }> = [];
    const registry = new ProviderRegistry("rec");
    registry.register({
      id: "rec",
      displayName: "rec",
      create: (init) => {
        seen.push({ name: init.sessionId, env: { ...(init.extraEnv ?? {}) } });
        return new MockSessionProvider("rec", []);
      },
    });
    const config = loadConfig({
      raw: {
        dbPath: join(tmp, "codeoid.db"),
        transcriptDir: join(tmp, "transcripts"),
        credentials: [{ id: "gh-client", kind: "env" }],
        workstreams: {
          items: [
            { id: "client", match: { paths: ["~/client/**"] }, env: { GH_TOKEN: { secret: "gh-client" } }, git: { name: "Client Bot", email: "bot@client.example" } },
            { id: "mine", match: { paths: ["~/mine"] } },
          ],
        },
      },
      env: {},
      quiet: true,
    });
    const m = new SessionManager(store, transcript, undefined, undefined, undefined, {
      config,
      providers: registry,
      _testFolderReader: new FolderReader({ home: join(tmp, "home"), sshConfig: "" }),
      _testSecrets: new EnvFileSecretStore({ CODEOID_CRED_GH_CLIENT: "ghp_client" }),
    });
    managers.push(m);
    const a = (await create(m, "in-client", "client")) as { data: SessionInfo };
    const b = (await create(m, "in-mine", "mine")) as { data: SessionInfo };
    const client = seen.find((x) => x.name === a.data.id)?.env;
    expect(client).toMatchObject({ GH_TOKEN: "ghp_client", GIT_AUTHOR_NAME: "Client Bot", GIT_COMMITTER_EMAIL: "bot@client.example" });
    expect(seen.find((x) => x.name === b.data.id)?.env).toBeDefined();
    expect(seen.find((x) => x.name === b.data.id)?.env.GH_TOKEN).toBeUndefined();
  });

  it("a config that sets a variable codeoid owns, or names an undeclared credential, fails to load", () => {
    const load = (workstreams: unknown, credentials: unknown[] = []) => () =>
      loadConfig({ raw: { dbPath: join(tmp, "x.db"), workstreams, credentials }, env: {}, quiet: true });
    expect(load({ items: [{ id: "a", env: { ANTHROPIC_API_KEY: { secret: "k" } } }] }, [{ id: "k", kind: "env" }])).toThrow(/codeoid owns this variable/);
    expect(load({ items: [{ id: "a", env: { GH_TOKEN: { secret: "nope" } } }] })).toThrow(/undeclared credential "nope"/);
  });
});

describe("a confirmed override (G3)", () => {
  const conflictOf = (r: DaemonMessage) => (r.type === "response.error" && r.detail?.kind === "workstream_conflict" ? r.detail.resolution.conflict : undefined);

  it("a conflict comes with a token; the confirming retry homes the session by override, once", async () => {
    const m = manager(WS);
    const first = await create(m, "o1", "client", { workstream: "mine" });
    const c = conflictOf(first);
    expect(c?.overrideToken).toBeString();
    expect(c?.changes).toEqual({ gains: [], withholds: [], env: [] });
    const ok = await create(m, "o1", "client", { workstream: "mine", override: { token: c!.overrideToken } });
    expect((ok as { data: SessionInfo }).data.workstream).toMatchObject({ id: "mine", source: "override" });
    const rows = store.database.prepare("SELECT detail FROM audit_log WHERE action = 'workstream.override'").all() as Array<{ detail: string }>;
    expect(rows[0]!.detail).toContain("folder=client chosen=mine");
    const again = await create(m, "o2", "client", { workstream: "mine", override: { token: c!.overrideToken } });
    expect(again).toMatchObject({ type: "response.error", code: "invalid_request" });
  });

  it("the token is bound: another folder or choice, a delegated token, or a missing approve scope can't use it", async () => {
    const m = manager({ items: [...WS.items, { id: "third" }] });
    const c = conflictOf(await create(m, "b1", "client", { workstream: "mine" }));
    const token = c!.overrideToken!;
    expect(await create(m, "b2", "client", { workstream: "third", override: { token } })).toMatchObject({ type: "response.error", code: "invalid_request" });
    const delegated = await m.handle(
      { type: "session.create", id: "b3", name: "b3", workdir: join(tmp, "home", "client"), workstream: "mine", override: { token } } as never,
      { ...OWNER, delegationDepth: 1 },
      client,
    );
    expect(delegated).toMatchObject({ type: "response.error", code: "forbidden" });
    const noApprove = await m.handle(
      { type: "session.create", id: "b4", name: "b4", workdir: join(tmp, "home", "client"), workstream: "mine", override: { token } } as never,
      { ...OWNER, scopes: [SCOPES.SESSION_CREATE] as AuthContext["scopes"] },
      client,
    );
    expect(noApprove).toMatchObject({ type: "response.error", code: "forbidden" });
    // Not spent by the refusals above: the right request still takes it.
    expect((await create(m, "b5", "client", { workstream: "mine", override: { token } })).type).toBe("response.ok");
  });

  it("no token at all when the folder's workstream allows no override", async () => {
    const m = manager({ items: WS.items.map((w) => (w.id === "client" ? { ...w, allowOverride: false } : w)) });
    const c = conflictOf(await create(m, "n1", "client", { workstream: "mine" }));
    expect(c?.overridable).toBe(false);
    expect(c?.overrideToken).toBeUndefined();
  });
});

describe("the folder record: a repository match that changed is refused, not a silent re-home", () => {
  it("an edited origin makes the next create choose; the choice is recorded", async () => {
    const repo = join(tmp, "home", "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    const origin = (url: string) => writeFileSync(join(repo, ".git", "config"), `[remote "origin"]\n\turl = ${url}\n`);
    origin("https://github.com/mine/app");
    const m = manager({ items: [{ id: "mine", match: { remotes: ["github.com/mine/*"] } }, { id: "corp", match: { remotes: ["github.com/corp/*"] } }] });
    expect(((await create(m, "r1", "repo")) as { data: SessionInfo }).data.workstream).toMatchObject({ id: "mine" });
    origin("https://github.com/corp/app");
    const refused = await create(m, "r2", "repo");
    expect(refused).toMatchObject({ type: "response.error", detail: { kind: "workstream_required" } });
    if (refused.type === "response.error") expect(refused.error).toContain('was workstream "mine"');
    expect(((await create(m, "r3", "repo", { workstream: "corp" })) as { data: SessionInfo }).data.workstream).toMatchObject({ id: "corp" });
    expect(((await create(m, "r4", "repo")) as { data: SessionInfo }).data.workstream).toMatchObject({ id: "corp", source: "matched" });
  });
});

describe("under isolation a user's create must have a home", () => {
  it("an unmatched folder is refused with the choices; a choice settles it", async () => {
    const m = manager({ ...WS, isolateGlobalServers: true });
    const r = await create(m, "i1", "loose");
    expect(r).toMatchObject({ type: "response.error", detail: { kind: "workstream_required" } });
    if (r.type === "response.error") expect(r.error).toContain("client, mine");
    expect((await create(m, "i2", "loose", { workstream: "mine" })).type).toBe("response.ok");
  });
});

describe("signing in to a credential slot", () => {
  it("is refused unless the slot is declared as an OAuth credential for that server", async () => {
    const m = manager(WS, [{ id: "slack-hf", kind: "oauth", server: "slack" }, { id: "plain", kind: "env" }, { id: "other-oauth", kind: "oauth", server: "notion" }]);
    const registry = new McpRegistry({ slack: { url: "https://slack.invalid/mcp", oauth: true, args: [], env: {}, headers: {}, trust: "prompt", scope: "workspace", enabled: true, native: false } as never }, { memoryEnabled: false });
    m.setMcp(registry, new McpHub({}), new McpOAuth({ store, redirectBaseUrl: () => "http://127.0.0.1:1", env: {} }));
    for (const credential of ["undeclared", "plain", "other-oauth"]) {
      const r = await m.handle({ type: "mcp.oauth.begin", id: `s-${credential}`, server: "slack", credential } as never, OWNER, client);
      expect(r).toMatchObject({ type: "response.error", code: "invalid_request" });
      if (r.type === "response.error") expect(r.error).toContain("is not an OAuth credential declared for \"slack\"");
    }
  });
});
