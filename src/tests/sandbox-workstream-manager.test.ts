/**
 * The workstream fence through a real SessionSandbox (workstreams §7.3):
 * under isolation a session's project roots are its home's and references'
 * folders (never the bare @parent), every other workstream's folder under a
 * shown root is hidden, and a reference added later reaches the next build.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CodeoidConfig } from "../config.js";
import type { ProviderEvent } from "../daemon/providers/interface.js";
import { MockSessionProvider } from "../daemon/providers/mock/session-provider.js";
import { ProviderRegistry } from "../daemon/providers/registry.js";
import { LocalSandboxHandle } from "../daemon/sandbox/local-handle.js";
import { SandboxRegistry } from "../daemon/sandbox/registry.js";
import type { SandboxProvider, SandboxSpec } from "../daemon/sandbox/types.js";
import { SessionManager } from "../daemon/session-manager.js";
import { Store } from "../daemon/store.js";
import { TranscriptStore } from "../daemon/transcript.js";
import { FolderReader } from "../daemon/workstreams/folder.js";
import { workstreamsSchema } from "../daemon/workstreams/schema.js";
import { ALL_SCOPES } from "../protocol/scopes.js";
import type { AuthContext, DaemonMessage, SessionInfo, SessionMessage } from "../protocol/types.js";

const AUTH: AuthContext = { sub: "user:fence", scopes: [...ALL_SCOPES] as AuthContext["scopes"], delegationDepth: 0, accountId: "acc", projectId: "proj" };
const CLIENT = { id: "cli", auth: AUTH, send: () => {} };
const DONE: ProviderEvent = { type: "turn_done", result: { providerId: "claude", model: "m", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, totalCostUsd: 0, durationMs: 1 } };

let specs: SandboxSpec[] = [];
void specs;
function fake(): SandboxProvider {
  const open = (spec: SandboxSpec) => {
    specs.push(spec);
    return new LocalSandboxHandle("bwrap", spec, (argv, o) => ({ argv: [...argv], env: o.env }));
  };
  return {
    id: "bwrap",
    displayName: "fake-bwrap",
    capabilities: { isolation: "os", placement: "local", workspace: "mount", stdioProcess: true, commands: true, wrapsArgv: true, network: ["on", "off"], platforms: ["linux"] },
    probe: async () => ({ available: true }),
    open: async (s) => open(s),
    openSync: open,
  };
}

let tmp: string;
let home: string;
let ws: string;
let store: Store;
let transcript: TranscriptStore;
const realHome = process.env.HOME;

beforeEach(() => {
  specs = [];
  const parent = process.env.CODEOID_TEST_SANDBOX_DIR ?? join(homedir(), ".cache");
  mkdirSync(parent, { recursive: true });
  tmp = realpathSync(mkdtempSync(join(parent, "codeoid-ws-fence-mgr-")));
  home = join(tmp, "home");
  ws = join(home, "Workspace");
  process.env.HOME = home;
  for (const d of ["mine", "pub", "hf"]) mkdirSync(join(ws, d), { recursive: true });
  mkdirSync(join(tmp, "data"));
  store = new Store(join(tmp, "data", "codeoid.db"));
  transcript = new TranscriptStore(join(tmp, "data", "transcripts"));
});

afterEach(async () => {
  try {
    await transcript.flush();
  } catch {}
  try {
    store.close();
  } catch {}
  process.env.HOME = realHome;
  rmSync(tmp, { recursive: true, force: true });
});

function newManager(): SessionManager {
  const config = {
    daemonUrl: "ws://127.0.0.1:7400",
    dbPath: join(tmp, "data", "codeoid.db"),
    transcriptDir: join(tmp, "data", "transcripts"),
    auth: { baseUrl: "http://localhost:8899" },
    zeroidUrl: "http://localhost:8899",
    workspaceIndex: { enabled: false, episodeThreshold: 5, timeThresholdMs: 60_000, debounceMs: 15_000 },
    compress: { enabled: false, excludeCommands: [], excludePatterns: [], compressPipes: false, minBytes: 1024 },
    labeling: {},
    telemetry: { osc8: "auto" },
    autoRotate: { enabled: false, warnPct: 0.6, rotatePct: 0.8, hardRotatePct: 0.9, minTurnsBeforeRotate: 3, strategy: "task-anchor" },
    session: {},
    conductor: { enabled: false, name: "conductor", provider: "claude" },
    workstreams: workstreamsSchema.parse({
      isolateGlobalServers: true,
      items: [
        { id: "mine", match: { paths: ["~/Workspace/mine"] } },
        { id: "pub", share: "open", match: { paths: ["~/Workspace/pub"] } },
        { id: "hf", share: "closed", match: { paths: ["~/Workspace/hf"] } },
      ],
    }),
  } as unknown as CodeoidConfig;
  const registry = new ProviderRegistry("claude");
  registry.register({ id: "claude", displayName: "claude", create: () => new MockSessionProvider("claude", [[DONE], [DONE], [DONE]]) });
  const sandboxRegistry = new SandboxRegistry("linux", (n) => `/usr/bin/${n}`);
  sandboxRegistry.register(fake());
  return new SessionManager(store, transcript, undefined, undefined, undefined, { config, providers: registry, sandboxRegistry, _testFolderReader: new FolderReader({ home, sshConfig: "" }) });
}

describe("the fence in the sandbox", () => {
  it("roots are the home's and references' folders, another workstream's is hidden, and a fresh session says no change", async () => {
    const m = newManager();
    const made = (await m.handle({ type: "session.create", id: "c", name: "s", workdir: join(ws, "mine") } as never, AUTH, CLIENT)) as DaemonMessage & { data?: SessionInfo };
    expect(made.data?.workstream?.id).toBe("mine");
    const session = m.findByName("s", AUTH)!;
    const infos: string[] = [];
    session.attach({ id: "w", auth: AUTH, send: (msg: { type: string; role?: string; content?: string; metadata?: Record<string, unknown> }) => void (msg.type === "session.message" && msg.role === "info" && infos.push(String((msg as unknown as SessionMessage).content))) } as never);
    await session.ensureSandbox();
    await session.ensureSandbox();
    expect(session.sandboxInfo?.projectRoots).toEqual([join(ws, "mine")]);
    expect(infos.filter((i) => i.includes("Sandbox directories applied"))).toEqual([]);

    await m.handle({ type: "session.add_reference", id: "r", sessionId: session.id, workstream: "pub" } as never, AUTH, CLIENT);
    await session.ensureSandbox();
    expect(session.sandboxInfo?.projectRoots?.sort()).toEqual([join(ws, "mine"), join(ws, "pub")].sort());
    expect(infos.filter((i) => i.includes("Sandbox directories applied")).length).toBe(1);
    await m.drain(2_000);
  });

  it("a session's own project roots stand (the fence then only hides: sandbox-workstream-fence.test.ts)", async () => {
    const m = newManager();
    await m.handle({ type: "session.create", id: "c", name: "t", workdir: join(ws, "mine"), sandbox: { projectRoots: [ws] } } as never, AUTH, CLIENT);
    const session = m.findByName("t", AUTH)!;
    await session.ensureSandbox();
    expect(session.sandboxInfo?.projectRoots).toEqual([ws]);
    await m.drain(2_000);
  });
});
