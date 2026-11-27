/**
 * MockProvider — deterministic fake AgentProvider for offline CI tests.
 *
 * Usage:
 *   const provider = new MockProvider("fake-claude", [
 *     // Turn 1 events
 *     [
 *       { type: "text_delta", content: "Hello" },
 *       { type: "text_done", content: "Hello" },
 *       { type: "turn_done", result: mockResult() },
 *     ],
 *     // Turn 2 events
 *     [...],
 *   ]);
 *
 * Each call to runTurn() dequeues the next script entry and emits those
 * events synchronously (as microtasks). No network calls are made.
 *
 * The `capturedOpts` array records every TurnOpts passed to runTurn() so
 * tests can assert on the history that was forwarded.
 */

import { AsyncQueue } from "../../async-queue.js";
import type {
  AgentProvider,
  ModelInfo,
  NormalizedTurnResult,
  ProviderEvent,
  TurnOpts,
  TurnRun,
} from "../interface.js";

export function mockResult(overrides: Partial<NormalizedTurnResult> = {}): NormalizedTurnResult {
  return {
    providerId: "mock",
    model: "mock-model",
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalCostUsd: 0,
    // A mock stands for a backend that reports its own cost (#430); tests of priced turns say otherwise.
    costSource: "backend",
    durationMs: 1,
    ...overrides,
  };
}

export class MockProvider implements AgentProvider {
  readonly id: string;
  readonly displayName: string;

  /** Recorded TurnOpts for every runTurn() call — inspect in tests. */
  readonly capturedOpts: TurnOpts[] = [];

  #script: ProviderEvent[][];

  constructor(id: string, script: ProviderEvent[][] = []) {
    this.id = id;
    this.displayName = `Mock(${id})`;
    this.#script = script.map((s) => [...s]);
  }

  runTurn(opts: TurnOpts): TurnRun {
    this.capturedOpts.push(opts);

    const events = this.#script.shift() ?? [
      { type: "turn_done", result: mockResult({ providerId: this.id }) },
    ];

    const queue = new AsyncQueue<ProviderEvent>();

    // Emit all events as microtasks so consumers can await normally.
    void Promise.resolve().then(() => {
      for (const event of events) {
        try {
          queue.push(event);
        } catch {
          break; // queue was closed (interrupt called)
        }
      }
      queue.close();
    });

    return {
      events: queue,
      interrupt: async () => {
        queue.close();
      },
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    return [{ id: "mock-model", displayName: "Mock Model" }];
  }

  async dispose(): Promise<void> {}
}
