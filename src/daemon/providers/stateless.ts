/**
 * StatelessSessionProvider — adapts a stateless AgentProvider (Gemini,
 * OpenAI: rebuilds the full history from CanonicalTurn[] on every runTurn)
 * to the SessionProvider surface Session requires.
 *
 * The extra SessionProvider members exist for ClaudeProvider's warm backing
 * session (rotation, recovery, mid-turn queueing). A stateless provider has
 * no backing session to lose or rotate, so the adapter's implementations are
 * honest no-ops: the "backing id" is just a display/persistence label and
 * recovery/rotation cannot apply.
 */

import type {
  AgentProvider,
  ModelInfo,
  SessionProvider,
  TurnOpts,
  TurnRun,
} from "./interface.js";

export class StatelessSessionProvider implements SessionProvider {
  onRecoveryNeeded: ((content: string) => void) | undefined;
  readonly #inner: AgentProvider;
  #backingSessionId: string;
  #hasQueried = false;

  constructor(inner: AgentProvider, backingSessionId: string) {
    this.#inner = inner;
    this.#backingSessionId = backingSessionId;
  }

  get id(): string {
    return this.#inner.id;
  }

  get displayName(): string {
    return this.#inner.displayName;
  }

  /** Forward the inner provider's memory-tool capability (OpenAI/Gemini set it
   *  true when a memory engine is wired for their function-calling loop). */
  get supportsMemoryTools(): boolean {
    return this.#inner.supportsMemoryTools ?? false;
  }

  get free(): boolean {
    return this.#inner.free ?? false;
  }

  get appliesToolInputRewrite(): boolean {
    return this.#inner.appliesToolInputRewrite ?? false;
  }

  get backingSessionId(): string {
    return this.#backingSessionId;
  }

  get hasQueried(): boolean {
    return this.#hasQueried;
  }

  /** Stateless providers consume the message synchronously per turn — nothing queues. */
  get queuedMessages(): number {
    return 0;
  }

  runTurn(opts: TurnOpts): TurnRun {
    this.#hasQueried = true;
    return this.#inner.runTurn(opts);
  }

  listModels(): Promise<ModelInfo[]> {
    return this.#inner.listModels();
  }

  resetToNewSession(newBackingId: string): void {
    // No warm context to rotate away from — just adopt the new label.
    this.#backingSessionId = newBackingId;
  }

  setHasQueried(value: boolean): void {
    this.#hasQueried = value;
  }

  async teardown(): Promise<void> {
    // Nothing runs between turns; dispose() handles final cleanup.
  }

  dispose(): Promise<void> {
    return this.#inner.dispose();
  }
}
