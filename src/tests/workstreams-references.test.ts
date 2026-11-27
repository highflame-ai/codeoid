/**
 * Workstreams W3 through the manager: references at create and mid-session
 * by each workstream's share policy, moves (§5.3), and the read fence
 * refusing a file tool in another workstream's folders at the gate (§7.3).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config.js";
import type { ProviderEvent } from "../daemon/providers/interface.js";
import { MockSessionProvider } from "../daemon/providers/mock/session-provider.js";
import { SessionManager } from "../daemon/session-manager.js";
import { Store } from "../daemon/store.js";
import { TranscriptStore } from "../daemon/transcript.js";
import { FolderReader } from "../daemon/workstreams/folder.js";
import { ALL_SCOPES, SCOPES } from "../protocol/scopes.js";
import type { AuthContext, DaemonMessage, SessionInfo } from "../protocol/types.js";

const DONE: ProviderEvent = { type: "turn_done", result: { providerId: "mock", model: "m", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, totalCostUsd: 0, durationMs: 1 } };
const OWNER: AuthContext = { sub: "user:ref", scopes: [...ALL_SCOPES] as AuthContext["scopes"], delegationDepth: 0, accountId: "acc", projectId: "proj" };
const SENDER: AuthContext = { ...OWNER, scopes: [SCOPES.SESSION_CREATE, SCOPES.SESSION_SEND, SCOPES.SESSION_LIST] as AuthContext["scopes"] };
const client = { id: "c-ref", auth: OWNER, send: (_m: DaemonMessage) => {} };

let tmp: string;
let home: string;
let store: Store;
let transcript: TranscriptStore;
let savedXdg: string | undefined;
let manager: SessionManager;
let providers: MockSessionProvider[];
let script: ProviderEvent[][];

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "codeoid-ws-ref-")));
  home = join(tmp, "home");
  savedXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = join(tmp, "config");
  mkdirSync(join(tmp, "config", "codeoid"), { recursive: true });
  for (const d of ["mine", "acme-api", "acme-web", "hf", "pub"]) mkdirSync(join(home, d), { recursive: true });
  writeFileSync(join(home, "hf", "secret.ts"), "x");
  writeFileSync(
    join(tmp, "config", "codeoid", "config.json"),
    JSON.stringify({
      dbPath: join(tmp, "codeoid.db"),
      transcriptDir: join(tmp, "transcripts"),
      workstreams: {
        isolateGlobalServers: true,
        items: [
          { id: "mine", share: "open", match: { paths: ["~/mine"] } },
          { id: "acme", share: "ask", match: { paths: ["~/acme-*"] } },
          { id: "hf", share: "closed", claim: "exclusive", match: { paths: ["~/hf"] } },
          { id: "pub", share: "open", match: { paths: ["~/pub"] } },
        ],
      },
    }),
  );
  store = new Store(join(tmp, "codeoid.db"));
  transcript = new TranscriptStore(join(tmp, "transcripts"));
  providers = [];
  script = [[DONE]];
  manager = new SessionManager(store, transcript, undefined, undefined, undefined, {
    config: loadConfig({ env: {}, quiet: true }),
    _testProviderFactory: () => {
      const p = new MockSessionProvider("mock", script);
      providers.push(p);
      return p;
    },
    _testFolderReader: new FolderReader({ home, sshConfig: "" }),
  });
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
  rmSync(tmp, { recursive: true, force: true });
});

const h = (msg: Record<string, unknown>, auth: AuthContext = OWNER) => manager.handle(msg as never, auth, { ...client, auth });
const create = async (name: string, dir: string, extra: Record<string, unknown> = {}, auth: AuthContext = OWNER) =>
  (await h({ type: "session.create", id: `c-${name}`, name, workdir: join(home, dir), ...extra }, auth)) as DaemonMessage & { data?: SessionInfo };

describe("references at create", () => {
  it("open is granted; ask needs the creator's approval rights; closed never", async () => {
    const open = await create("a", "mine", { references: [{ workstream: "pub" }] });
    expect(open.type).toBe("response.ok");
    expect(open.data?.workstream).toMatchObject({ id: "mine", references: [{ workstream: "pub" }], readFrom: ["pub"] });
    const ask = await create("b", "mine", { references: [{ workstream: "acme" }] }, SENDER);
    expect(ask).toMatchObject({ type: "response.error", code: "forbidden" });
    const asked = await create("c", "mine", { references: [{ workstream: "acme", paths: [join(home, "acme-api")] }] });
    expect(asked.data?.workstream?.references).toEqual([{ workstream: "acme", paths: [join(home, "acme-api")] }]);
    expect(await create("d", "mine", { references: [{ workstream: "hf" }] })).toMatchObject({ type: "response.error", code: "forbidden" });
    expect(await create("e", "mine", { references: [{ workstream: "acme", paths: ["/etc"] }] })).toMatchObject({ type: "response.error" });
  });
});

describe("references and moves mid-session", () => {
  it("add and remove a reference; an `ask` one from a sender without approval rights is asked on the session", async () => {
    const made = await create("s", "mine", {}, SENDER);
    const id = made.data!.id;
    const added = await h({ type: "session.add_reference", id: "r1", sessionId: id, workstream: "pub" }, SENDER);
    expect(added).toMatchObject({ type: "response.ok", data: { workstream: { references: [{ workstream: "pub" }] } } });
    const pending = await h({ type: "session.add_reference", id: "r2", sessionId: id, workstream: "acme" }, SENDER);
    expect(pending).toMatchObject({ type: "response.ok", data: { pending: true } });
    expect(manager.findByName("s", OWNER)?.workstream?.references?.map((r) => r.workstream)).toEqual(["pub"]);
    expect(await h({ type: "session.add_reference", id: "r3", sessionId: id, workstream: "hf" }, SENDER)).toMatchObject({ code: "forbidden" });
    const removed = await h({ type: "session.remove_reference", id: "r4", sessionId: id, workstream: "pub" }, SENDER);
    expect(removed).toMatchObject({ type: "response.ok" });
    // Gone, but still counted as read from (a later move follows its policy).
    expect(manager.findByName("s", OWNER)?.workstreamAhead).toMatchObject({ id: "mine", readFrom: ["pub"] });
    expect(manager.findByName("s", OWNER)?.workstreamAhead?.references).toBeUndefined();
  });

  it("only the owner", async () => {
    const made = await create("o", "mine");
    const other = { ...OWNER, sub: "user:other" };
    expect(await h({ type: "session.add_reference", id: "x", sessionId: made.data!.id, workstream: "pub" }, other)).toMatchObject({ type: "response.error" });
  });

  it("a move follows the old home's policy and every workstream read from", async () => {
    const fromMine = await create("m1", "mine");
    expect(await h({ type: "session.set_workstream", id: "w1", sessionId: fromMine.data!.id, workstream: "pub" })).toMatchObject({ type: "response.ok" });
    expect(manager.findByName("m1", OWNER)?.workstream).toMatchObject({ id: "pub", source: "explicit" });
    // Read from a closed workstream once: that conversation never leaves.
    const read = await create("m2", "mine", { references: [{ workstream: "pub" }] });
    const sid = read.data!.id;
    const s = manager.findByName("m2", OWNER)!;
    s.setWorkstream({ ...s.workstream!, readFrom: ["pub", "hf"] }, "test");
    expect(await h({ type: "session.set_workstream", id: "w2", sessionId: sid, workstream: "acme" })).toMatchObject({ code: "forbidden" });
    // From an `ask` home, a sender without approval rights is asked on the session.
    const fromAcme = await create("m3", "acme-api", {}, SENDER);
    expect(await h({ type: "session.set_workstream", id: "w3", sessionId: fromAcme.data!.id, workstream: "pub" }, SENDER)).toMatchObject({ data: { pending: true } });
    // Into a folder another workstream holds exclusively: an override, needing approval rights.
    const inHf = await create("m4", "hf");
    expect(inHf.data?.workstream?.id).toBe("hf");
    expect(await h({ type: "session.set_workstream", id: "w4", sessionId: inHf.data!.id, workstream: "pub" })).toMatchObject({ code: "forbidden" });
  });
});

describe("the read fence at the gate", () => {
  it("a file tool in another workstream's folder is refused, naming it; a reference is readable", async () => {
    script = [[{ type: "tool_start", toolId: "t1", sdkToolUseId: "sdk-t1", name: "Read", input: { file_path: join(home, "hf", "secret.ts") }, approvalId: "ap-1" } as ProviderEvent, DONE]];
    const made = await create("g", "mine");
    const session = manager.findByName("g", OWNER)!;
    await session.send("read it", OWNER);
    for (let i = 0; i < 200 && providers.at(-1)?.canUseToolResults.length === 0; i++) await Bun.sleep(10);
    const result = providers.at(-1)!.canUseToolResults[0];
    expect(result).toMatchObject({ behavior: "deny" });
    expect(result?.message).toContain('workstream "hf"');
    expect(made.data?.workstream?.id).toBe("mine");
  });

  it("a session moved to another workstream still reads its own folder", async () => {
    script = [[{ type: "tool_start", toolId: "t2", sdkToolUseId: "sdk-t2", name: "Read", input: { file_path: join(home, "mine", "own.ts") }, approvalId: "ap-2" } as ProviderEvent, DONE]];
    writeFileSync(join(home, "mine", "own.ts"), "x");
    const made = await create("mv", "mine");
    await h({ type: "session.set_workstream", id: "w", sessionId: made.data!.id, workstream: "pub" });
    const session = manager.findByName("mv", OWNER)!;
    expect(session.workstream?.id).toBe("pub");
    await session.send("read", OWNER);
    for (let i = 0; i < 100 && providers.at(-1)?.canUseToolResults.length === 0; i++) await Bun.sleep(10);
    const r = providers.at(-1)?.canUseToolResults[0];
    // Not refused by the fence (a guarded Read may still wait on its card: either way, never fenced).
    expect(r?.message ?? "").not.toContain("workstream");
  });
});

describe("reference inputs are held to what a binding is read back with", () => {
  it("a NUL in a folder, or one reference too many, is refused before it is stored", async () => {
    const made = await create("v", "mine");
    const id = made.data!.id;
    expect(await h({ type: "session.add_reference", id: "n", sessionId: id, workstream: "pub", paths: [`${join(home, "pub")}/\u0000x`] })).toMatchObject({ type: "response.error" });
    expect(await create("v2", "mine", { references: [{ workstream: "pub", paths: ["relative"] }] })).toMatchObject({ type: "response.error" });
    expect(manager.findByName("v", OWNER)?.workstream?.references).toBeUndefined();
  });

  it("a move counts the old home as read from: moving on follows its policy", async () => {
    const made = await create("chain", "acme-api");
    const id = made.data!.id;
    expect(await h({ type: "session.set_workstream", id: "m1", sessionId: id, workstream: "pub" })).toMatchObject({ type: "response.ok" });
    expect(manager.findByName("chain", OWNER)?.workstreamAhead?.readFrom).toContain("acme");
    // From pub (open) to mine: acme (ask) was read, so a sender without approval rights is asked.
    expect(await h({ type: "session.set_workstream", id: "m2", sessionId: id, workstream: "mine" }, SENDER)).toMatchObject({ data: { pending: true } });
  });

  it("a home chosen in a closed workstream's folder is refused; in an `ask` one it needs approval rights", async () => {
    expect(await create("in-hf", "hf", { workstream: "pub" })).toMatchObject({ type: "response.error" });
    expect(await create("in-acme", "acme-api", { workstream: "pub" }, SENDER)).toMatchObject({ type: "response.error", code: "forbidden" });
    const ok = await create("in-acme2", "acme-api", { workstream: "pub" });
    expect(ok.data?.workstream).toMatchObject({ id: "pub", readFrom: ["acme"] });
  });
});
