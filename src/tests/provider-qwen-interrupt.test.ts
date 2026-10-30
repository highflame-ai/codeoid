/**
 * QwenProvider interrupt semantics.
 *
 * qwen-code's `interrupt` control request aborts a session-wide controller the
 * CLI never resets, so the process later dies with "exited with code 1" — which
 * the consumer reads as a missing backing session and "recovers" by replaying
 * the last prompt. Stop must instead hard-abort (no recovery) and let the next
 * send rebuild the loop with `resume`.
 *
 * mock.module() lives in its own file so it cannot leak into the pure-function
 * tests in provider-qwen.test.ts.
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";

type Opts = {
  abortController: AbortController;
  resume?: string;
  sessionId?: string;
  canUseTool?: (name: string, input: unknown) => Promise<unknown>;
};

/** When set, the next query announces this tool call, then asks to run it (as the real SDK does). */
let nextToolCall: { id: string; name: string; input: Record<string, unknown> } | null = null;

/** Messages the next query sends, in order, before it waits. */
let nextMessages: unknown[] = [];

let queryCalls: Opts[] = [];
let softInterruptCalls = 0;

function makeMockQuery(opts: Opts) {
  let poisoned = false;
  const tool = nextToolCall;
  nextToolCall = null;
  let announced = false;
  const messages = nextMessages;
  nextMessages = [];
  return {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<{ done: boolean; value: unknown }> {
          if (messages.length > 0) return Promise.resolve({ done: false, value: messages.shift() });
          if (tool && !announced) {
            announced = true;
            setTimeout(() => void opts.canUseTool?.(tool.name, tool.input), 10);
            return Promise.resolve({
              done: false,
              value: { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "tool_use", ...tool }] } },
            });
          }
          return new Promise((_resolve, reject) => {
            opts.abortController.signal.addEventListener("abort", () =>
              reject(Object.assign(new Error("CLI process aborted by user"), { name: "AbortError" })),
            );
            // The real CLI dies after a soft interrupt once stdin is next read.
            const poll = setInterval(() => {
              if (poisoned) {
                clearInterval(poll);
                reject(new Error("CLI process exited with code 1"));
              }
            }, 5);
          });
        },
      };
    },
    interrupt: async () => {
      softInterruptCalls += 1;
      poisoned = true;
    },
    close: async () => {},
    getAvailableModels: async () => [],
  };
}

mock.module("@qwen-code/sdk", () => ({
  query: (args: { options: Opts }) => {
    queryCalls.push(args.options);
    return makeMockQuery(args.options);
  },
}));

import { QwenProvider } from "../daemon/providers/qwen/index.js";

function makeProvider(): QwenProvider {
  return new QwenProvider({
    sessionId: "sess-1",
    initialBackingId: "11111111-1111-4111-8111-111111111111",
    workspaceId: "ws_test",
    store: { audit: () => {} } as never,
  });
}

const turnOpts = (userMessage: string) => ({
  history: [],
  userMessage,
  workdir: "/tmp",
  canUseTool: async () => ({ behavior: "allow" as const }),
});

describe("QwenProvider interrupt", () => {
  beforeEach(() => {
    queryCalls = [];
    softInterruptCalls = 0;
  });

  test("hard-aborts instead of the CLI's soft interrupt, and does not trigger recovery", async () => {
    const provider = makeProvider();
    let recoveries = 0;
    provider.onRecoveryNeeded = () => {
      recoveries += 1;
    };

    const run = provider.runTurn(turnOpts("summarize the repo layout"));
    await run.interrupt();

    // The turn stream must end so the session can go idle.
    const events: unknown[] = [];
    for await (const e of run.events) events.push(e);
    await new Promise((r) => setTimeout(r, 50)); // past the mock's poison poll

    expect(softInterruptCalls).toBe(0);
    expect(queryCalls[0]?.abortController.signal.aborted).toBe(true);
    expect(recoveries).toBe(0);
    expect(events.filter((e) => (e as { type: string }).type === "error")).toHaveLength(0);
  });

  test("after a Stop, the next turn's approval still belongs to the call it announced (#430 round 2)", async () => {
    const provider = makeProvider();
    // The first turn translates a message (the provider's translation state is made then), and is stopped.
    nextToolCall = { id: "early-1", name: "read_file", input: { path: "a" } };
    const first = provider.runTurn(turnOpts("first"));
    await new Promise((r) => setTimeout(r, 40));
    await first.interrupt();
    for await (const _ of first.events) {
      /* drain */
    }
    nextToolCall = { id: "real-1", name: "run_shell_command", input: { command: "ls" } };
    const asked: string[] = [];
    const second = provider.runTurn({ ...turnOpts("second"), canUseTool: async (toolId: string) => {
      asked.push(toolId);
      return { behavior: "allow" as const };
    } });
    const starts: string[] = [];
    const reader = (async () => {
      for await (const e of second.events) if ((e as { type: string }).type === "tool_start") starts.push((e as { toolId: string }).toolId);
    })();
    await new Promise((r) => setTimeout(r, 80));
    await second.interrupt();
    await reader;
    expect(starts).toEqual(["real-1"]);
    expect(asked).toEqual(["real-1"]);
  });

  test("a sub-agent of a stopped turn, which never got its result, doesn't make the next turn's cost unknown (#430)", async () => {
    const provider = makeProvider();
    nextMessages = [{ type: "assistant", parent_tool_use_id: "t1", message: { content: [], usage: { input_tokens: 0, output_tokens: 0 } } }];
    const first = provider.runTurn(turnOpts("first"));
    await new Promise((r) => setTimeout(r, 20));
    await first.interrupt();
    const firstEvents: Array<{ type: string }> = [];
    for await (const e of first.events) firstEvents.push(e as { type: string });
    // Its request is one whose usage is never told: the stopped turn is unknown.
    expect(firstEvents.map((e) => e.type)).toEqual(["subagent_start", "model_request"]);
    nextMessages = [
      { type: "assistant", parent_tool_use_id: null, message: { content: [], usage: { input_tokens: 10, output_tokens: 1 } } },
      { type: "result", subtype: "success", is_error: false, modelUsage: { "qwen3.8-max": {} } },
    ];
    const second = provider.runTurn(turnOpts("second"));
    let done: { result: { costSource?: string } } | undefined;
    for await (const e of second.events) {
      if ((e as { type: string }).type === "turn_done") {
        done = e as never;
        break;
      }
    }
    expect(done).toBeDefined();
    expect(done!.result.costSource).toBeUndefined();
    await second.interrupt();
  });

  test("the next turn rebuilds the loop with resume, keeping the backing session", async () => {
    const provider = makeProvider();
    const first = provider.runTurn(turnOpts("first"));
    await first.interrupt();
    for await (const _ of first.events) {
      /* drain */
    }

    provider.runTurn(turnOpts("second"));

    expect(queryCalls).toHaveLength(2);
    expect(queryCalls[0]?.sessionId).toBe("11111111-1111-4111-8111-111111111111");
    expect(queryCalls[1]?.resume).toBe("11111111-1111-4111-8111-111111111111");
    expect(queryCalls[1]?.abortController.signal.aborted).toBe(false);
  });
});
