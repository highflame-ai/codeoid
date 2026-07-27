/**
 * Goal-blackboard MCP endpoint — the mountable surface (#245).
 *
 * The property under test is that THE TOKEN IS THE SCOPE. A mount cannot
 * address another goal or widen its own read/write set, because no tool takes
 * a goal id and `blackboard_write` takes no slot. If that ever stops being
 * true, a gemini reviewer could read the implementer's reasoning or overwrite
 * a peer's findings, and the independence guarantee in §6 evaporates.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlackboardMcpHttp, BLACKBOARD_MCP_PATH } from "../daemon/blackboard/mcp-http.js";
import { Blackboard, type RoleIdentity } from "../daemon/blackboard/service.js";
import { BlackboardStore, type GoalScope } from "../daemon/blackboard/store.js";
import { Store } from "../daemon/store.js";

let tmp: string;
let store: Store;
let bb: Blackboard;
let mcp: BlackboardMcpHttp;

const GOAL: GoalScope = { accountId: "acc", projectId: "proj", goalSessionId: "goal-1" };
const ident = (roleName: string, ordinal = 1): RoleIdentity => ({
  roleName,
  ordinal,
  authorSub: `agent:${roleName}#${ordinal}`,
});

const URL_ = `http://127.0.0.1:7400${BLACKBOARD_MCP_PATH}`;

/** POST one JSON-RPC message with a bearer token. */
async function rpc(
  token: string | null,
  method: string,
  params?: Record<string, unknown>,
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await mcp.handle(
    new Request(URL_, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
  );
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const call = (token: string, name: string, args: Record<string, unknown> = {}) =>
  rpc(token, "tools/call", { name, arguments: args });

/** The text payload of a tools/call result. */
const textOf = (body: any): string => body?.result?.content?.[0]?.text ?? "";
const isErr = (body: any): boolean => body?.result?.isError === true;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "codeoid-bbmcp-"));
  store = new Store(join(tmp, "codeoid.db"));
  bb = new Blackboard(new BlackboardStore(store.database));
  mcp = new BlackboardMcpHttp();
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("transport + auth", () => {
  // Each auth test mints an unrelated VALID token first. Without that, the map
  // is empty and a "reject unless the token resolves" test passes even against
  // an endpoint that falls back to whatever binding happens to exist — proving
  // only "401 when nothing is minted". Mutation testing caught exactly that.
  const mintOther = () => mcp.mint(bb.forRole({ ...GOAL, goalSessionId: "other" }, ident("review")));

  test("fails closed with no token, even when other mounts are live", async () => {
    mintOther();
    const r = await rpc(null, "tools/list");
    expect(r.status).toBe(401);
  });

  test("fails closed on an unknown token, even when other mounts are live", async () => {
    mintOther();
    const r = await rpc("bbt_nope", "tools/list");
    expect(r.status).toBe(401);
  });

  test("a revoked token stops working while its siblings keep working", async () => {
    const sibling = mintOther();
    const token = mcp.mint(bb.forRole(GOAL, ident("review")));
    expect((await rpc(token, "tools/list")).status).toBe(200);

    mcp.revoke(token);
    // Revoked one is dead...
    expect((await rpc(token, "tools/list")).status).toBe(401);
    // ...and the endpoint did NOT silently fall through to the live sibling.
    expect((await rpc(sibling, "tools/list")).status).toBe(200);
    expect(mcp.activeTokens).toBe(1);
  });

  test("GET is rejected — POST-only Streamable HTTP", async () => {
    const res = await mcp.handle(new Request(URL_, { method: "GET" }));
    expect(res.status).toBe(405);
  });

  test("initialize + tools/list advertise the four tools", async () => {
    const token = mcp.mint(bb.forRole(GOAL, ident("review")));
    const init = await rpc(token, "initialize", { protocolVersion: "2025-06-18" });
    expect(init.body.result.serverInfo.name).toBe("codeoid_blackboard");
    const list = await rpc(token, "tools/list");
    expect(list.body.result.tools.map((t: { name: string }) => t.name).sort()).toEqual([
      "blackboard_index",
      "blackboard_read",
      "blackboard_read_all",
      "blackboard_write",
    ]);
  });

  test("a notification (no id) gets 202 and no body", async () => {
    const token = mcp.mint(bb.forRole(GOAL, ident("review")));
    const res = await mcp.handle(
      new Request(URL_, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      }),
    );
    expect(res.status).toBe(202);
  });
});

describe("the token carries the role's scope", () => {
  test("a reviewer can read diff and write findings", async () => {
    bb.forRole(GOAL, ident("reasoning")).write("diff", "the change");
    const token = mcp.mint(bb.forRole(GOAL, ident("review")));

    const read = await call(token, "blackboard_read", { kind: "diff" });
    expect(isErr(read.body)).toBe(false);
    expect(textOf(read.body)).toContain("the change");

    const write = await call(token, "blackboard_write", {
      kind: "findings",
      content: "looks good",
    });
    expect(isErr(write.body)).toBe(false);
    expect(textOf(write.body)).toMatch(/Wrote findings \[review\] v1/);
  });

  // The §6 guarantee, exercised through the transport an actual agent uses.
  test("a reviewer is refused research, with a reason it can act on", async () => {
    bb.forRole(GOAL, ident("search")).write("research", "how I got here");
    const token = mcp.mint(bb.forRole(GOAL, ident("review")));
    const r = await call(token, "blackboard_read", { kind: "research" });
    // An MCP tool error, not a transport error: the agent should see WHY and
    // adapt, not get an opaque failure it retries forever.
    expect(r.status).toBe(200);
    expect(isErr(r.body)).toBe(true);
    expect(textOf(r.body)).toMatch(/may not read "research"/);
  });

  test("a reviewer is refused writing outside its lane", async () => {
    const token = mcp.mint(bb.forRole(GOAL, ident("review")));
    const r = await call(token, "blackboard_write", { kind: "diff", content: "sneaky" });
    expect(isErr(r.body)).toBe(true);
    expect(textOf(r.body)).toMatch(/may not write "diff"/);
  });

  // No tool takes a goal id, so a child cannot address another goal even by
  // guessing one — the mount is the boundary.
  test("no tool accepts a goal id, a session id, or a slot", async () => {
    const token = mcp.mint(bb.forRole(GOAL, ident("review")));
    const list = await rpc(token, "tools/list");
    // Assert on PARAMETER names, not the serialized blob — the descriptions
    // legitimately mention "this goal" in prose.
    const params = (list.body.result.tools as Array<{ inputSchema: { properties: object } }>)
      .flatMap((t) => Object.keys(t.inputSchema.properties ?? {}))
      .sort();
    // The full parameter vocabulary of the surface is exactly two names.
    expect([...new Set(params)]).toEqual(["content", "kind"]);
    for (const forbidden of ["goal", "goalSessionId", "sessionId", "slot", "accountId"]) {
      expect(params).not.toContain(forbidden);
    }
  });

  // Two goals, two tokens: neither can see the other's artifacts.
  test("a token cannot reach another goal's artifacts", async () => {
    const other: GoalScope = { ...GOAL, goalSessionId: "goal-2" };
    bb.forRole(GOAL, ident("reasoning")).write("diff", "goal one diff");
    bb.forRole(other, ident("reasoning")).write("diff", "goal two diff");

    const t1 = mcp.mint(bb.forRole(GOAL, ident("review")));
    const t2 = mcp.mint(bb.forRole(other, ident("review")));

    expect(textOf((await call(t1, "blackboard_read", { kind: "diff" })).body)).toContain(
      "goal one diff",
    );
    expect(textOf((await call(t2, "blackboard_read", { kind: "diff" })).body)).toContain(
      "goal two diff",
    );
  });

  test("blackboard_write takes no slot, so a peer's entry is unreachable", async () => {
    const t1 = mcp.mint(bb.forRole(GOAL, ident("review", 1)));
    const t2 = mcp.mint(bb.forRole(GOAL, ident("review", 2)));
    await call(t1, "blackboard_write", { kind: "findings", content: "from one" });
    // Even passing a slot explicitly cannot redirect the write — the schema
    // rejects unknown properties and the service picks the slot regardless.
    await call(t2, "blackboard_write", { kind: "findings", content: "from two", slot: "review" });

    const all = new BlackboardStore(store.database).latestAllSlots(GOAL, "findings");
    expect(all).toHaveLength(2);
    expect(all.map((a) => a.content).sort()).toEqual(["from one", "from two"]);
  });

  test("the index is readable and carries no bodies", async () => {
    bb.forRole(GOAL, ident("search")).write("research", "SECRET-RESEARCH-BODY");
    const token = mcp.mint(bb.forRole(GOAL, ident("review")));
    const r = await call(token, "blackboard_index");
    const text = textOf(r.body);
    expect(text).toContain("research");
    // Knowing it exists is not reading it.
    expect(text).not.toContain("SECRET-RESEARCH-BODY");
    // And the mount tells the agent its own scope, so it can plan.
    expect(text).toMatch(/You may read: spec, diff/);
    expect(text).toMatch(/You may write: findings/);
  });

  test("an unknown tool is an error result, not a crash", async () => {
    const token = mcp.mint(bb.forRole(GOAL, ident("review")));
    const r = await call(token, "blackboard_nope");
    expect(isErr(r.body)).toBe(true);
    expect(textOf(r.body)).toMatch(/Unknown tool/);
  });

  test("an unknown method is a JSON-RPC error", async () => {
    const token = mcp.mint(bb.forRole(GOAL, ident("review")));
    const r = await rpc(token, "resources/list");
    expect(r.body.error.code).toBe(-32601);
  });
});
