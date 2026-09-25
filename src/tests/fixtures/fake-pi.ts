/**
 * fake-pi — a protocol-faithful stand-in for `pi --mode rpc`, driven by
 * provider-pi.test.ts through a wrapper script. Speaks strict-LF JSONL on
 * stdin/stdout and simulates exactly the slices of pi the PiProvider
 * consumes:
 *
 *   - the codeoid bridge handshake (setStatus codeoid=bridge-ready) and
 *     bridge tool-approvals (`ctx.ui.input` with the reserved title) —
 *     i.e. it behaves as if the injected bridge extension were loaded
 *   - prompt-scripted turns keyed on the prompt text (see below)
 *   - get_state / get_session_stats / get_available_models / get_commands /
 *     set_model / switch_session / new_session / abort
 *
 * Prompt scripts:
 *   "hello"     → two text deltas + assistant message_end + agent_end
 *   "use-tool"  → bridge approval round-trip, then tool_execution_end whose
 *                 output echoes the (possibly patched) input, then agent_end
 *   "ask-user"  → a real extension confirm dialog; the assistant's reply
 *                 states the answer
 *   "notify"    → extension notify + a short text turn
 *
 * Env knobs: FAKE_PI_NO_BRIDGE=1 skips the bridge handshake (fail-closed test).
 */

const sessionId = `fake-${process.pid}`;
const sessionFile = `/tmp/fake-pi-${process.pid}.jsonl`;
let turns = 0;

const pendingUi = new Map<string, (resp: Record<string, unknown>) => void>();
let uiSeq = 0;

function emit(frame: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function respond(id: unknown, command: string, extra: Record<string, unknown> = {}): void {
  emit({ ...(typeof id === "string" ? { id } : {}), type: "response", command, success: true, ...extra });
}

function askUi(request: Record<string, unknown>): Promise<Record<string, unknown>> {
  const id = `ui-${++uiSeq}`;
  return new Promise((resolve) => {
    pendingUi.set(id, resolve);
    emit({ type: "extension_ui_request", id, ...request });
  });
}

if (process.env.FAKE_PI_NO_BRIDGE !== "1") {
  // The bridge's session_start handshake (fire-and-forget).
  emit({
    type: "extension_ui_request",
    id: "ui-handshake",
    method: "setStatus",
    statusKey: "codeoid",
    statusText: "bridge-ready",
  });
}

async function runPrompt(message: string): Promise<void> {
  turns += 1;
  emit({ type: "agent_start" });

  if (message.includes("use-tool")) {
    const toolCallId = `tc-${turns}`;
    const input = { command: "echo hi" };
    const answer = await askUi({
      method: "input",
      title: "codeoid:tool-approval",
      placeholder: JSON.stringify({ toolCallId, toolName: "bash", input }),
    });
    let decision: { behavior?: string; updatedInput?: Record<string, unknown> } = {};
    try {
      decision = JSON.parse(String(answer.value ?? "{}"));
    } catch {
      decision = {};
    }
    if (decision.behavior === "allow") {
      const effective = { ...input, ...(decision.updatedInput ?? {}) };
      emit({ type: "tool_execution_start", toolCallId, toolName: "bash", args: effective });
      emit({
        type: "tool_execution_end",
        toolCallId,
        toolName: "bash",
        result: { content: [{ type: "text", text: `ran:${JSON.stringify(effective)}` }] },
        isError: false,
      });
    } else {
      emit({
        type: "tool_execution_end",
        toolCallId,
        toolName: "bash",
        result: { content: [{ type: "text", text: "blocked by extension" }] },
        isError: true,
      });
    }
  } else if (message.includes("ask-user")) {
    const answer = await askUi({
      method: "confirm",
      title: "Deploy?",
      message: "The extension wants to deploy.",
    });
    const text = answer.cancelled ? "dialog cancelled" : `confirmed=${String(answer.confirmed)}`;
    emit({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" },
    });
  } else if (message.includes("recall-tool")) {
    // Stand in for a pi-registered memory tool's execute(): send a
    // codeoid:memory-tool ui-request; PiProvider runs the recall def against
    // the daemon engine and answers with the verbatim result text.
    const answer = await askUi({
      method: "input",
      title: "codeoid:memory-tool",
      placeholder: JSON.stringify({ tool: "recall", args: { query: "unicorn" } }),
    });
    emit({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: `RECALL:${String(answer.value ?? "")}` }], stopReason: "stop" },
    });
  } else if (message.includes("mcp-tool")) {
    // Stand in for a pi-registered external-MCP tool's execute(): send a
    // codeoid:mcp-tool ui-request; PiProvider runs it through McpHub and answers.
    const answer = await askUi({
      method: "input",
      title: "codeoid:mcp-tool",
      placeholder: JSON.stringify({ name: "mcp__local__echo", args: { msg: "hi" } }),
    });
    emit({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: `MCP:${String(answer.value ?? "")}` }], stopReason: "stop" },
    });
  } else if (message.includes("notify")) {
    emit({
      type: "extension_ui_request",
      id: `ui-${++uiSeq}`,
      method: "notify",
      message: "extension says hi",
      notifyType: "warning",
    });
  } else if (message.includes("ungated-tool")) {
    // A tool that never passed the bridge — the provider's loud-warning path.
    emit({
      type: "tool_execution_end",
      toolCallId: "rogue-1",
      toolName: "write",
      result: { content: [{ type: "text", text: "wrote file" }] },
      isError: false,
    });
  } else if (message.includes("echo-prompt")) {
    // Reflect the FULL received prompt back — lets tests prove what
    // actually reached pi (e.g. the prepended history seed).
    emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: `received:${message}` }],
        stopReason: "stop",
      },
    });
  } else {
    emit({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hello " },
    });
    emit({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "world" },
    });
    emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Hello world" }],
        stopReason: "stop",
      },
    });
  }

  emit({ type: "agent_end", messages: [] });
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buf += chunk;
  for (;;) {
    const nl = buf.indexOf("\n");
    if (nl === -1) break;
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    handle(JSON.parse(line) as Record<string, unknown>);
  }
});

function handle(cmd: Record<string, unknown>): void {
  switch (cmd.type) {
    case "extension_ui_response": {
      const resolve = pendingUi.get(String(cmd.id));
      if (resolve) {
        pendingUi.delete(String(cmd.id));
        resolve(cmd);
      }
      return;
    }
    case "prompt":
      respond(cmd.id, "prompt");
      void runPrompt(String(cmd.message ?? ""));
      return;
    case "get_state":
      respond(cmd.id, "get_state", {
        data: {
          sessionId,
          sessionFile,
          isStreaming: false,
          thinkingLevel: "off",
          messageCount: turns,
        },
      });
      return;
    case "get_session_stats":
      respond(cmd.id, "get_session_stats", {
        data: {
          sessionFile,
          sessionId,
          tokens: { input: turns * 100, output: turns * 40, cacheRead: turns * 10, cacheWrite: 0, total: turns * 150 },
          cost: turns * 0.01,
          // Real pi (0.80.6) reports its current model's window here; the
          // fixture omitted it, so nothing exercised that path.
          contextUsage: { tokens: turns * 150, contextWindow: 1_048_576, percent: 0 },
        },
      });
      return;
    case "get_available_models":
      respond(cmd.id, "get_available_models", {
        data: {
          models: [
            { id: "claude-sonnet-4-5", provider: "anthropic", name: "Claude Sonnet 4.5", contextWindow: 200_000 },
            { id: "gpt-5", provider: "openai", name: "GPT-5", contextWindow: 400_000 },
          ],
        },
      });
      return;
    case "get_commands":
      respond(cmd.id, "get_commands", {
        data: {
          commands: [
            { name: "review", description: "Review the diff", source: "extension" },
            { name: "skill:websearch", description: "Web search", source: "skill" },
          ],
        },
      });
      return;
    case "set_model":
      respond(cmd.id, "set_model", { data: {} });
      return;
    case "switch_session":
    case "new_session":
      respond(cmd.id, String(cmd.type), { data: { cancelled: false } });
      return;
    case "abort":
    case "steer":
    case "follow_up":
      respond(cmd.id, String(cmd.type));
      return;
    default:
      emit({
        ...(typeof cmd.id === "string" ? { id: cmd.id } : {}),
        type: "response",
        command: String(cmd.type),
        success: false,
        error: `fake-pi: unhandled command ${String(cmd.type)}`,
      });
  }
}
