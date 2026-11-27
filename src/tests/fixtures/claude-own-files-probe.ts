/**
 * Runs the REAL Claude Code CLI (the Agent SDK's bundled binary) against a
 * localhost stand-in for the Messages API (no model, no vendor) for #448
 * round 9: the stand-in answers the first request with the one tool call in
 * `<call.json>` and the next with "finished". Prints one JSON line: the
 * call's result, which calls reached canUseTool, and the memory dir the
 * CLI's system prompt names.
 *
 *   bun claude-own-files-probe.ts <root> <call.json> [deny]
 *
 * `<root>/home` is the CLI's HOME, `<root>/home/proj` its cwd, `<root>/cli`
 * its CLAUDE_CODE_TMPDIR. Grep and Glob are opted in (`allowedTools`).
 * `deny`: the query's settings carry the Read deny rules codeoid gives an
 * autonomous query (claudeSearchExclusions) for `proj/.env` and
 * `proj/secretdir`, hidden inside the workspace. Run in its own process: a
 * test file that mocks the SDK module must not see this one.
 */
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { claudeSearchExclusions } from "../../daemon/providers/claude/host-files.js";

const [root = "", callFile = "", mode = "none"] = process.argv.slice(2);
const call = JSON.parse(readFileSync(callFile, "utf8")) as { name: string; input: Record<string, unknown> };
const home = join(root, "home");
const ws = join(home, "proj");
const cliTemp = join(root, "cli");
mkdirSync(cliTemp, { recursive: true });

let toolResult: string | null = null;
let system = "";
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
    const body = (await req.json()) as { system?: unknown; tools?: Array<{ name: string }>; messages: Array<{ role: string; content: unknown }> };
    system += JSON.stringify(body.system ?? "");
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
      content = [{ type: "tool_use", id: "toolu_probe", name: call.name, input: call.input }];
      stop = "tool_use";
    }
    return new Response(stream(content, stop), { headers: { "content-type": "text/event-stream" } });
  },
});

const exclusions = claudeSearchExclusions({ workspace: ws, tempDir: join(root, "tmp"), writable: [], reexposed: [], hidden: [home, join(ws, ".env"), join(ws, "secretdir")] });
const asked: string[] = [];
let result = "";
try {
  for await (const m of query({
    prompt: "run the probe",
    options: {
      cwd: ws,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: home,
        ANTHROPIC_API_KEY: "sk-test-not-a-real-key",
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        DISABLE_AUTOUPDATER: "1",
        CLAUDE_CODE_TMPDIR: cliTemp,
      },
      permissionMode: "default",
      allowedTools: ["Grep", "Glob"],
      settingSources: ["project", "user"],
      systemPrompt: { type: "preset", preset: "claude_code" },
      ...(mode === "deny" ? { settings: { permissions: { deny: exclusions.rules } } } : {}),
      canUseTool: async (name, input) => {
        asked.push(name);
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
const memDir = /`([^`]*\/memory\/)`/.exec(system.replace(/\\n/g, "\n"))?.[1] ?? null;
console.log(JSON.stringify({ result, asked, toolResult, memDir }));
