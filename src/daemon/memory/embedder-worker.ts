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
 *   in:  { type: "stop" }                               → the worker exits once what it is running is done
 *
 * The worker stops itself: `Worker.terminate()` while onnxruntime (a native
 * addon) is loading the model or running a batch makes Bun panic ("NAPI
 * FATAL ERROR", the whole daemon dies with SIGILL), so the main thread never
 * terminates a worker that loaded the model. Requests run one at a time, so
 * a stop waits for the one running and never cuts into native code.
 */

import { TransformersJsEmbedder } from "./embedder-transformersjs.js";

declare const self: Worker;

export type EmbedderWorkerRequest =
  | { type: "init"; model: string; cacheDir?: string }
  | { type: "embed"; id: number; texts: string[] }
  | { type: "stop" };

export type EmbedderWorkerResponse =
  | { type: "ready"; dimensions: number }
  | { type: "init_error"; message: string }
  | { type: "embedded"; id: number; vectors: Float32Array[] }
  | { type: "embed_error"; id: number; message: string };

let embedder: TransformersJsEmbedder | null = null;

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const reply = (msg: EmbedderWorkerResponse, transfer: ArrayBuffer[] = []): void =>
  self.postMessage(msg, transfer);

/** Requests in arrival order, one at a time: a stop never lands inside a native call. */
let queue: Promise<void> = Promise.resolve();
let stopping = false;

self.onmessage = (event: MessageEvent<EmbedderWorkerRequest>) => {
  const msg = event.data;
  if (stopping) return;
  if (msg.type === "stop") stopping = true;
  queue = queue.then(() => handle(msg)).catch(() => {});
};

async function handle(msg: EmbedderWorkerRequest): Promise<void> {
  if (msg.type === "stop") {
    try {
      await embedder?.close();
    } catch {
      // Best-effort: the process is going anyway.
    }
    embedder = null;
    // Let the native finalizers of the model and the last batch run while the
    // thread's environment is still whole: exiting with them pending panics
    // Bun 1.3 the same way. Collect, let the queued finalizers run, collect
    // what they released.
    Bun.gc(true);
    await Bun.sleep(50);
    Bun.gc(true);
    await Bun.sleep(10);
    // Exiting from inside is clean (the main thread gets its `close` event);
    // a terminate() from outside, with the model loaded, crashes Bun.
    process.exit(0);
  }
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
}
