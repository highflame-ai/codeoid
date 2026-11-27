// Closes a WorkerEmbedder while its worker loads the model (`init`) or runs a
// batch (`embed`), after `delayMs`, then exits 0. Before the fix, close()
// terminated the worker and Bun panicked ("NAPI FATAL ERROR", SIGILL).
// Usage: bun embedder-close.ts <cacheDir> <delayMs> <init|embed>
import { WorkerEmbedder } from "../../daemon/memory/embedder.js";

const [cacheDir, delayArg, phase] = process.argv.slice(2);
const e = new WorkerEmbedder("Xenova/bge-small-en-v1.5", cacheDir);
if (phase === "embed") {
  await e.init();
  void e.embed(Array.from({ length: 64 }, (_, i) => `episode ${i} `.repeat(40))).catch(() => {});
} else {
  void e.init().catch(() => {});
}
await Bun.sleep(Number(delayArg ?? "0"));
await e.close();
// Keep running, as the daemon's shutdown does after memory closes: a worker
// torn down badly panics a moment later, not inside close().
await Bun.sleep(500);
console.log("closed");
process.exit(0);
