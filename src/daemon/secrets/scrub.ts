/**
 * What codeoid stores never holds a secret's value
 * (docs/secrets-and-memory-design.md §2): `scrub` replaces values codeoid
 * knows with `‹credential:<label>›` (known.ts) and credentials found by shape
 * with `‹secret:<kind>:<fingerprint>›` (detect.ts). A detected value is
 * dropped, or handed to `onDetected` (the vault, where a workstream keeps
 * them, §2.5).
 *
 * A text that can't be checked in time, or is too large to check, isn't
 * stored: it becomes a `‹not stored: …›` note. Never the text unchecked.
 */

import { findSecrets } from "./detect.js";
import type { Fingerprinter } from "./fingerprint.js";
import type { KnownSecrets, LearnedSecrets } from "./known.js";

/** atuin's budget: a text that can't be checked in this long isn't stored. */
export const SCRUB_BUDGET_MS = 250;
/** Larger than this and a text isn't checked, nor stored. */
export const MAX_SCRUB_BYTES = 8 * 1024 * 1024;

export const NOT_CHECKED = "‹not stored: it couldn't be checked for secrets in time›";
export const TOO_LARGE = "‹not stored: it is too large to check for secrets›";

export interface ScrubContext {
  /** The home workstream of what is being stored (for the vault's policy and scoping). */
  workstream?: string;
  sessionId?: string;
}

export interface DetectedSecret {
  kind: string;
  fingerprint: string;
  value: string;
}

export interface ScrubResult {
  text: string;
  /** Anything was replaced. */
  changed: boolean;
}

export function secretRef(kind: string, fingerprint: string): string {
  return `‹secret:${kind}:${fingerprint}›`;
}

export interface ScrubberOptions {
  known: KnownSecrets;
  /** Where a value found by shape is remembered, so it is matched exactly from then on. */
  learned?: LearnedSecrets;
  fingerprint: Fingerprinter;
  /** A detected secret, with its value: the vault keeps it where the workstream says so. */
  onDetected?: (secret: DetectedSecret, ctx: ScrubContext) => void;
  budgetMs?: number;
}

export class Scrubber {
  readonly #opts: ScrubberOptions;

  constructor(opts: ScrubberOptions) {
    this.#opts = opts;
  }

  get known(): KnownSecrets {
    return this.#opts.known;
  }

  /** `text` with no secret's value in it. */
  scrub(text: string, ctx: ScrubContext = {}): ScrubResult {
    if (!text) return { text, changed: false };
    if (text.length > MAX_SCRUB_BYTES) return { text: TOO_LARGE, changed: true };
    const deadline = performance.now() + (this.#opts.budgetMs ?? SCRUB_BUDGET_MS);
    const known = this.#opts.known.replace(text);
    let out = known.text;
    // A learned value matched exactly is still a detected secret: the vault keeps it where it is kept.
    if (this.#opts.learned && this.#opts.onDetected) {
      for (const ref of known.refs) {
        const m = /^‹secret:([a-z0-9-]+):([0-9a-f]{8})›$/.exec(ref);
        const value = m ? this.#opts.learned.valueOf(ref) : undefined;
        if (m && value !== undefined) this.#detected({ kind: m[1]!, fingerprint: m[2]!, value }, ctx);
      }
    }
    const spans = findSecrets(out, deadline);
    if (spans === null) return { text: NOT_CHECKED, changed: true };
    if (spans.length === 0) return { text: out, changed: known.labels.length > 0 };
    let result = "";
    let at = 0;
    let learnedAny = false;
    for (const s of spans) {
      const value = out.slice(s.start, s.end);
      const fp = this.#opts.fingerprint.of(value);
      if (this.#opts.learned?.learn(value, secretRef(s.kind, fp))) learnedAny = true;
      this.#detected({ kind: s.kind, fingerprint: fp, value }, ctx);
      result += out.slice(at, s.start) + secretRef(s.kind, fp);
      at = s.end;
    }
    out = result + out.slice(at);
    // A value just learned may appear again in this text, bare: replaced too.
    if (learnedAny) out = this.#opts.known.replace(out).text;
    return { text: out, changed: true };
  }

  #detected(secret: DetectedSecret, ctx: ScrubContext): void {
    if (!this.#opts.onDetected) return;
    try {
      this.#opts.onDetected(secret, ctx);
    } catch (err) {
      console.error(`[codeoid/secrets] keeping a detected secret failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** {@link scrub} applied to every string in a JSON-like value (a tool's input), structure kept. */
  scrubValue<T>(value: T, ctx: ScrubContext = {}): { value: T; changed: boolean } {
    let changed = false;
    const walk = (v: unknown, depth: number): unknown => {
      if (typeof v === "string") {
        const r = this.scrub(v, ctx);
        if (r.changed) changed = true;
        return r.text;
      }
      if (depth > 32 || v === null || typeof v !== "object") return v;
      if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = walk(x, depth + 1);
      return out;
    };
    const out = walk(value, 0) as T;
    return { value: changed ? out : value, changed };
  }
}

/** A line that may be naming a credential: held whole until it ends, so a pattern spanning spaces is matched whole. */
const TRIGGER = /secret|token|passw|pwd|api[_-]?key|private|auth|bearer|credential|:\/\/|-----BEGIN|\bcurl\b|--user\b/i;
/** The most held of one line (or one PEM block) before it is sent anyway, scrubbed as far as it has come. */
const MAX_LINE_HOLD = 4096;
const MAX_BLOCK_HOLD = 20_000;

/**
 * Scrubs text that arrives in pieces (an assistant's reply as it streams), so
 * a secret split across pieces is never sent unscrubbed:
 *
 * - the trailing run of non-space characters is held until the next space or
 *   the end (a token, a known value, is one run);
 * - a line that may name a credential (`password: "two words"`, `Bearer …`,
 *   a URL) is held until it ends, and a private key's armour until its end
 *   line, so each is scrubbed whole.
 *
 * Held text past a bound is sent anyway, scrubbed as far as it has come;
 * the committed message is scrubbed whole again, and replaces it.
 */
export class StreamScrubber {
  readonly #scrubber: Scrubber;
  readonly #ctx: ScrubContext;
  #held = "";

  constructor(scrubber: Scrubber, ctx: ScrubContext = {}) {
    this.#scrubber = scrubber;
    this.#ctx = ctx;
  }

  /** What may be sent of `piece` now (possibly nothing). */
  push(piece: string): string {
    const text = this.#held + piece;
    const cut = this.#safeEnd(text);
    this.#held = text.slice(cut);
    return cut > 0 ? this.#scrubber.scrub(text.slice(0, cut), this.#ctx).text : "";
  }

  /** The rest, at the message's end. */
  flush(): string {
    const rest = this.#held;
    this.#held = "";
    return rest ? this.#scrubber.scrub(rest, this.#ctx).text : "";
  }

  /** How much of `text` can be sent now. */
  #safeEnd(text: string): number {
    // An open private key: hold from its armour to its end line.
    const begin = text.lastIndexOf("-----BEGIN");
    if (begin >= 0 && text.indexOf("-----END", begin) < 0 && text.length - begin <= MAX_BLOCK_HOLD) {
      return this.#lineStart(text, begin);
    }
    // The last line, unfinished: held whole when it may name a credential.
    const lineStart = text.lastIndexOf("\n") + 1;
    const line = text.slice(lineStart);
    if (TRIGGER.test(line) && line.length <= MAX_LINE_HOLD) return lineStart;
    // Otherwise up to the last space, the run after it held (bounded by the longest known value).
    const hold = Math.min(Math.max(512, this.#scrubber.known.longest), MAX_LINE_HOLD);
    const lastSpace = Math.max(text.lastIndexOf(" "), text.lastIndexOf("\n"), text.lastIndexOf("\t"));
    let cut = lastSpace + 1;
    if (text.length - cut > hold) cut = text.length - hold;
    return cut;
  }

  #lineStart(text: string, at: number): number {
    return text.lastIndexOf("\n", at) + 1;
  }
}
