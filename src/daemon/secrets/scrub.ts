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
  /**
   * Where a value found by a distinct format is remembered, so it is matched exactly from then
   * on: per tenant (one tenant's text never tells another's what was seen). None: nothing kept.
   */
  learnedFor?: (ctx: ScrubContext) => LearnedSecrets | undefined;
  fingerprint: Fingerprinter;
  /** A detected secret, with its value: the vault keeps it where the workstream says so. */
  onDetected?: (secret: DetectedSecret, ctx: ScrubContext) => void;
  budgetMs?: number;
  /**
   * A text that can't be checked (too large, or over budget) is kept as it is and reported here,
   * instead of being replaced by a "not stored" note: for a rewrite of stored data, where the
   * note would destroy what is there for good. Unset: replaced.
   */
  onUnchecked?: (text: string) => void;
}

export class Scrubber {
  readonly #opts: ScrubberOptions;

  constructor(opts: ScrubberOptions) {
    this.#opts = opts;
  }

  get known(): KnownSecrets {
    return this.#opts.known;
  }

  /** The longest value matched exactly (known or learned) for `ctx`: what a stream must hold back. */
  longestKnown(ctx: ScrubContext = {}): number {
    return Math.max(this.#opts.known.longest, this.#opts.learnedFor?.(ctx)?.longest ?? 0);
  }

  /** `text` with no secret's value in it. */
  scrub(text: string, ctx: ScrubContext = {}): ScrubResult {
    if (!text) return { text, changed: false };
    if (text.length > MAX_SCRUB_BYTES) return this.#unchecked(text, TOO_LARGE);
    const deadline = performance.now() + (this.#opts.budgetMs ?? SCRUB_BUDGET_MS);
    const learned = this.#opts.learnedFor?.(ctx);
    const known = this.#opts.known.replace(text, deadline);
    if (!known) return this.#unchecked(text, NOT_CHECKED);
    let out = known.text;
    let changed = known.labels.length > 0;
    if (learned) {
      const r = learned.replace(out, deadline);
      if (!r) return this.#unchecked(text, NOT_CHECKED);
      out = r.text;
      // A learned value matched exactly is still a detected secret: the vault keeps it where it is kept.
      for (const ref of r.refs) {
        changed = true;
        const m = /^‹secret:([a-z0-9-]+):([0-9a-f]{8})›$/.exec(ref);
        const value = learned.valueOf(ref);
        if (m && value !== undefined) this.#detected({ kind: m[1]!, fingerprint: m[2]!, value }, ctx);
      }
    }
    const spans = findSecrets(out, deadline);
    if (spans === null) return this.#unchecked(text, NOT_CHECKED);
    if (spans.length === 0) return { text: out, changed };
    let result = "";
    let at = 0;
    let learnedAny = false;
    for (const s of spans) {
      const value = out.slice(s.start, s.end);
      const fp = this.#opts.fingerprint.of(value);
      // Only a distinct format is remembered: a word found under a name (`password: …`) is often ordinary elsewhere.
      if (s.distinct && learned?.learn(value, secretRef(s.kind, fp))) learnedAny = true;
      this.#detected({ kind: s.kind, fingerprint: fp, value }, ctx);
      result += out.slice(at, s.start) + secretRef(s.kind, fp);
      at = s.end;
    }
    out = result + out.slice(at);
    // A value just learned may appear again in this text, bare: replaced too.
    if (learnedAny && learned) {
      const again = learned.replace(out, deadline);
      if (!again) return this.#unchecked(text, NOT_CHECKED);
      out = again.text;
    }
    return { text: out, changed: true };
  }

  #unchecked(text: string, note: string): ScrubResult {
    if (!this.#opts.onUnchecked) return { text: note, changed: true };
    this.#opts.onUnchecked(text);
    return { text, changed: false };
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
      if (v === null || typeof v !== "object") return v;
      // Too deep to walk: not stored as it is, rather than stored unchecked (offline: kept, and said).
      if (depth > 32) {
        if (this.#opts.onUnchecked) {
          this.#opts.onUnchecked(JSON.stringify(v));
          return v;
        }
        changed = true;
        return NOT_CHECKED;
      }
      if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = walk(x, depth + 1);
      return out;
    };
    const out = walk(value, 0) as T;
    return { value: changed ? out : value, changed };
  }
}

/**
 * Where a credential may start on a line, as the detector's own names read it: a secret-named key
 * with its separator (`DB_PASSWORD=`, `"api_key":`, `passphrase:`), `Bearer`, `Authorization`, a
 * URL's userinfo, a password flag, a JWT, a .netrc entry. From there to the line's end is held,
 * so a value spanning spaces is matched whole; prose that only mentions "authentication" streams.
 */
const TRIGGER =
  /[A-Za-z0-9_.-]*(?:passw|passphrase|pwd|secret|api[_-]?key|private[_-]?key|access[_-]?key|token|credential|auth)[A-Za-z0-9_.-]*["'\]]?[ \t]*(?::=|=>|\?=|[=:])|\bbearer\b|\bauthorization\b|[a-z][a-z0-9+.-]{0,31}:\/\/[^\s/@]*:|(?:^|[ \t])(?:-u|--user|--passw(?:or)?d)\b|eyJ|(?:^|\s)machine\s|^[ \t]*password[ \t]/im;
/** The most held of one line (or one PEM block) before it is sent anyway, scrubbed as far as it has come. */
const MAX_LINE_HOLD = 4096;
const MAX_BLOCK_HOLD = 64_000;
/** How much of a line already sent a piece is judged with. */
const CONTEXT = 512;

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
  /** What was already sent of the current line, as it came: the context a later piece is judged in. */
  #sentLine = "";

  constructor(scrubber: Scrubber, ctx: ScrubContext = {}) {
    this.#scrubber = scrubber;
    this.#ctx = ctx;
  }

  /** What may be sent of `piece` now (possibly nothing). */
  push(piece: string): string {
    const text = this.#held + piece;
    const cut = this.#safeEnd(text);
    this.#held = text.slice(cut);
    return cut > 0 ? this.#send(text.slice(0, cut)) : "";
  }

  /** The rest, at the message's end. */
  flush(): string {
    const rest = this.#held;
    this.#held = "";
    const out = rest ? this.#send(rest) : "";
    this.#sentLine = "";
    return out;
  }

  /**
   * `chunk` scrubbed in the context of its line so far: a value whose name was sent in an
   * earlier piece (`AWS_ACCESS_KEY ` then `= …`) is still found. When the context's own
   * scrubbing doesn't come out the same, the chunk is scrubbed alone.
   */
  #send(chunk: string): string {
    let out: string;
    // Context only where it can matter: the line so far may name a credential, the chunk included.
    if (this.#sentLine && TRIGGER.test(this.#sentLine + chunk.split("\n", 1)[0])) {
      const prefix = this.#scrubber.scrub(this.#sentLine, this.#ctx).text;
      const whole = this.#scrubber.scrub(this.#sentLine + chunk, this.#ctx).text;
      out = whole.startsWith(prefix) ? whole.slice(prefix.length) : this.#scrubber.scrub(chunk, this.#ctx).text;
    } else out = this.#scrubber.scrub(chunk, this.#ctx).text;
    const nl = chunk.lastIndexOf("\n");
    this.#sentLine = (nl >= 0 ? chunk.slice(nl + 1) : this.#sentLine + chunk).slice(-CONTEXT);
    return out;
  }

  /** How much of `text` can be sent now. */
  #safeEnd(text: string): number {
    // An open private key: hold from its armour to its end line.
    const begin = text.lastIndexOf("-----BEGIN");
    if (begin >= 0 && text.indexOf("-----END", begin) < 0 && text.length - begin <= MAX_BLOCK_HOLD) {
      return this.#lineStart(text, begin);
    }
    // The last line, unfinished: held from where a credential may start — judged with what was
    // already sent of it, so a name sent in an earlier piece still holds its value.
    const lineStart = text.lastIndexOf("\n") + 1;
    // The last part of what was sent is enough: a credential's name sits just before its value.
    const sent = lineStart === 0 ? this.#sentLine.slice(-CONTEXT) : "";
    const line = sent + text.slice(lineStart);
    const trigger = TRIGGER.exec(line);
    if (trigger && line.length - trigger.index <= MAX_LINE_HOLD) {
      let at = lineStart + Math.max(0, trigger.index - sent.length);
      // From the word it is in (a quote or `export ` before a name stays with what was sent).
      while (at > lineStart && /[A-Za-z0-9_.$"'-]/.test(text[at - 1]!)) at--;
      return at;
    }
    // A known value with spaces in it is never cut inside: one begun at the end is held from its
    // start, and one already whole goes out whole.
    let cut = this.#plainCut(text);
    for (const v of this.#scrubber.known.spaced) {
      for (let i = text.indexOf(v); i >= 0; i = text.indexOf(v, i + 1)) if (i < cut && cut < i + v.length) cut = i + v.length;
      for (let k = Math.min(v.length - 1, text.length); k > 0; k--) {
        if (text.endsWith(v.slice(0, k))) {
          cut = Math.min(cut, text.length - k);
          break;
        }
      }
    }
    return cut;
  }

  /** Up to the last space, the run after it held (bounded by the longest known value). */
  #plainCut(text: string): number {
    const hold = Math.min(Math.max(512, this.#scrubber.longestKnown(this.#ctx)), MAX_LINE_HOLD);
    const lastSpace = Math.max(text.lastIndexOf(" "), text.lastIndexOf("\n"), text.lastIndexOf("\t"));
    let cut = lastSpace + 1;
    if (text.length - cut > hold) cut = text.length - hold;
    return cut;
  }

  #lineStart(text: string, at: number): number {
    return text.lastIndexOf("\n", at) + 1;
  }
}
