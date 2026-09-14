#!/usr/bin/env node
/**
 * `codeoid-memory` — the memory engine as a standalone MCP server over stdio,
 * so any harness that can mount an MCP server (Claude Code, Codex, Cursor,
 * Windsurf…) gets codeoid's verbatim workspace recall without running codeoid.
 *
 * Same tools, same ranking, same SQLite file as the daemon's in-process and
 * HTTP mounts — only the transport differs. Pointing the default `--db` at
 * `~/.codeoid/memory.db` means a codeoid user's existing episodes are readable
 * from their editor on the first run, with nothing to migrate.
 *
 * stdio discipline: stdout carries JSON-RPC and NOTHING else. Diagnostics go to
 * stderr — one stray write to stdout desynchronizes the client's parser.
 */

import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { MemoryEngine } from "./engine.js";
import {
  DEFAULT_MCP_PROTOCOL_VERSION,
  ok,
  rpcErr,
  type JsonRpcMessage,
  type JsonRpcResponse,
} from "./jsonrpc-http.js";
import { createMemory } from "./index.js";
import { workspaceIdFromPath } from "./store.js";
import { memoryToolDefs, type MemoryToolContext } from "./tools.js";

const SERVER_INFO = { name: "codeoid-memory", version: "0.4.0" } as const;

const USAGE = `codeoid-memory — verbatim workspace memory as an MCP server (stdio)

Usage:
  codeoid-memory [options]

Options:
  --workspace <path>   Directory the memories are scoped to (default: cwd)
  --db <path>          SQLite file (default: ~/.codeoid/memory.db)
  --account <id>       Tenant account id (default: personal)
  --project <id>       Tenant project id (default: dev)
  -h, --help           Show this help

Mount it in Claude Code with:
  claude mcp add codeoid-memory -- npx -y @highflame/codeoid-memory
`;

function arg(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

if (process.argv.includes("-h") || process.argv.includes("--help")) {
  process.stdout.write(USAGE);
  process.exit(0);
}

const workdir = resolve(arg("--workspace", process.cwd()));
const dbPath = resolve(arg("--db", join(homedir(), ".codeoid", "memory.db")));
const workspaceId = workspaceIdFromPath(workdir, {
  accountId: arg("--account", "personal"),
  projectId: arg("--project", "dev"),
});
// Recall excludes the caller's own turns, so each server process needs an id
// that no stored episode carries — nothing here writes, so it stays synthetic.
const sessionId = `mcp_stdio_${randomUUID()}`;

const defs = memoryToolDefs();

/** Built on first tool call, not at startup: the embedder downloads a ~50MB
 *  model on a cold cache and would blow the client's handshake timeout. */
let engineOnce: Promise<MemoryEngine> | null = null;
function engine(): Promise<MemoryEngine> {
  engineOnce ??= (async () => {
    const e = await createMemory({ dbPath });
    await e.init();
    return e;
  })();
  return engineOnce;
}

async function dispatch(msg: JsonRpcMessage): Promise<JsonRpcResponse | null> {
  // JSON-RPC notifications carry no id — acknowledge with no response.
  if (msg.id === undefined) return null;
  const id = msg.id ?? null;

  switch (msg.method) {
    case "initialize": {
      const requested = msg.params?.protocolVersion;
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
        tools: defs.map((d) => ({
          name: d.name,
          description: d.description,
          inputSchema: d.jsonSchema,
        })),
      });
    case "tools/call": {
      const name = msg.params?.name;
      const def = defs.find((d) => d.name === name);
      if (!def) {
        return ok(id, {
          content: [{ type: "text", text: `Unknown tool: ${String(name)}` }],
          isError: true,
        });
      }
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
      const ctx: MemoryToolContext = { engine: await engine(), workspaceId, sessionId };
      try {
        return ok(id, { content: [{ type: "text", text: await def.run(args, ctx) }], isError: false });
      } catch (e) {
        return ok(id, {
          content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` }],
          isError: true,
        });
      }
    }
    default:
      return rpcErr(id, -32601, `Method not found: ${String(msg.method)}`);
  }
}

// Serialized: responses carry ids so out-of-order would be legal, but recall is
// fast and one writer keeps SQLite contention and output interleaving out of play.
let queue: Promise<void> = Promise.resolve();

createInterface({ input: process.stdin }).on("line", (line) => {
  const text = line.trim();
  if (!text) return;
  queue = queue.then(async () => {
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(text) as JsonRpcMessage;
    } catch {
      process.stdout.write(`${JSON.stringify(rpcErr(null, -32700, "Parse error"))}\n`);
      return;
    }
    const res = await dispatch(msg);
    if (res) process.stdout.write(`${JSON.stringify(res)}\n`);
  });
});

process.stdin.on("close", () => {
  void queue.then(async () => {
    if (engineOnce) await (await engineOnce).close();
    process.exit(0);
  });
});

process.stderr.write(`codeoid-memory: workspace=${workdir} db=${dbPath}\n`);
