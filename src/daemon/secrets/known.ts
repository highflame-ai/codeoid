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

/** One form a value can be written in, longest first so a longer form wins over a shorter one inside it. */
interface Needle {
  text: string;
  label: string;
  ref: string;
}

export class KnownSecrets {
  readonly #sources = new Map<string, KnownSecretSource>();
  #needles: Needle[] | null = null;
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
    this.#needles = null;
    this.#version++;
  }

  /** Bumped on every change: a cache keyed by it is never stale. */
  get version(): number {
    return this.#version;
  }

  #build(): Needle[] {
    const byText = new Map<string, { label: string; ref: string }>();
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
        for (const form of formsOf(value)) if (!byText.has(form)) byText.set(form, { label, ref: ref ?? credentialRef(label) });
      }
    }
    return [...byText].map(([text, n]) => ({ text, ...n })).sort((a, b) => b.text.length - a.text.length);
  }

  #current(): Needle[] {
    if (!this.#needles || Date.now() - this.#builtAt > REBUILD_MS) {
      this.#needles = this.#build();
      this.#builtAt = Date.now();
    }
    return this.#needles;
  }

  /** The longest form any value is written in: how much a streaming scrubber must hold back. */
  get longest(): number {
    return this.#current()[0]?.text.length ?? 0;
  }

  /** `text` with every known value replaced by its reference, and the labels and references found. */
  replace(text: string): { text: string; labels: string[]; refs: string[] } {
    const needles = this.#current();
    if (needles.length === 0 || text.length < MIN_KNOWN_LENGTH) return { text, labels: [], refs: [] };
    const labels = new Set<string>();
    const refs = new Set<string>();
    let out = text;
    for (const n of needles) {
      if (!out.includes(n.text)) continue;
      out = out.split(n.text).join(n.ref);
      labels.add(n.label);
      refs.add(n.ref);
    }
    return { text: out, labels: [...labels], refs: [...refs] };
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

/**
 * Secrets found by shape, remembered (in memory only, never stored) so the
 * same value is replaced wherever it shows up later, even bare: a password
 * found as `DB_PASSWORD=…` in a tool's output, repeated in a reply.
 */
export class LearnedSecrets {
  readonly #values = new Map<string, KnownSecret>();
  #onChange: () => void = () => {};

  /** Called when a new value is learned (the known set rebuilds). */
  onChange(fn: () => void): void {
    this.#onChange = fn;
  }

  /** Remember a value; true when it is new. */
  learn(value: string, ref: string): boolean {
    if (value.length < MIN_KNOWN_LENGTH || this.#values.has(value)) return false;
    this.#values.set(value, { label: "learned", value, ref });
    while (this.#values.size > MAX_LEARNED) this.#values.delete(this.#values.keys().next().value!);
    this.#onChange();
    return true;
  }

  values(): Iterable<KnownSecret> {
    return this.#values.values();
  }

  /** The value a learned reference stands for. */
  valueOf(ref: string): string | undefined {
    for (const k of this.#values.values()) if (k.ref === ref) return k.value;
    return undefined;
  }
}
