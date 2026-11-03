/**
 * Runs the REAL Claude Code CLI (the Agent SDK's bundled binary) with
 * codeoid's sandbox option (#448) against a localhost stand-in for the
 * Messages API — no model, no vendor: the stand-in answers the first request
 * with one Bash call and the next with "finished". Prints one JSON line:
 * what the call's result said and which tool calls reached canUseTool.
 *
 *   bun claude-sandbox-probe.ts <root> <on|off|allowlist> <command-file> [unsandboxed] [allowHost]
 *
 * `<root>` holds the planted files (`ws`, `tmp`, `secrets`); the command is
 * read from a file so it is never part of a shell line. Run in its own
 * process: a test file that mocks the SDK module must not see this one.
 * canUseTool here allows a sandboxed call and DENIES one asking to run
 * outside the sandbox, as codeoid's gate would until its owner says yes.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { claudeSandboxSettings } from "../../daemon/sandbox/claude-native.js";

const [root = "", networkArg = "off", commandFile = "", flag = "", allowHost = ""] = process.argv.slice(2);
const network = networkArg as "on" | "off" | "allowlist";
const command = readFileSync(commandFile, "utf8");
const unsandboxed = flag === "unsandboxed";

let toolResult: string | null = null;
const sse = (events: Array<[string, unknown]>) => events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join("");
function stream(content: Array<Record<string, unknown>>, stop: string): string {
  const events: Array<[string, unknown]> = [
    ["message_start", { type: "message_start", message: { id: "msg", type: "message", role: "assistant", model: "claude-test", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } }],
  ];
  content.forEach((block, i) => {
    if (block.type === "text") {
      events.push(["content_block_start", { type: "content_block_start", index: i, content_block: { type: "text", text: "" } }]);
      events.push(["content_block_delta", { type: "content_block_delta", index: i, delta: { type: "text_delta", text: block.text } }]);
    } else {
      events.push(["content_block_start", { type: "content_block_start", index: i, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } }]);
      events.push(["content_block_delta", { type: "content_block_delta", index: i, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } }]);
    }
    events.push(["content_block_stop", { type: "content_block_stop", index: i }]);
  });
  events.push(["message_delta", { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 1 } }]);
  events.push(["message_stop", { type: "message_stop" }]);
  return sse(events);
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    if (!new URL(req.url).pathname.endsWith("/messages")) return Response.json({ data: [] });
    const body = (await req.json()) as { tools?: Array<{ name: string }>; messages: Array<{ role: string; content: unknown }> };
    for (const m of body.messages) {
      if (!Array.isArray(m.content)) continue;
      for (const c of m.content as Array<{ type?: string; tool_use_id?: string; content?: unknown }>) {
        if (c.type === "tool_result" && c.tool_use_id === "toolu_probe") toolResult = typeof c.content === "string" ? c.content : JSON.stringify(c.content);
      }
    }
    let content: Array<Record<string, unknown>> = [{ type: "text", text: "ok" }];
    let stop = "end_turn";
    if (toolResult !== null) content = [{ type: "text", text: "finished" }];
    else if (body.tools?.some((t) => t.name === "Bash")) {
      content = [{ type: "tool_use", id: "toolu_probe", name: "Bash", input: { command, description: "probe", ...(unsandboxed ? { dangerouslyDisableSandbox: true } : {}) } }];
      stop = "tool_use";
    }
    return new Response(stream(content, stop), { headers: { "content-type": "text/event-stream" } });
  },
});

const env: Record<string, string> = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  HOME: join(root, "home"),
  ANTHROPIC_API_KEY: "sk-test-not-a-real-key",
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`,
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  DISABLE_AUTOUPDATER: "1",
};
const spec = {
  sessionId: "probe",
  workspace: join(root, "ws"),
  tempDir: join(root, "tmp"),
  writable: [],
  hidden: [join(root, "secrets")],
  reexposed: [],
  containerSockets: [],
  network: network === "allowlist" ? { mode: network, allow: [allowHost] } : { mode: network },
  unsetEnv: [],
};
const sandbox = claudeSandboxSettings({ spec, config: { provider: "auto", network, allowedHosts: [], hiddenPaths: [], docker: { image: "x" } } } as never, env);
const asked: string[] = [];
let result = "";
try {
  for await (const m of query({
    prompt: "run the probe",
    options: {
      cwd: join(root, "ws"),
      env,
      sandbox,
      permissionMode: "default",
      settingSources: [],
      canUseTool: async (name, input) => {
        asked.push(name);
        if ((input as { dangerouslyDisableSandbox?: boolean }).dangerouslyDisableSandbox) return { behavior: "deny", message: "denied by the gate" };
        return { behavior: "allow", updatedInput: input };
      },
    },
  })) {
    if (m.type === "result") result = m.subtype;
  }
} catch (err) {
  result = `failed: ${err instanceof Error ? err.message : String(err)}`;
}
server.stop(true);
console.log(JSON.stringify({ result, asked, toolResult }));
