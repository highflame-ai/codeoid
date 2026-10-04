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

type Opts = { abortController: AbortController; resume?: string; sessionId?: string };

let queryCalls: Opts[] = [];
let softInterruptCalls = 0;

function makeMockQuery(opts: Opts) {
  let poisoned = false;
  return {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<{ done: boolean; value: unknown }> {
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
