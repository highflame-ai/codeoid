/**
 * MockSessionProvider — deterministic SessionProvider for integration tests.
 *
 * Extends the scripted-turn model from MockProvider with the seven
 * ClaudeProvider-specific APIs that Session calls beyond AgentProvider:
 *   onRecoveryNeeded, backingSessionId, hasQueried, queuedMessages,
 *   resetToNewSession(), setHasQueried(), teardown()
 *
 * Critically, this mock calls opts.canUseTool for each tool_start event it
 * emits, simulating the SDK's PreToolUse hook.  This is necessary for:
 *   - The autonomous budget to decrement (via #shouldAutoApprove in canUseTool)
 *   - Manual approval flows to work (via #waitForApproval in canUseTool)
 *   - Map cleanup tests to exercise the real denial/interrupt paths
 *
 * Usage:
 *   const provider = new MockSessionProvider("mock", [
 *     [
 *       { type: "text_done",  content: "Hello" },
 *       { type: "turn_done",  result: mockResult() },
 *     ],
 *   ]);
 *   const session = new Session({ ..., _testProvider: provider });
 */

import { AsyncQueue } from "../../async-queue.js";
import type {
  ModelInfo,
  NormalizedTurnResult,
  ProviderEvent,
  SessionProvider,
  TurnOpts,
  TurnRun,
  SessionScopedEvent,
} from "../interface.js";
import type { ProviderCommand } from "../../../protocol/types.js";
import type { CanonicalTurn, HistorySeedResult } from "../canonical.js";

export { mockResult } from "./index.js";

export class MockSessionProvider implements SessionProvider {
  readonly id: string;
  readonly displayName: string;

  /** Set by Session.send() before each runTurn() call. */
  onRecoveryNeeded: ((content: string) => void) | undefined;
  /** Session-lifetime listener — installed by Session, fired by tests to
   *  simulate background work settling with or without a turn in flight. */
  onSessionEvent: ((event: SessionScopedEvent) => void) | undefined;

  #backingSessionId: string;
  #hasQueried = false;
  #script: ProviderEvent[][];
  /** When true, runTurn() emits its scripted events then leaves the queue OPEN
   *  (never closes, never emits a terminal turn_done) — simulating a provider
   *  whose stream has gone silent (hung tool / dead subprocess). The queue is
   *  only closed by teardown(), mirroring ClaudeProvider. */
  #stall: boolean;
  /** Live turn queue, so teardown() can unblock a waiting consumer like the real provider. */
  #currentQueue: AsyncQueue<ProviderEvent> | null = null;

  /** Every TurnOpts passed to runTurn() — inspect in tests. */
  readonly capturedOpts: TurnOpts[] = [];

  /** Incremented each time teardown() is called — useful for asserting cleanup. */
  teardownCount = 0;

  /**
   * Every canUseTool resolution observed by #emit — inspect in tests to
   * assert what updatedInput the provider would actually run with (e.g.
   * the approval sanitizer's patchableKeys behaviour).
   */
  readonly canUseToolResults: Array<{
    behavior: "allow" | "deny";
    updatedInput?: Record<string, unknown>;
    message?: string;
  }> = [];

  /**
   * Optional dynamic-command catalog. When set, the provider exposes
   * `listCommands()` (Session → `session.commands`). A function form lets
   * tests script failures by throwing.
   */
  commands?: ProviderCommand[] | (() => Promise<ProviderCommand[]>);

  /**
   * Optional part-action handler (Session → `session.part_action`). When
   * set, the provider exposes `handlePartAction()`. Invocations are
   * recorded in `partActions`.
   */
  partActionHandler?: (action: string, data: Record<string, unknown> | undefined) => void | Promise<void>;
  readonly partActions: Array<{ action: string; data?: Record<string, unknown> }> = [];

  /** History captured by seedFromHistory() — inspect in provider-switch tests. */
  seededHistory: readonly CanonicalTurn[] | null = null;
  /** maxChars passed to the last seedFromHistory() — inspect window-sizing. */
  seededMaxChars: number | undefined = undefined;
  /** When set, seedFromHistory() throws it (best-effort degradation tests). */
  seedFromHistoryError: Error | null = null;
  /** When set, seedFromHistory() returns it — lets tests force a truncation
   *  result so the session's surfacing path can be exercised. */
  seedResultOverride: HistorySeedResult | null = null;
  /** When true, the session's VWS strategy may seed the compact session map
   *  instead of a transcript (models a backend with recall tools mounted). */
  supportsMemoryTools = false;
  /** Blocks captured by seedText() — the compact session-map seed path. */
  readonly seededText: string[] = [];

  /** When true, TurnRuns expose pushMidTurn (recorded in `midTurnPushes`). */
  #midTurn: boolean;

  /** Every pushMidTurn injection observed — inspect in tests. */
  readonly midTurnPushes: Array<{ content: string; priority: string }> = [];

  /** Times Session called `TurnRun.endTurn()` — the turn-exit signal. */
  endTurnCount = 0;

  /**
   * Push an event into the LIVE turn queue from a test: the deterministic
   * stand-in for "the SDK emitted this later in the turn". Needed to model a
   * terminal turn_done arriving after a mid-turn push (the pendingMidTurnCount
   * hang), which a static script can't express. Returns false when the turn's
   * queue is already gone or closed.
   */
  emitLive(event: ProviderEvent): boolean {
    const q = this.#currentQueue;
    if (!q) return false;
    try {
      q.push(event);
      return true;
    } catch {
      return false;
    }
  }

  constructor(
    id = "mock-session",
    script: ProviderEvent[][] = [],
    opts: { stall?: boolean; midTurn?: boolean } = {},
  ) {
    this.id = id;
    this.displayName = `MockSession(${id})`;
    this.#backingSessionId = `${id}-backing`;
    this.#script = script.map((s) => [...s]);
    this.#stall = opts.stall ?? false;
    this.#midTurn = opts.midTurn ?? false;
  }

  get backingSessionId(): string { return this.#backingSessionId; }
  get hasQueried(): boolean { return this.#hasQueried; }
  get queuedMessages(): number { return 0; }

  resetToNewSession(newBackingId: string): void {
    this.#backingSessionId = newBackingId;
    this.#hasQueried = false;
  }

  setHasQueried(value: boolean): void {
    this.#hasQueried = value;
  }

  async teardown(): Promise<void> {
    this.teardownCount++;
    this.onRecoveryNeeded = undefined;
    // Mirror ClaudeProvider: closing the live turn queue unblocks any consumer
    // currently awaiting the next event (e.g. a stalled run being recovered).
    this.#currentQueue?.close();
    this.#currentQueue = null;
  }

  async dispose(): Promise<void> {
    return this.teardown();
  }

  async listModels(): Promise<ModelInfo[]> {
    return [{ id: "mock-model", displayName: "Mock Model" }];
  }

  /**
   * Always present on the mock (tests shadow it with `undefined` to model a
   * provider without the capability); consults `this.commands`.
   */
  async listCommands(): Promise<ProviderCommand[]> {
    const c = this.commands;
    if (!c) return [];
    return typeof c === "function" ? c() : c;
  }

  async handlePartAction(action: string, data: Record<string, unknown> | undefined): Promise<void> {
    this.partActions.push({ action, ...(data !== undefined ? { data } : {}) });
    if (this.partActionHandler) await this.partActionHandler(action, data);
  }

  seedFromHistory(
    history: readonly CanonicalTurn[],
    opts?: { maxChars?: number },
  ): HistorySeedResult | undefined {
    if (this.seedFromHistoryError) throw this.seedFromHistoryError;
    this.seededHistory = [...history];
    this.seededMaxChars = opts?.maxChars;
    return this.seedResultOverride ?? undefined;
  }

  seedText(block: string): void {
    this.seededText.push(block);
  }

  runTurn(opts: TurnOpts): TurnRun {
    this.capturedOpts.push(opts);
    this.#hasQueried = true;

    const events = this.#script.shift() ?? [
      { type: "turn_done", result: defaultResult(this.id) } satisfies ProviderEvent,
    ];

    const queue = new AsyncQueue<ProviderEvent>();
    this.#currentQueue = queue;

    // Emit events asynchronously, calling canUseTool for each tool_start
    // to simulate the SDK's PreToolUse hook firing before the tool runs.
    void this.#emit(events, queue, opts);

    const run: TurnRun = {
      events: queue,
      interrupt: async () => {
        queue.close(); // idempotent — safe to call even if already closed
      },
      endTurn: () => {
        // Mirror ClaudeProvider: the consumer has stopped reading, so close the
        // queue rather than leaving it open and undrained.
        this.endTurnCount++;
        queue.close();
        if (this.#currentQueue === queue) this.#currentQueue = null;
      },
    };
    if (this.#midTurn) {
      run.pushMidTurn = (content: string, priority: string) => {
        this.midTurnPushes.push({ content, priority });
      };
    }
    return run;
  }

  async #emit(events: ProviderEvent[], queue: AsyncQueue<ProviderEvent>, opts: TurnOpts): Promise<void> {
    // Yield once so Session's #consumeEvents loop has started its for-await
    // before we begin pushing — avoids losing the first item if the consumer
    // hasn't reached its first `next()` call yet.
    await Promise.resolve();

    for (const event of events) {
      try {
        queue.push(event);
      } catch {
        break; // queue was closed by interrupt()
      }

      if (event.type === "tool_start") {
        // Use setTimeout(0) to flush ALL pending microtasks — this ensures
        // Session's #handleProviderEvent fully processes tool_start (registering
        // the approvalId in #approvalIdToMessageId) before we call canUseTool.
        // canUseTool's #shouldAutoApprove runs synchronously (before its own
        // `await Promise.resolve()`), then canUseTool cleans up #approvalIdToMessageId.
        // Without this flush the cleanup arrives before the registration.
        await new Promise<void>((r) => setTimeout(r, 0));
        try {
          const result = await opts.canUseTool(event.toolId, event.approvalId, event.name, event.input);
          this.canUseToolResults.push(result);
        } catch {
          // canUseTool rejection (very unusual — normally returns {behavior}) — treat as denial.
        }
      }
    }

    // Stall mode: emit the scripted events, then leave the queue OPEN (no
    // terminal event, no close) so the consumer's next pull blocks — exactly
    // what a hung provider stream looks like. Only teardown() closes it.
    if (this.#stall) return;

    queue.close();
  }
}

function defaultResult(providerId: string): NormalizedTurnResult {
  return {
    providerId,
    model: "mock-model",
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalCostUsd: 0,
    durationMs: 1,
  };
}
