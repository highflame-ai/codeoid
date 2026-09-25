/**
 * fake-codex — offline stand-in for `codex app-server` (newline JSON-RPC).
 *
 * Mirrors the wire behavior probed against @openai/codex@0.144.1
 * (docs/provider-codex-design.md → Probe results). Turn behavior is keyed
 * off the prompt text, like fake-pi:
 *
 *   "use-tool"   → server→client item/commandExecution/requestApproval,
 *                  then runs or skips the item based on the decision
 *   "auto-tool"  → item/completed for a command codex ran WITHOUT asking
 *   "ask-user"   → server→client item/tool/requestUserInput (select)
 *   "echo-policy"→ agentMessage with the approval/sandbox policies received
 *   "echo-mcp"   → agentMessage with the `-c mcp_servers.*` args + token env
 *   "echo-prompt"→ agentMessage containing the full received prompt
 *   default      → two agentMessage deltas + completed message
 *
 * Every turn ends with turn/completed carrying usage.
 *
 * thread/start + turn/start enforce the same `SandboxPolicy` shape the REAL
 * codex does (see fake-codex-validate.ts) — a bare-kebab-string sandboxPolicy
 * is rejected with codex's own serde error, so the #163 wire-shape regression
 * can't slip through offline again.
 */

import { sandboxPolicyError } from "./fake-codex-validate.js";

const enc = new TextEncoder();
function send(obj: unknown): void {
  process.stdout.write(enc.encode(`${JSON.stringify(obj)}\n`));
}

let nextServerReqId = 1000;
const pendingServerReqs = new Map<number, (result: Record<string, unknown>) => void>();

/** Approval/sandbox policy last seen on thread/start + turn/start, echoed by
 *  the "echo-policy" prompt so the provider's wire params can be asserted. */
let lastThreadPolicies: Record<string, unknown> = {};
let lastTurnPolicies: Record<string, unknown> = {};

function serverRequest(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const id = nextServerReqId++;
  send({ jsonrpc: "2.0", id, method, params });
  return new Promise((resolve) => pendingServerReqs.set(id, resolve));
}

/** Matches the real codex tokenUsage.last shape (thread/tokenUsage/updated). */
function tokenUsage() {
  return { totalTokens: 165, inputTokens: 120, cachedInputTokens: 20, outputTokens: 45, reasoningOutputTokens: 0 };
}
function emitUsage(threadId: string): void {
  send({
    method: "thread/tokenUsage/updated",
    // `ThreadTokenUsage` carries THREE fields on the real wire — `last`,
    // `total` and `modelContextWindow` (the codex binary's own serde says
    // "struct ThreadTokenUsage with 3 elements"). The third is how codex tells
    // us the window; the fixture omitted it, so nothing exercised that path.
    params: {
      threadId,
      turnId: "turn-1",
      tokenUsage: { total: tokenUsage(), last: tokenUsage(), modelContextWindow: 272_000 },
    },
  });
}

async function runTurn(threadId: string, prompt: string): Promise<void> {
  send({ method: "turn/started", params: { turn: { id: "turn-1" } } });

  if (prompt.includes("use-tool")) {
    const decision = await serverRequest("item/commandExecution/requestApproval", {
      threadId,
      turnId: "turn-1",
      itemId: "item-cmd-1",
      command: "rm -rf /tmp/scratch",
      cwd: "/tmp",
      reason: "cleanup",
    });
    if (decision.decision === "approved") {
      send({
        method: "item/completed",
        params: {
          item: { id: "item-cmd-1", type: "commandExecution", command: "rm -rf /tmp/scratch", aggregatedOutput: "removed", status: "completed" },
        },
      });
      send({ method: "item/agentMessage/delta", params: { delta: "Cleaned up." } });
      send({ method: "item/completed", params: { item: { id: "m1", type: "agentMessage", text: "Cleaned up." } } });
    } else {
      send({ method: "item/agentMessage/delta", params: { delta: "Approval denied; skipping." } });
      send({ method: "item/completed", params: { item: { id: "m1", type: "agentMessage", text: "Approval denied; skipping." } } });
    }
  } else if (prompt.includes("auto-tool")) {
    // codex ran a trusted read without asking — only item/completed arrives.
    send({
      method: "item/completed",
      params: { item: { id: "item-auto-1", type: "commandExecution", command: "ls -la", aggregatedOutput: "file-a\nfile-b", status: "completed" } },
    });
    send({ method: "item/completed", params: { item: { id: "m1", type: "agentMessage", text: "Listed files." } } });
  } else if (prompt.includes("mcp-nostart")) {
    // Defensive path: an elicitation arrives with NO preceding item/started
    // (so the provider can't correlate the tool from the item). It must still
    // recover the tool name from the `message` and the args from
    // `_meta.tool_params`. Distinct token so it doesn't match "mcp-tool".
    const decision = await serverRequest("mcpServer/elicitation/request", {
      threadId,
      turnId: "turn-1",
      serverName: "codeoid_memory",
      mode: "form",
      _meta: { codex_approval_kind: "mcp_tool_call", tool_description: "Recall verbatim episodes.", tool_params: { query: "compliance" } },
      message: 'Allow the codeoid_memory MCP server to run tool "recall"?',
      requestedSchema: { type: "object", properties: {} },
    });
    const text = decision.action === "accept" ? "Recalled (nostart)." : "Rejected.";
    send({ method: "item/completed", params: { item: { id: "m1", type: "agentMessage", text } } });
  } else if (prompt.includes("mcp-tool")) {
    // codex gates an MCP tool call: item/started names server+tool, then a
    // separate MCP elicitation (names only the server) asks permission. The
    // reply MUST be the MCP `{action}` shape; run or skip on accept/decline.
    send({
      method: "item/started",
      params: { item: { id: "item-mcp-1", type: "mcpToolCall", server: "codeoid_memory", tool: "recall", arguments: { query: "compliance" } } },
    });
    const decision = await serverRequest("mcpServer/elicitation/request", {
      threadId,
      turnId: "turn-1",
      serverName: "codeoid_memory",
      mode: "form",
      _meta: { codex_approval_kind: "mcp_tool_call", tool_description: "Recall verbatim episodes.", tool_params: { query: "compliance" } },
      message: 'Allow the codeoid_memory MCP server to run tool "recall"?',
      requestedSchema: { type: "object", properties: {} },
    });
    if (decision.action === "accept") {
      send({
        method: "item/completed",
        params: { item: { id: "item-mcp-1", type: "mcpToolCall", server: "codeoid_memory", tool: "recall", arguments: { query: "compliance" }, aggregatedOutput: "8 episodes", status: "completed" } },
      });
      send({ method: "item/completed", params: { item: { id: "m1", type: "agentMessage", text: "Recalled." } } });
    } else {
      send({ method: "item/completed", params: { item: { id: "m1", type: "agentMessage", text: "The MCP tool call was rejected by the user." } } });
    }
  } else if (prompt.includes("ask-user")) {
    const answer = await serverRequest("item/tool/requestUserInput", {
      threadId,
      turnId: "turn-1",
      itemId: "item-q-1",
      questions: [
        { id: "q1", header: "Pick one", question: "Which env?", options: [{ label: "dev" }, { label: "prod" }] },
      ],
    });
    const answers = answer.answers as Array<{ answer?: string | null }> | undefined;
    const picked = answers?.[0]?.answer ?? "no-answer";
    send({ method: "item/completed", params: { item: { id: "m1", type: "agentMessage", text: `You picked: ${picked}` } } });
  } else if (prompt.includes("hang-forever")) {
    // Emit nothing further — the test interrupts the turn.
    return;
  } else if (prompt.includes("unknown-request")) {
    const resp = await serverRequest("custom/unknownThing", { anything: true });
    const text = resp.__error ? "server-request-errored" : "server-request-oddly-ok";
    send({ method: "item/completed", params: { item: { id: "m1", type: "agentMessage", text } } });
  } else if (prompt.includes("echo-policy")) {
    const text = JSON.stringify({ thread: lastThreadPolicies, turn: lastTurnPolicies });
    send({ method: "item/completed", params: { item: { id: "m1", type: "agentMessage", text } } });
  } else if (prompt.includes("echo-mcp")) {
    // Surface the `-c mcp_servers.*` overrides + token env the provider spawned
    // us with, so the memory mount wiring can be asserted offline.
    const mcpArgs = process.argv.filter((a) => a.includes("mcp_servers"));
    const text = JSON.stringify({ mcpArgs, token: process.env.CODEOID_MEMORY_TOKEN ?? null });
    send({ method: "item/completed", params: { item: { id: "m1", type: "agentMessage", text } } });
  } else if (prompt.includes("echo-prompt")) {
    send({ method: "item/completed", params: { item: { id: "m1", type: "agentMessage", text: `PROMPT:${prompt}` } } });
  } else {
    send({ method: "item/reasoning/textDelta", params: { delta: "thinking..." } });
    send({ method: "item/agentMessage/delta", params: { delta: "Hello " } });
    send({ method: "item/agentMessage/delta", params: { delta: "world" } });
    send({ method: "item/completed", params: { item: { id: "m1", type: "agentMessage", text: "Hello world" } } });
  }

  emitUsage(threadId);
  send({ method: "turn/completed", params: { turn: { id: "turn-1", status: "completed" } } });
}

let buf = "";
process.stdin.on("data", (chunk: Buffer) => {
  buf += chunk.toString("utf8");
  for (;;) {
    const idx = buf.indexOf("\n");
    if (idx < 0) break;
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(line);
    } catch {
      continue;
    }
    void handle(frame);
  }
});

async function handle(frame: Record<string, unknown>): Promise<void> {
  const id = frame.id as number | undefined;
  const method = frame.method as string | undefined;
  const params = (frame.params ?? {}) as Record<string, unknown>;

  // Response to one of OUR server→client requests.
  if (id !== undefined && method === undefined) {
    const resolve = pendingServerReqs.get(id);
    if (resolve) {
      pendingServerReqs.delete(id);
      const error = frame.error as { message?: string } | undefined;
      resolve(
        error
          ? { __error: error.message ?? "error" }
          : ((frame.result ?? { decision: "denied" }) as Record<string, unknown>),
      );
    }
    return;
  }
  if (method === undefined) return;

  switch (method) {
    case "initialize":
      send({ id, result: { userAgent: "fake-codex/0.144.1" } });
      break;
    case "initialized":
      break;
    case "thread/start": {
      const bad = sandboxPolicyError(params.sandboxPolicy);
      if (bad) return void send({ id, error: { code: -32602, message: bad } });
      lastThreadPolicies = { approvalPolicy: params.approvalPolicy, sandboxPolicy: params.sandboxPolicy };
      send({ id, result: { thread: { id: "codex-thread-1" } } });
      send({ method: "thread/started", params: { thread: { id: "codex-thread-1" } } });
      break;
    }
    case "thread/resume":
      send({ id, result: { thread: { id: String(params.threadId ?? "codex-thread-1") } } });
      break;
    case "model/list":
      send({
        id,
        result: {
          data: [
            { id: "gpt-5.6-terra", model: "gpt-5.6-terra", displayName: "GPT-5.6-Terra", description: "Balanced agentic coding model." },
          ],
        },
      });
      break;
    case "turn/start": {
      const bad = sandboxPolicyError(params.sandboxPolicy);
      if (bad) return void send({ id, error: { code: -32602, message: bad } });
      lastTurnPolicies = { approvalPolicy: params.approvalPolicy, sandboxPolicy: params.sandboxPolicy };
      send({ id, result: { turn: { id: "turn-1" } } });
      const input = params.input as Array<{ type: string; text?: string }> | undefined;
      const prompt = input?.find((i) => i.type === "text")?.text ?? "";
      void runTurn(String(params.threadId ?? ""), prompt);
      break;
    }
    case "turn/interrupt":
      send({ id, result: {} });
      send({ method: "turn/completed", params: { turn: { id: "turn-1", status: "interrupted" } } });
      break;
    case "test/noReply":
      break; // deliberately never answered — rpc timeout test
    default:
      send({ id, error: { code: -32601, message: `fake-codex: unknown method ${method}` } });
      break;
  }
}
// This file is a module (see the import above), so no explicit `export {}`
// is needed to avoid global-script collisions with other fixtures under tsc.
