/**
 * Runs the REAL Claude Code CLI (the Agent SDK's bundled binary) against a
 * localhost stand-in for the Messages API (no model, no vendor) that has the
 * model call EnterWorktree once, then finish (#448 round 6). Prints one JSON
 * line: which calls reached canUseTool, what the call's result said, and
 * whether the CLI made a worktree.
 *
 *   bun claude-worktree-probe.ts <repo> <refuse|none>
 *
 * `<repo>` is a git repository the test made. `refuse`: the PreToolUse hook
 * is codeoid's refusal for a sandboxed session (cliWorktreeDecision); `none`:
 * no hook, the CLI's own behaviour. Run in its own process: a test file that
 * mocks the SDK module must not see this one.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { cliWorktreeDecision } from "../../daemon/providers/claude/index.js";

const [repo = "", mode = "none"] = process.argv.slice(2);
let toolResult: string | null = null;
const sse = (events: Array<[string, unknown]>) => events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join("");
function stream(block: Record<string, unknown>, stop: string): string {
  const events: Array<[string, unknown]> = [
    ["message_start", { type: "message_start", message: { id: "msg", type: "message", role: "assistant", model: "claude-test", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } }],
  ];
  if (block.type === "text") {
    events.push(["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }]);
    events.push(["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: block.text } }]);
  } else {
    events.push(["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } }]);
    events.push(["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } }]);
  }
  events.push(["content_block_stop", { type: "content_block_stop", index: 0 }]);
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
        if (c.type === "tool_result" && c.tool_use_id === "toolu_wt") toolResult = typeof c.content === "string" ? c.content : JSON.stringify(c.content);
      }
    }
    const call = toolResult === null && body.tools?.some((t) => t.name === "EnterWorktree");
    const block = call ? { type: "tool_use", id: "toolu_wt", name: "EnterWorktree", input: { name: "probe" } } : { type: "text", text: "finished" };
    return new Response(stream(block, call ? "tool_use" : "end_turn"), { headers: { "content-type": "text/event-stream" } });
  },
});

const asked: string[] = [];
let result = "";
try {
  for await (const m of query({
    prompt: "probe",
    options: {
      cwd: repo,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: join(repo, "..", "home"),
        GIT_CONFIG_NOSYSTEM: "1",
        ANTHROPIC_API_KEY: "sk-test-not-a-real-key",
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        DISABLE_AUTOUPDATER: "1",
      },
      permissionMode: "default",
      settingSources: ["project", "user"],
      ...(mode === "refuse"
        ? { hooks: { PreToolUse: [{ hooks: [async (i: unknown) => cliWorktreeDecision((i as { tool_name?: unknown }).tool_name, true) ?? {}] }] } }
        : {}),
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
const dir = join(repo, ".claude", "worktrees");
const worktrees = existsSync(dir) ? readdirSync(dir) : [];
console.log(JSON.stringify({ result, asked, toolResult, worktrees }));
