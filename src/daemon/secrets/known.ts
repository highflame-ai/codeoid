/**
 * Secrets codeoid already knows (docs/secrets-and-memory-design.md §2.2):
 * values it put there itself — a workstream's credential, an MCP server's
 * OAuth token, a backend's key, the daemon's own — replaced by exact match
 * wherever they show up, as `‹credential:<label>›`. No guessing, so no false
 * positives, and nothing new is stored: the value stays where it lives.
 *
 * Sources register a function that lists their values; the set is rebuilt
 * when one says it changed (`invalidate`) or after a minute, whichever comes
 * first (an OAuth token refreshes without telling anyone).
 *
 * Matching is one pass over the text (Aho-Corasick), leftmost-longest, and
 * never inside a reference codeoid wrote (`‹…›`): scrubbing twice changes
 * nothing.
 */

/** Shorter than this and a value would match ordinary text. */
export const MIN_KNOWN_LENGTH = 8;
const REBUILD_MS = 60_000;

export interface KnownSecret {
  /** What the reference names: `gh-saucam`, `oauth:linear`, `daemon:ANTHROPIC_API_KEY`. */
  label: string;
  value: string;
  /** The reference written in its place; default `‹credential:<label>›`. */
  ref?: string;
}

export type KnownSecretSource = () => Iterable<KnownSecret>;

/** A reference codeoid wrote: never matched inside. */
const OWN_REF = /‹[^‹›\n]{1,300}›/g;
/** A character a token goes on through: a bounded needle needs none on either side. */
const TOKEN_CHAR = /[A-Za-z0-9_-]/;

interface Needle {
  text: string;
  label: string;
  ref: string;
}

/** A multi-pattern matcher: every needle found in one pass. */
class Matcher {
  readonly #goto: Array<Map<string, number>> = [new Map()];
  readonly #fail: number[] = [0];
  /** Per state: the needles ending there, longest first. */
  readonly #out: Needle[][] = [[]];
  readonly longest: number;
  readonly size: number;

  constructor(needles: readonly Needle[]) {
    let longest = 0;
    for (const n of needles) {
      let state = 0;
      for (const ch of n.text) {
        let next = this.#goto[state]!.get(ch);
        if (next === undefined) {
          next = this.#goto.length;
          this.#goto.push(new Map());
          this.#fail.push(0);
          this.#out.push([]);
          this.#goto[state]!.set(ch, next);
        }
        state = next;
      }
      this.#out[state]!.push(n);
      longest = Math.max(longest, n.text.length);
    }
    this.longest = longest;
    this.size = needles.length;
    // Failure links, breadth first: each state's outputs include its failure state's.
    const queue: number[] = [...this.#goto[0]!.values()];
    for (let i = 0; i < queue.length; i++) {
      const state = queue[i]!;
      for (const [ch, next] of this.#goto[state]!) {
        queue.push(next);
        let f = this.#fail[state]!;
        while (f !== 0 && !this.#goto[f]!.has(ch)) f = this.#fail[f]!;
        const via = this.#goto[f]!.get(ch);
        this.#fail[next] = via !== undefined && via !== next ? via : 0;
        const inherited = this.#out[this.#fail[next]!]!;
        if (inherited.length > 0) this.#out[next] = [...this.#out[next]!, ...inherited];
      }
    }
  }

  /** Every match, as [start, end, needle]. */
  *matches(text: string): Generator<[number, number, Needle]> {
    if (this.size === 0) return;
    let state = 0;
    let i = 0;
    for (const ch of text) {
      i += ch.length;
      while (state !== 0 && !this.#goto[state]!.has(ch)) state = this.#fail[state]!;
      state = this.#goto[state]!.get(ch) ?? 0;
      for (const n of this.#out[state]!) yield [i - n.text.length, i, n];
    }
  }
}

/**
 * `text` with matches replaced: leftmost-longest, as whole tokens, none inside a reference. Past
 * `deadline`, null: the caller doesn't store what it couldn't check.
 */
function replaceMatches(text: string, matcher: Matcher, deadline: number): { text: string; refs: Set<string>; labels: Set<string> } | null {
  const refs = new Set<string>();
  const labels = new Set<string>();
  if (matcher.size === 0 || text.length < MIN_KNOWN_LENGTH) return { text, refs, labels };
  // References in order: a match is checked against them by binary search.
  const own: Array<[number, number]> = [];
  for (const m of text.matchAll(OWN_REF)) own.push([m.index!, m.index! + m[0].length]);
  const inOwn = (s: number, e: number): boolean => {
    let lo = 0;
    let hi = own.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (own[mid]![1] <= s) lo = mid + 1;
      else hi = mid;
    }
    return lo < own.length && own[lo]![0] < e;
  };
  const found: Array<[number, number, Needle]> = [];
  let n = 0;
  for (const m of matcher.matches(text)) {
    if (++n % 4096 === 0 && performance.now() > deadline) return null;
    const [s, e] = m;
    if (own.length > 0 && inOwn(s, e)) continue;
    if ((s > 0 && TOKEN_CHAR.test(text[s - 1]!)) || (e < text.length && TOKEN_CHAR.test(text[e]!))) continue;
    found.push(m);
  }
  if (found.length === 0) return { text, refs, labels };
  found.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  let out = "";
  let at = 0;
  for (const [s, e, n] of found) {
    if (s < at) continue;
    out += text.slice(at, s) + n.ref;
    at = e;
    refs.add(n.ref);
    labels.add(n.label);
  }
  return { text: out + text.slice(at), refs, labels };
}

export class KnownSecrets {
  readonly #sources = new Map<string, KnownSecretSource>();
  #matcher: Matcher | null = null;
  #spaced: string[] = [];
  #builtAt = 0;
  #version = 0;

  /** Add a source; returns a function that removes it. */
  register(name: string, source: KnownSecretSource): () => void {
    this.#sources.set(name, source);
    this.invalidate();
    return () => {
      if (this.#sources.get(name) === source) {
        this.#sources.delete(name);
        this.invalidate();
      }
    };
  }

  /** A source's values changed (a credential edited, a token refreshed). */
  invalidate(): void {
    this.#matcher = null;
    this.#version++;
  }

  /** Bumped on every change: a cache keyed by it is never stale. */
  get version(): number {
    return this.#version;
  }

  #build(): Matcher {
    const byText = new Map<string, Needle>();
    for (const [name, source] of this.#sources) {
      let entries: Iterable<KnownSecret>;
      try {
        entries = source();
      } catch (err) {
        console.error(`[codeoid/secrets] known-secret source ${name} failed: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      for (const { label, value, ref } of entries) {
        if (typeof value !== "string" || value.length < MIN_KNOWN_LENGTH) continue;
        for (const form of formsOf(value)) if (!byText.has(form)) byText.set(form, { text: form, label, ref: ref ?? credentialRef(label) });
      }
    }
    this.#spaced = [...byText.keys()].filter((t) => /\s/.test(t));
    return new Matcher([...byText.values()]);
  }

  #current(): Matcher {
    if (!this.#matcher || Date.now() - this.#builtAt > REBUILD_MS) {
      this.#matcher = this.#build();
      this.#builtAt = Date.now();
    }
    return this.#matcher;
  }

  /** Values with whitespace in them: a stream must not cut at a space inside one. */
  get spaced(): readonly string[] {
    this.#current();
    return this.#spaced;
  }

  /** The longest form any value is written in: how much a streaming scrubber must hold back. */
  get longest(): number {
    return this.#current().longest;
  }

  /**
   * `text` with every known value replaced by its reference where it stands as a whole token (a
   * dev default like `postgres` inside `postgresql://` is left), and the labels and references
   * found. Null past `deadline`.
   */
  replace(text: string, deadline = Number.POSITIVE_INFINITY): { text: string; labels: string[]; refs: string[] } | null {
    const r = replaceMatches(text, this.#current(), deadline);
    return r ? { text: r.text, labels: [...r.labels], refs: [...r.refs] } : null;
  }
}

/** The reference a known value is replaced by. */
export function credentialRef(label: string): string {
  return `‹credential:${label}›`;
}

/** How a value can be written: as it is, URL-encoded, and as Basic auth's base64 of `user:value` and `value:`. */
function formsOf(value: string): string[] {
  const forms = [value];
  const encoded = encodeURIComponent(value);
  if (encoded !== value) forms.push(encoded);
  // Basic auth carries `user:password` base64'd: a value used as the password
  // with an empty user, or as a token user with no password, is common enough.
  for (const pair of [`:${value}`, `${value}:`, `x-access-token:${value}`]) {
    const b64 = Buffer.from(pair).toString("base64");
    forms.push(b64.replace(/=+$/, ""));
  }
  return forms;
}

/** Most values remembered by {@link LearnedSecrets}; the oldest are let go past it. */
const MAX_LEARNED = 2000;
/** A remembered value is matched bare only when it is this long: shorter ones are too often ordinary words. */
const MIN_LEARNED_LENGTH = 12;

/**
 * Secrets found by a distinct format (a vendor's token, a JWT, a key),
 * remembered in memory only, never stored, so the same value is replaced
 * wherever it shows up later, even bare: a token a tool printed, repeated in
 * a reply. Matched as whole tokens only, and kept apart from the known set,
 * so learning one costs no rebuild of the rest.
 */
export class LearnedSecrets {
  readonly #values = new Map<string, Needle>();
  readonly #byRef = new Map<string, string>();
  /** By their first characters: a value is matched where a token starts, so a lookup there finds it. */
  readonly #byPrefix = new Map<string, Needle[]>();
  #longest = 0;

  /** Remember a value; true when it is new. Learning costs no rebuild. */
  learn(value: string, ref: string): boolean {
    if (value.length < MIN_LEARNED_LENGTH || this.#values.has(value)) return false;
    const n: Needle = { text: value, label: "learned", ref };
    this.#values.set(value, n);
    this.#byRef.set(ref, value);
    const key = value.slice(0, PREFIX);
    const list = this.#byPrefix.get(key) ?? [];
    list.push(n);
    list.sort((x, y) => y.text.length - x.text.length);
    this.#byPrefix.set(key, list);
    this.#longest = Math.max(this.#longest, value.length);
    while (this.#values.size > MAX_LEARNED) this.#forget(this.#values.keys().next().value!);
    return true;
  }

  #forget(value: string): void {
    const n = this.#values.get(value);
    if (!n) return;
    this.#values.delete(value);
    this.#byRef.delete(n.ref);
    const key = value.slice(0, PREFIX);
    const list = (this.#byPrefix.get(key) ?? []).filter((x) => x !== n);
    if (list.length > 0) this.#byPrefix.set(key, list);
    else this.#byPrefix.delete(key);
  }

  /** The value a learned reference stands for. */
  valueOf(ref: string): string | undefined {
    return this.#byRef.get(ref);
  }

  get longest(): number {
    return this.#longest;
  }

  /** Each remembered value replaced where it stands as a whole token, never inside a reference. Null past `deadline`. */
  replace(text: string, deadline = Number.POSITIVE_INFINITY): { text: string; refs: string[] } | null {
    const refs = new Set<string>();
    if (this.#values.size === 0 || text.length < MIN_LEARNED_LENGTH) return { text, refs: [] };
    const own: Array<[number, number]> = [];
    for (const m of text.matchAll(OWN_REF)) own.push([m.index!, m.index! + m[0].length]);
    let out = "";
    let at = 0;
    let o = 0;
    for (let i = 0; i + MIN_LEARNED_LENGTH <= text.length; i++) {
      if ((i & 0xffff) === 0 && i > 0 && performance.now() > deadline) return null;
      if (i > 0 && TOKEN_CHAR.test(text[i - 1]!)) continue;
      while (o < own.length && own[o]![1] <= i) o++;
      if (o < own.length && own[o]![0] <= i) {
        i = own[o]![1] - 1;
        continue;
      }
      const list = this.#byPrefix.get(text.slice(i, i + PREFIX));
      if (!list) continue;
      const n = list.find((c) => text.startsWith(c.text, i) && !(i + c.text.length < text.length && TOKEN_CHAR.test(text[i + c.text.length]!)));
      if (!n) continue;
      out += text.slice(at, i) + n.ref;
      at = i + n.text.length;
      refs.add(n.ref);
      i = at - 1;
    }
    return at === 0 ? { text, refs: [] } : { text: out + text.slice(at), refs: [...refs] };
  }
}

/** How many leading characters index a remembered value (each is at least MIN_LEARNED_LENGTH long). */
const PREFIX = 8;
