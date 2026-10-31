/**
 * scripted-chat-model — a local OpenAI-compatible chat-completions server
 * whose replies are scripted by the prompt, so a REAL opencode binary can run
 * whole turns (its tools, permission engine, sessions, feed) offline, for
 * free. Configured into opencode as a provider using
 * `@opencode/ai/providers/openai-compatible` (see
 * provider-opencode.integration.test.ts, `CODEOID_OPENCODE_MODEL=scripted`).
 *
 * Prints one JSON line `{"url": "http://127.0.0.1:<port>/v1"}` when ready.
 *
 * Directives in the LAST user message:
 *   [[tool:<name> <json>]]  call that tool; once its result is in, reply "done: <result head>"
 *   [[text:<words>]]        reply with those words
 *   [[think:<words>]]       stream them as reasoning first
 *   [[slow:<ms>]]           wait that long between streamed chunks
 *   [[fail:<status>]]       answer with that HTTP error (after [[slow:<ms>]], if given)
 *   [[recall]]              reply with the first number in an earlier user message
 * No directive: "ok". Usage is on the last chunk: 100 + 10 per request
 * served prompt tokens, 7 completion tokens.
 *
 * With SCRIPTED_API_KEY set, a request whose bearer token isn't that value is
 * answered 401: a test can tell the key reached opencode's provider.
 */
export {};

type Msg = { role: string; content?: unknown };

function text(c: unknown): string {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((p) => (typeof p === "string" ? p : ((p as { text?: string }).text ?? ""))).join("");
  return "";
}

interface Plan {
  think?: string;
  text?: string;
  call?: { name: string; args: string };
  slow: number;
  fail?: number;
}

function plan(messages: Msg[]): Plan {
  const lastUser = messages.findLastIndex((m) => m.role === "user");
  const u = lastUser >= 0 ? text(messages[lastUser]!.content) : "";
  const slow = Number(/\[\[slow:(\d+)\]\]/.exec(u)?.[1] ?? 0);
  const fail = /\[\[fail:(\d+)\]\]/.exec(u);
  if (fail) return { slow, fail: Number(fail[1]) };
  const think = /\[\[think:([^\]]*)\]\]/.exec(u)?.[1];
  const results = messages.slice(lastUser + 1).filter((m) => m.role === "tool");
  if (results.length > 0) return { slow, text: `done: ${text(results.at(-1)!.content).replace(/\s+/g, " ").slice(0, 200)}` };
  // Greedy: a tool's JSON input may itself hold a directive (a subagent's prompt).
  const tool = /\[\[tool:(\S+) (.*)\]\]/s.exec(u);
  if (tool) return { slow, think, call: { name: tool[1]!, args: tool[2]! } };
  if (/\[\[recall\]\]/.test(u)) {
    const earlier = messages.slice(0, lastUser).filter((m) => m.role === "user").map((m) => text(m.content)).join(" ");
    return { slow, think, text: /\d+/.exec(earlier)?.[0] ?? "nothing" };
  }
  return { slow, think, text: /\[\[text:([^\]]*)\]\]/.exec(u)?.[1] ?? "ok" };
}

let served = 0;
const requiredKey = process.env.SCRIPTED_API_KEY;
const enc = new TextEncoder();
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (requiredKey && req.headers.get("authorization") !== `Bearer ${requiredKey}`) {
      return Response.json({ error: { message: "scripted: wrong or missing API key", type: "invalid_request_error" } }, { status: 401 });
    }
    if (req.method === "GET" && url.pathname.endsWith("/models")) return Response.json({ object: "list", data: [{ id: "scripted-1", object: "model" }] });
    if (!url.pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 });
    const body = (await req.json()) as { messages: Msg[] };
    const id = ++served;
    const p = plan(body.messages);
    if (p.fail && p.slow) await Bun.sleep(p.slow);
    if (p.fail) return Response.json({ error: { message: `scripted failure ${p.fail}`, type: "server_error" } }, { status: p.fail });
    const chunk = (delta: Record<string, unknown>, finish: string | null = null, usage?: unknown) =>
      enc.encode(
        `data: ${JSON.stringify({ id: `cmpl-${id}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "scripted-1", choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`,
      );
    const stream = new ReadableStream<Uint8Array>({
      async start(ctrl) {
        const pause = () => (p.slow ? Bun.sleep(p.slow) : Promise.resolve());
        try {
          ctrl.enqueue(chunk({ role: "assistant", content: "" }));
          for (const w of p.think?.split(" ") ?? []) {
            ctrl.enqueue(chunk({ reasoning_content: `${w} ` }));
            await pause();
          }
          for (const w of p.text?.match(/\S+\s*/g) ?? []) {
            ctrl.enqueue(chunk({ content: w }));
            await pause();
          }
          if (p.call) ctrl.enqueue(chunk({ tool_calls: [{ index: 0, id: `call_${id}`, type: "function", function: { name: p.call.name, arguments: p.call.args } }] }));
          ctrl.enqueue(chunk({}, p.call ? "tool_calls" : "stop"));
          ctrl.enqueue(chunk({}, null, { prompt_tokens: 100 + 10 * id, completion_tokens: 7, total_tokens: 107 + 10 * id }));
          ctrl.enqueue(enc.encode("data: [DONE]\n\n"));
          ctrl.close();
        } catch {
          /* the client went away (an interrupt) */
        }
      },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream" } });
  },
});
process.stdout.write(`${JSON.stringify({ url: `http://127.0.0.1:${server.port}/v1` })}\n`);
