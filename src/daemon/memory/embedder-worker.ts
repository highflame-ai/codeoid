/**
 * Worker-thread host for the embedding model.
 *
 * transformers.js runs ONNX inference synchronously on whatever thread calls
 * it: on the daemon's main thread, one batch of 8 episodes froze the event
 * loop for ~450 ms — every session, WebSocket client and Telegram update
 * waited behind it. Hosting the model here moves that work off the event
 * loop; WorkerEmbedder (embedder.ts) is the main-thread proxy.
 *
 * Protocol (structured-clone messages):
 *   in:  { type: "init", model, cacheDir? }           → out: { type: "ready", dimensions } | { type: "init_error", message }
 *   in:  { type: "embed", id, texts }                  → out: { type: "embedded", id, vectors } | { type: "embed_error", id, message }
 */

import { TransformersJsEmbedder } from "./embedder-transformersjs.js";

declare const self: Worker;

export type EmbedderWorkerRequest =
  | { type: "init"; model: string; cacheDir?: string }
  | { type: "embed"; id: number; texts: string[] };

export type EmbedderWorkerResponse =
  | { type: "ready"; dimensions: number }
  | { type: "init_error"; message: string }
  | { type: "embedded"; id: number; vectors: Float32Array[] }
  | { type: "embed_error"; id: number; message: string };

let embedder: TransformersJsEmbedder | null = null;

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const reply = (msg: EmbedderWorkerResponse, transfer: ArrayBuffer[] = []): void =>
  self.postMessage(msg, transfer);

self.onmessage = async (event: MessageEvent<EmbedderWorkerRequest>) => {
  const msg = event.data;
  if (msg.type === "init") {
    try {
      embedder = new TransformersJsEmbedder(msg.model, msg.cacheDir);
      await embedder.init();
      reply({ type: "ready", dimensions: embedder.dimensions });
    } catch (err) {
      reply({ type: "init_error", message: errText(err) });
    }
    return;
  }
  if (msg.type === "embed") {
    if (!embedder) {
      reply({ type: "embed_error", id: msg.id, message: "embedder not initialized" });
      return;
    }
    try {
      const vectors = await embedder.embed(msg.texts);
      reply({ type: "embedded", id: msg.id, vectors }, vectors.map((v) => v.buffer as ArrayBuffer));
    } catch (err) {
      reply({ type: "embed_error", id: msg.id, message: errText(err) });
    }
  }
};
