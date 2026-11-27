/**
 * Slack Socket Mode client: envelopes are acknowledged (with the handler's
 * reply when Slack accepts one), and a `disconnect` opens a new connection.
 */
import { describe, expect, it } from "bun:test";
import { SlackApiError, SlackSocket, type SlackTransport, type SocketLike, slackApi } from "../frontends/slack/socket.js";

function fakeSlack() {
  const sockets: Array<SocketLike & { sent: string[] }> = [];
  let opens = 0;
  const transport: SlackTransport = {
    fetch: async (url) => {
      if (String(url).endsWith("apps.connections.open")) {
        opens++;
        return Response.json({ ok: true, url: `wss://test/${opens}` });
      }
      return Response.json({ ok: false, error: "channel_not_found" });
    },
    connect: () => {
      const s = { sent: [] as string[], send(d: string) { s.sent.push(d); }, close() {}, onopen: null, onmessage: null, onclose: null, onerror: null } as SocketLike & { sent: string[] };
      sockets.push(s);
      return s;
    },
  };
  return { transport, sockets, opens: () => opens };
}

describe("SlackSocket", () => {
  it("acknowledges each envelope, with the handler's reply when Slack accepts one", async () => {
    const slack = fakeSlack();
    const seen: string[] = [];
    const socket = new SlackSocket("xapp", async (env) => {
      seen.push(env.type);
      return env.type === "slash_commands" ? { text: "hi" } : undefined;
    }, slack.transport);
    await socket.start();
    const s = slack.sockets[0]!;
    s.onmessage?.({ data: JSON.stringify({ type: "hello" }) });
    s.onmessage?.({ data: JSON.stringify({ envelope_id: "e1", type: "slash_commands", payload: { text: "x" }, accepts_response_payload: true }) });
    s.onmessage?.({ data: JSON.stringify({ envelope_id: "e2", type: "events_api", payload: { event: {} } }) });
    await Bun.sleep(10);
    expect(seen).toEqual(["slash_commands", "events_api"]);
    // An event is acknowledged at once; the slash command once its answer is ready, with it.
    expect(s.sent.map((x) => JSON.parse(x)).sort((a, b) => a.envelope_id.localeCompare(b.envelope_id))).toEqual([{ envelope_id: "e1", payload: { text: "hi" } }, { envelope_id: "e2" }]);
    socket.stop();
  });

  it("a disconnect from Slack opens a new connection", async () => {
    const slack = fakeSlack();
    const socket = new SlackSocket("xapp", async () => undefined, slack.transport);
    await socket.start();
    slack.sockets[0]!.onmessage?.({ data: JSON.stringify({ type: "disconnect", reason: "refresh_requested" }) });
    for (let i = 0; i < 300 && slack.opens() < 2; i++) await Bun.sleep(10);
    expect(slack.opens()).toBe(2);
    socket.stop();
  });

  it("a Web API error throws with Slack's code", async () => {
    const slack = fakeSlack();
    await expect(slackApi(slack.transport, "xoxb", "chat.postMessage", {})).rejects.toBeInstanceOf(SlackApiError);
  });

  it("events are acknowledged at once, handled one at a time in order, and a retried event is dropped", async () => {
    const slack = fakeSlack();
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const socket = new SlackSocket("xapp", async (env) => {
      const id = String(env.payload.event_id);
      if (id === "Ev1") await gate;
      order.push(id);
      return undefined;
    }, slack.transport);
    await socket.start();
    const s = slack.sockets[0]!;
    s.onmessage?.({ data: JSON.stringify({ envelope_id: "e1", type: "events_api", payload: { event_id: "Ev1" } }) });
    s.onmessage?.({ data: JSON.stringify({ envelope_id: "e2", type: "events_api", payload: { event_id: "Ev2" } }) });
    s.onmessage?.({ data: JSON.stringify({ envelope_id: "e3", type: "events_api", payload: { event_id: "Ev1" }, retry_attempt: 1 }) });
    await Bun.sleep(10);
    // All three acknowledged before any handling finished.
    expect(s.sent.length).toBe(3);
    release();
    await Bun.sleep(20);
    expect(order).toEqual(["Ev1", "Ev2"]);
    socket.stop();
  });

  it("a slow slash command answers at its response_url", async () => {
    const slack = fakeSlack();
    const posted: string[] = [];
    const fetch = slack.transport.fetch;
    slack.transport.fetch = async (url, init) => {
      if (String(url).startsWith("https://hooks.slack.com/")) {
        posted.push(String(init?.body));
        return new Response("ok");
      }
      return fetch(url, init);
    };
    const socket = new SlackSocket("xapp", async () => {
      await Bun.sleep(2_700);
      return { text: "late answer" };
    }, slack.transport);
    await socket.start();
    const s = slack.sockets[0]!;
    s.onmessage?.({ data: JSON.stringify({ envelope_id: "e1", type: "slash_commands", accepts_response_payload: true, payload: { response_url: "https://hooks.slack.com/commands/x" } }) });
    await Bun.sleep(3_000);
    expect(JSON.parse(s.sent[0]!)).toEqual({ envelope_id: "e1" });
    expect(posted).toEqual([JSON.stringify({ text: "late answer" })]);
    socket.stop();
  });

  it("one user's slow handling never holds up another's", async () => {
    const slack = fakeSlack();
    const done: string[] = [];
    const socket = new SlackSocket("xapp", async (env) => {
      const user = String((env.payload.event as { user?: string }).user);
      if (user === "SLOW") await new Promise(() => {});
      done.push(user);
      return undefined;
    }, slack.transport);
    await socket.start();
    const s = slack.sockets[0]!;
    s.onmessage?.({ data: JSON.stringify({ envelope_id: "e1", type: "events_api", payload: { event_id: "A", event: { user: "SLOW" } } }) });
    s.onmessage?.({ data: JSON.stringify({ envelope_id: "e2", type: "events_api", payload: { event_id: "B", event: { user: "FAST" } } }) });
    await Bun.sleep(20);
    expect(done).toEqual(["FAST"]);
    socket.stop();
  });

  it("an envelope Slack resends (a press, a command) is acknowledged and not handled again", async () => {
    const slack = fakeSlack();
    let handled = 0;
    const socket = new SlackSocket("xapp", async () => {
      handled++;
      return undefined;
    }, slack.transport);
    await socket.start();
    const s = slack.sockets[0]!;
    const press = JSON.stringify({ envelope_id: "same", type: "interactive", payload: { type: "block_actions", user: { id: "U" } } });
    s.onmessage?.({ data: press });
    s.onmessage?.({ data: press });
    await Bun.sleep(20);
    expect(handled).toBe(1);
    expect(s.sent.length).toBe(2);
    socket.stop();
  });

  it("stop closes every socket, the one being replaced included", async () => {
    const slack = fakeSlack();
    const closed: number[] = [];
    const connect = slack.transport.connect;
    slack.transport.connect = (url) => {
      const sock = connect(url);
      const n = slack.sockets.length;
      sock.close = () => {
        closed.push(n);
      };
      return sock;
    };
    const socket = new SlackSocket("xapp", async () => undefined, slack.transport);
    await socket.start();
    slack.sockets[0]!.onmessage?.({ data: JSON.stringify({ type: "disconnect" }) });
    await Bun.sleep(20);
    expect(slack.sockets.length).toBe(2);
    socket.stop();
    expect(closed.sort()).toEqual([1, 2]);
  });

  it("a start that can't reach Slack keeps trying; a refused token stops it", async () => {
    let tries = 0;
    const down: SlackTransport = {
      fetch: async () => {
        tries++;
        throw new Error("network down");
      },
      connect: () => {
        throw new Error("never");
      },
    };
    const socket = new SlackSocket("xapp", async () => undefined, down);
    await socket.start();
    for (let i = 0; i < 200 && tries < 2; i++) await Bun.sleep(10);
    expect(tries).toBe(2);
    socket.stop();
    const refused: SlackTransport = { fetch: async () => Response.json({ ok: false, error: "invalid_auth" }), connect: () => { throw new Error("never"); } };
    await expect(new SlackSocket("xapp", async () => undefined, refused).start()).rejects.toThrow("invalid_auth");
  });
});
