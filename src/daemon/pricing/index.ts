/**
 * Model prices, for the cost of a turn on a backend that doesn't report one
 * (#430). Codex, OpenAI-compatible endpoints, Gemini and Qwen give tokens but
 * no dollars; without an estimate their turns counted as $0, so spend caps
 * never stopped anything there.
 *
 * Prices come from a snapshot of LiteLLM's maintained table
 * (`snapshot.json`, refreshed by `scripts/update-pricing.ts`) and from
 * `pricing.models` in the config, which wins: a custom endpoint's model, a
 * negotiated rate, or `{ "input": 0, "output": 0 }` for a free one.
 */
import snapshot from "./snapshot.json" with { type: "json" };

/** USD per million tokens. */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  /** Rates for a request whose prompt is over 200k tokens (Gemini Pro). */
  inputAbove200k?: number;
  outputAbove200k?: number;
  cacheReadAbove200k?: number;
  cacheWriteAbove200k?: number;
}

/** Where a turn's cost came from. */
export type CostSource =
  /** The backend said (Claude, pi). */
  | "backend"
  /** Tokens × the model's list price: an estimate, as precise as the token counts. */
  | "estimated"
  /** Nothing to pay: a model on your own machine (llama.cpp). */
  | "free"
  /** No price known for the model, or no token counts: the cost isn't known (never shown as $0). */
  | "unknown";

const SNAPSHOT = snapshot.models as Record<string, ModelPrice>;

/** When the snapshot was taken (YYYY-MM-DD). */
export const PRICING_SNAPSHOT_DATE: string = snapshot.updated;

/**
 * The price of `model`: the config's, else the snapshot's. Tries the id as
 * given, without a `models/` prefix (the Gemini API's), and without a
 * trailing date (`gpt-5.5-2026-04-23` → `gpt-5.5`), case-insensitively.
 */
export function priceFor(
  model: string,
  overrides?: Readonly<Record<string, ModelPrice>>,
  opts: { overridesOnly?: boolean } = {},
): ModelPrice | undefined {
  const candidates = new Set<string>();
  const base = model.trim();
  for (const id of [base, base.replace(/^models\//, "")]) {
    candidates.add(id);
    candidates.add(id.replace(/-\d{4}-?\d{2}-?\d{2}$/, ""));
  }
  for (const table of [overrides && lowerKeys(overrides), opts.overridesOnly ? undefined : SNAPSHOT_LOWER]) {
    if (!table) continue;
    for (const id of candidates) {
      // Own keys only: a model named "constructor" must not find Object.prototype's.
      const hit = table.get(id.toLowerCase());
      if (hit && isPrice(hit)) return hit;
    }
  }
  return undefined;
}

/** Keys lowercased, in a Map (no inherited keys); the first spelling of a key wins. */
function lowerKeys(table: Readonly<Record<string, ModelPrice>>): Map<string, ModelPrice> {
  const map = new Map<string, ModelPrice>();
  for (const [k, v] of Object.entries(table)) if (!map.has(k.toLowerCase())) map.set(k.toLowerCase(), v);
  return map;
}

const SNAPSHOT_LOWER = lowerKeys(SNAPSHOT);

function isPrice(p: unknown): p is ModelPrice {
  const q = p as ModelPrice;
  return typeof q === "object" && q !== null && Number.isFinite(q.input) && Number.isFinite(q.output) && q.input >= 0 && q.output >= 0;
}

export interface TurnTokens {
  /** New input tokens, cache reads excluded. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

/**
 * The cost of one turn at `price`. `largestPrompt` is the biggest single
 * request's prompt in the turn, when known: over 200k tokens, a model with a
 * long-context tier is billed at that tier.
 */
export function estimateCost(price: ModelPrice, tokens: TurnTokens, largestPrompt = 0): number {
  const long = largestPrompt > 200_000;
  const input = (long ? price.inputAbove200k : undefined) ?? price.input;
  const output = (long ? price.outputAbove200k : undefined) ?? price.output;
  // Cached tokens go up with the tier too: at their own long rate, else as input does.
  const scale = long && price.input > 0 ? input / price.input : 1;
  const cacheRead = (long ? price.cacheReadAbove200k : undefined) ?? (price.cacheRead !== undefined ? price.cacheRead * scale : input);
  const cacheWrite = (long ? price.cacheWriteAbove200k : undefined) ?? (price.cacheWrite !== undefined ? price.cacheWrite * scale : input);
  const usd =
    tokens.inputTokens * input +
    tokens.outputTokens * output +
    tokens.cacheReadTokens * cacheRead +
    tokens.cacheCreationTokens * cacheWrite;
  return usd / 1_000_000;
}

/**
 * The cost of a turn request by request, each at its own tier, when the
 * requests add up to the turn's tokens exactly; else undefined (price the
 * turn whole at its largest request's tier, which never under-counts).
 */
export function estimateCostByRequest(price: ModelPrice, tokens: TurnTokens, requests: readonly TurnTokens[]): number | undefined {
  if (requests.length === 0) return undefined;
  const keys = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheCreationTokens"] as const;
  if (keys.some((k) => requests.reduce((n, r) => n + r[k], 0) !== tokens[k])) return undefined;
  return requests.reduce((usd, r) => usd + estimateCost(price, r, r.inputTokens + r.cacheReadTokens + r.cacheCreationTokens), 0);
}
