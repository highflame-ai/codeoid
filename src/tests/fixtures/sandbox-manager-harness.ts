/**
 * A real SessionManager with a scriptable mock Claude backend and a fake
 * bubblewrap provider, over a scratch home with `projects/{work,sibling}`
 * (each a repository with a commit; the sibling has a `.env`): what the
 * #448 round-13 manager tests share. Call {@link sandboxManagerHarness} at a
 * test file's top level; it registers its own beforeEach/afterEach.
 */

import { afterEach, beforeEach, expect } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CodeoidConfig } from "../../config.js";
import type { ProviderEvent } from "../../daemon/providers/interface.js";
import { MockSessionProvider } from "../../daemon/providers/mock/session-provider.js";
import { ProviderRegistry } from "../../daemon/providers/registry.js";
import { LocalSandboxHandle } from "../../daemon/sandbox/local-handle.js";
import { SandboxRegistry } from "../../daemon/sandbox/registry.js";
import type { SandboxProvider, SandboxSpec } from "../../daemon/sandbox/types.js";
import type { Session } from "../../daemon/session.js";
import { SessionManager } from "../../daemon/session-manager.js";
import { Store } from "../../daemon/store.js";
import { TranscriptStore } from "../../daemon/transcript.js";
import { ALL_SCOPES } from "../../protocol/scopes.js";
import { type AuthContext, CAPABILITIES, type DaemonMessage, type SessionInfo } from "../../protocol/types.js";

export const AUTH: AuthContext = { sub: "user:r13", scopes: [...ALL_SCOPES] as AuthContext["scopes"], delegationDepth: 0, accountId: "acc", projectId: "proj" };
export const CLIENT = { id: "cli", auth: AUTH, send: () => {} };
export const DONE: ProviderEvent = { type: "turn_done", result: { providerId: "claude", model: "m", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, totalCostUsd: 0, durationMs: 1 } };
/** A Bash call (the gate is asked about it), with ids of its own. */
export const BASH_CALL = (id: string): ProviderEvent => ({ type: "tool_start", toolId: `t-${id}`, sdkToolUseId: `sdk-${id}`, name: "Bash", input: { command: "ls" }, approvalId: `ap-${id}` });
/** A turn: a Bash call, then done. */
export const BASH = (n: number): ProviderEvent[] => [BASH_CALL(String(n)), DONE];

export const infoOf = (r: DaemonMessage) => (r as { data?: SessionInfo }).data;

export async function until(pred: () => boolean): Promise<void> {
  for (let i = 0; i < 300 && !pred(); i++) await Bun.sleep(10);
}

const GIT_ENV = (home: string) => ({ PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e.invalid" });
export function git(args: string[], cwd: string): void {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: GIT_ENV(cwd) });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
}

export interface SandboxManagerHarness {
  /** The scratch dir (projects/, home/, data/ in it). */
  readonly tmp: string;
  /** `projects`: the default project root. */
  readonly root: string;
  /** `projects/work`: where sessions are created. */
  readonly workdir: string;
  /** `projects/sibling`: another repository under the root, with a `.env`. */
  readonly sibling: string;
  readonly transcript: TranscriptStore;
  /** Every audit entry so far. */
  readonly audits: Array<{ action: string; detail: string }>;
  /** The turns the next backend made runs (else a Bash call per turn). */
  script: ProviderEvent[][] | null;
  newManager(): SessionManager;
  create(m: SessionManager, extra?: Record<string, unknown>): Promise<DaemonMessage>;
  /** A session in autonomous mode, its sandbox resolved. */
  autonomous(m: SessionManager, extra?: Record<string, unknown>): Promise<{ info: SessionInfo | undefined; session: Session }>;
  /** Every confirm raised on the session, as a client with dialogs sees it. */
  dialogs(m: SessionManager, name: string): Array<{ requestId: string; title: string; message: string }>;
  /** Every info line said on the session from now on. */
  infoLines(m: SessionManager, name: string): string[];
  /** Every gate decision the backends made so far saw (a directory change restarts the backend: a new one). */
  decisions(): Array<{ behavior: string; message?: string }>;
  /** The spec the last backend made would run its commands under now (throws when it can't be built). */
  runtimeSpec(): SandboxSpec | null;
  /** Send once the backend's restart for a sandbox change is done (a send right after it is refused until then). */
  sendWhenReady(session: Session, text: string): Promise<void>;
}

/** Register the harness's setup and teardown, and hand back what the tests use. */
export function sandboxManagerHarness(): SandboxManagerHarness {
  let tmp = "";
  let store: Store | null = null;
  let transcript: TranscriptStore | null = null;
  let audits: Array<{ action: string; detail: string }> = [];
  let providers: MockSessionProvider[] = [];
  let runtimes: Array<() => SandboxSpec | null> = [];
  const realHome = process.env.HOME;

  const config = (): CodeoidConfig =>
    ({
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
    }) as CodeoidConfig;

  const fake = (): SandboxProvider => {
    const open = (spec: SandboxSpec) => new LocalSandboxHandle("bwrap", spec, (argv, o) => ({ argv: [...argv], env: o.env }));
    return {
      id: "bwrap",
      displayName: "fake-bwrap",
      capabilities: { isolation: "os", placement: "local", workspace: "mount", stdioProcess: true, commands: true, wrapsArgv: true, network: ["on", "off"], platforms: ["linux"] },
      probe: async () => ({ available: true }),
      open: async (s) => open(s),
      openSync: open,
    };
  };

  const h: SandboxManagerHarness = {
    get tmp() {
      return tmp;
    },
    get root() {
      return join(tmp, "projects");
    },
    get workdir() {
      return join(tmp, "projects", "work");
    },
    get sibling() {
      return join(tmp, "projects", "sibling");
    },
    get transcript() {
      return transcript as TranscriptStore;
    },
    get audits() {
      return audits;
    },
    script: null,
    newManager() {
      const registry = new ProviderRegistry("claude");
      registry.register({
        id: "claude",
        displayName: "claude",
        create: (init) => {
          // Ids of their own per backend: one made after a restart isn't taken for a call already seen.
          const n = providers.length * 10;
          const p = new MockSessionProvider("claude", h.script ?? [BASH(n + 1), BASH(n + 2), BASH(n + 3), BASH(n + 4)]);
          h.script = null;
          providers.push(p);
          // The spec the backend's commands run under (Claude's own sandbox is given it): what the tests read.
          runtimes.push(() => init.sandbox?.()?.spec ?? null);
          return p;
        },
      });
      const sandboxRegistry = new SandboxRegistry("linux", (n) => `/usr/bin/${n}`);
      sandboxRegistry.register(fake());
      return new SessionManager(store as Store, transcript as TranscriptStore, undefined, undefined, undefined, { config: config(), providers: registry, sandboxRegistry });
    },
    create(m, extra = {}) {
      return m.handle({ type: "session.create", id: "c", name: `s-${Math.random().toString(36).slice(2, 8)}`, workdir: h.workdir, ...extra } as never, AUTH, CLIENT);
    },
    async autonomous(m, extra = {}) {
      const info = infoOf(await h.create(m, extra));
      expect(await m.handle({ type: "session.set_mode", id: "m", sessionId: info?.id as string, mode: "autonomous" }, AUTH, CLIENT)).toMatchObject({ type: "response.ok" });
      const session = m.findByName(info?.name as string, AUTH);
      if (!session) throw new Error("no session");
      await session.ensureSandbox();
      return { info, session };
    },
    dialogs(m, name) {
      const asked: Array<{ requestId: string; title: string; message: string }> = [];
      m.findByName(name, AUTH)?.attach({
        id: `dialogs-${Math.random()}`,
        auth: AUTH,
        capabilities: [CAPABILITIES.UI_DIALOGS],
        send: (msg: { type: string; requestId?: string; title?: string; message?: string }) => {
          if (msg.type === "session.ui_request") asked.push({ requestId: msg.requestId ?? "", title: msg.title ?? "", message: msg.message ?? "" });
        },
      } as never);
      return asked;
    },
    infoLines(m, name) {
      const lines: string[] = [];
      m.findByName(name, AUTH)?.attach({ id: `info-${Math.random()}`, auth: AUTH, send: (msg: { type: string; role?: string; content?: string }) => void (msg.type === "session.message" && msg.role === "info" && lines.push(String(msg.content))) } as never);
      return lines;
    },
    decisions() {
      return providers.flatMap((p) => p.canUseToolResults as Array<{ behavior: string; message?: string }>);
    },
    runtimeSpec() {
      return runtimes.at(-1)?.() ?? null;
    },
    async sendWhenReady(session, text) {
      for (let i = 0; ; i++) {
        try {
          await session.send(text, AUTH);
          return;
        } catch (err) {
          if (i > 100 || !String(err).includes("previous sandbox")) throw err;
          await Bun.sleep(20);
        }
      }
    },
  };

  beforeEach(() => {
    providers = [];
    runtimes = [];
    h.script = null;
    const parent = process.env.CODEOID_TEST_SANDBOX_DIR ?? join(homedir(), ".cache");
    mkdirSync(parent, { recursive: true });
    tmp = realpathSync(mkdtempSync(join(parent, "codeoid-sbx-r13-")));
    process.env.HOME = join(tmp, "home");
    mkdirSync(process.env.HOME);
    for (const d of [h.workdir, h.sibling]) {
      mkdirSync(d, { recursive: true });
      git(["init", "-q", "-b", "main"], d);
      writeFileSync(join(d, "README.md"), "x\n");
      git(["add", "."], d);
      git(["commit", "-qm", "i"], d);
    }
    // The sibling's credentials: hidden in the root.
    writeFileSync(join(h.sibling, ".env"), "SIBLING_SECRET=1\n");
    mkdirSync(join(tmp, "data"));
    store = new Store(join(tmp, "data", "codeoid.db"));
    transcript = new TranscriptStore(join(tmp, "data", "transcripts"));
    audits = [];
    const s = store;
    const audit = s.audit.bind(s);
    s.audit = (subject, action, sessionId, detail) => {
      audits.push({ action, detail: detail ?? "" });
      audit(subject, action, sessionId, detail);
    };
  });

  afterEach(async () => {
    try {
      await transcript?.flush();
    } catch {}
    try {
      store?.close();
    } catch {}
    process.env.HOME = realHome;
    rmSync(tmp, { recursive: true, force: true });
  });

  return h;
}
