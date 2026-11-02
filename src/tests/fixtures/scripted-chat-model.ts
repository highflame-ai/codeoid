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
 *   [[usage:<n>]]           report <n> prompt tokens (a context near its limit: opencode compacts next)
 *   [[compact-slow:<ms>]]   anywhere in the conversation: opencode's compaction request ("You MUST
 *                           summarize the conversation above…") streams its summary that slowly
 *   [[midfail:<n>]]         in any user message: the first <n> requests of that conversation stream
 *                           some text, then end the stream with no finish_reason (a dropped stream)
 * No directive: "ok". Usage is on the last chunk: 100 + 10 per request
 * served prompt tokens, 7 completion tokens.
 *
 * With SCRIPTED_LOG set, each request is appended to that file as a JSON line.
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
  usage?: number;
  think?: string;
  text?: string;
  call?: { name: string; args: string };
  slow: number;
  fail?: number;
  /** Stream the text, then end the stream without a finish_reason. */
  drop?: boolean;
}

/** Requests served per `[[midfail:N]]` conversation (keyed by the user message holding it). */
const midfails = new Map<string, number>();

function plan(messages: Msg[]): Plan {
  const lastUser = messages.findLastIndex((m) => m.role === "user");
  const u = lastUser >= 0 ? text(messages[lastUser]!.content) : "";
  const midfailIn = messages.map((m) => (m.role === "user" ? text(m.content) : "")).findLast((t) => /\[\[midfail:\d+\]\]/.test(t));
  if (midfailIn !== undefined) {
    const served = (midfails.get(midfailIn) ?? 0) + 1;
    midfails.set(midfailIn, served);
    if (served <= Number(/\[\[midfail:(\d+)\]\]/.exec(midfailIn)![1])) return { slow: 0, text: "partial answer words ", drop: true };
    return { slow: 0, text: /\[\[text:([^\]]*)\]\]/.exec(midfailIn)?.[1] ?? "ok" };
  }
  if (u.startsWith("You MUST summarize the conversation above")) {
    const all = messages.map((m) => text(m.content)).join(" ");
    return { slow: Number(/\[\[compact-slow:(\d+)\]\]/.exec(all)?.[1] ?? 0), text: "summary ".repeat(40) };
  }
  const slow = Number(/\[\[slow:(\d+)\]\]/.exec(u)?.[1] ?? 0);
  const usage = /\[\[usage:(\d+)\]\]/.exec(u);
  if (usage) return { slow, usage: Number(usage[1]), text: /\[\[text:([^\]]*)\]\]/.exec(u)?.[1] ?? "ok" };
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
    const body = (await req.json()) as { messages: Msg[]; tools?: unknown[] };
    const id = ++served;
    if (process.env.SCRIPTED_LOG) {
      const lastUser = body.messages.findLast((m) => m.role === "user");
      const line = { id, tools: body.tools?.length ?? 0, messages: body.messages.length, system: text(body.messages.find((m) => m.role === "system")?.content).slice(0, 120), lastUser: text(lastUser?.content).slice(0, 300) };
      await Bun.write(process.env.SCRIPTED_LOG, `${(await Bun.file(process.env.SCRIPTED_LOG).exists()) ? await Bun.file(process.env.SCRIPTED_LOG).text() : ""}${JSON.stringify(line)}\n`);
    }
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
          if (p.drop) {
            ctrl.close();
            return;
          }
          if (p.call) ctrl.enqueue(chunk({ tool_calls: [{ index: 0, id: `call_${id}`, type: "function", function: { name: p.call.name, arguments: p.call.args } }] }));
          ctrl.enqueue(chunk({}, p.call ? "tool_calls" : "stop"));
          const prompt = p.usage ?? 100 + 10 * id;
          ctrl.enqueue(chunk({}, null, { prompt_tokens: prompt, completion_tokens: 7, total_tokens: prompt + 7 }));
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
