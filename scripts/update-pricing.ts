/**
 * Refresh codeoid's model price snapshot (#430) from LiteLLM's maintained
 * table (MIT): https://github.com/BerriAI/litellm, model_prices_and_context_window.json.
 *
 *   bun scripts/update-pricing.ts            # fetch it from GitHub
 *   bun scripts/update-pricing.ts <file>     # or read a copy you downloaded
 *
 * Keeps only chat models of the providers codeoid runs (OpenAI/Codex, Gemini
 * and the Gemini CLI, Anthropic, Qwen via DashScope), and only their
 * per-token prices, in USD per million tokens. Writes
 * src/daemon/pricing/snapshot.json; review the diff and commit it.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const OUT = join(import.meta.dir, "..", "src", "daemon", "pricing", "snapshot.json");

/** LiteLLM provider → the prefix its ids carry there (stripped: codeoid's backends name models without it). */
const PROVIDERS: Record<string, string> = {
  openai: "",
  anthropic: "",
  gemini: "gemini/",
  "vertex_ai-language-models": "",
  dashscope: "dashscope/",
};

interface Entry {
  litellm_provider?: string;
  mode?: string;
  input_cost_per_token?: number | null;
  output_cost_per_token?: number | null;
  cache_read_input_token_cost?: number | null;
  cache_creation_input_token_cost?: number | null;
  input_cost_per_token_above_200k_tokens?: number | null;
  output_cost_per_token_above_200k_tokens?: number | null;
}

const perMillion = (v: number | null | undefined) => (typeof v === "number" ? Math.round(v * 1e6 * 1e6) / 1e6 : undefined);

const raw = process.argv[2] ? readFileSync(process.argv[2], "utf8") : await (await fetch(SOURCE)).text();
const table = JSON.parse(raw) as Record<string, Entry>;
const models: Record<string, Record<string, number>> = {};
for (const [key, e] of Object.entries(table)) {
  const prefix = e?.litellm_provider !== undefined ? PROVIDERS[e.litellm_provider] : undefined;
  if (prefix === undefined || (e.mode !== "chat" && e.mode !== "responses")) continue;
  if (prefix && !key.startsWith(prefix)) continue;
  const id = key.slice(prefix.length);
  if (id.includes("/")) continue; // a regional or reseller variant
  const input = perMillion(e.input_cost_per_token);
  const output = perMillion(e.output_cost_per_token);
  if (input === undefined || output === undefined) continue;
  // A $0 listing is the provider's free tier, not the model's price on any other host: only pricing.models may say a model is free (#430).
  if (input === 0 && output === 0) continue;
  const price: Record<string, number> = { input, output };
  const cacheRead = perMillion(e.cache_read_input_token_cost);
  const cacheWrite = perMillion(e.cache_creation_input_token_cost);
  const inputLong = perMillion(e.input_cost_per_token_above_200k_tokens);
  const outputLong = perMillion(e.output_cost_per_token_above_200k_tokens);
  if (cacheRead !== undefined) price.cacheRead = cacheRead;
  if (cacheWrite !== undefined) price.cacheWrite = cacheWrite;
  if (inputLong !== undefined) price.inputAbove200k = inputLong;
  if (outputLong !== undefined) price.outputAbove200k = outputLong;
  // The first listing wins: the provider's own (`gemini/…`) and Vertex's agree or differ only in ways that don't matter here.
  models[id] ??= price;
}
const sorted = Object.fromEntries(Object.entries(models).sort(([a], [b]) => a.localeCompare(b)));
writeFileSync(
  OUT,
  `${JSON.stringify({ source: SOURCE, license: "MIT (BerriAI/litellm)", updated: new Date().toISOString().slice(0, 10), unit: "USD per million tokens", models: sorted }, null, 1)}\n`,
);
console.log(`wrote ${Object.keys(sorted).length} models to ${OUT}`);
