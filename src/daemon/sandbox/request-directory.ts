/**
 * `request_directory`: how an agent asks for a directory to write besides its
 * workspace (docs/sandbox.md, "Working across repositories"). The tool only
 * asks; the session decides (Session#requestDirectory): in guarded and
 * interactive mode its owner answers a confirm card naming the directory and
 * the reason (owner-only, audited); in autonomous mode (an unattended run's
 * too) a repository, or a dir in one, under the session's project roots,
 * named by a path with no link in it, is added unasked (audited) and
 * anything else is refused at once, with a reason the agent reads. Never
 * parks an unattended run. What is added is the directory the path really
 * is then, and takes effect at the session's next turn.
 *
 * Delivered the way codeoid's other session tools are: in-process (the
 * Claude Agent SDK's server, which Qwen's SDK takes as is), and over the
 * daemon's HTTP MCP endpoint {@link SANDBOX_MCP_PATH} for the backends that
 * mount a URL (Codex, the Gemini CLI, opencode). A token there is one
 * session's, minted for it and revoked with it: there is no parameter naming
 * a session.
 */

import { randomUUID } from "node:crypto";
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { DEFAULT_MCP_PROTOCOL_VERSION, ok, rpcErr, tokenFrom, type JsonRpcMessage, type JsonRpcResponse } from "../mcp/jsonrpc-http.js";

export const SANDBOX_MCP_SERVER_NAME = "codeoid_sandbox";
export const REQUEST_DIRECTORY_TOOL = "request_directory";
/** The tool's name as the Claude SDK exposes it. */
export const REQUEST_DIRECTORY_TOOL_FQ = `mcp__${SANDBOX_MCP_SERVER_NAME}__${REQUEST_DIRECTORY_TOOL}`;
/** Where the endpoint is mounted on the daemon's HTTP server. */
export const SANDBOX_MCP_PATH = "/mcp/sandbox";
/** The env var a URL-mounting backend reads the token from (Codex's `bearer_token_env_var`; out of its commands' environment: `CODEOID_*_TOKEN`). */
export const SANDBOX_MCP_TOKEN_ENV = "CODEOID_SANDBOX_TOKEN";
/**
 * How long a call waits for its owner's answer before it returns "no answer
 * yet" (the question stays open; a later yes still adds the directory):
 * under the Gemini CLI's and Qwen's MCP call timeout (10 min); Codex's is
 * raised past it (`tool_timeout_sec`).
 */
export const REQUEST_DIRECTORY_WAIT_MS = 8 * 60_000;
/** The same on opencode, whose MCP client gives a call about a minute (the MCP SDK's default request timeout). */
export const REQUEST_DIRECTORY_SHORT_WAIT_MS = 45_000;

export interface RequestDirectoryInput {
  path: string;
  reason: string;
}

/** Decides a request for `sessionId`; resolves with the text the agent reads. Never rejects. */
export type RequestDirectoryHandler = (sessionId: string, input: RequestDirectoryInput) => Promise<string>;

export const REQUEST_DIRECTORY_DESCRIPTION = [
  "Ask for write access to a directory outside your workspace (another repository, say), for this session's sandboxed commands.",
  "Your commands can already read the session's project roots; this is for writing. Give the absolute path and why you need it.",
  "Interactive and guarded mode: the owner is asked and decides. Autonomous mode: a repository (or a directory in one) under the project roots, named by its real path (no symbolic link in it), is added at once; anything else is refused.",
  "An added directory is writable from your next turn: finish this turn after it is granted. Never your home, /, a git or settings dir (.git, .claude, …), or a dir of credentials.",
].join(" ");

const REASON_MAX = 1000;

function clean(input: Record<string, unknown>): RequestDirectoryInput | string {
  const path = typeof input.path === "string" ? input.path.trim() : "";
  const reason = typeof input.reason === "string" ? input.reason.trim().slice(0, REASON_MAX) : "";
  if (!path) return "Refused: give the directory's absolute path (`path`).";
  if (path.length > 4096) return "Refused: that path is too long.";
  if (!reason) return "Refused: say why you need to write there (`reason`): the owner reads it.";
  return { path, reason };
}

/** The tool as an in-process MCP server bound to one session (Claude; Qwen's SDK takes the same shape). */
export function buildSandboxMcpServer(sessionId: string, handle: RequestDirectoryHandler): McpSdkServerConfigWithInstance {
  const request = tool(
    REQUEST_DIRECTORY_TOOL,
    REQUEST_DIRECTORY_DESCRIPTION,
    {
      path: z.string().min(1).max(4096).describe("The directory, absolute (~ expands)."),
      reason: z.string().min(1).max(REASON_MAX).describe("Why you need to write there: the owner reads it."),
    },
    async (args) => {
      const input = clean(args as Record<string, unknown>);
      const text = typeof input === "string" ? input : await handle(sessionId, input).catch((e) => `Refused: ${e instanceof Error ? e.message : String(e)}`);
      return { content: [{ type: "text" as const, text }] };
    },
  );
  return createSdkMcpServer({ name: SANDBOX_MCP_SERVER_NAME, version: "0.1.0", tools: [request] });
}

/** What a session hands a URL-mounting backend. */
export interface SandboxMcpMount {
  url: string;
  token: string;
}

/** The tool's input as JSON Schema (the HTTP endpoint's `tools/list`, pi's bridge). */
export const REQUEST_DIRECTORY_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    path: { type: "string", description: "The directory, absolute (~ expands)." },
    reason: { type: "string", description: "Why you need to write there: the owner reads it." },
  },
  required: ["path", "reason"],
  additionalProperties: false,
};

/** The daemon's `/mcp/sandbox` endpoint: one token per session, `request_directory` its one tool. */
export class SandboxMcpHttp {
  readonly #tokens = new Map<string, string>();
  readonly #handle: RequestDirectoryHandler;

  constructor(handle: RequestDirectoryHandler) {
    this.#handle = handle;
  }

  /** A token scoped to `sessionId`: the scope of every call made with it. */
  mint(sessionId: string): string {
    const token = `sbt_${randomUUID().replace(/-/g, "")}`;
    this.#tokens.set(token, sessionId);
    return token;
  }

  revoke(token: string): void {
    this.#tokens.delete(token);
  }

  /** Every token of `sessionId` (its destroy). */
  revokeSession(sessionId: string): void {
    for (const [t, s] of this.#tokens) if (s === sessionId) this.#tokens.delete(t);
  }

  get activeTokens(): number {
    return this.#tokens.size;
  }

  async handle(req: Request): Promise<Response> {
    if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
    const token = tokenFrom(req);
    const sessionId = token ? this.#tokens.get(token) : undefined;
    if (!sessionId) {
      return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "Content-Type": "application/json", "WWW-Authenticate": "Bearer" } });
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
      const res = await this.#dispatch(m, sessionId);
      if (res) responses.push(res);
    }
    if (responses.length === 0) return new Response(null, { status: 202 });
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (sawInitialize && token) headers["Mcp-Session-Id"] = token;
    return new Response(JSON.stringify(batch ? responses : responses[0]), { status: 200, headers });
  }

  async #dispatch(msg: JsonRpcMessage | null, sessionId: string): Promise<JsonRpcResponse | null> {
    if (msg?.id === undefined) return null;
    const id = msg.id ?? null;
    switch (msg.method) {
      case "initialize": {
        const requested = msg.params?.protocolVersion;
        return ok(id, {
          protocolVersion: typeof requested === "string" ? requested : DEFAULT_MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: SANDBOX_MCP_SERVER_NAME, version: "0.1.0" },
        });
      }
      case "ping":
        return ok(id, {});
      case "tools/list":
        return ok(id, { tools: [{ name: REQUEST_DIRECTORY_TOOL, description: REQUEST_DIRECTORY_DESCRIPTION, inputSchema: REQUEST_DIRECTORY_SCHEMA }] });
      case "tools/call": {
        const name = msg.params?.name;
        if (name !== REQUEST_DIRECTORY_TOOL) return ok(id, { content: [{ type: "text", text: `Unknown tool: ${String(name)}` }], isError: true });
        const input = clean((msg.params?.arguments ?? {}) as Record<string, unknown>);
        const text = typeof input === "string" ? input : await this.#handle(sessionId, input).catch((e) => `Refused: ${e instanceof Error ? e.message : String(e)}`);
        return ok(id, { content: [{ type: "text", text }], isError: false });
      }
      default:
        return rpcErr(id, -32601, `Method not found: ${String(msg.method)}`);
    }
  }
}
