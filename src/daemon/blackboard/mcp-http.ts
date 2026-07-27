/**
 * Goal blackboard — MOUNTABLE MCP endpoint
 * (docs/collaborative-session-design.md §4; mountability is #245).
 *
 * Deliberately an HTTP Streamable MCP server rather than the in-process
 * Claude-SDK object (`createSdkMcpServer`) that backs the fleet tools. The
 * fleet's in-process server is exactly why the orchestrator is claude-only in
 * v1: no other backend can mount it. The blackboard must not inherit that
 * limitation, because the whole premise is that a *gemini* reviewer and an
 * *openai* reasoner hand work to each other. Anything that can mount an MCP
 * URL — claude, codex, gemini, openai, pi — gets the same surface.
 *
 * ## The token is the scope
 *
 * `mint()` binds a token to one `RoleBlackboard` handle: one goal, one role
 * identity, one read/write set. Every call resolves through that handle, so a
 * child physically cannot address another goal or widen its own scope — there
 * is no tool parameter that would let it try. An unknown or revoked token
 * fails closed with 401, same contract as the memory mount.
 *
 * This is why slice 1 put enforcement in the service: these tools are a
 * transport over `RoleBlackboard`, not a second place where scoping decisions
 * get made and could disagree.
 */

import { randomUUID } from "node:crypto";
import {
  DEFAULT_MCP_PROTOCOL_VERSION,
  ok,
  rpcErr,
  tokenFrom,
  type JsonRpcMessage,
  type JsonRpcResponse,
} from "../mcp/jsonrpc-http.js";
import type { RoleBlackboard } from "./service.js";
import { CORE_ARTIFACT_KINDS } from "./types.js";

/** Path the endpoint is mounted at on the daemon's HTTP server. */
export const BLACKBOARD_MCP_PATH = "/mcp/blackboard";

/**
 * The MCP server name backends mount this under. Tool calls arrive namespaced
 * by it (e.g. `codeoid_blackboard__blackboard_read`), which is what lets the
 * tool-safety layer recognize them.
 */
export const BLACKBOARD_MCP_SERVER_NAME = "codeoid_blackboard";

const SERVER_INFO = { name: BLACKBOARD_MCP_SERVER_NAME, version: "0.1.0" } as const;

/** What a mount hands to a session so it can reach the blackboard. */
export interface BlackboardMcpMount {
  endpoint: BlackboardMcpHttp;
  url: string;
}

const KIND_DESC = `Artifact kind: ${CORE_ARTIFACT_KINDS.join(", ")}, or extra/<key>`;

interface ToolDef {
  name: string;
  description: string;
  jsonSchema: Record<string, unknown>;
  run(args: Record<string, unknown>, bb: RoleBlackboard): string;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * The four tools. Note what is absent: nothing takes a goal id, and `write`
 * takes no slot. Both omissions are the security model — a child cannot name
 * another goal, and a reviewer cannot name another reviewer's slot.
 */
const TOOLS: ToolDef[] = [
  {
    name: "blackboard_index",
    description:
      "List which artifacts exist on this goal, at what version, written by whom, and how large — without their contents. Start here to see what is ready.",
    jsonSchema: { type: "object", properties: {}, additionalProperties: false },
    run: (_args, bb) => {
      const idx = bb.index();
      if (idx.length === 0) return "The blackboard is empty — no artifacts written yet.";
      const lines = idx.map(
        (e) =>
          `- ${e.kind}${e.slot ? ` [${e.slot}]` : ""} v${e.version} · ${e.bytes} bytes · by ${e.authorRole ?? e.authorSub}`,
      );
      return [
        `${idx.length} artifact(s) on this goal:`,
        ...lines,
        "",
        `You may read: ${bb.reads.join(", ") || "(nothing)"}`,
        `You may write: ${bb.writes.join(", ") || "(nothing)"}`,
      ].join("\n");
    },
  },
  {
    name: "blackboard_read",
    description:
      "Read the latest version of one artifact. Denied if your role's read scope doesn't include it.",
    jsonSchema: {
      type: "object",
      properties: { kind: { type: "string", description: KIND_DESC } },
      required: ["kind"],
      additionalProperties: false,
    },
    run: (args, bb) => {
      const r = bb.read(str(args.kind));
      if (!r.ok) throw new Error(r.error);
      if (!r.value) return `No "${str(args.kind)}" has been written on this goal yet.`;
      const a = r.value;
      return `${a.kind} v${a.version} (by ${a.authorRole ?? a.authorSub}):\n\n${a.content}`;
    },
  },
  {
    name: "blackboard_read_all",
    description:
      "Read every writer's latest entry for one artifact kind — e.g. all reviewers' findings. Denied if the kind is outside your read scope.",
    jsonSchema: {
      type: "object",
      properties: { kind: { type: "string", description: KIND_DESC } },
      required: ["kind"],
      additionalProperties: false,
    },
    run: (args, bb) => {
      const r = bb.readAll(str(args.kind));
      if (!r.ok) throw new Error(r.error);
      if (r.value.length === 0) return `No "${str(args.kind)}" entries on this goal yet.`;
      return r.value
        .map(
          (a) =>
            `── ${a.kind}${a.slot ? ` [${a.slot}]` : ""} v${a.version} by ${a.authorRole ?? a.authorSub} ──\n${a.content}`,
        )
        .join("\n\n");
    },
  },
  {
    name: "blackboard_write",
    description:
      "Publish your output as an artifact. Appends a new version — it never overwrites, and for multi-writer kinds you write your own entry, so you cannot clobber a peer. Denied if the kind is outside your write scope.",
    jsonSchema: {
      type: "object",
      properties: {
        kind: { type: "string", description: KIND_DESC },
        content: { type: "string", description: "The artifact body" },
      },
      required: ["kind", "content"],
      additionalProperties: false,
    },
    run: (args, bb) => {
      const w = bb.write(str(args.kind), str(args.content));
      if (!w.ok) throw new Error(w.error);
      const a = w.value;
      return `Wrote ${a.kind}${a.slot ? ` [${a.slot}]` : ""} v${a.version} (${a.content.length} bytes).`;
    },
  },
];

export class BlackboardMcpHttp {
  /** token → the role-scoped handle it authorizes. */
  readonly #bindings = new Map<string, RoleBlackboard>();

  /**
   * Mint a bearer token bound to one role's view of one goal. The token IS the
   * scope — there is no wider handle reachable from it.
   */
  mint(handle: RoleBlackboard): string {
    const token = `bbt_${randomUUID().replace(/-/g, "")}`;
    this.#bindings.set(token, handle);
    return token;
  }

  revoke(token: string): void {
    this.#bindings.delete(token);
  }

  /** Live token count — for teardown assertions + telemetry. */
  get activeTokens(): number {
    return this.#bindings.size;
  }

  /** Bun.serve fetch handler for {@link BLACKBOARD_MCP_PATH}. */
  async handle(req: Request): Promise<Response> {
    if (req.method !== "POST") {
      // No server-initiated SSE stream; some clients probe GET first.
      return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
    }

    const token = tokenFrom(req);
    const bb = token ? this.#bindings.get(token) : undefined;
    if (!bb) {
      // Fail closed — never run a tool without a resolved role scope.
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json", "WWW-Authenticate": "Bearer" },
      });
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return Response.json(rpcErr(null, -32700, "Parse error"), { status: 400 });
    }

    const batch = Array.isArray(body);
    const messages = (batch ? body : [body]) as JsonRpcMessage[];
    const responses: JsonRpcResponse[] = [];
    let sawInitialize = false;
    for (const m of messages) {
      if (m && m.method === "initialize") sawInitialize = true;
      const res = this.#dispatch(m, bb);
      if (res) responses.push(res);
    }

    if (responses.length === 0) return new Response(null, { status: 202 });

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (sawInitialize && token) headers["Mcp-Session-Id"] = token;
    return new Response(JSON.stringify(batch ? responses : responses[0]), {
      status: 200,
      headers,
    });
  }

  #dispatch(msg: JsonRpcMessage | null, bb: RoleBlackboard): JsonRpcResponse | null {
    const id = msg?.id ?? null;
    // JSON-RPC notifications carry no id — acknowledge with no response.
    if (msg?.id === undefined) return null;

    switch (msg?.method) {
      case "initialize": {
        const requested = msg?.params?.protocolVersion;
        return ok(id, {
          protocolVersion:
            typeof requested === "string" ? requested : DEFAULT_MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        });
      }
      case "ping":
        return ok(id, {});
      case "tools/list":
        return ok(id, {
          tools: TOOLS.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.jsonSchema,
          })),
        });
      case "tools/call": {
        const name = msg?.params?.name;
        const args = (msg?.params?.arguments ?? {}) as Record<string, unknown>;
        const def = TOOLS.find((t) => t.name === name);
        if (!def) {
          return ok(id, {
            content: [{ type: "text", text: `Unknown tool: ${String(name)}` }],
            isError: true,
          });
        }
        try {
          return ok(id, { content: [{ type: "text", text: def.run(args, bb) }], isError: false });
        } catch (e) {
          // A scope denial surfaces as an MCP tool error, not a transport
          // error: the agent should see *why* it was refused and adapt, not
          // get an opaque failure it might retry forever.
          return ok(id, {
            content: [
              { type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` },
            ],
            isError: true,
          });
        }
      }
      default:
        return rpcErr(id, -32601, `Method not found: ${String(msg?.method)}`);
    }
  }
}
