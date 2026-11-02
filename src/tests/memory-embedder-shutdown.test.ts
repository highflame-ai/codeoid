/**
 * Closing the embedder never crashes the daemon. `Worker.terminate()` while
 * onnxruntime held the worker (loading the model, running a batch, or with its
 * finalizers still pending) made Bun panic, so every shutdown with memory on
 * could die with SIGILL before the store closed and the data-dir lock went.
 *
 * Needs the embedding model on disk: set CODEOID_TEST_EMBEDDING_MODELS to a
 * model cache dir (one holding Xenova/bge-small-en-v1.5, e.g. ~/.codeoid/models).
 * Skipped otherwise, since the model is ~34 MB to download.
 */

import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

const models = process.env.CODEOID_TEST_EMBEDDING_MODELS;
const have = !!models && existsSync(join(models, "Xenova", "bge-small-en-v1.5"));
const fixture = join(import.meta.dir, "fixtures", "embedder-close.ts");

describe.skipIf(!have)("closing the embedder", () => {
  for (const phase of ["init", "embed"]) {
    for (const delay of [0, 50, 200, 800]) {
      it(`while it ${phase === "init" ? "loads the model" : "runs a batch"} (${delay} ms in) exits cleanly`, async () => {
        const proc = Bun.spawn([process.execPath, fixture, models!, String(delay), phase], { stdout: "pipe", stderr: "pipe" });
        const [code, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
        if (code !== 0) throw new Error(`exited ${code}\n${err.slice(-3000)}`);
        expect(out).toContain("closed");
      }, 60_000);
    }
  }
});
