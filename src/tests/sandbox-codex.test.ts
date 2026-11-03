/**
 * Codex in the OS sandbox (#448), against the fake codex app-server:
 *
 *   - codex's own sandbox policy per session: workspace-write (workspace and
 *     the session's temp dir writable, the network per the session) when
 *     codeoid's sandbox is native; full access inside codeoid's when the
 *     whole process is inside it; the old default without one;
 *   - the app-server starts inside codeoid's sandbox, its home reachable,
 *     the network on for it;
 *   - with real bubblewrap (skipped where it can't run): the app-server
 *     can't read a planted credential, and can read its own home.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { CodexProvider, codexOwnState, codexSandboxPolicy } from "../daemon/providers/codex/index.js";
import type { ProviderEvent, TurnOpts } from "../daemon/providers/interface.js";
import { BwrapSandboxProvider } from "../daemon/sandbox/bwrap.js";
import { programLocations } from "../daemon/sandbox/policy.js";
import { SandboxRegistry } from "../daemon/sandbox/registry.js";
import { type SandboxRuntime, SessionSandbox } from "../daemon/sandbox/session-sandbox.js";
import type { SandboxHandle, SandboxSpec } from "../daemon/sandbox/types.js";
import type { Store } from "../daemon/store.js";

const FIXTURE = join(import.meta.dir, "fixtures", "fake-codex.ts");

function turnOpts(userMessage: string, workdir: string, over: Partial<TurnOpts> = {}): TurnOpts {
  return { history: [], userMessage, workdir, canUseTool: async () => ({ behavior: "allow" as const }), ...over };
}

async function textOf(provider: CodexProvider, opts: TurnOpts): Promise<string> {
  const events: ProviderEvent[] = [];
  for await (const e of provider.runTurn(opts).events) events.push(e);
  const done = events.filter((e) => e.type === "text_done") as Array<{ content: string }>;
  const err = events.find((e) => e.type === "error") as { message: string } | undefined;
  return done.map((e) => e.content).join("") || `ERROR:${err?.message ?? "none"}`;
}

function fakeRuntime(kind: "native" | "process", network: "on" | "off", tempDir: string) {
  const opened: Array<{ state: readonly string[]; opts: unknown }> = [];
  const wrapped: string[][] = [];
  const rt = {
    info: { choice: "auto", state: "on", network, enforced: true },
    plan: { kind, via: "", network: ["on", "off"], fileTools: true, wrapsBackend: true, limits: [] },
    provider: { id: "bwrap" },
    config: {},
    spec: { network: { mode: network }, tempDir } as unknown as SandboxSpec,
    open: async (state: readonly string[] = [], opts?: unknown) => {
      opened.push({ state, opts });
      return {
        wrap: (argv: readonly string[], o: { env: Record<string, string> }) => {
          wrapped.push([...argv]);
          return { argv: [...argv], env: o.env };
        },
      } as unknown as SandboxHandle;
    },
    openSync: () => {
      throw new Error("unused");
    },
  } as unknown as SandboxRuntime;
  return { rt, opened, wrapped };
}

describe("codex's own sandbox, per session", () => {
  test("native: workspace-write, workspace and temp dir writable, network per session", () => {
    const { rt } = fakeRuntime("native", "off", "/tmp/codeoid-sandbox-s");
    expect(codexSandboxPolicy(rt, "danger-full-access", "/w")).toEqual({
      type: "workspaceWrite",
      writableRoots: ["/w", "/tmp/codeoid-sandbox-s"],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    });
    expect(codexSandboxPolicy(fakeRuntime("native", "on", "/t").rt, "danger-full-access", "/w")).toMatchObject({ networkAccess: true });
  });

  test("the whole process inside codeoid's: full access inside it; no sandbox: the old default", () => {
    expect(codexSandboxPolicy(fakeRuntime("process", "on", "/t").rt, "danger-full-access", "/w")).toEqual({ type: "dangerFullAccess" });
    expect(codexSandboxPolicy(null, "danger-full-access", "/w")).toEqual({ type: "dangerFullAccess" });
    expect(codexSandboxPolicy(null, "workspace-write", "/w")).toMatchObject({ type: "workspaceWrite", networkAccess: false });
  });

  test("codex's own home stays reachable: CODEX_HOME and the default one an account's links lead to", () => {
    expect(codexOwnState({ HOME: "/h" }, { HOME: "/h" })).toEqual(["/h/.codex"]);
    expect(codexOwnState({ HOME: "/h", CODEX_HOME: "/cfg/accounts/codex/work" }, { HOME: "/h" })).toEqual(["/cfg/accounts/codex/work", "/h/.codex"]);
  });

  test("end to end: turn/start carries the policy, and the app-server is started through the sandbox, network on for it", async () => {
    const ws = mkdtempSync(join(tmpdir(), "codeoid-sbx-codex-"));
    const { rt, opened, wrapped } = fakeRuntime("native", "off", "/tmp/codeoid-sandbox-x");
    const p = new CodexProvider({ sessionId: "s", initialBackingId: "s", command: process.execPath, argsPrefix: [FIXTURE], store: {} as Store, sandbox: () => rt });
    try {
      const policy = JSON.parse(await textOf(p, turnOpts("echo-policy", ws, { mode: "autonomous" }))) as { turn: { sandboxPolicy: Record<string, unknown>; approvalPolicy: string } };
      expect(policy.turn.approvalPolicy).toBe("never");
      expect(policy.turn.sandboxPolicy).toMatchObject({ type: "workspaceWrite", writableRoots: [ws, "/tmp/codeoid-sandbox-x"], networkAccess: false });
      expect(opened).toHaveLength(1);
      expect(opened[0]?.opts).toMatchObject({ backendNetwork: true, readable: programLocations(process.execPath, [FIXTURE]) });
      expect(wrapped[0]?.slice(0, 3)).toEqual([process.execPath, FIXTURE, "app-server"]);
    } finally {
      await p.teardown();
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

const bwrap = new BwrapSandboxProvider();
const real = await bwrap.probe();

describe.skipIf(!real.available)("codex's app-server inside real bubblewrap", () => {
  let root: string;
  beforeAll(() => {
    // Outside the host's /tmp: the sandbox's /tmp is its own.
    const parent = [process.env.CODEOID_TEST_SANDBOX_DIR, "/var/tmp", join(homedir(), ".cache")].find((d) => {
      if (!d) return false;
      try {
        mkdirSync(d, { recursive: true });
        rmSync(mkdtempSync(join(d, "codeoid-probe-")), { recursive: true });
        return true;
      } catch {
        return false;
      }
    });
    root = realpathSync(mkdtempSync(join(parent ?? tmpdir(), "codeoid-sbx-codex-real-")));
    for (const d of ["ws", "secrets", "codex-home"]) mkdirSync(join(root, d), { recursive: true });
    writeFileSync(join(root, "secrets", "token"), "PLANTED\n");
    writeFileSync(join(root, "codex-home", "auth.json"), "OWN-LOGIN\n");
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test("a planted credential is unreadable to the app-server; its own home isn't", async () => {
    const registry = new SandboxRegistry("linux");
    registry.register(bwrap);
    const config = { sandbox: { provider: "bwrap", network: "on", allowedHosts: [], hiddenPaths: [join(root, "secrets")], docker: { image: "x" } } } as never;
    const sbx = new SessionSandbox({ sessionId: "codex-real", workdir: join(root, "ws"), registry, config });
    await sbx.refresh("codex");
    expect(sbx.info).toMatchObject({ state: "on", confinement: "native" });
    const p = new CodexProvider({
      sessionId: "s",
      initialBackingId: "s",
      command: process.execPath,
      argsPrefix: [FIXTURE],
      store: {} as Store,
      sandbox: () => sbx.runtime,
      extraEnv: {},
    });
    const prev = process.env.CODEX_HOME;
    process.env.CODEX_HOME = join(root, "codex-home");
    try {
      expect(await textOf(p, turnOpts(`read-file:${join(root, "secrets", "token")}`, join(root, "ws")))).toStartWith("UNREADABLE:");
      expect(await textOf(p, turnOpts(`read-file:${join(root, "codex-home", "auth.json")}`, join(root, "ws")))).toBe("CONTENT:OWN-LOGIN");
    } finally {
      if (prev === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = prev;
      await p.teardown();
      await sbx.close();
    }
  }, 60_000);
});
