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
    expect(s.sent.map((x) => JSON.parse(x))).toEqual([{ envelope_id: "e1", payload: { text: "hi" } }, { envelope_id: "e2" }]);
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
});
