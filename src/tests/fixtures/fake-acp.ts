/**
 * fake-acp — offline stand-in for an ACP agent (`gemini --acp` shape):
 * newline JSON-RPC; session/prompt is a LONG-RUNNING request answered when
 * the turn ends (its result carries stopReason). Turn behavior keys off the
 * prompt text, like fake-codex:
 *
 *   "use-tool"      → session/request_permission (allow/reject options),
 *                     runs the tool_call only when allowed
 *   "use-edit <path>" → session/request_permission for an edit, shaped as
 *                     gemini-cli 0.50 sends it: no rawInput, the file in
 *                     `locations` ({path}) and in a `diff` content block
 *   "auto-tool"     → tool_call + tool_call_update without asking
 *   "echo-prompt"   → agent_message_chunk with the full prompt
 *   "echo-mcp"      → agent_message_chunk with the last session/new mcpServers
 *   "hang-forever"  → never finishes (test sends session/cancel)
 *   "unknown-request" → sends a bogus server→client request first
 *   default         → thought chunk + two message chunks
 */

const enc = new TextEncoder();
function send(obj: unknown): void {
  process.stdout.write(enc.encode(`${JSON.stringify(obj)}\n`));
}

let nextServerReqId = 5000;
const pendingServerReqs = new Map<number, (frame: Record<string, unknown>) => void>();
let cancelRequested = false;
let authenticated = "";
/** Last mcpServers array received on session/new — surfaced via "echo-mcp". */
let lastMcpServers: unknown = null;

function serverRequest(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const id = nextServerReqId++;
  send({ jsonrpc: "2.0", id, method, params });
  return new Promise((resolve) => pendingServerReqs.set(id, resolve));
}

function update(sessionId: string, u: Record<string, unknown>): void {
  send({ method: "session/update", params: { sessionId, update: u } });
}

async function runTurn(sessionId: string, prompt: string): Promise<string> {
  if (prompt.includes("use-tool")) {
    const resp = await serverRequest("session/request_permission", {
      sessionId,
      toolCall: { toolCallId: "tc-1", title: "Run rm", kind: "execute", rawInput: { command: "rm -rf /tmp/scratch" } },
      options: [
        { optionId: "allow-1", name: "Allow", kind: "allow_once" },
        { optionId: "reject-1", name: "Reject", kind: "reject_once" },
      ],
    });
    const outcome = (resp.result as { outcome?: { outcome?: string; optionId?: string } } | undefined)?.outcome ?? (resp.outcome as { outcome?: string; optionId?: string } | undefined);
    if (outcome?.outcome === "selected" && outcome.optionId === "allow-1") {
      update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "tc-1", status: "completed", rawOutput: "removed" });
      update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Cleaned up." } });
    } else {
      update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Permission refused; skipping." } });
    }
    return "end_turn";
  }
  const edit = /use-edit (\S+)/.exec(prompt);
  if (edit) {
    const path = edit[1]!;
    const resp = await serverRequest("session/request_permission", {
      sessionId,
      toolCall: {
        toolCallId: "tc-3",
        status: "pending",
        title: `Edit ${path}`,
        content: [{ type: "diff", path, oldText: "a", newText: "b" }],
        locations: [{ path }],
        kind: "edit",
      },
      options: [
        { optionId: "allow-1", name: "Allow", kind: "allow_once" },
        { optionId: "reject-1", name: "Reject", kind: "reject_once" },
      ],
    });
    const outcome = (resp.result as { outcome?: { outcome?: string; optionId?: string } } | undefined)?.outcome;
    const allowed = outcome?.outcome === "selected" && outcome.optionId === "allow-1";
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: allowed ? "Edited." : "Permission refused; skipping." } });
    return "end_turn";
  }
  if (prompt.includes("auto-tool")) {
    update(sessionId, { sessionUpdate: "tool_call", toolCallId: "tc-2", title: "Read file", kind: "read", rawInput: { path: "a.ts" } });
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "tc-2", status: "completed", content: [{ content: { type: "text", text: "export {}" } }] });
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Read it." } });
    return "end_turn";
  }
  if (prompt.includes("echo-mcp")) {
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `MCP:${JSON.stringify(lastMcpServers)}` } });
    return "end_turn";
  }

  if (prompt.includes("echo-prompt")) {
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `PROMPT:${prompt}` } });
    return "end_turn";
  }
  if (prompt.includes("hang-forever")) {
    // Poll for cancellation — the ACP prompt only ends via session/cancel.
    for (;;) {
      if (cancelRequested) return "cancelled";
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  if (prompt.includes("unknown-request")) {
    const resp = await serverRequest("custom/bogusThing", {});
    const errored = resp.error !== undefined;
    update(sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: errored ? "server-request-errored" : "server-request-oddly-ok" },
    });
    return "end_turn";
  }
  update(sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "pondering..." } });
  update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello " } });
  update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ACP" } });
  return "end_turn";
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

  // Response to one of OUR server→client requests (result OR error).
  if (id !== undefined && method === undefined) {
    const resolve = pendingServerReqs.get(id);
    if (resolve) {
      pendingServerReqs.delete(id);
      resolve(frame);
    }
    return;
  }
  if (method === undefined) return;

  switch (method) {
    case "initialize":
      send({
        id,
        result: {
          protocolVersion: 1,
          agentCapabilities: {},
          authMethods: [
            { id: "oauth-personal", name: "Log in with Google" },
            { id: "gemini-api-key", name: "API key" },
          ],
        },
      });
      break;
    case "authenticate":
      authenticated = String(params.methodId ?? "");
      send({ id, result: {} });
      break;
    case "session/new":
      // GEMINI_FAKE_REQUIRE_AUTH mirrors real gemini-cli with cached OAuth
      // creds but no recorded selection: session/new fails until the ACP
      // authenticate method picks one.
      if (process.env.GEMINI_FAKE_REQUIRE_AUTH && !authenticated) {
        send({ id, error: { code: -32000, message: "Gemini API key is missing or not configured." } });
        break;
      }
      lastMcpServers = params.mcpServers ?? null;
      send({ id, result: { sessionId: "acp-session-1", authMethod: authenticated || null } });
      break;
    case "session/prompt": {
      cancelRequested = false;
      const prompt = (params.prompt as Array<{ type: string; text?: string }> | undefined)
        ?.find((b) => b.type === "text")?.text ?? "";
      const stopReason = await runTurn(String(params.sessionId ?? ""), prompt);
      send({ id, result: { stopReason } });
      break;
    }
    case "session/cancel":
      cancelRequested = true;
      break;
    default:
      send({ id, error: { code: -32601, message: `fake-acp: unknown method ${method}` } });
      break;
  }
}

// Module scope (avoids global-script collisions with other fixtures under tsc).
export {};
