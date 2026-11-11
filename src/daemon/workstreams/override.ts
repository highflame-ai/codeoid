/**
 * Override tokens (docs/workstreams-design.md G3): confirming a session's
 * home past another workstream's exclusive claim on its folder.
 *
 * A conflicting `session.create` is refused with a token; the confirming
 * retry presents it. The token is held here (in memory: a daemon restart just
 * means asking again), used once, valid for minutes, and bound to who asked,
 * the folder, the choice and the config revision — so the warning confirmed
 * is the one shown, for this folder and this choice, under this config.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const OVERRIDE_TTL_MS = 5 * 60_000;
const MAX_OUTSTANDING = 256;

export interface OverrideBinding {
  sub: string;
  workdir: string;
  chosen: string;
  revision: string;
}

const hashOf = (token: string) => createHash("sha256").update(token).digest("hex");
const keyOf = (b: OverrideBinding) => JSON.stringify([b.sub, b.workdir, b.chosen, b.revision]);

export class OverrideTokens {
  readonly #tokens = new Map<string, { key: string; expires: number }>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  issue(binding: OverrideBinding): string {
    this.#sweep();
    // Bounded: the oldest outstanding token goes first.
    while (this.#tokens.size >= MAX_OUTSTANDING) this.#tokens.delete(this.#tokens.keys().next().value as string);
    const token = randomBytes(24).toString("base64url");
    this.#tokens.set(hashOf(token), { key: keyOf(binding), expires: this.#now() + OVERRIDE_TTL_MS });
    return token;
  }

  /** Whether `token` is live and bound to exactly this request. Spends nothing. */
  valid(token: string, binding: OverrideBinding): boolean {
    this.#sweep();
    const held = this.#tokens.get(hashOf(token));
    if (!held) return false;
    const want = Buffer.from(keyOf(binding));
    const have = Buffer.from(held.key);
    return want.length === have.length && timingSafeEqual(want, have);
  }

  /** Spend a token: once the session it confirmed exists, so a create that fails later can be retried with it. */
  spend(token: string): void {
    this.#tokens.delete(hashOf(token));
  }

  /** True once, for a live token bound to exactly this request. A wrong binding spends nothing. */
  redeem(token: string, binding: OverrideBinding): boolean {
    if (!this.valid(token, binding)) return false;
    this.spend(token);
    return true;
  }

  #sweep(): void {
    const now = this.#now();
    for (const [h, t] of this.#tokens) if (t.expires <= now) this.#tokens.delete(h);
  }
}
